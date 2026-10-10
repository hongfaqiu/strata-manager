# 官方页面元素映射

状态：**源码映射完成，待最终视觉验证**。本文不声称像素级一致。视觉截图、几何检查和浏览器验证由最终验收补充。

## 来源与明确例外

基准为官方 Strata `serve/web`（revision `fb58e0dbc8399662c0e47c76578c6e878b14f6cf`） 的 `index.html`、`app.js`、`app.css`、`components.css`、`tokens.css`、`monitor.html`、`monitor.js`，2026-10-10 读取。`app.css`、`components.css`、`sprite.svg` 保留上游字节；`tokens.css` 仅字体路径改为 `../fonts/...`。Scoped CSS 为原属性值加选择器作用域，API Monitor CSS 从官方 HTML 内联样式提取。许可和字体许可保存在 `src/official/LICENSE.strata` 和 `src/fonts/OFL.txt`。

用户最新布局要求优先于官方全屏外壳与三 tab 导航：使用持久左侧导航以及共用的嵌套工作区布局。`layouts/AppLayout.tsx` 定义模块级 `AppLayout` / `Sidebar`；`layouts/WorkspaceLayout.tsx` 定义模块级 `WorkspaceLayout` / `WorkspaceHeader`。页面通过 children 嵌套，组件不因 App 状态更新重新挂载，不另引入路由依赖。所有导航支持 hash 初始定位、刷新和 Back/Forward。

外层管理布局是明确例外：总览、模型、聊天、调优、监控、设置六个主入口，二级页面在工作区中切换。侧栏显式收起/展开，经 core store 持久化 `sidebarCollapsed`；收起仍有图标、title、aria-label 和 aria-current。模型选择放在模型页；语言和主题在侧栏。全局历史入口和历史抽屉已删除，聊天历史回到聊天页内，默认展开，可独立折叠；小工作区默认收起并以 overlay 展开。

共享页头删除 Strata 品牌、Chat/Monitor/About tabs、重复服务下拉与语言主题按钮，统一为当前页面标题和真实服务状态。API Monitor 同样使用此页头，仅保留 API key 授权 action，正文保留原有元素。官方页保留视觉 tokens、控件与主要内容元素；About 中服务密钥和运行配置迁到独立 `pages/RuntimeConfigPage.tsx`，主题/桌面偏好归 Settings，About 保留 engine、硬件、Connect tools，并集中软件版本、存储说明、项目链接和许可。这些位置调整均来自最新用户要求，不计入原全屏几何对照。

聊天独立为 `pages/ChatPage.tsx`：页面拥有 file/input/scroll refs、near-bottom 滚动、输入器尺寸和历史面板；App 只传入状态、send/abort 和会话选择/重命名/删除回调。About 和 Monitoring 分别直接使用独立模块 `OfficialAbout.tsx` / `AboutPage` 与 `OfficialMonitoring.tsx` / `MonitoringPage`。总览独立为 `pages/OverviewPage.tsx`，显示真实 health/model/endpoint/process ownership、context/resource、running tasks 和近期 metrics 请求摘要，快捷操作仍调用实际 core API；缺失显示“–”，任务等待和任务接口失败不会显示为零任务。

`official-pages.css` 为工作区建立 container query：右侧宽度 ≤1000px 时恢复官方两列 metrics、单列 monitor-row/cache/config；API 工作区 ≤950px 改为单列列表/详情。自定义 dropdown 保留标签、值和条件；range 保留 HTML 拖动/键盘语义，轨道与 thumb 完全自绘；number 隐藏原生 spin。系统文件选择器是原生能力，不是网页默认控件。配置输入按官方 38px 高度，speed 的 2.2vw 调整为 2.2cqw 来跟随嵌套工作区宽度。

## 共享管理页头与侧栏

