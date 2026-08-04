#pragma once

/**
 * Aliya Live2D Native 模块公开 C ABI。
 * 约定：
 *  - 所有跨 DLL 边界 API 均为 C 函数（extern "C"），调用约定 __cdecl。
 *  - 字符串编码：UTF-8（模型路径、状态名、动作名、错误消息）。
 *  - 错误通过返回码报告，详细错误通过 AliyaLive2D_GetLastError 获取。
 *  - 不抛出 C++ 异常跨越 DLL 边界。
 */

#include <stdint.h>
#include <stddef.h>

#if defined(_WIN32)
#  if defined(ALIYA_LIVE2D_NATIVE_EXPORTS)
#    define ALIYA_LIVE2D_API __declspec(dllexport)
#  else
#    define ALIYA_LIVE2D_API __declspec(dllimport)
#  endif
#else
#  define ALIYA_LIVE2D_API
#endif

#ifdef __cplusplus
extern "C" {
#endif

/* 返回码（固定宽度 32 位） */
typedef int32_t AliyaLive2DResult;
enum AliyaLive2DResultValue {
    ALIYA_LIVE2D_OK = 0,
    ALIYA_LIVE2D_ERR_INVALID_ARG = -1,
    ALIYA_LIVE2D_ERR_INIT_FAILED = -2,
    ALIYA_LIVE2D_ERR_LOAD_FAILED = -3,
    ALIYA_LIVE2D_ERR_DEVICE_FAILED = -4,
    ALIYA_LIVE2D_ERR_MODEL_FAILED = -5,
    ALIYA_LIVE2D_ERR_NOT_READY = -6,
    ALIYA_LIVE2D_ERR_ALREADY_EXISTS = -7,
    ALIYA_LIVE2D_ERR_D3D9 = -8,
    ALIYA_LIVE2D_ERR_PHYSICS = -9,
    ALIYA_LIVE2D_ERR_STATE = -10,
    ALIYA_LIVE2D_ERR_UNSUPPORTED = -11
};

/* Native ABI 版本号。托管层校验必须与此一致：
 *   v1  初始 C ABI
 *   v2  增加 physics strength / idle timeout / gaze state
 *   v3  增加 AliyaLive2D_SetGazeIdleTimeout
 *   v4  修正 SetLipSyncValue ABI（extern "C" + C 名导出），增加 UNSUPPORTED 返回码
 *   v5  GetPhysicsStrength 增加 target 输出；增加 GetMouseIdleTimeout/GetMouseIdleElapsed；
 *       physics strength 真正应用到 Physics Evaluate 输出；鼠标静止计时按有效移动判定
 *   v6  Physics 拆分为独立输入驱动：输入增益（可见姿态分离）+ 输出倍率（上限 1.4）；
 *       固定 60Hz 步进；velocity 惯性输入；新增 SetPhysicsEnabled/GetPhysicsDriveInfo
 *   v7  physics3.json 解析唯一输出参数（替代名称前缀猜测）；新增独立输出幅度
 *       Set/GetPhysicsOutputAmplitude（0~2.0）；DriveInfo 扩展幅度/Clamp/应用计数
 *   v8  头部追踪映射修复：raw 输入（-1..1，脸部中心锚点）+ ShapeGazeAxis 中段增强；
 *       按模型真实参数范围 × X/Y/Z 安全比例 × 头部跟随幅度计算头部限制；
 *       新增 SetGazeRawInput / SetGazeHeadRange / SetGazeHeadFollowAmount /
 *       GetGazeDiagnostics（权重审计 + 覆盖检测） */
#ifndef ALIYA_LIVE2D_API_VERSION
#define ALIYA_LIVE2D_API_VERSION 8
#endif

typedef struct AliyaLive2D AliyaLive2D;
typedef AliyaLive2D* AliyaLive2DHandle;

typedef struct AliyaLive2DModelInfo {
    int parameterCount;
    int drawableCount;
    int textureCount;
    float canvasWidth;
    float canvasHeight;
    int hasPhysics;
    int hasEyeBlink;
    int hasLipSync;
} AliyaLive2DModelInfo;

/* 眨眼状态机快照（诊断 / 测试用） */
typedef struct AliyaLive2DBlinkInfo {
    int state;            /* 0=Idle 1=Closing 2=ClosedHold 3=Opening 4=OpenHold */
    double leftOpenness;  /* 0..1 */
    double rightOpenness; /* 0..1 */
    double nextBlinkDelay;/* 距下次眨眼秒数 */
    int enabled;
    int forced;
} AliyaLive2DBlinkInfo;

/* 动作播放状态（诊断 / 测试用） */
typedef struct AliyaLive2DActionInfo {
    int isPlaying;
    char currentActionId[64];
    double elapsed;
    double duration;
    int priority;
} AliyaLive2DActionInfo;

/* Physics 驱动快照（诊断 / 测试用）：
 * 可见姿态（小）与实际 Physics 输入（可见 × 输入增益 + 速度惯性）分离便于验证。 */
typedef struct AliyaLive2DPhysicsDriveInfo {
    float visibleAngleX, visibleAngleZ, visibleBodyX, visibleBodyZ;
    float physicsAngleX, physicsAngleZ, physicsBodyX, physicsBodyZ;
    float velocityHeadX, velocityHeadZ;
    int evaluateCount;
    float outputMaxDelta;
    float headInputGain, bodyInputGain, outputGain;
    float outputAmplitude, outputAmplitudeTarget; /* 输出幅度 current/target */
    float outputFinalMaxDelta;                    /* 幅度应用后最大最终增量 */
    int outputClampHits;            /* 本帧 Clamp 命中次数 */
    int uniqueOutputCount;          /* 唯一输出参数数（physics3.json 解析） */
    int amplitudeApplyCount;        /* 本帧实际应用幅度参数数 */
    int physicsFps;
} AliyaLive2DPhysicsDriveInfo;

/* 视线追踪诊断快照（测试 / 报告用）：
 * 头部限制值（模型真实参数范围 × 安全比例 × 跟随幅度）/
 * 权重审计（GazeWeight / ActionGazeMask / FinalGazeMultiplier）/
 * 覆盖检测（Gaze 写入前后 + model->Update 前头部参数）。 */
typedef struct AliyaLive2DGazeDiagnostics {
    float headMaxX, headMaxY, headMaxZ;       /* 实际头部角度限制（含比例×总幅度） */
    float headRangeX, headRangeY, headRangeZ; /* X/Y/Z 安全比例 */
    float headFollowAmount;                   /* 头部跟随总幅度（当前生效值） */
    float headFollowAmountTarget;             /* 头部跟随总幅度（目标值） */
    float gazeWeight;                         /* 头部视线权重（Tracking 稳态→1） */
    float actionGazeMask;                     /* 动作遮罩（动作播放时 0.35，正常 1.0） */
    float finalGazeMultiplier;                /* 最终总乘数 = gazeWeight × mask × 通道系数 */
    float headTargetX, headTargetY, headTargetZ; /* 头部弹簧当前位置 */
    float rawX, rawY, mappedX, mappedY;       /* raw 输入与 ShapeGazeAxis 映射 */
    float beforeGazeX, afterGazeX, beforeModelUpdateX; /* 覆盖检测 X */
    float beforeGazeY, afterGazeY, beforeModelUpdateY; /* 覆盖检测 Y */
} AliyaLive2DGazeDiagnostics;

/**
 * 创建 Live2D 宿主实例。
 * 返回 NULL 表示失败（请通过 AliyaLive2D_GetLastError(NULL,...) 获取错误）。
 */
ALIYA_LIVE2D_API AliyaLive2DHandle AliyaLive2D_Create(void) noexcept;

/**
 * 设置应用资源根目录（UTF-8）。用于解析 FrameworkShaders 等相对路径。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetAssetDirectory(AliyaLive2DHandle handle, const char* utf8Root) noexcept;

/**
 * 加载模型（model3.json 绝对路径，UTF-8）。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_LoadModel(AliyaLive2DHandle handle, const char* utf8ModelJsonPath) noexcept;

/**
 * 绑定父窗口句柄并设置视口（物理像素尺寸）。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_AttachWindow(AliyaLive2DHandle handle, void* hwnd, int widthPx, int heightPx) noexcept;

/**
 * 设置渲染视口（物理像素尺寸），可随时调整大小。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetViewport(AliyaLive2DHandle handle, int widthPx, int heightPx) noexcept;

/**
 * 更新模型参数（每帧调用）。deltaSeconds 为帧间隔秒。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_Update(AliyaLive2DHandle handle, double deltaSeconds) noexcept;

/**
 * 将模型渲染到共享纹理（D3D11），渲染完成后供 D3DImage 呈现。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_Render(AliyaLive2DHandle handle) noexcept;

/**
 * 设置模型缩放（1.0 = 原始适配比例）。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetScale(AliyaLive2DHandle handle, double scale) noexcept;

/**
 * 设置整体不透明度 0..1（进入/退出动画用）。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetOpacity(AliyaLive2DHandle handle, double opacity) noexcept;

/**
 * 设置状态：idle / move / drag / click / sleep / wake / entrance / exit。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetState(AliyaLive2DHandle handle, const char* state, double intensity) noexcept;

/**
 * 触发参数化动作：hop / sway / shake / stretch / nod / walk / click。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_PlayAction(AliyaLive2DHandle handle, const char* action) noexcept;

/**
 * 设置视线目标（视口相对坐标，0..1；0,0 = 左上）。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetLookTarget(AliyaLive2DHandle handle, double x, double y) noexcept;

/**
 * 设置原始视线输入（-1..1，以脸部中心为锚点，按追踪距离归一化的物理像素偏移）。
 * 鼠标右/上为正。该输入经 ShapeGazeAxis 中段增强后驱动眼睛/头部/身体。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetGazeRawInput(AliyaLive2DHandle handle, double x, double y) noexcept;

/**
 * 设置头部安全比例（X/Y/Z，0.05~1.0，默认 0.93/0.83/0.20）。
 * 实际限制 = min(|参数Min|,|参数Max|) × 比例 × 头部跟随幅度。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetGazeHeadRange(AliyaLive2DHandle handle,
    float rangeX, float rangeY, float rangeZ) noexcept;

/**
 * 读取头部安全比例回读（无 handle 时返回当前配置）。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_GetGazeHeadRange(AliyaLive2DHandle handle,
    float* outRangeX, float* outRangeY, float* outRangeZ) noexcept;

/**
 * 设置头部跟随总幅度（0.2~1.0，默认 0.9；0.9 = 90%）。平滑 0.15s 生效。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetGazeHeadFollowAmount(AliyaLive2DHandle handle, float amount) noexcept;

/**
 * 读取头部跟随总幅度（当前生效值 + 目标值）。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_GetGazeHeadFollowAmount(AliyaLive2DHandle handle,
    float* outCurrent, float* outTarget) noexcept;

/**
 * 读取视线追踪诊断快照（头部限制 / 权重审计 / 覆盖检测）。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_GetGazeDiagnostics(AliyaLive2DHandle handle,
    AliyaLive2DGazeDiagnostics* outInfo) noexcept;

/**
 * 清除视线目标（平滑回正）。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_ClearLookTarget(AliyaLive2DHandle handle) noexcept;

/**
 * 启用/禁用视线跟随（1 = 启用，0 = 禁用）。禁用后眼球参数平滑回 0。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetLookAtEnabled(AliyaLive2DHandle handle, int enabled) noexcept;

/**
 * 设置口型参数（0..1）。
 * value 会被 Clamp 到 [0,1] 并作为平滑目标交给控制器（不会瞬间写入参数）。
 * 若模型未加载/未就绪返回 ERR_NOT_READY；若模型不含 ParamMouthOpenY
 * 返回 ERR_UNSUPPORTED（托管层应据此禁用本次运行的 lip-sync）。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetLipSyncValue(AliyaLive2DHandle handle, double value) noexcept;
/**
 * 设置视线跟随速度倍率（1.0 = 默认，最高 5.0）。作用于视线弹簧响应速度。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetGazeSpeed(AliyaLive2DHandle handle, double multiplier) noexcept;
/**
 * 设置物理效果强度倍率（0.0 = 关闭物理，1.0 = 原始物理，2.0 = 双倍）。
 * 只影响 Physics 输出参数，不影响呼吸、视线、头部转向和身体转向。
 * 范围 0.0 ~ 2.0，超出范围 Clamp。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetPhysicsStrength(AliyaLive2DHandle handle, float strength) noexcept;

/**
 * 获取当前物理效果强度倍率（当前生效值 + 用户设置目标值）。
 * outCurrent：当前实际生效倍率（逐帧向目标平滑）；outTarget：用户设置值。
 * 二者均为 0.0 ~ 2.0。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_GetPhysicsStrength(AliyaLive2DHandle handle, float* outCurrent, float* outTarget) noexcept;

/**
 * 设置鼠标静止进入待机的时间（秒）。
 * 范围 0.1 ~ 30.0，超出范围 Clamp。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetMouseIdleTimeout(AliyaLive2DHandle handle, float seconds) noexcept;

/**
 * 获取鼠标静止进入待机的时间（秒）。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_GetMouseIdleTimeout(AliyaLive2DHandle handle, float* outSeconds) noexcept;

/**
 * 获取鼠标已静止的持续时间（秒，有效移动判定后重新累计）。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_GetMouseIdleElapsed(AliyaLive2DHandle handle, float* outSeconds) noexcept;

/**
 * 获取当前视线活动状态。
 * 返回值：0=Disabled 1=Tracking 2=ReturningToIdle 3=IdleBreathing 4=Reacquiring
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_GetGazeActivityState(AliyaLive2DHandle handle, int* outState) noexcept;

/**
 * 获取 Native ABI 版本号。用于 C# 层版本校验。
 */
ALIYA_LIVE2D_API int AliyaLive2D_GetApiVersion(void) noexcept;
/**
 * 设置物理效果强度倍率（0.0 = 关闭物理，1.0 = 原始物理，2.0 = 双倍）。
 * 只影响 Physics 输出参数，不影响呼吸、视线、头部转向和身体转向。
 * 范围 0.0 ~ 2.0，超出范围 Clamp。
 */
/**
 * 读取模型参数当前值（UTF-8 参数 ID）。返回 0 表示成功，参数不存在返回负值。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_GetParameterValue(AliyaLive2DHandle handle, const char* id, double* outValue) noexcept;

/**
 * 写入模型参数当前值（UTF-8 参数 ID）。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetParameterValue(AliyaLive2DHandle handle, const char* id, double value) noexcept;

/**
 * 强制触发一次眨眼（测试用）。下一帧立即进入 Closing。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_ForceBlink(AliyaLive2DHandle handle) noexcept;

/**
 * 获取眨眼状态机快照（诊断 / 测试用）。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_GetBlinkInfo(AliyaLive2DHandle handle, AliyaLive2DBlinkInfo* outInfo) noexcept;

/**
 * 列出已加载动作（JSON 数组，UTF-8，NUL 结尾）。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_ListActions(AliyaLive2DHandle handle, char* out, int outSize) noexcept;

/**
 * 获取当前动作播放状态。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_GetActionInfo(AliyaLive2DHandle handle, AliyaLive2DActionInfo* outInfo) noexcept;

/**
 * 轮询动作事件（JSON 数组，取走并清空 Native 队列）。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_PollActionEvents(AliyaLive2DHandle handle, char* out, int outSize) noexcept;

/**
 * 命中检测。x/y 为视口内物理像素坐标。
 * 返回值：1 = 命中模型，0 = 未命中，负值 = 错误。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_HitTest(AliyaLive2DHandle handle, double x, double y) noexcept;

/**
 * 暂停更新循环（模型保持，不更新参数）。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_Pause(AliyaLive2DHandle handle) noexcept;

/**
 * 恢复更新循环。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_Resume(AliyaLive2DHandle handle) noexcept;

/**
 * 获取模型信息。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_GetInfo(AliyaLive2DHandle handle, AliyaLive2DModelInfo* outInfo) noexcept;

/**
 * 将渲染帧复制到调用方缓冲区（BGRA，预乘 alpha）。
 * dest 需指向 heightPx * destStride 字节的缓冲区。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_CopyFramePixels(AliyaLive2DHandle handle, unsigned char* dest, int destStride) noexcept;

/**
 * 诊断：分阶段计时（D3D11 Device / SetupShader / GetDeviceInfo / 单 shader 编译与创建）。
 * 结果以 UTF-8 文本写入 out（NUL 结尾）。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_ProfileStages(AliyaLive2DHandle handle, char* out, int outSize) noexcept;

/**
 * 兼容保留：不再使用 D3D9 表面，始终返回 NULL。
 */
ALIYA_LIVE2D_API void* AliyaLive2D_GetBackBufferSurface(AliyaLive2DHandle handle) noexcept;

/**
 * 获取最后错误消息（UTF-8，写入调用方缓冲区）。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_GetLastError(AliyaLive2DHandle handle, char* buffer, int bufferSize) noexcept;

/**
 * 设置物理输入增益（头/身，1.0~4.0）。驱动 Physics 的虚拟输入 = 可见姿态 × 增益。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetPhysicsInputGain(AliyaLive2DHandle handle, float headGain, float bodyGain) noexcept;

/**
 * 设置物理输出倍率（0.0~1.4），作用于 Physics 输出参数增量。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetPhysicsOutputGain(AliyaLive2DHandle handle, float gain) noexcept;

/**
 * 设置物理输出幅度（0.0~2.0，默认 1.0）。与物理输入增益/输出倍率完全分离：
 * 每固定步 finalValue = base + rawDelta × outputGain × amplitude。
 * 100% 快速路径（|amplitude-1|<1e-4）时 finalValue = Evaluate 输出，不叠加。
 * Set 只更新目标值，逐帧按 0.20s 平滑生效。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetPhysicsOutputAmplitude(AliyaLive2DHandle handle, float amplitude) noexcept;

/**
 * 读取物理输出幅度当前生效值与目标值。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_GetPhysicsOutputAmplitude(AliyaLive2DHandle handle,
    float* outCurrent, float* outTarget) noexcept;

/**
 * 设置开关 Physics（诊断 / 测试用）。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetPhysicsEnabled(AliyaLive2DHandle handle, int enabled) noexcept;

/**
 * 设置 Physics 测试输入模式（编辑器等价性测试用）：
 * 启用后每帧强制将 4 个输入参数覆盖为指定角度，使 Physics 输入精确等于固定测试序列。
 * 禁用后恢复正常可见姿态驱动。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetPhysicsTestInput(AliyaLive2DHandle handle, int enabled,
    float angleX, float angleZ, float bodyAngleX, float bodyAngleZ) noexcept;

/**
 * 读取物理输入/输出增益与固定步进快照。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_GetPhysicsGains(AliyaLive2DHandle handle,
    float* outHeadCurrent, float* outHeadTarget, float* outBodyCurrent, float* outBodyTarget,
    float* outOutputCurrent, float* outOutputTarget) noexcept;

/**
 * 读取 Physics 驱动快照（可见姿态 vs 实际输入、Evaluate 次数、输出最大增量）。
 */
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_GetPhysicsDriveInfo(AliyaLive2DHandle handle, AliyaLive2DPhysicsDriveInfo* out) noexcept;

/**
 * 销毁宿主实例。可重复安全调用。
 */
ALIYA_LIVE2D_API void AliyaLive2D_Destroy(AliyaLive2DHandle handle) noexcept;

#ifdef __cplusplus
}
#endif









