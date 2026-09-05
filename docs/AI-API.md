# PetAI 对外接口（AI / 自动化开发指南）

桌宠的全部能力通过 **语义 API** 暴露（不接触底层 Live2D 参数），
入口：`window.petAI`（浏览器/Android WebView 直接调用；Windows Tauri
壳可经 Webview evaluate 调用，后续可按需包 Tauri command）。

分层架构（自下而上叠加，各层互不干扰）：

```
AI / 业务（petAI + 事件总线）
情绪引擎（emotion.ts：心境 → 默认表情 + 动作选择加权，自然衰减）
动作（motion3.json，瞬时行为） ⊕ 表情（exp3.json，持续心境）
视线（gaze.ts GazeController：唯一所有者——指针跟随 × 动作交挖权重
      × 表情注视偏移 → 眼球总钳制）+ 覆盖通道（overlay.ts：抬手/猫耳/
      眨眼覆盖/互动偏移，物理后写入）
物理 · 呼吸 · 眨眼（SDK 调度器，常驻）
```

每帧流水线（pet-model.update，五阶段）：

```
loadParameters → 动作 → saveParameters → 调度器(眨眼→表情→呼吸→物理)
→ GazeController → OverlayLayer → model.update
```

关键规则：**眼球的写入者只有 GazeController 与动作曲线**（动作播放时
跟随权重平滑交挖）；表情不直写眼球——注视偏移（垂眼/回避/斜眼）声明在
`gaze.ts EXPRESSION_GAZE`，与指针跟随合成后统一平滑与钳制（±20 安全
行程）。程序化效果（猫耳/抬手）走 `overlay.ts` 通道，晚于物理求值。

## API 一览

```ts
// 表情（12 个：neutral/happy/angry/sad/surprised/shy/sleepy/
//           smug/speechless/worried/serious/hit）
petAI.expressions()                    // string[]
petAI.express('angry')                 // 切表情（交叉淡入淡出）
petAI.express('hit', 2.5)              // 临时表情，2.5s 后自动回情绪默认
petAI.clearExpression()                // 立即回情绪默认表情

// 情绪（10 档：neutral/happy/cheerful/angry/sad/shy/sleepy/
//        smug/curious/speechless）
petAI.moods()                          // 定义（含动作亲和表）
petAI.setMood('happy')                 // 切心境：默认表情 + 动作加权 + 到期衰减
petAI.setMood('angry', 120)            // 指定 120 秒后回 neutral
petAI.mood()                           // { name, elapsedSeconds }

// 动作（9 个：nod/sway/shake/stretch/wave/doubt/angry/yawn/walk）
petAI.play('wave')                     // 播动作（挥手自动联动抬手）
petAI.state().actions                  // 可用动作名

// 视线（AI 引导注意力）
petAI.gaze(-0.8, 0.2)                  // -1..1，x右y上
petAI.clearGaze()                      // 回跟随指针

// 状态快照（AI 上下文）
petAI.state()                          // { mood, expression, expressions, actions }
```

## 事件总线（window CustomEvent，'pet:*'）

```ts
window.addEventListener('pet:mood', e => {
  // e.detail = { mood: 'happy', previous: 'neutral' }
});
window.addEventListener('pet:expression', e => {
  // e.detail = { expression: 'angry' }（null = 回默认）
});
window.addEventListener('pet:action', e => {
  // e.detail = { action: 'wave' }
});
```

## 典型用法

```ts
// 1) LLM 情感分析驱动表情
const mood = analyzeSentiment(userText);   // 'happy' | 'sad' | ...
petAI.setMood(mood === 'positive' ? 'happy' : mood);

// 2) 说到关键词时配合动作
if (/再见|拜拜/.test(userText)) petAI.play('wave');

// 3) 被骂了：短暂生气然后消气
petAI.setMood('angry', 90);               // 90 秒后自动回 neutral

// 4) 提醒场景：认真模式 + 注视
petAI.setMood('curious');
petAI.gaze(0.3, 0.5);
```

## 扩展指引

- **加表情**：改 `redesign/tools/gen-expressions.py` 配方 → 重新生成 →
  在 `16.model3.json` 的 Expressions 里登记 → `emotion.ts` 的 MOODS 可选挂接。
- **加动作**：改 `redesign/tools/gen-motions.py` → 重新生成 → model3.json
  Motions 登记 → `behavior.ts` ACTION_LIBRARY + `actions.json` 加亲和。
- **加情绪**：`emotion.ts` 的 MOODS 加定义（表情 + 持续时间 + 动作亲和）。
- **Tauri 壳**：`window.__TAURI__` 下可 evaluate 脚本调用 petAI；如需
  原生 command 代理，在 src-tauri 包一层即可（API 已收敛到语义名）。

## 设置窗口控制面板

设置窗口（settings.html）的「表情与情绪」面板走同一套能力（桌面端）：

- 表情按钮 → `tray-action: express`（8 秒预览后自动回情绪默认）；
- 恢复默认表情 → `tray-action: clear-expression`；
- 情绪按钮 → `tray-action: set-mood`，pet 窗口经 `pet-mood` 事件回推，
  面板高亮实时跟随（包括 AI 改的情绪和自然回落）。

即：**菜单手动控制与 petAI 程序控制共享同一状态源**，互相不冲突、
界面始终反映真实状态。

模型能力边界（哪些参数能动/不能动、物理链、值域坑）见 `docs/MODEL.md`。
