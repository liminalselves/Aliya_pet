# 动作接入指南

## 当前资源与接入

正式资源为 PET 版 Aliya 模型，入口保留 `16.model3.json`、`16.moc3`、
`16.physics3.json`、`16.cdi3.json`，纹理为 `aliya.2048/texture_00.png`。
当前 **14 个动作、12 个表情**；动作均由 `redesign/tools/gen-motions.py` 自编生成，
不是官方示例占位文件。LipSync 不启用。

修改关键帧后重新生成与验证：

```sh
python redesign/tools/gen-motions.py
python -B -m unittest discover -s redesign/tools -p test_gen_motions.py -v
npm --prefix redesign/ui test
npm --prefix redesign/ui run build
```

生成器同时更新 assets 与 dist；生产构建会重新复制正式 assets。动作资源位于
`redesign/ui/assets/live2d/aliya/motions/`。注册须同步生成器 `GENERATORS`、
`16.model3.json` 的 `Motions`、`actions.json`、`src/behavior.ts` 的
`ACTION_LIBRARY`、`src/chat/performance-manifest.ts` 的 `PERFORMANCE_ACTIONS`。
设置页中文标签由 `src/settings-page.ts` 的 `ACTION_LABELS` 提供。

## 动作清单

| 中文名称 | 内部动作名 | 设计要点 |
| --- | --- | --- |
| 摇摆 | `sway` | 头部周期摇摆与笑眼 |
| 点头 | `nod` | 两次点头，低点半闭眼 |
| 摇头 | `shake` | 两次摇头，眉毛下压 |
| 疑惑 | `doubt` | 歪头保持、不对称挑眉 |
| 挥手 | `wave` | 头脸协调，专用代码通道抬右手摆动 |
| 伸展 | `stretch` | 完全闭眼后仰，收尾回正 |
| 生气 | `angry` | 生气阴影、怒眉与头部颤动 |
| 打哈欠 | `yawn` | 闭眼张嘴、抬头后仰 |
| 开心雀跃 | `cheerful_bounce` | 蓄势、两次递减的上半身弹动、小幅协同摆臂 |
| 撒娇 | `shy_sway` | 贴身收肘藏手、三次柔和轻晃、低头偷看，自动脸红 |
| 鼓腮 | `puff` | 吸气后仰 → 猛扭头鼓嘴、身体一胀一胀 → 偷瞄 → 泄气吐气 |
| 飞吻 | `kiss` | 后仰预备 → 前倾闭眼嘟嘴「啾」→ 弹回过冲、单眼 wink |
| 委屈 | `sob` | 嘴角下撇眼湿 → 哭眼抽泣两下（肩耸）→ 吸鼻子抬头、眨眼忍住 |
| 无语 | `deadpan` | 愣住一拍 → 无语方眼、头身慢慢耷拉 → 叹气回正 |

## 替换脸动作 puff / kiss / sob / deadpan

这四个动作用的是模型里画师已画好、此前没用上的整套替换网格：鼓嘴 `Param37`、
嘟嘴 `Param39`、哭眼 `Param34`、无语眼 `Param35`。它们是 0/1 网格替换（中间值会让
两张嘴或两套眼睛半透明叠加，实测确认），不能写进 motion3.json 交给 SDK 交叉淡化。

- 时间轴写在 `actions.json` 对应条目的 `face` 字段（唯一来源），格式
  `{ "from": 秒, "to": 秒, "eye"?: "hit|sad|speechless", "mouth"?: "puff|pucker" }`，区间左闭右开。
- 运行时 `src/face-cue.ts` 的 `FaceCueTrack` 随动作启动；`PetModel` 在最终写入点
  （`face-variant.ts` 的 `applyFaceVariant` / `applyFaceMouth`）一帧切换，任何帧都只有 0 或 1。
- 动作提示优先于表情眼型，动作结束或被任何动作打断立即撤回，回到表情自己的眼睛；
  受击挤眼 `Param33` 自带整张脸，开启时不再叠替换嘴。
