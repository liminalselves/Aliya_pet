#include "live2d_device_manager.hpp"
#include "native_log.hpp"

#include <cstring>
#include <vector>

#if defined(ALIYA_BACKEND_D3D11)
#  include <dxgi.h>
#  include <wrl/client.h>
#elif defined(ALIYA_BACKEND_OPENGLES)
#  include <EGL/egl.h>
#  include <EGL/eglext.h>

namespace {
// 进程级共享 EGL display/context/surface：Framework 的 CubismShader_OpenGLES2 是进程单例，
// shader program 创建在首个 context 上；GL 对象按 context 隔离，多 Host（主界面+悬浮窗）
// 必须共享同一 EGL context，否则第二个引擎拿到的 shader ID 无效，绘制静默失败（输出全透明）。
void* g_sharedEglDisplay = nullptr;
void* g_sharedEglContext = nullptr;
void* g_sharedEglSurface = nullptr;
int g_sharedEglRefCount = 0;
} // namespace
#endif

namespace aliya {

Live2DDeviceManager::Live2DDeviceManager() = default;

Live2DDeviceManager::~Live2DDeviceManager()
{
    DestroyTargets();
    DestroyDevice();
}

bool Live2DDeviceManager::ResizeTargets(int widthPx, int heightPx)
{
    if (widthPx == width_ && heightPx == height_ && targetValid_)
        return true;
    return CreateRenderTargets(widthPx, heightPx);
}

#if defined(ALIYA_BACKEND_D3D11)

bool Live2DDeviceManager::CreateDevice()
{
    if (device11_)
        return true;

    HRESULT hr = S_OK;
    D3D_FEATURE_LEVEL levels[] = {
        D3D_FEATURE_LEVEL_11_1,
        D3D_FEATURE_LEVEL_11_0,
        D3D_FEATURE_LEVEL_10_1,
        D3D_FEATURE_LEVEL_10_0,
    };
    D3D_FEATURE_LEVEL createdLevel = D3D_FEATURE_LEVEL_11_0;

    UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
    // 不使用 D3D11_CREATE_DEVICE_DEBUG：debug 配置下与 Flutter 引擎共存时
    // AMD 驱动可能返回 DXGI_ERROR_NOT_CURRENTLY_AVAILABLE（0x887A002D）。

    D3D_DRIVER_TYPE driverType = D3D_DRIVER_TYPE_HARDWARE;
    hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, flags,
                           levels, ARRAYSIZE(levels), D3D11_SDK_VERSION,
                           &device11_, &createdLevel, &context11_);
    if (FAILED(hr))
    {
        NativeLog::Instance().Warn("CreateDevice: 硬件设备创建失败 hr=0x%08X，尝试 WARP。", static_cast<unsigned>(hr));
        driverType = D3D_DRIVER_TYPE_WARP;
        hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, flags,
                               levels, ARRAYSIZE(levels), D3D11_SDK_VERSION,
                               &device11_, &createdLevel, &context11_);
        if (FAILED(hr))
        {
            char buf[128];
            snprintf(buf, sizeof(buf), "CreateDevice: D3D11CreateDevice 失败 hr=0x%08X", static_cast<unsigned>(hr));
            lastError_ = buf;
            NativeLog::Instance().Error("%s", buf);
            return false;
        }
    }

    Microsoft::WRL::ComPtr<IDXGIDevice> dxgiDev;
    device11_->QueryInterface(__uuidof(IDXGIDevice), (void**)dxgiDev.GetAddressOf());
    Microsoft::WRL::ComPtr<IDXGIAdapter> adapter;
    if (dxgiDev)
        dxgiDev->GetAdapter(&adapter);
    DXGI_ADAPTER_DESC desc = {};
    if (adapter)
        adapter->GetDesc(&desc);
    char descName[256] = {};
    WideCharToMultiByte(CP_UTF8, 0, desc.Description, -1, descName, sizeof(descName), nullptr, nullptr);
    NativeLog::Instance().Info("CreateDevice: 成功 driverType=%d featureLevel=%u adapter=%s",
                               static_cast<int>(driverType), static_cast<unsigned>(createdLevel), descName);
    return true;
}

