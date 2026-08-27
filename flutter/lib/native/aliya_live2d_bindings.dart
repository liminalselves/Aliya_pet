import 'dart:ffi';
import 'dart:io';

import 'package:ffi/ffi.dart';

// 绑定层声明大量函数供各模块使用，部分暂未调用属正常情况。
// ignore_for_file: unused_field

/// AliyaLive2D.Native C ABI 绑定（v9）。
///
/// 对应 C 头文件：native/AliyaLive2D.Native/src/aliya_live2d.h
/// 平台库名：Windows → AliyaLive2D.Native.dll；Android → libAliyaLive2D.Native.so

/// 返回码（与 C 枚举 AliyaLive2DResultValue 一致）。
class AliyaResult {
  static const int ok = 0;
  static const int errInvalidArg = -1;
  static const int errInitFailed = -2;
  static const int errLoadFailed = -3;
  static const int errDeviceFailed = -4;
  static const int errModelFailed = -5;
  static const int errNotReady = -6;
  static const int errAlreadyExists = -7;
  static const int errD3D9 = -8;
  static const int errPhysics = -9;
  static const int errState = -10;
  static const int errUnsupported = -11;

  static String describe(int code) {
    switch (code) {
      case ok:
        return 'OK';
      case errInvalidArg:
        return '参数无效';
      case errInitFailed:
        return '初始化失败';
      case errLoadFailed:
        return '加载失败';
      case errDeviceFailed:
        return '设备失败';
      case errModelFailed:
        return '模型失败';
      case errNotReady:
        return '未就绪';
      case errAlreadyExists:
        return '已存在';
      case errPhysics:
        return '物理引擎错误';
      case errState:
        return '状态错误';
      case errUnsupported:
        return '不支持';
      default:
        return '未知错误($code)';
    }
  }
}

/// ABI 版本（C 端 ALIYA_LIVE2D_API_VERSION）。
const int kApiVersion = 9;

// ===================== struct 定义 =====================

/// 模型信息（AliyaLive2DModelInfo）。
final class AliyaModelInfo extends Struct {
  @Int32()
  external int parameterCount;

  @Int32()
  external int drawableCount;

  @Int32()
  external int textureCount;

  @Float()
  external double canvasWidth;

  @Float()
  external double canvasHeight;

  @Int32()
  external int hasPhysics;

  @Int32()
  external int hasEyeBlink;

  @Int32()
  external int hasLipSync;
}

/// 嘴型参数信息（AliyaLive2DMouthParamInfo）。
final class AliyaMouthParamInfo extends Struct {
  @Int32()
  external int hasOpenY;

  @Int32()
  external int hasForm;

  @Float()
  external double openYMin;

  @Float()
  external double openYMax;

  @Float()
  external double formMin;

  @Float()
  external double formMax;
}

/// 互动参数信息（AliyaLive2DInteractionParamInfo）。
final class AliyaInteractionParamInfo extends Struct {
  @Int32()
  external int hasAngleX;

  @Int32()
  external int hasAngleY;

  @Int32()
  external int hasAngleZ;

  @Int32()
  external int hasBodyAngleX;

  @Float()
  external double angleXMin;

  @Float()
  external double angleXMax;

  @Float()
  external double angleYMin;

  @Float()
  external double angleYMax;

  @Float()
  external double angleZMin;

  @Float()
  external double angleZMax;

  @Float()
  external double bodyXMin;

  @Float()
  external double bodyXMax;

  @Int32()
  external int hasEyeL;

  @Int32()
  external int hasEyeR;

  @Float()
  external double eyeLMin;

  @Float()
  external double eyeLMax;

  @Float()
  external double eyeRMin;

  @Float()
  external double eyeRMax;

  @Int32()
  external int hasLeftEarRoot;

  @Int32()
  external int hasRightEarRoot;

  @Float()
  external double leftEarRootMin;

  @Float()
  external double leftEarRootMax;

  @Float()
  external double rightEarRootMin;

  @Float()
  external double rightEarRootMax;

  @Int32()
  external int earRootPhysics;
}

/// 眨眼信息（AliyaLive2DBlinkInfo）。
final class AliyaBlinkInfo extends Struct {
  @Int32()
  external int state;

  @Double()
  external double leftOpenness;

  @Double()
  external double rightOpenness;

  @Double()
  external double nextBlinkDelay;

  @Int32()
  external int enabled;

  @Int32()
  external int forced;
}

/// 动作信息（AliyaLive2DActionInfo）。
final class AliyaActionInfo extends Struct {
  @Int32()
  external int isPlaying;

  @Array(64)
  external Array<Char> currentActionId;

  @Double()
  external double elapsed;

  @Double()
  external double duration;

  @Int32()
  external int priority;
}

/// 物理驱动诊断（AliyaLive2DPhysicsDriveInfo）。
final class AliyaPhysicsDriveInfo extends Struct {
  @Float()
  external double visibleAngleX;

  @Float()
  external double visibleAngleZ;

  @Float()
  external double visibleBodyX;

  @Float()
  external double visibleBodyZ;

  @Float()
  external double physicsAngleX;

  @Float()
  external double physicsAngleZ;

  @Float()
  external double physicsBodyX;

  @Float()
  external double physicsBodyZ;

  @Float()
  external double velocityHeadX;

  @Float()
  external double velocityHeadZ;

  @Int32()
  external int evaluateCount;

  @Float()
  external double outputMaxDelta;

  @Float()
  external double headInputGain;

  @Float()
  external double bodyInputGain;

  @Float()
  external double outputGain;

  @Float()
  external double outputAmplitude;