- 切换点都放在头部转动最快、或闭眼/垂眼的帧上，用动作遮住网格跳变。
- motion 本身只写头身与普通五官，按「预备 → 主动作 → 过冲 → 回弹」排节奏，
  全部使用保形平滑插值；四臂只复位。

满笑眼需同时 EyeOpen=0（本模型仅写 Smile 时眼型几乎不变）。

## 开心雀跃 cheerful_bounce

完整时长 **4.1s = 2.9s 表演与回正 + 1.2s 默认姿态尾垫**。
保留原蓄势、两次递减弹动、小回弹及收尾的所有时间点，主要头身曲线幅度增加 30%：

- 身体 Y 为 -3.38～2.08，身体 Z 为 -0.845～1.3。
- 头部 Y 为 -3.9～7.15，头部 Z 为 -1.82～2.6。
- 两侧上臂最大 1.4、前臂最大 1.8，前臂略迟于躯干，左右时点略错开；不做大幅抬手。

眉嘴仍按原节拍表演；满笑眼期间眼球 XY 保持 0。使用现有 `smooth_curve_segments()`
保形 C1 插值，单调中间关键帧不强制停速，极值与收尾自然减速。
模型没有独立整体升降或腿部跳跃绑定，所以这是上半身俯仰弹动，不是离地跳跃。
随机配置为 emotion、基础权重 0.45，偏好 happy。

## 撒娇 shy_sway

调用名、动作组和资源名统一为 `shy_sway`，无第二个别名；设置页显示“撒娇”。
完整时长 **5.4s = 4.2s 表演与回正 + 1.2s 默认姿态尾垫**，不改变现有动作管理架构。

### 时间节奏与姿态

- 0–0.74s：左右上臂逐渐贴身收肘、前臂错峰内折，双手收向外套侧后缘；低头轻歪、视线躲闪。
- 0.74–3.62s：四臂稳定保持，身体三次左右往返；极值约在 0.78/1.34/1.93/2.5/3.04/3.58s，逐渐收小。
  身体 Z 比前版增加 40%，主峰为 +2.66/-2.52；穿过 1.06s 中心时仍有非零速度。
- 身体 X 提前约 0.12s 轻转，增加 25% 后范围为 -2.0625～1.875；身体 Y 保持 1.1～1.5 的轻前倾起伏。
  头部 Z 只增加 10%，最大 4.18，滞后跟随；头部 X 反向量减半，最大绝对值 0.65，不以大幅反扭抢戏。
- 轻笑眼最大 0.24、眼球最大绝对值 3，回避后偷看，穿插两次完全眨眼，眉嘴细节延续到最后一次回摆。
- 3.62–4.2s：双臂放松、头身回正；接默认姿态尾垫。

保形 C1 Bezier 让相邻单调段共享切线，只在摆动极值、手臂平台和最终回正处减速。
控制点不超过相邻姿态的范围，不靠过冲或单纯放慢掩盖卡顿。

### 藏手能力与参数所有权

正式 Core/WebGL 逐侧扫描正负端点与中间值确认：四臂范围均为 ±10、默认 0；
`01` 负向贴身、正向外展，`02` **负向才是前臂明显内折**。不能仅凭参数名或镜像关系推断方向。
主体保持左上臂 -5.8、右上臂 -5.2、左前臂 -9.8、右前臂 -10，头身增强不改这四个姿态。
四臂均在主段保持，收尾才依次松开，不以腹前交叉或叉腰代替。

手部网格 `ArtMesh128/129` 绘制顺序为 17/16，`ArtMesh119/120` 为 32/31，
先于外套 `ArtMesh45` 的 47；利用模型固有层次遮挡，形成手藏向腰后侧/外套后缘的近似背手。
不修改透明度、绘制顺序、moc3 或物理输出；不包含背后手指交握或转身背面演出。
四臂已加入公共 `base_reset`，全库均有 30 参数曲线，任何接替动作都能释放收臂残值。

