import { CubismFramework } from '@framework/live2dcubismframework';
import { CubismModelSettingJson } from '@framework/cubismmodelsettingjson';
import { ICubismModelSetting } from '@framework/icubismmodelsetting';
import { CubismDefaultParameterId } from '@framework/cubismdefaultparameterid';
import { CubismIdHandle } from '@framework/id/cubismid';
import { CubismMatrix44 } from '@framework/math/cubismmatrix44';
import { CubismUserModel } from '@framework/model/cubismusermodel';
import {
  BreathParameterData,
  CubismBreath,
} from '@framework/effect/cubismbreath';
import { CubismEyeBlink } from '@framework/effect/cubismeyeblink';
import { CubismLook, LookParameterData } from '@framework/effect/cubismlook';
import { CubismEyeBlinkUpdater } from '@framework/motion/cubismeyeblinkupdater';
import { CubismBreathUpdater } from '@framework/motion/cubismbreathupdater';
import { CubismUpdateScheduler } from '@framework/motion/cubismupdatescheduler';
import { CubismMotion } from '@framework/motion/cubismmotion';
import { CubismExpressionMotion } from '@framework/motion/cubismexpressionmotion';
import { applyFaceVariant, FACE_VARIANT_PARAMETERS } from './face-variant';
import { CubismExpressionUpdater } from '@framework/motion/cubismexpressionupdater';
import { InteractionParamInfo, InteractionTarget } from './interaction/target';
import { ACTION_LIBRARY, PetBehaviorHost } from './behavior';
import { GazeController } from './gaze';
import {
  OverlayLayer,
  InteractionOffsetChannel,
  EyeOverrideChannel,
  EarChannel,
  CheekChannel,
  HandRaiseChannel,
} from './overlay';

/** 动作优先级（与官方 LAppDefine 一致）。 */
export const MotionPriority = {
  None: 0,
  Idle: 1,
  Normal: 2,
  Force: 3,
} as const;

/** 动作清单元数据（assets/live2d/aliya/actions.json）。 */
export interface ActionManifestEntry {
  name: string;
  category?: 'idle' | 'emotion' | 'reaction';
  weight?: number;
  moods?: Record<string, number>;
}

const INVALID_MOTION_HANDLE = -1;

/**
 * 模型装配与每帧流水线（成熟路径：五阶段，单一职责）：
 *
 *   1. loadParameters → 2. 动作(motion) → saveParameters
 *   → 3. 调度器（眨眼→表情→呼吸→物理，SDK 官方顺序）
 *   → 4. GazeController（视线唯一所有者：指针跟随/动作交挖/表情偏移/钳制）
 *   → 5. OverlayLayer（程序化通道：互动偏移/眼覆盖/猫耳/脸红/抬手）
 *   → model.update
 *
 * 同时实现 InteractionTarget（互动参数通道）与 PetBehaviorHost（动作/注视）。
 */
