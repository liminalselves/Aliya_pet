#pragma once

#include <mutex>
#include <string>

#include "render_backend.h"

namespace aliya {

// 双引擎并发场景（Android 主界面 + 悬浮窗各持一个 Host）下，两个线程会同时操作
// 进程级共享的 EGL display：eglMakeCurrent 并发在部分 Adreno 驱动上死锁。
// 所有 GL 操作入口（Render/CopyFramePixels/UploadTexture/BindTextures）必须串行化。
inline std::mutex& GlMutex()
{
    static std::mutex m;
    return m;
}

// 管理渲染设备、离屏渲染目标与 CPU 读回（供上层呈现帧像素）。
// 双后端实现：D3D11（Windows，BGRA 输出）/ OpenGL ES（Android，RGBA 输出）。
class Live2DDeviceManager {
public:
    Live2DDeviceManager();
    ~Live2DDeviceManager();

    // 创建渲染设备（可重入）。GLES 后端同时初始化 EGL 并绑定当前上下文。
    bool CreateDevice();

    // 创建离屏渲染目标 / 深度缓冲 / 暂存纹理。尺寸为物理像素。
    bool CreateRenderTargets(int widthPx, int heightPx);

    // 尺寸变化时重建渲染目标。
    bool ResizeTargets(int widthPx, int heightPx);

    // 将当前渲染结果复制到调用方缓冲区。
    // 像素格式：D3D11 为 BGRA 预乘 alpha；GLES 为 RGBA 直通，已做垂直翻转（顶行在前）。
    // dest 指向大小为 heightPx * destStride 的缓冲区。
    bool CopyFramePixels(unsigned char* dest, int destStride);

    void DestroyTargets();
    void DestroyDevice();

#if defined(ALIYA_BACKEND_D3D11)
    ID3D11Device* Device11() const { return device11_; }
    ID3D11DeviceContext* Context11() const { return context11_; }
    ID3D11RenderTargetView* RTV() const { return rtv_; }
    ID3D11DepthStencilView* DepthDSV() const { return depthDSV_; }
#elif defined(ALIYA_BACKEND_OPENGLES)
    // 将 FBO 绑定为当前渲染目标（Render 前调用）。
    bool BindFrameBuffer();
    // 解除 FBO 绑定（Render 后调用）。
    void UnbindFrameBuffer();
    // 确保 EGL 上下文为当前线程的当前上下文（Android 上其他组件可能切换）。
    bool EnsureGLContext();
#endif

    int Width() const { return width_; }
    int Height() const { return height_; }
    bool TargetValid() const { return targetValid_; }

    const std::string& LastError() const { return lastError_; }

private:
#if defined(ALIYA_BACKEND_D3D11)
    ID3D11Device* device11_ = nullptr;
    ID3D11DeviceContext* context11_ = nullptr;
    ID3D11Texture2D* renderTarget_ = nullptr;
    ID3D11RenderTargetView* rtv_ = nullptr;
    ID3D11Texture2D* depthTexture_ = nullptr;
    ID3D11DepthStencilView* depthDSV_ = nullptr;
    ID3D11Texture2D* staging_ = nullptr;
#elif defined(ALIYA_BACKEND_OPENGLES)
    void* eglDisplay_ = nullptr;    // EGLDisplay
    void* eglContext_ = nullptr;    // EGLContext
    void* eglSurface_ = nullptr;    // EGLSurface (PBuffer)
    unsigned int fbo_ = 0;          // GLuint
    unsigned int colorTex_ = 0;     // GLuint
    unsigned int depthRbo_ = 0;     // GLuint
#endif

    int width_ = 0;
    int height_ = 0;
    bool targetValid_ = false;
    std::string lastError_;
};

} // namespace aliya
