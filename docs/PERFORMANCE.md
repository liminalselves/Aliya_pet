# 表演指令协议（AI 回复驱动动作/表情）

状态：**已实施（2026-09-18）**，协议与跨仓实现的权威来源。misskey 位于
`C:/Users/35581/Desktop/misskey`。本文替代 `CHAT.md` 旧「本地关键词推断表情」方案。

## 目标

- AI 回复内嵌表演指令：**动作只播一次，表情切换后长期保持**，逐段台词可各换一次，
  对话更有生命感。
- 指令随消息**原文存储**：Misskey 网页聊天界面不展示（展示层剥离）、编辑界面可见
  （编辑器本就读原文）；只有桌宠环境的请求把指令协议与历史指令传给 AI。

设计依托现有 `[[agent_draw ...]]` / `[[agent_sticker key=...]]` 令牌家族：
存原文、展示端各自处理，且 `agent-preview-text.ts` 的通用正则
（`\[\[(?:agent_[a-z_]+|wb:)[\s\S]*?\]\]`）已自动把 `[[agent_*]]` 从通知/预览文本剥离，
新指令免费获得该行为。

## 协议

### 指令语法

```
[[agent_cue express=happy]]            切换表情（持久，直到下次切换）
[[agent_cue play=wave]]                播放动作（一次）
[[agent_cue express=happy play=wave]]  同时切换表情并播放动作
```

- **独占一行**，不与台词同行；name 字符集 `[a-z0-9_-]{1,32}`。
- 解析规则（两仓一致）：宽松匹配要求 `]]` 收尾（单个 `]` 不识别，未闭合令牌按普通文本）；
  严格解析固定 `express` 在前、`play` 在后，属性间空白分隔，名字统一小写。
- 表情与动作的语义由桌宠端执行层定义：表情持久、动作一次（见「语义与边界」）。

### 请求契约

`POST /agents/messages/send` 新增可选字段（paramDef 见施工点 4.1）：

```json
"performance": {
  "expressions": [{ "name": "happy", "hint": "开心" }],
  "actions":    [{ "name": "wave",  "hint": "挥手打招呼" }]
}
```

**环境判定：`performance` 携带任一非空清单 = 桌宠环境**（isPet）。后端不维护
表情/动作语义字典，name+hint 完全由桌宠请求供给，避免跨仓重复维护。

| | 桌宠环境（isPet） | 网页环境 |
| --- | --- | --- |
| system prompt 注入 `<agent_performance_protocol>` | 是 | 否 |
| LLM 历史中的 assistant 指令 | 保留（AI 可见自己过去的表演） | 剥离 |
| 回复落库前 | 仅剥离清单外名字的指令 | 全部剥离（如同模型从未输出） |

落库**永远存原文**（含指令）；环境差异只作用于 LLM 输入与展示层。

## 一轮对话数据流

```
桌宠 chat 窗口                     MSK 后端                          MSK 网页
──────────────                   ──────────────                    ──────────
send(text, clientRequestId,
     performance{expressions,actions})
  ──────────────────────────────▶ paramDef 校验；isPet = 任一清单非空
                                  system += <agent_performance_protocol>（仅 isPet）
                                  历史 pairs：assistant 行
                                    isPet 保留指令 / 非 isPet strip
                                  LLM → 回复
                                  回复落库前 enforce：
                                    isPet 删非法名 / 非 isPet 全删
                                  落库（原文含指令）                send（无 performance）
回复 assistantText（含指令） ◀──── 响应                              同一轮由网页发起时：
                                                                  注入/历史/回复三处都不含指令
渲染分段：指令行自成隐藏页
showPage 播到指令页 → controller.onCue
  tauri: send_chat_cue → chat-cue（全局）→ ChatPerformance
  内嵌: 直调 ChatPerformance
pet: express() 持久 / play() 一次
timeline（原文）→ 记录屏渲染时剥离指令
```

## MSK 后端施工（misskey 仓）

新模块 `packages/backend/src/core/agent-performance-cue.ts`（纯函数，无需 DI 服务，
对标 `agent-sticker-utils.ts`；单测 `packages/backend/test/unit/agent-performance-cue.ts`，
对标现有 `test/unit/AgentStickerService.ts`）：

