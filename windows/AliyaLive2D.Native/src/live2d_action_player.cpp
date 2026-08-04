#include "live2d_action_player.hpp"

#include <algorithm>
#include <cmath>

#include "native_log.hpp"

using namespace Live2D::Cubism::Framework;

namespace aliya {

namespace {
constexpr float kBlendOutMin = 0.05f;
} // namespace

void Live2DActionPlayer::Bind(const Live2DActionLibrary* library)
{
    library_ = library;
}

void Live2DActionPlayer::SetModel(CubismModel* model)
{
    model_ = model;
}

std::string Live2DActionPlayer::CurrentActionId() const
{
    return current_ ? current_->id : "";
}

int Live2DActionPlayer::CurrentPriority() const
{
    return current_ ? current_->priority : 0;
}

float Live2DActionPlayer::Duration() const
{
    return current_ ? current_->duration : 0.0f;
}

float Live2DActionPlayer::Ease(const std::string& name, float t)
{
    t = std::max(0.0f, std::min(1.0f, t));
    if (name == "easeIn")
        return t * t;
    if (name == "easeOut")
        return 1.0f - (1.0f - t) * (1.0f - t);
    if (name == "easeInOut")
        return t < 0.5f ? 2.0f * t * t : 1.0f - 2.0f * (1.0f - t) * (1.0f - t);
    // linear
    return t;
}

float Live2DActionPlayer::NormalizeValue(const ActionKeyframe& kf, float pmin, float pdef, float pmax)
{
    // normalized：-1=min, 0=default, 1=max
    if (kf.valueMode == "normalized")
    {
        if (pmax <= pmin)
            return pdef;
        float n = std::max(-1.0f, std::min(1.0f, kf.value));
        // 0..1 线性映射到 min..max（default 作为 0 点，但为简单按 -1..1 均匀映射）
        return pmin + (n + 1.0f) * 0.5f * (pmax - pmin);
    }
    return kf.value;
}

float Live2DActionPlayer::EvaluateKeyframes(const std::vector<ActionKeyframe>& kfs, float t) const
{
    if (kfs.empty())
        return 0.0f;
    // 找 t 所在的段
    if (t <= kfs.front().time)
        return kfs.front().value;
    if (t >= kfs.back().time)
        return kfs.back().value;

    size_t i = 0;
    while (i + 1 < kfs.size() && kfs[i + 1].time < t)
        i++;
    const ActionKeyframe& a = kfs[i];
    const ActionKeyframe& b = kfs[i + 1];
    float span = b.time - a.time;
    float tt = span > 0.0001f ? (t - a.time) / span : 1.0f;
    float e = Ease(a.easing, tt);
    // 归一化在段内插值后再转绝对（对 normalized 简单线性插值归一化值）
    if (a.valueMode == "normalized" || b.valueMode == "normalized")
    {
        float v = a.value + (b.value - a.value) * e;
        // 使用段起点所在通道的范围——这里由调用方传入真实范围较麻烦，
        // 统一在 EvaluateChannels 中转换。
        return v;
    }
    return a.value + (b.value - a.value) * e;
}

bool Live2DActionPlayer::Play(const std::string& id)
{
    if (!library_)
        return false;

    // sleep / wake 为状态动作，不进入 JSON 播放器
    if (id == "sleep" || id == "wake")
        return false;

    const ActionDefinition* def = library_->Find(id);
    if (!def)
    {
        NativeLog::Instance().Warn("Live2DActionPlayer: 未知动作 %s", id.c_str());
        return false;
    }

    // 冷却检查
    auto it = lastPlayed_.find(id);
    if (it != lastPlayed_.end() && (clock_ - it->second) < def->cooldown)
        return false;

    // 重复抑制：当前正在播放同 id 且不可打断时跳过
    if (current_ && current_->id == id && !def->interruptible)
        return false;

    if (current_ && playing_)
    {
        int curPrio = current_->priority;
        if (def->priority > curPrio || (def->priority == curPrio && current_->interruptible))
        {
            // 抢占
            Stop("interrupted_by_" + id);
            StartAction(def);
            return true;
        }
        if (def->priority > 0)
        {
            // 排队（上限 4）
            if (queue_.size() < 4 && std::find(queue_.begin(), queue_.end(), id) == queue_.end())
                queue_.push_back(id);
            return false;
        }
        return false;
    }

    StartAction(def);
    return true;
}

void Live2DActionPlayer::Stop(const std::string& reason)
{
    if (!playing_ && !current_)
        return;
    NativeLog::Instance().Debug("Live2DActionPlayer: 停止 %s（%s）",
                                current_ ? current_->id.c_str() : "?", reason.c_str());
    if (current_)
        lastPlayed_[current_->id] = clock_;
    fadingOut_ = true;
    fadeOutElapsed_ = 0.0f;
}

void Live2DActionPlayer::StartAction(const ActionDefinition* def)
{
    current_ = def;
    elapsed_ = 0.0f;
    loopCounter_ = 0;
    playing_ = true;
    fadingOut_ = false;
    fadeOutElapsed_ = 0.0f;
    runtimes_.clear();
    firedEventIdx_.clear();

    for (const auto& ch : def->channels)
    {
        if (!ch.available)
            continue;
        RuntimeChannel rc;
        rc.keyframes = ch.keyframes;
        rc.output.paramIndex = ch.paramIndex;
        runtimes_[ch.paramIndex] = std::move(rc);
    }
    NativeLog::Instance().Info("Live2DActionPlayer: 播放动作 %s (prio=%d dur=%.2fs loop=%d clock=%.2f)",
                               def->id.c_str(), def->priority, def->duration, def->loop ? 1 : 0, clock_);
}

void Live2DActionPlayer::Update(float delta)
{
    clock_ += delta;

    if (!current_)
        return;

    if (playing_ || fadingOut_)
        elapsed_ += delta;

    // 循环处理
    if (playing_ && !fadingOut_ && current_->loop)
    {
        if (elapsed_ >= current_->duration)
        {
            elapsed_ = std::fmod(elapsed_, current_->duration);
            loopCounter_++;
            firedEventIdx_.clear(); // 循环后事件可重新触发
            if (current_->loopCount > 0 && loopCounter_ >= current_->loopCount)
            {
                elapsed_ = current_->duration;
                Stop("loop_count_reached");
            }
        }
    }

    // 非循环动作结束
    if (playing_ && !fadingOut_ && !current_->loop && elapsed_ >= current_->duration)
    {
        Stop("finished");
    }

    // 淡出完成
    if (fadingOut_)
    {
        fadeOutElapsed_ += delta;
        if (fadeOutElapsed_ >= (current_->blendOut > 0 ? current_->blendOut : kBlendOutMin))
        {
            NativeLog::Instance().Info("Live2DActionPlayer: 淡出完成 %s clock=%.2f", current_->id.c_str(), clock_);
            playing_ = false;
            fadingOut_ = false;
            current_ = nullptr;
            runtimes_.clear();
            // 处理队列
            if (!queue_.empty())
            {
                std::string next = queue_.front();
                queue_.erase(queue_.begin());
                Play(next);
            }
            return;
        }
    }

    if (!current_)
        return;

    // 评估通道
    float t = elapsed_;
    float env = 1.0f;
    if (current_->blendIn > 0.0f)
        env *= std::min(1.0f, elapsed_ / current_->blendIn);
    if (current_->blendOut > 0.0f && !current_->loop)
        env *= std::min(1.0f, (current_->duration - elapsed_) / current_->blendOut);
    if (fadingOut_ && current_->blendOut > 0.0f)
    {
        float f = 1.0f - std::min(1.0f, fadeOutElapsed_ / current_->blendOut);
        env = std::min(env, f);
    }

    for (auto& kv : runtimes_)
    {
        RuntimeChannel& rc = kv.second;
        const ActionChannel* chDef = nullptr;
        for (const auto& c : current_->channels)
        {
            if (c.available && c.paramIndex == kv.first)
            {
                chDef = &c;
                break;
            }
        }
        if (!chDef)
            continue;

        float raw = EvaluateKeyframes(rc.keyframes, t);
        float value = raw;
        if (raw == raw) // NaN 保护
        {
            // 若任一段为 normalized，需要按范围转换。这里按通道范围对整条曲线做近似：
            // 简单起见：若首个关键帧为 normalized，将整条曲线视为归一化曲线。
            if (!chDef->keyframes.empty() && chDef->keyframes.front().valueMode == "normalized")
                value = chDef->pmin + (std::max(-1.0f, std::min(1.0f, raw)) + 1.0f) * 0.5f * (chDef->pmax - chDef->pmin);
            else
                value = raw;
        }

        float w = chDef->weight * env;
        ActionChannelOutput& out = rc.output;
        out.hasOverride = out.hasAdditive = out.hasMultiply = false;
        switch (chDef->blendMode)
        {
        case ActionBlendMode::Override:
            out.hasOverride = true;
            out.overrideValue = value;
            out.overrideWeight = w;
            break;
        case ActionBlendMode::Additive:
            out.hasAdditive = true;
            out.additiveValue = value;
            out.additiveWeight = w;
            break;
        case ActionBlendMode::Multiply:
            out.hasMultiply = true;
            out.multiplyValue = value;
            out.multiplyWeight = w;
            break;
        }
    }

    // 事件
    if (current_->events.empty())
        return;
    size_t evIdx = firedEventIdx_.size();
    for (; evIdx < current_->events.size(); evIdx++)
    {
        const ActionEventDef& ev = current_->events[evIdx];
        if (ev.time <= t)
        {
            ActionEventFired fired;
            fired.actionId = current_->id;
            fired.time = ev.time;
            fired.type = ev.type;
            fired.name = ev.name;
            fired.category = ev.category;
            events_.push_back(std::move(fired));
            firedEventIdx_.push_back(evIdx);
        }
        else
        {
            break; // events 已按时间排序
        }
    }
}

bool Live2DActionPlayer::GetChannelOutput(int paramIndex, ActionChannelOutput& out) const
{
    auto it = runtimes_.find(paramIndex);
    if (it == runtimes_.end())
        return false;
    out = it->second.output;
    return true;
}

void Live2DActionPlayer::DrainEvents(std::vector<ActionEventFired>& out)
{
    if (events_.empty())
        return;
    out.insert(out.end(), events_.begin(), events_.end());
    events_.clear();
}

} // namespace aliya
