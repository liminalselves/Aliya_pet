# 动作接入指南

## 2026-09-08 挥手新版接入

运行时已按实际参数兼容两种模型：包含 Param30/31/36 时使用新版
挥手开关、小臂和手部控制；否则继续使用当前模型的右手五段链。
两种控制都在物理之后执行，支持重复播放、打断和结束复位；
playAction、startMotion、startRandomMotion 均联动手部通道。

正式资源已替换为 PET.zip 中的完整模型，保留入口名称 16.model3.json、
16.moc3、16.physics3.json、16.cdi3.json；纹理改为 aliya.2048/texture_00.png。
现有 9 个动作、12 个表情和 actions.json 保留，LipSync 仍不启用。
Param30 使用 0/1 端点切换手臂图层，Param31/36 在物理后控制摆动，
避免 PhysicsSetting15 覆盖动作；结束与打断后显式归零。
挥手外观已在浏览器检查，真实模型在 15/30/60fps 下完成全部动作、
表情加载、特殊眼型互斥、重复挥手、打断复位及眼睛/耳朵/脸红互动检查。
测试入口：开发服务器的 /tests/model-preview.html（不进入生产构建）。
测得 maxX=0.373701、maxY=0.535082，含 5% 安全系数需求约 1.21746，
当前渲染余量 1.22 足够。新增更大动作仍需重新测量。

当前 9 个动作已是为新 Aliya 模型（aliya 重置版）**自编的动作**，
由 `redesign/tools/gen-motions.py` 生成，不再是官方示例占位文件。
修改动作请改生成器里的关键帧再重新生成：

```bash
python redesign/tools/gen-motions.py   # 同时写入 assets/ 与 dist/
cd redesign/ui && npm run build        # 或重新构建让 dist 生效
```

## 动作清单与文件位置

`redesign/ui/assets/live2d/aliya/motions/`

| 动作 | 文件 | 所属组（model3.json `Motions`） | 设计要点 |
| ---- | ---- | ------------------------------- | -------- |
| 摇摆 | `sway.motion3.json`  | `sway`   | AngleZ ±6 周期摇摆 + 笑眼 |
| 点头 | `nod.motion3.json`   | `nod`    | AngleY 两次点头（-11），低点半闭眼 |
| 摇头 | `shake.motion3.json` | `shake`  | AngleX ±12 两次，眉毛下压 |
| 疑惑 | `doubt.motion3.json` | `doubt`  | 歪头 AngleZ 10 保持 + 不对称挑眉 |
| 挥手 | `wave.motion3.json`  | `wave`   | AngleZ 摆动 + 满笑眼/嘴角/张嘴 + **抬右手摇摆**（代码通道，见下） |
| 伸展 | `stretch.motion3.json` | `stretch` | 闭眼后仰伸懒腰 + 收尾甩头 |
| 生气 | `angry.motion3.json` | `angry`  | Param32 生气阴影 + 怒眉 + 头部颤抖 |
| 打哈欠 | `yawn.motion3.json` | `yawn`   | 闭眼大张嘴 + 抬头后仰 |
| 走路 | `walk.motion3.json`  | `walk`   | BodyAngleZ ±5 步态摇摆 + 身体起伏 |

组名与 `ui/src/behavior.ts` 的 `ACTION_LIBRARY` 一一对应；新增/改名动作请
同步改该数组、`model3.json` 的 `Motions` 节（含 FadeInTime/FadeOutTime）和
生成器的动作表。

## 自编动作的工程约束（重要）

1. **只写存在的参数**。新模型可用参数见生成器头部注释；**手臂参数
   （ParamArmL01/02、ParamArmR01/02）在 PET 版已绑定变形器，范围均为 ±10；
   当前动作仍沿用原配方，挥手使用专用通道**。`Param33/34/35` 会切换整套特殊眼睛，
   中间值和交叉淡化会产生重影；动作仅保留 0 值复位曲线。
2. **每条动作必须带全套复位曲线**（生成器的 `base_reset`：16 个表情参数
   归 0、眼睛归 1、头身角度归 0）。否则上一个动作/互动写入的值会经
   `saveParameters` 残留到下一个动作。
3. **所有曲线必须在 Duration 结束前回到默认值**（生成器统一加
   `TAIL_SECONDS = 1.2s` 尾垫）。Cubism Web Framework 在动作自然播放完毕时
   不做完整淡出，最后一帧求值会被 `saveParameters` 冻结——不带尾垫的
   生气动作会让脸黑（Param32≈0.17）永久挂在脸上。
4. Meta 计数会被 `hasConsistency()` 校验：Linear 段 3 元素/段、Bezier 段
   7 元素/段，TotalPointCount = 1 + Linear×1 + Bezier×3。改生成器不要
   破坏计数。
