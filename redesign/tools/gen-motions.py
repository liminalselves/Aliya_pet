# -*- coding: utf-8 -*-
"""
Aliya 动作库生成器（重做版模型 aliya(重置) 专用）。

用手写的关键帧表生成 Cubism motion3.json，覆盖
redesign/ui/assets/live2d/aliya/motions/ 下的同名动作文件。

设计约束（重做版模型实测）：
- PET 版手臂已绑定；shy_sway 用前臂内折近似背手，cheerful_bounce 用小幅协同摆臂，其余动作归零；
  挥手由 HandRaiseChannel 驱动 Param30/31/36（旧版回退五段链），见 docs/ACTIONS.md；
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
    """全套复位曲线：面部/头身/手臂归零，眼睛回 1（自愈上一动作残留）。"""
    d = {}
    for p in (
        "ParamMouthForm", "ParamMouthOpenY",
        "ParamEyeLSmile", "ParamEyeRSmile",
        "ParamBrowLY", "ParamBrowRY", "ParamBrowLX", "ParamBrowRX",
        "ParamBrowLAngle", "ParamBrowRAngle", "ParamBrowLForm", "ParamBrowRForm",
        "Param32", "Param33", "Param34", "Param35",
        "ParamAngleX", "ParamAngleY", "ParamAngleZ",
        "ParamBodyAngleX", "ParamBodyAngleY", "ParamBodyAngleZ",
        # shy_sway 首次直接使用手臂；所有接替动作都必须释放被打断的收臂姿态
        "ParamArmL01", "ParamArmL02", "ParamArmR01", "ParamArmR02",
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

def smooth_curve_segments(keys):
    """shy_sway / cheerful_bounce 的保形 C1 Bezier：经过中间姿态不停顿，极值/保持处才减速。

    时间控制点放在 1/3、2/3，共用加权调和切线；平坦/反向处切线归零，
    不越过相邻关键帧的取值范围。首尾速度为零，安全接入默认姿态和尾垫。
    其他动作仍使用原 curve_segments，不改变既有节奏。
    """
    keys = sorted(keys)
    gaps = [b[0] - a[0] for a, b in zip(keys, keys[1:])]
    slopes = [(b[1] - a[1]) / gap for a, b, gap in zip(keys, keys[1:], gaps)]
    tangents = [0.0] * len(keys)
    for i in range(1, len(keys) - 1):
        before, after = slopes[i - 1], slopes[i]
        if before * after > 0:
            w1 = 2 * gaps[i] + gaps[i - 1]
            w2 = gaps[i] + 2 * gaps[i - 1]
            tangents[i] = (w1 + w2) / (w1 / before + w2 / after)
    segments = [keys[0][0], keys[0][1]]
    points = 1
    for i, ((t0, v0), (t1, v1)) in enumerate(zip(keys, keys[1:])):
        if abs(v1 - v0) < 1e-9:
            segments += [0, round(t1, 4), round(v1, 4)]
            points += 1
        else:
            third = gaps[i] / 3
            segments += [1, round(t0 + third, 4), round(v0 + third * tangents[i], 4),
                         round(t1 - third, 4), round(v1 - third * tangents[i + 1], 4),
                         round(t1, 4), round(v1, 4)]
            points += 3
    return segments, len(gaps), points


# 自然播放完毕时框架不做完整淡出，最后一帧求值会被 saveParameters 冻结：
# 内容曲线若贴着 Duration 结束，中间衰减值会永久残留（实测生气阴影卡 0.17）。
# 所有内容曲线在 content_dur 前回到默认值，尾部再挂 1.2s 默认姿态
# （≥ model3.json 的 FadeOutTime=1.0），冻结值即默认值，视觉无影响。
TAIL_SECONDS = 1.2

def emit(name, content_dur, motion_curves, *, smooth=False):
    dur = round(content_dur + TAIL_SECONDS, 3)
    curves_map = base_reset(dur)
    curves_map.update(motion_curves)
    curves = []
    total_seg = 0
    total_pts = 0
    for pid, keys in curves_map.items():
        seg, n_seg, n_pts = (smooth_curve_segments if smooth else curve_segments)(keys)
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

# ---------- 原有动作 ----------

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
        # 完整闭眼：0.1 仍会露出紫色虹膜，叠加笑眼后形成夹层。
        "ParamEyeLOpen": [(0, 1), (0.7, 0), (2.2, 0), (3.0, 1), (dur, 1)],
        "ParamEyeROpen": [(0, 1), (0.7, 0), (2.2, 0), (3.0, 1), (dur, 1)],
        "ParamEyeLSmile": [(0, 0), (0.7, 0.7), (2.2, 0.7), (3.0, 0), (dur, 0)],
        "ParamEyeRSmile": [(0, 0), (0.7, 0.7), (2.2, 0.7), (3.0, 0), (dur, 0)],
        "ParamAngleY": [(0, 0), (0.7, 8), (2.2, 8), (3.0, -3), (3.4, 1), (dur, 0)],
        "ParamBodyAngleY": [(0, 0), (0.7, -5), (2.2, -5), (3.0, 3), (3.5, 0), (dur, 0)],
        "ParamMouthOpenY": [(0, 0), (0.5, 0.2), (0.9, 0.55), (1.5, 0.6), (2.1, 0.5), (2.6, 0.3), (2.9, 0), (dur, 0)],
        "ParamAngleZ": [(0, 0), (0.7, 4), (2.2, -4), (3.0, 0), (dur, 0)],
        "ParamAngleX": [(0, 0), (3.05, 0), (3.2, 4), (3.35, -4), (3.5, 0), (dur, 0)],
        # 闭合笑眼不移瞳；使用 base_reset 回中，开合过渡也不把高光顶出。
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
        "ParamEyeLOpen": [(0, 1), (0.5, 0.8), (2.4, 0.8), (3.0, 1), (dur, 1)],
        "ParamEyeROpen": [(0, 1), (0.5, 0.8), (2.4, 0.8), (3.0, 1), (dur, 1)],
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

# ---------- 日常与对话演出（沿用手臂通道；不写腮红或物理输出） ----------

def cheerful_bounce():
    """蓄势 → 两次递减弹动 → 小回弹；仅上半身俯仰，不模拟离地跳跃。"""
    dur = 2.9
    return emit("cheerful_bounce", dur, {
        # 躯干先发力、头稍后跟上；间隔递短、幅度递减，保留轻快节奏
        "ParamBodyAngleY": [(0, 0), (0.32, 2.08), (0.67, -3.38), (1.02, 1.69), (1.32, -2.34), (1.64, 1.04), (1.92, -0.845), (2.25, 0.325), (2.65, 0), (dur, 0)],
        "ParamAngleY": [(0, 0), (0.36, -3.9), (0.76, 7.15), (1.12, -3.12), (1.43, 4.94), (1.74, -1.56), (2.05, 1.69), (2.4, -0.39), (dur, 0)],
        "ParamBodyAngleZ": [(0, 0), (0.4, -0.52), (0.85, 1.3), (1.38, -0.845), (2, 0.39), (2.6, 0), (dur, 0)],
        "ParamAngleZ": [(0, 0), (0.45, -1.3), (0.92, 2.6), (1.5, -1.82), (2.1, 0.78), (dur, 0)],
        # 手臂只辅助弹动，前臂略迟于躯干；不模拟抬手跳跃。
        "ParamArmL01": [(0, 0), (0.34, -0.5), (0.71, 1.4), (1.07, -0.6), (1.38, 1), (1.8, -0.3), (2.15, 0.35), (2.65, 0), (dur, 0)],
        "ParamArmR01": [(0, 0), (0.38, -0.45), (0.75, 1.25), (1.1, -0.5), (1.42, 0.9), (1.84, -0.25), (2.2, 0.3), (2.68, 0), (dur, 0)],
        "ParamArmL02": [(0, 0), (0.42, -0.4), (0.8, 1.8), (1.16, -0.65), (1.48, 1.2), (1.9, -0.25), (2.25, 0.3), (2.72, 0), (dur, 0)],
        "ParamArmR02": [(0, 0), (0.46, -0.35), (0.84, 1.6), (1.2, -0.55), (1.52, 1.1), (1.94, -0.2), (2.3, 0.25), (2.75, 0), (dur, 0)],
        # 笑眼期间眼球由 base_reset 固定回中，避免高光跑出眼弧
        "ParamEyeLSmile": [(0, 0), (0.35, 0.25), (0.78, 0.75), (1.18, 0.55), (1.5, 0.68), (2.05, 0.4), (2.5, 0.12), (dur, 0)],
        "ParamEyeRSmile": [(0, 0), (0.35, 0.25), (0.78, 0.75), (1.18, 0.55), (1.5, 0.68), (2.05, 0.4), (2.5, 0.12), (dur, 0)],
        **both(dur, [(0, 1), (0.35, 0.85), (0.78, 1), (1.12, 0.9), (1.45, 1), (2.1, 0.95), (dur, 1)]),
        "ParamBrowLY": [(0, 0), (0.32, 0.12), (0.7, 0.48), (1.08, 0.18), (1.4, 0.36), (1.75, 0.12), (2.05, 0.2), (2.5, 0.05), (dur, 0)],
        "ParamBrowRY": [(0, 0), (0.32, 0.12), (0.7, 0.48), (1.08, 0.18), (1.4, 0.36), (1.75, 0.12), (2.05, 0.2), (2.5, 0.05), (dur, 0)],
        "ParamMouthForm": [(0, 0), (0.3, 0.2), (0.78, 0.65), (1.15, 0.5), (1.48, 0.6), (2.1, 0.38), (2.55, 0.1), (dur, 0)],
        "ParamMouthOpenY": [(0, 0), (0.4, 0.04), (0.78, 0.24), (1.08, 0.06), (1.43, 0.18), (1.75, 0.04), (2.05, 0.09), (2.42, 0), (dur, 0)],
    }, smooth=True)

def shy_sway():
    """按收手参考：贴身收肘、前臂藏向外套后缘 → 连续轻晃偷看 → 放松回正。"""
    dur = 4.2  # 三次柔和往返留足时间；加 1.2s 默认姿态尾垫，完整文件 5.4s
    return emit("shy_sway", dur, {
        # 每侧分别扫描 -10/-5/+5/+10，再比较组合：01 负向贴身、02 负向内折。
        # 比旧版 -1.5/-1 的松散上臂更贴近参考；左右单独标定，不改透明度和绘制顺序。
        "ParamArmL01": [(0, 0), (0.18, -0.6), (0.42, -3.8), (0.66, -5.8), (3.62, -5.8), (3.92, -3.9), (dur, 0)],
        "ParamArmR01": [(0, 0), (0.22, -0.5), (0.48, -3.6), (0.72, -5.2), (3.64, -5.2), (3.96, -3.2), (dur, 0)],
        # 主体四臂全部平稳保持，晃动只来自头身；收尾才依次松肘、展开前臂。
        "ParamArmL02": [(0, 0), (0.16, -0.8), (0.4, -5.8), (0.68, -9.8), (3.62, -9.8), (3.94, -5.5), (dur, 0)],
        "ParamArmR02": [(0, 0), (0.2, -0.6), (0.46, -6.1), (0.74, -10), (3.64, -10), (3.98, -4.8), (dur, 0)],
        # 三次左右往返，间隔和幅度略有变化并逐渐收小；头滞后约 0.1s，保留轻前倾。
        "ParamBodyAngleZ": [(0, 0), (0.28, 0.21), (0.78, 2.66), (1.06, 0), (1.34, -2.52), (1.93, 2.38), (2.5, -2.17), (3.04, 1.82), (3.58, -1.33), (3.94, 0.28), (dur, 0)],
        # 身体先轻转、再侧倾，构成小幅扭动而非整片左右摆；前倾随换重心轻微起伏。
        "ParamBodyAngleX": [(0, 0), (0.3, -0.1875), (0.65, -2.0625), (1.22, 1.875), (1.81, -1.8125), (2.38, 1.625), (2.92, -1.375), (3.46, 1), (3.96, -0.15), (dur, 0)],
        "ParamBodyAngleY": [(0, 0), (0.6, 1.1), (1.05, 1.45), (1.6, 1.15), (2.18, 1.5), (2.76, 1.18), (3.3, 1.35), (3.98, 0.3), (dur, 0)],
        "ParamAngleZ": [(0, 0), (0.35, 0.55), (0.89, 4.18), (1.46, -2.09), (2.05, 3.74), (2.62, -1.76), (3.16, 2.75), (3.7, -0.99), (4.06, 0.33), (dur, 0)],
        "ParamAngleY": [(0, 0), (0.58, -3.2), (1.05, -3.5), (2.4, -2.8), (3.4, -2.4), (3.98, -0.3), (dur, 0)],
        # 头部晚于身体，反向转头减半，只做从属的小幅跟随，不抢身体主动作。
        "ParamAngleX": [(0, 0), (0.91, 0.65), (1.48, -0.325), (2.07, 0.55), (2.64, -0.275), (3.18, 0.4), (3.72, -0.15), (dur, 0)],
        # 轻笑眼只做微小移瞳：先躲开再偷看；自动脸红由运行时 CheekChannel 联动
        "ParamEyeBallX": [(0, 0), (0.33, -2.5), (0.78, -3), (1.45, -2.5), (2.14, 1.5), (2.75, 1.5), (3.7, 0), (dur, 0)],
        "ParamEyeBallY": [(0, 0), (0.5, -2.8), (1.5, -2.4), (2.3, -0.6), (3.2, 0), (dur, 0)],
        **both(dur, [(0, 1), (0.6, 0.94), (1.2, 0.94), (1.32, 0), (1.49, 0.96), (2.75, 0.96), (2.87, 0), (3.04, 0.98), (3.6, 0.98), (dur, 1)]),
        "ParamEyeLSmile": [(0, 0), (0.65, 0.16), (1.7, 0.18), (2.65, 0.24), (3.6, 0.16), (dur, 0)],
        "ParamEyeRSmile": [(0, 0), (0.65, 0.16), (1.7, 0.18), (2.65, 0.24), (3.6, 0.16), (dur, 0)],
        "ParamBrowLY": [(0, 0), (0.55, 0.16), (1.5, 0.12), (2.6, 0.24), (3.55, 0.14), (dur, 0)],
        "ParamBrowRY": [(0, 0), (0.62, 0.1), (1.55, 0.08), (2.65, 0.18), (3.6, 0.12), (dur, 0)],
        "ParamMouthForm": [(0, 0), (0.5, 0.2), (1.2, 0.28), (1.9, 0.22), (2.7, 0.38), (3.6, 0.24), (dur, 0)],
        "ParamMouthOpenY": [(0, 0), (2.2, 0), (2.6, 0.07), (2.85, 0.03), (3.15, 0), (dur, 0)],
    }, smooth=True)

GENERATORS = {
    "nod": nod, "sway": sway, "shake": shake, "stretch": stretch,
    "wave": wave, "doubt": doubt, "angry": angry, "yawn": yawn,
    "cheerful_bounce": cheerful_bounce,
    "shy_sway": shy_sway,
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