bool Live2DDeviceManager::CreateRenderTargets(int widthPx, int heightPx)
{
    if (!device11_ || !context11_)
    {
        lastError_ = "CreateRenderTargets: 设备未就绪";
        NativeLog::Instance().Error("%s", lastError_.c_str());
        return false;
    }
    if (widthPx <= 0 || heightPx <= 0)
    {
        lastError_ = "CreateRenderTargets: 无效尺寸";
        return false;
    }

    DestroyTargets();
    width_ = widthPx;
    height_ = heightPx;

    HRESULT hr = S_OK;

    D3D11_TEXTURE2D_DESC desc = {};
    desc.Width = static_cast<UINT>(widthPx);
    desc.Height = static_cast<UINT>(heightPx);
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;

    hr = device11_->CreateTexture2D(&desc, nullptr, &renderTarget_);
    if (FAILED(hr))
    {
        char buf[256];
        snprintf(buf, sizeof(buf), "CreateRenderTargets: 创建渲染目标失败 hr=0x%08X", static_cast<unsigned>(hr));
        lastError_ = buf;
        NativeLog::Instance().Error("%s", buf);
        return false;
    }

    hr = device11_->CreateRenderTargetView(renderTarget_, nullptr, &rtv_);
    if (FAILED(hr))
    {
        lastError_ = "CreateRenderTargets: CreateRenderTargetView 失败";
        NativeLog::Instance().Error("%s hr=0x%08X", lastError_.c_str(), static_cast<unsigned>(hr));
        return false;
    }

    D3D11_TEXTURE2D_DESC depthDesc = {};
    depthDesc.Width = static_cast<UINT>(widthPx);
    depthDesc.Height = static_cast<UINT>(heightPx);
    depthDesc.MipLevels = 1;
    depthDesc.ArraySize = 1;
    depthDesc.Format = DXGI_FORMAT_D24_UNORM_S8_UINT;
    depthDesc.SampleDesc.Count = 1;
    depthDesc.Usage = D3D11_USAGE_DEFAULT;
    depthDesc.BindFlags = D3D11_BIND_DEPTH_STENCIL;

    hr = device11_->CreateTexture2D(&depthDesc, nullptr, &depthTexture_);
    if (FAILED(hr))
    {
        lastError_ = "CreateRenderTargets: 创建深度纹理失败";
        NativeLog::Instance().Error("%s hr=0x%08X", lastError_.c_str(), static_cast<unsigned>(hr));
        return false;
    }

    D3D11_DEPTH_STENCIL_VIEW_DESC dsvDesc = {};
    dsvDesc.Format = depthDesc.Format;
    dsvDesc.ViewDimension = D3D11_DSV_DIMENSION_TEXTURE2D;
    dsvDesc.Texture2D.MipSlice = 0;
    hr = device11_->CreateDepthStencilView(depthTexture_, &dsvDesc, &depthDSV_);
    if (FAILED(hr))
    {
        lastError_ = "CreateRenderTargets: CreateDepthStencilView 失败";
        NativeLog::Instance().Error("%s hr=0x%08X", lastError_.c_str(), static_cast<unsigned>(hr));
        return false;
    }

    // 暂存纹理（CPU 读回）
    D3D11_TEXTURE2D_DESC stagingDesc = {};
    stagingDesc.Width = static_cast<UINT>(widthPx);
    stagingDesc.Height = static_cast<UINT>(heightPx);
    stagingDesc.MipLevels = 1;
    stagingDesc.ArraySize = 1;
    stagingDesc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    stagingDesc.SampleDesc.Count = 1;
    stagingDesc.Usage = D3D11_USAGE_STAGING;
    stagingDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;

    hr = device11_->CreateTexture2D(&stagingDesc, nullptr, &staging_);
    if (FAILED(hr))
    {
        lastError_ = "CreateRenderTargets: 创建暂存纹理失败";
        NativeLog::Instance().Error("%s hr=0x%08X", lastError_.c_str(), static_cast<unsigned>(hr));
        return false;
    }

    targetValid_ = true;
    NativeLog::Instance().Info("CreateRenderTargets: %dx%d 渲染目标创建成功", widthPx, heightPx);
    return true;
}

