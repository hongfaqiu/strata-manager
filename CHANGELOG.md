# Changelog

按版本维护中英文更新日志。发布前将未发布内容归入实际版本；更新弹窗只展示该版本、该语言的内容。
Maintain both languages for each version. Move unreleased changes into the actual version before publishing.

## [Unreleased]

### 中文

- 接入 Swift IQ3_S、下载源/GPU/后端选择与 GGUF 检查；加入运行中弹性显存控制、实验性引擎会话存档、固定文档前缀和 JSON/高级采样请求。
- 新增官方 MCP 自检与持久管理交接、逐 slot 监控和 Prefill 列，以及专家适应策略完整场景调优候选。

- 修复安装重新检测、API 使用统计和请求诊断的自动刷新闪烁。
- API 使用统计作为常用入口，请求正文查看移至可选的高级诊断。
- 精简 API 统计和总览的说明文字，统计口径与采集信息默认折叠。
- 合并总览的当前服务与服务控制卡片，启停操作放在右侧，并区分按钮颜色。
- 总览快捷入口统一布局并区分颜色，移除重复的受管与进程归属信息；精简模型页入口和工具栏。
- 移除模型使用向导与重复说明，将监控入口上移，底部状态栏改为动态 Token 速度与请求负载。
- 重载工作台时根据真实进程恢复当前服务；检查失败或存在运行中服务时禁止自动重复启动。
- 应用和 Strata 更新先展示当前语言的版本日志，经用户确认后执行。
- 区分图像支持与后台检查状态，提供图像服务快捷配置和文件检查。
- 按实际主模型归并本机模型，在配置下拉列表展示运行状态、参数和真实时间记录。
- 统一图形与 JSON 配置编辑，支持保存、复制新配置和带恢复副本的删除。
- 配置页通过浮动入口展示当前模型的全部配置，hover 显示操作并支持删除 JSON；保护未保存编辑，标明下一次请求生效或保存后重启生效。
- 支持预览模型文件和空间占用后删除，保护运行中的模型与仍被其他配置引用的文件。

### English

- Integrate Swift IQ3_S, source/GPU/backend selection and GGUF inspection; add elastic VRAM controls, experimental engine session files, pinned document prefixes and JSON/advanced request sampling.
- Add official MCP probes and persistent management handoff, individual slot telemetry, recent-request Prefill rates and adaptive expert-tier tuning candidates.

- Fix flickering during installation detection, API usage refresh and request diagnostics.
- Keep API usage in the main navigation and move request body inspection into optional diagnostics.
- Simplify overview and API usage text; collapse statistical definitions and collection details by default.
- Merge the overview service and control cards, placing service actions on the right with distinct colors.
- Align and color the overview shortcuts, remove redundant managed-service and ownership labels, and simplify model navigation and its toolbar.
- Remove the model guide and redundant text, move monitoring above tuning, and show live token throughput and request load in the status bar.
- Restore the selected service from process evidence on reload, preventing duplicate automatic startup when checks fail or a service is already running.
- Show localized release notes and require confirmation before app or Strata updates.
- Clarify image support and background checks, and add vision setup with file validation.
- Group local entries by main-model assets, with configuration details, running state and recorded timestamps in the selector.
- Share configuration files between graphical and JSON editors, with save, copy and recoverable deletion.
- Show the current model's complete configuration list from a floating entry, reveal actions on hover and support JSON deletion; protect unsaved edits and distinguish next-request changes from settings that require a restart.
- Preview model files and disk usage before deletion, protecting running models and files referenced by other configurations.

## [0.1.3-test.4]

### 中文

- 移除常态界面逐行的“详情”和“说明”；常用操作直接显示，帮助集中到标题图标。
- 启动参数改为分类选择，默认显示对话常用项；下载和调优保留必要高级入口，避免嵌套展开。
- 修复 Windows 路径映射导致本应用后台开机启动被错误拒绝的问题，保留文件校验及异地启动项保护。
- 保留错误、操作影响和配置草稿保护；Windows 本地测试包，不发布至自动更新渠道。

### English

- Show common controls directly and consolidate help in section headings.
- Group startup settings by category and reduce nested disclosures in downloads and tuning.
- Correct startup identity checks for mapped Windows paths while retaining staged-file and foreign-registration checks.
- Keep errors, operation impacts and unsaved-draft protection visible; local Windows test build.

## [0.1.3-test.3]

### 中文

- 将当前低内存模式不支持在线显存调整的原因改成中文提示，原始错误按需展开。
- 为折叠说明增加明显的展开标记；将监控中的 Prefill / Decode 改为输入处理 / 生成。
- 包含 test.2 的简化交互与所有新增功能；Windows 本地实测包，不发布至自动更新渠道。

### English

- Explain online VRAM resizing limits in resident low-RAM mode, with raw errors available on demand.
- Make expandable help easier to recognize; use input processing / generation labels in monitoring.
- Include test.2 interaction changes and all added features; local Windows test build, not published to the updater channel.

## [0.1.3-test.2]

### 中文

- 简化聊天、模型设置、监控、MCP 与调优交互；技术参数、原始日志和详细说明改为按需展开。
- 保持重要状态、错误与操作影响可见；明确区分模型格式支持和官方尚未验证。
- Windows 本地人工测试包，不发布至自动更新渠道。

### English

- Simplify chat, model setup, monitoring, MCP and tuning; show technical parameters, raw logs and help on demand.
- Keep important state, errors and operation impact visible; distinguish recognized formats from untested model recipes.
- Local Windows manual test build, not published to the updater channel.

## [0.1.3-test.1]

### 中文

- Windows 本地测试包：包含下载源/GPU 选择、Swift IQ3_S、GGUF 检查、弹性显存、实验性会话存档、长文固定前缀、JSON/高级采样、MCP 管理交接、逐槽监控、Prefill 和专家适应策略调优。
- 本包用于人工安装测试，未发布至自动更新渠道；GPU 和会话存档的实机验证继续由测试者确认。

### English

- Local Windows test build with source/GPU selection, Swift IQ3_S, GGUF inspection, elastic VRAM, experimental session files, document prefixes, JSON/advanced sampling, MCP handoff, slot telemetry, Prefill and adaptive expert tuning.
- Intended for manual installation testing; not published to the updater channel. GPU and session-file compatibility still require real-device validation.

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
