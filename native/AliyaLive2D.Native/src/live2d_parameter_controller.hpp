#pragma once

#include <string>
#include <map>
#include <random>
#include <set>
#include <vector>
#include <atomic>

#include "Model/CubismModel.hpp"
#include "live2d_action_player.hpp"

namespace aliya {

// 眨眼状态机（独立可观测）
enum class BlinkState {
    Idle = 0,       // 随机等待
    Closing = 1,    // 闭眼（平滑）
    ClosedHold = 2, // 完全闭合保持
    Opening = 3,    // 睁眼（平滑）
    OpenHold = 4    // 完全睁开保持（至少 200ms）
};

// 眨眼信息快照（供测试与诊断）
struct BlinkInfo {
    int state = 0;               // BlinkState 整数值
    float leftOpenness = 1.0f;   // 0..1
    float rightOpenness = 1.0f;  // 0..1
    float nextBlinkDelay = 2.5f; // 距下次眨眼秒数
    bool enabled = true;
    bool forced = false;         // 是否处于强制眨眼（ForceBlink 后等待执行）
};

// 视线弹簧通道
struct GazeChannel {
    int paramIndex = -1;
    float min = -1.0f, max = 1.0f, def = 0.0f;
    float current = 0.0f;   // 当前参数值
    float velocity = 0.0f;  // 弹簧速度
    bool available = false;
};

// 鼠标活动采样（有效移动判定，像素口径）：
//   单次位移 >= 2px 视为有效移动；
//   100ms 窗口内累计位移 >= 5px 也视为有效移动（容忍低速/抖动）。
// 静止时 idleElapsed 单调递增（不因相同坐标的 SetLookTarget 重置）。
struct CursorActivity {
    bool hasSample = false;      // 是否已收到首个采样
    float lastPxX = 0.0f;        // 上一次采样（物理像素）
    float lastPxY = 0.0f;
    float windowDistPx = 0.0f;   // 100ms 窗口内累计位移（px）
    float windowTime = 0.0f;     // 窗口计时（秒）
    float idleElapsed = 0.0f;    // 静止时长（秒，逐帧 delta 累加）
    int movementSequence = 0;    // 已受理的有效移动序列计数
    float framemovePx = 0.0f;    // 当帧采样位移（px），供 Update 判决
    bool isMoving = false;       // 本帧判定：是否有效移动
    float lastAcceptedX01 = 0.0f; // 最近一次被受理为移动的采样（归一化）
    float lastAcceptedY01 = 0.0f;
};

// 参数分层合成：每个头部/身体参数的最终值由多层叠加。
//   final = defaultValue
//         + idleOffset × idleWeight
//         + gazeOffset × gazeWeight
//         + stateOffset
// 动作层通过 BlendParamValue 在 base 上以 overrideWeight 混合，避免直接覆盖 idle/gaze。
struct ParameterLayers {
    float defaultValue = 0.0f;   // 模型参数默认值
    float idleOffset = 0.0f;     // 待机层偏移
    float gazeOffset = 0.0f;     // 视线层偏移
    float stateOffset = 0.0f;    // 状态层偏移（如 sleep/drag 姿态）
    float idleWeight = 1.0f;     // 待机权重（动作期间可降低但非零）
    float gazeWeight = 0.0f;     // 视线权重（鼠标离开后平滑归零）
};

// 统一参数控制器：眨眼 / 呼吸 / 头部待机 / 身体待机 / 视线 / 口型 / 状态 / Live2D 动作库。
// 每帧参数管线（固定，含参数所有权）：
//   1. 模型默认参数（Cubism 内部）
//   2. Idle 基础微动（多频正弦 + 平滑随机目标）
//   3. Live2D 主动作 Override/Additive/Multiply 层（按通道权重混合）
//   4. 鼠标眼球跟随（弹簧驱动）
//   5. 鼠标头部/身体跟随（弹簧驱动，与 idle 分层合成）
//   6. 自动眨眼（状态机，按模型元数据映射）
//   7. 呼吸（ParamBreath 仅本模块所有，非对称曲线）
//   8. 口型（ParamMouthOpenY 与动作层混合）
//   9. Physics（controller 之后单独 Evaluate）
//   10. 最终 Clamp（所有写入都限制在模型 Min/Max）
//   11. model->Update()
// 参数所有权：眨眼=ParamEyeLOpen/R；视线=ParamEyeBallX/Y；呼吸=ParamBreath；
//             Physics 输出=Param_Angle_Rotation_*（仅 Physics 写）。
class Live2DParameterController {
public:
    Live2DParameterController();
    ~Live2DParameterController();