bool Live2DDeviceManager::CopyFramePixels(unsigned char* dest, int destStride)
{
    if (!context11_ || !renderTarget_ || !staging_ || !dest)
    {
        NativeLog::Instance().Error("CopyFramePixels: 资源为空 ctx=%d rt=%d st=%d dest=%d",
            context11_ != nullptr, renderTarget_ != nullptr, staging_ != nullptr, dest != nullptr);
        return false;
    }

    context11_->CopyResource(staging_, renderTarget_);

    D3D11_MAPPED_SUBRESOURCE mapped = {};
    if (FAILED(context11_->Map(staging_, 0, D3D11_MAP_READ, 0, &mapped)))
    {
        NativeLog::Instance().Error("CopyFramePixels: Map 失败 reason=0x%08X", static_cast<unsigned>(device11_->GetDeviceRemovedReason()));
        return false;
    }

    const unsigned char* src = static_cast<const unsigned char*>(mapped.pData);
    int rowBytes = width_ * 4;
    if (destStride == mapped.RowPitch)
    {
        memcpy(dest, src, static_cast<size_t>(height_) * static_cast<size_t>(rowBytes));
    }
    else
    {
        for (int y = 0; y < height_; y++)
            memcpy(dest + static_cast<size_t>(y) * static_cast<size_t>(destStride),
                   src + static_cast<size_t>(y) * static_cast<size_t>(mapped.RowPitch),
                   static_cast<size_t>(rowBytes));
    }

    context11_->Unmap(staging_, 0);
    return true;
}

void Live2DDeviceManager::DestroyTargets()
{
    if (staging_)
    {
        staging_->Release();
        staging_ = nullptr;
    }
    if (depthDSV_)
    {
        depthDSV_->Release();
        depthDSV_ = nullptr;
    }
    if (depthTexture_)
    {
        depthTexture_->Release();
        depthTexture_ = nullptr;
    }
    if (rtv_)
    {
        rtv_->Release();
        rtv_ = nullptr;
    }
    if (renderTarget_)
    {
        renderTarget_->Release();
        renderTarget_ = nullptr;
    }
    width_ = 0;
    height_ = 0;
    targetValid_ = false;
}

void Live2DDeviceManager::DestroyDevice()
{
    if (context11_)
    {
        context11_->Release();
        context11_ = nullptr;
    }
    if (device11_)
    {
        device11_->Release();
        device11_ = nullptr;
    }
}

#elif defined(ALIYA_BACKEND_OPENGLES)

namespace {

// EGL 查询错误并记录（返回 false 表示失败）
bool LogEglError(const char* tag, EGLDisplay dpy)
{
    EGLint err = eglGetError();
    char buf[256];
    snprintf(buf, sizeof(buf), "%s: EGL error 0x%X", tag, static_cast<unsigned>(err));
    NativeLog::Instance().Error("%s", buf);
    return false;
}

} // namespace

