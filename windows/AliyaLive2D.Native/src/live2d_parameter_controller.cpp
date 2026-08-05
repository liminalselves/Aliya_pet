#include "live2d_parameter_controller.hpp"

#include <cmath>
#include <algorithm>
#include <cstdlib>

#include "CubismFramework.hpp"
#include "Id/CubismIdManager.hpp"
#include "native_log.hpp"

using namespace Live2D::Cubism::Framework;

namespace aliya {

namespace {
// 闭眼阈值（openness < 此值视为"眼睛处于闭合范围"）
constexpr float kEyeClosedThreshold = 0.05f;
// 卡死判定时长（秒）
constexpr float kEyeStuckSeconds = 1.0f;
// 正常帧间隔上限，超过视为异常（触发安全恢复并截断）
constexpr float kMaxDelta = 0.25f;
// OpenHold 最短保持时长
constexpr float kOpenHoldDuration = 0.25f;

inline bool IsFinite(float v)
{
    return std::isfinite(v);
}

// 弹簧积分：target 由光标距离 + 通道幅度决定。stiffness 越大越快，damping 抑制振荡。
void SpringStep(GazeChannel& ch, float target, float stiffness, float damping, float dt)
{
    if (!ch.available)
        return;
    float d = std::min(dt, 0.05f); // 稳定步长，避免大 dt 发散
    float a = stiffness * (target - ch.current) - damping * ch.velocity;
    if (!IsFinite(a))
        a = 0.0f;
    ch.velocity += a * d;
    ch.current += ch.velocity * d;
    if (!IsFinite(ch.current) || !IsFinite(ch.velocity))
    {
        ch.current = ch.def;
        ch.velocity = 0.0f;
    }
    if (ch.min > ch.max) std::swap(ch.min, ch.max);
    ch.current = std::max(ch.min, std::min(ch.max, ch.current));
}
} // namespace

Live2DParameterController::Live2DParameterController()
{
    std::random_device rd;
    rng_.seed(rd());
    char* traceEnv = nullptr;
    size_t traceEnvLen = 0;
    if (_dupenv_s(&traceEnv, &traceEnvLen, "ALIYA_LIVE2D_TRACE_PARAMETERS") == 0 && traceEnv)
    {
        traceEnabled_ = (traceEnv[0] != 0 && traceEnv[0] != '0');
        free(traceEnv);
    }
    char* velEnv = nullptr;
    size_t velEnvLen = 0;
    if (_dupenv_s(&velEnv, &velEnvLen, "ALIYA_LIVE2D_DISABLE_VELOCITY_PHYSICS") == 0 && velEnv)
    {
        velocityPhysicsEnabled_ = !(velEnv[0] != 0 && velEnv[0] != '0');
        free(velEnv);
    }
}

Live2DParameterController::~Live2DParameterController() = default;

bool Live2DParameterController::Bind(CubismModel* model)
{
    model_ = model;
    if (!model_)
        return false;

    CubismIdManager* idm = CubismFramework::GetIdManager();
    idAngleX_ = model_->GetParameterIndex(idm->GetId("ParamAngleX"));
    idAngleY_ = model_->GetParameterIndex(idm->GetId("ParamAngleY"));
    idAngleZ_ = model_->GetParameterIndex(idm->GetId("ParamAngleZ"));
    idBodyAngleX_ = model_->GetParameterIndex(idm->GetId("ParamBodyAngleX"));
    idBodyAngleY_ = model_->GetParameterIndex(idm->GetId("ParamBodyAngleY"));
    idBodyAngleZ_ = model_->GetParameterIndex(idm->GetId("ParamBodyAngleZ"));
    idEyeLOpen_ = model_->GetParameterIndex(idm->GetId("ParamEyeLOpen"));
    idEyeROpen_ = model_->GetParameterIndex(idm->GetId("ParamEyeROpen"));
    idEyeBallX_ = model_->GetParameterIndex(idm->GetId("ParamEyeBallX"));
    idEyeBallY_ = model_->GetParameterIndex(idm->GetId("ParamEyeBallY"));
    idMouthOpenY_ = model_->GetParameterIndex(idm->GetId("ParamMouthOpenY"));
    idBreath_ = model_->GetParameterIndex(idm->GetId("ParamBreath"));

    // 眼珠参数存在则视线跟随可用
    lookAtAvailable_ = (idEyeBallX_ >= 0 || idEyeBallY_ >= 0);

    // 缓存眼睛参数真实元数据（不假定 0..1）
    auto captureEyeMeta = [&](int idx, float& mn, float& df, float& mx) {
        if (idx >= 0)
        {
            mn = model_->GetParameterMinimumValue(static_cast<csmUint32>(idx));
            df = model_->GetParameterDefaultValue(static_cast<csmUint32>(idx));
            mx = model_->GetParameterMaximumValue(static_cast<csmUint32>(idx));
        }
        else
        {
            mn = 0.0f; df = 1.0f; mx = 1.0f;
        }
    };
    captureEyeMeta(idEyeLOpen_, eyeLOpenMin_, eyeLOpenDef_, eyeLOpenMax_);
    captureEyeMeta(idEyeROpen_, eyeROpenMin_, eyeROpenDef_, eyeROpenMax_);

    // 视线通道元数据 + 初始弹簧参数
    auto bindChannel = [&](GazeChannel& ch, int idx) {
        ch.paramIndex = idx;
        ch.available = idx >= 0;
        if (ch.available)
        {
            ch.min = model_->GetParameterMinimumValue(static_cast<csmUint32>(idx));
            ch.max = model_->GetParameterMaximumValue(static_cast<csmUint32>(idx));
            ch.def = model_->GetParameterDefaultValue(static_cast<csmUint32>(idx));
        }
        else
        {
            ch.min = -1.0f; ch.max = 1.0f; ch.def = 0.0f;
        }
        ch.current = ch.def;
        ch.velocity = 0.0f;
    };
    bindChannel(gazeEyeX_, idEyeBallX_);
    bindChannel(gazeEyeY_, idEyeBallY_);
    bindChannel(gazeHeadX_, idAngleX_);
    bindChannel(gazeHeadY_, idAngleY_);
    bindChannel(gazeHeadZ_, idAngleZ_);
    bindChannel(gazeBodyX_, idBodyAngleX_);
    bindChannel(gazeBodyY_, idBodyAngleY_);
    bindChannel(gazeBodyZ_, idBodyAngleZ_);

    RollNextBlinkDelay();

    // 按模型真实参数范围计算头部角度限制（X/Y/Z 安全比例 × 跟随幅度）
    RecalcHeadLimits();

    // 呼吸初始随机
    breathPeriod_ = 3.8f + static_cast<float>(rng_() % 1700) / 1000.0f;
    breathMin_ = 0.15f;
    breathMax_ = 0.85f;
    breathNextPeriod_ = breathPeriod_;
    breathNextMin_ = breathMin_;
    breathNextMax_ = breathMax_;

    // 待机子频初始相位随机
    headSubPhaseX_ = static_cast<float>(rng_() % 6283) / 1000.0f;
    headSubPhaseY_ = static_cast<float>(rng_() % 6283) / 1000.0f;
    headSubPhaseZ_ = static_cast<float>(rng_() % 6283) / 1000.0f;
    bodySubPhaseX_ = static_cast<float>(rng_() % 6283) / 1000.0f;
    bodySubPhaseY_ = static_cast<float>(rng_() % 6283) / 1000.0f;
    bodySubPhaseZ_ = static_cast<float>(rng_() % 6283) / 1000.0f;

    // 动作播放器绑定模型（用于参数范围归一化）
    actionPlayer_.SetModel(model_);

    NativeLog::Instance().Info(
        "ParameterController: 眼睛参数 L(idx=%d,min=%.3f,def=%.3f,max=%.3f) R(idx=%d,min=%.3f,def=%.3f,max=%.3f) 眼珠可用=%d 通道(头=%d/%d/%d 身=%d/%d/%d) breath idx=%d",
        idEyeLOpen_, eyeLOpenMin_, eyeLOpenDef_, eyeLOpenMax_,
        idEyeROpen_, eyeROpenMin_, eyeROpenDef_, eyeROpenMax_,
        lookAtAvailable_ ? 1 : 0,
        idAngleX_, idAngleY_, idAngleZ_, idBodyAngleX_, idBodyAngleY_, idBodyAngleZ_,
        idBreath_);

    return true;
}

int Live2DParameterController::FindIndex(const char* id)
{
    return model_ ? model_->GetParameterIndex(CubismFramework::GetIdManager()->GetId(id)) : -1;
}

float Live2DParameterController::GetParam(CubismModel* model, int index, float fallback)
{
    if (index < 0)
        return fallback;
    return model->GetParameterValue(index);
}

void Live2DParameterController::SetParam(CubismModel* model, int index, float value)
{
    if (index >= 0)
        model->SetParameterValue(index, value, 1.0f);
}

float Live2DParameterController::Clamp(float v, float lo, float hi)
{
    if (lo > hi)
        std::swap(lo, hi);
    return std::max(lo, std::min(hi, v));
}

float Live2DParameterController::Lerp(float a, float b, float t)
{
    return a + (b - a) * Clamp(t, 0.0f, 1.0f);
}

float Live2DParameterController::SmoothStep(float t)
{
    t = Clamp(t, 0.0f, 1.0f);
    return t * t * (3.0f - 2.0f * t);
}

float Live2DParameterController::RandRange(std::mt19937& rng, float lo, float hi)
{
    if (hi < lo) std::swap(lo, hi);
    std::uniform_real_distribution<float> dist(lo, hi);
    return dist(rng);
}

// 非对称呼吸曲线：phase01 ∈ [0,1)，吸气占 42%，呼气占 58%
// 输出 minVal..maxVal，使用平滑插值避免尖角
float Live2DParameterController::AsymmetricBreath(float phase01, float minVal, float maxVal)
{
    // 吸气：0..0.42，呼气：0.42..1.0
    constexpr float kInhaleEnd = 0.42f;
    float v = 0.0f;
    if (phase01 < kInhaleEnd)
    {
        float t = phase01 / kInhaleEnd;             // 0..1
        float s = SmoothStep(t);                    // 平滑吸气
        v = Lerp(minVal, maxVal, s);
    }
    else
    {
        float t = (phase01 - kInhaleEnd) / (1.0f - kInhaleEnd); // 0..1
        float s = SmoothStep(t);                                // 平滑呼气
        v = Lerp(maxVal, minVal, s);
    }
    return v;
}

bool Live2DParameterController::IsIdleAllowed() const
{
    // 待机动画允许条件：
    // - 不是 exit 状态
    // - 不是 drag/fall 状态
    if (state_ == "exit" || state_ == "entrance")
        return false;
    if (state_ == "drag" || state_ == "fall")
        return false;
    return true;
}

void Live2DParameterController::SetTraceContext(bool physicsEvaluated, const std::string& hostState)
{
    tracePhysics_ = physicsEvaluated;
    traceHostState_ = hostState;
}

int Live2DParameterController::LoadActions(const std::string& utf8Dir)
{
    int n = actionLibrary_.LoadFromDirectory(utf8Dir, model_);
    actionsLoaded_ = true;
    return n;
}

void Live2DParameterController::SetState(const std::string& state, float intensity)
{
    state_ = state;
    stateIntensity_ = intensity;
    if (state == "sleep")
    {
        sleep_ = true;
        breathPeriod_ = 7.0f;
    }
    else
    {
        sleep_ = false;
        breathPeriod_ = 3.8f + static_cast<float>(rng_() % 1700) / 1000.0f;
        breathNextPeriod_ = breathPeriod_;
    }
}

void Live2DParameterController::PlayAction(const std::string& action)
{
    actionPlayer_.Play(action);
}

void Live2DParameterController::SetLookTarget(float x01, float y01)
{
    float cx = Clamp(x01, 0.0f, 1.0f);
    float cy = Clamp(y01, 0.0f, 1.0f);
    gazeTargetX_ = cx;
    gazeTargetY_ = cy;
    gazeTargetSet_ = true;
    // 统一换算为 -1..1 raw 输入（中心 0.5 对应 0）
    gazeRawX_ = (cx - 0.5f) * 2.0f;
    gazeRawY_ = (cy - 0.5f) * 2.0f;
    gazeRawSet_ = true;

    // 像素口径采样：换算为视口物理像素位移（用于静止判定，2px/5px 阈值）
    float px = (gazeRawX_ * 0.5f + 0.5f) * viewportW_;
    float py = (gazeRawY_ * 0.5f + 0.5f) * viewportH_;
    CursorActivity& a = cursorActivity_;
    if (a.hasSample)
    {
        float dxPx = px - a.lastPxX;
        float dyPx = py - a.lastPxY;
        a.framemovePx = std::sqrt(dxPx * dxPx + dyPx * dyPx);
    }
    else
    {
        a.framemovePx = 0.0f;
    }
    a.lastPxX = px;
    a.lastPxY = py;
    a.hasSample = true;
}

// 原始视线输入（-1..1）。像素换算与 SetLookTarget 一致（raw -> 视口中心换算）。
void Live2DParameterController::SetGazeRawInput(float x, float y)
{
    gazeRawX_ = Clamp(x, -1.0f, 1.0f);
    gazeRawY_ = Clamp(y, -1.0f, 1.0f);
    gazeRawSet_ = true;
    gazeTargetSet_ = true;
    // 0..1 兼容口径（速度/诊断用）
    gazeTargetX_ = gazeRawX_ * 0.5f + 0.5f;
    gazeTargetY_ = gazeRawY_ * 0.5f + 0.5f;

    float px = (gazeRawX_ * 0.5f + 0.5f) * viewportW_;
    float py = (gazeRawY_ * 0.5f + 0.5f) * viewportH_;
    CursorActivity& a = cursorActivity_;
    if (a.hasSample)
    {
        float dxPx = px - a.lastPxX;
        float dyPx = py - a.lastPxY;
        a.framemovePx = std::sqrt(dxPx * dxPx + dyPx * dyPx);
    }
    else
    {
        a.framemovePx = 0.0f;
    }
    a.lastPxX = px;
    a.lastPxY = py;
    a.hasSample = true;
}

// 头部安全比例（X/Y/Z，0.05~1.0）。调用后立即重算实际限制。
void Live2DParameterController::SetGazeHeadRange(float x, float y, float z)
{
    if (!IsFinite(x) || !IsFinite(y) || !IsFinite(z)) return;
    headRangeX_ = Clamp(x, 0.05f, 1.0f);
    headRangeY_ = Clamp(y, 0.05f, 1.0f);
    headRangeZ_ = Clamp(z, 0.05f, 1.0f);
    RecalcHeadLimits();
}

// 头部跟随总幅度（0.2~1.0，默认 0.9）。目标值平滑 0.15s 生效。
void Live2DParameterController::SetGazeHeadFollowAmount(float amount)
{
    if (!IsFinite(amount)) return;
    headFollowAmountTgt_ = Clamp(amount, 0.2f, 1.0f);
}

// 按模型真实参数范围重新计算头部限制：
//   headMaxX = min(|minX|, |maxX|) × headRangeX × headFollowAmount
// 模型未加载时回退默认假设（27.9/24.9/6.0）。
void Live2DParameterController::RecalcHeadLimits()
{
    float m = headFollowAmountCur_;
    if (model_ && idAngleX_ >= 0 && idAngleY_ >= 0)
    {
        float mnx = model_->GetParameterMinimumValue(static_cast<csmUint32>(idAngleX_));
        float mxx = model_->GetParameterMaximumValue(static_cast<csmUint32>(idAngleX_));
        float mny = model_->GetParameterMinimumValue(static_cast<csmUint32>(idAngleY_));
        float mxy = model_->GetParameterMaximumValue(static_cast<csmUint32>(idAngleY_));
        float mnz = (idAngleZ_ >= 0) ? model_->GetParameterMinimumValue(static_cast<csmUint32>(idAngleZ_)) : -30.0f;
        float mxz = (idAngleZ_ >= 0) ? model_->GetParameterMaximumValue(static_cast<csmUint32>(idAngleZ_)) : 30.0f;
        headMaxX_ = std::min(std::fabs(mnx), std::fabs(mxx)) * headRangeX_ * m;
        headMaxY_ = std::min(std::fabs(mny), std::fabs(mxy)) * headRangeY_ * m;
        headMaxZ_ = std::min(std::fabs(mnz), std::fabs(mxz)) * headRangeZ_ * m;
    }
    else
    {
        headMaxX_ = 27.9f * headRangeX_ * m;
        headMaxY_ = 24.9f * headRangeY_ * m;
        headMaxZ_ = 6.0f * headRangeZ_ * m;
    }
}

// 中段增强映射（0.78 指数）：死区 0.04 内归零，约一半追踪距离时已到 55%~65% 最大角度。
float Live2DParameterController::ShapeGazeAxis(float value)
{
    float magnitude = std::fabs(value);
    if (magnitude < 0.04f)
        return 0.0f;
    float normalized = Clamp((magnitude - 0.04f) / 0.96f, 0.0f, 1.0f);
    float shaped = std::pow(normalized, 0.78f);
    return std::copysign(shaped, value);
}

// model->Update() 前由模型层调用：记录物理步进后的头部参数（覆盖检测）。
void Live2DParameterController::RecordModelUpdateSnapshot(Live2D::Cubism::Framework::CubismModel* model)
{
    if (!model) return;
    beforeModelUpdateX_ = GetParam(model, idAngleX_, 0.0f);
    beforeModelUpdateY_ = GetParam(model, idAngleY_, 0.0f);
}

Live2DParameterController::GazeDiagnostics Live2DParameterController::GetGazeDiagnostics() const
{
    GazeDiagnostics d;
    d.headMaxX = headMaxX_;
    d.headMaxY = headMaxY_;
    d.headMaxZ = headMaxZ_;
    d.headRangeX = headRangeX_;
    d.headRangeY = headRangeY_;
    d.headRangeZ = headRangeZ_;
    d.headFollowAmount = headFollowAmountCur_;
    d.headFollowAmountTarget = headFollowAmountTgt_;
    d.gazeWeight = headGazeWeight_;
    d.actionGazeMask = actionGazeMask_;
    d.finalGazeMultiplier = finalGazeMultiplier_;
    d.headTargetX = gazeHeadX_.current;
    d.headTargetY = gazeHeadY_.current;
    d.headTargetZ = gazeHeadZ_.current;
    d.rawX = gazeRawX_;
    d.rawY = gazeRawY_;
    d.mappedX = mappedX_;
    d.mappedY = mappedY_;
    d.beforeGazeX = beforeGazeX_;
    d.afterGazeX = afterGazeX_;
    d.beforeModelUpdateX = beforeModelUpdateX_;
    d.beforeGazeY = beforeGazeY_;
    d.afterGazeY = afterGazeY_;
    d.beforeModelUpdateY = beforeModelUpdateY_;
    return d;
}

void Live2DParameterController::SetViewportPixels(int wPx, int hPx)
{
    if (wPx > 0) viewportW_ = wPx;
    if (hPx > 0) viewportH_ = hPx;
}

// 有效移动判定（像素口径）：
//   单次采样位移 >= 2px 记一次移动；否则累计入 100ms 窗口，窗口累计 >= 5px 记一次移动。
//   收到有效移动时清零 idleElapsed（单调计时）；无移动时 idleElapsed += delta。
void Live2DParameterController::ProcessCursorActivity(float delta)
{
    CursorActivity& a = cursorActivity_;
    if (delta <= 0.0f)
        return;

    constexpr float kSingleMovePx = 2.0f;      // 单帧位移阈值
    constexpr float kWindowAccumPx = 5.0f;     // 窗口累计阈值
    constexpr float kWindowSeconds = 0.1f;     // 窗口时长 100ms

    if (!gazeTargetSet_)
    {
        // 无目标（鼠标离开）：不累计窗口，视为无有效活动
        a.windowDistPx = 0.0f;
        a.windowTime = 0.0f;
        a.framemovePx = 0.0f;
        a.isMoving = false;
        a.idleElapsed += delta;
        return;
    }

    bool moving = false;
    if (a.framemovePx >= kSingleMovePx)
    {
        moving = true;
        a.windowDistPx = 0.0f;
        a.windowTime = 0.0f;
    }
    else
    {
        a.windowDistPx += a.framemovePx;
        a.windowTime += delta;
        if (a.windowTime >= kWindowSeconds)
        {
            if (a.windowDistPx >= kWindowAccumPx)
                moving = true;
            else
                a.windowDistPx = 0.0f;
            a.windowTime = 0.0f;
        }
    }

    a.isMoving = moving;
    if (moving)
    {
        a.idleElapsed = 0.0f;
        a.movementSequence++;
        a.lastAcceptedX01 = gazeTargetX_;
        a.lastAcceptedY01 = gazeTargetY_;
    }
    else
    {
        a.idleElapsed += delta;
        // 防止长时间静止 float 模式下窗口残留
        if (a.windowTime >= kWindowSeconds && a.windowDistPx < kWindowAccumPx)
            a.windowDistPx = 0.0f;
    }
    a.framemovePx = 0.0f;
}

void Live2DParameterController::ClearLookTarget()
{
    gazeTargetSet_ = false;
    CursorActivity& a = cursorActivity_;
    a.hasSample = false;
    a.windowDistPx = 0.0f;
    a.windowTime = 0.0f;
    a.framemovePx = 0.0f;
    a.lastPxX = 0.0f;
    a.lastPxY = 0.0f;
}

void Live2DParameterController::SetLookAtEnabled(bool enabled)
{
    lookAtEnabled_ = enabled;
}

void Live2DParameterController::SetGazeSpeed(float speed)
{
    gazeSpeed_ = Clamp(speed, 0.5f, 5.0f);
}

void Live2DParameterController::SetPhysicsStrength(float strength)
{
    if (!IsFinite(strength)) { physicsStrengthTarget_ = 1.0f; physicsStrengthCurrent_ = 1.0f; return; }
    physicsStrengthTarget_ = Clamp(strength, 0.0f, 2.0f);
}

void Live2DParameterController::SetPhysicsInputGain(float headGain, float bodyGain)
{
    if (!IsFinite(headGain) || !IsFinite(bodyGain)) return;
    physicsInputGainHeadTgt_ = Clamp(headGain, 1.0f, 4.0f);
    physicsInputGainBodyTgt_ = Clamp(bodyGain, 1.0f, 4.0f);
}

void Live2DParameterController::SetPhysicsOutputGain(float gain)
{
    if (!IsFinite(gain)) return;
    physicsOutputGainTgt_ = Clamp(gain, 0.0f, 1.4f);
}

void Live2DParameterController::SetPhysicsOutputAmplitude(float amplitude)
{
    if (!IsFinite(amplitude)) return;
    physicsOutputAmplitudeTgt_ = Clamp(amplitude, 0.0f, 2.0f);
}

void Live2DParameterController::SetPhysicsGainSmoothTime(float seconds)
{
    if (!IsFinite(seconds)) return;
    physicsGainSmoothTime_ = Clamp(seconds, 0.05f, 2.0f);
}

void Live2DParameterController::SetVelocityGain(float gain)
{
    if (!IsFinite(gain)) return;
    velocityGain_ = Clamp(gain, 0.0f, 0.5f);
}







void Live2DParameterController::SetGazeIdleTimeout(float seconds)
{
    gazeIdleTimeout_ = Clamp(seconds, 0.1f, 30.0f);
}

void Live2DParameterController::SetLipSyncValue(float value)
{
    lipTarget_ = Clamp(value, 0.0f, 1.0f);
}

void Live2DParameterController::SetPaused(bool paused)
{
    paused_ = paused;
}

void Live2DParameterController::SetPhysicsParams(const std::vector<int>& physicsParamIndices)
{
    physicsParamIndices_ = physicsParamIndices;
}

void Live2DParameterController::ForceBlink()
{
    if (blinkState_ == BlinkState::Idle)
    {
        EnterBlinkState(BlinkState::Closing, 0.090f);
    }
}

BlinkInfo Live2DParameterController::GetBlinkInfo() const
{
    BlinkInfo info;
    info.state = static_cast<int>(blinkState_);
    info.leftOpenness = EyeLValue(leftWeight_);
    info.rightOpenness = EyeRValue(rightWeight_);
    info.nextBlinkDelay = nextBlinkDelay_;
    info.enabled = blinkEnabled_;
    info.forced = (nextBlinkDelay_ <= 0.0f && blinkState_ == BlinkState::Idle);
    return info;
}

bool Live2DParameterController::GetParameterValue(const char* id, float& outValue)
{
    if (!model_) return false;
    int idx = FindIndex(id);
    if (idx < 0) return false;
    outValue = model_->GetParameterValue(static_cast<csmUint32>(idx));
    return true;
}

bool Live2DParameterController::SetParameterValue(const char* id, float value)
{
    if (!model_) return false;
    int idx = FindIndex(id);
    if (idx < 0) return false;
    model_->SetParameterValue(static_cast<csmUint32>(idx), value, 1.0f);
    return true;
}

Live2DParameterController::IdleDiagnostics Live2DParameterController::GetIdleDiagnostics() const
{
    IdleDiagnostics d;
    d.breathPhase = breathPhase_;
    d.breathValue = Clamp(AsymmetricBreath(breathPhase_ / 6.2831853f, breathMin_, breathMax_), 0.0f, 1.0f);
    d.breathPeriod = breathPeriod_;
    d.breathMin = breathMin_;
    d.breathMax = breathMax_;
    d.headIdleX = headWanderX_;
    d.headIdleY = headWanderY_;
    d.headIdleZ = headWanderZ_;
    d.headGazeX = gazeHeadX_.current;
    d.headGazeY = gazeHeadY_.current;
    d.headGazeZ = gazeHeadZ_.current;
    d.headIdleWeight = idleWeight_;
    d.bodyIdleX = bodyWanderX_;
    d.bodyIdleY = bodyWanderY_;
    d.bodyIdleZ = bodyWanderZ_;
    d.bodyGazeX = gazeBodyX_.current;
    d.bodyGazeY = gazeBodyY_.current;
    d.bodyGazeZ = gazeBodyZ_.current;
    d.bodyIdleWeight = idleWeight_;
    d.idleEnabled = IsIdleAllowed();
    d.gazeActive = gazeTargetSet_ && (headGazeWeight_ > 0.01f || bodyGazeWeight_ > 0.01f);
    return d;
}

void Live2DParameterController::Update(CubismModel* model, float delta)
{
    if (!model)
        return;
    if (paused_)
        return;
    if (!IsFinite(delta) || delta <= 0.0f)
        delta = 0.0001f;

    if (delta > kMaxDelta)
    {
        NativeLog::Instance().Warn("Update: 异常 delta=%.4f，截断并安全恢复眨眼", delta);
        RecoverBlinkSafe();
        delta = kMaxDelta;
    }

    // 计算当前帧 idle 权重（动作期间降低但不归零）
    UpdateAction(model, delta);
    bool actionPlaying = actionPlayer_.IsPlaying();
    // 基础待机权重：动作运行时不低于 0.35，允许待机动画继续轻微作用
    idleWeight_ = actionPlaying ? 0.35f : 1.0f;
    // 动作遮罩：动作播放时视线权重目标降至 0.35（平滑过渡），正常 Tracking 为 1.0
    actionGazeMask_ = actionPlaying ? 0.35f : 1.0f;

    // 物理强度/输入增益/输出倍率目标平滑（约 physicsGainSmoothTime_ 内到达目标，防止突变）
    {
        float k = 1.0f - std::exp(-delta / std::max(0.01f, physicsGainSmoothTime_));
        auto smooth = [&](float& cur, float tgt) {
            if (std::fabs(cur - tgt) < 0.001f) cur = tgt;
            else cur += (tgt - cur) * k;
        };
        smooth(physicsStrengthCurrent_, physicsStrengthTarget_);
        smooth(physicsInputGainHeadCur_, physicsInputGainHeadTgt_);
        smooth(physicsInputGainBodyCur_, physicsInputGainBodyTgt_);
        smooth(physicsOutputGainCur_, physicsOutputGainTgt_);
        // 物理输出幅度独立平滑：固定时间常数 0.20s，误差 <0.0005 吸附（spec 硬性要求）。
        {
            float ka = 1.0f - std::exp(-delta / 0.20f);
            float& cur = physicsOutputAmplitudeCur_;
            float tgt = physicsOutputAmplitudeTgt_;
            if (std::fabs(cur - tgt) < 0.0005f) cur = tgt;
            else cur += (tgt - cur) * ka;
        }
        // 头部跟随幅度平滑：0.15s，误差 <0.0005 吸附；变化后重算实际角度限制
        {
            float ka = 1.0f - std::exp(-delta / 0.15f);
            float& cur = headFollowAmountCur_;
            float tgt = headFollowAmountTgt_;
            if (std::fabs(cur - tgt) < 0.0005f) cur = tgt;
            else cur += (tgt - cur) * ka;
            RecalcHeadLimits();
        }
    }

    // 鼠标有效移动判定 + 静止计时（先于状态机，供 UpdateGaze 使用）
    ProcessCursorActivity(delta);

    ApplyStateEffects(model, delta);

    if (IsIdleAllowed())
    {
        UpdateIdleHead(model, delta);
        UpdateIdleBody(model, delta);
    }
    else
    {
        // 不允许待机时，缓慢归零 wander（避免突变）
        headWanderX_ = Lerp(headWanderX_, 0.0f, std::min(1.0f, delta * 2.0f));
        headWanderY_ = Lerp(headWanderY_, 0.0f, std::min(1.0f, delta * 2.0f));
        headWanderZ_ = Lerp(headWanderZ_, 0.0f, std::min(1.0f, delta * 2.0f));
        bodyWanderX_ = Lerp(bodyWanderX_, 0.0f, std::min(1.0f, delta * 2.0f));
        bodyWanderY_ = Lerp(bodyWanderY_, 0.0f, std::min(1.0f, delta * 2.0f));
        bodyWanderZ_ = Lerp(bodyWanderZ_, 0.0f, std::min(1.0f, delta * 2.0f));
    }

    UpdateGaze(model, delta);
    UpdateBlink(model, delta);
    UpdateBreath(model, delta);
    UpdateLipSync(model, delta);

    TraceDiagnostics(model, delta);
}

void Live2DParameterController::ApplyStateEffects(CubismModel* model, float delta)
{
    // move / drag：根据强度（横向速度，px/s）平滑倾斜身体（独立慢通道）
    if (state_ == "move" || state_ == "drag")
    {
        float target = Clamp(stateIntensity_ * 0.004f, -3.0f, 3.0f);
        bodyLean_ = Lerp(bodyLean_, target, std::min(1.0f, delta * 4.0f));
    }
    else
    {
        bodyLean_ = Lerp(bodyLean_, 0.0f, std::min(1.0f, delta * 2.5f));
    }
    (void)model;
}

// ---- 头部待机：多频正弦 + 平滑随机目标 ----
// 注意：正弦子频必须作为瞬时偏移量，不能累加到 lerp 状态上（否则会被 lerp 增益放大）
void Live2DParameterController::UpdateIdleHead(CubismModel* model, float delta)
{
    (void)model;

    // 主目标游走（3.5~8s 切换）
    headTimer_ -= delta;
    if (headTimer_ <= 0.0f)
    {
        headTimer_ = 3.5f + static_cast<float>(rng_() % 4500) / 1000.0f;
        headTargetX_ = RandRange(rng_, -1.5f, 1.5f);
        headTargetY_ = RandRange(rng_, -0.8f, 0.8f);
        headTargetZ_ = RandRange(rng_, -0.6f, 0.6f);
    }
    float k = std::min(1.0f, delta * 0.8f);
    headWanderX_ = Lerp(headWanderX_, headTargetX_, k);
    headWanderY_ = Lerp(headWanderY_, headTargetY_, k);
    headWanderZ_ = Lerp(headWanderZ_, headTargetZ_, k);

    // 子频正弦：独立相位，瞬时计算偏移，不累加到 wander
    constexpr float kSubSpeedX = 6.2831853f / 3.1f;
    constexpr float kSubSpeedY = 6.2831853f / 3.7f;
    constexpr float kSubSpeedZ = 6.2831853f / 4.3f;
    headSubPhaseX_ += delta * kSubSpeedX;
    headSubPhaseY_ += delta * kSubSpeedY;
    headSubPhaseZ_ += delta * kSubSpeedZ;
    if (headSubPhaseX_ > 6.2831853f) headSubPhaseX_ -= 6.2831853f;
    if (headSubPhaseY_ > 6.2831853f) headSubPhaseY_ -= 6.2831853f;
    if (headSubPhaseZ_ > 6.2831853f) headSubPhaseZ_ -= 6.2831853f;

    // 子频作为瞬时偏移加到最终输出，不累积到 wander 累加器
    headSubOffsetX_ = std::sin(headSubPhaseX_) * 0.25f;
    headSubOffsetY_ = std::sin(headSubPhaseY_) * 0.15f;
    headSubOffsetZ_ = std::sin(headSubPhaseZ_) * 0.12f;
}

// ---- 身体待机：更慢、更小的多频游走 ----
void Live2DParameterController::UpdateIdleBody(CubismModel* model, float delta)
{
    (void)model;

    // 主目标游走（5~10s 切换，比头部更慢）
    bodyTimer_ -= delta;
    if (bodyTimer_ <= 0.0f)
    {
        bodyTimer_ = 5.0f + static_cast<float>(rng_() % 5000) / 1000.0f;
        bodyTargetX_ = RandRange(rng_, -0.55f, 0.55f);
        bodyTargetY_ = RandRange(rng_, -0.35f, 0.35f);
        bodyTargetZ_ = RandRange(rng_, -0.40f, 0.40f);
    }
    float k = std::min(1.0f, delta * 0.5f);
    bodyWanderX_ = Lerp(bodyWanderX_, bodyTargetX_, k);
    bodyWanderY_ = Lerp(bodyWanderY_, bodyTargetY_, k);
    bodyWanderZ_ = Lerp(bodyWanderZ_, bodyTargetZ_, k);

    // 子频正弦：瞬时偏移，不累加
    constexpr float kSubSpeedX = 6.2831853f / 6.5f;
    constexpr float kSubSpeedY = 6.2831853f / 7.8f;
    constexpr float kSubSpeedZ = 6.2831853f / 8.5f;
    bodySubPhaseX_ += delta * kSubSpeedX;
    bodySubPhaseY_ += delta * kSubSpeedY;
    bodySubPhaseZ_ += delta * kSubSpeedZ;
    if (bodySubPhaseX_ > 6.2831853f) bodySubPhaseX_ -= 6.2831853f;
    if (bodySubPhaseY_ > 6.2831853f) bodySubPhaseY_ -= 6.2831853f;
    if (bodySubPhaseZ_ > 6.2831853f) bodySubPhaseZ_ -= 6.2831853f;

    bodySubOffsetX_ = std::sin(bodySubPhaseX_) * 0.12f;
    bodySubOffsetY_ = std::sin(bodySubPhaseY_) * 0.08f;
    bodySubOffsetZ_ = std::sin(bodySubPhaseZ_) * 0.08f;
}

void Live2DParameterController::UpdateAction(CubismModel* model, float delta)
{
    (void)model;
    actionPlayer_.Update(delta);
}

float Live2DParameterController::BlendParamValue(float base, int paramIndex, float pmin, float pmax)
{
    ActionChannelOutput out;
    if (!actionPlayer_.GetChannelOutput(paramIndex, out))
        return Clamp(base, pmin, pmax);
    float v = base;
    if (out.hasOverride)
        v = Lerp(v, out.overrideValue, out.overrideWeight);
    if (out.hasMultiply)
        v = v * (1.0f + (out.multiplyValue - 1.0f) * out.multiplyWeight);
    if (out.hasAdditive)
        v = v + out.additiveValue * out.additiveWeight;
    return Clamp(v, pmin, pmax);
}

// ---- 视线：弹簧驱动 + 与 idle 分层合成 ----
void Live2DParameterController::UpdateGaze(CubismModel* model, float delta)
{
    bool pausedByState = sleep_ || state_ == "exit" || state_ == "entrance";
    bool gazeEnabled = lookAtEnabled_ && !pausedByState;

    // ---- 鼠标活动检测与状态机 ----
    bool mouseMoving = cursorActivity_.isMoving;

    // 状态机更新
    if (!lookAtEnabled_ || pausedByState)
        gazeState_ = GazeActivityState::Disabled;
    else if (gazeState_ == GazeActivityState::Disabled)
        gazeState_ = GazeActivityState::IdleBreathing;
    else if (gazeState_ == GazeActivityState::IdleBreathing)
    { if (mouseMoving) { gazeState_ = GazeActivityState::Reacquiring; gazeReacquireTimer_ = 0.0f; } }
    else if (gazeState_ == GazeActivityState::Reacquiring)
    {
        gazeReacquireTimer_ += delta;
        if (headGazeWeight_ > 0.95f && bodyGazeWeight_ > 0.95f) gazeState_ = GazeActivityState::Tracking;
        else if (!mouseMoving && gazeReacquireTimer_ > 1.0f) gazeState_ = GazeActivityState::ReturningToIdle;
    }
    else if (gazeState_ == GazeActivityState::Tracking)
    {
        if (mouseMoving) gazeIdleTimer_ = 0.0f;
        else { gazeIdleTimer_ += delta; if (gazeIdleTimer_ >= gazeIdleTimeout_) gazeState_ = GazeActivityState::ReturningToIdle; }
    }
    else if (gazeState_ == GazeActivityState::ReturningToIdle)
    {
        if (mouseMoving) { gazeState_ = GazeActivityState::Reacquiring; gazeReacquireTimer_ = 0.0f; }
        else if (headGazeWeight_ < 0.05f && bodyGazeWeight_ < 0.05f) { gazeState_ = GazeActivityState::IdleBreathing; gazeIdleTimer_ = 0.0f; }
    }

    // 光标速度（惯性估计，诊断用）
    float prevTx = gazePrevX_, prevTy = gazePrevY_;
    gazePrevX_ = gazeTargetX_;
    gazePrevY_ = gazeTargetY_;
    if (gazeTargetSet_ && !pausedByState)
    {
        gazeCursorVX_ = Lerp(gazeCursorVX_, (gazeTargetX_ - prevTx) / std::max(delta, 1e-4f), std::min(1.0f, delta * 8.0f));
        gazeCursorVY_ = Lerp(gazeCursorVY_, (gazeTargetY_ - prevTy) / std::max(delta, 1e-4f), std::min(1.0f, delta * 8.0f));
    }
    else
    {
        gazeCursorVX_ = Lerp(gazeCursorVX_, 0.0f, std::min(1.0f, delta * 8.0f));
        gazeCursorVY_ = Lerp(gazeCursorVY_, 0.0f, std::min(1.0f, delta * 8.0f));
    }

    // ---- 状态输入增益倍率（乘在 UI 输入增益上）----
    switch (gazeState_)
    {
    case GazeActivityState::IdleBreathing:
        headGainStateMul_ = 0.85f; bodyGainStateMul_ = 1.0f; break;
    case GazeActivityState::Reacquiring:
        headGainStateMul_ = 1.15f; bodyGainStateMul_ = 1.1f; break;
    case GazeActivityState::Tracking:
    case GazeActivityState::ReturningToIdle:
        headGainStateMul_ = 1.0f; bodyGainStateMul_ = 1.0f; break;
    default:
        headGainStateMul_ = 1.0f; bodyGainStateMul_ = 1.0f; break;
    }
    // 快速鼠标运动短时提升（1.2~1.35），平滑衰减；不使用原始鼠标速度
    {
        float boostTarget = mouseMoving ? 1.3f : 1.0f;
        float boostK = mouseMoving ? std::min(1.0f, delta * 3.0f) : std::min(1.0f, delta * 1.5f);
        fastMoveBoost_ = Lerp(fastMoveBoost_, boostTarget, boostK);
        headGainStateMul_ *= fastMoveBoost_;
        bodyGainStateMul_ *= 1.0f + (fastMoveBoost_ - 1.0f) * 0.5f;
    }

    // ---- 头部弹簧速度惯性输入（低通滤波 + 死区 + 上限 + 指数衰减）----
    // 使用头部弹簧当前速度（°/s），与原始 Cursor delta 无关；
    // 死区 0.05°/s，上限 30°/s，滤波系数约 10Hz，停止后指数衰减到 0。
    {
        constexpr float kVeloDeadzone = 0.05f;
        constexpr float kVeloMax = 30.0f;
        float rawVX = gazeHeadX_.available ? gazeHeadX_.velocity : 0.0f;
        float rawVZ = gazeHeadZ_.available ? gazeHeadZ_.velocity : 0.0f;
        auto filter = [&](float& out, float raw) {
            float a = std::fabs(raw);
            float v = (a > kVeloDeadzone) ? raw : 0.0f;
            v = std::max(-kVeloMax, std::min(kVeloMax, v));
            float fk = std::min(1.0f, delta * 10.0f); // 低通 ~10Hz
            if (!gazeTargetSet_)
                v = 0.0f; // 无目标时指数衰减到 0
            out = Lerp(out, v, fk);
            if (std::fabs(out) < kVeloDeadzone)
                out = 0.0f;
        };
        filter(filteredHeadVelX_, rawVX);
        filter(filteredHeadVelZ_, rawVZ);
    }

    // ---- 覆盖检测：Gaze 写入前快照 ----
    beforeGazeX_ = GetParam(model, idAngleX_, 0.0f);
    beforeGazeY_ = GetParam(model, idAngleY_, 0.0f);

    // 归一化光标偏移 -1..1（raw 输入：以脸部中心为锚点，reach 距离归一化）
    float rawX = gazeRawSet_ ? gazeRawX_ : 0.0f;
    float rawY = gazeRawSet_ ? gazeRawY_ : 0.0f;
    float radius = std::sqrt(rawX * rawX + rawY * rawY);

    // 中段增强映射：raw -> mapped（死区 0.04，0.78 指数）
    mappedX_ = ShapeGazeAxis(rawX);
    mappedY_ = ShapeGazeAxis(rawY);

    // ---- 基于状态机的权重计算 ----
    float targetHeadWeight = 0.0f, targetBodyWeight = 0.0f;
    float weightLerp = std::min(1.0f, delta * 3.0f);
    if (gazeState_ == GazeActivityState::Tracking)
    {
        // 正常 Tracking：头部权重目标 1.0（× 动作遮罩），总乘数接近 1
        targetHeadWeight = (radius > 0.02f) ? 1.0f * actionGazeMask_ : 0.0f;
        targetBodyWeight = (radius > 0.08f) ? 1.0f * actionGazeMask_ : 0.0f;
    }
    else if (gazeState_ == GazeActivityState::Reacquiring)
    {
        weightLerp = std::min(1.0f, delta * gazeReacquireSpeed_ * 3.0f);
        targetHeadWeight = (radius > 0.02f) ? 1.0f * actionGazeMask_ : 0.0f;
        targetBodyWeight = (radius > 0.08f) ? 1.0f * actionGazeMask_ : 0.0f;
    }
    else if (gazeState_ == GazeActivityState::ReturningToIdle)
    {
        weightLerp = std::min(1.0f, delta * gazeReturnSpeed_ * 2.0f);
        targetHeadWeight = 0.0f;
        targetBodyWeight = 0.0f;
    }
    // 抚摸期间降低 LookAt 权重（避免抵消抚摸头部转动；闭眼时眼珠权重无需保留）
    if (pettingLookAtReduction_)
    {
        targetHeadWeight *= 0.25f;   // HeadLookAtWeight ≈ 0.25
        targetBodyWeight *= 0.50f;
    }
    headGazeWeight_ = Lerp(headGazeWeight_, targetHeadWeight, weightLerp);
    bodyGazeWeight_ = Lerp(bodyGazeWeight_, targetBodyWeight, weightLerp);

    // 逐通道死区激活系数（死区后快速达到全强度，避免中远距离重复衰减）
    auto channelFactor = [&](float deadzone) -> float {
        if (!gazeEnabled) return 0.0f;
        float t = (radius - deadzone) / std::max(0.001f, (0.22f - deadzone));
        return SmoothStep(t);
    };

    // 眼珠的待机回正系数：仅在 Tracking/Reacquiring 时跟随鼠标，其余状态平滑归零。
    float targetEyeFollow = 0.0f;
    if (gazeState_ == GazeActivityState::Tracking || gazeState_ == GazeActivityState::Reacquiring)
        targetEyeFollow = 1.0f;
    const float eyeFollowK = std::min(1.0f, delta * gazeReturnSpeed_ * 2.5f);
    eyeFollowFactor_ = Lerp(eyeFollowFactor_, targetEyeFollow, eyeFollowK);

    // ---- 眼睛（最快，10Hz）：mapped × 0.95 / 0.85 ----
    float fEye = channelFactor(0.02f) * eyeFollowFactor_;
    float eyeXTarget = Clamp(mappedX_ * 0.95f, -0.95f, 0.95f) * fEye;
    float eyeYTarget = Clamp(mappedY_ * 0.85f, -0.85f, 0.85f) * fEye;

    // ---- 头部（中等，4.5Hz）：mapped × 模型真实限制 ----
    // 映射：头 X（左右）← 鼠标左右；头 Y（上下）← 鼠标上下；头 Z（歪头）← 斜向观察。
    float fHead = channelFactor(0.04f);
    float headXTarget = mappedX_ * headMaxX_ * fHead;
    float headYTarget = mappedY_ * headMaxY_ * fHead;
    float tilt = -mappedX_ * 3.6f + mappedX_ * std::fabs(mappedY_) * 2.0f;
    float diagonal = mappedX_ * mappedY_ * 2.5f;
    float headZTarget = Clamp(tilt + diagonal, -headMaxZ_, headMaxZ_) * fHead;

    // ---- 身体（最慢，2.3Hz）：头部 × 慢比例（X 0.24 / Y 0.13 / Z 0.32）----
    float fBody = channelFactor(0.08f);
    float bodyXTarget = headXTarget * 0.24f * fBody;
    float bodyYTarget = headYTarget * 0.13f * fBody;
    float bodyZTarget = headZTarget * 0.32f * fBody;

    // 最终总乘数（权重审计）：正常 Tracking 无动作时接近 1.0
    finalGazeMultiplier_ = headGazeWeight_ * actionGazeMask_ * fHead;

    // 弹簧积分（分层速度：眼睛 10Hz > 头部 4.5Hz > 身体 2.3Hz）
    float virtualDt = delta * gazeSpeed_;
    int substeps = std::max(1, static_cast<int>(std::ceil(virtualDt / 0.008f)));
    float subDt = virtualDt / static_cast<float>(substeps);
    for (int i = 0; i < substeps; i++)
    {
        SpringStep(gazeEyeX_, eyeXTarget, 4000.0f, 100.0f, subDt);
        SpringStep(gazeEyeY_, eyeYTarget, 4000.0f, 100.0f, subDt);
        SpringStep(gazeHeadX_, headXTarget, 800.0f, 45.0f, subDt);
        SpringStep(gazeHeadY_, headYTarget, 800.0f, 45.0f, subDt);
        SpringStep(gazeHeadZ_, headZTarget, 640.0f, 40.0f, subDt);
        SpringStep(gazeBodyX_, bodyXTarget, 210.0f, 23.0f, subDt);
        SpringStep(gazeBodyY_, bodyYTarget, 210.0f, 23.0f, subDt);
        SpringStep(gazeBodyZ_, bodyZTarget, 180.0f, 21.0f, subDt);
    }

    // 眼珠：纯视线（无 idle 成分）
    if (gazeEyeX_.available)
        SetParam(model, gazeEyeX_.paramIndex, BlendParamValue(gazeEyeX_.current, gazeEyeX_.paramIndex, gazeEyeX_.min, gazeEyeX_.max));
    if (gazeEyeY_.available)
        SetParam(model, gazeEyeY_.paramIndex, BlendParamValue(gazeEyeY_.current, gazeEyeY_.paramIndex, gazeEyeY_.min, gazeEyeY_.max));

    // 头部：分层合成 (idle + sub-freq + gaze + action)
    float headBaseX = (headWanderX_ + headSubOffsetX_) * idleWeight_ + gazeHeadX_.current * headGazeWeight_;
    float headBaseY = (headWanderY_ + headSubOffsetY_) * idleWeight_ + gazeHeadY_.current * headGazeWeight_;
    float headBaseZ = (headWanderZ_ + headSubOffsetZ_) * idleWeight_ + gazeHeadZ_.current * headGazeWeight_;
    if (gazeHeadX_.available) SetParam(model, gazeHeadX_.paramIndex, BlendParamValue(headBaseX, gazeHeadX_.paramIndex, gazeHeadX_.min, gazeHeadX_.max));
    if (gazeHeadY_.available) SetParam(model, gazeHeadY_.paramIndex, BlendParamValue(headBaseY, gazeHeadY_.paramIndex, gazeHeadY_.min, gazeHeadY_.max));
    if (gazeHeadZ_.available) SetParam(model, gazeHeadZ_.paramIndex, BlendParamValue(headBaseZ, gazeHeadZ_.paramIndex, gazeHeadZ_.min, gazeHeadZ_.max));

    // ---- 覆盖检测：Gaze 写入后快照（若 BeforeModelUpdate 变小，说明被后续流程覆盖）----
    afterGazeX_ = GetParam(model, idAngleX_, 0.0f);
    afterGazeY_ = GetParam(model, idAngleY_, 0.0f);

    // 身体：分层合成 (idle + sub-freq + gaze + state + action)
    float bodyBaseX = (bodyWanderX_ + bodySubOffsetX_) * idleWeight_ + gazeBodyX_.current * bodyGazeWeight_;
    float bodyBaseY = (bodyWanderY_ + bodySubOffsetY_) * idleWeight_ + gazeBodyY_.current * bodyGazeWeight_;
    float bodyBaseZ = (bodyWanderZ_ + bodySubOffsetZ_) * idleWeight_ + gazeBodyZ_.current * bodyGazeWeight_ + bodyLean_;
    if (gazeBodyX_.available) SetParam(model, gazeBodyX_.paramIndex, BlendParamValue(bodyBaseX, gazeBodyX_.paramIndex, gazeBodyX_.min, gazeBodyX_.max));
    if (gazeBodyY_.available) SetParam(model, gazeBodyY_.paramIndex, BlendParamValue(bodyBaseY, gazeBodyY_.paramIndex, gazeBodyY_.min, gazeBodyY_.max));
    if (gazeBodyZ_.available) SetParam(model, gazeBodyZ_.paramIndex, BlendParamValue(bodyBaseZ, gazeBodyZ_.paramIndex, gazeBodyZ_.min, gazeBodyZ_.max));
}
void Live2DParameterController::UpdateBreath(CubismModel* model, float delta)
{
    // 周期缓慢过渡到下一目标（避免突变）
    float periodK = std::min(1.0f, delta / 4.0f);
    breathPeriod_ = Lerp(breathPeriod_, breathNextPeriod_, periodK);
    breathMin_ = Lerp(breathMin_, breathNextMin_, periodK);
    breathMax_ = Lerp(breathMax_, breathNextMax_, periodK);

    // 相位推进
    float speed = 6.2831853f / std::max(0.1f, breathPeriod_);
    breathPhase_ += delta * speed;

    // 完成一个完整呼吸周期后生成下一组随机值
    while (breathPhase_ >= 6.2831853f)
    {
        breathPhase_ -= 6.2831853f;
        // 生成下一周期随机参数：周期 ±8%，幅度 ±5%
        float periodCenter = 4.6f;
        float periodVar = periodCenter * 0.08f;
        breathNextPeriod_ = Clamp(periodCenter + RandRange(rng_, -periodVar, periodVar), 3.8f, 5.5f);
        // 幅度随机：min/max 变化 ±5%
        float minVar = 0.05f;
        float maxVar = 0.05f;
        breathNextMin_ = Clamp(0.15f + RandRange(rng_, -minVar, minVar), 0.05f, 0.30f);
        breathNextMax_ = Clamp(0.85f + RandRange(rng_, -maxVar, maxVar), 0.70f, 0.95f);
        // 确保 min < max
        if (breathNextMin_ >= breathNextMax_)
            breathNextMin_ = breathNextMax_ - 0.1f;
    }
    if (breathPhase_ < 0.0f) breathPhase_ = 0.0f;
    // 防溢出
    if (breathPhase_ > 6.2831853f * 100.0f) breathPhase_ -= 6.2831853f * 100.0f;

    // 计算呼吸值（非对称曲线）
    float phase01 = breathPhase_ / 6.2831853f;
    float value = AsymmetricBreath(phase01, breathMin_, breathMax_);
    if (sleep_)
        value = breathMin_ + (value - breathMin_) * 0.45f; // 睡眠呼吸变浅

    if (idBreath_ >= 0)
        SetParam(model, idBreath_, Clamp(value, 0.0f, 1.0f));
}

void Live2DParameterController::UpdateLipSync(CubismModel* model, float delta)
{
    float k = std::min(1.0f, delta * 8.0f);
    lipCurrent_ = Lerp(lipCurrent_, lipTarget_, k);
    if (lipTarget_ <= 0.001f)
        lipCurrent_ = Lerp(lipCurrent_, 0.0f, std::min(1.0f, delta * 6.0f));

    SetParam(model, idMouthOpenY_, BlendParamValue(lipCurrent_, idMouthOpenY_, 0.0f, 1.0f));
}

void Live2DParameterController::EnterBlinkState(BlinkState s, float duration)
{
    blinkState_ = s;
    blinkStateElapsed_ = 0.0f;
    blinkStateDuration_ = std::max(0.001f, duration);
}

void Live2DParameterController::RollNextBlinkDelay()
{
    nextBlinkDelay_ = RandRange(rng_, 2.0f, 5.0f);
}

float Live2DParameterController::EyeLValue(float openness) const
{
    return Clamp(eyeLOpenMin_ + (eyeLOpenMax_ - eyeLOpenMin_) * openness, eyeLOpenMin_, eyeLOpenMax_);
}

float Live2DParameterController::EyeRValue(float openness) const
{
    return Clamp(eyeROpenMin_ + (eyeROpenMax_ - eyeROpenMin_) * openness, eyeROpenMin_, eyeROpenMax_);
}

void Live2DParameterController::WriteEyes(CubismModel* model, float lOpenness, float rOpenness)
{
    lOpenness = Clamp(lOpenness, 0.0f, 1.0f);
    rOpenness = Clamp(rOpenness, 0.0f, 1.0f);
    leftWeight_ = lOpenness;
    rightWeight_ = rOpenness;
    float lv = BlendParamValue(EyeLValue(lOpenness), idEyeLOpen_, eyeLOpenMin_, eyeLOpenMax_);
    float rv = BlendParamValue(EyeRValue(rOpenness), idEyeROpen_, eyeROpenMin_, eyeROpenMax_);
    SetParam(model, idEyeLOpen_, lv);
    SetParam(model, idEyeROpen_, rv);
}

void Live2DParameterController::RecoverBlinkSafe()
{
    blinkState_ = BlinkState::OpenHold;
    blinkStateElapsed_ = 0.0f;
    blinkStateDuration_ = kOpenHoldDuration;
    leftWeight_ = 1.0f;
    rightWeight_ = 1.0f;
    stuckClosedTime_ = 0.0f;
    RollNextBlinkDelay();
}

void Live2DParameterController::UpdateBlink(CubismModel* model, float delta)
{
    if (eyeOverrideActive_)
        return; // 互动眼覆盖（抚摸闭眼）期间：自动眨眼与卡死检测全部暂停

    if (!blinkEnabled_)
        return;

    if (blinkState_ != BlinkState::Idle)
        nextBlinkDelay_ = 0.0f;

    switch (blinkState_)
    {
    case BlinkState::Idle:
    {
        blinkStateElapsed_ += delta;
        WriteEyes(model, 1.0f, 1.0f);
        lastEyeWriter_ = "blink";
        if (blinkStateElapsed_ >= nextBlinkDelay_)
        {
            EnterBlinkState(BlinkState::Closing, RandRange(rng_, 0.090f, 0.140f));
        }
        break;
    }
    case BlinkState::Closing:
    {
        blinkStateElapsed_ += delta;
        float t = blinkStateElapsed_ / blinkStateDuration_;
        float openness = 1.0f - SmoothStep(t);
        WriteEyes(model, openness, openness);
        lastEyeWriter_ = "blink";
        if (t >= 1.0f)
            EnterBlinkState(BlinkState::ClosedHold, RandRange(rng_, 0.040f, 0.080f));
        break;
    }
    case BlinkState::ClosedHold:
    {
        blinkStateElapsed_ += delta;
        WriteEyes(model, 0.0f, 0.0f);
        lastEyeWriter_ = "blink";
        if (blinkStateElapsed_ >= blinkStateDuration_)
            EnterBlinkState(BlinkState::Opening, RandRange(rng_, 0.090f, 0.180f));
        break;
    }
    case BlinkState::Opening:
    {
        blinkStateElapsed_ += delta;
        float t = blinkStateElapsed_ / blinkStateDuration_;
        float openness = SmoothStep(t);
        WriteEyes(model, openness, openness);
        lastEyeWriter_ = "blink";
        if (t >= 1.0f)
        {
            EnterBlinkState(BlinkState::OpenHold, kOpenHoldDuration);
        }
        break;
    }
    case BlinkState::OpenHold:
    {
        blinkStateElapsed_ += delta;
        WriteEyes(model, 1.0f, 1.0f);
        lastEyeWriter_ = "blink";
        if (blinkStateElapsed_ >= blinkStateDuration_)
        {
            EnterBlinkState(BlinkState::Idle, 0.0f);
            blinkStateElapsed_ = 0.0f;
            RollNextBlinkDelay();
        }
        break;
    }
    }

    DetectStuckEyes(model, delta);
}

void Live2DParameterController::DetectStuckEyes(CubismModel* model, float delta)
{
    (void)model;
    if (sleep_)
    {
        stuckClosedTime_ = 0.0f;
        return;
    }
    bool inBlinkClose = (blinkState_ == BlinkState::Closing || blinkState_ == BlinkState::ClosedHold);
    bool below = (leftWeight_ < kEyeClosedThreshold && rightWeight_ < kEyeClosedThreshold);
    if (below && !inBlinkClose)
    {
        stuckClosedTime_ += delta;
        if (stuckClosedTime_ >= kEyeStuckSeconds)
        {
            NativeLog::Instance().Error(
                "EYE_STUCK_CLOSED BlinkState=%d 眼睛连续低于闭眼阈值 %.2fs lastWriter=%s -> 强制恢复",
                static_cast<int>(blinkState_), stuckClosedTime_, lastEyeWriter_.c_str());
            RecoverBlinkSafe();
            lastEyeWriter_ = "stuck_recover";
            stuckClosedTime_ = 0.0f;
        }
    }
    else
    {
        stuckClosedTime_ = 0.0f;
    }
}

void Live2DParameterController::TraceDiagnostics(CubismModel* model, float delta)
{
    if (!traceEnabled_)
        return;

    traceTimer_ += delta;
    if (traceTimer_ < 0.25f)
        return;
    traceTimer_ = 0.0f;

    float eyeL = GetParam(model, idEyeLOpen_, 0.0f);
    float eyeR = GetParam(model, idEyeROpen_, 0.0f);
    float eyeBX = GetParam(model, idEyeBallX_, 0.0f);
    float eyeBY = GetParam(model, idEyeBallY_, 0.0f);
    float hx = GetParam(model, idAngleX_, 0.0f);
    float hy = GetParam(model, idAngleY_, 0.0f);
    float hz = GetParam(model, idAngleZ_, 0.0f);
    float bx = GetParam(model, idBodyAngleX_, 0.0f);
    float by = GetParam(model, idBodyAngleY_, 0.0f);
    float bz = GetParam(model, idBodyAngleZ_, 0.0f);

    const char* stateName = "Idle";
    switch (blinkState_)
    {
    case BlinkState::Closing: stateName = "Closing"; break;
    case BlinkState::ClosedHold: stateName = "ClosedHold"; break;
    case BlinkState::Opening: stateName = "Opening"; break;
    case BlinkState::OpenHold: stateName = "OpenHold"; break;
    default: break;
    }

    float breathVal = 0.0f;
    if (idBreath_ >= 0)
        breathVal = GetParam(model, idBreath_, 0.0f);

    NativeLog::Instance().Info(
        "TRACE_PARAMS BlinkState=%s EyeLOpen=%.3f/%.3f EyeROpen=%.3f/%.3f EyeBallX=%.3f EyeBallY=%.3f "
        "HeadX=%.2f HeadY=%.2f HeadZ=%.2f BodyX=%.2f BodyY=%.2f BodyZ=%.2f "
        "IdleH=%.2f/%.2f/%.2f IdleB=%.2f/%.2f/%.2f IdleWt=%.2f GazeWt=%.2f/%.2f "
        "HeadMax=%.2f/%.2f/%.2f HeadRange=%.2f/%.2f/%.2f HeadAmount=%.2f/%.2f "
        "Raw=%.2f/%.2f Mapped=%.2f/%.2f GazeWeight=%.2f ActionGazeMask=%.2f FinalGazeMultiplier=%.2f "
        "BeforeGazeX=%.2f GazeTargetX=%.2f AfterGazeX=%.2f BeforeModelUpdateX=%.2f "
        "Breath=%.3f BreathPeriod=%.2f BreathMin=%.3f BreathMax=%.3f "
        "cursor=%.3f/%.3f cursorVel=%.2f/%.2f motionActive=%d physics=%d host=%s delta=%.4f "
        "physicsStrength=%.2f/%.2f idleTimeout=%.2f idleElapsed=%.2f eyeFollow=%.2f sequence=%d",
        stateName, eyeL, EyeLValue(leftWeight_), eyeR, EyeRValue(rightWeight_),
        eyeBX, eyeBY, hx, hy, hz, bx, by, bz,
        headWanderX_, headWanderY_, headWanderZ_,
        bodyWanderX_, bodyWanderY_, bodyWanderZ_,
        idleWeight_, headGazeWeight_, bodyGazeWeight_,
        headMaxX_, headMaxY_, headMaxZ_, headRangeX_, headRangeY_, headRangeZ_,
        headFollowAmountCur_, headFollowAmountTgt_,
        gazeRawX_, gazeRawY_, mappedX_, mappedY_,
        headGazeWeight_, actionGazeMask_, finalGazeMultiplier_,
        beforeGazeX_, gazeHeadX_.current, afterGazeX_, beforeModelUpdateX_,
        breathVal, breathPeriod_, breathMin_, breathMax_,
        gazeTargetX_, gazeTargetY_, gazeCursorVX_, gazeCursorVY_,
        actionPlayer_.IsPlaying() ? 1 : 0, tracePhysics_ ? 1 : 0, traceHostState_.c_str(), delta,
        physicsStrengthCurrent_, physicsStrengthTarget_, gazeIdleTimeout_, cursorActivity_.idleElapsed,
        eyeFollowFactor_, cursorActivity_.movementSequence);
}

} // namespace aliya











