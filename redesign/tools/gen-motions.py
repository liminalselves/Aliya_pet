# -*- coding: utf-8 -*-
"""
Aliya 动作库生成器（重做版模型 aliya(重置) 专用）。

用手写的关键帧表生成 Cubism motion3.json，覆盖
redesign/ui/assets/live2d/aliya/motions/ 下 9 个同名动作文件。

设计约束（重做版模型实测）：
- 手臂参数 ParamArmL01/02、ParamArmR01/02 未绑定变形器（满量程位移≈0），不使用；
  抬手能力在代码侧（pet-model._handRaiseR 通道写手部物理链），见 docs/ACTIONS.md；
- Param33/34/35 会切换特殊眼睛，动作只能写 0 复位，禁止用中间值做效果；
- 头部：ParamAngleX(+右转)/Y(+抬头)/Z(+左倾) ±30，身体 ParamBodyAngle* ±10；
- 运行时无 Idle 动作：saveParameters 会保留动作结束值，因此
  每个动作必须携带「复位曲线」（所有触碰过的参数结束回默认值），
  且每个动作都内置全套面部/头部/眼部平坦复位曲线，自愈被打断的残留；
- 眼球 ParamEyeBallX/Y（值域 ±30，非官方惯例 ±1）：动作携带视线曲线
  （视线跟随不活跃时生效；指针活跃时 CubismLook 加性覆盖，视觉饱和无冲突）；
- 不触碰：ParamCheek（互动系统所有）、ParamBreath（呼吸所有）、
  Param_Angle_Rotation_*（物理输出）、Param7~Param14（猫耳物理输出）。
"""

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
MOTIONS_DIR = os.path.join(HERE, "..", "ui", "assets", "live2d", "aliya", "motions")
DIST_DIR = os.path.join(HERE, "..", "ui", "dist", "live2d", "aliya", "motions")

# ---------- 平坦复位曲线 ----------

def flat(dur, v):
    return [(0.0, v), (dur, v)]

def base_reset(dur):
    """全套复位曲线：面部/头部/身体归零，眼睛回 1（自愈上一动作残留）。"""
    d = {}
    for p in (
        "ParamMouthForm", "ParamMouthOpenY",
        "ParamEyeLSmile", "ParamEyeRSmile",
        "ParamBrowLY", "ParamBrowRY", "ParamBrowLX", "ParamBrowRX",
        "ParamBrowLAngle", "ParamBrowRAngle", "ParamBrowLForm", "ParamBrowRForm",
        "Param32", "Param33", "Param34", "Param35",
        "ParamAngleX", "ParamAngleY", "ParamAngleZ",
        "ParamBodyAngleX", "ParamBodyAngleY", "ParamBodyAngleZ",
        # 眼球也复位：视线跟随在「不活跃且已回中」时跳过写入，
        # 上一动作残留的视线值会冻结，需下一条动作自愈
        "ParamEyeBallX", "ParamEyeBallY",
    ):
        d[p] = flat(dur, 0.0)
    d["ParamEyeLOpen"] = flat(dur, 1.0)
    d["ParamEyeROpen"] = flat(dur, 1.0)
    return d

def both(dur, keys_l, keys_r=None):
    """左右眼同曲线。"""
    return {"ParamEyeLOpen": keys_l, "ParamEyeROpen": keys_r or keys_l}

# ---------- 关键帧 → Segments ----------

def curve_segments(keys):
    """keys: [(t, v), ...] 递增。平坦段发 Linear，其余发 ease-in-out Bezier。"""
    keys = sorted(keys)
    seg = [keys[0][0], keys[0][1]]
    n_seg = 0
    n_pts = 1
    for (t0, v0), (t1, v1) in zip(keys, keys[1:]):
        if abs(v1 - v0) < 1e-9:
            seg += [0, round(t1, 4), round(v1, 4)]
            n_pts += 1
        else:
            d = t1 - t0
            seg += [1, round(t0 + d * 0.42, 4), round(v0, 4),
                    round(t1 - d * 0.42, 4), round(v1, 4),
                    round(t1, 4), round(v1, 4)]
            n_pts += 3
        n_seg += 1
    return seg, n_seg, n_pts

