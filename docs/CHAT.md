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
ChatPerformance（表情/动作表演：AI 指令驱动，表情持久、动作一次限频；触碰优先）
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
  reply 150–默认比例、setup 至少 300 CSS px。连接/会话屏按 setup 全高；
  Windows 的记录与上下文定位已迁入独立 `records` 窗口，不再撑大贴附桌宠的
  GAL 面板。
- chat 不提供独立拖动；pet 移动/缩放时 chat 严格跟随。水平方向 pet 中心
  在屏内时 chat 钳回工作区（chat 比 pet 宽，纯居中会在贴边时把发送按钮
  切出屏幕）；pet 中心出屏（被拖出桌面）时 chat 作为影子随之越界。
  chat 打开后隐藏 pet 脚下的入口按钮（pet 侧 `.chat-launcher[hidden]`
  需 `display:none!important` 压过自身的 `display:flex`），关闭后恢复。
- 视觉：全应用设计 token 统一在 `ui/src/styles/tokens.css`（Jade Terminal
  深色阶、玉石绿主色、低对比边框、圆角、阴影、动效、焦点环），pet/聊天/
  设置/记录/托管抽屉只引用变量，不自造色值。页面底色 `#0B1210`，卡片与面板
  `#121B17`，主操作 `#63E6BE`，链接与悬停强调 `#2FCF9C`；不使用装饰渐变或
  强发光。透明窗口内的面板/输入框保留半透明（透出桌面与模型，backdrop 10px
  模糊），字号随窗口宽度自适应（`.chat-shell` container-type + cqw clamp
  11.5–13px）；名牌条 25px 高，工具栏保留记录/会话/会话配置/发送/×（退出账号
  在会话屏内）。按钮分级：主操作 `.btn-primary` 玉绿色药丸（与发送一致），
  次要 `.ghost` 淡边框胶囊（`#chat-ui button` 的 ID 规则会压过类选择器，
  border/radius 需 `!important`）。chat 打开即自动聚焦输入框（仅 tauri，内嵌
  不抢软键盘），composer 有 `:focus-within` 玉绿色聚焦环；历史角色标签
  who-user/who-aliya 双色区分。
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
  窗口永久隐藏备用入口。设置主菜单的「聊天」区只展示 Misskey 连接状态、
  当前会话和会话配置，不再提供冗余的“打开聊天窗口”按钮。

Android 主界面内嵌 ChatView，记录使用同源辅助页；悬浮窗不初始化聊天。
web 开发模式保留内嵌记录。安卓容器与验收边界见 [ANDROID.md](ANDROID.md)。

## 实例地址与开发配置

实例地址统一在 `redesign/ui/src/chat/msk/config.ts` 中定义，API、MiAuth、
消息渲染请求与托管控制台共用 `MSK_BASE`。Windows 开发启动命令：

```bash
cd redesign
npm run dev                                  # https://misskey.liminalselves.top
npm run dev -- http://127.0.0.1:3000         # 使用指定实例
```

`redesign/scripts/dev.mjs` 校验参数后通过 `VITE_MSK_ORIGIN` 传给 Tauri 启动的
Vite 服务。参数必须是仅含协议、主机和可选端口的 `http://` 或 `https://`
地址，不能带路径、查询串或凭证；多传参数会直接报错。启动日志会输出实际实例。
命令不读取 `.env.development.local` 来决定实例，因此省略参数始终使用默认远程地址。
生产构建同样默认使用远程地址。

登录 token、用户、待完成授权与选中会话按实例隔离；默认实例沿用原来的
存储键，其他实例追加 `@{origin}`。切换实例后需在对应实例重新授权。
Aliya 角色与文风 ID 仍采用 `msk/client.ts` 的固定值，本地数据库需有对应数据。

## 托管会话配置

入口有两处：设置窗口 → 聊天 → **配置当前会话**，以及聊天输入栏“会话”旁的
齿轮按钮。二者打开同一个设置窗口与同一抽屉控制器；未登录或未选择会话时禁用。
设置窗口在 Tauri 启动时隐藏预创建，关闭只隐藏复用，避免 Windows 命令线程动态
创建第二个 WebView2 的死锁问题。抽屉不进入贴附桌宠的聊天窗，因此不改变其尺寸
和跟随规则。
提供模型、生图、主动消息、记忆、世界书、规则、对话风格、会话八个面板。

协议权威来源：`C:/Users/35581/Desktop/misskey/docs/agent-control-embed.md`。
宿主实现位于 `msk/control.ts`、`control-drawer.ts` 与 `control-bridge.ts`：

- iframe 加载 `/agents/embed/{sessionId}/{panel}`；收到 ready 后通过
  `postMessage` 注入 token 和紫灰色主题，校验消息的 origin 与 source。
  token 不进入 URL；已认证时切换面板用 `set-panel` 让 iframe 内部跳转
  路由，不重载；未完成认证或点击重试时才销毁重建，关闭抽屉或页面
  卸载时释放 iframe 与监听器。
