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
import { CubismEyeBlink, EyeState } from '@framework/effect/cubismeyeblink';
import { CubismLook, LookParameterData } from '@framework/effect/cubismlook';
import { AttenuatedBreathUpdater, ContinuousEyeBlinkUpdater, FadingExpressionUpdater } from './animation-updaters';
import { CubismUpdateScheduler } from '@framework/motion/cubismupdatescheduler';
import { CubismMotion } from '@framework/motion/cubismmotion';
import { CubismExpressionMotion } from '@framework/motion/cubismexpressionmotion';
import { applyFaceMouth, applyFaceVariant, expressionEye, EyeVariantTransition, FACE_MOUTH_PARAMETERS, FACE_VARIANT_PARAMETERS } from './face-variant';
import { FaceCueTrack, parseFaceCues, type FaceCueSpan, type FaceState } from './face-cue';
import { FX_NAMES, FX_PARAMETERS, FxChannel, parseFxCues, type FxName, type FxSpan } from './fx-cue';
import {
  InteractionParamInfo,
  InteractionTarget,
  type ArmInteractionValues,
  type FaceMicroInteractionValues,
  type PartImpulseKind,
} from './interaction/target';
import type { PetBehaviorHost } from './behavior';
import { MOTION_NAMES } from './catalog';
import { GazeController } from './gaze';
import {
  OverlayLayer,
  InteractionOffsetChannel,
  EyeOverrideChannel,
  EarChannel,
  EarDragPhysics,
  CheekChannel,
  HandRaiseChannel,
  GlassesChannel,
  ArmInteractionChannel,
  FaceMicroChannel,
  PartImpulseChannel,
  type PartImpulseSpec,
  type PartImpulseTarget,
  AngerMarkSplit,
} from './overlay';

/** 只显示怒气符号 / 只显示黑脸的表情（都借用 Param32，见 AngerMarkSplit）。 */
const ANGER_SPLIT_MODES: Record<string, 'mark' | 'shade'> = { annoyed: 'mark', gloomy: 'shade' };
import { assetUrl } from './embed';

/** 动作优先级（与官方 LAppDefine 一致）。 */
export const MotionPriority = {
  None: 0,
  Idle: 1,
  Normal: 2,
  Force: 3,
} as const;

/** 动作资源附加数据（assets/live2d/aliya/actions.json）。 */
interface ActionAssetEntry {
  name: string;
  /** 动作期间的整套眼型/替换嘴型时间轴（见 face-cue.ts）。 */
  face?: unknown;
  /** 动作期间的情绪符号时间轴（见 fx-cue.ts）。 */
  fx?: unknown;
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
  private _shaderPath = assetUrl('/shaders/');
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
  private readonly _motionBaseFadeIn = new WeakMap<CubismMotion, number>();
  private _motionUpdated = false;

  // 表情（exp3.json；眼睑乘法，其余安全参数加性叠加）。
  // 管理器复用 CubismUserModel 基类自带的 _expressionManager。
  private readonly _expressions = new Map<string, CubismExpressionMotion>();
  private _currentExpression: string | null = null;

  // 眨眼参数 ID（覆盖写入用）
  private _eyeBlinkIds: CubismIdHandle[] = [];

  // 视线（唯一所有者）与程序化覆盖层（句柄就绪后装配）
  private _gaze: GazeController = null;
  private readonly _overlays = new OverlayLayer();
  private _chInteraction: InteractionOffsetChannel = null;
  private _chEye: EyeOverrideChannel = null;
  private _chEar: EarChannel = null;
  private _chEarDrag: EarDragPhysics | null = null;
  private _chCheek: CheekChannel = null;
  private _chHand: HandRaiseChannel = null;
  private _chGlasses: GlassesChannel | null = null;
  private _chArm: ArmInteractionChannel = null;
  private _chFaceMicro: FaceMicroChannel = null;
  private _chPartImpulse: PartImpulseChannel = null;
  /** 情绪符号图层（ParamFx*），随动作时间轴与表情联动。 */
  private _chFx: FxChannel = null;
  private _angerSplit: AngerMarkSplit | null = null;
  private _idAngerShadow: CubismIdHandle = null;
  private _lookAtReduction = false; // 抚摸期间视线跟随降权
  // 猫耳显隐：部件不透明度逐帧逼近目标（部件不进 saveParameters，每帧显式写入）。
  private _earPartIndex = -1;
  private _earsVisible = true;
  private _earBlend = 1;
  private _earOpacity = 1;
  private _hasGlasses = false;
  private static readonly _earFadeSeconds = 0.18;
  private static readonly _lookReductionScale = 0.25;