# 自然播放完毕时框架不做完整淡出，最后一帧求值会被 saveParameters 冻结：
# 内容曲线若贴着 Duration 结束，中间衰减值会永久残留（实测生气阴影卡 0.17）。
# 所有内容曲线在 content_dur 前回到默认值，尾部再挂 1.2s 默认姿态
# （≥ model3.json 的 FadeOutTime=1.0），冻结值即默认值，视觉无影响。
TAIL_SECONDS = 1.2

def emit(name, content_dur, motion_curves):
    dur = round(content_dur + TAIL_SECONDS, 3)
    curves_map = base_reset(dur)
    curves_map.update(motion_curves)
    curves = []
    total_seg = 0
    total_pts = 0
    for pid, keys in curves_map.items():
        seg, n_seg, n_pts = curve_segments(keys)
        total_seg += n_seg
        total_pts += n_pts
        curves.append({"Target": "Parameter", "Id": pid, "Segments": seg})
    return {
        "Version": 3,
        "Meta": {
            "Duration": dur,
            "Fps": 30.0,
            "Loop": False,
            "AreBeziersRestricted": False,
            "CurveCount": len(curves),
            "TotalSegmentCount": total_seg,
            "TotalPointCount": total_pts,
            "UserDataCount": 0,
            "TotalUserDataSize": 0,
        },
        "Curves": curves,
    }

# ---------- 9 个动作 ----------

def nod():
    dur = 2.0
    return emit("nod", dur, {
        "ParamAngleY": [(0, 0), (0.30, -11), (0.62, -1.5), (0.94, -10), (1.32, 0), (dur, 0)],
        "ParamBodyAngleY": [(0, 0), (0.34, -3), (0.66, -0.5), (0.98, -2.5), (1.36, 0), (dur, 0)],
        "ParamEyeLOpen": [(0, 1), (0.30, 0.55), (0.62, 1), (0.94, 0.55), (1.32, 1), (dur, 1)],
        "ParamEyeROpen": [(0, 1), (0.30, 0.55), (0.62, 1), (0.94, 0.55), (1.32, 1), (dur, 1)],
        # 视线随点头轻垂（乖巧）
        "ParamEyeBallY": [(0, 0), (0.30, -8), (0.62, 0), (0.94, -7), (1.32, 0), (dur, 0)],
        # 眉随节拍起伏，嘴角渐扬，每次点头轻张嘴
        "ParamBrowLY": [(0, 0), (0.18, 0.3), (0.44, 0.08), (0.80, 0.26), (1.10, 0.05), (1.5, 0), (dur, 0)],
        "ParamBrowRY": [(0, 0), (0.18, 0.3), (0.44, 0.08), (0.80, 0.26), (1.10, 0.05), (1.5, 0), (dur, 0)],
        "ParamMouthForm": [(0, 0), (0.4, 0.25), (1.0, 0.45), (1.6, 0.3), (2.0, 0), (dur, 0)],
        "ParamMouthOpenY": [(0, 0), (0.26, 0.18), (0.42, 0), (0.90, 0.15), (1.08, 0), (dur, 0)],
    })