### 自动脸红，不替换原表情

motion 文件不写 `ParamCheek`。成功的 `playAction`、`startMotion` 和经其调用的随机动作
统一触发既有 `CheekChannel`；设置按钮、Windows/Android 桥、AI 与自动行为走相同入口。
被拒绝或未知动作不改变当前包络。不会调用 `startExpression('shy')`，也不会结束时清空表情。

动作脸红目标为 1，进入按 0.1s 时间常数平滑；主体末 0.6s 用 smoothstep 降低目标，
退出按 0.18s 时间常数平滑并在 1.2s 尾垫内释放。重播从当前红晕继续，中断只撤回动作自己的贡献。
覆盖位于 `saveParameters` 之后，取 **原表情、互动、动作贡献的最大值**并限制为 0～1，
不把脸红写进持久动作基线，不用较弱点击覆盖更强表情。

点击脸红保留原 300ms 渐入、900ms 保持、700ms 恢复，峰值由 0.55 提高至
**0.85 × strength**（strength 限制在 0～1）；互动贡献另作平滑接管/释放。
既有 `shy` 表情的 Cheek 已为 1，不再提高或叠加越界。若调用前有 shy 表情或点击脸红，
撒娇结束/打断后保留它们自己的状态，按原生命周期退出。
仍可通过已有协议另外选择完整害羞表情：

```text
[[agent_cue express=shy play=shy_sway]]
```

这不是自动脸红的必要条件。随机配置仍为 emotion、基础权重 0.4，shy 倍率 4、happy 倍率 2。

## 自编动作的工程约束

1. 只写已验证存在的参数。四臂可用，但手链、头发、猫耳、眼部跟随等物理输出不进 motion；
   `ParamBreath` 由呼吸系统独占，`ParamCheek` 由表情与既有覆盖层协调。
2. 每个动作必须带全套 `base_reset`：30 参数，面部/头身/四臂默认 0，眼开度默认 1。
   不完整的曲线会让 `saveParameters` 保存前一个动作的残值。
3. 所有表演曲线在内容段结束时回默认；统一 `TAIL_SECONDS = 1.2`，大于当前 1s 淡出。
   SDK 自然完成不会替所有参数执行完整淡出，不可依赖队列结束自动恢复。
4. Meta 必须与曲线一致：Linear 每段 3 元素、Bezier 每段 7 元素，
   TotalPointCount = 1 + Linear×1 + Bezier×3，保留 `hasConsistency()` 校验。
5. `Param33/34/35` 是整套特殊眼型选择器，不可中间值渐变；motion 只写 0 复位，
   运行时最后负责互斥。`Param32` 是生气阴影，不是脸红。
6. 眼球 XY 的真实范围为 ±30，而不是惯例 ±1；动作与指针跟随走现有 `GazeController`
   混合和径向钳制。轻笑眼（≤0.4）只用小视线（≤±5），满笑眼（≥0.7）眼球居中。
7. `stretch` 闭眼保持使用 EyeOpen=0、EyeBallXY=0；EyeOpen=0.1 在此模型仍露紫色虹膜，
   叠加笑眼会产生夹层。`doubt` 起止眼开度为默认 1，不能用零值 hold 复位眼开度。
8. 眉嘴按语义和节奏协调变化。平滑插值用于当前 cheerful、shy，不改变其余动作节奏。

## 挥手与猫耳兼容通道

包含 `Param30/31/36` 的当前模型使用新版挥手图层开关、小臂及手部控制，在物理之后应用；
旧模型回退到 `Param_Angle_Rotation_1..5_ArtMesh61` 五段手链。挥手包络约 0.45s 举起，
2.55s 起用 0.6s 放下，重复和打断均平滑释放；不让 motion 直接写这些独占参数。