  @Float()
  external double outputAmplitudeTarget;

  @Float()
  external double outputFinalMaxDelta;

  @Int32()
  external int outputClampHits;

  @Int32()
  external int uniqueOutputCount;

  @Int32()
  external int amplitudeApplyCount;

  @Int32()
  external int physicsFps;
}

/// 视线诊断（AliyaLive2DGazeDiagnostics）。
final class AliyaGazeDiagnostics extends Struct {
  @Float()
  external double headMaxX;

  @Float()
  external double headMaxY;

  @Float()
  external double headMaxZ;

  @Float()
  external double headRangeX;

  @Float()
  external double headRangeY;

  @Float()
  external double headRangeZ;

  @Float()
  external double headFollowAmount;

  @Float()
  external double headFollowAmountTarget;

  @Float()
  external double gazeWeight;

  @Float()
  external double actionGazeMask;

  @Float()
  external double finalGazeMultiplier;

  @Float()
  external double headTargetX;

  @Float()
  external double headTargetY;

  @Float()
  external double headTargetZ;

  @Float()
  external double rawX;

  @Float()
  external double rawY;

  @Float()
  external double mappedX;

  @Float()
  external double mappedY;

  @Float()
  external double beforeGazeX;

  @Float()
  external double afterGazeX;

  @Float()
  external double beforeModelUpdateX;

  @Float()
  external double beforeGazeY;

  @Float()
  external double afterGazeY;

  @Float()
  external double beforeModelUpdateY;
}

// ===================== 值语义数据类（FFI struct 快照，避免 use-after-free） =====================

/// Array\<Char\> → String（截断于 NUL）。
String _charsToString(Array<Char> chars) {
  final buf = StringBuffer();
  for (var i = 0; i < 64; i++) {
    final c = chars[i];
    if (c == 0) break;
    buf.writeCharCode(c);
  }
  return buf.toString();
}

/// 模型信息快照。
final class AliyaModelInfoData {
  AliyaModelInfoData(this.parameterCount, this.drawableCount, this.textureCount,
      this.canvasWidth, this.canvasHeight, this.hasPhysics,
      this.hasEyeBlink, this.hasLipSync);
  final int parameterCount;
  final int drawableCount;
  final int textureCount;
  final double canvasWidth;
  final double canvasHeight;
  final int hasPhysics;
  final int hasEyeBlink;
  final int hasLipSync;
}

/// 眨眼状态快照。
final class AliyaBlinkInfoData {
  AliyaBlinkInfoData(this.state, this.leftOpenness, this.rightOpenness,
      this.nextBlinkDelay, this.enabled, this.forced);
  final int state;
  final double leftOpenness;
  final double rightOpenness;
  final double nextBlinkDelay;
  final int enabled;
  final int forced;
}

/// 动作信息快照。
final class AliyaActionInfoData {
  AliyaActionInfoData(this.isPlaying, this.currentActionId, this.elapsed,
      this.duration, this.priority);
  final int isPlaying;
  final String currentActionId;
  final double elapsed;
  final double duration;
  final int priority;
}

/// 嘴型参数信息快照。
final class AliyaMouthParamInfoData {
  AliyaMouthParamInfoData(this.hasOpenY, this.hasForm, this.openYMin,
      this.openYMax, this.formMin, this.formMax);
  final int hasOpenY;
  final int hasForm;
  final double openYMin;
  final double openYMax;
  final double formMin;
  final double formMax;
}

/// 互动参数信息快照。
final class AliyaInteractionParamInfoData {
  AliyaInteractionParamInfoData(
      this.hasAngleX, this.hasAngleY, this.hasAngleZ, this.hasBodyAngleX,
      this.angleXMin, this.angleXMax, this.angleYMin, this.angleYMax,
      this.angleZMin, this.angleZMax, this.bodyXMin, this.bodyXMax,
      this.hasEyeL, this.hasEyeR, this.eyeLMin, this.eyeLMax,
      this.eyeRMin, this.eyeRMax,
      this.hasLeftEarRoot, this.hasRightEarRoot,
      this.leftEarRootMin, this.leftEarRootMax,
      this.rightEarRootMin, this.rightEarRootMax, this.earRootPhysics);
  final int hasAngleX, hasAngleY, hasAngleZ, hasBodyAngleX;
  final double angleXMin, angleXMax, angleYMin, angleYMax;
  final double angleZMin, angleZMax, bodyXMin, bodyXMax;
  final int hasEyeL, hasEyeR;
  final double eyeLMin, eyeLMax, eyeRMin, eyeRMax;
  final int hasLeftEarRoot, hasRightEarRoot;
  final double leftEarRootMin, leftEarRootMax, rightEarRootMin, rightEarRootMax;
  final int earRootPhysics;
}

/// 物理驱动诊断快照。
final class AliyaPhysicsDriveInfoData {
  AliyaPhysicsDriveInfoData(
      this.visibleAngleX, this.visibleAngleZ, this.visibleBodyX, this.visibleBodyZ,
      this.physicsAngleX, this.physicsAngleZ, this.physicsBodyX, this.physicsBodyZ,
      this.velocityHeadX, this.velocityHeadZ, this.evaluateCount, this.outputMaxDelta,
      this.headInputGain, this.bodyInputGain, this.outputGain, this.outputAmplitude,
      this.outputAmplitudeTarget, this.outputFinalMaxDelta, this.outputClampHits,
      this.uniqueOutputCount, this.amplitudeApplyCount, this.physicsFps);
  final double visibleAngleX, visibleAngleZ, visibleBodyX, visibleBodyZ;
  final double physicsAngleX, physicsAngleZ, physicsBodyX, physicsBodyZ;
  final double velocityHeadX, velocityHeadZ;
  final int evaluateCount;
  final double outputMaxDelta;
  final double headInputGain, bodyInputGain, outputGain, outputAmplitude;
  final double outputAmplitudeTarget, outputFinalMaxDelta;
  final int outputClampHits, uniqueOutputCount, amplitudeApplyCount, physicsFps;
}