def sway():
    dur = 4.4
    return emit("sway", dur, {
        "ParamAngleZ": [(0, 0), (1.1, 6), (2.2, 0), (3.3, -6), (dur, 0)],
        "ParamBodyAngleZ": [(0, 0), (1.1, 2.5), (2.2, 0), (3.3, -2.5), (dur, 0)],
        "ParamAngleX": [(0, 0), (1.1, 2), (2.2, 0), (3.3, -2), (dur, 0)],
        "ParamBodyAngleX": [(0, 0), (1.1, 1), (2.2, 0), (3.3, -1), (dur, 0)],
        "ParamEyeLSmile": [(0, 0), (0.6, 0.35), (3.8, 0.35), (dur, 0)],
        "ParamEyeRSmile": [(0, 0), (0.6, 0.35), (3.8, 0.35), (dur, 0)],
        # 视线随摇摆缓缓游移（笑眼 0.35 下幅度收小，防高光顶出）
        "ParamEyeBallX": [(0, 0), (1.1, 5), (2.2, 0), (3.3, -5), (dur, 0)],
        # 眉随节拍呼吸起伏（学习旧版 Hiyori 的节拍眉），嘴角随摆、轻哼
        "ParamBrowLY": [(0, 0), (0.55, 0.22), (1.1, 0), (1.65, 0.22), (2.2, 0), (2.75, 0.2), (3.3, 0), (3.85, 0.18), (dur, 0)],
        "ParamBrowRY": [(0, 0), (0.55, 0.22), (1.1, 0), (1.65, 0.22), (2.2, 0), (2.75, 0.2), (3.3, 0), (3.85, 0.18), (dur, 0)],
        "ParamMouthForm": [(0, 0), (0.8, 0.3), (2.2, 0.45), (3.6, 0.25), (dur, 0)],
        "ParamMouthOpenY": [(0, 0), (0.7, 0.12), (0.95, 0), (1.5, 0.12), (1.75, 0), (2.3, 0.12), (2.55, 0), (3.1, 0.1), (3.35, 0), (dur, 0)],
    })

def shake():
    dur = 2.6
    return emit("shake", dur, {
        "ParamAngleX": [(0, 0), (0.35, 12), (0.85, -12), (1.35, 11), (1.85, -8), (2.3, 0), (dur, 0)],
        "ParamBodyAngleX": [(0, 0), (0.35, 3), (0.85, -3), (1.35, 2.5), (1.85, -2), (2.3, 0), (dur, 0)],
        # 眉随每次摇头加深压低再回弹，嘴角跟随摇头、微张嘴换气
        "ParamBrowLY": [(0, 0), (0.35, -0.35), (0.85, -0.55), (1.35, -0.65), (1.85, -0.5), (2.3, -0.15), (2.6, 0), (dur, 0)],
        "ParamBrowRY": [(0, 0), (0.35, -0.35), (0.85, -0.55), (1.35, -0.65), (1.85, -0.5), (2.3, -0.15), (2.6, 0), (dur, 0)],
        "ParamMouthForm": [(0, 0), (0.35, -0.25), (0.85, -0.45), (1.35, -0.55), (1.85, -0.35), (2.3, -0.1), (2.6, 0), (dur, 0)],
        "ParamMouthOpenY": [(0, 0), (0.3, 0.12), (0.5, 0), (0.8, 0.14), (1.0, 0), (1.3, 0.12), (1.5, 0), (dur, 0)],
        # 视线随头转（AngleX+ 与 EyeBallX+ 同为画面右）
        "ParamEyeBallX": [(0, 0), (0.35, 11), (0.85, -10), (1.35, 9), (1.85, -7), (2.3, 0), (dur, 0)],
    })

