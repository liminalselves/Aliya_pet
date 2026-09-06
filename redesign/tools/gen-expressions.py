# -*- coding: utf-8 -*-
"""
Aliya 表情库生成器（重做版模型 aliya(重置) 专用）。

生成标准 Cubism exp3.json 到 redesign/ui/assets/live2d/aliya/expressions/，
由 model3.json 的 FileReferences.Expressions 引用，运行时经
CubismExpressionMotionManager 加性求值（调度顺序：眨眼→表情→呼吸→物理）。

实测参数能力（值域）：
- 眉：LY/RY ±1（抬/压）、LAngle/RAngle ±1（+ 内斜怒眉 / - 外斜挑眉）、
  LForm/RForm ±1（+ 忧愁眉）
- 眼：LOpen/ROpen 0..1、LSmile/RSmile 0..1
- 嘴：MouthForm ±1（+笑/-撇）、MouthOpenY 0..1
- Param33/34/35 会切换整套特殊眼睛，禁止用于可交叉淡化的表情；
  中间值或同时激活会出现小黑点、白眼和重影。
- 脸红：ParamCheek 0..1

设计约束：
- 眼睑使用 Multiply，保留完整闭眼；其他参数使用 Add；
- 眼球（ParamEyeBallX/Y）一律不写：注视偏移（垂眼/回避/斜眼）声明在
  ui/src/gaze.ts 的 EXPRESSION_GAZE，由 GazeController 与指针跟随合成、
  统一平滑与钳制（多写入者曾是 bug之源）；
- 开心与得意显式闭眼，才能显示模型的弯月笑眼；其余用不同开合区分。
- 受击/难过/无语的专用眼型由 face-variant.ts 互斥控制，并隔离普通眼部物理。
- 眉嘴、眼型与轻微头部姿态共同区分表情，不依赖被刘海遮住的细小眉形。
"""

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
EXPR_DIR = os.path.join(HERE, "..", "ui", "assets", "live2d", "aliya", "expressions")

def P(pid, value):
    if pid in ("ParamEyeLOpen", "ParamEyeROpen"):
        return {"Id": pid, "Value": min(1.0, max(0.0, 1.0 + value)), "Blend": "Multiply"}
    return {"Id": pid, "Value": value, "Blend": "Add"}

# ---------- 12 个表情 ----------
# FadeIn/FadeOut 单位秒；注视偏移见 gaze.ts EXPRESSION_GAZE。