/// 视线诊断快照。
final class AliyaGazeDiagnosticsData {
  AliyaGazeDiagnosticsData(
      this.headMaxX, this.headMaxY, this.headMaxZ,
      this.headRangeX, this.headRangeY, this.headRangeZ,
      this.headFollowAmount, this.headFollowAmountTarget,
      this.gazeWeight, this.actionGazeMask, this.finalGazeMultiplier,
      this.headTargetX, this.headTargetY, this.headTargetZ,
      this.rawX, this.rawY, this.mappedX, this.mappedY,
      this.beforeGazeX, this.afterGazeX, this.beforeModelUpdateX,
      this.beforeGazeY, this.afterGazeY, this.beforeModelUpdateY);
  final double headMaxX, headMaxY, headMaxZ;
  final double headRangeX, headRangeY, headRangeZ;
  final double headFollowAmount, headFollowAmountTarget;
  final double gazeWeight, actionGazeMask, finalGazeMultiplier;
  final double headTargetX, headTargetY, headTargetZ;
  final double rawX, rawY, mappedX, mappedY;
  final double beforeGazeX, afterGazeX, beforeModelUpdateX;
  final double beforeGazeY, afterGazeY, beforeModelUpdateY;
}

// ===================== typedef（Native + Dart 成对） =====================

// Create: () -> handle
typedef _NCreate = Pointer<Void> Function();
typedef _DCreate = Pointer<Void> Function();

// Destroy: (handle) -> void
typedef _NDestroy = Void Function(Pointer<Void>);
typedef _DDestroy = void Function(Pointer<Void>);

// GetApiVersion: () -> int
typedef _NGetApiVersion = Int32 Function();
typedef _DGetApiVersion = int Function();

// 简单操作: (handle) -> result
typedef _NResultFn = Int32 Function(Pointer<Void>);
typedef _DResultFn = int Function(Pointer<Void>);

// (handle, int, int) -> result
// 注意：AttachWindow 的 C 签名是 (handle, hwnd, widthPx, heightPx)，hwnd 可为空。
typedef _NResultInt2 = Int32 Function(Pointer<Void>, Int32, Int32);
typedef _DResultInt2 = int Function(Pointer<Void>, int, int);

// (handle, hwnd, int, int) -> result（AttachWindow）
typedef _NAttachWindow = Int32 Function(Pointer<Void>, Pointer<Void>, Int32, Int32);
typedef _DAttachWindow = int Function(Pointer<Void>, Pointer<Void>, int, int);

// (handle, double) -> result
typedef _NResultDouble = Int32 Function(Pointer<Void>, Double);
typedef _DResultDouble = int Function(Pointer<Void>, double);

// (handle, double, double) -> result
typedef _NResultDouble2 = Int32 Function(Pointer<Void>, Double, Double);
typedef _DResultDouble2 = int Function(Pointer<Void>, double, double);

// (handle, double, double, double, double) -> result
typedef _NResultDouble4 = Int32 Function(
    Pointer<Void>, Double, Double, Double, Double);
typedef _DResultDouble4 = int Function(
    Pointer<Void>, double, double, double, double);

// (handle, float) -> result
typedef _NResultFloat = Int32 Function(Pointer<Void>, Float);
typedef _DResultFloat = int Function(Pointer<Void>, double);

// (handle, float, float) -> result
typedef _NResultFloat2 = Int32 Function(Pointer<Void>, Float, Float);
typedef _DResultFloat2 = int Function(Pointer<Void>, double, double);

// (handle, float, float, float) -> result
typedef _NResultFloat3 = Int32 Function(Pointer<Void>, Float, Float, Float);
typedef _DResultFloat3 = int Function(Pointer<Void>, double, double, double);

// (handle, int) -> result
typedef _NResultInt = Int32 Function(Pointer<Void>, Int32);
typedef _DResultInt = int Function(Pointer<Void>, int);

// (handle, int, double, double) -> result
typedef _NResultIntDouble2 = Int32 Function(Pointer<Void>, Int32, Double, Double);
typedef _DResultIntDouble2 = int Function(Pointer<Void>, int, double, double);

// (handle, int, float, float, float, float) -> result
typedef _NResultIntFloat4 =
    Int32 Function(Pointer<Void>, Int32, Float, Float, Float, Float);
typedef _DResultIntFloat4 =
    int Function(Pointer<Void>, int, double, double, double, double);

// (handle, const char*) -> result
typedef _NResultStr = Int32 Function(Pointer<Void>, Pointer<Utf8>);
typedef _DResultStr = int Function(Pointer<Void>, Pointer<Utf8>);

// (handle, const char*, double) -> result
typedef _NResultStrDouble = Int32 Function(Pointer<Void>, Pointer<Utf8>, Double);
typedef _DResultStrDouble = int Function(Pointer<Void>, Pointer<Utf8>, double);

// (handle, float*, float*) -> result
typedef _NResultPtrFloat2 = Int32 Function(Pointer<Void>, Pointer<Float>, Pointer<Float>);
typedef _DResultPtrFloat2 = int Function(Pointer<Void>, Pointer<Float>, Pointer<Float>);