```ts
/** 宽松匹配（剥离用）：任何 [[agent_cue ...]] 令牌，不容许内嵌换行 */
export const AGENT_CUE_ANY_RE = /\[\[agent_cue\b[^\]\n]*\]\]/;

/** 整体剥离：独占行连同换行移除 + 行内残留清理 + 空行收敛（照抄
 *  AgentImageService.stripDrawPlaceholders 的三段式，AgentImageService.ts:450-459） */
export function stripPerformanceCues(text: string): string;

/** 落库前过滤：allowed=null 全部剥离；否则只保留 name 命中集合的令牌 */
export function enforcePerformanceCues(text: string, allowed: Set<string> | null): string;

/** 协议块：<agent_performance_protocol>…</agent_performance_protocol>，
 *  列出 express/play 语法、持久/一次语义、逐段可换、只用清单名、不得向用户提及 */
export function buildPerformanceSystemBlock(performance: {
  expressions: { name: string; hint?: string }[];
  actions: { name: string; hint?: string }[];
}): string;
```

### 4.1 paramDef（`packages/backend/src/server/api/endpoints/agents/messages/send.ts:83-93`）

`performance`：可选 object；`expressions`/`actions` 各为 array（maxItems 32），元素
`{ name: string ≤64 必填, hint: string ≤64 可选 }`。不进 required，缺失即网页环境。

### 4.2 system 注入（send.ts:455-461 生图块旁）

```ts
const perf = body.performance;              // 先规范化 + 名字去重
const isPet = perf != null && (perf.expressions.length > 0 || perf.actions.length > 0);
if (isPet) system += '\n\n' + buildPerformanceSystemBlock(perf);
```

### 4.3 历史过滤（send.ts:408-426 pairs 两分支）

- 压缩路径（413-417）与普通路径（419-424）：assistant 行在 `filterForAi` 之后追加
  `!isPet ? stripPerformanceCues(content) : content`；user 行不需要（用户不发指令）。
- 长期记忆 `memPairs`（send.ts:429）：**无条件剥离**指令——记忆里存表演指令是噪声，
  与 `stripHistoricTimePrefix` 的「不进记忆」原则一致。

### 4.4 回复落库前（send.ts:526-531 enforceReplyLimits 旁并列）

```ts
// 非 isPet：协议未注入，但历史/习惯可能诱导模型输出指令——整体剥离
//（与生图模型为「无」时 stripDrawPlaceholders 的理由相同，send.ts:520-524）。
const assistantText = enforcePerformanceCues(stickerFilteredText, isPet ? allowedNames : null);
```

不限每条回复的指令数量：执行端（桌宠 ChatPerformance）自带动作限频兜底。

### 4.5 主动消息路径（`AgentProactiveMessageService.ts:238-332`）

v1 不注入表演协议（无请求上下文，无法知道清单）；该路径历史组装（254-265）与回复
落库前（332 附近）**无条件 `stripPerformanceCues`**——否则桌宠轮次历史里的指令会
诱导主动消息也输出指令。见「决策」1。

### 4.6 类型再生成

`packages/misskey-js/src/autogen/types.ts` 的 send 请求体已按生成格式手工同步
`performance` 字段（misskey-js typecheck 通过）；后续如跑根目录
`pnpm build-misskey-js-with-types`（package.json:30）应产出等价内容。网页前端发送处
本就 `as any`（agent-session.vue:4835），不依赖新类型也不破。

### 4.7 system prompt 模板（buildPerformanceSystemBlock 输出要点）

协议块要点（完整文本以 `agent-performance-cue.ts` 为准）：

- 指令独占一行，三种格式（express / play / 合写）。
- **指令行必须先于它所驱动的台词出现**；解说当前表情的句子放在当前表情的指令之后、
  切换下一个表情的指令之前。
- 表情长期保持，同样的表情连续使用时不需重复切换；动作只播放一次。
- 逐段可换，但只在情绪或语义明显契合时使用；只能用清单名，不向用户提及指令。
- 清单：`- name —— hint`（对齐 `AgentStickerService.buildSystemBlocks` 行文）。
- 示例（用户认证的节奏）：开场先切换、解说句衔接、结尾保持不重复切换：

