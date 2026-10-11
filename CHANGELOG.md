# Changelog

按版本维护中英文更新日志。发布前将未发布内容归入实际版本；更新弹窗只展示该版本、该语言的内容。
Maintain both languages for each version. Move unreleased changes into the actual version before publishing.

## [Unreleased]

### 中文

以下改动正在开发与验收，尚未包含在公开安装包中。

- 新增 Benchmark 测试工作区，支持提示词长度、重复轮次、输出长度、预热和重复输入缓存测试，可停止测试、查看历史报告并导出 JSON。
- 分别记录首 Token 延迟、请求总耗时、P50/P95、输入与输出 Token、输入处理与生成速度以及缓存命中；测试期间协调聊天、调优、服务启停和更新操作。
- 增加已审阅 Strata 0.1.43 的 API 使用统计兼容，改善 Windows 安装路径识别和更新元数据复用，保留引擎校验、配置保护与回滚检查。
- 修复 Linux 本机环境扫描被无关或权限受限的 Python 进程打断的问题，保留运行环境身份核验。
- 更新官网首页，补充 Strata 与 Manager 职责图示，并从本日志生成中英文更新日志页面。
- Benchmark 已完成隔离测试与真实桌面停机状态检查，真实 GPU 模型加载后的吞吐和持续稳定性仍待验收。

### English

These changes are in development and validation and are not included in publicly available installers.

- Add a Benchmark workspace with prompt lengths, repeated runs, output limits, warmup and repeated-input cache tests, plus cancellation, report history and JSON export.
- Record time to first token, request duration, P50/P95, input/output tokens, input-processing and generation rates, and cache hits separately; coordinate chat, tuning, service controls and updates while a test runs.
- Add API usage compatibility for the reviewed Strata 0.1.43 source and improve Windows installation-path detection and update-metadata reuse, retaining engine validation, configuration protection and rollback checks.
- Fix Linux local-environment scans being interrupted by unrelated or permission-restricted Python processes, retaining runtime identity checks.
- Redesign the website with a Strata/Manager responsibility diagram and generate bilingual website changelog pages from this file.
- Benchmark has passed isolated tests and stopped-service checks in the real desktop app; throughput and sustained stability with a loaded GPU model still require validation.

## [0.1.3] - Unreleased

### 中文

- 聊天加入 JSON / JSON Schema、长文复用和高级生成参数，发送前按当前引擎核验支持情况。
- 新增模型文件检查、下载来源与显卡选择；支持 Swift IQ3_S 格式。
- 新增会话保存/恢复、逐槽位监控、输入处理速度，以及按引擎能力提供的显存调整。
- 接入官方 MCP 连接检查和安装目录管理交接，加入专家适应策略调优候选。
- 移除逐项“详情”和重复小字，常用操作直接显示；启动设置改为分类选择，帮助集中到标题入口。
- 修复 Windows 路径映射造成的开机启动误判，保留外来启动项与文件校验保护。
- Windows 中文聊天、JSON、长文缓存、会话存取、双并发和管理交接已实机验证；低 RAM 常驻模式不支持在线显存调整。完整长时间调优、新模型下载及跨登录自启动未包含在本轮实测中。

### English

- Add JSON / JSON Schema responses, document reuse and advanced generation controls with fresh engine capability checks before sending.
- Add model-file inspection and download-source/GPU choices, including the Swift IQ3_S format.
- Add engine session save/restore, per-slot monitoring, input-processing rates and capability-gated VRAM resizing.
- Integrate official MCP connection checks, installation management handoff and adaptive expert tuning candidates.
- Remove repeated disclosure rows and explanatory text, show common controls directly and group startup settings by category.
- Correct Windows startup checks for mapped paths while retaining foreign-registration and staged-file protections.
- Windows chat, structured output, document caching, session storage, parallel requests and handoff were tested on real hardware. Online VRAM resizing is unsupported in resident low-RAM mode; full tuning, new model downloads and Windows login-cycle startup were not tested in this pass.

## [0.1.2] - 2026-10-11

### 中文