// (handle, float*, float*, float*) -> result
typedef _NResultPtrFloat3 =
    Int32 Function(Pointer<Void>, Pointer<Float>, Pointer<Float>, Pointer<Float>);
typedef _DResultPtrFloat3 =
    int Function(Pointer<Void>, Pointer<Float>, Pointer<Float>, Pointer<Float>);

// (handle, float*) -> result
typedef _NResultPtrFloat = Int32 Function(Pointer<Void>, Pointer<Float>);
typedef _DResultPtrFloat = int Function(Pointer<Void>, Pointer<Float>);

// (handle, 6 x float*) -> result
typedef _NResultPtrFloat6 = Int32 Function(
    Pointer<Void>, Pointer<Float>, Pointer<Float>, Pointer<Float>, Pointer<Float>, Pointer<Float>, Pointer<Float>);
typedef _DResultPtrFloat6 = int Function(
    Pointer<Void>, Pointer<Float>, Pointer<Float>, Pointer<Float>, Pointer<Float>, Pointer<Float>, Pointer<Float>);

// (handle, int*) -> result
typedef _NResultPtrInt = Int32 Function(Pointer<Void>, Pointer<Int32>);
typedef _DResultPtrInt = int Function(Pointer<Void>, Pointer<Int32>);

// (handle, const char*, double*) -> result
typedef _NResultStrPtrDouble = Int32 Function(Pointer<Void>, Pointer<Utf8>, Pointer<Double>);
typedef _DResultStrPtrDouble = int Function(Pointer<Void>, Pointer<Utf8>, Pointer<Double>);

// (handle, char*, int) -> result（字符串缓冲区）
typedef _NResultChars = Int32 Function(Pointer<Void>, Pointer<Utf8>, Int32);
typedef _DResultChars = int Function(Pointer<Void>, Pointer<Utf8>, int);

// AliyaLive2D_GetModelTargetSize：两个 double 输出参数。
typedef _NResultTwoPtrDouble = Int32 Function(
    Pointer<Void>, Pointer<Double>, Pointer<Double>);
typedef _DResultTwoPtrDouble = int Function(
    Pointer<Void>, Pointer<Double>, Pointer<Double>);

// (handle, struct*) -> result
typedef _NResultStruct = Int32 Function(Pointer<Void>, Pointer<Void>);
typedef _DResultStruct = int Function(Pointer<Void>, Pointer<Void>);

// (handle, uchar*, int) -> result（帧像素读回）
typedef _NResultPixels = Int32 Function(Pointer<Void>, Pointer<Uint8>, Int32);
typedef _DResultPixels = int Function(Pointer<Void>, Pointer<Uint8>, int);

// (handle, int, int, int, uchar*) -> result（纹理上传）
typedef _NResultUpload =
    Int32 Function(Pointer<Void>, Int32, Int32, Int32, Pointer<Uint8>);
typedef _DResultUpload =
    int Function(Pointer<Void>, int, int, int, Pointer<Uint8>);

/// AliyaLive2D.Native 动态库绑定。
class AliyaLive2DBindings {
  AliyaLive2DBindings(this._lib);

  factory AliyaLive2DBindings.load() {
    final DynamicLibrary lib;
    if (Platform.isWindows) {
      // 开发期：DLL 与可执行文件同目录；发布期由安装器放置
      lib = DynamicLibrary.open('AliyaLive2D.Native.dll');
    } else if (Platform.isAndroid) {
      lib = DynamicLibrary.open('libAliyaLive2D.Native.so');
    } else {
      throw UnsupportedError('不支持平台: ${Platform.operatingSystem}');
    }
    return AliyaLive2DBindings(lib);
  }

  final DynamicLibrary _lib;

  // ---------- 生命周期 ----------
  late final _DCreate _create =
      _lib.lookupFunction<_NCreate, _DCreate>('AliyaLive2D_Create');
  late final _DDestroy _destroy =
      _lib.lookupFunction<_NDestroy, _DDestroy>('AliyaLive2D_Destroy');
  late final _DGetApiVersion _getApiVersion = _lib
      .lookupFunction<_NGetApiVersion, _DGetApiVersion>('AliyaLive2D_GetApiVersion');

  // ---------- 生命周期操作 ----------
  late final _DResultStr _setAssetDirectory = _lib
      .lookupFunction<_NResultStr, _DResultStr>('AliyaLive2D_SetAssetDirectory');
  late final _DResultStr _loadModel =
      _lib.lookupFunction<_NResultStr, _DResultStr>('AliyaLive2D_LoadModel');
  late final _DAttachWindow _attachWindow =
      _lib.lookupFunction<_NAttachWindow, _DAttachWindow>('AliyaLive2D_AttachWindow');
  late final _DResultInt2 _setViewport =
      _lib.lookupFunction<_NResultInt2, _DResultInt2>('AliyaLive2D_SetViewport');
  late final _DResultDouble _update =
      _lib.lookupFunction<_NResultDouble, _DResultDouble>('AliyaLive2D_Update');
  late final _DResultFn _render =
      _lib.lookupFunction<_NResultFn, _DResultFn>('AliyaLive2D_Render');
  late final _DResultDouble _setScale =
      _lib.lookupFunction<_NResultDouble, _DResultDouble>('AliyaLive2D_SetScale');
  late final _DResultDouble _setOpacity =
      _lib.lookupFunction<_NResultDouble, _DResultDouble>('AliyaLive2D_SetOpacity');
  late final _DResultStrDouble _setState = _lib
      .lookupFunction<_NResultStrDouble, _DResultStrDouble>('AliyaLive2D_SetState');
  late final _DResultStr _playAction =
      _lib.lookupFunction<_NResultStr, _DResultStr>('AliyaLive2D_PlayAction');
  late final _DResultFn _pause =
      _lib.lookupFunction<_NResultFn, _DResultFn>('AliyaLive2D_Pause');
  late final _DResultFn _resume =
      _lib.lookupFunction<_NResultFn, _DResultFn>('AliyaLive2D_Resume');

