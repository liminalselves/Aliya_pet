#pragma once

#include <string>
#include <vector>

#include "Model/CubismModel.hpp"

namespace aliya {

// =========================================================
// Live2D 动作数据模型（JSON 定义，运行时绑定模型参数元数据）
// =========================================================

enum class ActionBlendMode {
    Override,   // 覆盖层：与基础值按权重混合
    Additive,   // 附加层：在基础值上叠加
    Multiply    // 乘法层：基础值 * 因子
};

const char* ActionBlendModeName(ActionBlendMode m);

struct ActionKeyframe {
    float time = 0.0f;
    float value = 0.0f;                 // 绝对值或归一化值
    std::string easing = "linear";      // linear / easeIn / easeOut / easeInOut
    std::string valueMode = "absolute"; // absolute | normalized
};

struct ActionChannel {
    std::string parameter;
    ActionBlendMode blendMode = ActionBlendMode::Additive;
    float weight = 1.0f;        // 通道权重 0..1
    bool clampToModelRange = true;
    std::vector<ActionKeyframe> keyframes;

    // 绑定模型时填充
    int paramIndex = -1;
    float pmin = -1.0f, pdef = 0.0f, pmax = 1.0f;
    bool available = false;
    bool warned = false;   // 缺参数只警告一次
};

struct ActionEventDef {
    float time = 0.0f;
    std::string type;      // blink / sound / speech ...
    std::string name;
    std::string category;
};

struct ActionDefinition {
    std::string id;
    float duration = 1.0f;
    bool loop = false;
    int loopCount = 0;          // 0 = 无限循环
    int priority = 10;
    bool interruptible = true;
    float blendIn = 0.12f;
    float blendOut = 0.18f;
    float cooldown = 0.0f;
    std::vector<std::string> tags;
    std::vector<ActionChannel> channels;
    std::vector<ActionEventDef> events;
};

// 已触发事件（Native 排队，托管层轮询）
struct ActionEventFired {
    std::string actionId;
    float time = 0.0f;
    std::string type;
    std::string name;
    std::string category;
};

// =========================================================
// Live2DActionLibrary：加载 Actions 目录下所有动作 JSON，
// 解析并把每个通道绑定到模型真实参数（min/default/max）。
// =========================================================
class Live2DActionLibrary {
public:
    // 加载 utf8Dir 下所有 *.json 动作。缺参数通道自动禁用（只警告一次）。
    // 返回加载成功数量。
    int LoadFromDirectory(const std::string& utf8Dir, Live2D::Cubism::Framework::CubismModel* model);

    const ActionDefinition* Find(const std::string& id) const;
    const std::vector<ActionDefinition>& All() const { return actions_; }

private:
    bool LoadOneFile(const std::string& utf8Path,
                     Live2D::Cubism::Framework::CubismModel* model,
                     ActionDefinition& out, std::string& err);
    void BindActionChannels(ActionDefinition& action,
                            Live2D::Cubism::Framework::CubismModel* model);

    std::vector<ActionDefinition> actions_;
};

} // namespace aliya