当前模型没有旧 `ParamEarL/R`；耳朵映射到物理输出 `Param9/13`（互动值 ×12），
有原生参数的旧模型仍使用 0～1 原生耳动。覆盖在物理之后、生效于当帧，不保存进动作基线。

## 验证与人工验收

保留 develop 原有开发入口 `/tests/model-preview.html`，通过正式 PetApp、Core、纹理和物理
加载真实模型。运行按钮覆盖全部动作的 15/30/60 FPS、12 表情、特殊眼型、挥手重播/打断
及眼睛/猫耳/脸红互动。

## 渲染余量

`PetApp._renderMarginRatio = 1.30`。测量方式：正式 Cubism Core 6.0.1、moc、
物理及 `PetModel.update` 驱动全部动作 × 全部表情 × 中点/四角注视的顶点包络，
按实际静态宽高取 `maxAbsX/(0.5×boundsW)`、`maxAbsY/(0.5×boundsH)` 的最大值，
再乘 1.05 安全系。当前测得所需余量约 1.222，低于 1.30，动作幅度扩大后必须重测。

在 `redesign/ui` 运行 `npm run test:bounds` 可复现此较慢检查（本机约 5 分钟）。测试还用
真实 `PetApp._render` 和 Cubism 矩阵，将测得的保守包络投影到 3840×2160 工作区、
DPI 1/1.5/2/3、设备最小/默认/最大尺寸及镜像开关的全部 24 组合，检查边缘安全带。
这属于正式 Core 顶点及 CPU 投影检查；纹理上传和 GL 调用被隔离，不能视为 WebGL 像素、
原生 Tauri 跨窗口 IPC 或 Windows 实机高 DPI 验收。

自动检查和静帧不能替代连续播放审美验收；Windows 实际 DPI/缩放/镜像、高频指针跟随、
Android 设备的实际渲染与触摸观感仍需人工确认。跨平台使用共用 TypeScript 调用链不等于 Android 实机通过。

重新测量时禁用随机行为，手动 `_update(dt)` 驱动；每帧读取 `getDynamicBounds()`，
按 maxAbsX/(0.5×boundsW)、maxAbsY/(0.5×boundsH) 取最大，并另乘 1.05 报告建议安全带。
水平使用实际静态 `boundsW`，不再用 `0.64×boundsH` 近似宽度，以免低估所需余量。
画面须等待纹理与首次有效 WebGL 渲染，不能只以 `isReady()` 为截图就绪依据。

## 互动命中坐标

`aliya_hit_areas.json` 使用固定模型参考坐标 `model_reference_normalized`，
`referenceRenderMargin: 1.22` 记录原椭圆的校准基准；椭圆数值保留，不宣称重新测量了可见部位。
`PetApp` 的渲染和命中反解共享模型到画布的变换，点击先按真实 canvas 像素尺寸反投影，
再换算到参考坐标；镜像只消除一次，聊天适配、贴合原点和 DPR 取整均纳入计算。
因此当前或后续渲染余量变化不需手工平移椭圆；注视及指针速度仍保持原口径。
椭圆比剪影大（头部区域伸出头顶），是否落在角色上先由像素 alpha 门控（`PetApp._isOnCharacter`），
椭圆只在门控通过后决定部位。

在 `redesign/ui` 运行 `node --test tests/eye-side.test.mjs` 可复现命中回归：
正式 Core/moc 的全部顶点及椭圆采样点，经真实 `PetApp._render` 和 Cubism 矩阵投影，
在 288 组余量、尺寸、DPI、镜像及布局组合下保持相同参考坐标和命中分类。
这证明坐标随渲染一致，不是部位语义的重新标注，也不替代实机 GPU、鼠标及触摸验收。

## 旧版格式参考

git 历史 `windows/Assets/Live2D/Aliya/Actions/*.json` 是旧 C# 自定义
`channels/parameter/keyframes/weight` 格式，不是 Cubism motion3.json，不能直接替换。
可参考语义与节奏，但正式资源始终由当前生成器生成。
