#pragma once

#include <string>
#include <vector>
#include <memory>

#include <d3d11.h>

#include "CubismFramework.hpp"
#include "ICubismModelSetting.hpp"
#include "Model/CubismUserModel.hpp"
#include "live2d_parameter_controller.hpp"

namespace Live2D { namespace Cubism { namespace Framework { 
class CubismModelSettingJson; 
class CubismModel; 
} } }

namespace aliya {

// 派生模型：暴露 Physics / Pose 访问器（基类为 protected）。
class AliyaUserModel : public Live2D::Cubism::Framework::CubismUserModel {
public:
    Live2D::Cubism::Framework::CubismPhysics* GetPhysicsPtr() { return _physics; }
};

// 模型加载、渲染、命中检测与参数控制。
class Live2DModel {
public:
    Live2DModel(ID3D11Device* device, ID3D11DeviceContext* context);
    ~Live2DModel();

    // 加载 model3.json（绝对路径，UTF-8）。失败时 error 写入原因。
    bool Load(const std::string& utf8ModelJsonPath, std::string& error);

    // 视口尺寸变化时重建渲染器与投影。
    bool Resize(int viewportW, int viewportH);

    // 每帧更新参数 + physics。delta 秒。
    void Update(float delta);

    // 渲染到当前绑定的渲染目标（由 Host 绑定共享纹理 RTV）。
    void Render(int viewportW, int viewportH);

    // 命中检测（视口物理像素坐标，y 向下）。
    bool HitTest(float xPx, float yPx) const;

    // 设置整体缩放倍率（乘在适配比例上）。
    void SetScale(float scale);
    float GetScale() const { return scale_; }

    Live2DParameterController& Controller() { return controller_; }

    // 底层 CubismModel 访问（供 Host 读取参数真实范围）
    Live2D::Cubism::Framework::CubismModel* GetModel() { return userModel_ ? userModel_->GetModel() : nullptr; }
    const Live2D::Cubism::Framework::CubismModel* GetModel() const { return userModel_ ? userModel_->GetModel() : nullptr; }

    int ParameterCount() const { return parameterCount_; }
    int DrawableCount() const { return drawableCount_; }
    int TextureCount() const { return textureCount_; }
    float CanvasWidth() const { return canvasWidth_; }
    float CanvasHeight() const { return canvasHeight_; }
    bool HasPhysics() const { return hasPhysics_; }
    bool HasEyeBlink() const { return hasEyeBlink_; }
    bool HasLipSync() const { return hasLipSync_; }

    const std::string& ModelDir() const { return modelDir_; }

    // 物理固定步进诊断快照
    struct PhysicsDriveInput {
        float visibleAngleX = 0, visibleAngleZ = 0;
        float visibleBodyX = 0, visibleBodyZ = 0;
        float physicsAngleX = 0, physicsAngleZ = 0;
        float physicsBodyX = 0, physicsBodyZ = 0;
        float velocityHeadX = 0, velocityHeadZ = 0; // 速度惯性贡献（度）
        int evaluateCount = 0;          // 本帧实际 Evaluate 次数（0~3）
        float outputMaxDelta = 0;       // 本帧输出参数最大原始增量（evaluated-base，度）
        float outputFinalMaxDelta = 0;  // 本帧输出参数最大最终增量（final-base，度）
        int outputClampHits = 0;        // 本帧输出参数 Clamp 命中总次数
        float outputAmplitude = 1.0f;   // 当前生效输出幅度（平滑后 current）
        float outputAmplitudeTarget = 1.0f; // 输出幅度目标值
        int uniqueOutputCount = 0;      // 唯一 Physics 输出参数数（physics3.json 解析）
        int amplitudeApplyCount = 0;    // 本帧实际应用幅度的输出参数数（应 == uniqueOutputCount）
        float physicsFps = 60.0f;
    };
    const PhysicsDriveInput& LastPhysicsDrive() const { return lastDrive_; }
    int LastFramePhysicsSteps() const { return lastFramePhysicsSteps_; }
    void ResetPhysicsAccumulator() { physicsAccum_ = 0.0f; }
    void SetPhysicsEnabled(bool enabled) { physicsEnabled_ = enabled; }
    bool PhysicsEnabled() const { return physicsEnabled_; }

