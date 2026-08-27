#include <algorithm>
#include "live2d_host.hpp"

#include <cstdlib>
#include <cstring>

#include "aliya_live2d.h"
#include "live2d_asset_loader.hpp"
#include "native_log.hpp"
#include "render_backend.h"

#if defined(ALIYA_BACKEND_D3D11)
#include "Rendering/D3D11/CubismRenderer_D3D11.hpp"
#include "Rendering/D3D11/CubismDeviceInfo_D3D11.hpp"
#include "Rendering/D3D11/CubismShader_D3D11.hpp"
#include <d3dcompiler.h>
#endif

using namespace Live2D::Cubism::Framework;

namespace aliya {

// ---------- CubismAllocator ----------
void* CubismAllocator::Allocate(const csmSizeType size)
{
    return ::malloc(size);
}

void CubismAllocator::Deallocate(void* memory)
{
    ::free(memory);
}

void* CubismAllocator::AllocateAligned(const csmSizeType size, const csmUint32 alignment)
{
    // 注意：alignment 是 32 位，必须先提升为 size_t 再取反，
    // 否则 ~(alignment-1) 是 32 位掩码，& 时零扩展会清空 64 位地址的高 32 位。
    const size_t align = (alignment == 0) ? 1 : static_cast<size_t>(alignment);
    const size_t offset = (align - 1) + sizeof(void*);
    void* p1 = ::malloc(size + offset);
    if (!p1)
        return nullptr;
    void** p2 = reinterpret_cast<void**>((reinterpret_cast<size_t>(p1) + offset) & ~(align - 1));
    p2[-1] = p1;
    return p2;
}

void CubismAllocator::DeallocateAligned(void* alignedMemory)
{
    if (!alignedMemory)
        return;
    void** p2 = reinterpret_cast<void**>(alignedMemory);
    ::free(p2[-1]);
}

// ---------- Framework 全局生命周期 ----------
static std::mutex g_frameworkMutex;
static int g_frameworkRefCount = 0;
static CubismAllocator g_allocator;
// Framework 的 s_option 保存的是指针，必须保证 Option 生命周期覆盖整个进程。
static CubismFramework::Option g_frameworkOption;

static void CubismLogHandler(const char* message)
{
    NativeLog::Instance().Info("CubismCore: %s", message ? message : "");
}

void Live2DHost::AcquireFramework()
{
    std::lock_guard<std::mutex> lock(g_frameworkMutex);
    if (g_frameworkRefCount == 0)
    {
        memset(&g_frameworkOption, 0, sizeof(g_frameworkOption));
        g_frameworkOption.LogFunction = CubismLogHandler;
        g_frameworkOption.LoggingLevel = CubismFramework::Option::LogLevel_Warning;
        g_frameworkOption.LoadFileFunction = CubismLoadFileFunction;
        g_frameworkOption.ReleaseBytesFunction = CubismReleaseBytesFunction;
        CubismFramework::StartUp(&g_allocator, &g_frameworkOption);
        CubismFramework::Initialize();
        NativeLog::Instance().Info("CubismFramework 已初始化");
    }
    g_frameworkRefCount++;
}

void Live2DHost::ReleaseFramework()
{
    std::lock_guard<std::mutex> lock(g_frameworkMutex);
    if (g_frameworkRefCount > 0)
        g_frameworkRefCount--;
    if (g_frameworkRefCount == 0)
    {
#if defined(ALIYA_BACKEND_D3D11)
        Rendering::CubismDeviceInfo_D3D11::ReleaseAllDeviceInfo();
#endif
        CubismFramework::Dispose();
        CubismFramework::CleanUp();
        NativeLog::Instance().Info("CubismFramework 已释放");
    }
}

// ---------- Live2DHost ----------
Live2DHost::Live2DHost()
{
    state_.store(HostState::Created);
    AcquireFramework();
}

Live2DHost::~Live2DHost()
{
    DestroyAll();
    ReleaseFramework();
}

void Live2DHost::SetState(HostState s)
{
    state_.store(s);
}

HostState Live2DHost::GetState() const
{
    return state_.load();
}

bool Live2DHost::Ready() const
{
    HostState s = state_.load();
    return s == HostState::Ready || s == HostState::Paused;
}

bool Live2DHost::EnsureDevices()
{
    if (!devices_.CreateDevice())
    {
        SetLastError(devices_.LastError());
        return false;
    }
#if defined(ALIYA_BACKEND_D3D11)
    Rendering::CubismRenderer_D3D11::SetConstantSettings(1, devices_.Device11());
#endif
    return true;
}

bool Live2DHost::SetAssetDirectory(const std::string& utf8Root)
{
    SetAssetRoot(utf8Root);
    return true;
}

bool Live2DHost::LoadModel(const std::string& utf8ModelJsonPath)
{
    std::lock_guard<std::mutex> lock(lifecycleMutex_);
    HostState s = state_.load();
    if (s != HostState::Created && s != HostState::Initializing)
    {
        SetLastError("LoadModel: 当前状态不允许加载模型");
        return false;
    }
    SetState(HostState::Initializing);

    if (!EnsureDevices())
    {
        SetState(HostState::Failed);
        return false;
    }

    model_ = std::make_unique<Live2DModel>(devices_);
    std::string error;
    if (!model_->Load(utf8ModelJsonPath, error))
    {
        SetLastError(error);
        NativeLog::Instance().Error("Live2DHost::LoadModel 失败: %s", error.c_str());
        model_.reset();          // 部分清理
        devices_.DestroyTargets();
        SetState(HostState::Failed);
        return false;
    }
    return true; // 状态保持 Initializing，AttachWindow 后进入 Ready
}

bool Live2DHost::AttachWindow(void* hwnd, int widthPx, int heightPx)
{
    std::lock_guard<std::mutex> lock(lifecycleMutex_);
    if (state_.load() != HostState::Initializing || !model_)
    {
        SetLastError("AttachWindow: 需先成功 LoadModel");
        return false;
    }

    parentHwnd_ = hwnd;
    viewportW_ = widthPx;
    viewportH_ = heightPx;

    if (!devices_.ResizeTargets(viewportW_, viewportH_))
    {
        SetLastError(devices_.LastError());
        SetState(HostState::Failed);
        return false;
    }
    if (!model_->Resize(viewportW_, viewportH_))
    {
        SetLastError("模型视口重建失败");
        SetState(HostState::Failed);
        return false;
    }

    SetState(HostState::Ready);
    return true;
}

bool Live2DHost::SetViewport(int widthPx, int heightPx)
{
    std::lock_guard<std::mutex> lock(lifecycleMutex_);
    if (!Ready())
    {
        SetLastError("SetViewport: 未就绪");
        return false;
    }
    if (widthPx <= 0 || heightPx <= 0)
    {
        SetLastError("SetViewport: 无效尺寸");
        return false;
    }

    viewportW_ = widthPx;
    viewportH_ = heightPx;

    if (!devices_.ResizeTargets(viewportW_, viewportH_))
    {
        SetLastError(devices_.LastError());
        return false;
    }
    if (model_ && !model_->Resize(viewportW_, viewportH_))
    {
        SetLastError("模型视口重建失败");
        return false;
    }
    return true;
}

const char* Live2DHost::StateName(HostState s)
{
    switch (s)
    {
    case HostState::Created: return "Created";
    case HostState::Initializing: return "Initializing";
    case HostState::Ready: return "Ready";
    case HostState::Paused: return "Paused";
    case HostState::Failed: return "Failed";
    case HostState::Destroyed: return "Destroyed";
    }
    return "Unknown";
}

bool Live2DHost::Update(float deltaSeconds)
{
    if (!Ready() || paused_ || !model_)
        return false;

    // 每帧开头读取一次最新输入快照（托管层事件线程只写快照）
    {
        std::lock_guard<std::mutex> lock(inputMutex_);
        if (gazeInput_.valid)
            model_->Controller().SetLookTarget(gazeInput_.x, gazeInput_.y);
        else
            model_->Controller().ClearLookTarget();
    }

    model_->Controller().SetTraceContext(model_->HasPhysics(), StateName(state_.load()));
    model_->Update(static_cast<float>(deltaSeconds));
    return true;
}

bool Live2DHost::Render()
{
    if (!Ready() || !model_ || !devices_.TargetValid())
        return false;

#if defined(ALIYA_BACKEND_D3D11)
    auto* context = devices_.Context11();
    auto* rtv = devices_.RTV();
    auto* dsv = devices_.DepthDSV();
    if (!context || !rtv || !dsv)
    {
        SetLastError("Render: DirectX 资源为空");
        return false;
    }

    ID3D11RenderTargetView* rtvs[1] = { rtv };
    context->OMSetRenderTargets(1, rtvs, dsv);
    float clearColor[4] = { 0.0f, 0.0f, 0.0f, 0.0f };
    context->ClearRenderTargetView(rtv, clearColor);
    context->ClearDepthStencilView(dsv, D3D11_CLEAR_DEPTH, 1.0f, 0);

    D3D11_VIEWPORT vp = {};
    vp.Width = static_cast<float>(viewportW_);
    vp.Height = static_cast<float>(viewportH_);
    vp.MaxDepth = 1.0f;
    context->RSSetViewports(1, &vp);

    model_->Render(viewportW_, viewportH_);

    ID3D11RenderTargetView* nullRtv[1] = { nullptr };
    context->OMSetRenderTargets(1, nullRtv, nullptr);
    context->Flush();
#elif defined(ALIYA_BACKEND_OPENGLES)
    // 双引擎并发（Android 主界面 + 悬浮窗）下 EGL 操作必须串行化
    std::lock_guard<std::mutex> glLock(GlMutex());
    if (!devices_.BindFrameBuffer())
    {
        SetLastError("Render: FBO 绑定失败");
        return false;
    }
    glClearColor(0.0f, 0.0f, 0.0f, 0.0f);
    glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
    model_->Render(viewportW_, viewportH_);
    devices_.UnbindFrameBuffer();
#endif
    return true;
}

bool Live2DHost::UploadTexture(int textureIndex, int widthPx, int heightPx, const unsigned char* rgba)
{
    if (!Ready() || !model_ || !rgba || textureIndex < 0 || widthPx <= 0 || heightPx <= 0)
        return false;
    return model_->UploadTexture(textureIndex, widthPx, heightPx, rgba);
}

bool Live2DHost::CopyFramePixels(unsigned char* dest, int destStride)
{
    if (!Ready() || !model_ || !devices_.TargetValid())
        return false;
#if defined(ALIYA_BACKEND_OPENGLES)
    // 双引擎并发下 EGL 操作必须串行化
    std::lock_guard<std::mutex> glLock(GlMutex());
#endif
    return devices_.CopyFramePixels(dest, destStride);
}

bool Live2DHost::Pause()
{
    if (!Ready())
        return false;
    paused_ = true;
    if (model_)
    {
        model_->Controller().SetPaused(true);
        model_->ResetPhysicsAccumulator();
    }
    SetState(HostState::Paused);
    return true;
}

bool Live2DHost::Resume()
{
    if (state_.load() != HostState::Paused)
        return false;
    paused_ = false;
    if (model_)
    {
        model_->Controller().SetPaused(false);
        model_->ResetPhysicsAccumulator();
    }
    SetState(HostState::Ready);
    return true;
}

bool Live2DHost::SetScale(float scale)
{
    if (!Ready() || !model_)
        return false;
    model_->SetScale(scale);
    return true;
}

bool Live2DHost::SetOpacity(float opacity)
{
    opacity_ = opacity;
    return true;
}

bool Live2DHost::SetState(const std::string& state, float intensity)
{
    if (!Ready() || !model_)
        return false;
    model_->Controller().SetState(state, intensity);
    return true;
}

bool Live2DHost::PlayAction(const std::string& action)
{
    if (!Ready() || !model_)
        return false;
    model_->Controller().PlayAction(action);
    return true;
}

bool Live2DHost::SetLookTarget(float x01, float y01)
{
    if (!Ready())
        return false;
    // 只更新线程安全快照，Native 每帧 Update 开头读取
    std::lock_guard<std::mutex> lock(inputMutex_);
    gazeInput_.x = x01;
    gazeInput_.y = y01;
    gazeInput_.valid = true;
    return true;
}

bool Live2DHost::SetGazeRawInput(float x, float y)
{
    if (!Ready())
        return false;
    // raw(-1..1) 统一换算为 0..1 快照口径（controller 内部转回 raw）
    std::lock_guard<std::mutex> lock(inputMutex_);
    gazeInput_.x = x * 0.5f + 0.5f;
    gazeInput_.y = y * 0.5f + 0.5f;
    gazeInput_.valid = true;
    return true;
}

bool Live2DHost::SetGazeHeadRange(float x, float y, float z)
{
    if (!Ready() || !model_)
        return false;
    model_->Controller().SetGazeHeadRange(x, y, z);
    return true;
}

bool Live2DHost::GetGazeHeadRange(float* x, float* y, float* z) const
{
    if (!model_ || !x || !y || !z)
        return false;
    *x = model_->Controller().GazeHeadRangeX();
    *y = model_->Controller().GazeHeadRangeY();
    *z = model_->Controller().GazeHeadRangeZ();
    return true;
}

bool Live2DHost::SetGazeHeadFollowAmount(float amount)
{
    if (!Ready() || !model_)
        return false;
    model_->Controller().SetGazeHeadFollowAmount(amount);
    return true;
}

bool Live2DHost::GetGazeHeadFollowAmount(float* outCurrent, float* outTarget) const
{
    if (!model_ || !outCurrent || !outTarget)
        return false;
    *outCurrent = model_->Controller().GazeHeadFollowAmount();
    *outTarget = model_->Controller().GazeHeadFollowAmountTarget();
    return true;
}

bool Live2DHost::GetGazeDiagnostics(AliyaLive2DGazeDiagnostics* out) const
{
    if (!model_ || !out)
        return false;
    auto d = model_->Controller().GetGazeDiagnostics();
    out->headMaxX = d.headMaxX;
    out->headMaxY = d.headMaxY;
    out->headMaxZ = d.headMaxZ;
    out->headRangeX = d.headRangeX;
    out->headRangeY = d.headRangeY;
    out->headRangeZ = d.headRangeZ;
    out->headFollowAmount = d.headFollowAmount;
    out->headFollowAmountTarget = d.headFollowAmountTarget;
    out->gazeWeight = d.gazeWeight;
    out->actionGazeMask = d.actionGazeMask;
    out->finalGazeMultiplier = d.finalGazeMultiplier;
    out->headTargetX = d.headTargetX;
    out->headTargetY = d.headTargetY;
    out->headTargetZ = d.headTargetZ;
    out->rawX = d.rawX;
    out->rawY = d.rawY;
    out->mappedX = d.mappedX;
    out->mappedY = d.mappedY;
    out->beforeGazeX = d.beforeGazeX;
    out->afterGazeX = d.afterGazeX;
    out->beforeModelUpdateX = d.beforeModelUpdateX;
    out->beforeGazeY = d.beforeGazeY;
    out->afterGazeY = d.afterGazeY;
    out->beforeModelUpdateY = d.beforeModelUpdateY;
    return true;
}

bool Live2DHost::ClearLookTarget()
{
    if (!Ready())
        return false;
    std::lock_guard<std::mutex> lock(inputMutex_);
    gazeInput_.valid = false;
    return true;
}

bool Live2DHost::SetLookAtEnabled(bool enabled)
{
    if (!Ready() || !model_)
        return false;
    model_->Controller().SetLookAtEnabled(enabled);
    return true;
}

bool Live2DHost::SetGazeSpeed(float multiplier)
{
    if (!Ready() || !model_)
        return false;
    model_->Controller().SetGazeSpeed(multiplier);
    return true;
}

bool Live2DHost::SetPhysicsStrength(float strength)
{
    if (!Ready() || !model_)
        return false;
    model_->Controller().SetPhysicsStrength(strength);
    return true;
}

bool Live2DHost::SetPhysicsInputGain(float headGain, float bodyGain)
{
    if (!Ready() || !model_)
        return false;
    model_->Controller().SetPhysicsInputGain(headGain, bodyGain);
    return true;
}

bool Live2DHost::SetPhysicsOutputGain(float gain)
{
    if (!Ready() || !model_)
        return false;
    model_->Controller().SetPhysicsOutputGain(gain);
    return true;
}

bool Live2DHost::SetPhysicsOutputAmplitude(float amplitude)
{
    if (!Ready() || !model_)
        return false;
    model_->Controller().SetPhysicsOutputAmplitude(amplitude);
    return true;
}

float Live2DHost::GetPhysicsOutputAmplitudeCurrent() const
{
    if (!Ready() || !model_) return -1.0f;
    return static_cast<const Live2DModel*>(model_.get())->Controller().PhysicsOutputAmplitude();
}

float Live2DHost::GetPhysicsOutputAmplitudeTarget() const
{
    if (!Ready() || !model_) return -1.0f;
    return static_cast<const Live2DModel*>(model_.get())->Controller().PhysicsOutputAmplitudeTarget();
}

bool Live2DHost::SetPhysicsEnabled(bool enabled)
{
    if (!Ready() || !model_)
        return false;
    model_->SetPhysicsEnabled(enabled);
    return true;
}

bool Live2DHost::SetPhysicsTestInput(bool enabled, float angleX, float angleZ, float bodyAngleX, float bodyAngleZ)
{
    if (!Ready() || !model_)
        return false;
    model_->SetPhysicsTestInput(enabled, angleX, angleZ, bodyAngleX, bodyAngleZ);
    return true;
}

float Live2DHost::GetHeadInputGainCurrent() const
{
    if (!Ready() || !model_) return -1.0f;
    return static_cast<const Live2DModel*>(model_.get())->Controller().HeadInputGainCurrent();
}

float Live2DHost::GetHeadInputGainTarget() const
{
    if (!Ready() || !model_) return -1.0f;
    return static_cast<const Live2DModel*>(model_.get())->Controller().HeadInputGainTarget();
}

float Live2DHost::GetBodyInputGainCurrent() const
{
    if (!Ready() || !model_) return -1.0f;
    return static_cast<const Live2DModel*>(model_.get())->Controller().BodyInputGainCurrent();
}

float Live2DHost::GetBodyInputGainTarget() const
{
    if (!Ready() || !model_) return -1.0f;
    return static_cast<const Live2DModel*>(model_.get())->Controller().BodyInputGainTarget();
}

float Live2DHost::GetPhysicsOutputGainCurrent() const
{
    if (!Ready() || !model_) return -1.0f;
    return static_cast<const Live2DModel*>(model_.get())->Controller().PhysicsOutputGain();
}

float Live2DHost::GetPhysicsOutputGainTarget() const
{
    if (!Ready() || !model_) return -1.0f;
    return static_cast<const Live2DModel*>(model_.get())->Controller().PhysicsOutputGainTarget();
}

bool Live2DHost::GetPhysicsDriveInfo(AliyaLive2DPhysicsDriveInfo* out) const
{
    if (!out || !Ready() || !model_)
        return false;
    const auto& d = model_->LastPhysicsDrive();
    out->visibleAngleX = d.visibleAngleX;
    out->visibleAngleZ = d.visibleAngleZ;
    out->visibleBodyX = d.visibleBodyX;
    out->visibleBodyZ = d.visibleBodyZ;
    out->physicsAngleX = d.physicsAngleX;
    out->physicsAngleZ = d.physicsAngleZ;
    out->physicsBodyX = d.physicsBodyX;
    out->physicsBodyZ = d.physicsBodyZ;
    out->velocityHeadX = d.velocityHeadX;
    out->velocityHeadZ = d.velocityHeadZ;
    out->evaluateCount = d.evaluateCount;
    out->outputMaxDelta = d.outputMaxDelta;
    out->headInputGain = model_->Controller().HeadInputGainCurrent() * model_->Controller().HeadInputGainStateMultiplier();
    out->bodyInputGain = model_->Controller().BodyInputGainCurrent() * model_->Controller().BodyInputGainStateMultiplier();
    out->outputGain = model_->Controller().PhysicsOutputGain();
    out->outputAmplitude = d.outputAmplitude;
    out->outputAmplitudeTarget = d.outputAmplitudeTarget;
    out->outputFinalMaxDelta = d.outputFinalMaxDelta;
    out->outputClampHits = d.outputClampHits;
    out->uniqueOutputCount = d.uniqueOutputCount;
    out->amplitudeApplyCount = d.amplitudeApplyCount;
    out->physicsFps = static_cast<int>(d.physicsFps);
    return true;
}

bool Live2DHost::SetGazeIdleTimeout(float seconds)
{
    if (!Ready() || !model_)
        return false;
    model_->Controller().SetGazeIdleTimeout(seconds);
    return true;
}

bool Live2DHost::SetMouseIdleTimeout(float seconds)
{
    if (!Ready() || !model_)
        return false;
    model_->Controller().SetMouseIdleTimeout(seconds);
    return true;
}

float Live2DHost::GetPhysicsStrengthTarget() const
{
    if (!Ready() || !model_)
        return -1.0f;
    return static_cast<const Live2DModel*>(model_.get())->Controller().PhysicsStrengthTarget();
}

float Live2DHost::GetPhysicsStrengthCurrent() const
{
    if (!Ready() || !model_)
        return -1.0f;
    return static_cast<const Live2DModel*>(model_.get())->Controller().PhysicsStrengthCurrent();
}

float Live2DHost::GetMouseIdleTimeout() const
{
    if (!Ready() || !model_)
        return -1.0f;
    return static_cast<const Live2DModel*>(model_.get())->Controller().MouseIdleTimeout();
}

float Live2DHost::GetMouseIdleElapsed() const
{
    if (!Ready() || !model_)
        return -1.0f;
    return static_cast<const Live2DModel*>(model_.get())->Controller().MouseIdleElapsed();
}

int Live2DHost::GetGazeActivityState() const
{
    if (!Ready() || !model_)
        return -1;
    return static_cast<const Live2DModel*>(model_.get())->Controller().GetGazeActivityState();
}

Live2DParameterController& Live2DHost::GetController()
{
    return model_->Controller();
}

bool Live2DHost::SetLipSyncValue(float value)
{
    if (!Ready() || !model_)
        return false;
    model_->Controller().SetLipSyncValue(value);
    return true;
}

bool Live2DHost::LipSyncSupported() const
{
    return model_ && model_->HasLipSync();
}

bool Live2DHost::SetMouthOverride(bool enabled, float openY, float form)
{
    if (!Ready() || !model_)
        return false;
    if (!std::isfinite(openY) || !std::isfinite(form))
        return false;
    model_->SetMouthOverride(enabled, openY, form);
    return true;
}

bool Live2DHost::MouthParamInfo(AliyaLive2DMouthParamInfo* out) const
{
    if (!out)
        return false;
    memset(out, 0, sizeof(*out));
    if (!Ready() || !model_)
        return false;
    out->hasOpenY = model_->HasMouthOpenY() ? 1 : 0;
    out->hasForm = model_->HasMouthForm() ? 1 : 0;
    float oyMin = 0.0f, oyMax = 1.0f, fmMin = 0.0f, fmMax = 1.0f;
    model_->GetMouthParamMeta(oyMin, oyMax, fmMin, fmMax);
    out->openYMin = oyMin;
    out->openYMax = oyMax;
    out->formMin = fmMin;
    out->formMax = fmMax;
    return true;
}

bool Live2DHost::SetInteractionOffsets(float angleX, float angleY, float angleZ, float bodyAngleX)
{
    if (!Ready() || !model_)
        return false;
    if (!std::isfinite(angleX) || !std::isfinite(angleY) || !std::isfinite(angleZ) || !std::isfinite(bodyAngleX))
        return false;
    model_->SetInteractionOffsets(angleX, angleY, angleZ, bodyAngleX);
    return true;
}

bool Live2DHost::SetEyeOverride(bool enabled, float leftOpen, float rightOpen)
{
    if (!Ready() || !model_)
        return false;
    if (!std::isfinite(leftOpen) || !std::isfinite(rightOpen))
        return false;
    model_->SetEyeOverride(enabled, leftOpen, rightOpen);
    return true;
}

bool Live2DHost::SetEarInteraction(bool enabled, float leftNorm, float rightNorm)
{
    if (!Ready() || !model_)
        return false;
    if (!std::isfinite(leftNorm) || !std::isfinite(rightNorm))
        return false;
    model_->SetEarInteraction(enabled, leftNorm, rightNorm);
    return true;
}

bool Live2DHost::SetPettingLookAtReduction(bool enabled)
{
    if (!Ready() || !model_)
        return false;
    model_->Controller().SetPettingLookAtReduction(enabled);
    return true;
}

bool Live2DHost::InteractionParamInfo(AliyaLive2DInteractionParamInfo* out) const
{
    if (!out)
        return false;
    memset(out, 0, sizeof(*out));
    if (!Ready() || !model_)
        return false;
    using CsmUint32 = Live2D::Cubism::Framework::csmUint32;
    auto* m = model_->GetModel();
    if (m)
    {
        auto range = [&](int idx, int& has, float& mn, float& mx) {
            if (idx >= 0)
            {
                has = 1;
                mn = m->GetParameterMinimumValue(static_cast<CsmUint32>(idx));
                mx = m->GetParameterMaximumValue(static_cast<CsmUint32>(idx));
            }
        };
        range(model_->AngleXIndex(), out->hasAngleX, out->angleXMin, out->angleXMax);
        range(model_->AngleYIndex(), out->hasAngleY, out->angleYMin, out->angleYMax);
        range(model_->AngleZIndex(), out->hasAngleZ, out->angleZMin, out->angleZMax);
        range(model_->BodyAngleXIndex(), out->hasBodyAngleX, out->bodyXMin, out->bodyXMax);
        range(model_->EyeLIndex(), out->hasEyeL, out->eyeLMin, out->eyeLMax);
        range(model_->EyeRIndex(), out->hasEyeR, out->eyeRMin, out->eyeRMax);
    }
    out->leftEarRootMin = 0; out->leftEarRootMax = 1; out->rightEarRootMin = 0; out->rightEarRootMax = 1;
    out->hasLeftEarRoot = model_->EarLeftRootIndex() >= 0 ? 1 : 0;
    out->hasRightEarRoot = model_->EarRightRootIndex() >= 0 ? 1 : 0;
    out->earRootPhysics = model_->EarRootPhysics() ? 1 : 0;
    float lMin = 0, lMax = 1, rMin = 0, rMax = 1;
    model_->GetEarRootRanges(lMin, lMax, rMin, rMax);
    out->leftEarRootMin = lMin;
    out->leftEarRootMax = lMax;
    out->rightEarRootMin = rMin;
    out->rightEarRootMax = rMax;
    return true;
}

bool Live2DHost::ListEarParams(char* out, int outSize) const
{
    if (!out || outSize <= 0 || !model_)
        return false;
    std::string json;
    model_->ListEarParams(json);
    int n = std::min(static_cast<int>(json.size()), outSize - 1);
    if (n > 0) memcpy(out, json.c_str(), static_cast<size_t>(n));
    out[n] = 0;
    return true;
}

bool Live2DHost::HitTest(float xPx, float yPx) const
{
    if (!Ready() || !model_)
        return false;
    return model_->HitTest(xPx, yPx);
}

bool Live2DHost::GetParameterValue(const char* id, float& outValue)
{
    if (!Ready() || !model_ || !id)
        return false;
    return model_->Controller().GetParameterValue(id, outValue);
}

bool Live2DHost::SetParameterValue(const char* id, float value)
{
    if (!Ready() || !model_ || !id)
        return false;
    return model_->Controller().SetParameterValue(id, value);
}

bool Live2DHost::ForceBlink()
{
    if (!Ready() || !model_)
        return false;
    model_->Controller().ForceBlink();
    return true;
}

bool Live2DHost::GetBlinkInfo(AliyaLive2DBlinkInfo* outInfo)
{
    if (!outInfo)
        return false;
    memset(outInfo, 0, sizeof(*outInfo));
    if (!Ready() || !model_)
        return false;
    aliya::BlinkInfo bi = model_->Controller().GetBlinkInfo();
    outInfo->state = bi.state;
    outInfo->leftOpenness = bi.leftOpenness;
    outInfo->rightOpenness = bi.rightOpenness;
    outInfo->nextBlinkDelay = bi.nextBlinkDelay;
    outInfo->enabled = bi.enabled ? 1 : 0;
    outInfo->forced = bi.forced ? 1 : 0;
    return true;
}

bool Live2DHost::ListActions(char* out, int outSize) const
{
    if (!out || outSize <= 0 || !model_)
        return false;
    std::string s = "[";
    bool first = true;
    for (const auto& a : model_->Controller().ActionLibrary().All())
    {
        if (!first) s += ",";
        first = false;
        s += "{\"id\":\"" + a.id + "\",\"duration\":" + std::to_string(a.duration) +
             ",\"priority\":" + std::to_string(a.priority) + ",\"loop\":" + (a.loop ? "true" : "false") + "}";
    }
    // 状态动作（不经过 JSON 播放器）
    if (!first) s += ",";
    s += "{\"id\":\"sleep\",\"duration\":0,\"priority\":100,\"loop\":true}";
    s += ",{\"id\":\"wake\",\"duration\":0,\"priority\":110,\"loop\":false}";
    s += ",{\"id\":\"shutdown\",\"duration\":0,\"priority\":200,\"loop\":false}";
    s += "]";
    int n = std::min(static_cast<int>(s.size()), outSize - 1);
    if (n > 0) memcpy(out, s.c_str(), static_cast<size_t>(n));
    out[n] = 0;
    return true;
}

bool Live2DHost::GetActionInfo(AliyaLive2DActionInfo* out) const
{
    if (!out)
        return false;
    memset(out, 0, sizeof(*out));
    if (!model_)
        return false;
    const auto& player = model_->Controller().ActionPlayer();
    out->isPlaying = player.IsPlaying() ? 1 : 0;
    std::string id = player.CurrentActionId();
    // snprintf 保证 null 结尾且跨平台（strncpy_s 是 MSVC 扩展，NDK 没有）。
    snprintf(out->currentActionId, sizeof(out->currentActionId), "%s", id.c_str());
    out->elapsed = player.Elapsed();
    out->duration = player.Duration();
    out->priority = player.CurrentPriority();
    return true;
}

bool Live2DHost::PollActionEvents(char* out, int outSize)
{
    if (!out || outSize <= 0 || !model_)
        return false;
    std::vector<aliya::ActionEventFired> events;
    model_->Controller().ActionPlayer().DrainEvents(events);
    std::string s = "[";
    bool first = true;
    for (const auto& e : events)
    {
        if (!first) s += ",";
        first = false;
        s += "{\"action\":\"" + e.actionId + "\",\"time\":" + std::to_string(e.time) +
             ",\"type\":\"" + e.type + "\",\"name\":\"" + e.name + "\",\"category\":\"" + e.category + "\"}";
    }
    s += "]";
    int n = std::min(static_cast<int>(s.size()), outSize - 1);
    if (n > 0) memcpy(out, s.c_str(), static_cast<size_t>(n));
    out[n] = 0;
    return true;
}

bool Live2DHost::GetInfo(AliyaLive2DModelInfo* info) const
{
    if (!info)
        return false;
    memset(info, 0, sizeof(*info));
    if (!Ready() || !model_)
        return false;
    info->parameterCount = model_->ParameterCount();
    info->drawableCount = model_->DrawableCount();
    info->textureCount = model_->TextureCount();
    info->canvasWidth = model_->CanvasWidth();
    info->canvasHeight = model_->CanvasHeight();
    info->hasPhysics = model_->HasPhysics() ? 1 : 0;
    info->hasEyeBlink = model_->HasEyeBlink() ? 1 : 0;
    info->hasLipSync = model_->HasLipSync() ? 1 : 0;
    return true;
}

bool Live2DHost::GetModelTargetSize(float& outW, float& outH) const
{
    if (!Ready() || !model_)
        return false;
    model_->ComputeTargetPixelSize(outW, outH);
    return true;
}


bool Live2DHost::ProfileStages(std::string& outText)
{
#if defined(ALIYA_BACKEND_D3D11)
    using namespace Live2D::Cubism::Framework::Rendering;
    char buf[4096];
    auto now = []() {
        LARGE_INTEGER f, t;
        QueryPerformanceFrequency(&f);
        QueryPerformanceCounter(&t);
        return (double)t.QuadPart * 1000.0 / f.QuadPart;
    };

    // 1) 全新设备创建耗时
    ID3D11Device* freshDev = nullptr;
    ID3D11DeviceContext* freshCtx = nullptr;
    D3D_FEATURE_LEVEL lv[] = { D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_1 };
    double t0 = now();
    HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                                   lv, 2, D3D11_SDK_VERSION, &freshDev, nullptr, &freshCtx);
    double tDev = now() - t0;