```
示例：
[[agent_cue express=happy play=wave]]
你想看表情？好呀，那我一个一个给你变，你可看仔细了。

这个是开心的。
[[agent_cue express=shy]]
你看，一说到给你看这个，我自己就先笑出来了。…

这个是害羞的。
[[agent_cue express=angry play=shake]]
……你别一直盯着看啦。…

这个是生气的。
[[agent_cue express=happy]]
这个，是我现在最想给你的——就是很安心、很踏实的笑。

看完了没有？可要记得，我最想让你记住的是最后一个。
```

## MSK 前端施工（misskey 仓）

1. **展示剥离**：`agent-session.message.vue` 的 `displayContent`（219-228）在 hide
   规则循环后追加 `content = stripAgentCueTokens(content)`。helper 放
   `packages/frontend/src/utility/agent-message-segments.ts`（与分段器同源导出，
   实现 = 后端 `stripPerformanceCues` 同款三段式）。剥离发生在分段之前，空行由
   分段器自然跳过，不留空气泡；无分段模式（segmentedOutputEnabled 关）同样覆盖。
2. **流式播放取段**：`agent-session.vue` 的 `playableSegmentsFor`（4662-4666）入参
   先过同一 `stripAgentCueTokens`，避免逐气泡回放时把指令当正文念出来。
3. **编辑界面零改动**：编辑走 `agents/messages/show` 拿 `rawContent` 原文，
   「编辑中可以查看」天然成立。
4. **通知/预览零改动**：`agent-preview-text.ts` 通用正则已覆盖 `[[agent_cue]]`。

## 桌宠端施工（aliya_pet 仓，redesign/ui）

### 6.1 共享清单 `src/chat/performance-manifest.ts`（新增）

name+中文 hint 的唯一权威来源，chat 窗口（构建请求）与 pet 窗口（校验指令）共用
（两窗口同 bundle `ui/src`）。初版清单：

```ts
export const PERFORMANCE_EXPRESSIONS = [
  { name: 'neutral',     hint: '平静' },
  { name: 'happy',       hint: '开心' },
  { name: 'angry',       hint: '生气' },
  { name: 'sad',         hint: '难过' },
  { name: 'surprised',   hint: '惊讶' },
  { name: 'shy',         hint: '害羞' },
  { name: 'sleepy',      hint: '困倦' },
  { name: 'smug',        hint: '得意' },
  { name: 'speechless',  hint: '无语' },
  { name: 'worried',     hint: '担心' },
  { name: 'serious',     hint: '认真' },
  { name: 'hit',         hint: '受打击' },
];
export const PERFORMANCE_ACTIONS = [
  { name: 'nod',     hint: '点头附和' },
  { name: 'sway',    hint: '摇摆身体' },
  { name: 'shake',   hint: '摇头' },
  { name: 'stretch', hint: '伸懒腰' },
  { name: 'wave',    hint: '挥手打招呼' },
  { name: 'doubt',   hint: '歪头疑惑' },
  { name: 'angry',   hint: '气得发抖' },
  { name: 'yawn',    hint: '打哈欠' },
  { name: 'walk',    hint: '原地踱步' },
];
```

同文件导出 `parseCueSegment(segment: string): PerformanceCue | null`（整段恰为一个
合法指令令牌时返回 cue）与 `CUE_TOKEN_RE`，compose 防御性剥离复用同一正则。

### 6.2 请求携带（`src/chat/msk/client.ts:163-170`、`msk/provider.ts`）

`MskClient.send` 增可选尾参 `performance`，postRaw 请求体带上；
`MskChatProvider.reply`（provider.ts:20 调用处）从 manifest 直取传入——
client 保持通用 HTTP 层，不耦合 pet 清单。轮询兜底路径（`awaitAssistantReply` 走
timeline 原文）无需改动，指令天然在回复文本里。

### 6.3 渲染（`src/chat/rendering/compose.ts:82-134`）

`composeMessage` 管线在心率剥离（87-88）后追加指令处理：

- **分段播放路径**（assistant 且 segmented）：segment 经 `parseCueSegment` 命中 →
  输出 `<div class="msk-segment msk-cue" data-express="happy" data-play="wave"></div>`
  （空内容、无 markdown），不进 token 扫描。**开场归一**：若首条 cue 之前有文本页
  （模型习惯让开场白素颜），把首条 cue 提前到页首——表情持续，提前只是多覆盖
  开场白，原配对段落仍被覆盖到下一条指令为止，不错位；**不做链式交换**（模型
  输出在「报幕式/指令段首式」两种格式间摇摆，链式交换会把已正确的配对整体
  错开一段）。MSK 展示与存储原文不受影响。