- 抽屉固定高度，内部页面自己滚动。认证错误或加载超时显示中文提示和重试入口。
- 登录或选中会话变化会关闭旧面板；同账号令牌变化通过 update-token 更新。
- 修改成功后刷新会话摘要并通知聊天重新读取上下文；删除当前会话后清理选择。
- 消息与上下文分界导航在 Windows/Android 交给共用的 `records` 页，web 开发
  仍使用 ChatView 内嵌面板；都读取目标附近的可见时间线，不使用消息编辑接口。
  目标不存在时显示提示。
- 外部链接通过平台已有 `openUrl` 打开。聊天本身不嵌入 Misskey 消息列表。

## 验权（MiAuth）

首次使用必须授权；token 存 localStorage（`aliya_msk_token`），
界面只负责打开浏览器和展示状态，不接触密码。token 不写入源码/文档/
日志/Git。

| 平台 | 回调方式 |
| --- | --- |
| Windows（Tauri） | 壳 `miauth_begin(session)` 绑 127.0.0.1 随机端口一次性监听（`miauth.rs`），回调只认 `/miauth/callback?session=匹配`，仅向 chat 窗口发 `miauth-callback {ok,query,session}`；`miauth_end(session)` 按身份取消；5 分钟超时 |
| Android | `AuthRelayActivity` 接 `aliyapet://miauth`，写入 ShellPrefs `miauth_callback` 后返回主界面；保留页轮询换 token，被系统回收后从 pending/callback 恢复 |
| web 开发 | 整页跳转授权，session 记入 `aliya_miauth_pending`，回跳后 `resumeCallback` 恢复换 token；也可手动填 token |

拿到 session 后 `POST /api/miauth/{session}/check` 换 token；
启动时 `POST /api/i` 校验，401/403 视为失效并清除。权限范围与
Aliya_web 相同。

## 会话

- 列表来自 `agents/sessions/list-mine`，只保留 Aliya 角色
  （`characterId == akqruskge8w6003j`）。
- 列表按最近活跃排序，每行显示名称、最后消息预览+相对时间、未读点。
- 「新建会话」复用 `MskClient.createSession`，确认固定文风可用后创建 Aliya 社区会话；
  失败显示原因，可重试。「Misskey」打开浏览器管理会话。
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
  替换；停止等待则收起了占位。可 Esc/× 关闭。
- 回复播放是萝莉斯式逐页对话（`view.ts` + `typewriter.ts`）：assistant
  回复按 MSK 展示分段机制（`rendering/segments.ts`，逐行移植 misskey
  `agent-message-segments.ts`）拆成多页，一段一页；空行分页，代码块/
  表格/列表/引用/跨行生图占位符保持整块，表情包 token 独占一页；
  全站表情名须命中表情表才切分（12:30:45 的 `:30:` 不会被拆散）。
  每页逐字冒出（`Typewriter`：文本按码点逐字，图片/贴纸/代码块等
  原子元素到位置整块淡入，隐藏期间 visibility 保留占位，布局不被
  图片加载挤动）；播放中滚动跟随最新冒字，播完回到页首——超高页
  （大图/长文出滚动条）默认从顶部读起；GAL 式推进：播放中点击直接
  补完本页，播完点击翻页，末页点击收起。点击监听挂在面板捕获阶段，
  纯图片页同样点得动（图片的 msk-zoom 外部打开在播放中让位给翻页，
  放大看图去记录里点）；链接/生图按钮等真交互控件不翻页。播放期间
  gal-content 为 user-select:none：可选文本时快速连点会触发浏览器
  双击选词/三击选段，选区反复重建既吞点击（曾表现为文本页
  「点不动」）又闪高亮；划选复制去记录窗口（非 replying 态仍可选）。
  页脚提示行显示「▼ 点击继续 n/N」。播放等
  渲染 settled 再开始（表情表/生图状态首轮查询完成），之后的生图状态
  更新只静态刷新当前页。面板样式为贴附式：顶部紫色名牌条，窗口锚定
  Live2D 可见矩形并覆盖角色下半部；输入框和回复共用 `chat-shell` 连成
  一张卡片，外窗高度随 composer/reply/setup 状态收放；量高补上
  gal-content 滚动溢出量（面板被 max-height 钳住时不会越量越矮），
  生图/附图解码完成再补量。记录/会话/连接屏不分页不逐字。
- 表演走「表演指令协议」（`PERFORMANCE.md`）：send 请求携带表情/动作清单
  （`performance-manifest.ts`，即桌宠环境标记），AI 回复内嵌独占一行的
  `[[agent_cue express=… play=…]]`；渲染时指令行自成隐藏 cue 页（`msk-cue`），
  翻页播到该页才经 `controller.onCue` 派发——原生窗口走 `send_chat_cue` 跨窗口
  转给 pet，内嵌直调。表情持久到下一个指令、动作只播一次（`ChatPerformance`）。
  记录屏与行内残留一律剥离指令，不回放表演。