| 原官方元素 / 扩展 | 当前实现 | 状态 / 条件 |
|---|---|---|
| `index.html:22-35` 品牌和 3 tabs | 移除，改 `WorkspaceHeader` 的标题/分组 | 最新用户要求；page h1=`workspace-page-title` 供页面 aria-labelledby 引用 |
| `index.html:30-31`, `app.js:175-194` pill / dot / pill-text | App 的 status slot | 读取/生成/排队来自 metrics；无指标时仅显示真实 loaded/online/连接状态，不推断 idle |
| API Monitor 原 `monitor.html` 70px brand/theme header | `WorkspaceHeader` api variant | 统一简洁 header，仅留授权按钮；正文 title、load/unload 等保持 |
| 当前服务、语言、主题 | `Sidebar` | 全页共享；收起服务图标可展开服务选择器，主题与语言图标仍可访问 |
| Overview | `pages/OverviewPage.tsx` | 缺失值、运行任务 pending/error、HTTP 与 loaded/owned 的区别明确呈现 |

## Chat 与消息动态元素

| 官方 source | 元素 | 实现 | 状态 / 条件 |
|---|---|---|---|
| `index.html:39-47`, `app.css:18-24` | view--chat、chat-scroll、chat、chat-empty、title/sub | `pages/ChatPage.tsx` | 没有消息时显示 Ask anything；副文案带健康接口模型名；缺少档案/离线显示实际提示 |
| `index.html:48-70`, `components.css:85-95` | composer-wrap、st-composer、textarea、bar、spacer、hint | `pages/ChatPage.tsx` | rows=2、自动高度、Enter 发送 / Shift+Enter 换行；near-bottom 自动滚动；当前服务历史搜索、分组、选择/重命名/删除，生成时禁用修改 |
| `index.html:50-58`, `app.js:902-978` | attachments、chip、attach-btn、hidden file input | App `addFiles` / `pages/ChatPage.tsx` | 文本/图像拖放、图片粘贴、健康 images 能力门控、删除附件；无假附件 |
| `index.html:56-62` | attach / new / export / sampling 四个按钮的原排列 | `pages/ChatPage.tsx` | 新建、Markdown 导出、采样；空聊天或生成中禁止导出 |
| `index.html:64-69`, `app.js:762-767` | Stop secondary、Send primary | App `send` / `pages/ChatPage.tsx` | 生成时隐藏 Send 显示 Stop；abort 取消；离线禁止发送 |
| `app.js:569-602`, `app.css:25-52` | st-msg--user、msg-images、chip、st-bubble、You/time meta | `ChatMessageView` | 文本使用纯文字和 pre-wrap；图片缩略图、文件 chip 放在气泡之前 |
| `app.js:603-615`, `app.js:660-685` | assistant think details / bubble / meta / copy | `ChatMessageView` | 流式 reasoning 自动展开；开始回答时自动合起；手动切换保持用户选择；Thinking/Thought for/Thoughts |
| `app.js:616-659`, `app.css:54-69` | tool-call、name/server/preview/badge/time、Arguments/Result/Error | `ToolCall` | 按真实 tool.at 将工具块插入回答；ID 合并、lazy details、截断/字符数、完成/错误/跳过；工具轮次上限为 meta |
| `app.js:491-554`, `components.css:77-82` | Markdown、inline code、st-code、head、pre、copy | `Markdown` / `CodeBlock` | react-markdown + GFM；代码原文本复制、表格/引用/列表/标题支持 |
| `app.js:41-55`, `app.js:846-861` | copy → check 1.5s、usage / tok/s / stopped / tool calls | `OfficialCopyButton` / `ChatMessageView` | 真实 usage；速度按首个内容 token 至结束实测，非虚构 engine decode；失败用 msg-error |
| `app.js:563-567`, `app.js:1076-1083` | 聊天恢复、q shortcut | App 初始化 / activeConversationIds | SQLite/IDB 恢复当前档案会话；`?q=` 在线后仅消费一次并清理 URL；StrictMode 不重复发送 |

## About

