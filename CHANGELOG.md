# Changelog

按版本维护中英文更新日志。发布前将未发布内容归入实际版本；更新弹窗只展示该版本、该语言的内容。
Maintain both languages for each version. Move unreleased changes into the actual version before publishing.

## [Unreleased]

## [0.1.1]

### 中文

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

## [0.1.0] - Unpublished

### 中文

- 此候选未公开发布。保留原版本标签和失败记录；首次稳定版使用 0.1.1。

### English

- This candidate was not published. Its tag and failed workflow records are retained; the first stable release uses 0.1.1.

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