    // 绑定模型并缓存参数索引与元数据（min/default/max）。返回 false 表示缺少关键参数。
    bool Bind(Live2D::Cubism::Framework::CubismModel* model);

    // 加载 Live2D 动作库（JSON）。返回加载数量。
    int LoadActions(const std::string& utf8Dir);

    // 每帧更新。delta 为秒。
    void Update(Live2D::Cubism::Framework::CubismModel* model, float delta);

    void SetState(const std::string& state, float intensity);
    void PlayAction(const std::string& action);
    void SetLookTarget(float x01, float y01);
    void ClearLookTarget();
    void SetLookAtEnabled(bool enabled);
    // 视口尺寸（物理像素），用于把归一化鼠标坐标换算为像素位移
    void SetViewportPixels(int wPx, int hPx);
    // 视线跟随速度倍率（1.0 = 默认，范围 0.5 ~ 5.0）
    void SetGazeSpeed(float speed);    // 物理效果强度（0.0 = 关闭, 1.0 = 原始, 2.0 = 双倍）
    // 原始视线输入（-1..1，屏幕物理像素归一化，以脸部中心为锚点，由 C# 层计算）。
    // 鼠标右/上为正。该输入经 ShapeGazeAxis 映射后驱动眼睛/头部/身体。
    void SetGazeRawInput(float x, float y);
    // 头部安全比例（X/Y/Z，0.05~1.0）。最终限制 = min(|min|,|max|) × 比例 × 总幅度。
    void SetGazeHeadRange(float x, float y, float z);
    float GazeHeadRangeX() const { return headRangeX_; }
    float GazeHeadRangeY() const { return headRangeY_; }
    float GazeHeadRangeZ() const { return headRangeZ_; }
    // 头部跟随总幅度（0.2~1.0，默认 0.9）。平滑 0.15s 生效。
    void SetGazeHeadFollowAmount(float amount);
    float GazeHeadFollowAmount() const { return headFollowAmountCur_; }
    float GazeHeadFollowAmountTarget() const { return headFollowAmountTgt_; }
    // 实际头部角度限制（含比例与总幅度），模型加载后按真实参数范围计算。
    float HeadMaxX() const { return headMaxX_; }
    float HeadMaxY() const { return headMaxY_; }
    float HeadMaxZ() const { return headMaxZ_; }
    // model->Update() 前由模型层调用：记录物理步进后的头部参数（覆盖检测）。
    void RecordModelUpdateSnapshot(Live2D::Cubism::Framework::CubismModel* model);
    // UI 值 0~2 仅作保存；实际驱动拆分为输入增益(outputGain)与输出倍率(outputGain)，见下方接口。
    void SetPhysicsStrength(float strength);
    // 物理输入增益：驱动 Physics 的虚拟输入 = 可见姿态 × 输入增益。范围 1.0~4.0。
    void SetPhysicsInputGain(float headGain, float bodyGain);
    float HeadInputGainCurrent() const { return physicsInputGainHeadCur_; }
    float BodyInputGainCurrent() const { return physicsInputGainBodyCur_; }
    float HeadInputGainTarget() const { return physicsInputGainHeadTgt_; }
    float BodyInputGainTarget() const { return physicsInputGainBodyTgt_; }
    // 物理输出倍率（0.0~1.4），作用于 Physics 输出参数的增量
    void SetPhysicsOutputGain(float gain);
    float PhysicsOutputGain() const { return physicsOutputGainCur_; }
    float PhysicsOutputGainTarget() const { return physicsOutputGainTgt_; }
    // 物理输出幅度（0.0~2.0，默认 1.0）：与输入增益完全分离的独立输出倍率。
    // 每固定步 finalValue = baseValue + rawDelta × outputGain × amplitude。
    // 100% 快速路径：|amplitude-1| < 1e-4 时 finalValue = Evaluate 输出（不叠加）。
    void SetPhysicsOutputAmplitude(float amplitude);
    float PhysicsOutputAmplitude() const { return physicsOutputAmplitudeCur_; }
    float PhysicsOutputAmplitudeTarget() const { return physicsOutputAmplitudeTgt_; }
    // 增益平滑过渡时间（秒，建议 0.2~0.4）
    void SetPhysicsGainSmoothTime(float seconds);
    // 状态/运动倍率（乘在输入增益上，供模型层使用）
    float HeadInputGainStateMultiplier() const { return headGainStateMul_; }
    float BodyInputGainStateMultiplier() const { return bodyGainStateMul_; }
    // 弹簧速度惯性输入：低通滤波后的头部弹簧速度(°/s) 与 速度增益
    float FilteredHeadVelX() const { return filteredHeadVelX_; }
    float FilteredHeadVelZ() const { return filteredHeadVelZ_; }
    float VelocityGain() const { return velocityGain_; }
    bool VelocityPhysicsEnabled() const { return velocityPhysicsEnabled_; }
    // 设置 velocity 惯性输入增益（0.08~0.20），0 = 关闭
    void SetVelocityGain(float gain);
    void SetVelocityPhysicsEnabled(bool enabled) { velocityPhysicsEnabled_ = enabled; }
    // 鼠标静止进入待机的时间（秒）
    void SetGazeIdleTimeout(float seconds);
    // 物理强度 getter：目标值（用户设置）与当前生效值（逐帧平滑）
    float PhysicsStrength() const { return physicsStrengthCurrent_; }
    float PhysicsStrengthTarget() const { return physicsStrengthTarget_; }
    float PhysicsStrengthCurrent() const { return physicsStrengthCurrent_; }
    // 鼠标空闲超时 getter (秒)
    float MouseIdleTimeout() const { return gazeIdleTimeout_; }
    // 鼠标静止已持续时长（秒）
    float MouseIdleElapsed() const { return cursorActivity_.idleElapsed; }
    // 有效移动序列计数
    int MovementSequence() const { return cursorActivity_.movementSequence; }
    // 视线状态机 getter
    int GetGazeActivityState() const { return static_cast<int>(gazeState_); }
    // 设置鼠标空闲超时 (别名)
    void SetMouseIdleTimeout(float seconds) { SetGazeIdleTimeout(seconds); }
    void SetLipSyncValue(float value);
    void SetPaused(bool paused);
    bool IsPaused() const { return paused_; }
    // 互动眼覆盖激活时暂停自动眨眼（抚摸闭眼用）：UpdateBlink 直接跳过，
    // 卡死检测同步暂停，避免把互动闭眼误判为卡死强行睁开。
    void SetEyeOverrideActive(bool active) { eyeOverrideActive_ = active; }
    bool EyeOverrideActive() const { return eyeOverrideActive_; }
    // 抚摸期间降低 LookAt 对头部/身体角度权重，避免 LookAt 抵消抚摸转动
    void SetPettingLookAtReduction(bool enabled) { pettingLookAtReduction_ = enabled; }
    bool PettingLookAtReduction() const { return pettingLookAtReduction_; }

