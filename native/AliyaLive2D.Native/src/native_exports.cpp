#include "aliya_live2d.h"

#include <mutex>
#include <string>
#include <cstring>
#include <algorithm>
#include <unordered_set>
#if defined(ALIYA_BACKEND_D3D11)
#  include <objbase.h>
#endif

#include "live2d_host.hpp"
#include "live2d_asset_loader.hpp"
#include "native_log.hpp"

// C ABI 导出。所有函数：extern "C" + __declspec(dllexport) + noexcept。
// 所有 C++ 异常在 DLL 内部捕获并转为返回码，不跨 DLL 边界抛出。
#define ALIYA_GUARD_BEGIN try {
#define ALIYA_GUARD_END } catch (const std::exception& ex) { \
        aliya::NativeLog::Instance().Error("native exception: %s", ex.what()); \
        SetGlobalError(ex.what()); \
        return ALIYA_LIVE2D_ERR_INIT_FAILED; \
    } catch (...) { \
        aliya::NativeLog::Instance().Error("native unknown exception"); \
        SetGlobalError("unknown native exception"); \
        return ALIYA_LIVE2D_ERR_INIT_FAILED; \
    }

namespace {

std::mutex g_globalErrorMutex;
std::string g_globalError;

// 活动宿主注册表：保证 Destroy 幂等（重复调用安全）。
std::mutex g_hostMutex;
std::unordered_set<aliya::Live2DHost*> g_liveHosts;

void SetGlobalError(const std::string& message)
{
    std::lock_guard<std::mutex> lock(g_globalErrorMutex);
    g_globalError = message;
}

std::string GetGlobalError()
{
    std::lock_guard<std::mutex> lock(g_globalErrorMutex);
    return g_globalError;
}

aliya::Live2DHost* GetHost(AliyaLive2DHandle handle)
{
    return reinterpret_cast<aliya::Live2DHost*>(handle);
}

int CopyError(aliya::Live2DHost* host, char* buffer, int bufferSize)
{
    std::string error = host ? host->LastError() : GetGlobalError();
    if (!buffer || bufferSize <= 0)
        return static_cast<int>(error.size());
    int n = std::min(static_cast<int>(error.size()), bufferSize - 1);
    if (n > 0)
        memcpy(buffer, error.c_str(), static_cast<size_t>(n));
    buffer[n] = '\0';
    return n;
}

// 自包含 COM 初始化：仅在本次调用真正初始化时才 Uninitialize。
// 仅 D3D11 后端需要（WIC 解码依赖 COM）。
#if defined(ALIYA_BACKEND_D3D11)
struct ComScope {
    bool owned = false;
    ComScope() {
        HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
        owned = (hr == S_OK);
    }
    ~ComScope() {
        if (owned)
            CoUninitialize();
    }
};
#else
struct ComScope {};
#endif

} // namespace

// ---------- 导出实现 ----------