  // ---------- 视线 / 交互 ----------
  late final _DResultDouble2 _setLookTarget =
      _lib.lookupFunction<_NResultDouble2, _DResultDouble2>('AliyaLive2D_SetLookTarget');
  late final _DResultDouble2 _setGazeRawInput =
      _lib.lookupFunction<_NResultDouble2, _DResultDouble2>('AliyaLive2D_SetGazeRawInput');
  late final _DResultFloat3 _setGazeHeadRange =
      _lib.lookupFunction<_NResultFloat3, _DResultFloat3>('AliyaLive2D_SetGazeHeadRange');
  late final _DResultPtrFloat3 _getGazeHeadRange = _lib
      .lookupFunction<_NResultPtrFloat3, _DResultPtrFloat3>('AliyaLive2D_GetGazeHeadRange');
  late final _DResultFloat _setGazeHeadFollowAmount = _lib
      .lookupFunction<_NResultFloat, _DResultFloat>('AliyaLive2D_SetGazeHeadFollowAmount');
  late final _DResultPtrFloat2 _getGazeHeadFollowAmount = _lib
      .lookupFunction<_NResultPtrFloat2, _DResultPtrFloat2>('AliyaLive2D_GetGazeHeadFollowAmount');
  late final _DResultStruct _getGazeDiagnostics = _lib
      .lookupFunction<_NResultStruct, _DResultStruct>('AliyaLive2D_GetGazeDiagnostics');
  late final _DResultFn _clearLookTarget =
      _lib.lookupFunction<_NResultFn, _DResultFn>('AliyaLive2D_ClearLookTarget');
  late final _DResultInt _setLookAtEnabled =
      _lib.lookupFunction<_NResultInt, _DResultInt>('AliyaLive2D_SetLookAtEnabled');
  late final _DResultDouble _setGazeSpeed =
      _lib.lookupFunction<_NResultDouble, _DResultDouble>('AliyaLive2D_SetGazeSpeed');

  // ---------- 嘴型 / 互动通道 ----------
  late final _DResultDouble _setLipSyncValue =
      _lib.lookupFunction<_NResultDouble, _DResultDouble>('AliyaLive2D_SetLipSyncValue');
  late final _DResultIntDouble2 _setMouthOverride = _lib
      .lookupFunction<_NResultIntDouble2, _DResultIntDouble2>('AliyaLive2D_SetMouthOverride');
  late final _DResultStruct _getMouthParamInfo = _lib
      .lookupFunction<_NResultStruct, _DResultStruct>('AliyaLive2D_GetMouthParamInfo');
  late final _DResultDouble4 _setInteractionOffsets = _lib
      .lookupFunction<_NResultDouble4, _DResultDouble4>('AliyaLive2D_SetInteractionOffsets');
  late final _DResultIntDouble2 _setEyeOverride = _lib
      .lookupFunction<_NResultIntDouble2, _DResultIntDouble2>('AliyaLive2D_SetEyeOverride');
  late final _DResultIntDouble2 _setEarInteraction = _lib
      .lookupFunction<_NResultIntDouble2, _DResultIntDouble2>('AliyaLive2D_SetEarInteraction');
  late final _DResultStruct _getInteractionParamInfo = _lib
      .lookupFunction<_NResultStruct, _DResultStruct>('AliyaLive2D_GetInteractionParamInfo');
  late final _DResultChars _listEarParams =
      _lib.lookupFunction<_NResultChars, _DResultChars>('AliyaLive2D_ListEarParams');
  late final _DResultInt _setPettingLookAtReduction = _lib.lookupFunction<
      _NResultInt, _DResultInt>('AliyaLive2D_SetPettingLookAtReduction');

  // ---------- 物理 ----------
  late final _DResultFloat _setPhysicsStrength = _lib
      .lookupFunction<_NResultFloat, _DResultFloat>('AliyaLive2D_SetPhysicsStrength');
  late final _DResultPtrFloat2 _getPhysicsStrength = _lib
      .lookupFunction<_NResultPtrFloat2, _DResultPtrFloat2>('AliyaLive2D_GetPhysicsStrength');
  late final _DResultFloat _setMouseIdleTimeout = _lib
      .lookupFunction<_NResultFloat, _DResultFloat>('AliyaLive2D_SetMouseIdleTimeout');
  late final _DResultPtrFloat _getMouseIdleTimeout = _lib
      .lookupFunction<_NResultPtrFloat, _DResultPtrFloat>('AliyaLive2D_GetMouseIdleTimeout');
  late final _DResultPtrFloat _getMouseIdleElapsed = _lib
      .lookupFunction<_NResultPtrFloat, _DResultPtrFloat>('AliyaLive2D_GetMouseIdleElapsed');
  late final _DResultPtrInt _getGazeActivityState = _lib
      .lookupFunction<_NResultPtrInt, _DResultPtrInt>('AliyaLive2D_GetGazeActivityState');
  late final _DResultFloat2 _setPhysicsInputGain = _lib
      .lookupFunction<_NResultFloat2, _DResultFloat2>('AliyaLive2D_SetPhysicsInputGain');
  late final _DResultFloat _setPhysicsOutputGain = _lib
      .lookupFunction<_NResultFloat, _DResultFloat>('AliyaLive2D_SetPhysicsOutputGain');
  late final _DResultFloat _setPhysicsOutputAmplitude = _lib
      .lookupFunction<_NResultFloat, _DResultFloat>('AliyaLive2D_SetPhysicsOutputAmplitude');
  late final _DResultPtrFloat2 _getPhysicsOutputAmplitude = _lib
      .lookupFunction<_NResultPtrFloat2, _DResultPtrFloat2>('AliyaLive2D_GetPhysicsOutputAmplitude');
  late final _DResultInt _setPhysicsEnabled =
      _lib.lookupFunction<_NResultInt, _DResultInt>('AliyaLive2D_SetPhysicsEnabled');
  late final _DResultIntFloat4 _setPhysicsTestInput = _lib
      .lookupFunction<_NResultIntFloat4, _DResultIntFloat4>('AliyaLive2D_SetPhysicsTestInput');
  late final _DResultPtrFloat6 _getPhysicsGains = _lib
      .lookupFunction<_NResultPtrFloat6, _DResultPtrFloat6>('AliyaLive2D_GetPhysicsGains');
  late final _DResultStruct _getPhysicsDriveInfo = _lib
      .lookupFunction<_NResultStruct, _DResultStruct>('AliyaLive2D_GetPhysicsDriveInfo');

