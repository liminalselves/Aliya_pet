# 表演指令协议（AI 回复驱动动作/表情）

桌宠聊天协议与跨仓实现的权威来源。misskey 后端位于独立仓库。协议已实施，
本文替代 `CHAT.md` 旧「本地关键词推断表情」方案。

## 三个概念

桌宠的表演只分三类，定义都在 `ui/src/catalog.ts`：

| 概念 | 含义 | 谁来控制 | 上报 MSK |
| --- | --- | --- | --- |
| 表情 | 一张持续的脸（exp3.json） | AI 指令、互动反应组、设置预览，都是临时覆盖 | 是（全部） |
| 动作 | 播一次就结束。`motion`=Live2D 动作；`procedural`=互动层参数微动（歪头、蹭手、缩一下等） | AI 指令（只限 motion）、互动反应组、待机抽取 | 只上报 motion |
| 状态 | 稳定保持的「默认表情 + 待机动作池」 | 桌宠自己：设置里手动选择优先并一直保持；「自动」时深夜/凌晨困倦，其余平静 | 否，MSK 不干预 |

临时表情结束后一律回到当前状态的默认表情。互动（点击、抚摸、拖动）是另一套与 MSK 无关的系统，
见 `INTERACTION.md` 的反应组。

## 目标

- AI 回复内嵌表演指令：**动作只播一次，表情切换后长期保持**，逐段台词可各换一次，
  对话更有生命感。
- 指令随消息**原文存储**：Misskey 网页聊天界面不展示（展示层剥离）、编辑界面可见
  （编辑器本就读原文）；只有桌宠环境的请求把指令协议与历史指令传给 AI。

设计依托现有 `[[agent_draw ...]]` / `[[agent_sticker key=...]]` 令牌家族：
存原文、展示端各自处理，且通知/预览文本的通用正则已自动把 `[[agent_*]]` 剥离，
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

`POST /agents/messages/send` 的可选字段：

```json
"performance": {
  "expressions": [{ "name": "happy", "hint": "开心" }],
  "actions":    [{ "name": "wave",  "hint": "挥手打招呼" }]
}
```

`expressions`/`actions` 各为 array（maxItems 32），元素 `{ name ≤64 必填, hint ≤64 可选 }`。

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

## 实现位置

| 位置 | 作用 |
| --- | --- |
| `packages/backend/src/core/agent-performance-cue.ts` | 协议块构建、剥离、白名单过滤、清单规范化（纯函数，无 DI） |
| `packages/backend/src/server/api/endpoints/agents/messages/send.ts` | paramDef、system 注入、历史过滤、落库前过滤 |
| `packages/backend/src/core/AgentProactiveMessageService.ts` | 主动消息路径：不注入协议，历史与回复无条件剥离 |
| `packages/frontend/src/utility/agent-message-segments.ts` + `agent-session*.vue` | MSK 网页展示剥离（与后端同款三段式），编辑界面读原文零改动 |
| `ui/src/chat/performance-manifest.ts` | 从 `catalog.ts` 派生上报清单；指令解析、剥离正则 |
| `ui/src/chat/msk/client.ts`、`msk/provider.ts` | 请求体携带清单 |
| `ui/src/chat/rendering/compose.ts`、`segments.ts` | 指令行独立成段 → `msk-cue` 隐藏页；行内残留防御剥离 |
| `ui/src/chat/view.ts`（showPage） | 播到指令页时派发 cue 并自动翻页；页脚不计 cue 页 |
| `ui/src/chat/performance.ts`（ChatPerformance） | 表情持久语义、限频、busy 让位、取消复位 |
| `ui/src/pet-app.ts` | `performanceRequestPayload` 上报、cue 派发接线 |

## 语义与边界

- **表情持久**：下一个表情指令覆盖；重复切换保持中的表情被幂等吸收（不重放
  express）；用户触碰（busy）暂时让位、结束恢复；状态切换/设置面板手动预览
  覆盖后每帧拿回；聊天关闭/取消回状态默认表情。不跨聊天会话保留。推论：聊天表情
  保持期间，设置面板的表情预览会被立即拿回，预览需先收起聊天或等取消。
- **动作一次**：播放即完，不排队；busy（拖动/互动）期间的动作指令丢弃；
  4s 内的重复动作指令被限频吞掉——都属既有行为，指令化后不改。
- **开场归一**：模型习惯让开场白素颜（指令总在第一段正文后才出现）；桌宠渲染时
  把首条 cue 提前到页首——表情持续，提前只是多覆盖开场白，原配对段落仍被覆盖
  到下一条指令为止，不错位。不做链式交换（模型输出在「报幕式/段首式」间摇摆，
  交换会把已正确的配对整体错开）。
- **替换脸动作**：puff/kiss/sob/deadpan 等特殊眼型/嘴型网格由 `actions.json`
  的 `face` 时间轴驱动（见 `ACTIONS.md`），AI 用 `play=` 触发时同样生效。
- **回复展示期间不放待机动作**：`InteractionCoordinator.speaking` 包含回复面板展示中
  （原生聊天窗经 `chat-state.replying`，内嵌聊天读 `ChatView.replying`），直到读完收起。
  否则 8～16s 的自动动作会在读回复时插进来；动作自带的表情曲线（如 `fume` 的黑脸与
  怒气符号、`wave` 的满笑眼）叠在聊天表情上，看起来人物表情与台词不符。
  手动点击、AI 指令和设置面板的动作不受影响。
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
- **生效前提**：后端实例必须运行本协议代码（misskey 仓独立部署）。

## 决策记录

1. 主动消息 v1 不注入表演协议；其历史与回复无条件剥离指令。
2. 表情不跨聊天会话保留，聊天关闭即回状态默认表情。
3. 桌宠记录屏剥离指令（与 MSK 展示一致），不显示原始指令行。
4. 不限每条回复指令数量，靠桌宠端动作限频兜底。
5. name+hint 由桌宠清单供给，后端/网页不维护语义字典。
6. 指令语法沿用 `[[agent_*]]` 家族而非 MFM/自定义标签，最大化复用既有剥离与
   分段先例。

## 同步纪律

`ui/src/catalog.ts` 是表情、动作、状态的唯一权威来源（name、中文 label、给 AI 的 hint、
动作类型、状态的默认表情与待机池）。上报清单、设置页按钮、待机抽取、PetAI 全部从它派生。
资源侧只剩两处要对齐，由 `tests/catalog-reactions.test.mjs` 强制检查：

1. `assets/live2d/aliya/16.model3.json` 的 Expressions/Motions 与目录同名
2. `assets/live2d/aliya/actions.json` 只放动作的 `face` 时间轴（替换脸），条目名必须是目录里的 Live2D 动作

## 测试与验收

- 后端：`test/unit/agent-performance-cue.ts`（剥离、白名单过滤、协议块渲染、
  清单规范化）；前端 `agent-message-segments.test.ts`。
- 桌宠：`redesign/ui` 的 `npm test` 覆盖分段成页、compose → cue 页与行内剥离、
  ChatPerformance 持久表情/拿回/让位/限频/取消不复活、send 携带清单、
  face-cue 替换脸逐帧断言；`npm run build` 通过。
- **实机验收归用户**：真模型上「表情持续到下一段、动作只播一次、限频、关闭聊天
  复位」；MSK 网页查看同一会话指令不显示、编辑可见；网页轮次后桌宠轮次正常诱导。