  // 热路径参数句柄缓存（配置探测后填充）
  private _idAngleX: CubismIdHandle = null;
  private _idAngleY: CubismIdHandle = null;
  private _idAngleZ: CubismIdHandle = null;
  private _idBodyAngleX: CubismIdHandle = null;
  private _idBodyAngleY: CubismIdHandle = null;
  private _idBodyAngleZ: CubismIdHandle = null;
  private _idEarL: CubismIdHandle = null;
  private _idEarR: CubismIdHandle = null;
  private _idCheek: CubismIdHandle = null;
  private _idEyeBallX: CubismIdHandle = null;
  private _idEyeBallY: CubismIdHandle = null;
  /** 会切换整套特殊眼睛、无法安全交叉淡化的模型参数。 */
  private _unsafeFaceVariantIds: CubismIdHandle[] = [];
  private _faceVariantIds: CubismIdHandle[] = [];
  private _faceMouthIds: CubismIdHandle[] = [];
  /** 动作名 → 脸部提示时间轴（actions.json face 字段）。 */
  private readonly _faceCues = new Map<string, FaceCueSpan[]>();
  /** 动作名 → 情绪符号时间轴（actions.json fx 字段）。 */
  private readonly _fxCues = new Map<string, FxSpan[]>();
  private readonly _faceTrack = new FaceCueTrack();
  private _face: FaceState = { eye: null, mouth: null };
  /** 特殊眼型（流泪/无语/受击）切换：先闭眼，流泪/无语再在闭眼下渐变。 */
  private readonly _eyeTransition = new EyeVariantTransition();
  private _holdClosedRemaining = 0;
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