- **内联残留防御剥离**：其余 segment 文本里的行内 `[[agent_cue …]]` 令牌用
  `CUE_TOKEN_RE` 移除（AI 偶尔不守「独占一行」时兜底）。
- **记录屏**（segmented=false 整条一段）只走内联剥离 → 指令不展示、不生成 cue 页、
  不触发表演。
- 分段器 `segments.ts` **零改动**：逐行状态机本就把普通单行各自成段
  （segments.ts:144-158），独占一行的指令天然自成一页。

### 6.4 翻页播放（`src/chat/view.ts:357-370` showPage）

- 页元素含 `msk-cue` 类：不建 Typewriter、不加 `gal-page-in`，保持 hidden，解析
  `data-express`/`data-play` 得 cue，经 `this.controller.onCue?.(cue)` 派发
  （复用 controller 既有回调，window.ts:23 与 pet-app.ts 内嵌两处消费端不用改），
  设 `data-dispatched` 幂等标记（resyncPages 在生图状态更新时会重入 showPage，
  已派发的指令页直接跳过），约 400ms 后自动 `showPage(index+1, true)`；末页则
  延时后 `hideReply()`。定时器挂在实例上，`clearPlayback` 时清理。
- `updateHint`（381-394）页脚计数只计非 cue 页（`segments.filter(s => !s.classList.contains('msk-cue'))`），
  避免「2/5」把看不见的指令页数进去。
- 连续多指令页自然链式自动翻页。

### 6.5 表演语义（`src/chat/performance.ts`）

`cue()` 的表情分支去掉 `_until = now + 3500` 的 3.5s 临时语义，改为**持久**：
`_expression` 保持到下一个表情指令或 `cancel()`；触碰优先逻辑不变（busy 时让位、
结束后恢复）。动作分支不变（busy 不播 + 4s 限频）。`cancel()` 时机维持现状：
聊天关闭/重试失败时触发，回情绪默认表情。

### 6.6 删除本地推断

- `msk/provider.ts` 的 `localCue` 整函数删除，segment 事件不再带 `cue`
  （types.ts `ChatEvent.segment.cue` 字段一并移除）。
- `controller.ts` 的请求期 `this.onCue(event.cue)` 删除——派发时机从
  「回复到达」改为「播放到该页」（6.4）。

### 6.7 pet 窗口接线（`src/pet-app.ts`）

- `PerformanceHost` 新增 `expression()`（取 `petAI.state().expression`）：
  `ChatPerformance.tick()` 每帧比对实际表情，情绪引擎或设置面板覆盖后自动拿回
  聊天表情（无该钩子的 host 退回 `_applied` 标记语义）。
- 互动协调的 `speaking` 信号移除 `_chatPerformance.active`：持久表情不再是
  「正在说话」，否则一次聊天后待机动作/随机台词被永久压制。
- `chat-state` 监听里 `open=false` 时 `cancel()`：原生窗口关闭即复位表情，
  与内嵌模式的 `setOpen(false)` 回调对齐。

## 语义与边界

- **表情持久**：下一个表情指令覆盖；重复切换保持中的表情被幂等吸收（不重放
  express）；用户触碰（busy）暂时让位、结束恢复；情绪引擎/设置面板手动预览
  覆盖后每帧拿回；聊天关闭/取消回情绪默认。不跨聊天会话保留。推论：聊天表情
  保持期间，设置面板的表情预览会被立即拿回，预览需先收起聊天或等取消。
- **动作一次**：播放即完，不排队；busy（拖动/互动）期间的动作指令丢弃；
  4s 内的重复动作指令被限频吞掉——都属既有行为，指令化后不改。
- **混合客户端**：同一会话网页轮次 AI 看不到指令（输入输出都剥），桌宠轮次
  AI 能看到自己历史中的指令；两边存储原文一致，时间线互通无冲突。
