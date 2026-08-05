#include "live2d_model.hpp"
#include "live2d_asset_loader.hpp"
#include "native_log.hpp"

#include <windows.h>
#include <wincodec.h>
#include <wrl/client.h>
#include <cmath>
#include <cstdlib>

#include "CubismModelSettingJson.hpp"
#include "Physics/CubismPhysics.hpp"
#include "Physics/CubismPhysicsJson.hpp"
#include "Model/CubismMoc.hpp"
#include "Rendering/D3D11/CubismRenderer_D3D11.hpp"
#include "Rendering/D3D11/CubismRenderTarget_D3D11.hpp"
#include "Rendering/D3D11/CubismDeviceInfo_D3D11.hpp"
#include "Math/CubismMatrix44.hpp"
#include "Id/CubismIdManager.hpp"

using namespace Live2D::Cubism::Framework;
using namespace Live2D::Cubism::Framework::Rendering;
using Microsoft::WRL::ComPtr;

namespace aliya {

Live2DModel::Live2DModel(ID3D11Device* device, ID3D11DeviceContext* context)
    : device_(device), context_(context)
{
}

Live2DModel::~Live2DModel()
{
    for (auto* srv : textureSrvs_)
    {
        if (srv)
            srv->Release();
    }
    textureSrvs_.clear();

    if (userModel_)
        delete userModel_;
    if (modelSetting_)
        delete modelSetting_;
}

bool Live2DModel::CreateTextureFromPng(const std::string& utf8Path, ID3D11ShaderResourceView** outSrv,
                                       unsigned int* outWidth, unsigned int* outHeight)
{
    std::vector<char> bytes;
    if (!ReadFileToBytes(utf8Path, bytes))
        return false;

    ComPtr<IWICImagingFactory> wicFactory;
    HRESULT hr = CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
                                  IID_PPV_ARGS(&wicFactory));
    if (FAILED(hr))
    {
        NativeLog::Instance().Error("CreateTextureFromPng: WIC 工厂创建失败 hr=0x%08X", static_cast<unsigned>(hr));
        return false;
    }

    ComPtr<IWICStream> stream;
    hr = wicFactory->CreateStream(&stream);
    if (FAILED(hr))
        return false;

    hr = stream->InitializeFromMemory(reinterpret_cast<BYTE*>(bytes.data()), static_cast<DWORD>(bytes.size()));
    if (FAILED(hr))
        return false;

    ComPtr<IWICBitmapDecoder> decoder;
    hr = wicFactory->CreateDecoderFromStream(stream.Get(), nullptr, WICDecodeMetadataCacheOnLoad, &decoder);
    if (FAILED(hr))
    {
        NativeLog::Instance().Error("CreateTextureFromPng: 解码失败 %s hr=0x%08X", utf8Path.c_str(), static_cast<unsigned>(hr));
        return false;
    }

    ComPtr<IWICBitmapFrameDecode> frame;
    hr = decoder->GetFrame(0, &frame);
    if (FAILED(hr))
        return false;

    ComPtr<IWICFormatConverter> converter;
    hr = wicFactory->CreateFormatConverter(&converter);
    if (FAILED(hr))
        return false;

    hr = converter->Initialize(frame.Get(), GUID_WICPixelFormat32bppBGRA,
                               WICBitmapDitherTypeNone, nullptr, 0.0, WICBitmapPaletteTypeCustom);
    if (FAILED(hr))
    {
        NativeLog::Instance().Error("CreateTextureFromPng: 格式转换失败 %s hr=0x%08X", utf8Path.c_str(), static_cast<unsigned>(hr));
        return false;
    }

    UINT w = 0, h = 0;
    converter->GetSize(&w, &h);
    std::vector<BYTE> pixels(static_cast<size_t>(w) * h * 4);
    hr = converter->CopyPixels(nullptr, w * 4, static_cast<UINT>(pixels.size()), pixels.data());
    if (FAILED(hr))
        return false;

    D3D11_TEXTURE2D_DESC desc = {};
    desc.Width = w;
    desc.Height = h;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_IMMUTABLE;
    desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;

    D3D11_SUBRESOURCE_DATA init = {};
    init.pSysMem = pixels.data();
    init.SysMemPitch = w * 4;

    ComPtr<ID3D11Texture2D> texture;
    hr = device_->CreateTexture2D(&desc, &init, &texture);
    if (FAILED(hr))
    {
        NativeLog::Instance().Error("CreateTextureFromPng: 创建 D3D11 纹理失败 %s hr=0x%08X", utf8Path.c_str(), static_cast<unsigned>(hr));
        return false;
    }

    hr = device_->CreateShaderResourceView(texture.Get(), nullptr, outSrv);
    if (FAILED(hr))
        return false;

    if (outWidth) *outWidth = w;
    if (outHeight) *outHeight = h;
    NativeLog::Instance().Info("CreateTextureFromPng: %s (%ux%u)", utf8Path.c_str(), w, h);
    return true;
}