| 官方 source | 元素 | 实现 | 状态 / 条件 |
|---|---|---|---|
| `index.html:150-155`, `app.js:369-383` | Model and engine 卡、facts-engine | `OfficialAbout.tsx` / `AboutPage` | model、version/source、context tokens、KV 格式与驻留、experts、speculation、images、projection 文案；缺失行按官方省略 |
| `index.html:156-159`, `app.js:384-390` | This PC 卡、facts-hw | `OfficialAbout.tsx` / `AboutPage` | GPU 名称/容量、CPU/threads、RAM，无法 NVML 读取用真实状态 |
| `index.html:160-164`, `app.js:391-397` | Connect your tools、API 三 facts 与 copy | `OfficialAbout.tsx` / `AboutPage` / `OfficialCopyButton` | base 经 core.normalizeBaseUrl，OpenAI /v1、Anthropic origin、模型名称 |
| `index.html:165-175` | 原 Settings 卡的参数/偏好按新要求迁移 | `pages/RuntimeConfigPage.tsx` / `Sidebar` / Settings | 服务 API key 走 keyring/浏览器会话；主题侧栏共用；About 集中真实软件版本、存储/链接/许可 |
| `index.html:176-183`, `app.js:438-460` | cfg-card / file / note / cfg-form | `pages/RuntimeConfigPage.tsx` | GET /config 成功且有 keys 才显示；所有服务公布字段逐项渲染，bool/enum custom Dropdown、number/text 自绘输入 |
| `app.js:462-487`, `runconfig.py:20-45` | 全部 15 个运行配置字段、cfg-save/cfg-msg | `pages/RuntimeConfigPage.tsx` | 仅提交改动的 `{set}`；空字段 null；保存备份/下次启动提示；中文翻译服务 help、英文沿用 source help |

## Sampling drawer

| 官方 source | 元素 | 实现 | 状态 / 条件 |
|---|---|---|---|
| `index.html:190-193`, `components.css:97-102` | st-drawer、head/title、chevron close、body、scrim | `OfficialDialog` drawer variant | 360px 右抽屉、source padding/gap；新增焦点圈闭、Escape 和焦点恢复 |
| `index.html:194-200`, `app.js:1030-1038` | Thinking label/output、4 段 radio | `SamplingDrawer` / `Segmented` | Off/Low/Medium/xhigh；source 解释文案，off → API none |
| `index.html:201-213` | Temperature/Top-p/Top-k label/output/slider | `SamplingDrawer` / `Slider` | 原范围与步长 0..1.5/0.05、0.05..1/0.05、1..64/1；temperature=0 禁用 top-p/k；greedy 提示 |
| `index.html:214-221` | Max tokens、Seed 独立两行、output/placeholder | `SamplingDrawer` / `NumberField` | 空 max 使用直到完成；空 seed 随机；正整数，spin 外观隐藏 |
| `index.html:222-229`, `app.js:415-429`, `app.js:1026-1028` | Show thinking、MCP、ESP 三 toggle-row 与提示 | `SamplingDrawer` / `Toggle` | 显示思考本机偏好；MCP 仅存在 servers 时显示；ESP 仅 eng.cvec 非 0 时显示和提交 |
| `index.html:230-236`, `app.js:1000-1024`, `app.js:1046-1067` | Use for other apps too、Reset/Apply 两按钮 | `SamplingDrawer` | GET /settings 读 shared；POST /settings 写 defaults 或 null；重置官方采样默认值；本机参数仍持久化 |
| desktop extension | model/systemPrompt | Management Settings 页 | 保留功能但放到管理扩展设置，不插入官方 sampling 行序 |

## Monitor

| 官方 source | 元素 | 实现 | 状态 / 条件 |
|---|---|---|---|
| `index.html:74-87`, `app.js:240-265` | model state card、5 badge、label/detail/progress | `OfficialMonitoring:126-134` | reading/prompt、generating/token、queued、error、idle；null 为缺失状态 |
| `index.html:89-91`, `app.js:109-153`, `app.js:267-307` | 8 metric-card、icon/value/sub、双 Speed、SVG spark | `OfficialMonitoring:16-52`, `OfficialMonitoring:135-142` | decode/prefill + GPU/VRAM/temp/power/PCIe/CPU/disk；真实 history，缺失点断线 |
| `index.html:94-113`, `app.js:309-327` | Context gauge、experts/RAM/temp 3 bars | `OfficialMonitoring:145-150` | 原 270° gauge、ctx 文本/容量与资源比率，不编造缺失值 |
| `index.html:114-127`, `app.js:329-352` | Recent requests 8 columns、Show all、totals | `OfficialMonitoring:151-156` | 请求字段/finish/ESP/PCIe share；超过12才显示按钮；切换真实 /metrics?requests=all |
| `index.html:130-142`, `app.js:205-229` | Conversation cache card / summary / bars / facts / note | `OfficialMonitoring:160-164` | enabled 条件、slots/memory、reused/eviction 信息；无 cache 数据隐藏 |
| `index.html:144-148`, `app.js:403-429` | MCP card/list/server head/tool chips/error/note | `OfficialMonitoring:166-169` | 单独 GET /mcp 后注入 raw；无 servers 时隐藏；按真实 ready/starting/failed/stopped/idle 状态 |