- **编辑**：在 MSK 编辑器增删指令即改原文；展示两端照常剥离；不触发任何表演。
- **纯指令回复**（无台词）：桌宠会依次派发后自动收起，属可接受的退化；
  非 isPet 环境下全剥离后空回复走现有 `hasVisibleAssistantText` 空回退路径。
- **未知名字**：后端 enforce 与桌宠 `ChatPerformance` 双重校验（`host.expressions()
  .includes` 既有逻辑），不存在的名字静默忽略。
- **用户消息指令**：用户手打 `[[agent_cue …]]` 不具特殊性——发给 AI 原样可见
  （与 sticker 不同，不做 LLM 视图转换），pet 侧展示层仍会剥离（两端一致），
  只在 assistant 分段播放时解析表演。

## 测试与验收

- **misskey**：`test/unit/agent-performance-cue.ts` 14 项（strip 三段式、enforce
  白名单与全剥、协议块渲染、normalize 去重小写）；前端
  `agent-message-segments.test.ts` 补 strip 3 项。后端 typecheck、misskey-js
  typecheck、前端 vitest 均通过。
- **aliya_pet**（`redesign/ui`）：`npm test` 58 项全过、`npm run build` 通过。
  覆盖：分段器指令行独立成段；compose 指令段 → `msk-cue` div + 行内/记录屏
  剥离 + 畸形剥空；ChatPerformance 持久表情、覆盖后拿回、触碰让位、限频、
  取消不复活；provider 无请求期 cue、send 携带 name+hint 清单。
- **实机验收归用户**：真模型上「表情持续到下一段、动作只播一次、限频、关闭聊天
  复位」；MSK 网页查看同一会话指令不显示、编辑可见；网页轮次后桌宠轮次正常诱导。

### 2026-09-18 实测记录（本地 dev 实例，g3f 模型）

- 桌宠代码链路用 mock 后端 + 浏览器端到端全过：请求携带清单、指令页派发
  `wave+happy`、`shy` 事件序列、自动翻页、页脚只计文本页、6s 后表情仍保持、
  关闭聊天复位 null、模型面部视觉呈现害羞腮红。
- 真实 LLM（本地实例 g3f）：携带中文 hint 清单时模型按协议输出独占行指令并落库；
  同会话不带 `performance` 的请求即使历史含指令且强诱导，回复与落库均零指令
  （历史剥离 + 落库过滤双确认）。
- **指令位置实测**：g3f 的输出格式在「标签句→指令→展开」（报幕式）与
  「指令→段落」（段首式）之间摇摆，配对语义始终是「指令驱动其后最近的段落」；
  开场白前几乎从不给指令，且早期会对保持中的表情重复切换。处置：协议要求
  指令前置与开场指令（对遵循度高的模型生效），桌宠端以**开场归一**（仅首条
  cue 提前到页首，利用表情持续语义不错位）+ **表情幂等**（重复切换吸收）兜底。
  2026-09-18 终版协议（含「回复必须以指令行开头」规则）下实测：配对全部正确、
  结尾不重复切换，开场白仍缺指令由开场归一补上。
- 生效前提：**后端实例必须运行本协议代码**。本地 dev 实例（`node ./built/boot/entry.js`）
  改 TS 后须 `pnpm --filter backend build` 并重启；远程 misskey.liminalselves.top
  需部署后才有协议。

## 决策记录

1. 主动消息 v1 不注入表演协议；其历史与回复无条件剥离指令。
2. 表情不跨聊天会话保留，聊天关闭即回情绪默认。
3. 桌宠记录屏剥离指令（与 MSK 展示一致），不显示原始指令行。
4. 不限每条回复指令数量，靠桌宠端动作限频兜底。
5. name+hint 由桌宠清单供给，后端/网页不维护语义字典。
6. 指令语法沿用 `[[agent_*]]` 家族而非 MFM/自定义标签，最大化复用既有剥离与
   分段先例。

## 同步纪律

`performance-manifest.ts` 成为第四张动作/表情对照表，与既有三处保持同步
（新增/改名时四表一起动，规则见 `ACTIONS.md`）：

1. `assets/live2d/aliya/16.model3.json` 的 Expressions/Motions
2. `assets/live2d/aliya/actions.json`
3. `src/behavior.ts` 的 `ACTION_LIBRARY`
4. `src/chat/performance-manifest.ts`（本表，另带 hint）