bool Live2DModel::Load(const std::string& utf8ModelJsonPath, std::string& error)
{
    // 解析目录
    size_t sep = utf8ModelJsonPath.find_last_of("/\\");
    if (sep == std::string::npos)
    {
        error = "model3.json 路径无效";
        return false;
    }
    modelDir_ = utf8ModelJsonPath.substr(0, sep + 1);

    std::vector<char> jsonBytes;
    if (!ReadFileToBytes(utf8ModelJsonPath, jsonBytes))
    {
        error = "无法读取 model3.json: " + utf8ModelJsonPath;
        return false;
    }

    LARGE_INTEGER tl0, tl1, tl2, tlf; QueryPerformanceFrequency(&tlf); QueryPerformanceCounter(&tl0);
    NativeLog::Instance().Info("Load step 1: 解析 model3.json");
    modelSetting_ = new CubismModelSettingJson(reinterpret_cast<const csmByte*>(jsonBytes.data()), static_cast<csmSizeInt>(jsonBytes.size()));

    // 加载 moc3
    const csmChar* mocFileName = modelSetting_->GetModelFileName();
    std::vector<char> mocBytes;
    if (!mocFileName || !ReadFileToBytes(modelDir_ + mocFileName, mocBytes))
    {
        error = "无法读取 moc3: " + modelDir_ + (mocFileName ? mocFileName : "");
        return false;
    }

    QueryPerformanceCounter(&tl1);
    NativeLog::Instance().Info("LoadTiming: model3_json解析=%.1f ms", (double)(tl1.QuadPart - tl0.QuadPart) * 1000.0 / tlf.QuadPart);
    NativeLog::Instance().Info("Load step 2: 加载 moc3 (%s)", modelDir_.c_str());
    // 校验 moc3 文件头（MOC3 magic），损坏的 moc 直接拒绝加载
    if (mocBytes.size() < 8 || memcmp(mocBytes.data(), "MOC3", 4) != 0)
    {
        error = "moc3 文件头无效: " + modelDir_ + (mocFileName ? mocFileName : "");
        NativeLog::Instance().Error("%s", error.c_str());
        return false;
    }

    userModel_ = new AliyaUserModel();
    QueryPerformanceCounter(&tl1);
    NativeLog::Instance().Info("LoadTiming: moc读取=%.1f ms", (double)(tl1.QuadPart - tl0.QuadPart) * 1000.0 / tlf.QuadPart);
    NativeLog::Instance().Info("Load step 3: LoadModel");
    userModel_->LoadModel(reinterpret_cast<const csmByte*>(mocBytes.data()), static_cast<csmSizeInt>(mocBytes.size()), true);

    canvasWidth_ = userModel_->GetModel()->GetCanvasWidth();
    canvasHeight_ = userModel_->GetModel()->GetCanvasHeight();
    parameterCount_ = userModel_->GetModel()->GetParameterCount();
    drawableCount_ = userModel_->GetModel()->GetDrawableCount();
    textureCount_ = modelSetting_->GetTextureCount();

    QueryPerformanceCounter(&tl1);
    NativeLog::Instance().Info("LoadTiming: moc3解析+Model创建=%.1f ms", (double)(tl1.QuadPart - tl0.QuadPart) * 1000.0 / tlf.QuadPart);
    NativeLog::Instance().Info("Load step 4: 创建渲染器");
    LARGE_INTEGER t0, t1, freq; QueryPerformanceFrequency(&freq); QueryPerformanceCounter(&t0);
    // 创建渲染器（尺寸在 Resize 时重建）
    userModel_->CreateRenderer(viewportW_ > 0 ? static_cast<csmUint32>(viewportW_) : 128,
                               viewportH_ > 0 ? static_cast<csmUint32>(viewportH_) : 128, 1);

    QueryPerformanceCounter(&t1);
    NativeLog::Instance().Info("CreateRenderer 耗时 %.1f ms", (double)(t1.QuadPart - t0.QuadPart) * 1000.0 / freq.QuadPart);
    QueryPerformanceCounter(&tl1);
    NativeLog::Instance().Info("LoadTiming: CreateRenderer=%.1f ms", (double)(tl1.QuadPart - tl0.QuadPart) * 1000.0 / tlf.QuadPart);
    NativeLog::Instance().Info("Load step 5: 绑定纹理");
    // 绑定纹理
    BindTextures();

    // 物理
    if (modelSetting_->GetPhysicsFileName() != nullptr && strlen(modelSetting_->GetPhysicsFileName()) > 0)
    {
        const csmChar* physicsFileName = modelSetting_->GetPhysicsFileName();
        std::vector<char> physicsBytes;
        if (physicsFileName && ReadFileToBytes(modelDir_ + physicsFileName, physicsBytes))
        {
            userModel_->LoadPhysics(reinterpret_cast<const csmByte*>(physicsBytes.data()), static_cast<csmSizeInt>(physicsBytes.size()));
            hasPhysics_ = true;
        }
        else
        {
            NativeLog::Instance().Warn("Live2DModel: physics3.json 读取失败，物理降级运行");
        }
    }

    QueryPerformanceCounter(&tl1);
    NativeLog::Instance().Info("LoadTiming: 纹理绑定=%.1f ms", (double)(tl1.QuadPart - tl0.QuadPart) * 1000.0 / tlf.QuadPart);
    NativeLog::Instance().Info("Load step 6: 绑定参数控制器");
    // 计算模型 drawable 顶点包围盒（用于视口适配，避免角色过小）
    {
        const CubismModel* m = userModel_->GetModel();
        csmInt32 dc = m->GetDrawableCount();
        float minX = 1e9f, maxX = -1e9f, minY = 1e9f, maxY = -1e9f;
        for (csmInt32 i = 0; i < dc; i++)
        {
            const csmFloat32* v = m->GetDrawableVertices(i);
            csmInt32 vc = m->GetDrawableVertexCount(i);
            for (csmInt32 j = 0; j < vc; j++)
            {
                float x = v[j * 2], y = v[j * 2 + 1];
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
            }
        }
        modelBoundsW_ = std::max(0.1f, maxX - minX);
        modelBoundsH_ = std::max(0.1f, maxY - minY);
        NativeLog::Instance().Info("模型包围盒: w=%f h=%f", modelBoundsW_, modelBoundsH_);
    }

    // 绑定参数控制器
    if (!controller_.Bind(userModel_->GetModel()))
        NativeLog::Instance().Warn("Live2DModel: 参数绑定不完整");

    // 缓存 Physics 输入参数索引（虚拟输入写入/恢复；物理输入与可见姿态分离）
    {
        CubismIdManager* idm = CubismFramework::GetIdManager();
        CubismModel* m = userModel_->GetModel();
        idAngleXIdx_ = m->GetParameterIndex(idm->GetId("ParamAngleX"));
        idAngleZIdx_ = m->GetParameterIndex(idm->GetId("ParamAngleZ"));
        idBodyAngleXIdx_ = m->GetParameterIndex(idm->GetId("ParamBodyAngleX"));
        idBodyAngleZIdx_ = m->GetParameterIndex(idm->GetId("ParamBodyAngleZ"));
        lastDrive_.physicsFps = kPhysicsFps;
    }

    // 收集 Physics 输出参数索引（用于强度缩放 / 输出幅度应用）
    // 优先解析 physics3.json 的 Output.Destination.Id（不修改正式 physics3.json），
    // 按唯一 parameterIndex 去重；解析失败才回退旧前缀收集（保证不回归）。
    std::vector<int> physicsOutputIndices;
    if (hasPhysics_ && userModel_)
    {
        CubismModel* m = userModel_->GetModel();
        physicsOutputParams_.clear();
        CollectPhysicsOutputParams(m);
        for (const auto& p : physicsOutputParams_)
            physicsOutputIndices.push_back(p.index);
        controller_.SetPhysicsParams(physicsOutputIndices);
        NativeLog::Instance().Info("Live2DModel: Physics 唯一输出参数 %d 个（physics3.json 解析），将应用输入增益 × 输出倍率 × 输出幅度",
            static_cast<int>(physicsOutputParams_.size()));

        // 记录 physics3.json 文件名（诊断日志字段）
        const csmChar* pf = modelSetting_->GetPhysicsFileName();
        if (pf)
        {
            std::string name(pf);
            size_t slash = name.find_last_of("/\\");
            physicsFile_ = (slash == std::string::npos) ? name : name.substr(slash + 1);
        }
    }

    // 诊断环境变量
    {
        char* diagEnv = nullptr;
        size_t diagLen = 0;
        if (_dupenv_s(&diagEnv, &diagLen, "ALIYA_LIVE2D_TRACE_PARAMETERS") == 0 && diagEnv)
        {
            diagEnabled_ = (diagEnv[0] != 0 && diagEnv[0] != '0');
            free(diagEnv);
        }
    }

    // 加载 Live2D 动作库（Assets/Live2D/Aliya/Actions/*.json）
    controller_.LoadActions(modelDir_ + "Actions");

    // 眼眨 / 口型判断
    hasEyeBlink_ = (controller_.EyeLOpenIndex() >= 0 || controller_.EyeROpenIndex() >= 0);
    hasLipSync_ = controller_.MouthIndex() >= 0;

    // 缓存嘴型覆盖通道参数索引（用于 model->Update() 前最终写入）
    {
        CubismIdManager* idm = CubismFramework::GetIdManager();
        CubismModel* m = userModel_->GetModel();
        idMouthOpenYIdx_ = m->GetParameterIndex(idm->GetId("ParamMouthOpenY"));
        idMouthFormIdx_ = m->GetParameterIndex(idm->GetId("ParamMouthForm"));
    }

    // 缓存人物互动通道参数索引与真实范围（不假定眼睛范围一定为 0..1）
    {
        CubismIdManager* idm = CubismFramework::GetIdManager();
        CubismModel* m = userModel_->GetModel();
        idEyeLIdx_ = m->GetParameterIndex(idm->GetId("ParamEyeLOpen"));
        idEyeRIdx_ = m->GetParameterIndex(idm->GetId("ParamEyeROpen"));
        if (idEyeLIdx_ >= 0)
        {
            eyeLMin_ = m->GetParameterMinimumValue(static_cast<csmUint32>(idEyeLIdx_));
            eyeLMax_ = m->GetParameterMaximumValue(static_cast<csmUint32>(idEyeLIdx_));
        }
        if (idEyeRIdx_ >= 0)
        {
            eyeRMin_ = m->GetParameterMinimumValue(static_cast<csmUint32>(idEyeRIdx_));
            eyeRMax_ = m->GetParameterMaximumValue(static_cast<csmUint32>(idEyeRIdx_));
        }
        idAngleXIdx_ = m->GetParameterIndex(idm->GetId("ParamAngleX"));
        idAngleYIdx_ = m->GetParameterIndex(idm->GetId("ParamAngleY"));
        idAngleZIdx_ = m->GetParameterIndex(idm->GetId("ParamAngleZ"));
        idBodyAngleXIdx_ = m->GetParameterIndex(idm->GetId("ParamBodyAngleX"));
    }
    DetectEarRootParams();

    QueryPerformanceCounter(&tl1);
    NativeLog::Instance().Info("LoadTiming: 总耗时(至加载成功)=%.1f ms", (double)(tl1.QuadPart - tl0.QuadPart) * 1000.0 / tlf.QuadPart);
    NativeLog::Instance().Info("Live2DModel: 加载成功 canvas=(%f,%f) params=%d drawables=%d textures=%d physics=%d",
                               canvasWidth_, canvasHeight_, parameterCount_, drawableCount_, textureCount_, hasPhysics_ ? 1 : 0);
    return true;
}