- 在 CI 与签名发布中串行运行完整的 Linux 原生测试，避免多个隔离后台同时冷启动；补充启动失败的子进程与 IPC 诊断，保留原有断言、时间限制和发布门禁。
- 调优报告成功完成后保留其完成时间，避免后台成功回调再次改写已完成的报告。
- 现有 Windows 运行环境更新时保留配置，并恢复更新前正在运行的服务。
- 改善 Windows 本机检测，避免已退出的临时 Python 进程干扰扫描；更新前再次核验实际服务、安装目录和监听归属。
- 受支持运行时增加 5/15/30 分钟临时请求正文诊断，仅在 RAM 保留，关闭或到期清空；用户已有 `api_monitor` 配置单独管理。
- 核验登录自启动注册项的后台程序、完整哈希及数据目录，损坏或同名外部项显示可行动诊断，不自动认领。
- 保存窗口位置、尺寸和最大化状态，恢复时按显示器工作区与 DPI 夹紧，并处理最大化跨屏移动。
- 明确官方引擎 ZIP 更新只支持匹配的 Windows x64 包；Linux 保留版本和发布日志查看。
- 官网优先展示已公开稳定版，仅在没有稳定版时明确回退预览版；缺失或来源不符的安装资产不启用下载。
- 修复安装重新检测、API 使用统计和请求诊断的自动刷新闪烁。
- API 使用统计作为常用入口，请求正文查看移至可选的高级诊断。
- 精简 API 统计和总览的说明文字，统计口径与采集信息默认折叠。
- 合并总览的当前服务与服务控制卡片，启停操作放在右侧，并区分按钮颜色。
- 总览快捷入口统一布局并区分颜色，移除重复的受管与进程归属信息；精简模型页入口和工具栏。
- 移除模型使用向导与重复说明，将监控入口上移，底部状态栏改为动态 Token 速度与请求负载。
- 总览未启用模型时提供“最近启用”或选择模型入口，停止状态显示“未启动”；移除卡片内的参数对比和运行环境卡片的重复模型入口。
- “任务与日志”成为独立菜单，集中查看准备、下载、更新任务与日志；参数比较继续在调优页进行。
- 重新打开应用连接已有后台，不因保存过模型选择而启动服务。冷启动和旧档案交接保留停止状态；应用升级只恢复升级前实际运行且通过核验的受管服务及其模型加载状态。
- 登录自启动只启动后台，模型服务手动启用；“运行期间保持模型就绪”仅在启用服务后保持加载，不在打开应用或登录时自动启用模型。
- 应用和 Strata 更新先展示当前语言的版本日志，经用户确认后执行。
- 区分图像支持与后台检查状态，提供图像服务快捷配置和文件检查。
- 按实际主模型归并本机模型，在配置下拉列表展示运行状态、参数和真实时间记录。
- 统一图形与 JSON 配置编辑，支持保存、复制新配置和带恢复副本的删除。
- 配置页通过浮动入口展示当前模型的全部配置，hover 显示操作并支持删除 JSON；保护未保存编辑，标明下一次请求生效或保存后重启生效。
- 支持预览模型文件和空间占用后删除，保护运行中的模型与仍被其他配置引用的文件。

### English

- Run the complete Linux native tests serially in CI and signed releases to avoid simultaneous isolated background cold starts, and retain child-process and IPC startup diagnostics without weakening assertions, deadlines or release gates.
- Preserve a successfully completed tuning report's completion time instead of rewriting it in the background success callback.
- Preserve configurations and restore the previously running service when updating an existing Windows runtime.
- Improve Windows local detection so exited temporary Python processes do not disrupt scans, and recheck the actual service, installation directory and listener ownership before an update.
- Add 5/15/30-minute temporary request-body diagnostics on supported runtimes, retaining bodies only in RAM and clearing them on disable or expiry; existing user `api_monitor` settings remain separately managed.
- Validate login-startup registration against the background binary, full hash and data directory, with actionable diagnostics for damaged or foreign entries instead of claiming them.
- Save window position, size and maximized state, clamp restoration to monitor work areas and DPI, and track maximized moves between displays.
- Limit official engine ZIP updates to matching Windows x64 packages; retain Linux version and release-note browsing.
- Prefer published stable releases on the website, explicitly fall back to previews only when no stable exists, and disable missing or foreign download assets.
- Fix flickering during installation detection, API usage refresh and request diagnostics.
- Keep API usage in the main navigation and move request body inspection into optional diagnostics.
- Simplify overview and API usage text; collapse statistical definitions and collection details by default.
- Merge the overview service and control cards, placing service actions on the right with distinct colors.
- Align and color the overview shortcuts, remove redundant managed-service and ownership labels, and simplify model navigation and its toolbar.
- Remove the model guide and redundant text, move monitoring above tuning, and show live token throughput and request load in the status bar.
- Offer a recently enabled model or model selection when Overview has no enabled service, show stopped services as Not started, and remove parameter comparisons and duplicate model links from the cards.
- Give Tasks & logs its own menu for preparation, download and update tasks and logs; keep parameter comparisons in Tuning.
- Reconnect to an existing background when reopening the app without starting services from a saved selection. Cold startup and legacy handoff preserve stopped services; app upgrades restore only verified services that were actually running before the upgrade, with their previous model-loading state.
- Start only the background at sign-in and enable model services manually. Keep the running model ready applies after enabling a service; it does not enable models when opening the app or signing in.
- Show localized release notes and require confirmation before app or Strata updates.
- Clarify image support and background checks, and add vision setup with file validation.
- Group local entries by main-model assets, with configuration details, running state and recorded timestamps in the selector.
- Share configuration files between graphical and JSON editors, with save, copy and recoverable deletion.
- Show the current model's complete configuration list from a floating entry, reveal actions on hover and support JSON deletion; protect unsaved edits and distinguish next-request changes from settings that require a restart.
- Preview model files and disk usage before deletion, protecting running models and files referenced by other configurations.