## 独立 API Monitor 与请求弹层

官方 API Monitor 来源为独立 `monitor.html` 页面。管理导航提供入口，统一使用简化共享页头；请求弹层是桌面扩展，复用同一 `RequestViewer`。

| 官方 source | 元素 | 实现 | 状态 / 条件 |
|---|---|---|---|
| `monitor.html:15`, `monitor.html:9` | header 按最新用户要求简化 | `WorkspaceHeader` api variant | API Monitor 标题/状态 + API key actions；品牌/theme/management 按钮移除，不叠第二个 header |
| `monitor.html:17-20`, `monitor.js:105-117` | API Monitor title/sub、Load/Unload、error notice、auth form | `RequestViewer:41-42` | 真实 /load /unload；inflight/busy/loaded 禁用；401 或 key 按钮显示 password auth，setApiKey 后重连 |
| `monitor.html:21-25`, `monitor.js:80-96` | Model/count/wall/decode 四卡及 sub/dot | `RequestViewer:43` | /v1/status + /api/requests；actual activity/loaded/auto_load；wall 包含队列和加载 |
| `monitor.html:27-29`, `monitor.js:20-48` | panel-bar/filter/search/list/request endpoint/meta/tag | `RequestViewer:44` | custom Dropdown 保留4 filter值；实际 started_at 秒、stream/json、HTTP status、ID；保留选中态 |
| `monitor.html:30-33`, `monitor.js:49-72` | selection/empty、title/status/time、8 facts/error | `RequestViewer:44` | 详情 GET /api/requests?id=；活跃请求持续刷新；wall/load/queue/first/usage/speed/responseformat |
| `monitor.html:32-33`, `monitor.js:49-56` | Input/Output/Reasoning/API response tabs、Copy、note、pre | `RequestViewer:44` | 原文/JSON格式化、独立 reasoning、truncated 256K 提示、失败诊断；复制后1.5s反馈 |
| `monitor.html:35`, `monitor.js:73-102` | retention footer / updated | `RequestViewer:45` | 实际 retention；Live 更新/Disconnected retry；无 captures 默认404说明 |

## 验证记录

- 本阶段已通过 desktop `tsc --noEmit`、Vite production build、全仓库 `git diff --check`；Outfit OFL 仅清理了尾随空白，许可正文保持。
- 源码扫描没有 `<select>` / `<option>` / `<datalist>` / checkbox / 原生 `<dialog>`。
- 页面重组已验证 1440/1100/920/700 展开/收起布局、单一 Header、聊天历史搜索/重命名/删除/标题显示、侧栏状态持久化、配置迁移、无横向溢出、主题/语言/hash 刷新恢复。侧栏 11 个导航图标不重复、菜单高 36px、收起 240ms 动画；reduced-motion 关闭动画，滚动条默认透明、悬停或键盘聚焦显示。
- 实际原生 WebView2 已验证真实 GPU 多轮聊天、图像/文本附件、取消、复制、MCP 工具结果、API Monitor 四标签、共享采样、运行配置和模型卸载/重载，范围见 VERIFICATION.md。Markdown 采用原生保存路径及 UTF-8 写入，避免 WebView2 Blob 下载不产生文件的问题。
- 新服务管理页、首次引导和参数分类复用官方 tokens/字体/控件；按用户授权调整结构，旧 source 全屏几何不作为管理外壳基准。源码稳定后的桌面整合与安装包仍需最终验证。