void Live2DModel::BindTextures()
{
    auto* renderer = userModel_->GetRenderer<CubismRenderer_D3D11>();
    if (!renderer)
        return;

    for (csmInt32 i = 0; i < modelSetting_->GetTextureCount(); i++)
    {
        const csmChar* fileName = modelSetting_->GetTextureFileName(i);
        if (!fileName || fileName[0] == '\0')
            continue;

        ID3D11ShaderResourceView* srv = nullptr;
        if (CreateTextureFromPng(modelDir_ + fileName, &srv, nullptr, nullptr))
        {
            renderer->BindTexture(i, srv);
            textureSrvs_.push_back(srv);
        }
        else
        {
            NativeLog::Instance().Error("Live2DModel: 纹理加载失败 %s", (modelDir_ + fileName).c_str());
        }
    }

    renderer->IsPremultipliedAlpha(false);
}

bool Live2DModel::Resize(int viewportW, int viewportH)
{
    if (viewportW <= 0 || viewportH <= 0)
        return false;

    bool sizeChanged = (viewportW != viewportW_ || viewportH != viewportH_);
    if (!sizeChanged && userModel_->GetRenderer<CubismRenderer_D3D11>())
        return true;

    viewportW_ = viewportW;
    viewportH_ = viewportH;
    controller_.SetViewportPixels(viewportW_, viewportH_);

    // 重建渲染器（更新裁剪缓冲尺寸），无需重载模型
    if (userModel_)
    {
        userModel_->DeleteRenderer();
        userModel_->CreateRenderer(static_cast<csmUint32>(viewportW_), static_cast<csmUint32>(viewportH_), 1);
        BindTextures();
    }
    return true;
}