EXPRESSIONS = {
    # 中性（空表情，只作占位/清除目标）
    "neutral": {"fade": (0.3, 0.5), "params": []},

    # 开心【签名：闭眼弯月笑 + 大笑嘴；Smile 在睁眼时几乎不可见】
    "happy": {"fade": (0.4, 0.6), "params": [
        P("ParamEyeLSmile", 1.0), P("ParamEyeRSmile", 1.0),
        P("ParamEyeLOpen", -1.0), P("ParamEyeROpen", -1.0),
        P("ParamMouthForm", 1.0),
        P("ParamMouthOpenY", 0.45),
        P("ParamBrowLY", 0.25), P("ParamBrowRY", 0.25),
    ]},

    # 生气【签名：阴影符号 + 怒 V 眉 + 撇嘴】
    "angry": {"fade": (0.25, 0.5), "params": [
        P("Param32", 1.0),
        P("ParamBrowLAngle", 0.9), P("ParamBrowRAngle", 0.9),
        P("ParamBrowLY", -0.85), P("ParamBrowRY", -0.85),
        P("ParamMouthForm", -1.0), P("ParamMouthOpenY", 0.25),
        P("ParamEyeLOpen", -0.2), P("ParamEyeROpen", -0.2),
    ]},

    # 难过【签名：原生流泪眼型（face-variant.ts 独占）+ 深忧愁眉 + 下撇嘴】
    "sad": {"fade": (0.5, 0.8), "params": [
        P("ParamBrowLForm", 1.0), P("ParamBrowRForm", 1.0),
        P("ParamBrowLY", -0.45), P("ParamBrowRY", -0.45),
        P("ParamMouthForm", -0.85),
        P("ParamMouthOpenY", 0.3),
    ]},

    # 惊讶【签名：高挑眉 + 大张嘴 + 瞪眼】
    "surprised": {"fade": (0.15, 0.4), "params": [
        P("ParamBrowLY", 0.95), P("ParamBrowRY", 0.95),
        P("ParamBrowLAngle", -0.45), P("ParamBrowRAngle", -0.45),
        P("ParamMouthOpenY", 0.9),
        P("ParamMouthForm", 0.15),
        P("ParamEyeLOpen", 0.2), P("ParamEyeROpen", 0.2),
    ]},

    # 害羞【签名：腮红 + 半弯月眼 + 回避视线（gaze 偏移 +6,-5）】
    "shy": {"fade": (0.5, 0.8), "params": [
        P("ParamAngleX", 10), P("ParamAngleZ", -5),
        P("ParamCheek", 1.0),
        P("ParamEyeLSmile", 0.4), P("ParamEyeRSmile", 0.4),
        P("ParamEyeLOpen", -0.35), P("ParamEyeROpen", -0.35),
        P("ParamMouthForm", 0.45),
        P("ParamBrowLForm", 0.4), P("ParamBrowRForm", 0.4),
    ]},

    # 困倦【签名：半垂眼 + 下垮眉 + 小张嘴；视线垂下】
    "sleepy": {"fade": (0.6, 0.8), "params": [
        P("ParamAngleY", -8), P("ParamAngleZ", 6),
        P("ParamEyeLOpen", -0.8), P("ParamEyeROpen", -0.8),
        P("ParamMouthOpenY", 0.15),
        P("ParamBrowLY", -0.4), P("ParamBrowRY", -0.4),
        P("ParamMouthForm", -0.1),
    ]},

    # 得意【签名：不对称挑眉 + 斜眼（gaze +5,0）+ 单侧笑眼】
    "smug": {"fade": (0.35, 0.6), "params": [
        P("ParamBrowLY", 0.9), P("ParamBrowRY", -0.2),
        P("ParamBrowLAngle", -0.35), P("ParamBrowRAngle", 0.15),
        P("ParamEyeLSmile", 1.0), P("ParamEyeRSmile", 0.0),
        P("ParamEyeLOpen", -1.0), P("ParamEyeROpen", -0.05),
        P("ParamMouthForm", 0.9),
        P("ParamMouthOpenY", 0.08),
    ]},

    # 无语【签名：死板半垂眼 + 平嘴】
    "speechless": {"fade": (0.3, 0.5), "params": [
        P("ParamMouthForm", -0.5),
        P("ParamBrowLY", -0.18), P("ParamBrowRY", -0.18),
    ]},

    # 担忧【签名：忧愁眉 + 小张嘴 + 回避视线（gaze -5,+2）；
    # 与 sad 的区分：嘴不深撇、眼睑更开、眉毛不全垮】
    "worried": {"fade": (0.5, 0.8), "params": [
        P("ParamAngleZ", -8), P("ParamAngleY", -3),
        P("ParamBrowLForm", 0.75), P("ParamBrowRForm", 0.75),
        P("ParamBrowLY", 0.65), P("ParamBrowRY", 0.3),
        P("ParamBrowLAngle", -0.35), P("ParamBrowRAngle", -0.15),
        P("ParamMouthOpenY", 0.25),
        P("ParamMouthForm", -0.6),
        P("ParamEyeLOpen", -0.08), P("ParamEyeROpen", -0.08),
    ]},

    # 认真【签名：压内眉 + 抿嘴 + 微瞪】
    "serious": {"fade": (0.35, 0.6), "params": [
        P("ParamAngleY", -8),
        P("ParamBrowLAngle", 0.55), P("ParamBrowRAngle", 0.55),
        P("ParamBrowLY", -0.55), P("ParamBrowRY", -0.55),
        P("ParamMouthForm", -0.65),
        P("ParamEyeLOpen", -0.15), P("ParamEyeROpen", -0.15),
    ]},

    # 受击（彩蛋/被戳反应）【签名：原生挤眼（face-variant.ts）+ 挑眉张嘴】
    "hit": {"fade": (0.08, 0.35), "params": [
        P("ParamBrowLY", 0.6), P("ParamBrowRY", 0.6),
        P("ParamMouthOpenY", 0.35),
        P("ParamMouthForm", -0.1),
    ]},
}

def main():
    os.makedirs(EXPR_DIR, exist_ok=True)
    for name, spec in EXPRESSIONS.items():
        data = {
            "Type": "Live2D Expression",
            "FadeInTime": spec["fade"][0],
            "FadeOutTime": spec["fade"][1],
            "Parameters": spec["params"],
        }
        path = os.path.join(EXPR_DIR, f"{name}.exp3.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        print(f"{name}: {len(spec['params'])} params")

if __name__ == "__main__":
    main()