bool Live2DDeviceManager::CreateDevice()
{
    if (eglDisplay_)
        return true;

    // 复用进程级共享 EGL context（Framework shader 单例依赖同一 context）
    if (g_sharedEglRefCount > 0 && g_sharedEglDisplay && g_sharedEglContext && g_sharedEglSurface)
    {
        eglDisplay_ = g_sharedEglDisplay;
        eglContext_ = g_sharedEglContext;
        eglSurface_ = g_sharedEglSurface;
        ++g_sharedEglRefCount;
        return true;
    }

    EGLDisplay dpy = eglGetDisplay(EGL_DEFAULT_DISPLAY);
    if (dpy == EGL_NO_DISPLAY)
        return LogEglError("CreateDevice: eglGetDisplay", dpy);

    if (!eglInitialize(dpy, nullptr, nullptr))
        return LogEglError("CreateDevice: eglInitialize", dpy);

    // 选择 RGBA8 + 深度 24 的离屏配置
    const EGLint configAttribs[] = {
        EGL_SURFACE_TYPE, EGL_PBUFFER_BIT,
        EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
        EGL_RED_SIZE, 8,
        EGL_GREEN_SIZE, 8,
        EGL_BLUE_SIZE, 8,
        EGL_ALPHA_SIZE, 8,
        EGL_DEPTH_SIZE, 24,
        EGL_NONE
    };
    EGLConfig config = nullptr;
    EGLint numConfigs = 0;
    if (!eglChooseConfig(dpy, configAttribs, &config, 1, &numConfigs) || numConfigs < 1)
        return LogEglError("CreateDevice: eglChooseConfig", dpy);

    const EGLint contextAttribs[] = {
        EGL_CONTEXT_CLIENT_VERSION, 2,
        EGL_NONE
    };
    EGLContext ctx = eglCreateContext(dpy, config, EGL_NO_CONTEXT, contextAttribs);
    if (ctx == EGL_NO_CONTEXT)
        return LogEglError("CreateDevice: eglCreateContext", dpy);

    // PBuffer 离屏 surface（1x1 占位，实际渲染目标用 FBO）
    const EGLint pbufferAttribs[] = {
        EGL_WIDTH, 1,
        EGL_HEIGHT, 1,
        EGL_NONE
    };
    EGLSurface surface = eglCreatePbufferSurface(dpy, config, pbufferAttribs);
    if (surface == EGL_NO_SURFACE)
    {
        eglDestroyContext(dpy, ctx);
        return LogEglError("CreateDevice: eglCreatePbufferSurface", dpy);
    }

    if (!eglMakeCurrent(dpy, surface, surface, ctx))
    {
        eglDestroySurface(dpy, surface);
        eglDestroyContext(dpy, ctx);
        return LogEglError("CreateDevice: eglMakeCurrent", dpy);
    }

    eglDisplay_ = dpy;
    eglContext_ = ctx;
    eglSurface_ = surface;
    g_sharedEglDisplay = dpy;
    g_sharedEglContext = ctx;
    g_sharedEglSurface = surface;
    g_sharedEglRefCount = 1;

    NativeLog::Instance().Info("CreateDevice: EGL 初始化成功");
    return true;
}

bool Live2DDeviceManager::CreateRenderTargets(int widthPx, int heightPx)
{
    if (!eglDisplay_ || !eglContext_)
    {
        lastError_ = "CreateRenderTargets: 设备未就绪";
        NativeLog::Instance().Error("%s", lastError_.c_str());
        return false;
    }
    if (widthPx <= 0 || heightPx <= 0)
    {
        lastError_ = "CreateRenderTargets: 无效尺寸";
        return false;
    }

    DestroyTargets();
    width_ = widthPx;
    height_ = heightPx;

    // 颜色纹理（RGBA8）
    glGenTextures(1, &colorTex_);
    glBindTexture(GL_TEXTURE_2D, colorTex_);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, width_, height_, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    glBindTexture(GL_TEXTURE_2D, 0);

    // 深度 renderbuffer（GLES2 核心仅保证 16 位深度，2D 渲染足够）
    glGenRenderbuffers(1, &depthRbo_);
    glBindRenderbuffer(GL_RENDERBUFFER, depthRbo_);
    glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH_COMPONENT16, width_, height_);
    glBindRenderbuffer(GL_RENDERBUFFER, 0);

    // FBO
    glGenFramebuffers(1, &fbo_);
    glBindFramebuffer(GL_FRAMEBUFFER, fbo_);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, colorTex_, 0);
    glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, depthRbo_);
    GLenum fboStatus = glCheckFramebufferStatus(GL_FRAMEBUFFER);
    glBindFramebuffer(GL_FRAMEBUFFER, 0);

    if (fboStatus != GL_FRAMEBUFFER_COMPLETE)
    {
        char buf[256];
        snprintf(buf, sizeof(buf), "CreateRenderTargets: FBO 不完整 status=0x%X", static_cast<unsigned>(fboStatus));
        lastError_ = buf;
        NativeLog::Instance().Error("%s", buf);
        DestroyTargets();
        return false;
    }

    targetValid_ = true;
    NativeLog::Instance().Info("CreateRenderTargets: %dx%d FBO 创建成功", widthPx, heightPx);
    return true;
}

