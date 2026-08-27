# 动作接入指南

当前 9 个动作是**官方示例（Hiyori）占位文件**，等 Aliya 真动作库导出后
直接替换同名文件即可，接口已就绪。

## 动作清单与文件位置

`redesign/ui/assets/live2d/aliya/motions/`

| 动作 | 文件 | 所属组（model3.json `Motions`） |
| ---- | ---- | ------------------------------- |
| 摇摆 | `sway.motion3.json`  | `sway`   |
| 点头 | `nod.motion3.json`   | `nod`    |
| 摇头 | `shake.motion3.json` | `shake`  |
| 疑惑 | `doubt.motion3.json` | `doubt`  |
| 挥手 | `wave.motion3.json`  | `wave`   |
| 伸展 | `stretch.motion3.json` | `stretch` |
| 生气 | `angry.motion3.json` | `angry`  |
| 打哈欠 | `yawn.motion3.json` | `yawn`   |
| 走路 | `walk.motion3.json`  | `walk`   |

组名与 `ui/src/behavior.ts` 的 `ACTION_LIBRARY` 一一对应；新增/改名动作请
同步改该数组与 `model3.json` 的 `Motions` 节（含 FadeInTime/FadeOutTime）。

## 替换步骤

1. 在 Cubism Editor 里用 **Aliya 模型**做动作，导出为 Cubism 4/5 格式，
   得到 `.motion3.json`（可直接导入官方 Demo 工程导出）。
2. 覆盖 `motions/` 下同名文件（保留模型参数 ID 不变即可；
   `model3.json` 引用的就是这些文件名）。
3. 重新构建前端：`cd redesign/ui && npm run build`
   （Windows 走 tauri dev 自动热载；Android 重新 `assembleDebug`）。

## 注意事项

- **动作一致性检查**：占位动作来自别的模型，前端加载时已关闭
  `CubismUserModel.loadMotion` 的一致性检查（`shouldCheckConsistency=false`）。
  换成 Aliya 自己的动作后仍可保持关闭（无害），但**不要**反过来开。
- **手臂互斥（pose3.json）**：当前 4.2 导出不带 pose 文件。
  若真动作用到「默认手臂组 / 举起组」互斥（旧版有 PartArmA/B 逻辑），
  需要同时提供 `pose3.json` 并在 `16.model3.json` 的 `FileReferences` 里加
  `"Pose": "16.pose3.json"`；前端 `PetModel` 目前未 loadPose，需补一步
  （在 `loadFromSetting` 的 moc 之后加载 + 复位默认组）。

## 动作余量重新测量

渲染余量（`ui/src/pet-app.ts` 的 `_renderMarginRatio`，当前 1.45）是为占位
动作的摆动幅度定的；换成 Aliya 真动作后应重新测量收紧（占位动作摆动比
真动作大得多，1.45 会让角色偏小）。

测量方法（挂上真动作后）：

```bash
# 逐个动作播放，采样模型空间包围盒（模型单位）：
node tools/cdp-eval.mjs "(async()=>{ const a=window.__pet; const md=a.model._model;
 const s=()=>{let mn=1e9,mx=-1e9; const dc=md.getDrawableCount();
  for(let i=0;i<dc;i++){const v=md.getDrawableVertices(i); for(let j=0;j<v.length;j+=2){mn=Math.min(mn,v[j]);mx=Math.max(mx,v[j]);}}
  return [mn,mx];}; a.model.playAction('sway'); const t0=performance.now();
 let L=1e9,R=-1e9; while(performance.now()-t0<4500){const [l,r]=s(); L=Math.min(L,l);R=Math.max(R,r);
  await new Promise(r=>setTimeout(r,70));} const b=a.model; return JSON.stringify({minX:L,maxX:R,
  needMin: (2*Math.max(-L,R))/(0.64*b.boundsH)});})()"
```

约束：`余量 ≥ maxX / (0.32 × boundsH)`（水平）且 `≥ maxY / (0.5 × boundsH)`
（垂直），取最差 ×1.05 安全系数。用新值替换 `_renderMarginRatio`。

## 旧版动作文件（参考）

git 历史里的 `windows/Assets/Live2D/Aliya/Actions/*.json` 是旧 C# 版自己的
**自定义 keyframe 格式**（`channels/parameter/keyframes/weight`），**不是**
Cubism motion3.json，不能直接替换；如需要可参考其参数范围与时间轴上卷为
Cubism 动作，但建议直接用 Cubism Editor 导出。