- 历史 = 服务器时间线（`messages/timeline`，拉 100 条，过滤 system，
  按时间正序），MSK 模式不写 localStorage。Windows 工具栏「记录」打开
  预创建的可移动、可缩放 `records` 原生窗口：消息按内容自适应气泡
  （用户靠右、Aliya 靠左，阅读栏居中限宽）、跨天插日期分隔条、
  顶部会话摘要与条数、显式刷新；拉取分打开/手动/静默（focus 30s 节流
  与 storage）三档，时间线签名（会话+条数+末条 id）未变就不重渲染、
  DOM 原样保留；打开与手动刷新滚到底部并用 rAF 钉住直到生图卡片与
  图片落定（instant 滚动，用户滚动即取消钉底），静默刷新贴底保持吸底、
  否则保留阅读位置，首次加载用骨架屏，另有回到底部浮钮；重播与图片
  重生成按钮悬停气泡才浮现。重播经 CONTROL_REQUEST_KEY 跨窗请求 chat
  播放：chat 在写入（storage）与忙碌结束时消费，处理期间到达的新请求
  收尾补消费；焦点回归只消化 20 秒内的新鲜请求，陈旧残留直接清除不补播
  （输入框获焦本身不触发任何重渲染或重播）。
  生图对齐 Misskey 智能体卡片形态——图片铺满卡片按自然比例显示无留白，
  不展示「配图」与生图 prompt，仅保留半透明圆形重生成按钮浮于图上；
  无图状态退回上下布局；
  贴纸/全站表情收敛到消息尺度。Windows 关闭只隐藏复用，Android 记录页返回销毁。
  web 保留内嵌记录屏。各界面只展示最近 50 轮（轮 = 一条用户消息及其后的
  Aliya 回复），本地裁掉或服务器还有更早页时显示
  「更早的对话已省略 · 仅显示最近 50 轮」。
- 渲染由 `rendering/MskMessageRenderer` 负责，与 Aliya_web 对齐：
  角色 regexRules（targets 含角色且 effects 含 hide 的规则按序串行
  替换，非法规则跳过）、heart_rate 剥离并钳制 0-300、表情包
  （gif/apng 原图其余缩略图）、自定义 emoji、画图占位状态机
  （liveArrived 自动生成/历史只查状态）、MFM+Markdown、附件图片。
  存储文本里的字面 `<br>` 等价换行（权威端 marked 当 HTML 放行；
  `render.ts` 在解析前还原成行，代码围栏内保持字面），其余 HTML
  仍全部转义。
- 助手消息按 `messageId` 渲染原始消息；时间线消息携带 `file` 附件。

## 行为规则（与普通互动相处）

- 请求期间所有异步事件必须属于当前请求：停止/重发后旧流的迟到
  文本一律丢弃；表演指令页翻到才派发，收起/重开后未派发的不再触发。
- 重试替换失败的助手消息，不重复用户消息；停止保留已有片段。
- 表情指令持久到下一个表情指令或聊天关闭；抚摸/互动占用面部时让位，
  结束（或被情绪引擎覆盖后）逐帧恢复对话表情。
- 聊天窗口开启期间（`chat-state.open`）：随机台词与闲聊静默，
  普通点击只做身体反馈。

## Android

主界面聊天、记录辅助页、八面板配置、双击返回、键盘与授权交接的权威说明
及真机验收表见 [ANDROID.md](ANDROID.md)。悬浮窗只运行基础互动。

## 验证

`redesign/ui` 下 `npm test`（回归、渲染与托管协议）与 `npm run build`；
`redesign/src-tauri` 下 `cargo test`（窗口几何/MiAuth 共 21 项）。
Windows 已实机验收：chat 窗口预创建、贴 pet 右侧底对齐、授权全链路
（错误 session/favicon 404 且监听存活、正确 session 200、未授权时
界面显示错误）、× 收起窗口、边缘避让（pet 贴近右缘时 chat 翻到左侧、
pet 下移时 chat 垂直钳进工作区，均经 SetWindowPos 移动 pet 验证跟随）、
chat 穿透掩码（透明区 ignore=true、面板上 ignore=false）、开关状态跨
重启记忆（双向）。待验收：授权通过后的会话选择与回复渲染、托盘
切换 pet 显隐时 chat 联动（自动化够不到托盘，按代码实现）、Android
deep link 回跳。

2026-09-15 实例配置与托管控制台接入：用户要求停止测试前，55 项单元回归
及前端构建通过。浏览器仅确认设置入口与未连接禁用状态；抽屉点击和截图
未完成，真实授权后的面板保存、消息导航及原生跨窗口联动尚未验收。
后续测试由用户进行；临时无效凭证已清理，本次启动的开发服务已停止。