void Live2DModel::SetScale(float scale)
{
    scale_ = scale;
}

void Live2DModel::SetupModelMatrix(int viewportW, int viewportH)
{
    if (!userModel_ || viewportW <= 0 || viewportH <= 0)
        return;

    // 按角色真实包围盒适配视口（模型通常只占画布的一部分，避免角色过小）。
    // 留边系数 kModelViewportMargin：模型在视口四周留出摆动空间，
    // 马尾/头发等物理摆动顶点会超出静态包围盒，若填满视口则摆动部分被 D3D 视口裁剪（如左转头时马尾右上缺失）。
    // HitTest 使用同一矩阵反变换，坐标保持一致。
    float fit = std::min(static_cast<float>(viewportW) / modelBoundsW_,
                         static_cast<float>(viewportH) / modelBoundsH_);
    float s = fit * scale_ * kModelViewportMargin;

    CubismMatrix44 m;
    m.LoadIdentity();
    // 模型坐标系 Y 轴朝上，视口 Y 轴朝下（左上原点）：模型 +Y -> 视口上方。
    m.Scale(s, -s);
    m.Translate(static_cast<float>(viewportW) * 0.5f, static_cast<float>(viewportH) * 0.5f);

    userModel_->GetModelMatrix()->SetMatrix(m.GetArray());
}

void Live2DModel::Update(float delta)
{
    if (!userModel_)
        return;

    // 0. 互动眼覆盖激活时暂停控制器自动眨眼（抚摸闭眼；卡死检测同步暂停）
    controller_.SetEyeOverrideActive(eyeOverrideEnabled_);

    // 0.5 帧内根部写入索引清零（重复写入断言：同一帧同一根部参数被 Interaction 写入超过一次）
    lastEarRootWriteIdx_ = -1;

    // 1. 参数控制器先写业务参数（可见姿态：动作/Idle/Gaze/Blink/Breath/LipSync，渲染帧率）
    controller_.Update(userModel_->GetModel(), delta);

    // 1.5 猫耳根部为 Physics 输入参数时：在 Physics 前应用（Physics 会把该值作为输入读取）
    if (earInteractionEnabled_ && !earRootPhysics_)
        ApplyEarRootInteraction(userModel_->GetModel());

    // 1.6 物理测试输入模式：覆盖 4 个输入参数为固定测试序列（编辑器等价性测试专用）
    if (physicsTestInput_)
    {
        auto* m = userModel_->GetModel();
        if (idAngleXIdx_ >= 0) m->SetParameterValue(static_cast<csmUint32>(idAngleXIdx_), testAngleX_, 1.0f);
        if (idAngleZIdx_ >= 0) m->SetParameterValue(static_cast<csmUint32>(idAngleZIdx_), testAngleZ_, 1.0f);
        if (idBodyAngleXIdx_ >= 0) m->SetParameterValue(static_cast<csmUint32>(idBodyAngleXIdx_), testBodyX_, 1.0f);
        if (idBodyAngleZIdx_ >= 0) m->SetParameterValue(static_cast<csmUint32>(idBodyAngleZIdx_), testBodyZ_, 1.0f);
    }

    // 2. 物理固定步进（60Hz，与 Render FPS 分离）
    if (hasPhysics_ && userModel_->GetPhysicsPtr() && physicsEnabled_)
    {
        RunPhysicsFixedSteps(delta);
    }

    // 2.5 覆盖检测：model->Update() 前记录头部参数（若小于 Gaze 写入后值说明被覆盖）
    controller_.RecordModelUpdateSnapshot(userModel_->GetModel());

    // 2.6 人物互动通道：controller 合成与物理之后、mouth override 之前应用。
    //     InteractionOffsets 为头部/身体临时附加值（不改变基础参数）；
    //     EyeOverride 为抚摸闭眼。
    ApplyInteractionChannels(userModel_->GetModel());

    // 2.7 猫耳根部为 Physics 输出参数时：在 Physics 后应用（覆盖在本帧 Physics 结果上）
    if (earInteractionEnabled_ && earRootPhysics_)
        ApplyEarRootInteraction(userModel_->GetModel());

    // 2.8 说话嘴型覆盖通道：独立通道，在动作/表情/Idle/LipSync 合成与物理之后、
    //     model->Update() 之前以最终值写入嘴部参数（不会被同帧其他模块覆盖）。
    if (mouthOverrideEnabled_)
    {
        auto* m = userModel_->GetModel();
        if (idMouthOpenYIdx_ >= 0)
            m->SetParameterValue(static_cast<csmUint32>(idMouthOpenYIdx_), mouthOpenY_, 1.0f);
        if (idMouthFormIdx_ >= 0)
            m->SetParameterValue(static_cast<csmUint32>(idMouthFormIdx_), mouthForm_, 1.0f);
    }

    // 3. 更新模型（应用参数到变形）
    userModel_->GetModel()->Update();
}