    // 静态包围盒：默认姿态下可见 drawable 顶点的 min/max（native 同款算法）。
    // 默认透明的网格（情绪符号、替换脸）不计入：符号伸出头顶，计入会让人物整体缩小。
    {
      this._model.update();
      const dc = this._model.getDrawableCount();
      let minX = 1e9,
        maxX = -1e9,
        minY = 1e9,
        maxY = -1e9;
      for (let i = 0; i < dc; i++) {
        if (this._model.getDrawableOpacity(i) < 0.01) continue;
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
    // 与 _loadTexture 的预乘上传一致，让图层透明度同时作用于 RGB。
    this.getRenderer().setIsPremultipliedAlpha(true);
    // 提高裁剪遮罩缓冲区到 512：默认 256 对当前显示尺寸偏小，
    // 遮罩贴图放大后边缘锯齿明显。需在 startUp 前设置，
    // 使 FBO 首次创建即按目标尺寸分配，避免二次重建。
    const renderer = this.getRenderer();
    if (typeof renderer.setClippingMaskBufferSize === 'function') {
      renderer.setClippingMaskBufferSize(512);
    }
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
      new ContinuousEyeBlinkUpdater(
        // 始终推进眨眼时钟；动作暂时拥有眼睛时只保留它的输出。
        () => this._motionUpdated,
        this._eyeBlink
      )
    );

    // 呼吸（收敛强绑定头侧倾，加入与呼吸同频的轻胸腔俯仰，并在动作期间平滑减幅头身摆动）
    this._breath = CubismBreath.create();
    const id = (s: string) => CubismFramework.getIdManager().getId(s);
    const idBreath = id(CubismDefaultParameterId.ParamBreath);
    this._breath.setParameters([
      new BreathParameterData(id(CubismDefaultParameterId.ParamAngleX), 0.0, 9.0, 6.5345, 0.5),
      new BreathParameterData(id(CubismDefaultParameterId.ParamAngleY), 0.0, 8.0, 3.5345, 0.5),
      new BreathParameterData(id(CubismDefaultParameterId.ParamAngleZ), 0.0, 4.5, 5.5345, 0.5),
      new BreathParameterData(id(CubismDefaultParameterId.ParamBodyAngleX), 0.0, 3.5, 15.5345, 0.5),
      new BreathParameterData(id(CubismDefaultParameterId.ParamBodyAngleY), 0.0, 1.4, 3.2345, 0.5),
      new BreathParameterData(idBreath, 0.5, 0.5, 3.2345, 1.0),
    ]);
    this._updateScheduler.addUpdatableList(
      new AttenuatedBreathUpdater(() => this._motionUpdated, this._breath, idBreath, 0.35)
    );

    // 视线跟随增益（GazeController 内合成；头部按 Q 版模型调低：官方 ±30
    // 的 AngleZ 在该模型绑定极强会「断头」，收敛到动作库同量级 ±6~12）。
    const look = CubismLook.create();
    look.setParameters([
      new LookParameterData(id(CubismDefaultParameterId.ParamAngleX), 12, 0, 0),
      new LookParameterData(id(CubismDefaultParameterId.ParamAngleY), 0, 10, 0),
      new LookParameterData(id(CubismDefaultParameterId.ParamAngleZ), 0, 0, -8),
      new LookParameterData(id(CubismDefaultParameterId.ParamBodyAngleX), 7.5, 0, 0),
      new LookParameterData(id(CubismDefaultParameterId.ParamBodyAngleY), 0, 7.0, 0),
      // 该模型眼球参数值域是 ±30（非官方惯例的 ±1），取 18（60% 行程）
      new LookParameterData(id(CubismDefaultParameterId.ParamEyeBallX), 18, 0, 0),
      new LookParameterData(id(CubismDefaultParameterId.ParamEyeBallY), 0, 18, 0),
    ]);

    // 互动参数句柄缓存
    this._idAngleX = id(CubismDefaultParameterId.ParamAngleX);
    this._idAngleY = id(CubismDefaultParameterId.ParamAngleY);
    this._idAngleZ = id(CubismDefaultParameterId.ParamAngleZ);
    this._idBodyAngleX = id(CubismDefaultParameterId.ParamBodyAngleX);
    this._idBodyAngleY = id(CubismDefaultParameterId.ParamBodyAngleY);
    this._idBodyAngleZ = id(CubismDefaultParameterId.ParamBodyAngleZ);
    // 猫耳：旧模型的 ParamEarL/R 在新模型上不存在；新模型耳朵由物理输出
    // Param8/9/10（左）与 Param12/13/14（右）驱动，写入点在物理之后（EarChannel）。
    const hasParam = (name: string): boolean => {
      for (let i = 0; i < this._model.getParameterCount(); i++) {
        if (this._model.getParameterId(i).getString() === name) return true;
      }
      return false;
    };
    const optId = (name: string): CubismIdHandle | undefined => (hasParam(name) ? id(name) : undefined);
    const hasLegacyEars = hasParam('ParamEarL') && hasParam('ParamEarR');
    const idEarL = id(hasLegacyEars ? 'ParamEarL' : 'Param9');
    const idEarR = id(hasLegacyEars ? 'ParamEarR' : 'Param13');
    this._idEarL = idEarL;
    this._idEarR = idEarR;
    this._idCheek = id('ParamCheek');
    this._idEyeBallX = id('ParamEyeBallX');
    this._idEyeBallY = id('ParamEyeBallY');
    this._unsafeFaceVariantIds = [id('Param33'), id('Param34'), id('Param35')];
    // 猫耳父部件（cdi3「猫耳」）；缺失的模型不提供显隐开关。
    {
      const index = this._model.getPartIndex(id('Part21'));
      this._earPartIndex = index >= 0 && index < this._model.getPartCount() ? index : -1;
    }
    this._faceVariantIds = FACE_VARIANT_PARAMETERS.map(id);
    this._faceMouthIds = FACE_MOUTH_PARAMETERS.map(id);

    const glassesId = optId('Param43');
    this._hasGlasses = Boolean(glassesId);

    // 按真实参数探测新版挥手/划重点能力；缺少参数时保留旧模型的五段链。
    // 不向 SDK 创建的虚拟参数写入，两个版本均在物理后统一控制。
    const nativeWave = ['Param30', 'Param31', 'Param36'].every(hasParam)
      ? {
          enabled: id('Param30'),
          forearm: id('Param31'),
          hand: id('Param36'),
          pointOut: optId('Param42'),
          mouthForm: optId('ParamMouthForm'),
        }
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
      bodyAngleY: hasParam(CubismDefaultParameterId.ParamBodyAngleY) ? this._idBodyAngleY : undefined,
      bodyAngleZ: hasParam(CubismDefaultParameterId.ParamBodyAngleZ) ? this._idBodyAngleZ : undefined,
    });
    this._chEye = new EyeOverrideChannel({
      left: this._eyeBlinkIds[0],
      right: this._eyeBlinkIds[1] ?? this._eyeBlinkIds[0],
    });
    const earLeftRot = hasLegacyEars ? undefined : optId('Param8');
    const earLeftTip = hasLegacyEars ? undefined : optId('Param10');
    const earRightRot = hasLegacyEars ? undefined : optId('Param12');
    const earRightTip = hasLegacyEars ? undefined : optId('Param14');
    this._chEar = new EarChannel(hasLegacyEars
      ? { left: idEarL, right: idEarR }
      : {
          left: idEarL,
          right: idEarR,
          leftRot: earLeftRot,
          leftTip: earLeftTip,
          rightRot: earRightRot,
          rightTip: earRightTip,
        });
    this._chEar.scale = 1;
    this._chEarDrag = earLeftRot && earLeftTip && earRightRot && earRightTip
      ? new EarDragPhysics({
          leftRot: earLeftRot,
          leftMid: idEarL,
          leftTip: earLeftTip,
          leftPersp: optId('Param7'),
          rightRot: earRightRot,
          rightMid: idEarR,
          rightTip: earRightTip,
          rightPersp: optId('Param11'),
        })
      : null;
    this._chCheek = new CheekChannel(this._idCheek);
    this._chHand = new HandRaiseChannel(idsHandR, nativeWave);
    this._chGlasses = new GlassesChannel(glassesId);
    this._chArm = new ArmInteractionChannel(
      {
        l01: optId('ParamArmL01'),
        l02: optId('ParamArmL02'),
        r01: optId('ParamArmR01'),
        r02: optId('ParamArmR02'),
      },
      () => this._chHand?.raising ?? 0
    );
    this._chFaceMicro = new FaceMicroChannel({
      eyeLSmile: optId('ParamEyeLSmile'),
      eyeRSmile: optId('ParamEyeRSmile'),
      mouthForm: optId('ParamMouthForm'),
      mouthOpen: optId('ParamMouthOpenY'),
      browLY: optId('ParamBrowLY'),
      browRY: optId('ParamBrowRY'),
      browLAngle: optId('ParamBrowLAngle'),
      browRAngle: optId('ParamBrowRAngle'),
      browLForm: optId('ParamBrowLForm'),
      browRForm: optId('ParamBrowRForm'),
    });
    const collectChain = (entries: ReadonlyArray<readonly [string, number]>): PartImpulseTarget[] => {
      const list: PartImpulseTarget[] = [];
      for (const [name, weight] of entries) {
        const handle = optId(name);
        if (handle) list.push({ id: handle, weight });
      }
      return list;
    };
    const impulseSpecs: Partial<Record<PartImpulseKind, PartImpulseSpec>> = {
      tie: {
        targets: collectChain([
          ['Param_Angle_Rotation_1_ArtMesh42', 0.65],
          ['Param_Angle_Rotation_2_ArtMesh42', 1.0],
          ['Param_Angle_Rotation_3_ArtMesh42', 0.85],
        ]),
        min: -45, max: 45, omega: 15, zeta: 0.24, maxAmp: 22,
      },
      bangs: {
        targets: collectChain([
          ['Param_Angle_Rotation_1_ArtMesh8', 0.25],
          ['Param_Angle_Rotation_2_ArtMesh8', 0.45],
          ['Param_Angle_Rotation_3_ArtMesh8', 0.65],
          ['Param_Angle_Rotation_4_ArtMesh8', 0.85],
          ['Param_Angle_Rotation_5_ArtMesh8', 1.0],
          ['Param_Angle_Rotation_6_ArtMesh8', 1.0],
          ['Param_Angle_Rotation_7_ArtMesh8', 0.9],
          ['Param_Angle_Rotation_1_ArtMesh7', 0.3],
          ['Param_Angle_Rotation_2_ArtMesh7', 0.55],
          ['Param_Angle_Rotation_3_ArtMesh7', 0.8],
          ['Param_Angle_Rotation_4_ArtMesh7', 1.0],
          ['Param_Angle_Rotation_5_ArtMesh7', 0.9],
        ]),
        min: -45, max: 45, omega: 13, zeta: 0.42, maxAmp: 4.2,
      },
      side_hair_left: {
        targets: collectChain([
          ['Param_Angle_Rotation_1_FrontHair_L', 0.3],
          ['Param_Angle_Rotation_2_FrontHair_L', 0.5],
          ['Param_Angle_Rotation_3_FrontHair_L', 0.7],
          ['Param_Angle_Rotation_4_FrontHair_L', 0.85],
          ['Param_Angle_Rotation_5_FrontHair_L', 1.0],
          ['Param_Angle_Rotation_6_FrontHair_L', 1.0],
          ['Param_Angle_Rotation_7_FrontHair_L', 0.9],
          ['Param_Angle_Rotation_1_ArtMesh54', 0.35],
          ['Param_Angle_Rotation_2_ArtMesh54', 0.6],
          ['Param_Angle_Rotation_3_ArtMesh54', 0.85],
          ['Param_Angle_Rotation_4_ArtMesh54', 1.0],
          ['Param_Angle_Rotation_5_ArtMesh54', 0.9],
        ]),
        min: -45, max: 45, omega: 14, zeta: 0.26, maxAmp: 9.5,
      },
      side_hair_right: {
        targets: collectChain([
          ['Param_Angle_Rotation_1_FrontHair_R', 0.3],
          ['Param_Angle_Rotation_2_FrontHair_R', 0.5],
          ['Param_Angle_Rotation_3_FrontHair_R', 0.7],
          ['Param_Angle_Rotation_4_FrontHair_R', 0.85],
          ['Param_Angle_Rotation_5_FrontHair_R', 1.0],
          ['Param_Angle_Rotation_6_FrontHair_R', 1.0],
          ['Param_Angle_Rotation_7_FrontHair_R', 0.9],
          ['Param_Angle_Rotation_1_ArtMesh55', 0.3],
          ['Param_Angle_Rotation_2_ArtMesh55', 0.5],
          ['Param_Angle_Rotation_3_ArtMesh55', 0.7],
          ['Param_Angle_Rotation_4_ArtMesh55', 0.85],
          ['Param_Angle_Rotation_5_ArtMesh55', 1.0],
          ['Param_Angle_Rotation_6_ArtMesh55', 1.0],
          ['Param_Angle_Rotation_7_ArtMesh55', 0.9],
        ]),
        min: -45, max: 45, omega: 14, zeta: 0.26, maxAmp: 9.5,
      },
      ponytail: {
        targets: collectChain([
          ['Param_Angle_Rotation_1_ArtMesh59', 0.15],
          ['Param_Angle_Rotation_2_ArtMesh59', 0.2],
          ['Param_Angle_Rotation_3_ArtMesh59', 0.3],
          ['Param_Angle_Rotation_4_ArtMesh59', 0.4],
          ['Param_Angle_Rotation_5_ArtMesh59', 0.55],
          ['Param_Angle_Rotation_6_ArtMesh59', 0.7],
          ['Param_Angle_Rotation_7_ArtMesh59', 0.85],
          ['Param_Angle_Rotation_8_ArtMesh59', 0.95],
          ['Param_Angle_Rotation_9_ArtMesh59', 1.0],
          ['Param_Angle_Rotation_10_ArtMesh59', 1.0],
          ['Param_Angle_Rotation_11_ArtMesh59', 0.9],
          ['Param_Angle_Rotation_12_ArtMesh59', 0.8],
          ['Param_Angle_Rotation_13_ArtMesh59', 0.7],
        ]),
        min: -45, max: 45, omega: 11, zeta: 0.26, maxAmp: 7.5,
      },
      hair_bounce: {
        targets: collectChain([['Param4', 1.0]]),
        min: -30, max: 30, omega: 17, zeta: 0.32, maxAmp: 18,
      },
      hand_left: {
        targets: collectChain([
          ['Param_Angle_B_BODY_6', 0.6],
          ['Param_Angle_B_BODY_7', 0.9],
          ['Param_Angle_B_BODY_8', 1.0],
        ]),
        min: -30, max: 30, omega: 16, zeta: 0.30, maxAmp: 12,
      },
      hand_right: {
        targets: collectChain([
          ['Param_Angle_B_BODY_9', 0.6],
          ['Param_Angle_B_BODY_10', 0.9],
          ['Param_Angle_B_BODY_11', 1.0],
        ]),
        min: -30, max: 30, omega: 16, zeta: 0.30, maxAmp: 12,
      },
      // 画面左耳 ear_left = 解剖右耳 Param12/13/14；画面右耳 ear_right = 解剖左耳 Param8/9/10
      ear_left: {
        targets: collectChain(hasLegacyEars
          ? [['ParamEarR', 1.0]]
          : [['Param12', 0.9], ['Param13', 0.7], ['Param14', 0.5]]),
        min: -1, max: 1, omega: 10.5, zeta: 0.32, maxAmp: 0.85,
      },
      ear_right: {
        targets: collectChain(hasLegacyEars
          ? [['ParamEarL', 1.0]]
          : [['Param8', 0.9], ['Param9', 0.7], ['Param10', 0.5]]),
        min: -1, max: 1, omega: 10.5, zeta: 0.32, maxAmp: 0.85,
      },
    };
    this._chPartImpulse = new PartImpulseChannel(impulseSpecs);
    // _chInteraction 在物理之前应用，让点击/抚摸/拎起的头身动作自然带动头发、猫耳与领带物理；
    // 其余通道（猫耳加写/脸红/挥手/四腕/微表情/局部弹性/情绪符号）在物理之后叠加。
    this._overlays.add(this._chEar);
    this._overlays.add(this._chCheek);
    this._overlays.add(this._chGlasses);
    this._overlays.add(this._chHand);
    this._overlays.add(this._chArm);
    this._overlays.add(this._chFaceMicro);
    this._overlays.add(this._chPartImpulse);
    const fxIds = new Map<FxName, CubismIdHandle>();
    for (const fx of FX_NAMES) fxIds.set(fx, id(FX_PARAMETERS[fx]));
    this._chFx = new FxChannel(fxIds, [id('Param37'), id('Param40'), id('Param41')]);
    this._overlays.add(this._chFx);
    // 黑脸 ArtMesh11 / 怒气符号 ArtMesh12 均由 Param32 驱动（Core 逐值扫描确认）
    const shadeIndex = this._model.getDrawableIndex(id('ArtMesh11'));
    const markIndex = this._model.getDrawableIndex(id('ArtMesh12'));
    this._idAngerShadow = id('Param32');
    this._angerSplit = shadeIndex >= 0 && markIndex >= 0
      ? new AngerMarkSplit(shadeIndex, markIndex) : null;

    // 动作库（tools/gen-motions.py 为 Aliya 生成的自编动作）
    await this._preloadMotions();

    // 动作脸部时间轴（可选：缺失时替换脸动作只播普通曲线）
    try {
      const buf = await this._fetchArrayBuffer('actions.json');
      const parsed = JSON.parse(new TextDecoder().decode(buf));
      if (Array.isArray(parsed.actions)) {
        for (const entry of parsed.actions as ActionAssetEntry[]) {
          const spans = parseFaceCues(entry.face);
          if (spans.length > 0) this._faceCues.set(entry.name, spans);
          const fx = parseFxCues(entry.fx);
          if (fx.length > 0) this._fxCues.set(entry.name, fx);
        }
      }
    } catch {
      // 可选文件，缺失不阻塞
    }

    // 表情库（tools/gen-expressions.py 生成，model3.json Expressions 引用）。
    // 求值顺序 = CubismUpdateOrder_Expression(300)：眨眼后、呼吸/物理前，
    // Add 混合叠加在动作结果之上，且不进 saveParameters 快照（每帧重施加）。
    await this._preloadExpressions();
    this._updateScheduler.addUpdatableList(
      new FadingExpressionUpdater(this._expressionManager)
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
        // 新队列保留旧表情的淡出，已淡出的条目由 updater 清理。
        this._expressionManager.startMotion(neutral, false);
      }
      this._currentExpression = null;
      this._chFx?.setExpression(null);
      this._gaze.setExpression(null);
      this._angerSplit?.setMode(null);
      return true;
    }
    const expr = this._expressions.get(name);
    if (!expr) return false;
    if (this._currentExpression === name) return true;
    this._expressionManager.startMotion(expr, false);
    this._currentExpression = name;
    this._chFx?.setExpression(name);
    // 表情注视偏移（垂眼/回避/斜眼）由视线控制器合成，exp3 不直写眼球
    this._gaze.setExpression(name);
    this._angerSplit?.setMode(ANGER_SPLIT_MODES[name] ?? (name === 'angry' ? 'both' : null));
    return true;
  }

  public isReady(): boolean {
    return this._ready;
  }

  /** 已加载可播放的 Live2D 动作名。 */
  public getMotionNames(): string[] {
    return MOTION_NAMES.filter(name => this._motions.has(`${name}_0`));
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
      // 隐藏的网格（如关掉的猫耳）不算剪影，气泡贴着可见头顶。
      if (this._model.getDrawableOpacity(i) < 0.01) continue;
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
    for (const group of MOTION_NAMES) {
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
          const baseFadeIn = fadeIn >= 0 ? fadeIn : 1.0;
          motion.setFadeInTime(baseFadeIn);
          motion.setFadeOutTime(fadeOut >= 0 ? fadeOut : 1.0);
          this._motionBaseFadeIn.set(motion, baseFadeIn);
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

  /** 空闲起播用更紧凑的淡入以保留 0.1–0.25s 预备动作，打断进行中动作保留完整交叉淡化。 */
  private _prepareMotionFadeIn(motion: CubismMotion): void {
    const baseFadeIn = this._motionBaseFadeIn?.get(motion);
    if (baseFadeIn === undefined || typeof motion.setFadeInTime !== 'function') return;
    const interrupting = !this._motionManager.isFinished();
    motion.setFadeInTime(interrupting ? baseFadeIn : Math.min(baseFadeIn, 0.22));
  }

  /** 播放指定动作。低优先级不打断播放中的高优先级动作。 */
  public startMotion(group: string, index: number, priority: number): number {
    if (!this._ready) return INVALID_MOTION_HANDLE;
    if (priority <= this._motionManager.getCurrentPriority()) {
      return INVALID_MOTION_HANDLE;
    }
    const motion = this._motions.get(`${group}_${index}`);
    if (!motion) return INVALID_MOTION_HANDLE;
    this._prepareMotionFadeIn(motion);
    // SDK startMotion 会让旧动作淡出，不提前清空它的参数贡献。
    const handle = this._motionManager.startMotionPriority(motion, false, priority);
    if (handle !== INVALID_MOTION_HANDLE) {
      const duration = typeof motion.getDuration === 'function' ? motion.getDuration() : 0;
      this._onMotionStarted(group, duration);
    }
    return handle;
  }

  /** 动作成功起播时联动左手/眼镜/脸红/表情符号提示，并平滑收起上一动作通道。 */
  private _onMotionStarted(name: string, duration: number): void {
    if (name === 'wave') this._chHand?.trigger('wave', duration);
    else if (name === 'point_out') this._chHand?.trigger('point_out', duration);
    else this._chHand?.release();
    if (name === 'shy_sway') this._chCheek?.triggerAction(duration);
    else this._chCheek?.releaseAction();
    if (name === 'point_out') this._chGlasses?.triggerAction(duration);
    else this._chGlasses?.releaseAction();
    this._startFaceCue(name);
  }

  /** 新动作接管脸部时间轴；没有提示的动作会清掉被打断动作的眼型/嘴型。 */
  private _startFaceCue(name: string): void {
    const lidL = this._eyeBlinkIds?.[0];
    const lidR = this._eyeBlinkIds?.[1] ?? lidL;
    const eyeL = lidL && this._model?.getParameterValueById ? this._model.getParameterValueById(lidL) : 1;
    const eyeR = lidR && this._model?.getParameterValueById ? this._model.getParameterValueById(lidR) : eyeL;
    const transitionActive = this._eyeTransition?.active ?? false;
    const eyesClosed = (eyeL <= 0.05 && eyeR <= 0.05) || transitionActive;
    this._holdClosedRemaining = name === 'kiss' && transitionActive ? 0.58 : 0;
    const spans = this._faceCues?.get(name);
    if (spans) this._faceTrack?.start(spans, { eyesClosed });
    else this._faceTrack?.stop();
    this._chFx?.startAction(this._fxCues?.get(name));
  }

  /** 当前动作脸部提示（调试/测试用）。 */
  public get faceCue(): FaceState {
    return this._face;
  }

  get isActionPlaying(): boolean {
    return this._ready && !this._motionManager.isFinished();
  }

  /** PetBehaviorHost：播放语义动作（可互相打断，队列自带交叉淡出）。 */
  public playAction(name: string): boolean {
    if (!this._ready) return false;
    const count = this._setting.getMotionCount(name);
    if (count === 0) return false;
    const index = Math.floor(Math.random() * count);
    const motion = this._motions.get(`${name}_${index}`);
    if (!motion) return false;
    this._prepareMotionFadeIn(motion);
    // SDK 在淡出完成后回收旧动作；保留短暂重叠以连续交接。
    const handle = this._motionManager.startMotionPriority(
      motion,
      false,
      MotionPriority.Normal
    );
    if (handle === INVALID_MOTION_HANDLE) return false;
    // 从统一播放入口联动，设置页（Windows/Android）、AI 和自动行为均生效；不替换原表情。
    const duration = typeof motion.getDuration === 'function' ? motion.getDuration() : 0;
    this._onMotionStarted(name, duration);
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
    const bx = or(rangeOf(this._idBodyAngleX), -10, 10);
    const by = or(rangeOf(this._idBodyAngleY), -10, 10);
    const bz = or(rangeOf(this._idBodyAngleZ), -10, 10);
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
      bodyYMin: by.min,
      bodyYMax: by.max,
      bodyZMin: bz.min,
      bodyZMax: bz.max,
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

  public setBodyTilt(bodyAngleY: number, bodyAngleZ: number): void {
    this._chInteraction.bodyY = bodyAngleY;
    this._chInteraction.bodyZ = bodyAngleZ;
  }

  public setEyeOverride(
    enabled: boolean,
    leftOpen: number,
    rightOpen: number,
    side: 'both' | 'left' | 'right' = 'both'
  ): void {
    this._chEye.enabled = enabled;
    this._chEye.side = side;
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

  public setArmInteraction(
    enabled: boolean,
    values?: Partial<ArmInteractionValues>
  ): void {
    if (!this._chArm) return;
    this._chArm.enabled = enabled;
    this._chArm.armL01 = enabled ? (values?.armL01 ?? 0) : 0;
    this._chArm.armL02 = enabled ? (values?.armL02 ?? 0) : 0;
    this._chArm.armR01 = enabled ? (values?.armR01 ?? 0) : 0;
    this._chArm.armR02 = enabled ? (values?.armR02 ?? 0) : 0;
  }

  public setFaceMicroInteraction(
    enabled: boolean,
    values?: FaceMicroInteractionValues
  ): void {
    if (!this._chFaceMicro) return;
    this._chFaceMicro.enabled = enabled;
    this._chFaceMicro.eyeSmile = enabled ? (values?.eyeSmile ?? 0) : 0;
    this._chFaceMicro.mouthForm = enabled ? (values?.mouthForm ?? 0) : 0;
    this._chFaceMicro.mouthOpen = enabled ? (values?.mouthOpen ?? 0) : 0;
    this._chFaceMicro.browY = enabled ? (values?.browY ?? 0) : 0;
    this._chFaceMicro.browAngle = enabled ? (values?.browAngle ?? 0) : 0;
    this._chFaceMicro.browForm = enabled ? (values?.browForm ?? 0) : 0;
  }

  public triggerPartImpulse(part: PartImpulseKind, strength: number): void {
    this._chPartImpulse?.trigger(part, strength);
  }

  /** 模型是否有可隐藏的猫耳部件。 */
  public get hasCatEars(): boolean {
    return this._earPartIndex >= 0;
  }

  /**
   * 少动态效果：情绪符号只渐入渐出，不摆动、不闪烁。
   * 默认跟随系统「减少动态效果」，每帧读取（主桌宠与吊坠一致）；测试可显式覆盖。
   */
  public setReducedMotion(reduce: boolean | null): void {
    this._reducedMotionOverride = reduce;
  }
  private _reducedMotionOverride: boolean | null = null;
  private _reducedMotionQuery: MediaQueryList | null | undefined;
  private _reducedMotion(): boolean {
    if (this._reducedMotionOverride !== null) return this._reducedMotionOverride;
    if (this._reducedMotionQuery === undefined) {
      this._reducedMotionQuery = typeof matchMedia === 'function'
        ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    }
    return this._reducedMotionQuery?.matches ?? false;
  }

  /** 该网格是否属于猫耳部件（Part21 及其子部件）。 */
  public isEarDrawable(drawableIndex: number): boolean {
    if (this._earPartIndex < 0) return false;
    const parents = this._model.getPartParentPartIndices();
    let part = this._model.getDrawableParentPartIndex(drawableIndex);
    for (let guard = 0; part >= 0 && guard < 64; guard++) {
      if (part === this._earPartIndex) return true;
      part = parents[part];
    }
    return false;
  }

  /** 显示/隐藏猫耳；immediate 用于启动恢复，跳过淡变。 */
  public setCatEarsVisible(visible: boolean, immediate = false): void {
    this._earsVisible = visible;
    if (immediate) {
      this._earBlend = visible ? 1 : 0;
      this._earOpacity = this._earBlend;
    }
  }

  /** 模型是否有可开关的黑框眼镜饰品（Param43）。 */
  public get hasGlasses(): boolean {
    return this._hasGlasses;
  }

  /** 显示/隐藏黑框眼镜饰品；immediate 用于启动恢复，跳过淡变。 */
  public setGlassesVisible(visible: boolean, immediate = false): void {
    this._chGlasses?.setVisible(visible, immediate);
  }

  /**
   * 物理「风力」（Cubism 粒子坐标，y 向下，量纲约为重力的倍数）。
   * 鼠标吊坠和主桌宠拎起拖动时用它把整体摆动的惯性力传给头发、裙摆等物理链。
   */
  public setPhysicsWind(x: number, y: number): void {
    const options = this._physics?.getOption();
    if (!options || !Number.isFinite(x) || !Number.isFinite(y)) return;
    options.wind.x = x;
    options.wind.y = y;
    this._chEarDrag?.setWind(x, y);
  }

  public setPettingLookAtReduction(enabled: boolean): void {
    this._lookAtReduction = enabled;
  }

  // ---------- 每帧（五阶段流水线） ----------

  private _writeTransitionLid(model: PetModel['_model'], lid: number | null): void {
    if (lid === null) return;
    model.setParameterValueById(this._eyeBlinkIds[0], lid);
    model.setParameterValueById(this._eyeBlinkIds[1] ?? this._eyeBlinkIds[0], lid);
  }

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
    // 动作脸部提示优先于表情眼型：动作结束后回到表情自己的眼睛。
    this._face = this._faceTrack.advance(deltaTimeSeconds);
    const targetEye = this._face.eye ?? expressionEye(this._currentExpression);
    // 眼睑必须先于物理写入，否则眼珠/高光物理读到的是另一套开合值。
    this._chEye.apply(model, deltaTimeSeconds);
    // 特殊眼型切换先闭眼：读到的是眨眼/动作/互动合成后的真实眼睑。
    const lidNow = Math.min(
      model.getParameterValueById(this._eyeBlinkIds[0]),
      model.getParameterValueById(this._eyeBlinkIds[1] ?? this._eyeBlinkIds[0])
    );
    if (this._holdClosedRemaining > 0) {
      this._holdClosedRemaining = Math.max(0, this._holdClosedRemaining - Math.max(0, deltaTimeSeconds));
    }
    const eyeTransition = this._eyeTransition.advance(
      targetEye,
      deltaTimeSeconds,
      lidNow,
      this._holdClosedRemaining > 0
    );
    const eye = eyeTransition.eye;
    applyFaceVariant(model, this._faceVariantIds, eye, eyeTransition.weight, eyeTransition.mute);
    // 过渡眼睑在物理前也写一次，眼珠/高光物理跟着一起闭合。
    this._writeTransitionLid(model, eyeTransition.lid);

    // 4. 视线（唯一所有者：指针跟随 × 动作交控权重 × 抚摸降权
    //    + 表情注视偏移 → 眼球总钳制）
    // 取两眼最大开合，保证得意单眼 wink / 单眼眨时睁开的那只眼仍正常注视。
    const eyeL = model.getParameterValueById(this._eyeBlinkIds[0]);
    const eyeR = model.getParameterValueById(this._eyeBlinkIds[1] ?? this._eyeBlinkIds[0]);
    const blinkState = (this._eyeBlink as { _blinkingState?: number } | null)?._blinkingState ?? EyeState.EyeState_Interval;
    const blinking = !this._motionUpdated && !this._chEye.enabled && eyeTransition.lid === null
      && blinkState >= EyeState.EyeState_Closing;
    this._gaze.update(model, deltaTimeSeconds, {
      motionActive: this._motionUpdated,
      reduction: this._lookAtReduction ? PetModel._lookReductionScale : 1,
      eyeOpenness: Math.max(eyeL, eyeR),
      blinking,
    });
    // 互动头身偏移放在物理之前，使点击/抚摸/拎起动作能自然带出头发、猫耳与领带物理。
    this._chInteraction?.apply(model, deltaTimeSeconds);
    if (this._physics) this._physics.evaluate(model, deltaTimeSeconds);

    const reducedMotion = this._reducedMotion();
    // 拖拽期间用 3 段耦合弹簧链模拟猫耳惯性（耳根→中段→耳尖滞后、加减速冲击、软限幅回弹），
    // 并接管原物理中左耳水平风力反偏的输出，叠加点在 EarChannel/PartImpulse 之前。
    if (this._chEarDrag) {
      this._chEarDrag.visible = this._earsVisible;
      this._chEarDrag.reducedMotion = reducedMotion;
      if (this._physics) this._chEarDrag.apply(model, deltaTimeSeconds);
    }
    if (this._chFx) this._chFx.reducedMotion = reducedMotion;
    if (this._chEar) this._chEar.visible = this._earsVisible;
    if (this._chPartImpulse) {
      this._chPartImpulse.reducedMotion = reducedMotion;
      this._chPartImpulse.earsVisible = this._earsVisible;
    }
    // 5. 程序化覆盖通道（猫耳加写/脸红/抬手/四腕/微表情/局部弹性/情绪符号；
    //    晚于物理，可直接加写物理输出参数）→ 应用到顶点
    this._overlays.apply(model, deltaTimeSeconds);

    // 在动作、表情淡化、物理和互动之后独占写入整套眼型与替换嘴型。
    // 受击始终 0/1；流泪/无语只在普通眼闭合时渐变。
    applyFaceVariant(model, this._faceVariantIds, eye, eyeTransition.weight, eyeTransition.mute);
    // 过渡眼睑最后写，盖过动作、眨眼与互动对 EyeOpen 的写入。
    this._writeTransitionLid(model, eyeTransition.lid);
    applyFaceMouth(model, this._faceMouthIds, this._face.mouth, eye);

    if (this._earPartIndex >= 0) {
      const target = this._earsVisible ? 1 : 0;
      if (this._earBlend !== target) {
        const step = Math.max(0, deltaTimeSeconds) / PetModel._earFadeSeconds;
        this._earBlend = target > this._earBlend
          ? Math.min(target, this._earBlend + step) : Math.max(target, this._earBlend - step);
        this._earOpacity = this._earBlend * this._earBlend * (3 - 2 * this._earBlend);
      }
      model.setPartOpacityByIndex(this._earPartIndex, this._earOpacity);
    }

    model.update();
    // 拆分只改已求值的网格不透明度，必须在 update 之后、绘制之前。
    this._angerSplit?.apply(model.getModel().drawables.opacities, deltaTimeSeconds,
      model.getParameterValueById(this._idAngerShadow));
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

  /**
   * 加载 PNG 并上传为预乘 alpha 纹理（与官方渲染器的混合方式配套）。
   * createImageBitmap 在解码线程完成 2048² 贴图解码与预乘，主线程只做上传，
   * 启动时不卡交互；上传后立即 close 释放解码位图，不让 16MB 像素常驻图片缓存。
   */
  private async _loadTexture(fileName: string): Promise<WebGLTexture> {
    const response = await fetch(`${this._homeDir}${fileName}`);
    if (!response.ok) throw new Error(`failed to load texture ${fileName}`);
    const bitmap = await createImageBitmap(await response.blob(), { premultiplyAlpha: 'premultiply' });
    try {
      const gl = this._gl;
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      // ImageBitmap 的预乘已在解码时完成，像素存储标志对它无效，保持默认避免二次预乘。
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      gl.generateMipmap(gl.TEXTURE_2D);
      // 显式设定采样参数：三线性过滤让 mipmap 层级切换连续，
      // CLAMP_TO_EDGE 避免边缘混合到透明区污染色。
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      return texture;
    } finally {
      bitmap.close();
    }
  }
}