    // ---- 眨眼控制（诊断 / 测试）----
    void ForceBlink();
    bool IsBlinkEnabled() const { return blinkEnabled_; }
    BlinkInfo GetBlinkInfo() const;

    // ---- 参数读写（诊断 / 测试）----
    bool GetParameterValue(const char* id, float& outValue);
    bool SetParameterValue(const char* id, float value);

    // ---- 追踪上下文（由模型层每帧设置）----
    void SetTraceContext(bool physicsEvaluated, const std::string& hostState);

    // 物理输出参数不允许普通待机覆盖；物理 Evaluate 后本控制器不再次写这些参数。
    void SetPhysicsParams(const std::vector<int>& physicsParamIndices);

    // 动作库 / 播放器访问（供 Host 与测试）
    Live2DActionLibrary& ActionLibrary() { return actionLibrary_; }
    Live2DActionPlayer& ActionPlayer() { return actionPlayer_; }

    // 参数索引访问（供模型层读取能力标记）
    int EyeLOpenIndex() const { return idEyeLOpen_; }
    int EyeROpenIndex() const { return idEyeROpen_; }
    int MouthIndex() const { return idMouthOpenY_; }
    const std::vector<int>& PhysicsOutputIndices() const { return physicsParamIndices_; }

    // ---- 诊断快照（供测试与报告）----
    struct IdleDiagnostics {
        // 呼吸
        float breathPhase = 0.0f;
        float breathValue = 0.0f;
        float breathPeriod = 4.2f;
        float breathMin = 0.0f;
        float breathMax = 0.0f;
        // 头部
        float headIdleX = 0.0f, headIdleY = 0.0f, headIdleZ = 0.0f;
        float headGazeX = 0.0f, headGazeY = 0.0f, headGazeZ = 0.0f;
        float headIdleWeight = 1.0f;
        // 身体
        float bodyIdleX = 0.0f, bodyIdleY = 0.0f, bodyIdleZ = 0.0f;
        float bodyGazeX = 0.0f, bodyGazeY = 0.0f, bodyGazeZ = 0.0f;
        float bodyIdleWeight = 1.0f;
        // 状态
        bool idleEnabled = true;
        bool gazeActive = false;
    };
    IdleDiagnostics GetIdleDiagnostics() const;