5. **眼球曲线（ParamEyeBallX/Y，值域 ±30）**：该模型眼球参数不是官方惯例
   的 ±1 而是 ±30——按 ±1 写只有 3% 行程，几乎看不见。动作带视线表演
   （点头垂眼、疑惑斜瞟、生气下压瞪人等，常用 5~11）。**动作播放期间
   视线跟随按权重平滑交挖**（gaze.ts GazeController 单一所有权：指针跟随
   ×交挖权重×表情注视偏移→动态径向钳制），动作曲线与跟随交叉淡化衔接。
   每条动作必须带眼球复位曲线（base_reset 已含）。方向：X+ 画面右、Y+ 上。
6. **嘴/眉要动态**：参考旧版 Hiyori 占位动作的节拍风格——眉毛随节拍起伏
   （±0.2~0.7）、嘴角随剧情渐变而非长平台、嘴巴在节拍上轻张轻收
   （0.1~0.3）。长期平坦的微笑曲线会让角色「僵笑」。
7. **笑眼与注视互斥**：满笑眼（弯月，EyeSmile≥0.7）**不要带注视曲线**——
   瞳孔/高光物理链（输入：头部角度 + 闭眼）不跟眼球走，弯月眼里移瞳会把
   高光顶出弧线外，呈现「破相」。轻度笑眼（≤0.4）注视幅度收小（≤±5）。

## 动作余量重新测量

渲染余量（`ui/src/pet-app.ts` 的 `_renderMarginRatio`，当前 **1.22**）按
PET 版现动作实测：水平 maxX 0.373701 / 垂直 maxY 0.535082（模型单位，
静态包围盒约 0.635599×1.007191），取水平/垂直最大需求并乘 1.05
安全系数 = 1.21746 → 1.22。
（旧占位动作摆动大得多，当时是 1.45。）

改动动作幅度后重新测量（手动步进法，页面隐藏时 rAF 不跑）：

```js
// 在页面 console / CDP evaluate 里：
const app = window.__pet, pm = app._model, md = pm._model;
app._behavior.autoActions = false;
const dyn = () => { let a=1e9,b=-1e9,c=1e9,d=-1e9;
  for (let i=0;i<md.getDrawableCount();i++){const v=md.getDrawableVertices(i);
    for(let j=0;j<v.length;j+=2){a=Math.min(a,v[j]);b=Math.max(b,v[j]);
      c=Math.min(c,v[j+1]);d=Math.max(d,v[j+1]);}} return [a,b,c,d]; };
pm.playAction('wave'); let X=0,Y=0;
for(let t=0;t<4.2;t+=1/30){ app._update(1/30); app._render();
  const [l,r,b,tp]=dyn(); X=Math.max(X,-l,r); Y=Math.max(Y,-b,tp); }
// 余量 ≥ X/(0.32×pm.boundsH) 且 ≥ Y/(0.5×pm.boundsH)，取最差 ×1.05
```

## 旧模型抬手通道（兼容回退）

模型有两条「手部物理链」：`Param_Angle_Rotation_1..5_ArtMesh60`（左手）/
`.._ArtMesh61`（右手），五段旋转驱动整条小臂+手，**左手正角抬起、右手负角
抬起**（±45 满量程可把手举到头侧，实测位移 ≈0.28 模型单位）。

但它们是**物理输出**（physics3.json PhysicsSetting13/14，输入 BodyAngleX/Z），
物理每帧覆盖，所以 **motion3.json 曲线写不住**——抬手只能像猫耳一样走代码
通道：`pet-model.ts` 的 `_handRaiseR`（0..1），在物理求值后、`model.update()`
前加写。目前由 `playAction('wave')` 触发包络（0.45s 举起 → 保持 + 指尖摆动
→ 2.55s 起 0.6s 放下，被打断平滑回落）。要让别的动作抬手，在同一个包络
里加触发即可；物理基础摆动会自然叠加在抬起姿态上。

## 猫耳互动映射（已适配）

新模型没有旧版的 `ParamEarL/ParamEarR`；耳朵由物理输出 **Param9/Param13**
（左/右晃动1，cdi3「猫耳」组）驱动。`pet-model.ts` 加载时探测：有原生
ParamEarL/R 用原生（0..1 直写），否则映射物理输出（×12 缩放）。写入点在
物理求值之后、`model.update()` 之前，加写当帧生效（实测 0.8 强度耳尖
抽动 ≈0.05 模型单位位移）。

## 旧版动作文件（参考）

git 历史里的 `windows/Assets/Live2D/Aliya/Actions/*.json` 是旧 C# 版自己的
**自定义 keyframe 格式**（`channels/parameter/keyframes/weight`），**不是**
Cubism motion3.json，不能直接替换；如需要可参考其参数范围与时间轴上卷为
Cubism 动作，但建议直接改 `gen-motions.py` 重新生成。