  // ---------- 参数 / 动作 / 诊断 ----------
  late final _DResultStrPtrDouble _getParameterValue = _lib.lookupFunction<
      _NResultStrPtrDouble, _DResultStrPtrDouble>('AliyaLive2D_GetParameterValue');
  late final _DResultStrDouble _setParameterValue = _lib
      .lookupFunction<_NResultStrDouble, _DResultStrDouble>('AliyaLive2D_SetParameterValue');
  late final _DResultFn _forceBlink =
      _lib.lookupFunction<_NResultFn, _DResultFn>('AliyaLive2D_ForceBlink');
  late final _DResultStruct _getBlinkInfo =
      _lib.lookupFunction<_NResultStruct, _DResultStruct>('AliyaLive2D_GetBlinkInfo');
  late final _DResultChars _listActions =
      _lib.lookupFunction<_NResultChars, _DResultChars>('AliyaLive2D_ListActions');
  late final _DResultStruct _getActionInfo =
      _lib.lookupFunction<_NResultStruct, _DResultStruct>('AliyaLive2D_GetActionInfo');
  late final _DResultChars _pollActionEvents = _lib
      .lookupFunction<_NResultChars, _DResultChars>('AliyaLive2D_PollActionEvents');
  late final _DResultDouble2 _hitTest =
      _lib.lookupFunction<_NResultDouble2, _DResultDouble2>('AliyaLive2D_HitTest');
  late final _DResultStruct _getInfo =
      _lib.lookupFunction<_NResultStruct, _DResultStruct>('AliyaLive2D_GetInfo');
  late final _DResultTwoPtrDouble _getModelTargetSize = _lib
      .lookupFunction<_NResultTwoPtrDouble, _DResultTwoPtrDouble>(
          'AliyaLive2D_GetModelTargetSize');
  late final _DResultPixels _copyFramePixels = _lib
      .lookupFunction<_NResultPixels, _DResultPixels>('AliyaLive2D_CopyFramePixels');
  late final _DResultUpload _uploadTexture = _lib
      .lookupFunction<_NResultUpload, _DResultUpload>('AliyaLive2D_UploadTexture');
  late final _DResultChars _profileStages = _lib
      .lookupFunction<_NResultChars, _DResultChars>('AliyaLive2D_ProfileStages');
  late final _DResultChars _getLastError =
      _lib.lookupFunction<_NResultChars, _DResultChars>('AliyaLive2D_GetLastError');

  // ===================== 高层便捷调用 =====================

  /// 校验 ABI 版本，不一致抛出异常。
  void verifyApiVersion() {
    final int v = _getApiVersion();
    if (v != kApiVersion) {
      throw StateError('AliyaLive2D.Native ABI 版本不匹配：期望 $kApiVersion，实际 $v。'
          '请重新编译 Native 库。');
    }
  }

  Pointer<Void> create() => _create();
  void destroy(Pointer<Void> handle) => _destroy(handle);

  int setAssetDirectory(Pointer<Void> handle, String root) =>
      _withUtf8(root, (p) => _setAssetDirectory(handle, p));
  int loadModel(Pointer<Void> handle, String modelJsonPath) =>
      _withUtf8(modelJsonPath, (p) => _loadModel(handle, p));
  int attachWindow(Pointer<Void> handle, Pointer<Void> hwnd, int widthPx, int heightPx) =>
      _attachWindow(handle, hwnd, widthPx, heightPx);
  int setViewport(Pointer<Void> handle, int widthPx, int heightPx) =>
      _setViewport(handle, widthPx, heightPx);
  int update(Pointer<Void> handle, double deltaSeconds) =>
      _update(handle, deltaSeconds);
  int render(Pointer<Void> handle) => _render(handle);
  int setScale(Pointer<Void> handle, double scale) => _setScale(handle, scale);
  int setOpacity(Pointer<Void> handle, double opacity) =>
      _setOpacity(handle, opacity);
  int setState(Pointer<Void> handle, String state, double intensity) =>
      _withUtf8(state, (p) => _setState(handle, p, intensity));
  int playAction(Pointer<Void> handle, String action) =>
      _withUtf8(action, (p) => _playAction(handle, p));
  int pause(Pointer<Void> handle) => _pause(handle);
  int resume(Pointer<Void> handle) => _resume(handle);