    // 视线追踪诊断快照（测试与报告）：限制值 / 权重审计 / 覆盖检测
    struct GazeDiagnostics {
        float headMaxX = 0.0f, headMaxY = 0.0f, headMaxZ = 0.0f;   // 实际限制（含比例×总幅度）
        float headRangeX = 0.93f, headRangeY = 0.83f, headRangeZ = 0.20f;
        float headFollowAmount = 0.9f, headFollowAmountTarget = 0.9f;
        float gazeWeight = 0.0f;          // 头部视线权重（Tracking 稳态 → 1）
        float actionGazeMask = 1.0f;      // 动作遮罩（动作播放时 0.35，正常 1.0）
        float finalGazeMultiplier = 0.0f; // 最终总乘数 = gazeWeight × mask × 通道系数
        float headTargetX = 0.0f, headTargetY = 0.0f, headTargetZ = 0.0f; // 弹簧当前位置
        float rawX = 0.0f, rawY = 0.0f, mappedX = 0.0f, mappedY = 0.0f;
        float beforeGazeX = 0.0f, afterGazeX = 0.0f, beforeModelUpdateX = 0.0f; // 覆盖检测（X）
        float beforeGazeY = 0.0f, afterGazeY = 0.0f, beforeModelUpdateY = 0.0f; // 覆盖检测（Y）
    };
    GazeDiagnostics GetGazeDiagnostics() const;

private:
    int FindIndex(const char* id);
    float GetParam(Live2D::Cubism::Framework::CubismModel* model, int index, float fallback = 0.0f);
    void SetParam(Live2D::Cubism::Framework::CubismModel* model, int index, float value);
    static float Clamp(float v, float lo, float hi);
    static float Lerp(float a, float b, float t);
    static float SmoothStep(float t);
    static float RandRange(std::mt19937& rng, float lo, float hi);
    // 非对称呼吸曲线（吸气42% / 呼气58%），输出 0..1
    static float AsymmetricBreath(float phase01, float minVal, float maxVal);

    // 判断当前是否允许待机动画运行
    bool IsIdleAllowed() const;

    // 按模型真实参数范围重新计算头部角度限制（Bind 与 setter 后调用）
    void RecalcHeadLimits();
    // 中段增强映射：raw ∈ [-1,1] -> mapped ∈ [-1,1]（死区 0.04，指数 0.78）
    static float ShapeGazeAxis(float value);

    // 有效移动判定（像素口径）与静止计时
    void ProcessCursorActivity(float delta);

    // 状态效果（move/drag 倾斜等；sleep 闭眼在 UpdateBlink）
    void ApplyStateEffects(Live2D::Cubism::Framework::CubismModel* model, float delta);
    // Live2D 动作播放器推进（每帧）
    void UpdateAction(Live2D::Cubism::Framework::CubismModel* model, float delta);
    // 通用动作通道应用（手臂/眉毛/眼睛/手/腿等参数，头/身/嘴由 BlendParamValue 处理）
    void ApplyRemainingActionChannels(Live2D::Cubism::Framework::CubismModel* model);
    // 头部 / 身体待机（多频正弦 + 平滑随机目标）
    void UpdateIdleHead(Live2D::Cubism::Framework::CubismModel* model, float delta);
    void UpdateIdleBody(Live2D::Cubism::Framework::CubismModel* model, float delta);
    // 视线（眼珠 + 头部 + 身体，弹簧驱动，与 idle 分层合成后写入参数）
    void UpdateGaze(Live2D::Cubism::Framework::CubismModel* model, float delta);
    // 眨眼（状态机，按模型元数据映射）
    void UpdateBlink(Live2D::Cubism::Framework::CubismModel* model, float delta);
    // 呼吸（非对称曲线，随机周期/幅度）
    void UpdateBreath(Live2D::Cubism::Framework::CubismModel* model, float delta);
    // 口型
    void UpdateLipSync(Live2D::Cubism::Framework::CubismModel* model, float delta);

