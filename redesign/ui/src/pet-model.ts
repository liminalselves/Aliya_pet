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
import { CubismPhysicsUpdater } from '@framework/motion/cubismphysicsupdater';
import { CubismUpdateScheduler } from '@framework/motion/cubismupdatescheduler';
import { CubismMotion } from '@framework/motion/cubismmotion';
import { InteractionParamInfo, InteractionTarget } from './interaction/target';
import { ACTION_LIBRARY, PetBehaviorHost } from './behavior';

/** 动作优先级（与官方 LAppDefine 一致）。 */
export const MotionPriority = {
  None: 0,
  Idle: 1,
  Normal: 2,
  Force: 3,
} as const;

const INVALID_MOTION_HANDLE = -1;

/**
 * 模型装配与每帧行为：
 *   呼吸/眨眼/物理（调度器）→ 视线跟随 → 互动写入（抚摸/程序化反应）→ 动作播放。
 * 同时实现 InteractionTarget（互动参数通道）与 PetBehaviorHost（动作/注视）。
 *
 * 每帧顺序（与官方 LAppModel 一致，互动写入在物理之后、model.update 之前）：
 *   loadParameters → motion 更新 → saveParameters → 调度器（物理/眨眼/呼吸）
 *   → 视线 → 互动偏移/眼睛覆盖/耳朵/脸红 → model.update
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

  // 眨眼参数 ID（覆盖写入用）
  private _eyeBlinkIds: CubismIdHandle[] = [];

  // 视线
  private _look: CubismLook = null;
  private _lookTargetX = 0; // -1..1（右为正）
  private _lookTargetY = 0; // -1..1（上为正）
  private _lookCurrentX = 0;
  private _lookCurrentY = 0;
  private _lookActive = false;
  private _lookAtReduction = false; // 抚摸期间降低权重
  private static readonly _lookTauSeconds = 0.15;
  private static readonly _lookReductionScale = 0.25;

  // 互动通道状态（每帧全量重写）
  private _intAngleX = 0;
  private _intAngleY = 0;
  private _intAngleZ = 0;
  private _intBodyX = 0;
  private _eyeOverrideEnabled = false;
  private _eyeOverrideL = 0;
  private _eyeOverrideR = 0;
  private _earEnabled = false;
  private _earL = 0;
  private _earR = 0;
  private _cheekEnabled = false;
  private _cheek = 0;

  // 热路径参数句柄缓存（配置探测后填充）
  private _idAngleX: CubismIdHandle = null;
  private _idAngleY: CubismIdHandle = null;
  private _idAngleZ: CubismIdHandle = null;
  private _idBodyAngleX: CubismIdHandle = null;
  private _idEarL: CubismIdHandle = null;
  private _idEarR: CubismIdHandle = null;
  private _idCheek: CubismIdHandle = null;
  private _paramInfo: InteractionParamInfo = null;

  public constructor() {
    super();
    this._updateScheduler = new CubismUpdateScheduler();
  }

  /**
   * 按 model3.json 装配：moc → 物理 → 纹理 → 渲染器 → 动作库 → 待机行为。
   * Aliya 的 model3.json 未挂 EyeBlink/LipSync Ids，眨眼参数回退到标准 ID。
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
      this._updateScheduler.addUpdatableList(
        new CubismPhysicsUpdater(this._physics)
      );
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
        // 动作更新中或眼睛被互动覆盖时暂停自动眨眼
        () => this._motionUpdated || this._eyeOverrideEnabled,
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

    // 视线跟随（权重与官方 LAppModel 一致）
    this._look = CubismLook.create();
    this._look.setParameters([
      new LookParameterData(id(CubismDefaultParameterId.ParamAngleX), 30, 0, 0),
      new LookParameterData(id(CubismDefaultParameterId.ParamAngleY), 0, 30, 0),
      new LookParameterData(id(CubismDefaultParameterId.ParamAngleZ), 0, 0, -30),
      new LookParameterData(id(CubismDefaultParameterId.ParamBodyAngleX), 10, 0, 0),
      new LookParameterData(id(CubismDefaultParameterId.ParamEyeBallX), 1, 0, 0),
      new LookParameterData(id(CubismDefaultParameterId.ParamEyeBallY), 0, 1, 0),
    ]);

    // 互动参数句柄缓存
    this._idAngleX = id(CubismDefaultParameterId.ParamAngleX);
    this._idAngleY = id(CubismDefaultParameterId.ParamAngleY);
    this._idAngleZ = id(CubismDefaultParameterId.ParamAngleZ);
    this._idBodyAngleX = id(CubismDefaultParameterId.ParamBodyAngleX);
    this._idEarL = id('ParamEarL');
    this._idEarR = id('ParamEarR');
    this._idCheek = id('ParamCheek');

    // 占位动作库（官方示例动作，Aliya 动作导出后替换文件即可）
    await this._preloadMotions();

    this._ready = true;
  }

  public isReady(): boolean {
    return this._ready;
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
    return this._motionManager.startMotionPriority(motion, false, priority);
  }

  /** PetBehaviorHost：播放语义动作（可互相打断，队列自带交叉淡出）。 */
  public playAction(name: string): boolean {
    if (!this._ready) return false;
    const count = this._setting.getMotionCount(name);
    if (count === 0) return false;
    const index = Math.floor(Math.random() * count);
    const motion = this._motions.get(`${name}_${index}`);
    if (!motion) return false;
    // startMotion 会让播放中的动作按 fadeOut 退出，新动作直接上位
    this._motionManager.startMotionPriority(
      motion,
      false,
      MotionPriority.Normal
    );
    return true;
  }

  // ---------- PetBehaviorHost：视线 ----------

  setLookTarget(x01: number, y01: number): void {
    this._lookTargetX = x01 * 2 - 1;
    this._lookTargetY = y01 * 2 - 1;
    this._lookActive = true;
  }

  clearLookTarget(): void {
    this._lookActive = false;
    this._lookTargetX = 0;
    this._lookTargetY = 0;
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
    this._intAngleX = angleX;
    this._intAngleY = angleY;
    this._intAngleZ = angleZ;
    this._intBodyX = bodyAngleX;
  }

  public setEyeOverride(
    enabled: boolean,
    leftOpen: number,
    rightOpen: number
  ): void {
    this._eyeOverrideEnabled = enabled;
    this._eyeOverrideL = leftOpen;
    this._eyeOverrideR = rightOpen;
  }

  public setEarInteraction(
    enabled: boolean,
    leftValue: number,
    rightValue: number
  ): void {
    this._earEnabled = enabled;
    this._earL = leftValue;
    this._earR = rightValue;
  }

  public setFaceCheek(enabled: boolean, value: number): void {
    this._cheekEnabled = enabled;
    this._cheek = value;
  }

  public setPettingLookAtReduction(enabled: boolean): void {
    this._lookAtReduction = enabled;
  }

  // ---------- 每帧 ----------

  public update(deltaTimeSeconds: number): void {
    if (!this._ready) return;
    const model = this._model;

    model.loadParameters();

    // 动作（播完自动解除优先级；占位动作库无 Idle 循环，呼吸接管待机）
    this._motionUpdated = this._motionManager.updateMotion(
      model,
      deltaTimeSeconds
    );

    model.saveParameters();

    // 物理 → 眨眼（动作/覆盖期间自动暂停）→ 呼吸
    this._updateScheduler.onLateUpdate(model, deltaTimeSeconds);

    // 视线跟随（一阶滞后平滑；抚摸期间降权重；清除目标后回中）
    this._updateLook(deltaTimeSeconds);

    // 互动写入：头部偏移（加性）
    if (this._intAngleX !== 0) {
      model.addParameterValueById(this._idAngleX, this._intAngleX);
    }
    if (this._intAngleY !== 0) {
      model.addParameterValueById(this._idAngleY, this._intAngleY);
    }
    if (this._intAngleZ !== 0) {
      model.addParameterValueById(this._idAngleZ, this._intAngleZ);
    }
    if (this._intBodyX !== 0) {
      model.addParameterValueById(this._idBodyAngleX, this._intBodyX);
    }

    // 眼睛覆盖（绝对值；覆盖期间眨眼已被调度器跳过）
    if (this._eyeOverrideEnabled) {
      if (this._eyeBlinkIds[0]) {
        model.setParameterValueById(this._eyeBlinkIds[0], this._eyeOverrideL);
      }
      if (this._eyeBlinkIds[1]) {
        model.setParameterValueById(this._eyeBlinkIds[1], this._eyeOverrideR);
      }
    }

    // 猫耳 / 脸红（参数缺失时写入无害——Framework 落到虚拟参数表）
    if (this._earEnabled) {
      model.addParameterValueById(this._idEarL, this._earL);
      model.addParameterValueById(this._idEarR, this._earR);
    }
    if (this._cheekEnabled) {
      model.setParameterValueById(this._idCheek, this._cheek);
    }

    model.update();
  }

  private _updateLook(dt: number): void {
    const targetX = this._lookActive ? this._lookTargetX : 0;
    const targetY = this._lookActive ? this._lookTargetY : 0;
    const k = 1.0 - Math.exp(-dt / PetModel._lookTauSeconds);
    this._lookCurrentX += (targetX - this._lookCurrentX) * k;
    this._lookCurrentY += (targetY - this._lookCurrentY) * k;

    // 静止且已回中：跳过写入
    if (
      !this._lookActive &&
      Math.abs(this._lookCurrentX) < 0.001 &&
      Math.abs(this._lookCurrentY) < 0.001
    ) {
      return;
    }
    const scale = this._lookAtReduction
      ? PetModel._lookReductionScale
      : 1.0;
    this._look.updateParameters(
      this._model,
      this._lookCurrentX * scale,
      this._lookCurrentY * scale
    );
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