    // ---- 说话嘴型覆盖通道（独立于动作/表情/Idle/LipSync） ----
    // 启用后每帧在控制器合成与物理步进之后、model->Update() 之前以最终值写入嘴部参数。
    void SetMouthOverride(bool enabled, float openY, float form)
    {
        mouthOverrideEnabled_ = enabled;
        mouthOpenY_ = openY;
        mouthForm_ = form;
    }
    bool MouthOverrideEnabled() const { return mouthOverrideEnabled_; }
    bool HasMouthOpenY() const { return idMouthOpenYIdx_ >= 0; }
    bool HasMouthForm() const { return idMouthFormIdx_ >= 0; }
    void GetMouthParamMeta(float& openYMin, float& openYMax, float& formMin, float& formMax) const
    {
        auto* m = userModel_ ? userModel_->GetModel() : nullptr;
        using CsmUint32 = Live2D::Cubism::Framework::csmUint32;
        if (m)
        {
            openYMin = (idMouthOpenYIdx_ >= 0) ? m->GetParameterMinimumValue(static_cast<CsmUint32>(idMouthOpenYIdx_)) : 0.0f;
            openYMax = (idMouthOpenYIdx_ >= 0) ? m->GetParameterMaximumValue(static_cast<CsmUint32>(idMouthOpenYIdx_)) : 1.0f;
            formMin = (idMouthFormIdx_ >= 0) ? m->GetParameterMinimumValue(static_cast<CsmUint32>(idMouthFormIdx_)) : 0.0f;
            formMax = (idMouthFormIdx_ >= 0) ? m->GetParameterMaximumValue(static_cast<CsmUint32>(idMouthFormIdx_)) : 1.0f;
        }
        else
        {
            openYMin = 0.0f; openYMax = 1.0f; formMin = 0.0f; formMax = 1.0f;
        }
    }

    // ---- 人物互动通道（独立于 Controller/Physics/MouthOverride）----
    // 在 controller 合成与物理之后、mouth override 之前应用；均为临时附加值，不改变基础参数。
    void SetInteractionOffsets(float angleX, float angleY, float angleZ, float bodyAngleX)
    {
        interAngleX_ = angleX;
        interAngleY_ = angleY;
        interAngleZ_ = angleZ;
        interBodyAngleX_ = bodyAngleX;
    }
    // 互动眼覆盖：left/right 为模型真实范围内的目标值（通常 0=闭眼 1=睁眼）
    void SetEyeOverride(bool enabled, float leftOpen, float rightOpen)
    {
        eyeOverrideEnabled_ = enabled;
        eyeLeft_ = leftOpen;
        eyeRight_ = rightOpen;
    }
    // 猫耳根部互动：只允许控制左右各一个经确认的根部旋转参数
    // （默认 Param_Angle_Rotation_1_CAT_Ear_L/R，需实测确认），
    // 其余 Rotation_2/3 交给模型原有 Physics 与父子变形器处理，避免图层割裂。
    void SetEarInteraction(bool enabled, float leftNorm, float rightNorm)
    {
        earInteractionEnabled_ = enabled;
        if (enabled)
        {
            earLeft_ = leftNorm;
            earRight_ = rightNorm;
        }
        else
        {
            // 传入 enabled=false 时必须清零所有耳朵互动偏移
            earLeft_ = 0.0f;
            earRight_ = 0.0f;
        }
    }
    bool HasEyeLeft() const { return idEyeLIdx_ >= 0; }
    bool HasEyeRight() const { return idEyeRIdx_ >= 0; }
    bool HasEarRootParams() const { return idEarLeftRoot_ >= 0 || idEarRightRoot_ >= 0; }
    bool EarRootPhysics() const { return earRootPhysics_; }
    int EarLeftRootIndex() const { return idEarLeftRoot_; }
    int EarRightRootIndex() const { return idEarRightRoot_; }
    void GetEarRootRanges(float& lMin, float& lMax, float& rMin, float& rMax) const
    {
        lMin = earLeftRootMin_; lMax = earLeftRootMax_;
        rMin = earRightRootMin_; rMax = earRightRootMax_;
    }
    // 互动通道参数索引（供 Host 读取真实范围）
    int AngleXIndex() const { return idAngleXIdx_; }
    int AngleYIndex() const { return idAngleYIdx_; }
    int AngleZIndex() const { return idAngleZIdx_; }
    int BodyAngleXIndex() const { return idBodyAngleXIdx_; }
    int EyeLIndex() const { return idEyeLIdx_; }
    int EyeRIndex() const { return idEyeRIdx_; }
    void GetEyeRanges(float& lMin, float& lMax, float& rMin, float& rMax) const
    {
        lMin = eyeLMin_; lMax = eyeLMax_; rMin = eyeRMin_; rMax = eyeRMax_;
    }
    void ListEarParams(std::string& out) const;

