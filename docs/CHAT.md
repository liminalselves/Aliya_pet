# AI 聊天系统

聊天是第二套互动系统：连接用户的 Misskey 账号，与 Aliya 智能体对话。
定位是「桌宠对话」而不是聊天工具——记录只是方便回看，平时隐藏，
只有输入框常驻；回复以 gal 风格对话框弹出，可收起。普通互动
（点击/抚摸/拖动）不经过 AI，规则见 `INTERACTION.md`。
MSK 接口细节参考 `Aliya_web/MSK_API_USAGE.md`。

## 分层

```
ChatView（连接/会话/对话三屏；GAL 面板 + 常驻输入框；回复分段逐页播放）
ChatController（请求/取消/重试，只认当前请求的事件）
ChatPerformance（表情/动作表演：表情 3.5s，动作限频；触碰优先）
Typewriter（回复逐字冒出，原子元素整块淡入）
ChatProvider ── MskChatProvider（真实对话）
MskClient / MskAuth（MSK HTTP 与 MiAuth 验权）
MskMessageRenderer（rendering/：完整 MSK 消息渲染与展示分段）
```

代码位于 `redesign/ui/src/chat/`，集成点在 `pet-app.ts`（Windows
与内嵌模式）与 `chat/window.ts`（独立聊天窗口入口）。

## 窗口形态（Windows/Tauri）

聊天是独立原生窗口 `chat`（tauri.conf.json 声明，启动预创建
`visible:false`；命令线程里 build() 第二个 WebView2 在 Windows 实测
死锁，故不做按需创建）。几何与跟随逻辑在 `src-tauri/src/chat_window.rs`：

- pet 前端上报 Live2D 实际可见矩形（按与渲染矩阵相同的 aspect-fit 计算），
  不用含透明留白的 pet 外窗。chat 水平居中并覆盖该矩形下半部：composer
  压住脚线，回复/连接面板向上覆盖腿部，形态对齐萝莉斯而非模型下挂网页。
- chat 宽按可见模型宽 × 1.18（钳 260–560 CSS px）；外窗高度由前端
  `set_chat_layout(mode,contentHeight)` 按内容态动态调整：composer 62–88、
  reply 150–默认比例、setup 至少 300 CSS px，连接页不会再被小窗裁切。
- chat 不提供独立拖动；pet 移动/缩放时 chat 严格跟随。水平方向 pet 中心
  在屏内时 chat 钳回工作区（chat 比 pet 宽，纯居中会在贴边时把发送按钮
  切出屏幕）；pet 中心出屏（被拖出桌面）时 chat 作为影子随之越界。
  chat 打开后隐藏 pet 脚下的入口按钮（pet 侧 `.chat-launcher[hidden]`
  需 `display:none!important` 压过自身的 `display:flex`），关闭后恢复。
- 视觉：面板/输入框半透明（rgba .74–.90，透出桌面与模型），字号随窗口
  宽度自适应（`.chat-shell` container-type + cqw clamp 11.5–13px）；
  名牌条 23px 高，工具栏只留 记录/会话/发送/×（退出账号在会话屏内）。
  按钮分级：主操作 `.btn-primary` 紫药丸（与发送一致），次要 `.ghost`
  淡边框胶囊（`#chat-ui button` 的 ID 规则会压过类选择器，border/radius
  需 `!important`）。chat 打开即自动聚焦输入框（仅 tauri，内嵌不抢软键盘），
  composer 有 `:focus-within` 紫色聚焦环；历史角色标签 who-user/who-aliya
  双色区分。
- 锚点由 pet 前端 `sync_chat_anchor(x,y,w,h)` 上报（物理像素，与
  `update_hit_mask` 的 win_* 同源）；未上报回退原生查询。
- 壳命令：`show_chat`/`hide_chat`/`sync_chat_anchor`/
  `set_chat_state(busy,typing)`/`send_chat_cue(cue)`；
  事件：`chat-state {busy,typing,open}`（全局）、`chat-cue`（payload 即
  PerformanceCue 对象，全局）、`chat-window-state {open}`（仅 pet）。
