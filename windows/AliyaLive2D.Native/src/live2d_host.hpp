#pragma once

#include <string>
#include <memory>
#include <mutex>
#include <atomic>

#include <windows.h>

#include "CubismFramework.hpp"
#include "aliya_live2d.h"
#include "live2d_device_manager.hpp"
#include "live2d_model.hpp"

namespace aliya {

// Cubism Framework 内存分配器
class CubismAllocator : public Live2D::Cubism::Framework::ICubismAllocator {
public:
    void* Allocate(const Live2D::Cubism::Framework::csmSizeType size) override;
    void Deallocate(void* memory) override;
    void* AllocateAligned(const Live2D::Cubism::Framework::csmSizeType size, const Live2D::Cubism::Framework::csmUint32 alignment) override;
    void DeallocateAligned(void* alignedMemory) override;
};

// Native 宿主生命周期状态。
// 所有导出函数都会校验状态：Stopping/Destroyed/Failed 下拒绝 Update/Render/Readback 等调用。
enum class HostState {
    Created,       // Create 成功，尚未初始化
    Initializing,  // 正在创建设备/加载模型
    Ready,         // 设备+模型+渲染目标就绪，可 Update/Render
    Paused,        // 暂停（保留资源）
    Failed,        // 初始化失败（仅允许 Destroy / GetLastError / GetInfo）
    Destroyed      // 已销毁（不允许任何调用）
};

// 一个 Live2D 宿主实例。
class Live2DHost {
public:
    Live2DHost();
    ~Live2DHost();

    // 全局 Framework 引用计数
    static void AcquireFramework();
    static void ReleaseFramework();

    // ---- 生命周期操作 ----
    bool SetAssetDirectory(const std::string& utf8Root);
    bool LoadModel(const std::string& utf8ModelJsonPath);
    bool AttachWindow(HWND hwnd, int widthPx, int heightPx);
    bool SetViewport(int widthPx, int heightPx);
    bool Update(float deltaSeconds);
    bool Render();
    bool CopyFramePixels(unsigned char* dest, int destStride);
    bool Pause();
    bool Resume();

    // ---- 参数控制 ----
    bool SetScale(float scale);
    bool SetOpacity(float opacity);
    bool SetState(const std::string& state, float intensity);
    bool PlayAction(const std::string& action);
bool SetLookTarget(float x01, float y01);
    bool SetGazeRawInput(float x, float y);
    bool SetGazeHeadRange(float x, float y, float z);
    bool GetGazeHeadRange(float* x, float* y, float* z) const;
    bool SetGazeHeadFollowAmount(float amount);
    bool GetGazeHeadFollowAmount(float* outCurrent, float* outTarget) const;
    bool GetGazeDiagnostics(AliyaLive2DGazeDiagnostics* out) const;
    bool ClearLookTarget();
    bool SetLookAtEnabled(bool enabled);
    bool SetGazeSpeed(float multiplier);    bool SetPhysicsStrength(float strength);
    bool SetGazeIdleTimeout(float seconds);    bool SetMouseIdleTimeout(float seconds);
    // 物理输入增益 / 输出倍率（与可见姿态分离）
    bool SetPhysicsInputGain(float headGain, float bodyGain);
    bool SetPhysicsOutputGain(float gain);
    // 物理输出幅度（0.0~2.0，与输入增益/输出倍率完全分离）
    bool SetPhysicsOutputAmplitude(float amplitude);
    float GetPhysicsOutputAmplitudeCurrent() const;
    float GetPhysicsOutputAmplitudeTarget() const;
    bool SetPhysicsEnabled(bool enabled);
    bool SetPhysicsTestInput(bool enabled, float angleX, float angleZ, float bodyAngleX, float bodyAngleZ);
    float GetHeadInputGainCurrent() const;
    float GetHeadInputGainTarget() const;
    float GetBodyInputGainCurrent() const;
    float GetBodyInputGainTarget() const;
    float GetPhysicsOutputGainCurrent() const;
    float GetPhysicsOutputGainTarget() const;
    bool GetPhysicsDriveInfo(AliyaLive2DPhysicsDriveInfo* out) const;
    // 诊断 getter：物理强度目标/当前、静止超时、静止已持续
    float GetPhysicsStrengthTarget() const;
    float GetPhysicsStrengthCurrent() const;
    float GetMouseIdleTimeout() const;
    float GetMouseIdleElapsed() const;
    int GetGazeActivityState() const;
    // 获取参数控制器（用于诊断导出）
    class Live2DParameterController& GetController();
bool SetLipSyncValue(float value);
    // 模型是否包含 ParamMouthOpenY（口型可用性）
    bool LipSyncSupported() const;
    // 说话嘴型覆盖通道：独立写入，最终值在 model->Update() 前应用
    bool SetMouthOverride(bool enabled, float openY, float form);
    bool MouthParamInfo(AliyaLive2DMouthParamInfo* out) const;
    // 人物互动通道：头部/身体临时附加偏移、抚摸闭眼、猫耳附加偏移
    bool SetInteractionOffsets(float angleX, float angleY, float angleZ, float bodyAngleX);
    bool SetEyeOverride(bool enabled, float leftOpen, float rightOpen);
    bool SetEarInteraction(bool enabled, float leftNorm, float rightNorm);
    bool SetPettingLookAtReduction(bool enabled);
    bool InteractionParamInfo(AliyaLive2DInteractionParamInfo* out) const;
    bool ListEarParams(char* out, int outSize) const;
    bool HitTest(float xPx, float yPx) const;
    bool GetInfo(AliyaLive2DModelInfo* info) const;
    bool ProfileStages(std::string& outText);

    // ---- 诊断 / 测试 ----
    bool GetParameterValue(const char* id, float& outValue);
    bool SetParameterValue(const char* id, float value);
    bool ForceBlink();
    bool GetBlinkInfo(AliyaLive2DBlinkInfo* outInfo);
    bool ListActions(char* out, int outSize) const;
    bool GetActionInfo(AliyaLive2DActionInfo* out) const;
    bool PollActionEvents(char* out, int outSize);

    // ---- 查询 ----
    HostState GetState() const;
    bool Ready() const;
    const std::string& LastError() const { return lastError_; }
    void SetLastError(const std::string& error) { lastError_ = error; }
    float Opacity() const { return opacity_; }

private:
    // 线程安全的最新输入快照：托管层事件线程只写快照，Native 每帧 Update 开头读取一次。
    struct GazeInputSnapshot {
        float x = 0.5f, y = 0.5f;
        bool valid = false;
    };
    mutable std::mutex inputMutex_;
    GazeInputSnapshot gazeInput_;

    bool EnsureDevices();
    void DestroyAll();
    void SetState(HostState s);
    static const char* StateName(HostState s);

    Live2DDeviceManager devices_;
    std::unique_ptr<Live2DModel> model_;
    HWND parentHwnd_ = nullptr;
    int viewportW_ = 0;
    int viewportH_ = 0;
    float opacity_ = 1.0f;
    std::atomic<HostState> state_{ HostState::Created };
    bool paused_ = false;
    std::string lastError_;
    std::mutex lifecycleMutex_;   // 保护状态转换与资源生命周期
};

} // namespace aliya