def stretch():
    dur = 3.8
    return emit("stretch", dur, {
        "ParamEyeLOpen": [(0, 1), (0.7, 0.1), (2.2, 0.1), (3.0, 1), (dur, 1)],
        "ParamEyeROpen": [(0, 1), (0.7, 0.1), (2.2, 0.1), (3.0, 1), (dur, 1)],
        "ParamEyeLSmile": [(0, 0), (0.7, 0.7), (2.2, 0.7), (3.0, 0), (dur, 0)],
        "ParamEyeRSmile": [(0, 0), (0.7, 0.7), (2.2, 0.7), (3.0, 0), (dur, 0)],
        "ParamAngleY": [(0, 0), (0.7, 8), (2.2, 8), (3.0, -3), (3.4, 1), (dur, 0)],
        "ParamBodyAngleY": [(0, 0), (0.7, -5), (2.2, -5), (3.0, 3), (3.5, 0), (dur, 0)],
        "ParamMouthOpenY": [(0, 0), (0.5, 0.2), (0.9, 0.55), (1.5, 0.6), (2.1, 0.5), (2.6, 0.3), (2.9, 0), (dur, 0)],
        "ParamAngleZ": [(0, 0), (0.7, 4), (2.2, -4), (3.0, 0), (dur, 0)],
        "ParamAngleX": [(0, 0), (3.05, 0), (3.2, 4), (3.35, -4), (3.5, 0), (dur, 0)],
        # 伸展时视线上扬（闭眼期间不可见，睁眼瞬间已回中）
        "ParamEyeBallY": [(0, 0), (0.7, 9), (2.2, 9), (2.9, 0), (dur, 0)],
        # 眉大抬（用力），嘴角先扬后抿再放松；收尾甩头配眉抖
        "ParamBrowLY": [(0, 0), (0.7, 0.65), (2.2, 0.7), (2.9, 0.2), (3.1, 0.35), (3.25, 0.15), (3.45, 0), (dur, 0)],
        "ParamBrowRY": [(0, 0), (0.7, 0.65), (2.2, 0.7), (2.9, 0.2), (3.1, 0.35), (3.25, 0.15), (3.45, 0), (dur, 0)],
        "ParamMouthForm": [(0, 0), (0.6, 0.35), (1.4, -0.15), (2.2, -0.1), (2.9, 0.1), (dur, 0)],
    })

def wave():
    dur = 3.0
    tilt = [(0, 0), (0.4, 8), (0.9, 2), (1.4, 8), (1.9, 2), (2.4, 0), (dur, 0)]
    return emit("wave", dur, {
        "ParamAngleZ": tilt,
        "ParamBodyAngleZ": [(t, v * 0.4) for t, v in tilt],
        "ParamEyeLSmile": [(0, 0), (0.35, 1), (2.3, 1), (2.8, 0), (dur, 0)],
        "ParamEyeRSmile": [(0, 0), (0.35, 1), (2.3, 1), (2.8, 0), (dur, 0)],
        # 嘴：笑意渐强到峰值再收；每个摆动节拍嘴轻张（跟着挥手哼唱）
        "ParamMouthForm": [(0, 0), (0.4, 0.45), (0.9, 0.7), (1.4, 0.9), (1.9, 0.75), (2.4, 0.4), (2.8, 0), (dur, 0)],
        "ParamMouthOpenY": [(0, 0), (0.4, 0.14), (0.62, 0), (0.9, 0.18), (1.12, 0), (1.4, 0.2), (1.62, 0), (1.9, 0.16), (2.12, 0), (2.4, 0.1), (2.7, 0), (dur, 0)],
        # 眉：欢快起伏，峰值处最高
        "ParamBrowLY": [(0, 0), (0.4, 0.3), (0.9, 0.15), (1.4, 0.45), (1.9, 0.2), (2.4, 0.1), (2.8, 0), (dur, 0)],
        "ParamBrowRY": [(0, 0), (0.4, 0.3), (0.9, 0.15), (1.4, 0.45), (1.9, 0.2), (2.4, 0.1), (2.8, 0), (dur, 0)],
        # 满笑眼（弯月）不带注视：瞳孔/高光物理只跟头角与闭眼，不跟眼球，
        # 弯月眼里移瞳会把高光顶出弧线外（实测破相）。注视交给 base_reset 平坦回中。
    })

def doubt():
    dur = 3.2
    hold = lambda v: [(0, 0), (0.5, v), (2.4, v), (3.0, 0), (dur, 0)]
    return emit("doubt", dur, {
        "ParamAngleZ": hold(10),
        "ParamAngleX": hold(3),
        "ParamBrowLY": hold(0.85),
        "ParamBrowRY": hold(-0.25),
        "ParamEyeLOpen": hold(0.8),
        "ParamEyeROpen": hold(0.8),
        "ParamMouthForm": hold(-0.25),
        # 起始「咦？」：嘴先小张再收，挑眉再回落半格（打破静止）
        "ParamMouthOpenY": [(0, 0), (0.22, 0.2), (0.5, 0.02), (2.2, 0.02), (2.9, 0), (dur, 0)],
        "ParamBrowLY": [(0, 0), (0.5, 0.85), (1.4, 0.7), (2.4, 0.85), (3.0, 0), (dur, 0)],
        "ParamBrowRY": [(0, 0), (0.5, -0.25), (1.4, -0.15), (2.4, -0.25), (3.0, 0), (dur, 0)],
        # 疑惑：斜眼瞟向一侧（思考）
        "ParamEyeBallX": hold(11),
        "ParamEyeBallY": hold(5),
    })