    // 物理测试输入模式（编辑器等价性测试）：
    // 启用后每帧在参数控制器合成完成后，将 4 个输入参数强制覆盖为测试值，
    // 使 Physics 的"可见输入"精确等于测试序列，直接对比 Editor 相同输入的效果。
    void SetPhysicsTestInput(bool enabled, float angleX, float angleZ, float bodyAngleX, float bodyAngleZ)
    {
        physicsTestInput_ = enabled;
        testAngleX_ = angleX;
        testAngleZ_ = angleZ;
        testBodyX_ = bodyAngleX;
        testBodyZ_ = bodyAngleZ;
    }
    bool PhysicsTestInput() const { return physicsTestInput_; }

private:
    bool CreateTextureFromPng(const std::string& utf8Path, ID3D11ShaderResourceView** outSrv, unsigned int* outWidth, unsigned int* outHeight);
    void SetupModelMatrix(int viewportW, int viewportH);
    void BindTextures();
    // 物理输出参数元数据（增量倍率 Clamp 用）。索引唯一（physics3.json 解析去重）。
    struct PhysicsOutputParam {
        int index = -1;
        float min = -10.0f, max = 10.0f;
        float defaultValue = 0.0f;  // 模型参数默认值（非 Physics 基础值，恒定参考点）
        std::string id;             // 参数 ID（Clamp 报告用）
        float baseValue = 0.0f;     // 应用 base（默认值/抖动参考）
        float evaluatedValue = 0.0f;// Evaluate 直接输出
        float finalValue = 0.0f;    // 幅度应用后写回值
    };
    // 固定步长 Physics：accumulator + 可见/虚拟输入分离 + 单帧最多 3 步
    void RunPhysicsFixedSteps(float delta);
    // Evaluate 后对输出参数增量应用输出倍率（0.0~1.4）× 输出幅度（0.0~2.0）
    void ApplyOutputGainAfterEvaluate(const std::vector<float>& before);
    // 解析 physics3.json，缓存唯一 Physics 输出参数（按 parameterIndex 去重）
    void CollectPhysicsOutputParams(Live2D::Cubism::Framework::CubismModel* m);
    // 唯一输出参数追加（重复索引忽略）
    void AddOutputParamIfUnique(Live2D::Cubism::Framework::CubismModel* m, int index, const char* idName);
    // 按模型 Min/Max Clamp 虚拟输入
    float ClampParam(int index, float v);
    void TracePhysicsDiagnostics(float delta);
    // 扫描模型真实猫耳根部参数（默认 Rotation_1_CAT_Ear_L/R，供互动通道使用）
    void DetectEarRootParams();
    // 应用猫耳根部互动偏移（final = 本帧当前值 + 归一化偏移 × 安全幅度，Clamp 到真实范围）
    void ApplyEarRootInteraction(Live2D::Cubism::Framework::CubismModel* m);
    // 应用人物互动通道（controller 与物理之后、mouth override 之前）
    void ApplyInteractionChannels(Live2D::Cubism::Framework::CubismModel* m);

