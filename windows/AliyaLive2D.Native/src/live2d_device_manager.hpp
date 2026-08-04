#pragma once

#include <windows.h>
#include <d3d11.h>
#include <string>

namespace aliya {

// 管理 D3D11 设备、离屏渲染目标与 CPU 读回（供托管层 WriteableBitmap 呈现）。
// 不依赖 D3D9，因此可在无 D3D9 硬件支持的环境（远程会话/WARP）运行。
class Live2DDeviceManager {
public:
    Live2DDeviceManager();
    ~Live2DDeviceManager();

    // 创建 D3D11 设备与上下文（可重入）。
    bool CreateD3D11();

    // 创建离屏渲染目标 / 深度缓冲 / 暂存纹理。尺寸为物理像素。
    bool CreateRenderTargets(int widthPx, int heightPx);

    // 尺寸变化时重建渲染目标。
    bool ResizeTargets(int widthPx, int heightPx);

    // 将当前渲染结果复制到调用方缓冲区（BGRA，预乘 alpha）。
    // dest 指向大小为 heightPx * destStride 的缓冲区。
    bool CopyFramePixels(unsigned char* dest, int destStride);

    void DestroyTargets();
    void DestroyD3D11();

    ID3D11Device* Device11() const { return device11_; }
    ID3D11DeviceContext* Context11() const { return context11_; }
    ID3D11RenderTargetView* RTV() const { return rtv_; }
    ID3D11DepthStencilView* DepthDSV() const { return depthDSV_; }
    int Width() const { return width_; }
    int Height() const { return height_; }
    bool TargetValid() const { return renderTarget_ != nullptr; }

    const std::string& LastError() const { return lastError_; }

private:
    ID3D11Device* device11_ = nullptr;
    ID3D11DeviceContext* context11_ = nullptr;
    ID3D11Texture2D* renderTarget_ = nullptr;
    ID3D11RenderTargetView* rtv_ = nullptr;
    ID3D11Texture2D* depthTexture_ = nullptr;
    ID3D11DepthStencilView* depthDSV_ = nullptr;
    ID3D11Texture2D* staging_ = nullptr;

    int width_ = 0;
    int height_ = 0;
    std::string lastError_;
};

} // namespace aliya