def angry():
    dur = 3.0
    hold = lambda v: [(0, 0), (0.35, v), (2.3, v), (2.8, 0), (dur, 0)]
    tremble = [(0, 0), (0.35, 0)]
    t, v = 0.5, 2.5
    while t <= 2.0:
        tremble.append((round(t, 2), v))
        v = -v
        t += 0.15
    tremble += [(2.2, 0), (dur, 0)]
    return emit("angry", dur, {
        "Param32": hold(1.0),
        # 怒眉快速压到位后随颤抖起伏，末段松开（气消）
        "ParamBrowLAngle": [(0, 0), (0.3, -0.85), (1.2, -0.7), (1.8, -0.85), (2.2, -0.4), (2.8, 0), (dur, 0)],
        "ParamBrowRAngle": [(0, 0), (0.3, -0.85), (1.2, -0.7), (1.8, -0.85), (2.2, -0.4), (2.8, 0), (dur, 0)],
        "ParamBrowLY": [(0, 0), (0.3, -0.5), (1.2, -0.4), (1.8, -0.5), (2.2, -0.2), (2.8, 0), (dur, 0)],
        "ParamBrowRY": [(0, 0), (0.3, -0.5), (1.2, -0.4), (1.8, -0.5), (2.2, -0.2), (2.8, 0), (dur, 0)],
        # 嘴角下撇加深，嘟囔三连（幅度递减 = 渐渐消气）
        "ParamMouthForm": [(0, 0), (0.35, -0.5), (1.2, -0.7), (2.0, -0.6), (2.8, 0), (dur, 0)],
        "ParamMouthOpenY": [(0, 0), (0.9, 0), (1.05, 0.3), (1.2, 0), (1.5, 0),
                            (1.65, 0.22), (1.8, 0), (2.1, 0), (2.2, 0.14), (2.32, 0), (dur, 0)],
        "ParamAngleY": hold(-6),
        "ParamAngleZ": tremble,
        # 生气瞪人：视线下压盯过来
        "ParamEyeBallY": hold(-6),
    })

def yawn():
    dur = 4.4
    return emit("yawn", dur, {
        "ParamEyeLOpen": [(0, 1), (0.5, 0.7), (1.2, 0.05), (2.6, 0.05), (3.4, 0.7), (4.0, 1), (dur, 1)],
        "ParamEyeROpen": [(0, 1), (0.5, 0.7), (1.2, 0.05), (2.6, 0.05), (3.4, 0.7), (4.0, 1), (dur, 1)],
        "ParamMouthOpenY": [(0, 0), (0.5, 0.2), (1.2, 0.95), (2.6, 0.9), (3.2, 0.25), (3.6, 0.15), (4.0, 0), (dur, 0)],
        "ParamMouthForm": [(0, 0), (1.0, -0.1), (1.8, -0.3), (2.6, -0.2), (3.4, 0.15), (4.0, 0), (dur, 0)],
        # 眉：吸气时抬高，呵欠中回落，结束后疲惫微垂
        "ParamBrowLY": [(0, 0), (0.6, 0.5), (1.4, 0.15), (2.6, -0.2), (3.6, -0.1), (4.0, 0), (dur, 0)],
        "ParamBrowRY": [(0, 0), (0.6, 0.5), (1.4, 0.15), (2.6, -0.2), (3.6, -0.1), (4.0, 0), (dur, 0)],
        "ParamAngleY": [(0, 0), (0.6, 5), (1.2, 2), (2.6, -2), (3.4, 3), (4.0, 0), (dur, 0)],
        "ParamBodyAngleY": [(0, 0), (0.6, -3), (2.6, -3), (3.4, 1), (4.0, 0), (dur, 0)],
        "ParamAngleZ": [(0, 0), (1.2, 3), (2.6, 3), (4.0, 0), (dur, 0)],
        # 打哈欠时视线自然上飘
        "ParamEyeBallY": [(0, 0), (1.2, 9), (2.6, 9), (3.6, 0), (dur, 0)],
    })

