# Aliya（重置版）模型能力图谱

模型：`redesign/ui/assets/live2d/aliya/`（moc3 格式版本 4，125 参数，
纹理 1024 一张）。本文档是**实测**结论，供动作/表情/AI 开发查阅。

## 参数总表（按 cdi3 分组）

| 组 | 参数 | 值域 | 实测效果 |
| ---- | ---- | ---- | ---- |
| 头部 | ParamAngleX | ±30 | 水平转（+画面右）；绑定弱，30° 视觉也不夸张 |
| 头部 | ParamAngleY | ±30 | 点抬头（+抬头）；绑定中等 |
| 头部 | ParamAngleZ | ±30 | 侧倾（+左倾）；**绑定强**，±10 已很明显 |
| 身体 | ParamBodyAngleX/Y/Z | ±10 | 身体转/俯仰/侧倾；Z 用于步态 |
| 嘴 | ParamMouthForm | ±1 | +笑 / -撇嘴 |
| 嘴 | ParamMouthOpenY | 0..1 | 张嘴 |
| 左右眼 | ParamEyeLOpen/ROpen | 0..1 | 闭眼（眨眼系统占用；默认 1） |
| 左右眼 | ParamEyeLSmile/RSmile | 0..1 | 笑眼（弯月） |
| 眼睛 | ParamEyeBallX | **±30** | 瞳孔水平（+画面右）；值域非官方惯例 ±1 |
| 眼睛 | ParamEyeBallY | **±30** | 瞳孔垂直（+上） |
| 眉毛 | ParamBrowLY/RY | ±1 | +抬眉 / -压眉 |
| 眉毛 | ParamBrowLX/RX | ±1 | 眉内外移 |
| 眉毛 | ParamBrowLAngle/RAngle | ±1 | +内斜（怒 V）/ -外斜（挑） |
| 眉毛 | ParamBrowLForm/RForm | ±1 | +忧愁眉（内侧上挑） |
| 表情 | ParamCheek | 0..1 | 腮红（互动系统优先占用） |
| 表情 | Param32 | 0..1 | 生气阴影（脸色变暗 + 💢 符号） |
| 表情 | Param33 | 0..1 | 受击星标（额头星星） |
| 表情 | Param34 | 0..1 | 泪光 |
| 表情 | Param35 | 0..1 | 无语汗滴 |
| 左右腕 | ParamArmL01/02、R01/02 | ±10/-10..20 | **死参数**：未绑定变形器，满量程位移≈0，勿用 |
| 呼吸 | ParamBreath | 0..1 | 呼吸系统占用 |

## 物理链（physics3.json）

| 物理 | 输入 | 输出 | 说明 |
| ---- | ---- | ---- | ---- |
| 猫耳（左/右） | AngleX/Y/Z + EyeLOpen/ROpen | Param7~10 / Param11~14 | 耳朵随头摆；**加写 Param9/Param13 可直接拨耳**（×12 缩放） |
| 手部（左/右） | BodyAngleX/Z | Param_Angle_Rotation_1..5_ArtMesh60/61 | 五段旋转链驱动整条小臂；**左 +45 抬手、右 -45 抬手**；动作文件写不住（物理覆盖），须走 pet-model 代码通道 |
| 头发×多组/刘海/马尾/侧发 | AngleX/Y/Z 等 | Param_Angle_Rotation_* | 摆动自然，勿手动写 |
| 眼睑跟随（左/右） | EyeLOpen/ROpen | 眼珠W1/W2/N、高光X/Y/Z1、眼眶X/Y | 闭眼时瞳孔高光跟随；自动 |
| 领带 | BodyAngle | Param_Angle_Rotation_*_ArtMesh42 | 自动 |

## 已知的坑

1. **手臂参数是空壳**（见上表）；抬手用手部物理链。
2. **眼球值域 ±30**：按 ±1 写只有 3% 行程。
3. **物理输出参数写不进动作文件**：motion 求值在物理之前，物理每帧覆盖；
   只能经 pet-model 的物理后写入点（猫耳/抬手通道）。
4. **动作自然结束无完整淡出**：末值会被 saveParameters 冻结，动作曲线
   必须带 1.2s 复位尾垫（gen-motions.py 已内置）。
5. **视线跟随在「不活跃且已回中」时跳过写入**：动作眼球曲线在指针
   静止时生效，指针活动时被加性覆盖。

## 表情库（12 个，exp3.json）

`expressions/` 下由 `tools/gen-expressions.py` 生成，model3.json
`FileReferences.Expressions` 引用：

neutral / happy / angry / sad / surprised / shy / sleepy / smug /
speechless / worried / serious / hit

全部 Add 混合（与眨眼叠加不互斥）；生成器头部有每个表情的参数配方。
表情=持续心境（情绪引擎管理），动作=瞬时行为，两者自动叠加。

## 动作库（9 个，motion3.json）

`motions/` 下由 `tools/gen-motions.py` 生成（见 docs/ACTIONS.md）。
元数据（情绪亲和/权重/分类）在 `actions.json`。