  int setLookTarget(Pointer<Void> handle, double x, double y) =>
      _setLookTarget(handle, x, y);
  int setGazeRawInput(Pointer<Void> handle, double x, double y) =>
      _setGazeRawInput(handle, x, y);
  int clearLookTarget(Pointer<Void> handle) => _clearLookTarget(handle);
  int setLookAtEnabled(Pointer<Void> handle, bool enabled) =>
      _setLookAtEnabled(handle, enabled ? 1 : 0);
  int setGazeSpeed(Pointer<Void> handle, double multiplier) =>
      _setGazeSpeed(handle, multiplier);

  int setLipSyncValue(Pointer<Void> handle, double value) =>
      _setLipSyncValue(handle, value);
  int setMouthOverride(Pointer<Void> handle, bool enabled, double openY, double form) =>
      _setMouthOverride(handle, enabled ? 1 : 0, openY, form);
  int setInteractionOffsets(Pointer<Void> handle, double angleX, double angleY,
          double angleZ, double bodyAngleX) =>
      _setInteractionOffsets(handle, angleX, angleY, angleZ, bodyAngleX);
  int setEyeOverride(Pointer<Void> handle, bool enabled, double leftOpen, double rightOpen) =>
      _setEyeOverride(handle, enabled ? 1 : 0, leftOpen, rightOpen);
  int setEarInteraction(
          Pointer<Void> handle, bool enabled, double leftValue, double rightValue) =>
      _setEarInteraction(handle, enabled ? 1 : 0, leftValue, rightValue);
  int setPettingLookAtReduction(Pointer<Void> handle, bool enabled) =>
      _setPettingLookAtReduction(handle, enabled ? 1 : 0);

  int setPhysicsStrength(Pointer<Void> handle, double strength) =>
      _setPhysicsStrength(handle, strength);
  int setMouseIdleTimeout(Pointer<Void> handle, double seconds) =>
      _setMouseIdleTimeout(handle, seconds);
  int setPhysicsInputGain(Pointer<Void> handle, double headGain, double bodyGain) =>
      _setPhysicsInputGain(handle, headGain, bodyGain);
  int setPhysicsOutputGain(Pointer<Void> handle, double gain) =>
      _setPhysicsOutputGain(handle, gain);
  int setPhysicsOutputAmplitude(Pointer<Void> handle, double amplitude) =>
      _setPhysicsOutputAmplitude(handle, amplitude);
  int setPhysicsEnabled(Pointer<Void> handle, bool enabled) =>
      _setPhysicsEnabled(handle, enabled ? 1 : 0);
  int setPhysicsTestInput(Pointer<Void> handle, bool enabled, double angleX,
          double angleZ, double bodyAngleX, double bodyAngleZ) =>
      _setPhysicsTestInput(handle, enabled ? 1 : 0, angleX, angleZ, bodyAngleX, bodyAngleZ);

  int getParameterValue(Pointer<Void> handle, String id, Pointer<Double> outValue) =>
      _withUtf8(id, (p) => _getParameterValue(handle, p, outValue));
  int setParameterValue(Pointer<Void> handle, String id, double value) =>
      _withUtf8(id, (p) => _setParameterValue(handle, p, value));
  int forceBlink(Pointer<Void> handle) => _forceBlink(handle);

  int hitTest(Pointer<Void> handle, double x, double y) =>
      _hitTest(handle, x, y);

  /// 读取一帧像素到 [dest]（D3D11: BGRA 预乘 alpha；GLES: RGBA。顶行在前）。
  int copyFramePixels(Pointer<Void> handle, Pointer<Uint8> dest, int stride) =>
      _copyFramePixels(handle, dest, stride);

  /// 上传纹理像素（RGBA8，顶行在前）。
  int uploadTexture(
          Pointer<Void> handle, int index, int width, int height, Pointer<Uint8> rgba) =>
      _uploadTexture(handle, index, width, height, rgba);

  // ---------- struct 读取 ----------
  // 注意：getter 返回前必须把字段拷贝到普通对象（Struct 视图指向 calloc 内存，
  // free 后访问是 use-after-free，Android 上会读到垃圾值）。
  AliyaModelInfoData getInfo(Pointer<Void> handle) {
    final info = calloc<AliyaModelInfo>();
    try {
      _check(_getInfo(handle, info.cast()), handle);
      final r = info.ref;
      return AliyaModelInfoData(
        r.parameterCount, r.drawableCount, r.textureCount,
        r.canvasWidth, r.canvasHeight,
        r.hasPhysics, r.hasEyeBlink, r.hasLipSync);
    } finally {
      calloc.free(info);
    }
  }

  /// 获取桌宠在当前 scale 下的目标窗口像素尺寸（含留边 margin）。
  ({double width, double height}) getModelTargetSize(Pointer<Void> handle) {
    final pw = calloc<Double>();
    final ph = calloc<Double>();
    try {
      _check(_getModelTargetSize(handle, pw, ph), handle);
      return (width: pw.value, height: ph.value);
    } finally {
      calloc.free(pw);
      calloc.free(ph);
    }
  }

  AliyaBlinkInfoData getBlinkInfo(Pointer<Void> handle) {
    final info = calloc<AliyaBlinkInfo>();
    try {
      _check(_getBlinkInfo(handle, info.cast()), handle);
      final r = info.ref;
      return AliyaBlinkInfoData(
        r.state, r.leftOpenness, r.rightOpenness,
        r.nextBlinkDelay, r.enabled, r.forced);
    } finally {
      calloc.free(info);
    }
  }