export class PetModel
  extends CubismUserModel
  implements InteractionTarget, PetBehaviorHost
{
  private _updateScheduler: CubismUpdateScheduler;
  private _setting: ICubismModelSetting;
  private _homeDir: string;
  private _gl: WebGL2RenderingContext = null;
  private _frameBuffer: WebGLFramebuffer = null;
  private _shaderPath = '/shaders/';
  private _ready = false;
  // 模型静态包围盒（drawable 顶点，模型坐标系）：视口适配与窗口尺寸的基准，
  // 与 native live2d_model.cpp 的 modelBoundsW_/modelBoundsH_ 一致
  private _boundsW = 1;
  private _boundsH = 1;
  private _boundsMinX = -0.5;
  private _boundsMinY = -0.5;
  private _boundsMaxX = 0.5;
  private _boundsMaxY = 0.5;

  // 动作
  private readonly _motions = new Map<string, CubismMotion>();
  private _motionUpdated = false;

  // 表情（exp3.json；眼睑乘法，其余安全参数加性叠加）。
  // 管理器复用 CubismUserModel 基类自带的 _expressionManager。
  private readonly _expressions = new Map<string, CubismExpressionMotion>();
  private _currentExpression: string | null = null;

  // 动作清单元数据（可选，缺省时均匀抽取）
  private _actionManifest: ActionManifestEntry[] | null = null;

  // 眨眼参数 ID（覆盖写入用）
  private _eyeBlinkIds: CubismIdHandle[] = [];

  // 视线（唯一所有者）与程序化覆盖层（句柄就绪后装配）
  private _gaze: GazeController = null;
  private readonly _overlays = new OverlayLayer();
  private _chInteraction: InteractionOffsetChannel = null;
  private _chEye: EyeOverrideChannel = null;
  private _chEar: EarChannel = null;
  private _chCheek: CheekChannel = null;
  private _chHand: HandRaiseChannel = null;
  private _lookAtReduction = false; // 抚摸期间视线跟随降权
  private static readonly _lookReductionScale = 0.25;

  // 热路径参数句柄缓存（配置探测后填充）
  private _idAngleX: CubismIdHandle = null;
  private _idAngleY: CubismIdHandle = null;
  private _idAngleZ: CubismIdHandle = null;
  private _idBodyAngleX: CubismIdHandle = null;
  private _idEarL: CubismIdHandle = null;
  private _idEarR: CubismIdHandle = null;
  private _idCheek: CubismIdHandle = null;
  private _idEyeBallX: CubismIdHandle = null;
  private _idEyeBallY: CubismIdHandle = null;
  /** 会切换整套特殊眼睛、无法安全交叉淡化的模型参数。 */
  private _unsafeFaceVariantIds: CubismIdHandle[] = [];
  private _faceVariantIds: CubismIdHandle[] = [];
  private _paramInfo: InteractionParamInfo = null;

  public constructor() {
    super();
    this._updateScheduler = new CubismUpdateScheduler();
  }

  /**
   * 按 model3.json 装配：moc → 物理 → 纹理 → 渲染器 → 动作库 → 待机行为。
   * 眨眼参数读 model3.json 的 EyeBlink Ids（新版已挂 ParamEyeLOpen/ROpen），
   * 为空时回退标准参数 ID；LipSync 未启用。
   */
  public async loadFromSetting(
    buffer: ArrayBuffer,
    size: number,
    homeDir: string,
    renderContext: {
      gl: WebGL2RenderingContext;
      frameBuffer: WebGLFramebuffer;
      shaderPath: string;
    }
  ): Promise<void> {
    this._setting = new CubismModelSettingJson(buffer, size);
    this._homeDir = homeDir;
    this._gl = renderContext.gl;
    this._frameBuffer = renderContext.frameBuffer;
    this._shaderPath = renderContext.shaderPath;

    // moc
    const mocFile = this._setting.getModelFileName();
    if (mocFile === '') throw new Error('model3.json has no Moc');
    this.loadModel(await this._fetchArrayBuffer(mocFile), false);
    this._model.saveParameters();

    // 静态包围盒：默认姿态下全部 drawable 顶点的 min/max（native 同款算法）
    {
      this._model.update();
      const dc = this._model.getDrawableCount();
      let minX = 1e9,
        maxX = -1e9,
        minY = 1e9,
        maxY = -1e9;
      for (let i = 0; i < dc; i++) {
        const v = this._model.getDrawableVertices(i);
        for (let j = 0; j < v.length; j += 2) {
          if (v[j] < minX) minX = v[j];
          if (v[j] > maxX) maxX = v[j];
          if (v[j + 1] < minY) minY = v[j + 1];
          if (v[j + 1] > maxY) maxY = v[j + 1];
        }
      }
      this._boundsW = Math.max(0.1, maxX - minX);
      this._boundsH = Math.max(0.1, maxY - minY);
      this._boundsMinX = minX;
      this._boundsMinY = minY;
      this._boundsMaxX = maxX;
      this._boundsMaxY = maxY;
    }

    // 物理
    if (this._setting.getPhysicsFileName() !== '') {
      const physicsBuffer = await this._fetchArrayBuffer(
        this._setting.getPhysicsFileName()
      );
      this.loadPhysics(physicsBuffer, physicsBuffer.byteLength);
    }

    // 纹理 → 渲染器
    const textureCount = this._setting.getTextureCount();
    this.createRenderer(
      this._gl.drawingBufferWidth,
      this._gl.drawingBufferHeight
    );
    // renderer.initialize 刻意不碰 WebGL（官方设计），gl 必须经 startUp 注入
    this.getRenderer().startUp(this._gl);
    for (let i = 0; i < textureCount; i++) {
      const tex = await this._loadTexture(
        this._setting.getTextureFileName(i)
      );
      this.getRenderer().bindTexture(i, tex);
    }

    // 眨眼：model3.json 的 Ids 为空时回退标准参数
    this._eyeBlinkIds = [];
    for (let i = 0; i < this._setting.getEyeBlinkParameterCount(); i++) {
      this._eyeBlinkIds.push(this._setting.getEyeBlinkParameterId(i));
    }
    if (this._eyeBlinkIds.length === 0) {
      this._eyeBlinkIds = [
        CubismFramework.getIdManager().getId(
          CubismDefaultParameterId.ParamEyeLOpen
        ),
        CubismFramework.getIdManager().getId(
          CubismDefaultParameterId.ParamEyeROpen
        ),
      ];
    }
    this._eyeBlink = CubismEyeBlink.create();
    this._eyeBlink.setParameterIds(this._eyeBlinkIds);
    this._updateScheduler.addUpdatableList(
      new CubismEyeBlinkUpdater(
        // 动作更新中或眼睛被互动覆盖时暂停自动眨眼（通道装配后再取状态）
        () => this._motionUpdated || this._chEye?.enabled === true,
        this._eyeBlink
      )
    );

    // 呼吸（待机基础动画，参数与官方 Demo 一致）
    this._breath = CubismBreath.create();
    const id = (s: string) => CubismFramework.getIdManager().getId(s);
    this._breath.setParameters([
      new BreathParameterData(id(CubismDefaultParameterId.ParamAngleX), 0.0, 15.0, 6.5345, 0.5),
      new BreathParameterData(id(CubismDefaultParameterId.ParamAngleY), 0.0, 8.0, 3.5345, 0.5),
      new BreathParameterData(id(CubismDefaultParameterId.ParamAngleZ), 0.0, 10.0, 5.5345, 0.5),
      new BreathParameterData(id(CubismDefaultParameterId.ParamBodyAngleX), 0.0, 4.0, 15.5345, 0.5),
      new BreathParameterData(id(CubismDefaultParameterId.ParamBreath), 0.5, 0.5, 3.2345, 1.0),
    ]);
    this._updateScheduler.addUpdatableList(
      new CubismBreathUpdater(this._breath)
    );

    // 视线跟随增益（GazeController 内合成；头部按 Q 版模型调低：官方 ±30
    // 的 AngleZ 在该模型绑定极强会「断头」，收敛到动作库同量级 ±6~12）。
    const look = CubismLook.create();
    look.setParameters([
      new LookParameterData(id(CubismDefaultParameterId.ParamAngleX), 12, 0, 0),
      new LookParameterData(id(CubismDefaultParameterId.ParamAngleY), 0, 10, 0),
      new LookParameterData(id(CubismDefaultParameterId.ParamAngleZ), 0, 0, -8),
      new LookParameterData(id(CubismDefaultParameterId.ParamBodyAngleX), 4, 0, 0),
      // 该模型眼球参数值域是 ±30（非官方惯例的 ±1），取 18（60% 行程）
      new LookParameterData(id(CubismDefaultParameterId.ParamEyeBallX), 18, 0, 0),
      new LookParameterData(id(CubismDefaultParameterId.ParamEyeBallY), 0, 18, 0),
    ]);

    // 互动参数句柄缓存
    this._idAngleX = id(CubismDefaultParameterId.ParamAngleX);
    this._idAngleY = id(CubismDefaultParameterId.ParamAngleY);
    this._idAngleZ = id(CubismDefaultParameterId.ParamAngleZ);
    this._idBodyAngleX = id(CubismDefaultParameterId.ParamBodyAngleX);
    // 猫耳：旧模型的 ParamEarL/R 在新模型上不存在；新模型耳朵由物理输出
    // Param9/Param13（左/右晃动1，cdi3「猫耳」组）驱动。探测后二选一，
    // 写入点在物理之后（EarChannel），加写即可生效。
    const hasParam = (name: string): boolean => {
      for (let i = 0; i < this._model.getParameterCount(); i++) {
        if (this._model.getParameterId(i).getString() === name) return true;
      }
      return false;
    };
    const idEarL = id(hasParam('ParamEarL') ? 'ParamEarL' : 'Param9');
    const idEarR = id(hasParam('ParamEarR') ? 'ParamEarR' : 'Param13');
    this._idEarL = idEarL;
    this._idEarR = idEarR;
    this._idCheek = id('ParamCheek');
    this._idEyeBallX = id('ParamEyeBallX');
    this._idEyeBallY = id('ParamEyeBallY');
    this._unsafeFaceVariantIds = [id('Param33'), id('Param34'), id('Param35')];
    this._faceVariantIds = FACE_VARIANT_PARAMETERS.map(id);

    // 按真实参数探测新版挥手能力；缺少参数时保留旧模型的五段链。
    // 不向 SDK 创建的虚拟参数写入，两个版本均在物理后统一控制。
    const nativeWave = ['Param30', 'Param31', 'Param36'].every(hasParam)
      ? { enabled: id('Param30'), forearm: id('Param31'), hand: id('Param36') }
      : null;
    const idsHandR: CubismIdHandle[] = [];
    for (let s = 1; s <= 5; s++) {
      const name = `Param_Angle_Rotation_${s}_ArtMesh61`;
      if (hasParam(name)) idsHandR.push(id(name));
    }

    // 视线控制器（唯一所有者）与覆盖通道装配（固定顺序）
    this._gaze = new GazeController(look, this._idEyeBallX, this._idEyeBallY);
    this._chInteraction = new InteractionOffsetChannel({
      angleX: this._idAngleX,
      angleY: this._idAngleY,
      angleZ: this._idAngleZ,
      bodyAngleX: this._idBodyAngleX,
    });
    this._chEye = new EyeOverrideChannel({
      left: this._eyeBlinkIds[0],
      right: this._eyeBlinkIds[1] ?? this._eyeBlinkIds[0],
    });
    this._chEar = new EarChannel({ left: idEarL, right: idEarR });
    this._chEar.scale = hasParam('ParamEarL') ? 1 : 12;
    this._chCheek = new CheekChannel(this._idCheek);
    this._chHand = new HandRaiseChannel(idsHandR, nativeWave);
    this._overlays.add(this._chInteraction);
    this._overlays.add(this._chEar);
    this._overlays.add(this._chCheek);
    this._overlays.add(this._chHand);

    // 动作库（tools/gen-motions.py 为 Aliya 生成的自编动作）
    await this._preloadMotions();

    // 动作清单元数据（可选：情绪亲和权重；缺失时行为层均匀抽取）
    try {
      const buf = await this._fetchArrayBuffer('actions.json');
      const parsed = JSON.parse(new TextDecoder().decode(buf));
      if (Array.isArray(parsed.actions)) {
        this._actionManifest = parsed.actions;
      }
    } catch {
      // 可选文件，缺失不阻塞
    }

    // 表情库（tools/gen-expressions.py 生成，model3.json Expressions 引用）。
    // 求值顺序 = CubismUpdateOrder_Expression(300)：眨眼后、呼吸/物理前，
    // Add 混合叠加在动作结果之上，且不进 saveParameters 快照（每帧重施加）。
    await this._preloadExpressions();
    this._updateScheduler.addUpdatableList(
      new CubismExpressionUpdater(this._expressionManager)
    );

    this._ready = true;
  }

  private async _preloadExpressions(): Promise<void> {
    const count = this._setting.getExpressionCount
      ? this._setting.getExpressionCount()
      : 0;
    for (let i = 0; i < count; i++) {
      const name = this._setting.getExpressionName(i);
      const file = this._setting.getExpressionFileName(i);
      if (!name || !file) continue;
      try {
        const buffer = await this._fetchArrayBuffer(file);
        this._expressions.set(
          name,
          CubismExpressionMotion.create(buffer, buffer.byteLength)
        );
      } catch {
        // 单个表情缺失不阻塞加载
      }
    }
  }

  /** 可用表情名列表（AI/调试用）。 */
  public getExpressionNames(): string[] {
    return Array.from(this._expressions.keys());
  }

  /** 当前表情名（null = 无）。 */
  public getCurrentExpression(): string | null {
    return this._currentExpression;
  }

  /**
   * 切换表情（交叉淡入淡出由 exp3.json 的 Fade 时间控制）。
   * @param name 表情名；null 或 'neutral' 清除表情
   * @returns 是否成功
   */
  public startExpression(name: string | null): boolean {
    if (name === null || name === 'neutral') {
      if (this._currentExpression === null) return true;
      // 播放空表情触发旧的淡出
      const neutral = this._expressions.get('neutral');
      if (neutral) {
        // 高频切换时旧队列会累积并同时混合；只保留最新请求。
        this._expressionManager.stopAllMotions();
        this._expressionManager.startMotion(neutral, false);
      }
      this._currentExpression = null;
      this._gaze.setExpression(null);
      return true;
    }
    const expr = this._expressions.get(name);
    if (!expr) return false;
    if (this._currentExpression === name) return true;
    this._expressionManager.stopAllMotions();
    this._expressionManager.startMotion(expr, false);
    this._currentExpression = name;
    // 表情注视偏移（垂眼/回避/斜眼）由视线控制器合成，exp3 不直写眼球
    this._gaze.setExpression(name);
    return true;
  }

  public isReady(): boolean {
    return this._ready;
  }

  /** 动作清单元数据（actions.json；null = 未提供）。 */
  public get actionManifest(): ActionManifestEntry[] | null {
    return this._actionManifest;
  }

  /** 模型静态包围盒宽（模型坐标单位） */
  public get boundsW(): number {
    return this._boundsW;
  }

  /** 模型静态包围盒高（模型坐标单位） */
  public get boundsH(): number {
    return this._boundsH;
  }

  /** 包围盒宽高比（native 窗口比例基准） */
  public get boundsAspect(): number {
    return this._boundsW / this._boundsH;
  }

  /**
   * 默认姿态的静态包围盒（模型坐标）：悬浮窗固定窗口矩形的基准——
   * 动作在模型画布内活动，静态盒 + 边距可全程包容，窗口无需逐帧跟随剪影。
   */
  public getStaticBounds(): {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  } | null {
    if (!this._ready) return null;
    return {
      minX: this._boundsMinX,
      minY: this._boundsMinY,
      maxX: this._boundsMaxX,
      maxY: this._boundsMaxY,
    };
  }

  /**
   * 当前姿态的动态包围盒（模型坐标；须在 update 之后调用）。
   * 悬浮窗内容贴合模式用：窗口矩形逐帧包裹角色剪影。
   */
  public getDynamicBounds(): {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  } | null {
    if (!this._ready) return null;
    const dc = this._model.getDrawableCount();
    let minX = 1e9,
      maxX = -1e9,
      minY = 1e9,
      maxY = -1e9;
    for (let i = 0; i < dc; i++) {
      const v = this._model.getDrawableVertices(i);
      for (let j = 0; j < v.length; j += 2) {
        if (v[j] < minX) minX = v[j];
        if (v[j] > maxX) maxX = v[j];
        if (v[j + 1] < minY) minY = v[j + 1];
        if (v[j + 1] > maxY) maxY = v[j + 1];
      }
    }
    if (minX > maxX || minY > maxY) return null;
    return { minX, minY, maxX, maxY };
  }

  // ---------- 动作播放 ----------

  private async _preloadMotions(): Promise<void> {
    for (const group of ACTION_LIBRARY) {
      const count = this._setting.getMotionCount(group);
      for (let i = 0; i < count; i++) {
        const name = `${group}_${i}`;
        try {
          const fileName = this._setting.getMotionFileName(group, i);
          const buf = await this._fetchArrayBuffer(fileName);
          // 占位动作来自其他模型：必须关掉 motion3.json 一致性检查
          const motion = this.loadMotion(
            buf,
            buf.byteLength,
            name,
            null,
            null,
            this._setting,
            group,
            i,
            false
          );
          if (!motion) continue;
          // 自动效果参数 ID 必须显式设置，否则播放时读 null.length 崩溃
          // （官方 LAppModel 在 startMotion 里做同样的事）
          motion.setEffectIds(this._eyeBlinkIds, []);
          const fadeIn = this._setting.getMotionFadeInTimeValue(group, i);
          const fadeOut = this._setting.getMotionFadeOutTimeValue(group, i);
          motion.setFadeInTime(fadeIn >= 0 ? fadeIn : 1.0);
          motion.setFadeOutTime(fadeOut >= 0 ? fadeOut : 1.0);
          this._motions.set(name, motion);
        } catch (e) {
          console.warn(`[pet] motion ${name} load failed`, e);
        }
      }
    }
  }

  /** 播放指定动作组中随机一条。 */
  public startRandomMotion(group: string, priority: number): number {
    const count = this._setting.getMotionCount(group);
    if (count === 0) return INVALID_MOTION_HANDLE;
    return this.startMotion(
      group,
      Math.floor(Math.random() * count),
      priority
    );
  }

  /** 播放指定动作。低优先级不打断播放中的高优先级动作。 */
  public startMotion(group: string, index: number, priority: number): number {
    if (!this._ready) return INVALID_MOTION_HANDLE;
    if (priority <= this._motionManager.getCurrentPriority()) {
      return INVALID_MOTION_HANDLE;
    }
    const motion = this._motions.get(`${group}_${index}`);
    if (!motion) return INVALID_MOTION_HANDLE;
    // 每次只保留一个动作。连续触发时由新动作自身 fade-in 接管当前姿态，
    // 避免多个淡出动作叠加写眼睑/笑眼/特殊脸参数。
    this._motionManager.stopAllMotions();
    const handle = this._motionManager.startMotionPriority(motion, false, priority);
    if (handle !== INVALID_MOTION_HANDLE) {
      if (group === 'wave') this._chHand.trigger();
      else this._chHand.release();
    }
    return handle;
  }

  /** PetBehaviorHost：播放语义动作（可互相打断，队列自带交叉淡出）。 */
  public playAction(name: string): boolean {
    if (!this._ready) return false;
    const count = this._setting.getMotionCount(name);
    if (count === 0) return false;
    const index = Math.floor(Math.random() * count);
    const motion = this._motions.get(`${name}_${index}`);
    if (!motion) return false;
    // 高频入口采用 latest-wins，防止淡出队列无界累积。
    this._motionManager.stopAllMotions();
    this._motionManager.startMotionPriority(
      motion,
      false,
      MotionPriority.Normal
    );
    // 挥手联动抬手包络；其他动作打断时平滑放下
    if (name === 'wave') {
      this._chHand.trigger();
    } else {
      this._chHand.release();
    }
    return true;
  }

  // ---------- PetBehaviorHost：视线 ----------

  setLookTarget(x01: number, y01: number): void {
    this._gaze.setTarget(x01, y01);
  }

  clearLookTarget(): void {
    this._gaze.clearTarget();
  }

  // ---------- InteractionTarget ----------

  public getInteractionParamInfo(): InteractionParamInfo | null {
    if (!this._ready) return null;
    if (this._paramInfo) return this._paramInfo;

    const model = this._model;
    const count = model.getParameterCount();
    const rangeOf = (
      handle: CubismIdHandle
    ): { min: number; max: number; exists: boolean } => {
      const index = model.getParameterIndex(handle);
      // getParameterIndex 对不存在的参数返回虚拟索引（>= count）
      if (index < 0 || index >= count) {
        return { min: 0, max: 0, exists: false };
      }
      return {
        min: model.getParameterMinimumValue(index),
        max: model.getParameterMaximumValue(index),
        exists: true,
      };
    };
    const or = (
      r: { min: number; max: number; exists: boolean },
      dMin: number,
      dMax: number
    ) => (r.exists ? r : { min: dMin, max: dMax, exists: false });

    const ax = or(rangeOf(this._idAngleX), -30, 30);
    const ay = or(rangeOf(this._idAngleY), -30, 30);
    const az = or(rangeOf(this._idAngleZ), -30, 30);
    const bx = or(rangeOf(this._idBodyAngleX), -30, 30);
    const el = or(rangeOf(this._eyeBlinkIds[0]), 0, 1);
    const er = or(
      rangeOf(this._eyeBlinkIds[1] ?? this._eyeBlinkIds[0]),
      0,
      1
    );

    this._paramInfo = {
      angleXMin: ax.min,
      angleXMax: ax.max,
      angleYMin: ay.min,
      angleYMax: ay.max,
      angleZMin: az.min,
      angleZMax: az.max,
      bodyXMin: bx.min,
      bodyXMax: bx.max,
      eyeLMin: el.min,
      eyeLMax: el.max,
      eyeRMin: er.min,
      eyeRMax: er.max,
      hasEyes: el.exists && er.exists,
    };
    return this._paramInfo;
  }

  public setInteractionOffsets(
    angleX: number,
    angleY: number,
    angleZ: number,
    bodyAngleX: number
  ): void {
    this._chInteraction.angleX = angleX;
    this._chInteraction.angleY = angleY;
    this._chInteraction.angleZ = angleZ;
    this._chInteraction.bodyX = bodyAngleX;
  }

  public setEyeOverride(
    enabled: boolean,
    leftOpen: number,
    rightOpen: number
  ): void {
    this._chEye.enabled = enabled;
    this._chEye.left = leftOpen;
    this._chEye.right = rightOpen;
  }

  public setEarInteraction(
    enabled: boolean,
    leftValue: number,
    rightValue: number
  ): void {
    this._chEar.enabled = enabled;
    this._chEar.left = leftValue;
    this._chEar.right = rightValue;
  }

  public setFaceCheek(enabled: boolean, value: number): void {
    this._chCheek.enabled = enabled;
    this._chCheek.value = value;
  }

  public setPettingLookAtReduction(enabled: boolean): void {
    this._lookAtReduction = enabled;
  }

  // ---------- 每帧（五阶段流水线） ----------

  public update(deltaTimeSeconds: number): void {
    if (!this._ready) return;
    const model = this._model;

    // 1. 恢复上一帧保存的基准
    model.loadParameters();

    // 2. 动作（可互相打断，交叉淡出；播完自动解除，待机由呼吸接管）
    this._motionUpdated = this._motionManager.updateMotion(
      model,
      deltaTimeSeconds
    );
    // 特殊眼睛选择器不支持连续混合。即使旧资源或缓存仍写入，也在基准层清零。
    for (const id of this._unsafeFaceVariantIds) {
      model.setParameterValueById(id, 0);
    }
    model.saveParameters();

    // 3. 调度器：眨眼(200) → 表情(300) → 呼吸(500)
    this._updateScheduler.onLateUpdate(model, deltaTimeSeconds);
    for (const id of this._unsafeFaceVariantIds) {
      model.setParameterValueById(id, 0);
    }
    // 眼睑必须先于物理写入，否则眼珠/高光物理读到的是另一套开合值。
    this._chEye.apply(model);
    applyFaceVariant(model, this._faceVariantIds, this._currentExpression);

    // 4. 视线（唯一所有者：指针跟随 × 动作交控权重 × 抚摸降权
    //    + 表情注视偏移 → 眼球总钳制）
    this._gaze.update(model, deltaTimeSeconds, {
      motionActive: this._motionUpdated,
      reduction: this._lookAtReduction ? PetModel._lookReductionScale : 1,
      eyeOpenness: Math.min(
        model.getParameterValueById(this._eyeBlinkIds[0]),
        model.getParameterValueById(this._eyeBlinkIds[1] ?? this._eyeBlinkIds[0])
      ),
    });
    if (this._physics) this._physics.evaluate(model, deltaTimeSeconds);

    // 5. 程序化覆盖通道（互动偏移/眼覆盖/猫耳/脸红/抬手；
    //    晚于物理，可直接加写物理输出参数）→ 应用到顶点
    this._overlays.apply(model, deltaTimeSeconds);

    // 在动作、表情淡化、物理和互动之后独占写入整套眼型。
    // 受击/无语保留原生表现，但不经历会产生重影的中间值。
    applyFaceVariant(model, this._faceVariantIds, this._currentExpression);

    model.update();
  }

  public draw(matrix: CubismMatrix44): void {
    if (!this._ready) return;
    matrix.multiplyByMatrix(this._modelMatrix);
    this.getRenderer().setMvpMatrix(matrix);
    this.getRenderer().setRenderState(this._frameBuffer, [
      0,
      0,
      this._gl.drawingBufferWidth,
      this._gl.drawingBufferHeight,
    ]);
    this.getRenderer().drawModel(this._shaderPath);
  }

  private async _fetchArrayBuffer(fileName: string): Promise<ArrayBuffer> {
    const response = await fetch(`${this._homeDir}${fileName}`);
    if (!response.ok) {
      throw new Error(`failed to load ${this._homeDir}${fileName}`);
    }
    return response.arrayBuffer();
  }

  /** 加载 PNG 并上传为预乘 alpha 纹理（与官方渲染器的混合方式配套）。 */
  private _loadTexture(fileName: string): Promise<WebGLTexture> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.addEventListener('load', () => {
        const gl = this._gl;
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          img
        );
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.bindTexture(gl.TEXTURE_2D, null);
        resolve(texture);
      });
      img.addEventListener('error', () =>
        reject(new Error(`failed to load texture ${fileName}`))
      );
      img.src = `${this._homeDir}${fileName}`;
    });
  }
}