    ID3D11Device* device_ = nullptr;
    ID3D11DeviceContext* context_ = nullptr;

    Live2D::Cubism::Framework::CubismModelSettingJson* modelSetting_ = nullptr;
    AliyaUserModel* userModel_ = nullptr;

    std::string modelDir_;
    int viewportW_ = 0;
    int viewportH_ = 0;
    float scale_ = 1.0f;

    int parameterCount_ = 0;
    int drawableCount_ = 0;
    int textureCount_ = 0;
    float canvasWidth_ = 1.0f;
    float canvasHeight_ = 1.0f;
    float modelBoundsW_ = 1.0f;
    float modelBoundsH_ = 1.0f;
    bool hasPhysics_ = false;
    bool hasEyeBlink_ = false;
    bool hasLipSync_ = false;
    std::vector<PhysicsOutputParam> physicsOutputParams_;

    // 物理输入参数索引（虚拟输入写入/恢复）
    int idAngleXIdx_ = -1;
    int idAngleZIdx_ = -1;
    int idBodyAngleXIdx_ = -1;
    int idBodyAngleZIdx_ = -1;

    // 固定步长
    static constexpr float kPhysicsFps = 60.0f;
    static constexpr float kPhysicsFixedStep = 1.0f / 60.0f;
    static constexpr float kMaxPhysicsDelta = 0.05f;
    static constexpr int kMaxPhysicsSteps = 3;
    float physicsAccum_ = 0.0f;
    bool physicsEnabled_ = true;
    int lastFramePhysicsSteps_ = 0;
    PhysicsDriveInput lastDrive_;

    // 诊断（250ms）
    bool diagEnabled_ = false;
    float diagTimer_ = 0.0f;
    std::string physicsFile_;
    // 最近一次诊断窗口内命中安全 Clamp（>150% 幅度）的输出参数 ID 列表（逗号分隔）
    std::string lastClampedParams_;

    // 物理测试输入模式（编辑器等价性测试专用）
    bool physicsTestInput_ = false;
    float testAngleX_ = 0.0f, testAngleZ_ = 0.0f;
    float testBodyX_ = 0.0f, testBodyZ_ = 0.0f;

    // 说话嘴型覆盖通道状态（索引在 Load 时缓存）
    int idMouthOpenYIdx_ = -1;
    int idMouthFormIdx_ = -1;
    bool mouthOverrideEnabled_ = false;
    float mouthOpenY_ = 0.0f;
    float mouthForm_ = 0.0f;

    // ---- 人物互动通道状态 ----
    int idEyeLIdx_ = -1, idEyeRIdx_ = -1;
    float eyeLMin_ = 0.0f, eyeLMax_ = 1.0f, eyeRMin_ = 0.0f, eyeRMax_ = 1.0f;
    int idAngleYIdx_ = -1;
    float interAngleX_ = 0.0f, interAngleY_ = 0.0f, interAngleZ_ = 0.0f, interBodyAngleX_ = 0.0f;
    bool eyeOverrideEnabled_ = false;
    float eyeLeft_ = 1.0f, eyeRight_ = 1.0f;
    // 猫耳根部互动：只保存左右各一个根部参数索引/范围/是否 Physics 输出
    int idEarLeftRoot_ = -1, idEarRightRoot_ = -1;
    float earLeftRootMin_ = -45.0f, earLeftRootMax_ = 45.0f;
    float earRightRootMin_ = -45.0f, earRightRootMax_ = 45.0f;
    bool earRootPhysics_ = false;   // 根部参数是否为 Physics 输出
    bool earInteractionEnabled_ = false;
    float earLeft_ = 0.0f, earRight_ = 0.0f;  // 归一化 -1..1
    int lastEarRootWriteIdx_ = -1;            // 本帧上一个被写根部参数索引（重复写入断言）
    // 抚摸互动安全幅度（度）：不使用完整 ±45 范围
    static constexpr float kEarRootMaxOffset = 2.0f;

    std::vector<ID3D11ShaderResourceView*> textureSrvs_;

    Live2DParameterController controller_;
};

} // namespace aliya