// 固定 60Hz Physics 步进：
//   1. accumulator += delta（上限 0.05s，最多补 3 步）
//   2. 每步：保存可见输入 -> 计算虚拟输入(可见×输入增益 + 弹簧速度惯性) -> 写虚拟输入
//      -> Evaluate(fixedStep) -> 对输出参数增量应用输出倍率 -> 恢复可见输入
//   3. 不恢复输出参数；不调用 LoadParameters/RestoreParameters 覆盖输出。
void Live2DModel::RunPhysicsFixedSteps(float delta)
{
    auto* model = userModel_->GetModel();
    auto* physics = userModel_->GetPhysicsPtr();
    if (!model || !physics)
        return;

    if (delta > kMaxPhysicsDelta)
        delta = kMaxPhysicsDelta;
    if (delta < 0.0f)
        delta = 0.0f;

    physicsAccum_ += delta;
    physicsAccum_ = std::min(physicsAccum_, kPhysicsFixedStep * static_cast<float>(kMaxPhysicsSteps));

    // 保存可见输入（渲染帧合成后的真实姿态值）
    float visibleAngleX = (idAngleXIdx_ >= 0) ? model->GetParameterValue(static_cast<csmUint32>(idAngleXIdx_)) : 0.0f;
    float visibleAngleZ = (idAngleZIdx_ >= 0) ? model->GetParameterValue(static_cast<csmUint32>(idAngleZIdx_)) : 0.0f;
    float visibleBodyX = (idBodyAngleXIdx_ >= 0) ? model->GetParameterValue(static_cast<csmUint32>(idBodyAngleXIdx_)) : 0.0f;
    float visibleBodyZ = (idBodyAngleZIdx_ >= 0) ? model->GetParameterValue(static_cast<csmUint32>(idBodyAngleZIdx_)) : 0.0f;
    lastDrive_.visibleAngleX = visibleAngleX;
    lastDrive_.visibleAngleZ = visibleAngleZ;
    lastDrive_.visibleBodyX = visibleBodyX;
    lastDrive_.visibleBodyZ = visibleBodyZ;

    int steps = 0;
    while (physicsAccum_ >= kPhysicsFixedStep - 1e-5f && steps < kMaxPhysicsSteps)
    {
        physicsAccum_ -= kPhysicsFixedStep;
        steps++;

        // 有效输入增益 = UI 增益 × 状态倍率，最终 Clamp 4.0
        float headGain = std::min(4.0f, controller_.HeadInputGainCurrent() * controller_.HeadInputGainStateMultiplier());
        float bodyGain = std::min(4.0f, controller_.BodyInputGainCurrent() * controller_.BodyInputGainStateMultiplier());

        // 弹簧速度惯性输入（低通滤波在控制器内维护，°/s × velocityGain）
        // 高强度（输入增益大）时自动降低 velocityGain，避免虚拟输入叠加过冲（4.0 时降至 0.65×）。
        // 测试输入模式下禁用（固定序列需逐点确定）。
        float velX = 0.0f, velZ = 0.0f;
        if (!physicsTestInput_ && controller_.VelocityPhysicsEnabled() && controller_.VelocityGain() > 0.0f)
        {
            float velScale = 1.0f - 0.35f * ((headGain - 1.0f) / 3.0f);
            velX = controller_.FilteredHeadVelX() * controller_.VelocityGain() * velScale;
            velZ = controller_.FilteredHeadVelZ() * controller_.VelocityGain() * velScale;
        }

        float physX = ClampParam(idAngleXIdx_, visibleAngleX * headGain + velX);
        float physZ = ClampParam(idAngleZIdx_, visibleAngleZ * headGain + velZ);
        float physBX = ClampParam(idBodyAngleXIdx_, visibleBodyX * bodyGain);
        float physBZ = ClampParam(idBodyAngleZIdx_, visibleBodyZ * bodyGain);

        lastDrive_.physicsAngleX = physX;
        lastDrive_.physicsAngleZ = physZ;
        lastDrive_.physicsBodyX = physBX;
        lastDrive_.physicsBodyZ = physBZ;
        lastDrive_.velocityHeadX = velX;
        lastDrive_.velocityHeadZ = velZ;

        // 写虚拟输入
        if (idAngleXIdx_ >= 0) model->SetParameterValue(static_cast<csmUint32>(idAngleXIdx_), physX, 1.0f);
        if (idAngleZIdx_ >= 0) model->SetParameterValue(static_cast<csmUint32>(idAngleZIdx_), physZ, 1.0f);
        if (idBodyAngleXIdx_ >= 0) model->SetParameterValue(static_cast<csmUint32>(idBodyAngleXIdx_), physBX, 1.0f);
        if (idBodyAngleZIdx_ >= 0) model->SetParameterValue(static_cast<csmUint32>(idBodyAngleZIdx_), physBZ, 1.0f);

        // 记录输出前值 -> Evaluate（固定步长）-> 输出倍率
        std::vector<float> before(physicsOutputParams_.size(), 0.0f);
        for (size_t i = 0; i < physicsOutputParams_.size(); i++)
            before[i] = model->GetParameterValue(static_cast<csmUint32>(physicsOutputParams_[i].index));
        physics->Evaluate(model, kPhysicsFixedStep);
        ApplyOutputGainAfterEvaluate(before);

        // 恢复可见输入（不恢复输出参数；不重跑 Physics）
        if (idAngleXIdx_ >= 0) model->SetParameterValue(static_cast<csmUint32>(idAngleXIdx_), visibleAngleX, 1.0f);
        if (idAngleZIdx_ >= 0) model->SetParameterValue(static_cast<csmUint32>(idAngleZIdx_), visibleAngleZ, 1.0f);
        if (idBodyAngleXIdx_ >= 0) model->SetParameterValue(static_cast<csmUint32>(idBodyAngleXIdx_), visibleBodyX, 1.0f);
        if (idBodyAngleZIdx_ >= 0) model->SetParameterValue(static_cast<csmUint32>(idBodyAngleZIdx_), visibleBodyZ, 1.0f);
    }
    lastDrive_.evaluateCount = steps;
    lastFramePhysicsSteps_ = steps;

    TracePhysicsDiagnostics(delta);
}

