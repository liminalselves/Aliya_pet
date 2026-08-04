#include "live2d_device_manager.hpp"
#include "native_log.hpp"

#include <dxgi.h>
#include <wrl/client.h>

using Microsoft::WRL::ComPtr;

namespace aliya {

Live2DDeviceManager::Live2DDeviceManager() = default;

Live2DDeviceManager::~Live2DDeviceManager()
{
    DestroyTargets();
    DestroyD3D11();
}

bool Live2DDeviceManager::CreateD3D11()
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
#if defined(_DEBUG)
    flags |= D3D11_CREATE_DEVICE_DEBUG;
#endif

    D3D_DRIVER_TYPE driverType = D3D_DRIVER_TYPE_HARDWARE;
    hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, flags,
                           levels, ARRAYSIZE(levels), D3D11_SDK_VERSION,
                           &device11_, &createdLevel, &context11_);
    if (FAILED(hr))
    {
        NativeLog::Instance().Warn("CreateD3D11: 硬件设备创建失败 hr=0x%08X，尝试 WARP。", static_cast<unsigned>(hr));
        driverType = D3D_DRIVER_TYPE_WARP;
        hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, flags,
                               levels, ARRAYSIZE(levels), D3D11_SDK_VERSION,
                               &device11_, &createdLevel, &context11_);
        if (FAILED(hr))
        {
            char buf[128];
            snprintf(buf, sizeof(buf), "CreateD3D11: D3D11CreateDevice 失败 hr=0x%08X", static_cast<unsigned>(hr));
            lastError_ = buf;
            NativeLog::Instance().Error("%s", buf);
            return false;
        }
    }

    ComPtr<IDXGIDevice> dxgiDev;
    device11_->QueryInterface(__uuidof(IDXGIDevice), (void**)dxgiDev.GetAddressOf());
    ComPtr<IDXGIAdapter> adapter;
    if (dxgiDev)
        dxgiDev->GetAdapter(&adapter);
    DXGI_ADAPTER_DESC desc = {};
    if (adapter)
        adapter->GetDesc(&desc);
    char descName[256] = {};
    WideCharToMultiByte(CP_UTF8, 0, desc.Description, -1, descName, sizeof(descName), nullptr, nullptr);
    NativeLog::Instance().Info("CreateD3D11: 成功 driverType=%d featureLevel=%u adapter=%s",
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

    NativeLog::Instance().Info("CreateRenderTargets: %dx%d 渲染目标创建成功", widthPx, heightPx);
    return true;
}

bool Live2DDeviceManager::ResizeTargets(int widthPx, int heightPx)
{
    if (widthPx == width_ && heightPx == height_ && renderTarget_)
        return true;
    return CreateRenderTargets(widthPx, heightPx);
}

bool Live2DDeviceManager::CopyFramePixels(unsigned char* dest, int destStride)
{
    if (!context11_ || !renderTarget_ || !staging_ || !dest)
        return false;

    context11_->CopyResource(staging_, renderTarget_);

    D3D11_MAPPED_SUBRESOURCE mapped = {};
    if (FAILED(context11_->Map(staging_, 0, D3D11_MAP_READ, 0, &mapped)))
        return false;

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
}

void Live2DDeviceManager::DestroyD3D11()
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

} // namespace aliya