extern "C" {

ALIYA_LIVE2D_API AliyaLive2DHandle AliyaLive2D_Create(void) noexcept
{
    try
    {
        aliya::Live2DHost* host = new aliya::Live2DHost();
        {
            std::lock_guard<std::mutex> lock(g_hostMutex);
            g_liveHosts.insert(host);
        }
        return reinterpret_cast<AliyaLive2DHandle>(host);
    }
    catch (...)
    {
        return nullptr;
    }
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetAssetDirectory(AliyaLive2DHandle handle, const char* utf8Root) noexcept
{
    if (!handle || !utf8Root)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    if (host->GetState() == aliya::HostState::Destroyed)
        return ALIYA_LIVE2D_ERR_NOT_READY;
    host->SetAssetDirectory(std::string(utf8Root));
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_LoadModel(AliyaLive2DHandle handle, const char* utf8ModelJsonPath) noexcept
{
    if (!handle || !utf8ModelJsonPath)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    ComScope com;
    aliya::Live2DHost* host = GetHost(handle);
    if (!host->LoadModel(std::string(utf8ModelJsonPath)))
        return ALIYA_LIVE2D_ERR_LOAD_FAILED;
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_AttachWindow(AliyaLive2DHandle handle, void* hwnd, int widthPx, int heightPx) noexcept
{
    // hwnd 允许为空：渲染全程离屏（parentHwnd_ 仅存储，不参与渲染）。
    if (!handle || widthPx <= 0 || heightPx <= 0)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    ComScope com;
    aliya::Live2DHost* host = GetHost(handle);
    if (!host->AttachWindow(hwnd, widthPx, heightPx))
        return ALIYA_LIVE2D_ERR_DEVICE_FAILED;
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetViewport(AliyaLive2DHandle handle, int widthPx, int heightPx) noexcept
{
    if (!handle || widthPx <= 0 || heightPx <= 0)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    ComScope com;
    aliya::Live2DHost* host = GetHost(handle);
    if (!host->SetViewport(widthPx, heightPx))
        return ALIYA_LIVE2D_ERR_DEVICE_FAILED;
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_Update(AliyaLive2DHandle handle, double deltaSeconds) noexcept
{
    if (!handle)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    host->Update(static_cast<float>(deltaSeconds));
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_Render(AliyaLive2DHandle handle) noexcept
{
    if (!handle)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    if (!host->Render())
        return ALIYA_LIVE2D_ERR_NOT_READY;
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetScale(AliyaLive2DHandle handle, double scale) noexcept
{
    if (!handle)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    host->SetScale(static_cast<float>(scale));
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetOpacity(AliyaLive2DHandle handle, double opacity) noexcept
{
    if (!handle)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    host->SetOpacity(static_cast<float>(opacity));
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetState(AliyaLive2DHandle handle, const char* state, double intensity) noexcept
{
    if (!handle || !state)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    host->SetState(std::string(state), static_cast<float>(intensity));
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_PlayAction(AliyaLive2DHandle handle, const char* action) noexcept
{
    if (!handle || !action)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    host->PlayAction(std::string(action));
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetLookTarget(AliyaLive2DHandle handle, double x, double y) noexcept
{
    if (!handle)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    host->SetLookTarget(static_cast<float>(x), static_cast<float>(y));
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetGazeRawInput(AliyaLive2DHandle handle, double x, double y) noexcept
{
    if (!handle)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    host->SetGazeRawInput(static_cast<float>(x), static_cast<float>(y));
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetGazeHeadRange(AliyaLive2DHandle handle,
    float rangeX, float rangeY, float rangeZ) noexcept
{
    if (!handle)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    host->SetGazeHeadRange(rangeX, rangeY, rangeZ);
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_GetGazeHeadRange(AliyaLive2DHandle handle,
    float* outRangeX, float* outRangeY, float* outRangeZ) noexcept
{
    if (!handle || !outRangeX || !outRangeY || !outRangeZ)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    if (!host->GetGazeHeadRange(outRangeX, outRangeY, outRangeZ))
        return ALIYA_LIVE2D_ERR_NOT_READY;
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetGazeHeadFollowAmount(AliyaLive2DHandle handle, float amount) noexcept
{
    if (!handle)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    host->SetGazeHeadFollowAmount(amount);
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_GetGazeHeadFollowAmount(AliyaLive2DHandle handle,
    float* outCurrent, float* outTarget) noexcept
{
    if (!handle || !outCurrent || !outTarget)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    if (!host->GetGazeHeadFollowAmount(outCurrent, outTarget))
        return ALIYA_LIVE2D_ERR_NOT_READY;
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_GetGazeDiagnostics(AliyaLive2DHandle handle,
    AliyaLive2DGazeDiagnostics* outInfo) noexcept
{
    if (!handle || !outInfo)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    if (!host->GetGazeDiagnostics(outInfo))
        return ALIYA_LIVE2D_ERR_NOT_READY;
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_ClearLookTarget(AliyaLive2DHandle handle) noexcept
{
    if (!handle)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    host->ClearLookTarget();
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetLookAtEnabled(AliyaLive2DHandle handle, int enabled) noexcept
{
    if (!handle)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    host->SetLookAtEnabled(enabled != 0);
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetGazeSpeed(AliyaLive2DHandle handle, double multiplier) noexcept
{
    if (!handle)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    host->SetGazeSpeed(static_cast<float>(multiplier));
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetPhysicsStrength(AliyaLive2DHandle handle, float strength) noexcept
{
    if (!handle)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    if (!host) return ALIYA_LIVE2D_ERR_INVALID_ARG;
    host->SetPhysicsStrength(static_cast<float>(strength));
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}


ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_GetPhysicsStrength(AliyaLive2DHandle handle, float* outCurrent, float* outTarget) noexcept
{
    if (!handle || !outCurrent || !outTarget) return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    if (!host || !host->Ready()) return ALIYA_LIVE2D_ERR_NOT_READY;
    *outCurrent = host->GetPhysicsStrengthCurrent();
    *outTarget = host->GetPhysicsStrengthTarget();
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetMouseIdleTimeout(AliyaLive2DHandle handle, float seconds) noexcept
{
    if (!handle) return ALIYA_LIVE2D_ERR_INVALID_ARG;
    if (!std::isfinite(seconds)) return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    if (!host || !host->Ready()) return ALIYA_LIVE2D_ERR_NOT_READY;
    host->SetMouseIdleTimeout(seconds);
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_GetMouseIdleTimeout(AliyaLive2DHandle handle, float* outSeconds) noexcept
{
    if (!handle || !outSeconds) return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    if (!host || !host->Ready()) return ALIYA_LIVE2D_ERR_NOT_READY;
    *outSeconds = host->GetMouseIdleTimeout();
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_GetMouseIdleElapsed(AliyaLive2DHandle handle, float* outSeconds) noexcept
{
    if (!handle || !outSeconds) return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    if (!host || !host->Ready()) return ALIYA_LIVE2D_ERR_NOT_READY;
    *outSeconds = host->GetMouseIdleElapsed();
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_GetGazeActivityState(AliyaLive2DHandle handle, int* outState) noexcept
{
    if (!handle || !outState) return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    if (!host || !host->Ready()) return ALIYA_LIVE2D_ERR_NOT_READY;
    *outState = host->GetController().GetGazeActivityState();
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetPhysicsInputGain(AliyaLive2DHandle handle, float headGain, float bodyGain) noexcept
{
    if (!handle) return ALIYA_LIVE2D_ERR_INVALID_ARG;
    if (!std::isfinite(headGain) || !std::isfinite(bodyGain)) return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    if (!host || !host->Ready()) return ALIYA_LIVE2D_ERR_NOT_READY;
    host->SetPhysicsInputGain(headGain, bodyGain);
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetPhysicsOutputGain(AliyaLive2DHandle handle, float gain) noexcept
{
    if (!handle) return ALIYA_LIVE2D_ERR_INVALID_ARG;
    if (!std::isfinite(gain)) return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    if (!host || !host->Ready()) return ALIYA_LIVE2D_ERR_NOT_READY;
    host->SetPhysicsOutputGain(gain);
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetPhysicsOutputAmplitude(AliyaLive2DHandle handle, float amplitude) noexcept
{
    if (!handle) return ALIYA_LIVE2D_ERR_INVALID_ARG;
    if (!std::isfinite(amplitude)) return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    if (!host || !host->Ready()) return ALIYA_LIVE2D_ERR_NOT_READY;
    host->SetPhysicsOutputAmplitude(amplitude);
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_GetPhysicsOutputAmplitude(AliyaLive2DHandle handle,
    float* outCurrent, float* outTarget) noexcept
{
    if (!handle || !outCurrent || !outTarget) return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    if (!host || !host->Ready()) return ALIYA_LIVE2D_ERR_NOT_READY;
    *outCurrent = host->GetPhysicsOutputAmplitudeCurrent();
    *outTarget = host->GetPhysicsOutputAmplitudeTarget();
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetPhysicsEnabled(AliyaLive2DHandle handle, int enabled) noexcept
{
    if (!handle) return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    if (!host || !host->Ready()) return ALIYA_LIVE2D_ERR_NOT_READY;
    host->SetPhysicsEnabled(enabled != 0);
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetPhysicsTestInput(AliyaLive2DHandle handle, int enabled,
    float angleX, float angleZ, float bodyAngleX, float bodyAngleZ) noexcept
{
    if (!handle) return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    if (!host || !host->Ready()) return ALIYA_LIVE2D_ERR_NOT_READY;
    host->SetPhysicsTestInput(enabled != 0, angleX, angleZ, bodyAngleX, bodyAngleZ);
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_GetPhysicsGains(AliyaLive2DHandle handle,
    float* outHeadCurrent, float* outHeadTarget, float* outBodyCurrent, float* outBodyTarget,
    float* outOutputCurrent, float* outOutputTarget) noexcept
{
    if (!handle || !outHeadCurrent || !outHeadTarget || !outBodyCurrent || !outBodyTarget ||
        !outOutputCurrent || !outOutputTarget) return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    if (!host || !host->Ready()) return ALIYA_LIVE2D_ERR_NOT_READY;
    *outHeadCurrent = host->GetHeadInputGainCurrent();
    *outHeadTarget = host->GetHeadInputGainTarget();
    *outBodyCurrent = host->GetBodyInputGainCurrent();
    *outBodyTarget = host->GetBodyInputGainTarget();
    *outOutputCurrent = host->GetPhysicsOutputGainCurrent();
    *outOutputTarget = host->GetPhysicsOutputGainTarget();
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_GetPhysicsDriveInfo(AliyaLive2DHandle handle, AliyaLive2DPhysicsDriveInfo* out) noexcept
{
    if (!handle || !out) return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    if (!host || !host->Ready()) return ALIYA_LIVE2D_ERR_NOT_READY;
    return host->GetPhysicsDriveInfo(out) ? ALIYA_LIVE2D_OK : ALIYA_LIVE2D_ERR_NOT_READY;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API int AliyaLive2D_GetApiVersion(void) noexcept
{
    return ALIYA_LIVE2D_API_VERSION; // ABI v8: raw 视线输入 + 头部真实范围映射 + 权重审计/覆盖检测
}
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetGazeIdleTimeout(AliyaLive2DHandle handle, double seconds) noexcept
{
    if (!handle)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    if (!host) return ALIYA_LIVE2D_ERR_INVALID_ARG;
    host->SetGazeIdleTimeout(static_cast<float>(seconds));
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetLipSyncValue(AliyaLive2DHandle handle, double value) noexcept
{
    if (!handle)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    if (!std::isfinite(value))
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    if (!host || host->GetState() == aliya::HostState::Destroyed)
        return ALIYA_LIVE2D_ERR_NOT_READY;
    if (!host->Ready())
        return ALIYA_LIVE2D_ERR_NOT_READY;
    if (!host->LipSyncSupported())
        return ALIYA_LIVE2D_ERR_UNSUPPORTED;
    host->SetLipSyncValue(static_cast<float>(value));
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetMouthOverride(AliyaLive2DHandle handle, int enabled, double openY, double form) noexcept
{
    if (!handle)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    if (!std::isfinite(openY) || !std::isfinite(form))
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    if (!host || host->GetState() == aliya::HostState::Destroyed)
        return ALIYA_LIVE2D_ERR_NOT_READY;
    if (!host->Ready())
        return ALIYA_LIVE2D_ERR_NOT_READY;
    host->SetMouthOverride(enabled != 0, static_cast<float>(openY), static_cast<float>(form));
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_GetMouthParamInfo(AliyaLive2DHandle handle, AliyaLive2DMouthParamInfo* outInfo) noexcept
{
    if (!handle || !outInfo)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    if (!host || host->GetState() == aliya::HostState::Destroyed)
        return ALIYA_LIVE2D_ERR_NOT_READY;
    if (!host->Ready())
        return ALIYA_LIVE2D_ERR_NOT_READY;
    if (!host->MouthParamInfo(outInfo))
        return ALIYA_LIVE2D_ERR_NOT_READY;
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetInteractionOffsets(AliyaLive2DHandle handle,
    double angleX, double angleY, double angleZ, double bodyAngleX) noexcept
{
    if (!handle)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    if (!std::isfinite(angleX) || !std::isfinite(angleY) || !std::isfinite(angleZ) || !std::isfinite(bodyAngleX))
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    if (!host || host->GetState() == aliya::HostState::Destroyed)
        return ALIYA_LIVE2D_ERR_NOT_READY;
    if (!host->Ready())
        return ALIYA_LIVE2D_ERR_NOT_READY;
    host->SetInteractionOffsets(static_cast<float>(angleX), static_cast<float>(angleY),
                                static_cast<float>(angleZ), static_cast<float>(bodyAngleX));
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetEyeOverride(AliyaLive2DHandle handle,
    int enabled, double leftOpen, double rightOpen) noexcept
{
    if (!handle)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    if (!std::isfinite(leftOpen) || !std::isfinite(rightOpen))
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    if (!host || host->GetState() == aliya::HostState::Destroyed)
        return ALIYA_LIVE2D_ERR_NOT_READY;
    if (!host->Ready())
        return ALIYA_LIVE2D_ERR_NOT_READY;
    host->SetEyeOverride(enabled != 0, static_cast<float>(leftOpen), static_cast<float>(rightOpen));
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetEarInteraction(AliyaLive2DHandle handle,
    int enabled, double leftValue, double rightValue) noexcept
{
    if (!handle)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    if (!std::isfinite(leftValue) || !std::isfinite(rightValue))
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    if (!host || host->GetState() == aliya::HostState::Destroyed)
        return ALIYA_LIVE2D_ERR_NOT_READY;
    if (!host->Ready())
        return ALIYA_LIVE2D_ERR_NOT_READY;
    host->SetEarInteraction(enabled != 0, static_cast<float>(leftValue), static_cast<float>(rightValue));
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetPettingLookAtReduction(AliyaLive2DHandle handle, int enabled) noexcept
{
    if (!handle)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    if (!host || host->GetState() == aliya::HostState::Destroyed)
        return ALIYA_LIVE2D_ERR_NOT_READY;
    if (!host->Ready())
        return ALIYA_LIVE2D_ERR_NOT_READY;
    host->SetPettingLookAtReduction(enabled != 0);
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_GetInteractionParamInfo(AliyaLive2DHandle handle,
    AliyaLive2DInteractionParamInfo* outInfo) noexcept
{
    if (!handle || !outInfo)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    if (!host || host->GetState() == aliya::HostState::Destroyed)
        return ALIYA_LIVE2D_ERR_NOT_READY;
    if (!host->Ready())
        return ALIYA_LIVE2D_ERR_NOT_READY;
    if (!host->InteractionParamInfo(outInfo))
        return ALIYA_LIVE2D_ERR_NOT_READY;
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_ListEarParams(AliyaLive2DHandle handle, char* out, int outSize) noexcept
{
    if (!handle || !out || outSize <= 0)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    if (!host || host->GetState() == aliya::HostState::Destroyed)
        return ALIYA_LIVE2D_ERR_NOT_READY;
    if (!host->Ready())
        return ALIYA_LIVE2D_ERR_NOT_READY;
    if (!host->ListEarParams(out, outSize))
        return ALIYA_LIVE2D_ERR_NOT_READY;
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_GetParameterValue(AliyaLive2DHandle handle, const char* id, double* outValue) noexcept
{
    if (!handle || !id || !outValue)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    float v = 0.0f;
    if (!host->GetParameterValue(id, v))
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    *outValue = static_cast<double>(v);
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_SetParameterValue(AliyaLive2DHandle handle, const char* id, double value) noexcept
{
    if (!handle || !id)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    if (!host->SetParameterValue(id, static_cast<float>(value)))
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_ForceBlink(AliyaLive2DHandle handle) noexcept
{
    if (!handle)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    host->ForceBlink();
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_GetBlinkInfo(AliyaLive2DHandle handle, AliyaLive2DBlinkInfo* outInfo) noexcept
{
    if (!handle || !outInfo)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    return host->GetBlinkInfo(outInfo) ? ALIYA_LIVE2D_OK : ALIYA_LIVE2D_ERR_NOT_READY;
    ALIYA_GUARD_END
}
ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_HitTest(AliyaLive2DHandle handle, double x, double y) noexcept
{
    if (!handle)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    return host->HitTest(static_cast<float>(x), static_cast<float>(y)) ? 1 : 0;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_Pause(AliyaLive2DHandle handle) noexcept
{
    if (!handle)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    host->Pause();
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_Resume(AliyaLive2DHandle handle) noexcept
{
    if (!handle)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    host->Resume();
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_ListActions(AliyaLive2DHandle handle, char* out, int outSize) noexcept
{
    if (!handle || !out || outSize <= 0)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    if (!host->ListActions(out, outSize))
        return ALIYA_LIVE2D_ERR_NOT_READY;
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_GetActionInfo(AliyaLive2DHandle handle, AliyaLive2DActionInfo* outInfo) noexcept
{
    if (!handle || !outInfo)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    return host->GetActionInfo(outInfo) ? ALIYA_LIVE2D_OK : ALIYA_LIVE2D_ERR_NOT_READY;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_PollActionEvents(AliyaLive2DHandle handle, char* out, int outSize) noexcept
{
    if (!handle || !out || outSize <= 0)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    if (!host->PollActionEvents(out, outSize))
        return ALIYA_LIVE2D_ERR_NOT_READY;
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_GetInfo(AliyaLive2DHandle handle, AliyaLive2DModelInfo* outInfo) noexcept
{
    if (!handle || !outInfo)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    return host->GetInfo(outInfo) ? ALIYA_LIVE2D_OK : ALIYA_LIVE2D_ERR_NOT_READY;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_GetModelTargetSize(AliyaLive2DHandle handle, double* outW, double* outH) noexcept
{
    if (!handle || !outW || !outH)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    float w = 0.0f, h = 0.0f;
    if (!host->GetModelTargetSize(w, h))
        return ALIYA_LIVE2D_ERR_NOT_READY;
    *outW = w;
    *outH = h;
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_CopyFramePixels(AliyaLive2DHandle handle, unsigned char* dest, int destStride) noexcept
{
    if (!handle || !dest || destStride <= 0)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    return host->CopyFramePixels(dest, destStride) ? ALIYA_LIVE2D_OK : ALIYA_LIVE2D_ERR_NOT_READY;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_UploadTexture(AliyaLive2DHandle handle, int textureIndex, int widthPx, int heightPx, const unsigned char* rgba) noexcept
{
    if (!handle || !rgba || textureIndex < 0 || widthPx <= 0 || heightPx <= 0)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    return host->UploadTexture(textureIndex, widthPx, heightPx, rgba) ? ALIYA_LIVE2D_OK : ALIYA_LIVE2D_ERR_MODEL_FAILED;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_ProfileStages(AliyaLive2DHandle handle, char* out, int outSize) noexcept
{
    if (!handle || !out || outSize <= 0)
        return ALIYA_LIVE2D_ERR_INVALID_ARG;
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    if (host->GetState() == aliya::HostState::Destroyed)
        return ALIYA_LIVE2D_ERR_NOT_READY;
    std::string text;
    if (!host->ProfileStages(text))
        return ALIYA_LIVE2D_ERR_NOT_READY;
    int n = std::min(static_cast<int>(text.size()), outSize - 1);
    memcpy(out, text.c_str(), static_cast<size_t>(n));
    out[n] = 0;
    ALIYA_GUARD_END
    return ALIYA_LIVE2D_OK;
}

ALIYA_LIVE2D_API void* AliyaLive2D_GetBackBufferSurface(AliyaLive2DHandle handle) noexcept
{
    (void)handle;
    return nullptr;
}

ALIYA_LIVE2D_API AliyaLive2DResult AliyaLive2D_GetLastError(AliyaLive2DHandle handle, char* buffer, int bufferSize) noexcept
{
    ALIYA_GUARD_BEGIN
    aliya::Live2DHost* host = GetHost(handle);
    CopyError(host, buffer, bufferSize);
    // 查询类接口：无论是否有错误文本都返回 OK（CopyError 的返回值为写入字节数，非错误码）
    return ALIYA_LIVE2D_OK;
    ALIYA_GUARD_END
}

ALIYA_LIVE2D_API void AliyaLive2D_Destroy(AliyaLive2DHandle handle) noexcept
{
    if (!handle)
        return;
    try
    {
        aliya::Live2DHost* host = GetHost(handle);
        std::lock_guard<std::mutex> lock(g_hostMutex);
        auto it = g_liveHosts.find(host);
        if (it == g_liveHosts.end())
            return; // 已销毁，幂等
        g_liveHosts.erase(it);
        delete host;
    }
    catch (...)
    {
        aliya::NativeLog::Instance().Error("AliyaLive2D_Destroy exception");
    }

} // AliyaLive2D_Destroy

} // extern "C"




