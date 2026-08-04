#include "live2d_action_library.hpp"

#include <algorithm>
#include <cctype>
#include <cstring>
#include <windows.h>


#include "CubismFramework.hpp"
#include "Id/CubismIdManager.hpp"
#include "Utils/CubismJson.hpp"
#include "live2d_asset_loader.hpp"
#include "native_log.hpp"

using namespace Live2D::Cubism::Framework;
using namespace Live2D::Cubism::Framework::Utils;

namespace aliya {

namespace {
using JValue = Value;

// 通用 JSON 读取助手
inline float JFloat(JValue& v, const char* key, float def)
{
    if (!v.IsMap())
        return def;
    JValue& f = v[key];
    return f.IsNull() ? def : f.ToFloat(def);
}
inline int JInt(JValue& v, const char* key, int def)
{
    if (!v.IsMap())
        return def;
    JValue& f = v[key];
    return f.IsNull() ? def : f.ToInt(def);
}
inline bool JBool(JValue& v, const char* key, bool def)
{
    if (!v.IsMap())
        return def;
    JValue& f = v[key];
    return f.IsNull() ? def : (f.ToBoolean(def) != 0);
}
inline std::string JStr(JValue& v, const char* key, const std::string& def = "")
{
    if (!v.IsMap())
        return def;
    JValue& f = v[key];
    if (f.IsNull() || !f.IsString())
        return def;
    return f.GetString("").GetRawString();
}

ActionBlendMode ParseBlendMode(const std::string& s, ActionBlendMode def)
{
    std::string lower = s;
    std::transform(lower.begin(), lower.end(), lower.begin(), ::tolower);
    if (lower == "override") return ActionBlendMode::Override;
    if (lower == "multiply") return ActionBlendMode::Multiply;
    if (lower == "additive") return ActionBlendMode::Additive;
    return def;
}
} // namespace

const char* ActionBlendModeName(ActionBlendMode m)
{
    switch (m)
    {
    case ActionBlendMode::Override: return "override";
    case ActionBlendMode::Additive: return "additive";
    case ActionBlendMode::Multiply: return "multiply";
    }
    return "additive";
}

int Live2DActionLibrary::LoadFromDirectory(const std::string& utf8Dir,
                                           CubismModel* model)
{
    actions_.clear();
    if (utf8Dir.empty() || !model)
        return 0;

    // 枚举目录下 *.json
    std::vector<std::string> files;
    std::string pattern = utf8Dir;
    if (!pattern.empty() && pattern.back() != '\\' && pattern.back() != '/')
        pattern += "\\";
    pattern += "*.json";

    WIN32_FIND_DATAA fd = {};
    HANDLE hFind = FindFirstFileA(pattern.c_str(), &fd);
    if (hFind == INVALID_HANDLE_VALUE)
    {
        NativeLog::Instance().Warn("Live2DActionLibrary: 动作目录不存在或为空 %s", utf8Dir.c_str());
        return 0;
    }
    do
    {
        if (!(fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY))
            files.push_back(fd.cFileName);
    } while (FindNextFileA(hFind, &fd));
    FindClose(hFind);
    std::sort(files.begin(), files.end());

    int loaded = 0;
    for (const auto& name : files)
    {
        std::string path = utf8Dir + "\\" + name;
        ActionDefinition def;
        std::string err;
        if (LoadOneFile(path, model, def, err))
        {
            if (Find(def.id.c_str()) != nullptr)
            {
                NativeLog::Instance().Warn("Live2DActionLibrary: 重复动作 id=%s（%s）已跳过", def.id.c_str(), name.c_str());
                continue;
            }
            actions_.push_back(std::move(def));
            loaded++;
        }
        else
        {
            NativeLog::Instance().Warn("Live2DActionLibrary: 动作加载失败 %s : %s", path.c_str(), err.c_str());
        }
    }
    NativeLog::Instance().Info("Live2DActionLibrary: 加载 %d 个动作（%s）", loaded, utf8Dir.c_str());
    return loaded;
}

const ActionDefinition* Live2DActionLibrary::Find(const std::string& id) const
{
    for (const auto& a : actions_)
        if (a.id == id)
            return &a;
    return nullptr;
}

bool Live2DActionLibrary::LoadOneFile(const std::string& utf8Path,
                                      CubismModel* model,
                                      ActionDefinition& out, std::string& err)
{
    std::vector<char> bytes;
    if (!ReadFileToBytes(utf8Path, bytes) || bytes.empty())
    {
        err = "文件读取失败";
        return false;
    }

    CubismJson* json = CubismJson::Create(reinterpret_cast<const csmByte*>(bytes.data()),
                                          static_cast<csmSizeInt>(bytes.size()));
    if (!json)
    {
        err = "JSON 解析失败";
        return false;
    }
    JValue& root = json->GetRoot();
    if (root.IsNull() || !root.IsMap())
    {
        CubismJson::Delete(json);
        err = "根节点不是对象";
        return false;
    }

    out.id = JStr(root, "id");
    if (out.id.empty())
    {
        CubismJson::Delete(json);
        err = "缺少 id";
        return false;
    }
    out.duration = std::max(0.05f, JFloat(root, "duration", 1.0f));
    out.loop = JBool(root, "loop", false);
    out.loopCount = JInt(root, "loopCount", 0);
    out.priority = JInt(root, "priority", 10);
    out.interruptible = JBool(root, "interruptible", true);
    out.blendIn = std::max(0.0f, JFloat(root, "blendIn", 0.12f));
    out.blendOut = std::max(0.0f, JFloat(root, "blendOut", 0.18f));
    out.cooldown = std::max(0.0f, JFloat(root, "cooldown", 0.0f));

    // tags
    JValue& tags = root["tags"];
    if (tags.IsArray())
    {
        for (csmInt32 i = 0; i < tags.GetSize(); i++)
            out.tags.push_back(tags[i].GetString("").GetRawString());
    }

    // channels
    JValue& channels = root["channels"];
    if (channels.IsArray())
    {
        for (csmInt32 i = 0; i < channels.GetSize(); i++)
        {
            JValue& c = channels[i];
            ActionChannel ch;
            ch.parameter = JStr(c, "parameter");
            ch.blendMode = ParseBlendMode(JStr(c, "blendMode", "additive"), ActionBlendMode::Additive);
            ch.weight = std::max(0.0f, std::min(1.0f, JFloat(c, "weight", 1.0f)));
            ch.clampToModelRange = JBool(c, "clampToModelRange", true);

            JValue& kfs = c["keyframes"];
            if (kfs.IsArray())
            {
                for (csmInt32 k = 0; k < kfs.GetSize(); k++)
                {
                    JValue& kv = kfs[k];
                    ActionKeyframe kf;
                    kf.time = std::max(0.0f, JFloat(kv, "time", 0.0f));
                    kf.value = JFloat(kv, "value", 0.0f);
                    kf.easing = JStr(kv, "easing", "linear");
                    kf.valueMode = JStr(kv, "valueMode", "absolute");
                    ch.keyframes.push_back(kf);
                }
                std::sort(ch.keyframes.begin(), ch.keyframes.end(),
                          [](const ActionKeyframe& a, const ActionKeyframe& b) { return a.time < b.time; });
            }
            if (ch.parameter.empty())
            {
                NativeLog::Instance().Warn("Live2DActionLibrary: 动作 %s 通道缺少 parameter，已跳过", out.id.c_str());
                continue;
            }
            out.channels.push_back(std::move(ch));
        }
    }

    // events
    JValue& evs = root["events"];
    if (evs.IsArray())
    {
        for (csmInt32 i = 0; i < evs.GetSize(); i++)
        {
            JValue& e = evs[i];
            ActionEventDef ev;
            ev.time = std::max(0.0f, JFloat(e, "time", 0.0f));
            ev.type = JStr(e, "type");
            ev.name = JStr(e, "name");
            ev.category = JStr(e, "category");
            if (ev.type.empty())
                continue;
            out.events.push_back(ev);
        }
        std::sort(out.events.begin(), out.events.end(),
                  [](const ActionEventDef& a, const ActionEventDef& b) { return a.time < b.time; });
    }

    CubismJson::Delete(json);
    BindActionChannels(out, model);
    return true;
}

void Live2DActionLibrary::BindActionChannels(ActionDefinition& action, CubismModel* model)
{
    CubismIdManager* idm = CubismFramework::GetIdManager();
    int disabled = 0;
    for (auto& ch : action.channels)
    {
        ch.paramIndex = model->GetParameterIndex(idm->GetId(ch.parameter.c_str()));
        if (ch.paramIndex < 0)
        {
            ch.available = false;
            disabled++;
            if (!ch.warned)
            {
                NativeLog::Instance().Warn("Live2DActionLibrary: 动作 %s 参数不存在 %s（通道禁用）",
                                           action.id.c_str(), ch.parameter.c_str());
                ch.warned = true;
            }
            continue;
        }
        ch.available = true;
        ch.pmin = model->GetParameterMinimumValue(static_cast<csmUint32>(ch.paramIndex));
        ch.pdef = model->GetParameterDefaultValue(static_cast<csmUint32>(ch.paramIndex));
        ch.pmax = model->GetParameterMaximumValue(static_cast<csmUint32>(ch.paramIndex));
    }
    if (disabled > 0)
        NativeLog::Instance().Info("Live2DActionLibrary: 动作 %s 有 %d 个通道因参数缺失被禁用", action.id.c_str(), disabled);
}

} // namespace aliya