// 输出倍率 × 输出幅度：Evaluate 输出相对"参数默认值"的偏移 × outputGain × amplitude，再写回。
//   baseValue    = 模型参数默认值（恒定参考，禁止用上一帧 finalValue，杜绝反馈累积）
//   rawDelta     = evaluated - default
//   finalValue   = default + rawDelta × outputGain × amplitude
// 100% 快速路径（|amplitude-1|<1e-4 且 |outputGain-1|<1e-3）：finalValue = evaluatedValue，
// 不做任何额外的 Lerp/Spring/低通/软限制/二次叠加，与增加本功能前的原始输出一致。
// >150% 幅度安全 Clamp 到 [min+span*0.04, max-span*0.04]，否则线性 Clamp(min, max)。
void Live2DModel::ApplyOutputGainAfterEvaluate(const std::vector<float>& before)
{
    auto* model = userModel_->GetModel();
    float gain = controller_.PhysicsOutputGain();
    float amplitude = controller_.PhysicsOutputAmplitude();
    const bool fastPath = std::fabs(amplitude - 1.0f) < 0.0001f && std::fabs(gain - 1.0f) < 0.001f;
    const bool safeClamp = amplitude > 1.5f + 1e-4f;

    float maxRawDelta = 0.0f;
    float maxFinalDelta = 0.0f;
    int clampHits = 0;
    int applyCount = 0;

    for (size_t i = 0; i < physicsOutputParams_.size(); i++)
    {
        auto& p = physicsOutputParams_[i];
        float after = model->GetParameterValue(static_cast<csmUint32>(p.index));
        p.baseValue = p.defaultValue;
        p.evaluatedValue = after;
        float rawDelta = after - p.defaultValue;
        maxRawDelta = std::max(maxRawDelta, std::fabs(rawDelta));
        applyCount++;

        if (fastPath)
        {
            p.finalValue = after;
        }
        else
        {
            float scaled = p.defaultValue + rawDelta * gain * amplitude;
            float lo = p.min, hi = p.max;
            if (safeClamp)
            {
                float span = p.max - p.min;
                lo = p.min + span * 0.04f;
                hi = p.max - span * 0.04f;
            }
            bool hitLo = false, hitHi = false;
            if (scaled < lo) { scaled = lo; hitLo = true; }
            if (scaled > hi) { scaled = hi; hitHi = true; }
            p.finalValue = scaled;
            if (hitLo || hitHi)
            {
                clampHits++;
                if (safeClamp && !p.id.empty())
                {
                    if (lastClampedParams_.find(p.id) == std::string::npos)
                    {
                        if (!lastClampedParams_.empty()) lastClampedParams_ += ",";
                        lastClampedParams_ += p.id;
                    }
                }
            }
            model->SetParameterValue(static_cast<csmUint32>(p.index), scaled, 1.0f);
        }
        maxFinalDelta = std::max(maxFinalDelta, std::fabs(p.finalValue - p.baseValue));
    }

    lastDrive_.outputMaxDelta = maxRawDelta;
    lastDrive_.outputFinalMaxDelta = maxFinalDelta;
    lastDrive_.outputClampHits = clampHits;
    lastDrive_.outputAmplitude = amplitude;
    lastDrive_.outputAmplitudeTarget = controller_.PhysicsOutputAmplitudeTarget();
    lastDrive_.uniqueOutputCount = static_cast<int>(physicsOutputParams_.size());
    lastDrive_.amplitudeApplyCount = applyCount;
}

float Live2DModel::ClampParam(int index, float v)
{
    if (index < 0 || !userModel_)
        return v;
    auto* m = userModel_->GetModel();
    float mn = m->GetParameterMinimumValue(static_cast<csmUint32>(index));
    float mx = m->GetParameterMaximumValue(static_cast<csmUint32>(index));
    return std::max(mn, std::min(mx, v));
}

// 解析 physics3.json，缓存所有唯一 Physics 输出参数：
//   PhysicsSettings[].Output[].Destination.Id -> 参数索引；按唯一 parameterIndex 去重。
// 优先使用 Framework 官方 CubismPhysicsJson 解析；文件缺失/解析失败回退旧前缀收集。
void Live2DModel::AddOutputParamIfUnique(Live2D::Cubism::Framework::CubismModel* m, int index, const char* idName)
{
    for (const auto& existing : physicsOutputParams_)
    {
        if (existing.index == index) return;
    }
    PhysicsOutputParam p;
    p.index = index;
    p.min = m->GetParameterMinimumValue(static_cast<csmUint32>(index));
    p.max = m->GetParameterMaximumValue(static_cast<csmUint32>(index));
    p.defaultValue = m->GetParameterDefaultValue(static_cast<csmUint32>(index));
    p.id = idName ? idName : "";
    physicsOutputParams_.push_back(p);
}

void Live2DModel::CollectPhysicsOutputParams(Live2D::Cubism::Framework::CubismModel* m)
{
    physicsOutputParams_.clear();
    bool parsed = false;
    const csmChar* physicsFileName = modelSetting_ ? modelSetting_->GetPhysicsFileName() : nullptr;
    if (physicsFileName && modelDir_.size() > 0)
    {
        std::vector<char> bytes;
        if (ReadFileToBytes(modelDir_ + physicsFileName, bytes) && !bytes.empty())
        {
            CubismPhysicsJson json(reinterpret_cast<const csmByte*>(bytes.data()),
                                   static_cast<csmSizeInt>(bytes.size()));
            csmInt32 rigCount = json.GetSubRigCount();
            CubismIdManager* idm = CubismFramework::GetIdManager();
            for (csmInt32 r = 0; r < rigCount; r++)
            {
                csmInt32 outCount = json.GetOutputCount(r);
                for (csmInt32 o = 0; o < outCount; o++)
                {
                    CubismIdHandle dst = json.GetOutputsDestinationId(r, o);
                    if (!dst) continue;
                    const char* idStr = dst->GetString().GetRawString();
                    int idx = m->GetParameterIndex(idm->GetId(idStr));
                    if (idx >= 0) AddOutputParamIfUnique(m, idx, idStr);
                }
            }
            parsed = true;
        }
    }

    if (!parsed)
    {
        // 回退：名称前缀收集（旧行为，仅文件异常时保底）
        NativeLog::Instance().Warn("Live2DModel: physics3.json 解析失败，回退前缀收集 Physics 输出参数");
        CubismIdManager* idm = CubismFramework::GetIdManager();
        csmInt32 paramCount = m->GetParameterCount();
        for (csmInt32 i = 0; i < paramCount; i++)
        {
            CubismIdHandle idHandle = m->GetParameterId(i);
            const char* idStr = idHandle ? idHandle->GetString().GetRawString() : "";
            if (idStr && strstr(idStr, "Param_Angle_Rotation_") == idStr)
                AddOutputParamIfUnique(m, i, idStr);
        }
    }
}

