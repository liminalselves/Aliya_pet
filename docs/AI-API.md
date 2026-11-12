# PetAI 对外接口（AI / 自动化开发指南）

桌宠的全部能力通过 **语义 API** 暴露（不接触底层 Live2D 参数），
入口：`window.petAI`（浏览器/Android WebView 直接调用；Windows Tauri
壳可经 Webview evaluate 调用，后续可按需包 Tauri command）。

分层架构（自下而上叠加，各层互不干扰）：

```
AI / 业务（petAI + 事件总线）
状态引擎（state.ts：默认表情 + 待机动作池；手动优先，自动按时段）
动作（motion3.json，瞬时行为） ⊕ 表情（exp3.json，持续的脸）
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

关键规则：**眼球的写入者只有 GazeController 与动作曲线**。任何动作播放期间
（待机、互动、AI 指令、设置试放；状态只设默认表情，不算动作）头部与眼球都完全交给
动作曲线，指针跟随与表情注视偏移让位，播完约 0.2s 时间常数淡回跟随；表情不直写眼球——
注视偏移（垂眼/回避/斜眼）声明在 `gaze.ts EXPRESSION_GAZE`，与指针跟随合成后统一平滑
与钳制（±20 安全行程）。程序化效果（猫耳/抬手）走 `overlay.ts` 通道，晚于物理求值。

## API 一览

表情、动作、状态的名字与含义只在 `ui/src/catalog.ts` 定义（三概念见 `PERFORMANCE.md`）。

```ts
// 表情：临时覆盖，结束后回当前状态的默认表情
petAI.expressions()                    // string[]
petAI.express('angry')                 // 切表情（交叉淡入淡出）
petAI.express('hit', 2.5)              // 2.5s 后自动回状态默认表情
petAI.clearExpression()                // 立即回状态默认表情

// 动作：Live2D 动作与互动程序微动共用一个入口
petAI.play('wave')                     // 播动作（挥手自动联动抬手）
petAI.play('nuzzle')                   // 程序微动（蹭手）
petAI.state().actions                  // 可用动作名

// 状态：默认表情 + 待机动作池；手动指定后一直保持
petAI.states()                         // 定义列表
petAI.setState('sleepy')               // 手动指定
petAI.setState(null)                   // 回到自动（当前为平静）

// 视线（AI 引导注意力）
petAI.gaze(-0.8, 0.2)                  // -1..1，x右y上
petAI.clearGaze()                      // 回跟随指针

// 快照（AI 上下文）
petAI.state()                          // { state, manual, expression, expressions, actions }
```

## 事件总线（window CustomEvent，'pet:*'）

```ts
window.addEventListener('pet:state', e => {
  // e.detail = { state: 'sleepy', manual: null, previous: 'neutral' }
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
// 1) 说到关键词时配合动作
if (/再见|拜拜/.test(userText)) petAI.play('wave');

// 2) 被骂了：短暂生气，3 秒后回到状态默认表情
petAI.express('angry', 3);

// 3) 提醒场景：认真脸 + 注视
petAI.express('serious');
petAI.gaze(0.3, 0.5);
```

## 扩展指引

- **加表情**：改 `redesign/tools/gen-expressions.py` 配方 → 重新生成 →
  在 `16.model3.json` 的 Expressions 里登记 → `catalog.ts` 的 `EXPRESSIONS` 补条目。
- **加动作**：改 `redesign/tools/gen-motions.py` → 重新生成 → model3.json
  Motions 登记 → `catalog.ts` 的 `ACTIONS` 补条目，并加进需要的状态待机池
  （用替换脸时在 `actions.json` 写 `face` 时间轴，见 ACTIONS.md）。
- **加状态**：`catalog.ts` 的 `STATES` 加定义（默认表情 + 待机池）。
- **加互动反应**：只改 `assets/interaction/reactions.json`（见 `INTERACTION.md`）。
- **Tauri 壳**：`window.__TAURI__` 下可 evaluate 脚本调用 petAI；如需
  原生 command 代理，在 src-tauri 包一层即可（API 已收敛到语义名）。

## 设置窗口控制面板

设置窗口（settings.html）的「表情与状态」面板走同一套能力：

- 表情按钮 → `tray-action: express`（8 秒预览后回状态默认表情）；
- 恢复默认表情 → `tray-action: clear-expression`；
- 状态按钮 → `tray-action: set-state`（name 为空 = 自动），pet 窗口经 `pet-state`
  事件（Android 为 localStorage `aliya_pet_state`）回推，面板高亮跟随。

即：**菜单手动控制与 petAI 程序控制共享同一状态源**，互相不冲突、
界面始终反映真实状态。

模型能力边界（哪些参数能动/不能动、物理链、值域坑）见 `docs/MODEL.md`。
