# Aliya（重置版）模型能力图谱

模型：`redesign/ui/assets/live2d/aliya/`（2026-09-08 接入 PET.zip，
moc3 格式版本 4，126 参数、39 Parts、126 Drawables，2048 纹理一张）。
入口文件名仍为 16.model3.json，保留原有动作、表情和互动接口。

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
| 表情 | Param33 | 0..1 | 特殊受击眼睛选择器；禁止渐变使用 |
| 表情 | Param34 | 0..1 | 特殊哭脸眼睛选择器；禁止渐变使用 |
| 表情 | Param35 | 0..1 | 特殊无语眼睛选择器；禁止渐变使用 |
| 左右腕 | ParamArmL01/02、R01/02 | ±10 | PET 版已绑定变形器，可驱动双臂 |
| 挥手 | Param30 | 0..1 | 手臂图层开关，运行时只写 0 或 1 |
| 挥手 | Param31 / Param36 | ±1 | 小臂 / 手部挥手，物理后写入 |
| 表情 | Param37 / Param39 | 0..1 | 鼓嘴L / 嘴努子；当前表情库尚不使用 |
| 呼吸 | ParamBreath | 0..1 | 呼吸系统占用 |

## 物理链（physics3.json）

| 物理 | 输入 | 输出 | 说明 |
| ---- | ---- | ---- | ---- |
| 猫耳（左/右） | AngleX/Y/Z + EyeLOpen/ROpen | Param7~10 / Param11~14 | 耳朵随头摆；**加写 Param9/Param13 可直接拨耳**（×12 缩放） |
| 手部（左/右） | BodyAngleX/Y/Z + Breath | Param_Angle_B_BODY_6..8 / 9..11 | 左右各三段，±30；自然摆动由物理控制 |
| 挥手 | BodyAngleX/Y | Param31 / Param36 | PhysicsSetting15；挥手通道在物理后控制，避免覆盖 |
| 头发×多组/刘海/马尾/侧发 | AngleX/Y/Z 等 | Param_Angle_Rotation_* | 摆动自然，勿手动写 |
| 眼睑跟随（左/右） | EyeLOpen/ROpen | 眼珠W1/W2/N、高光X/Y/Z1、眼眶X/Y | 闭眼时瞳孔高光跟随；自动 |
| 领带 | BodyAngle | Param_Angle_Rotation_*_ArtMesh42 | 自动 |

## 已知的坑

1. PET 版已删除旧 ArtMesh60/61 五段手链；新版挥手使用 Param30/31/36，旧模型才回退到五段链。
2. **眼球值域 ±30**：按 ±1 写只有 3% 行程。
3. **物理输出参数写不进动作文件**：motion 求值在物理之前，物理每帧覆盖；
   只能经 pet-model 的物理后写入点（猫耳/抬手通道）。
4. **动作自然结束无完整淡出**：末值会被 saveParameters 冻结，动作曲线
   必须带 1.2s 复位尾垫（gen-motions.py 已内置）。
5. **眼球只能走统一视线通道**：表情不直接写 `ParamEyeBallX/Y`；有注视
   目标时由跟随控制眼球，无目标时平滑交还给动作曲线。
6. **Param33/34/35 不是普通叠加装饰**：中间值会同时显示两套眼睛，多个
   参数交叉淡化更会形成白眼、小黑点和重影。exp3 与 motion3 不激活它们；
   `face-variant.ts` 在最终写入点按表情名互斥切换完整眼型：受击 Param33=1、
   难过 Param34=1、无语 Param35=1，其余为 0。哈欠不使用哭眼。禁止对这些选择器做渐变。
   特殊眼型自带眼睑形状，期间普通 EyeOpen 固定 1、EyeSmile 固定 0，
   否则普通眨眼或半闭眼会把特殊眼型裁成白眼。
   **仅固定眼睑还不够**：开心闭眼之后，PhysicsSetting10/11 的眼眶／眼珠／
   高光输出仍有回弹残留。特殊眼型期间必须在物理后把这些普通眼部变形及
   眼球视线归零；详见 `FACE_VARIANT_PARAMETERS`，普通表情仍保留物理与视线。

## 表情库（12 个，exp3.json）

`expressions/` 下由 `tools/gen-expressions.py` 生成，model3.json
`FileReferences.Expressions` 引用：

neutral / happy / angry / sad / surprised / shy / sleepy / smug /
speechless / worried / serious / hit

眼睑开合使用 Multiply 混合以保留完整眨眼，其余参数使用 Add；生成器头部
有每个表情的参数配方。
表情=持续心境（情绪引擎管理），动作=瞬时行为，两者自动叠加。

辨识重点：开心闭眼弯月笑、得意单眼眨眼、害羞泛红偏头、困倦窄眼低头、
生气阴影怒眉、认真低头抿嘴、惊讶张嘴、担忧歪头忧眉；难过使用原生流泪，
受击使用挤眼，无语使用半垂方眼。表情数量仍为 12。

## 动作库（9 个，motion3.json）

`motions/` 下由 `tools/gen-motions.py` 生成（见 docs/ACTIONS.md）。
元数据（情绪亲和/权重/分类）在 `actions.json`。