    // 动作合成：base 与 ActionPlayer 当前动作在该参数上的 Override/Additive/Multiply 混合
    float BlendParamValue(float base, int paramIndex, float pmin, float pmax);

    // 参数默认值（越界防御）
    static float GetParamDefault(Live2D::Cubism::Framework::CubismModel* model, int index, float fallback);
    // 动作结束恢复时跳过的参数（眼睛由眨眼管理）
    bool IsSkipRecoverParam(int idx) const;

    // 眨眼状态机辅助
    void WriteEyes(Live2D::Cubism::Framework::CubismModel* model, float lOpenness, float rOpenness);
    void RecoverBlinkSafe();   // 安全恢复：回到睁开状态
    void EnterBlinkState(BlinkState s, float duration);
    void RollNextBlinkDelay();
    float EyeLValue(float openness) const;
    float EyeRValue(float openness) const;
    // 检测眼睛卡死（低于闭眼阈值 > 1s 且非 Closing/ClosedHold/sleep/click）
    void DetectStuckEyes(Live2D::Cubism::Framework::CubismModel* model, float delta);

    // 诊断追踪（250ms 一次）
    void TraceDiagnostics(Live2D::Cubism::Framework::CubismModel* model, float delta);

    Live2D::Cubism::Framework::CubismModel* model_ = nullptr;

    // 基础参数索引
    int idAngleX_ = -1, idAngleY_ = -1, idAngleZ_ = -1;
    int idBodyAngleX_ = -1, idBodyAngleY_ = -1, idBodyAngleZ_ = -1;
    int idEyeLOpen_ = -1, idEyeROpen_ = -1;
    int idEyeBallX_ = -1, idEyeBallY_ = -1;
    int idMouthOpenY_ = -1;
    int idBreath_ = -1;
    // 手臂互斥组（PartArmA 自然 / PartArmB 举起）：参数索引 + 部件索引（直接控制 PartOpacity）
    int idPartArmA_ = -1;
    int idPartArmB_ = -1;
    int partIndexArmA_ = -1;
    int partIndexArmB_ = -1;

    // 眼睛参数元数据（按模型实际值，不假定 0..1）
    float eyeLOpenMin_ = 0.0f, eyeLOpenDef_ = 1.0f, eyeLOpenMax_ = 1.0f;
    float eyeROpenMin_ = 0.0f, eyeROpenDef_ = 1.0f, eyeROpenMax_ = 1.0f;

    // 状态
    std::string state_ = "idle";
    float stateIntensity_ = 0.0f;
    bool lookAtEnabled_ = true;
    bool lookAtAvailable_ = false; // 模型是否有眼珠参数
    bool sleep_ = false;

    // ---- 视线（九通道）----
    // 通道：眼珠X / 眼珠Y / 头X / 头Y / 头Z / 身X / 身Y / 身Z / 身体倾斜(lean)
    GazeChannel gazeEyeX_, gazeEyeY_, gazeHeadX_, gazeHeadY_, gazeHeadZ_;
    GazeChannel gazeBodyX_, gazeBodyY_, gazeBodyZ_;
    float bodyLean_ = 0.0f;      // 移动/拖动产生的倾斜（独立慢通道，叠加到身Z）
    float gazeTargetX_ = 0.5f, gazeTargetY_ = 0.5f; // 归一化光标目标 0..1（SetLookTarget 兼容）
    float gazeRawX_ = 0.0f, gazeRawY_ = 0.0f;       // 原始视线输入 -1..1（SetGazeRawInput）
    bool gazeRawSet_ = false;
    float gazePrevX_ = 0.5f, gazePrevY_ = 0.5f;     // 上一帧光标（用于速度）
    float gazeCursorVX_ = 0.0f, gazeCursorVY_ = 0.0f;
    bool gazeTargetSet_ = false;
    float gazeSpeed_ = 1.0f;                      // 视线弹簧速度倍率 0.5~5.0
    float headGazeWeight_ = 0.0f;                  // 头部视线权重（鼠标存在时 1，离开时平滑归零）
    float bodyGazeWeight_ = 0.0f;                  // 身体视线权重
    float eyeFollowFactor_ = 1.0f;                 // 眼珠跟随系数（待机/返回时平滑回正）
    int viewportW_ = 320, viewportH_ = 480;        // 视口物理像素（归一化 -> 像素换算）
    CursorActivity cursorActivity_;                // 鼠标活动采样与判定

