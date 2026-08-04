#pragma once

#include <map>
#include <string>
#include <vector>

#include "live2d_action_library.hpp"

namespace aliya {

// 单个参数通道的动作输出（供控制器合成）
struct ActionChannelOutput {
    int paramIndex = -1;
    bool hasOverride = false;
    float overrideValue = 0.0f;   // 参数单位（绝对）
    float overrideWeight = 0.0f;  // 通道权重 * 包络
    bool hasAdditive = false;
    float additiveValue = 0.0f;
    float additiveWeight = 0.0f;
    bool hasMultiply = false;
    float multiplyValue = 1.0f;
    float multiplyWeight = 0.0f;
};

// Live2DActionPlayer：播放、优先级、冷却、排队、事件。
// 每帧 Update(delta) 推进动作，评估各通道关键帧，输出到 channels 映射。
class Live2DActionPlayer {
public:
    void Bind(const Live2DActionLibrary* library);
    void SetModel(Live2D::Cubism::Framework::CubismModel* model);

    // 尝试播放动作。返回是否真正开始（优先级/冷却/重复抑制/排队）。
    bool Play(const std::string& id);
    // 强制停止（reason 记录到日志）。带 blendOut 淡出。
    void Stop(const std::string& reason);

    // 每帧推进；同时推进全局时钟（用于冷却）。
    void Update(float delta);

    bool IsPlaying() const { return playing_; }
    std::string CurrentActionId() const;
    int CurrentPriority() const;
    float Elapsed() const { return elapsed_; }
    float Duration() const;

    // 参数合成输出（paramIndex 不存在时返回 false）
    bool GetChannelOutput(int paramIndex, ActionChannelOutput& out) const;

    // 排队状态
    int QueueSize() const { return static_cast<int>(queue_.size()); }
    void ClearQueue() { queue_.clear(); }

    // 事件：取走并清空
    void DrainEvents(std::vector<ActionEventFired>& out);

    // 测试辅助
    const ActionDefinition* CurrentAction() const { return current_; }
    float Clock() const { return clock_; }

private:
    struct RuntimeChannel {
        ActionChannelOutput output;
        std::vector<ActionKeyframe> keyframes; // 拷贝，便于运行时
    };

    void StartAction(const ActionDefinition* def);
    void EvaluateChannels(float t);
    float EvaluateKeyframes(const std::vector<ActionKeyframe>& kfs, float t) const;
    static float Ease(const std::string& name, float t);
    static float NormalizeValue(const ActionKeyframe& kf, float pmin, float pdef, float pmax);

    const Live2DActionLibrary* library_ = nullptr;
    Live2D::Cubism::Framework::CubismModel* model_ = nullptr;

    const ActionDefinition* current_ = nullptr;
    float elapsed_ = 0.0f;
    bool playing_ = false;
    bool fadingOut_ = false;   // Stop 后淡出
    float fadeOutElapsed_ = 0.0f;
    int loopCounter_ = 0;

    std::map<int, RuntimeChannel> runtimes_;
    std::vector<ActionEventFired> events_;
    std::vector<size_t> firedEventIdx_;

    std::vector<std::string> queue_;
    float clock_ = 0.0f;
    std::map<std::string, float> lastPlayed_;
    std::map<std::string, int> playCount_;
};

} // namespace aliya