// 250ms 诊断日志：明确区分可见姿态(小)与 Physics 实际输入(大)。
void Live2DModel::TracePhysicsDiagnostics(float delta)
{
    if (!diagEnabled_)
        return;
    diagTimer_ += delta;
    if (diagTimer_ < 0.25f)
        return;
    diagTimer_ = 0.0f;

    NativeLog::Instance().Info(
        "PHYSICS_INPUT VisibleHeadX=%.2f/Z=%.2f VisibleBodyX=%.2f/Z=%.2f "
        "PhysicsHeadX=%.2f/Z=%.2f PhysicsBodyX=%.2f/Z=%.2f "
        "HeadInputGain=%.2f BodyInputGain=%.2f VelocityInput=%.3f "
        "PhysicsOutputGain=%.2f PhysicsEvaluateCount=%d PhysicsOutputMaxDelta=%.3f "
        "PhysicsOutputAmplitude=%.3f/Tgt=%.3f PhysicsFinalMaxDelta=%.3f "
        "PhysicsClampHits=%d UniqueOutputs=%d AmplitudeApplyCount=%d "
        "PhysicsFile=%s PhysicsFps=%.0f ClampedParams=%s",
        lastDrive_.visibleAngleX, lastDrive_.visibleAngleZ,
        lastDrive_.visibleBodyX, lastDrive_.visibleBodyZ,
        lastDrive_.physicsAngleX, lastDrive_.physicsAngleZ,
        lastDrive_.physicsBodyX, lastDrive_.physicsBodyZ,
        controller_.HeadInputGainCurrent() * controller_.HeadInputGainStateMultiplier(),
        controller_.BodyInputGainCurrent() * controller_.BodyInputGainStateMultiplier(),
        lastDrive_.velocityHeadX,
        controller_.PhysicsOutputGain(),
        lastDrive_.evaluateCount,
        lastDrive_.outputMaxDelta,
        lastDrive_.outputAmplitude,
        lastDrive_.outputAmplitudeTarget,
        lastDrive_.outputFinalMaxDelta,
        lastDrive_.outputClampHits,
        lastDrive_.uniqueOutputCount,
        lastDrive_.amplitudeApplyCount,
        physicsFile_.empty() ? "(none)" : physicsFile_.c_str(),
        lastDrive_.physicsFps,
        lastClampedParams_.empty() ? "(none)" : lastClampedParams_.c_str());
    lastClampedParams_.clear();
}

// 检测猫耳根部参数：默认选择 Param_Angle_Rotation_1_CAT_Ear_L/R（Rotation_1 为根部惯例，
// physics3.json 中 Rotation_1 的 Scale 最大=1.5，根部驱动量最大）。
// 若该参数不存在，回退到该侧第一个 CAT_Ear 参数。其余 Rotation_2/3 一律不写入。
void Live2DModel::DetectEarRootParams()
{
    idEarLeftRoot_ = -1;
    idEarRightRoot_ = -1;
    earRootPhysics_ = false;
    if (!userModel_)
        return;

    CubismModel* m = userModel_->GetModel();
    CubismIdManager* idm = CubismFramework::GetIdManager();

    auto pickRoot = [&](const char* preferredId, const char* sideSub) -> int {
        int idx = m->GetParameterIndex(idm->GetId(preferredId));
        if (idx >= 0)
            return idx;
        // 回退：扫描该侧第一个 CAT_Ear 参数
        csmInt32 count = m->GetParameterCount();
        for (csmInt32 i = 0; i < count; i++)
        {
            CubismIdHandle idHandle = m->GetParameterId(i);
            const char* idStr = idHandle ? idHandle->GetString().GetRawString() : "";
            if (idStr && strstr(idStr, "CAT_Ear") && strstr(idStr, sideSub))
                return i;
        }
        return -1;
    };

    idEarLeftRoot_ = pickRoot("Param_Angle_Rotation_1_CAT_Ear_L", "CAT_Ear_L");
    idEarRightRoot_ = pickRoot("Param_Angle_Rotation_1_CAT_Ear_R", "CAT_Ear_R");

    auto setRange = [&](int idx, float& mn, float& mx) {
        if (idx >= 0)
        {
            mn = m->GetParameterMinimumValue(static_cast<csmUint32>(idx));
            mx = m->GetParameterMaximumValue(static_cast<csmUint32>(idx));
        }
    };
    setRange(idEarLeftRoot_, earLeftRootMin_, earLeftRootMax_);
    setRange(idEarRightRoot_, earRightRootMin_, earRightRootMax_);

    std::vector<int> physicsIndices = controller_.PhysicsOutputIndices();
    auto isPhysics = [&](int idx) {
        for (int p : physicsIndices)
            if (p == idx) return true;
        return false;
    };
    earRootPhysics_ = (idEarLeftRoot_ >= 0 && isPhysics(idEarLeftRoot_))
                   || (idEarRightRoot_ >= 0 && isPhysics(idEarRightRoot_));

    if (idEarLeftRoot_ < 0 && idEarRightRoot_ < 0)
    {
        NativeLog::Instance().Warn("Live2DModel: 未检测到猫耳根部参数，抚摸时耳朵反馈跳过");
        return;
    }
    NativeLog::Instance().Info("Live2DModel: 猫耳根部 left=%d(%s) right=%d(%s) physics=%d",
        idEarLeftRoot_, idEarLeftRoot_ >= 0 ? m->GetParameterId(static_cast<csmUint32>(idEarLeftRoot_))->GetString().GetRawString() : "none",
        idEarRightRoot_, idEarRightRoot_ >= 0 ? m->GetParameterId(static_cast<csmUint32>(idEarRightRoot_))->GetString().GetRawString() : "none",
        earRootPhysics_ ? 1 : 0);
}