- 穿透掩码按窗口标签区分（`HitMaskState` 为 label→HitMask 表，点击穿透
  轮询同时服务 pet 与 chat）：pet 上报动态角色剪影（1.5s 无更新回退
  可交互）；chat 由 `chat/window.ts` 每 500ms 上报面板+输入框的静态矩形
  （sticky，不做陈旧回退），透明死区点击穿透到下层窗口。
- pet 显隐与 chat 联动：托盘隐藏 pet 时 chat 随之隐藏并记住开关
  （`on_pet_hidden`/`on_pet_shown`），pet 恢复时带回之前开着的 chat。
- 开关状态跨重启记忆：pet 前端在 `chat-state` 监听里把 open 写入
  localStorage `aliya_chat_open`，启动时据此自动恢复 chat 窗口。
- pet 窗口的「聊天」按钮是开关：打开后再点收起（按 `chat-state.open`
  决定发 `show_chat`/`hide_chat`，并据此切换高亮）；独立 chat 页监听该
  状态同步恢复 ChatView，避免关闭后再次打开只剩内嵌备用小按钮；独立
  窗口永久隐藏备用入口。设置主菜单的「聊天」区展示 Misskey 连接状态
  与当前会话，并可打开聊天窗口。

Android/web 无独立窗口：ChatView 内嵌 pet 页（Android 主界面默认展开；
悬浮窗不创建聊天 UI）。chat 页面与 pet 页共用同一套 ChatView/渲染代码。

## 验权（MiAuth）

首次使用必须授权；token 存 localStorage（`aliya_msk_token`），
界面只负责打开浏览器和展示状态，不接触密码。token 不写入源码/文档/
日志/Git。

| 平台 | 回调方式 |
| --- | --- |
| Windows（Tauri） | 壳 `miauth_begin(session)` 绑 127.0.0.1 随机端口一次性监听（`miauth.rs`），回调只认 `/miauth/callback?session=匹配`，仅向 chat 窗口发 `miauth-callback {ok,query,session}`；`miauth_end(session)` 按身份取消；5 分钟超时 |
| Android | manifest 注册 `aliyapet://miauth` deep link；MainActivity 把查询串写入 ShellPrefs `miauth_callback`，前端轮询取走后清除；冷启动不丢（偏好持久） |
| web 开发 | 整页跳转授权，session 记入 `aliya_miauth_pending`，回跳后 `resumeCallback` 恢复换 token；也可手动填 token |

拿到 session 后 `POST /api/miauth/{session}/check` 换 token；
启动时 `POST /api/i` 校验，401/403 视为失效并清除。权限范围与
Aliya_web 相同。

## 会话

- 列表来自 `agents/sessions/list-mine`，只保留 Aliya 角色
  （`characterId == akqruskge8w6003j`）。
- 列表按最近活跃排序，每行显示名称、最后消息预览+相对时间、未读点。
- 无会话时提示去 Misskey 创建（客户端不做创建）。
- 选中的会话按用户存 `aliya_session:{userId}`（JSON `{id,name}`，名称供
  设置页展示），下次验证 token 后自动恢复。

## 对话与渲染

- `messages/send` 同步回复（120s 超时），`clientRequestId` 为 UUID；
  失败重试复用同一 id，避免上游产生重复消息。
- 回执缺失兜底（对齐 Aliya_web 的成熟做法）：空 200/204、网关 5xx、
  网络超时都视为「消息可能已送达」，改为轮询时间线——先确认本次用户
  消息落库，再取其后的助手回复（最长 90s）。`AGENTS_LLM_FAILED` 属于
  服务端已回滚本轮并释放锁的瞬时失败，客户端使用同一 clientRequestId
  退避重试两次；仍失败才显示中文提示。其他已知错误码（余额不足、回复
  pending、审核拦截等）也翻译成中文，不向界面泄漏服务器英文原文。