bool Live2DDeviceManager::EnsureGLContext()
{
    if (!eglDisplay_ || !eglContext_ || !eglSurface_)
        return false;
    EGLDisplay dpy = static_cast<EGLDisplay>(eglDisplay_);
    EGLContext ctx = static_cast<EGLContext>(eglContext_);
    EGLSurface surface = static_cast<EGLSurface>(eglSurface_);
    // 仅当当前线程的当前上下文不是我们的上下文时才重新绑定
    if (eglGetCurrentContext() != ctx)
    {
        if (!eglMakeCurrent(dpy, surface, surface, ctx))
            return false;
    }
    return true;
}

bool Live2DDeviceManager::BindFrameBuffer()
{
    if (!targetValid_)
        return false;
    if (!EnsureGLContext())
        return false;
    glBindFramebuffer(GL_FRAMEBUFFER, fbo_);
    glViewport(0, 0, width_, height_);
    return true;
}

void Live2DDeviceManager::UnbindFrameBuffer()
{
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    // 确保 CPU 读回前渲染完成
    glFinish();
}

bool Live2DDeviceManager::CopyFramePixels(unsigned char* dest, int destStride)
{
    if (!targetValid_ || !dest)
        return false;
    if (!EnsureGLContext())
        return false;

    // GL 原点在左下，读回后垂直翻转使顶行在前（与 D3D11 输出一致）。
    std::vector<unsigned char> raw(static_cast<size_t>(width_) * height_ * 4);
    glBindFramebuffer(GL_FRAMEBUFFER, fbo_);
    glPixelStorei(GL_PACK_ALIGNMENT, 1);
    glReadPixels(0, 0, width_, height_, GL_RGBA, GL_UNSIGNED_BYTE, raw.data());
    glBindFramebuffer(GL_FRAMEBUFFER, 0);

    int rowBytes = width_ * 4;
    for (int y = 0; y < height_; y++)
    {
        int srcY = height_ - 1 - y;
        memcpy(dest + static_cast<size_t>(y) * static_cast<size_t>(destStride),
               raw.data() + static_cast<size_t>(srcY) * static_cast<size_t>(rowBytes),
               static_cast<size_t>(rowBytes));
    }
    return true;
}

void Live2DDeviceManager::DestroyTargets()
{
    if (targetValid_ || fbo_ != 0 || colorTex_ != 0 || depthRbo_ != 0)
    {
        glDeleteFramebuffers(1, &fbo_);
        glDeleteTextures(1, &colorTex_);
        glDeleteRenderbuffers(1, &depthRbo_);
        fbo_ = 0;
        colorTex_ = 0;
        depthRbo_ = 0;
    }
    width_ = 0;
    height_ = 0;
    targetValid_ = false;
}

void Live2DDeviceManager::DestroyDevice()
{
    DestroyTargets();

    if (eglDisplay_ && --g_sharedEglRefCount <= 0)
    {
        // 最后一个 Host 实例销毁时才释放共享 EGL 资源
        EGLDisplay dpy = static_cast<EGLDisplay>(eglDisplay_);
        if (eglContext_ && eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT))
        {
            if (eglSurface_)
                eglDestroySurface(dpy, static_cast<EGLSurface>(eglSurface_));
            eglDestroyContext(dpy, static_cast<EGLContext>(eglContext_));
        }
        eglTerminate(dpy);
        g_sharedEglDisplay = nullptr;
        g_sharedEglContext = nullptr;
        g_sharedEglSurface = nullptr;
        g_sharedEglRefCount = 0;
    }
    eglDisplay_ = nullptr;
    eglContext_ = nullptr;
    eglSurface_ = nullptr;
}

#endif

} // namespace aliya