void Live2DModel::ListEarParams(std::string& out) const
{
    out.clear();
    if (!userModel_)
    {
        out = "[]";
        return;
    }
    auto append = [&](int idx, const char* side, float mn, float mx, bool physics) {
        if (idx < 0)
            return;
        if (out.size() > 1) out += ",";   // 已输出 "[" 之后才加逗号
        out += "{\"side\":\"";
        out += side;
        out += "\",\"id\":\"";
        out += userModel_->GetModel()->GetParameterId(static_cast<csmUint32>(idx))->GetString().GetRawString();
        out += "\",\"min\":";
        out += std::to_string(mn);
        out += ",\"max\":";
        out += std::to_string(mx);
        out += ",\"physics\":";
        out += physics ? "true" : "false";
        out += ",\"root\":true}";
    };
    out += "[";
    append(idEarLeftRoot_, "left", earLeftRootMin_, earLeftRootMax_, earRootPhysics_);
    append(idEarRightRoot_, "right", earRightRootMin_, earRightRootMax_, earRootPhysics_);
    out += "]";
}

// 应用猫耳根部互动偏移：final = 本帧当前值 + 归一化偏移 × 安全幅度，Clamp 到真实范围。
// 只写左右各一个根部参数；不做 current += offset 的持续累加（基于本帧结果计算）。
void Live2DModel::ApplyEarRootInteraction(Live2D::Cubism::Framework::CubismModel* m)
{
    if (!m)
        return;
    auto apply = [&](int idx, float mn, float mx, float norm) {
        if (idx < 0)
            return;
        // 同一帧同一根部参数被 Interaction 写入超过一次：记录一次（正式版本只记一次，不刷日志）
        if (lastEarRootWriteIdx_ == idx)
            NativeLog::Instance().Warn("EAR_PARAMETER_MULTIPLE_WRITE idx=%d", idx);
        lastEarRootWriteIdx_ = idx;
        float current = m->GetParameterValue(static_cast<csmUint32>(idx)); // 本帧 Physics/Controller 结果
        float offset = norm * kEarRootMaxOffset;
        float v = std::max(mn, std::min(mx, current + offset));
        m->SetParameterValue(static_cast<csmUint32>(idx), v, 1.0f);
    };
    apply(idEarLeftRoot_, earLeftRootMin_, earLeftRootMax_, earLeft_);
    apply(idEarRightRoot_, earRightRootMin_, earRightRootMax_, earRight_);
}

// 应用人物互动通道：头部/身体临时附加值、抚摸闭眼、猫耳附加偏移。
// 所有写入都 Clamp 到模型真实 Min/Max；均为临时值，不改变基础参数。
void Live2DModel::ApplyInteractionChannels(Live2D::Cubism::Framework::CubismModel* m)
{
    if (!m)
        return;

    auto addClamped = [&](int idx, float offset) {
        if (idx < 0)
            return;
        float mn = m->GetParameterMinimumValue(static_cast<csmUint32>(idx));
        float mx = m->GetParameterMaximumValue(static_cast<csmUint32>(idx));
        float cur = m->GetParameterValue(static_cast<csmUint32>(idx));
        float v = std::max(mn, std::min(mx, cur + offset));
        m->SetParameterValue(static_cast<csmUint32>(idx), v, 1.0f);
    };

    // 头部互动偏移：临时附加值（叠加在 Controller 结果上，之后 Clamp 到模型范围）
    if (interAngleX_ != 0.0f || interAngleY_ != 0.0f || interAngleZ_ != 0.0f)
    {
        addClamped(idAngleXIdx_, interAngleX_);
        addClamped(idAngleYIdx_, interAngleY_);
        addClamped(idAngleZIdx_, interAngleZ_);
    }
    if (interBodyAngleX_ != 0.0f)
        addClamped(idBodyAngleXIdx_, interBodyAngleX_);

    // 抚摸闭眼：直接写入眼睛真实范围内目标值（自动眨眼已暂停）
    if (eyeOverrideEnabled_)
    {
        if (idEyeLIdx_ >= 0)
        {
            float v = std::max(eyeLMin_, std::min(eyeLMax_, eyeLeft_));
            m->SetParameterValue(static_cast<csmUint32>(idEyeLIdx_), v, 1.0f);
        }
        if (idEyeRIdx_ >= 0)
        {
            float v = std::max(eyeRMin_, std::min(eyeRMax_, eyeRight_));
            m->SetParameterValue(static_cast<csmUint32>(idEyeRIdx_), v, 1.0f);
        }
    }
    // 注意：猫耳根部互动已拆分为 ApplyEarRootInteraction（仅根部参数，Physics 前/后按需调用）
}

void Live2DModel::Render(int viewportW, int viewportH)
{
    if (!userModel_ || viewportW <= 0 || viewportH <= 0)
        return;

    auto* renderer = userModel_->GetRenderer<CubismRenderer_D3D11>();
    if (!renderer)
        return;

    SetupModelMatrix(viewportW, viewportH);

    CubismMatrix44 projection;
    projection.LoadIdentity();
    // 视口像素 -> NDC（y 翻转：视口 y 向下，NDC y 向上）
    projection.Scale(2.0f / static_cast<float>(viewportW), -2.0f / static_cast<float>(viewportH));
    projection.Translate(-1.0f, 1.0f);

    CubismMatrix44 mvp = projection;
    mvp.MultiplyByMatrix(userModel_->GetModelMatrix());

    renderer->StartFrame(context_);
    renderer->SetMvpMatrix(&mvp);
    renderer->DrawModel();
    renderer->EndFrame();
}

bool Live2DModel::HitTest(float xPx, float yPx) const
{
    if (!userModel_ || !userModel_->GetModel())
        return false;

    const CubismModel* model = userModel_->GetModel();
    csmInt32 count = model->GetDrawableCount();
    for (csmInt32 i = 0; i < count; i++)
    {
        // 命中所有 drawable（模型内网格即角色轮廓）
        if (userModel_->IsHit(model->GetDrawableId(i), xPx, yPx))
            return true;
    }
    return false;
}

} // namespace aliya