  AliyaActionInfoData getActionInfo(Pointer<Void> handle) {
    final info = calloc<AliyaActionInfo>();
    try {
      _check(_getActionInfo(handle, info.cast()), handle);
      final r = info.ref;
      return AliyaActionInfoData(
        r.isPlaying, _charsToString(r.currentActionId),
        r.elapsed, r.duration, r.priority);
    } finally {
      calloc.free(info);
    }
  }

  AliyaMouthParamInfoData getMouthParamInfo(Pointer<Void> handle) {
    final info = calloc<AliyaMouthParamInfo>();
    try {
      _check(_getMouthParamInfo(handle, info.cast()), handle);
      final r = info.ref;
      return AliyaMouthParamInfoData(
        r.hasOpenY, r.hasForm,
        r.openYMin, r.openYMax, r.formMin, r.formMax);
    } finally {
      calloc.free(info);
    }
  }

  AliyaInteractionParamInfoData getInteractionParamInfo(Pointer<Void> handle) {
    final info = calloc<AliyaInteractionParamInfo>();
    try {
      _check(_getInteractionParamInfo(handle, info.cast()), handle);
      final r = info.ref;
      return AliyaInteractionParamInfoData(
        r.hasAngleX, r.hasAngleY, r.hasAngleZ, r.hasBodyAngleX,
        r.angleXMin, r.angleXMax, r.angleYMin, r.angleYMax,
        r.angleZMin, r.angleZMax, r.bodyXMin, r.bodyXMax,
        r.hasEyeL, r.hasEyeR, r.eyeLMin, r.eyeLMax, r.eyeRMin, r.eyeRMax,
        r.hasLeftEarRoot, r.hasRightEarRoot,
        r.leftEarRootMin, r.leftEarRootMax,
        r.rightEarRootMin, r.rightEarRootMax, r.earRootPhysics);
    } finally {
      calloc.free(info);
    }
  }

  AliyaPhysicsDriveInfoData getPhysicsDriveInfo(Pointer<Void> handle) {
    final info = calloc<AliyaPhysicsDriveInfo>();
    try {
      _check(_getPhysicsDriveInfo(handle, info.cast()), handle);
      final r = info.ref;
      return AliyaPhysicsDriveInfoData(
        r.visibleAngleX, r.visibleAngleZ, r.visibleBodyX, r.visibleBodyZ,
        r.physicsAngleX, r.physicsAngleZ, r.physicsBodyX, r.physicsBodyZ,
        r.velocityHeadX, r.velocityHeadZ, r.evaluateCount, r.outputMaxDelta,
        r.headInputGain, r.bodyInputGain, r.outputGain, r.outputAmplitude,
        r.outputAmplitudeTarget, r.outputFinalMaxDelta, r.outputClampHits,
        r.uniqueOutputCount, r.amplitudeApplyCount, r.physicsFps);
    } finally {
      calloc.free(info);
    }
  }

  AliyaGazeDiagnosticsData getGazeDiagnostics(Pointer<Void> handle) {
    final info = calloc<AliyaGazeDiagnostics>();
    try {
      _check(_getGazeDiagnostics(handle, info.cast()), handle);
      final r = info.ref;
      return AliyaGazeDiagnosticsData(
        r.headMaxX, r.headMaxY, r.headMaxZ,
        r.headRangeX, r.headRangeY, r.headRangeZ,
        r.headFollowAmount, r.headFollowAmountTarget,
        r.gazeWeight, r.actionGazeMask, r.finalGazeMultiplier,
        r.headTargetX, r.headTargetY, r.headTargetZ,
        r.rawX, r.rawY, r.mappedX, r.mappedY,
        r.beforeGazeX, r.afterGazeX, r.beforeModelUpdateX,
        r.beforeGazeY, r.afterGazeY, r.beforeModelUpdateY);
    } finally {
      calloc.free(info);
    }
  }

  /// 读取字符串列表/错误信息（UTF-8 缓冲区）。
  /// [checkResult] 为 false 时不校验返回值（错误查询类：读取失败时返回值是字节数而非错误码）。
  String readString(Pointer<Void> handle,
      int Function(Pointer<Void>, Pointer<Utf8>, int) call,
      {bool checkResult = true}) {
    const int bufSize = 8192;
    final buf = calloc<Uint8>(bufSize);
    try {
      final r = call(handle, buf.cast<Utf8>(), bufSize);
      if (checkResult) _check(r, handle);
      return buf.cast<Utf8>().toDartString();
    } finally {
      calloc.free(buf);
    }
  }

  String listActions(Pointer<Void> handle) => readString(handle, _listActions);
  String listEarParams(Pointer<Void> handle) =>
      readString(handle, _listEarParams);
  String pollActionEvents(Pointer<Void> handle) =>
      readString(handle, _pollActionEvents);
  // 错误查询：不校验返回值（Native 返回字节数；且递归调用 _check 会栈溢出）
  String lastError(Pointer<Void> handle) =>
      readString(handle, _getLastError, checkResult: false);

  void _check(int code, Pointer<Void> handle) {
    if (code != AliyaResult.ok) {
      throw AliyaNativeException(code, lastError(handle));
    }
  }

  static T _withUtf8<T>(String s, T Function(Pointer<Utf8>) fn) {
    final p = s.toNativeUtf8();
    try {
      return fn(p);
    } finally {
      calloc.free(p);
    }
  }
}

/// Native 调用失败异常。
class AliyaNativeException implements Exception {
  AliyaNativeException(this.code, this.message);

  final int code;
  final String message;

  @override
  String toString() =>
      'AliyaLive2D 错误(${AliyaResult.describe(code)}): $message';
}