## [0.1.1] - Unpublished

### 中文

- 源码 `33190cf6294ae11787f40b0f5fd6dc29e072cee3` 的 [main CI 38100739579](https://github.com/hongfaqiu/strata-manager/actions/runs/38100739579)两平台通过；[签名 Release 38102509861](https://github.com/hongfaqiu/strata-manager/actions/runs/38102509861)的 Windows 构建与安装门禁成功，但 Linux 的三个隔离后台生命周期测试均在首次 IPC 就绪检查约 5.2 秒后失败，publish 跳过，此版本未公开。
- 保留不可移动的 `v0.1.1` 标签与失败记录。旧夹具未记录子进程退出状态或 stderr，实际启动失败原因尚未确定；debug 后台在发布 IPC 前计算自身完整哈希，并发启动的资源竞争仅为待验证假设。修复使用新候选 0.1.2。

### English

- Both platforms passed [main CI 38100739579](https://github.com/hongfaqiu/strata-manager/actions/runs/38100739579) for source `33190cf6294ae11787f40b0f5fd6dc29e072cee3`. Windows build and installation gates passed in [signed Release 38102509861](https://github.com/hongfaqiu/strata-manager/actions/runs/38102509861), but all three isolated Linux background lifecycle tests failed at their initial IPC readiness check after about 5.2 seconds. Publish was skipped; this version was not published.
- Keep the immutable `v0.1.1` tag and failure records. The previous fixture did not record child exit status or stderr, so the actual startup failure remains unknown. Concurrent resource contention while debug backgrounds hash their complete executables before publishing IPC is an unverified hypothesis. Continue fixes in candidate 0.1.2.

## [0.1.0] - Unpublished

### 中文

- 此候选未公开发布。保留原版本标签和失败记录；公开版本与安装包请查看后续发布记录。

### English

- This candidate was not published. Its tag and failed workflow records are retained; see subsequent releases for public versions and installers.

## [0.1.0-beta.2] - 2026-10-10 (UTC)

### 中文

- 发布 Windows x64 NSIS、Linux x64 AppImage 和 DEB，以及三份 Tauri 更新签名、latest.json 和 SHA256SUMS，共八项公开资产。
- [签名发布流水线](https://github.com/hongfaqiu/strata-manager/actions/runs/38080808731)的 Windows、Linux 与发布任务均成功，对应源码 `0db2fea5128144fe2fe00cca992bd5139c831508`。发布门禁核验资产、更新元数据和真实签名，预览版不覆盖稳定更新通道。
- [beta.2 发布页](https://github.com/hongfaqiu/strata-manager/releases/tag/v0.1.0-beta.2)记录此版本；该历史结果不证明后续 0.1.0 候选已通过，也不代表真实 GPU、登录自启动或客户端跨版本更新已验收。

### English

- Publish Windows x64 NSIS, Linux x64 AppImage and DEB, three Tauri update signatures, latest.json and SHA256SUMS: eight public assets.
- Windows, Linux and publish jobs all passed in the [signed release workflow](https://github.com/hongfaqiu/strata-manager/actions/runs/38080808731), for source `0db2fea5128144fe2fe00cca992bd5139c831508`. Release guards validate assets, updater metadata and actual signatures; this preview does not replace the stable update channel.
- The [beta.2 release page](https://github.com/hongfaqiu/strata-manager/releases/tag/v0.1.0-beta.2) records that version. Its historical result does not establish a passing 0.1.0 candidate, real GPU use, login startup or client cross-version updater acceptance.

## [0.1.0-beta.1] - 2026-10-11

### 中文

- 首个公开预览版，提供 Windows x64 安装包及 Linux x64 AppImage、DEB。
- 集中管理本机模型、聊天、后台服务、API 使用统计与参数调优。
- 支持中文和英文、浅色和深色主题。
- 模型权重和 Strata 运行时独立安装；预览版不替换稳定更新通道。

### English

- First public preview with Windows x64 installer and Linux x64 AppImage and DEB packages.
- Manage local models, chat, background services, API usage and tuning in one workspace.
- Support Chinese and English, plus light and dark themes.
- Model weights and the Strata runtime are installed separately. This preview does not replace the stable update channel.