- 回复为单个 segment（不再按句切分），带 `messageId`；发送后 GAL 面板
  立即弹出显示「正在输入」三点动画（gal-in 出场动效），回复到达后原位
  替换；停止等待则收起了占位。可 Esc/收起。
- 回复播放是萝莉斯式逐页对话（`view.ts` + `typewriter.ts`）：assistant
  回复按 MSK 展示分段机制（`rendering/segments.ts`，逐行移植 misskey
  `agent-message-segments.ts`）拆成多页，一段一页；空行分页，代码块/
  表格/列表/引用/跨行生图占位符保持整块，表情包 token 独占一页；
  全站表情名须命中表情表才切分（12:30:45 的 `:30:` 不会被拆散）。
  每页逐字冒出（`Typewriter`：文本按码点逐字，图片/贴纸/代码块等
  原子元素到位置整块淡入，隐藏期间 visibility 保留占位，布局不被
  图片加载挤动）；点击对话框补完当前页，补完后点击翻页，末页点击
  收起；页脚提示行显示「▼ 点击继续 n/N」。播放等渲染 settled 再开始
  （表情表/生图状态首轮查询完成），之后的生图状态更新只静态刷新当前页。
  面板样式为贴附式：顶部紫色名牌条，窗口锚定 Live2D 可见矩形并覆盖
  角色下半部；输入框和回复共用 `chat-shell` 连成一张卡片，外窗高度随
  composer/reply/setup 状态收放。记录/会话/连接屏不分页不逐字。
- MSK 不返回表演信息：本地关键词轻量推断表情（开心/害羞/担心），
  经 `send_chat_cue` 跨窗口转给 pet 表演；没有就不表演。
- 历史 = 服务器时间线（`messages/timeline`，60 条，过滤 system，
  按时间正序），默认隐藏，经工具栏「记录」查看；MSK 模式不写
  localStorage。
- 渲染由 `rendering/MskMessageRenderer` 负责，与 Aliya_web 对齐：
  角色 regexRules（targets 含角色且 effects 含 hide 的规则按序串行
  替换，非法规则跳过）、heart_rate 剥离并钳制 0-300、表情包
  （gif/apng 原图其余缩略图）、自定义 emoji、画图占位状态机
  （liveArrived 自动生成/历史只查状态）、MFM+Markdown、附件图片。
- 助手消息按 `messageId` 渲染原始消息；时间线消息携带 `file` 附件。

## 行为规则（与普通互动相处）

- 请求期间所有异步事件必须属于当前请求：停止/重发后旧流的迟到
  文本与动作一律丢弃。
- 重试替换失败的助手消息，不重复用户消息；停止保留已有片段。
- 表情提示持续 3.5s；抚摸/互动占用面部时让位，结束恢复对话表情。
- 聊天窗口开启期间（`chat-state.open`）：随机台词与闲聊静默，
  普通点击只做身体反馈。

## Android

- 主界面（非悬浮窗）默认展开聊天；`adjustResize` + IME insets 让
  键盘不遮挡输入；需要 INTERNET 权限。
- 悬浮窗（`_wrapWindow`）不创建聊天 UI，也不读取/发送会话。

## 验证

`redesign/ui` 下 `npm test`（回归 + 渲染共 49 项）与 `npm run build`；
`redesign/src-tauri` 下 `cargo test`（窗口几何/MiAuth 共 21 项）。
Windows 已实机验收：chat 窗口预创建、贴 pet 右侧底对齐、授权全链路
（错误 session/favicon 404 且监听存活、正确 session 200、未授权时
界面显示错误）、× 收起窗口、边缘避让（pet 贴近右缘时 chat 翻到左侧、
pet 下移时 chat 垂直钳进工作区，均经 SetWindowPos 移动 pet 验证跟随）、
chat 穿透掩码（透明区 ignore=true、面板上 ignore=false）、开关状态跨
重启记忆（双向）。待验收：授权通过后的会话选择与回复渲染、托盘
切换 pet 显隐时 chat 联动（自动化够不到托盘，按代码实现）、Android
deep link 回跳。