    // 2) SetupShader（含 D3DCompile + Create*Shader）——使用宿主设备（Framework 静态状态一致）
    double tSetup = 0;
    if (devices_.Device11())
    {
        t0 = now();
        CubismShader_D3D11 shader;
        shader.SetupShader(devices_.Device11());
        tSetup = now() - t0;
    }

    // 3) GetDeviceInfo（第二个新设备：完整 render-state + shader 初始化）
    double tGetInfo = 0;
    ID3D11Device* dev2 = nullptr;
    ID3D11DeviceContext* ctx2 = nullptr;
    if (freshDev)
    {
        hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                               lv, 2, D3D11_SDK_VERSION, &dev2, nullptr, &ctx2);
        if (SUCCEEDED(hr) && dev2)
        {
            t0 = now();
            CubismDeviceInfo_D3D11::GetDeviceInfo(dev2);
            tGetInfo = now() - t0;
        }
    }

    // 4) 单个 shader：D3DCompile + CreateVertexShader
    double tCompile = 0, tCreateVS = 0;
    {
        std::string fxPath = ResolvePath("FrameworkShaders/CubismEffect.fx");
        std::vector<char> src;
        if (ReadFileToBytes(fxPath, src))
        {
            ID3DBlob* blob = nullptr; ID3DBlob* errBlob = nullptr;
            t0 = now();
            HRESULT chr = D3DCompile(src.data(), src.size(), nullptr, nullptr, nullptr, "VertNormal", "vs_4_0", 0, 0, &blob, &errBlob);
            tCompile = now() - t0;
            if (SUCCEEDED(chr) && blob && devices_.Device11())
            {
                ID3D11VertexShader* vs = nullptr;
                t0 = now();
                devices_.Device11()->CreateVertexShader(blob->GetBufferPointer(), blob->GetBufferSize(), nullptr, &vs);
                tCreateVS = now() - t0;
                if (vs) vs->Release();
            }
            if (blob) blob->Release();
            if (errBlob) errBlob->Release();
        }
    }

    snprintf(buf, sizeof(buf),
        "D3D11CreateDevice=%.1f ms; SetupShader=%.1f ms; GetDeviceInfo(fresh)=%.1f ms; D3DCompile(1)=%.3f ms; CreateVertexShader(1)=%.3f ms",
        tDev, tSetup, tGetInfo, tCompile, tCreateVS);
    outText = buf;

    if (ctx2) ctx2->Release();
    if (dev2) dev2->Release();
    if (freshCtx) freshCtx->Release();
    if (freshDev) freshDev->Release();
    return true;
#else
    outText = "ProfileStages: 当前后端（OpenGL ES）不支持此诊断";
    return true;
#endif
}
void Live2DHost::DestroyAll()
{
    // 先置 Stopping 语义（禁止新调用进入），再释放资源。
    std::lock_guard<std::mutex> lock(lifecycleMutex_);
    state_.store(HostState::Destroyed);
    paused_ = false;
    model_.reset();              // 释放 Cubism 模型/渲染器/物理/纹理
    devices_.DestroyTargets();   // 释放 RTV/深度/暂存纹理
    devices_.DestroyDevice();    // 释放 Device/Context
}

} // namespace aliya