    // ---- 头部追踪限制（模型真实参数范围 × 安全比例 × 总幅度）----
    float headRangeX_ = 0.93f, headRangeY_ = 0.83f, headRangeZ_ = 0.20f; // X/Y/Z 安全比例
    float headFollowAmountTgt_ = 0.90f, headFollowAmountCur_ = 0.90f;    // 总幅度（0.2~1.0）
    float headMaxX_ = 27.9f, headMaxY_ = 24.9f, headMaxZ_ = 6.0f;        // Bind 时按模型重算
    float mappedX_ = 0.0f, mappedY_ = 0.0f;       // ShapeGazeAxis 映射结果（诊断）
    // 覆盖检测快照（Gaze 写入前后 + model->Update 前）
    float beforeGazeX_ = 0.0f, afterGazeX_ = 0.0f, beforeModelUpdateX_ = 0.0f;
    float beforeGazeY_ = 0.0f, afterGazeY_ = 0.0f, beforeModelUpdateY_ = 0.0f;
    float actionGazeMask_ = 1.0f;                 // 动作遮罩（动作播放时 0.35，正常 1.0）
    float finalGazeMultiplier_ = 0.0f;            // 最终总乘数（权重审计）

    // ---- 眨眼状态机 ----
    std::mt19937 rng_;
    BlinkState blinkState_ = BlinkState::Idle;
    float blinkStateElapsed_ = 0.0f;
    float blinkStateDuration_ = 0.0f;
    float nextBlinkDelay_ = 2.5f;   // 随机间隔，仅在进入 Idle 时重新生成
    float leftWeight_ = 1.0f;
    float rightWeight_ = 1.0f;
    bool blinkEnabled_ = true;
    float stuckClosedTime_ = 0.0f;     // 连续低于闭眼阈值的时间
    std::string lastEyeWriter_ = "none"; // 最近一次写眼睛参数的模块

    // ---- 待机动画（多频正弦 + 平滑随机目标）----
    // 头部待机游走
    float headWanderX_ = 0.0f, headWanderY_ = 0.0f, headWanderZ_ = 0.0f;
    float headTargetX_ = 0.0f, headTargetY_ = 0.0f, headTargetZ_ = 0.0f;
    float headTimer_ = 0.0f;
    // 头部待机子频（增加自然感）
    float headSubPhaseX_ = 0.0f, headSubPhaseY_ = 0.0f, headSubPhaseZ_ = 0.0f;
    float headSubOffsetX_ = 0.0f, headSubOffsetY_ = 0.0f, headSubOffsetZ_ = 0.0f;
    // 身体待机游走
    float bodyWanderX_ = 0.0f, bodyWanderY_ = 0.0f, bodyWanderZ_ = 0.0f;
    float bodyTargetX_ = 0.0f, bodyTargetY_ = 0.0f, bodyTargetZ_ = 0.0f;
    float bodyTimer_ = 0.0f;
    // 身体待机子频
    float bodySubPhaseX_ = 0.0f, bodySubPhaseY_ = 0.0f, bodySubPhaseZ_ = 0.0f;
    float bodySubOffsetX_ = 0.0f, bodySubOffsetY_ = 0.0f, bodySubOffsetZ_ = 0.0f;
    // 待机权重（动作期间适度降低但不归零）
    float idleWeight_ = 1.0f;

    // 口型
    float lipTarget_ = 0.0f;
    float lipCurrent_ = 0.0f;