def walk():
    dur = 2.8
    rock = [(0, 0)]
    bob = [(0, 0)]
    step = 0.35
    n = 7
    for k in range(1, n + 1):
        rock.append((round(step * k, 3), 5 if k % 2 == 1 else (0 if k < n else 0)))
    rock = [(0, 0), (0.35, 5), (0.7, 0), (1.05, -5), (1.4, 0), (1.75, 5), (2.1, 0), (2.45, -3), (dur, 0)]
    for k in range(1, 8):
        bob.append((round(0.35 * k - 0.175, 3), -2))
        bob.append((round(0.35 * k, 3), 0))
    bob.append((dur, 0))
    return emit("walk", dur, {
        "ParamBodyAngleZ": rock,
        "ParamAngleZ": [(t, -v * 0.6) for t, v in rock],
        "ParamBodyAngleY": bob,
        "ParamBodyAngleX": [(0, 0), (0.7, 2), (1.4, 0), (2.1, -2), (dur, 0)],
        "ParamAngleY": [(0, 0), (0.4, -2.5), (2.4, -2.5), (dur, 0)],
        "ParamEyeLSmile": [(0, 0), (0.4, 0.4), (2.4, 0.4), (dur, 0)],
        "ParamEyeRSmile": [(0, 0), (0.4, 0.4), (2.4, 0.4), (dur, 0)],
        # 哼歌：每步嘴轻张收，嘴角轻扬；眉随步伐小幅起伏
        "ParamMouthForm": [(0, 0), (0.5, 0.3), (1.4, 0.45), (2.3, 0.3), (dur, 0)],
        "ParamMouthOpenY": [(0, 0), (0.18, 0.12), (0.35, 0), (0.53, 0.12), (0.7, 0), (0.88, 0.12), (1.05, 0),
                            (1.23, 0.12), (1.4, 0), (1.58, 0.12), (1.75, 0), (1.93, 0.12), (2.1, 0),
                            (2.28, 0.1), (2.45, 0), (dur, 0)],
        "ParamBrowLY": [(0, 0), (0.35, 0.18), (0.7, 0.05), (1.05, 0.18), (1.4, 0.05), (1.75, 0.18), (2.1, 0.05), (2.45, 0.1), (dur, 0)],
        "ParamBrowRY": [(0, 0), (0.35, 0.18), (0.7, 0.05), (1.05, 0.18), (1.4, 0.05), (1.75, 0.18), (2.1, 0.05), (2.45, 0.1), (dur, 0)],
        # 走路时视线随步子轻轻左右看（笑眼 0.4 下幅度收小）
        "ParamEyeBallX": [(0, 0), (0.35, 4), (1.05, -4), (1.75, 4), (2.45, -3), (dur, 0)],
    })

GENERATORS = {
    "nod": nod, "sway": sway, "shake": shake, "stretch": stretch,
    "wave": wave, "doubt": doubt, "angry": angry, "yawn": yawn, "walk": walk,
}

def main():
    for name, gen in GENERATORS.items():
        data = gen()
        text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
        for base in (MOTIONS_DIR, DIST_DIR):
            os.makedirs(base, exist_ok=True)
            path = os.path.join(base, f"{name}.motion3.json")
            with open(path, "w", encoding="utf-8") as f:
                f.write(text)
        m = data["Meta"]
        print(f"{name}: dur={m['Duration']} curves={m['CurveCount']} "
              f"segs={m['TotalSegmentCount']} pts={m['TotalPointCount']}")

if __name__ == "__main__":
    main()