    // ---- 呼吸（非对称曲线 + 周期/幅度随机）----
    float breathPhase_ = 0.0f;        // 0..2π
    float breathPeriod_ = 4.2f;       // 当前周期（秒）
    float breathMin_ = 0.15f;         // 呼气结束值
    float breathMax_ = 0.85f;         // 吸气峰值
    float breathNextPeriod_ = 4.2f;   // 下一周期（平滑过渡）
    float breathNextMin_ = 0.15f;
    float breathNextMax_ = 0.85f;

    bool paused_ = false;

    // 互动眼覆盖（抚摸闭眼期间为 true，自动眨眼跳过）
    bool eyeOverrideActive_ = false;

    // 抚摸期间 LookAt 头部/身体权重降低（避免抵消抚摸转动）
    bool pettingLookAtReduction_ = false;

    // ---- Live2D 动作库 ----
    Live2DActionLibrary actionLibrary_;
    Live2DActionPlayer actionPlayer_;
    bool actionsLoaded_ = false;

    // 追踪
    bool traceEnabled_ = false;
    float traceTimer_ = 0.0f;
    bool tracePhysics_ = false;
    std::string traceHostState_ = "unknown";

    // 动作通道残留恢复：上次动作写过的参数索引 → 默认值（动作结束后恢复，防止手臂/手/腿残留姿态）
    std::set<int> lastActionParams_;
    std::map<int, float> lastActionDefaults_;


    // 物理输出参数索引（用于强度缩放）
    std::vector<int> physicsParamIndices_;

    // ---- 视线与待机状态机 ----
    enum class GazeActivityState {
        Disabled = 0,
        Tracking = 1,
        ReturningToIdle = 2,
        IdleBreathing = 3,
        Reacquiring = 4
    };
    GazeActivityState gazeState_ = GazeActivityState::IdleBreathing;
    float gazeIdleTimeout_ = 5.0f;       // 鼠标静止进入待机的秒数
    float gazeIdleTimer_ = 0.0f;         // 鼠标静止计时器
    float gazeReacquireTimer_ = 0.0f;    // 重新锁定计时器
    float physicsStrengthTarget_ = 1.0f; // 物理效果强度目标值（用户设置 0.0~2.0，UI 语义）
    float physicsStrengthCurrent_ = 1.0f; // 当前生效值（逐帧向目标平滑）
    // 物理输入/输出增益（虚值与俯仰分离的核心）：
    //   physics 输入 = 可见姿态 × 输入增益(+速度惯性)；输出参数增量 × 输出倍率。
    //   UI 100% 默认：head=2.5 / body=3.0 / output=1.0。head/body 上限 4.0，output 上限 1.4。
    float physicsInputGainHeadTgt_ = 2.5f;
    float physicsInputGainBodyTgt_ = 3.0f;
    float physicsInputGainHeadCur_ = 2.5f;
    float physicsInputGainBodyCur_ = 3.0f;
    float physicsOutputGainTgt_ = 1.0f;
    float physicsOutputGainCur_ = 1.0f;
    // 物理输出幅度（独立于输入增益/输出倍率）：目标值仅由 SetPhysicsOutputAmplitude 修改，
    // 与其它滑块互不覆盖。平滑常数固定 0.20s，误差 <0.0005 吸附。
    float physicsOutputAmplitudeTgt_ = 1.0f;
    float physicsOutputAmplitudeCur_ = 1.0f;
    float physicsGainSmoothTime_ = 0.3f;    // 增益平滑过渡秒数（0.2~0.4）
    float headGainStateMul_ = 1.0f;         // 当前状态下的头部输入增益倍率
    float bodyGainStateMul_ = 1.0f;         // 当前状态下的身体输入增益倍率
    float fastMoveBoost_ = 1.0f;            // 快速鼠标运动的短时增益提升（平滑衰减回 1.0）
    // 速度惯性输入：头部弹簧速度低通滤波 + 死区 + 上限 + 指数衰减
    float filteredHeadVelX_ = 0.0f;
    float filteredHeadVelZ_ = 0.0f;
    float velocityGain_ = 0.12f;            // 速度增益（建议 0.08~0.20）
    bool velocityPhysicsEnabled_ = true;    // ALIYA_LIVE2D_DISABLE_VELOCITY_PHYSICS=1 关闭
    float gazeReturnSpeed_ = 1.5f;       // 回到待机的速度倍率
    float gazeReacquireSpeed_ = 2.0f;    // 重新锁定的速度倍率
};

} // namespace aliya



