# Changelog

按版本维护中英文更新日志。发布前将未发布内容归入实际版本；更新弹窗只展示该版本、该语言的内容。
Maintain both languages for each version. Move unreleased changes into the actual version before publishing.

## [Unreleased]

### 中文

- **上游升级兼容自动化**：观察器改为“已审查哈希快速通道 + 结构能力检测”，未审查的新版 Strata 结构兼容时自动完整统计（标注未审查），缺少可选能力时逐项降级，核心契约变化时关闭并改用公开 `/health` `/status` `/metrics` 监控；新增 0.1.44.1 已审查哈希。
- 已审查清单统一到 `apps/supervisor/resources/observer_compat.json`，Python 运行时、Release ZIP 更新与测试共用；未审查源码不再阻止运行环境更新。
- Linux MCP stdio 守护同样改为“已审查哈希 + 结构检测”，哈希统一来自 `observer_compat.json`；结构不兼容时给出明确拒绝原因（HTTP MCP 不受影响）。
- 启动设置快捷表单读取已安装引擎的 `--help`，未列出的参数自动禁用并提示（已保存值不变）。
- 运行环境页新增“用官方脚本更新 Strata”：调用安装目录内官方 `update.sh` / `UPDATE.bat` 并实时显示输出；有已修改的跟踪文件时拒绝执行，绝不强制。
- 观察器兼容上游 Strata **0.1.44**（保留既有已审阅哈希；CI / 发版复用门禁同步）。
- 模型下载设置：多卡图形选择器，以及仅生成命令的官方 `--calibrate` 入口（不执行真实校准）。
- API 接入向导增加 **Cursor** 与 **Codex** 示例。
- 启动设置增加常用并发 / batch / 空闲卸载 / 弹性显存快捷表单。
- 总览空状态与右上角状态艺术动画、浏览器假数据预览（`?mockData=1`）。
- 同源 CI 复用失败时输出具体证据原因，避免静默 `missing`。
- 资源评估安装器规则锚点跟随至 Strata 0.1.44。
- 修复发版复用同源 CI 时，Actions 刚完成的任务短暂缺少 `steps` 会被误判为不可复用、进而重复调度 CI 或直接失败的问题；证据不足时给出明确错误，不再返回假的 `missing`。

### English

- **Upgrade compatibility automation**: the observer now uses reviewed hashes as a fast path plus structural capability detection. An unreviewed but compatible Strata is fully observed (labelled unreviewed), missing optional capabilities degrade individually, and a changed core contract disables it in favour of the public `/health` `/status` `/metrics` channel. Adds the reviewed 0.1.44.1 hash.
- The reviewed list lives in `apps/supervisor/resources/observer_compat.json`, shared by the Python runtime, release ZIP updates and tests; an unreviewed source no longer blocks runtime updates.
- The Linux MCP stdio guard uses the same reviewed-hash-or-structural rule from `observer_compat.json`, refusing incompatible sources with a clear reason (HTTP MCP unaffected).
- The startup quick form reads the installed engine's `--help` and disables unlisted flags with a hint (saved values are kept).
- The environment page adds "Update Strata with the official script": runs the installation's own `update.sh` / `UPDATE.bat` with streamed output, and refuses (never forces) when tracked files were changed.
- Observer compatibility for upstream Strata **0.1.44** (keeps prior reviewed hashes; CI / release-reuse gates updated).
- Model download settings: graphical multi-GPU selector and a copy-only official `--calibrate` entry (does not run real calibration).
- API connection wizard examples for **Cursor** and **Codex**.
- Startup settings quick form for concurrency / batch / idle unload / elastic VRAM.
- Overview empty-state polish, status-driven art animations, and browser mock data (`?mockData=1`).
- Same-source CI reuse reports evidence failures instead of a silent `missing`.
- Resource-assessment setup-rule anchor follows Strata 0.1.44.
- Fix release same-source CI reuse treating briefly empty Actions job `steps` as non-reusable evidence, which could re-dispatch CI or fail the release; surface real evidence failures instead of a false `missing` status.

## [0.1.8] - 2026-10-14

### 中文

- Windows 检测运行中服务，显示实际模型加载状态、当前模型、配置、PID、引擎版本与 OpenAI API Base URL；优先连接已有 Manager 后台，仅在确认没有后台所有者时允许托管普通外部实例。空闲后台遇到唯一明确的运行候选时自动连接；自动托管还要求模型健康、已加载且空闲，多候选保留手动选择。停止的模型不因发现或监控而启动。Linux 的外部进程身份核验与接管不在此版本支持范围。
- 同一运行环境使用跨进程托管锁，阻止另一后台重复启动或接管；升级副本也核验原运行目录的所有者，确认进程树停止后才释放托管锁，冲突时保留现有服务并返回可读诊断。
- 界面跟随 Windows 系统语言，首次启动可确认选择，并提供简体中文、繁体中文、英文、日文、韩文、德文、法文、西班牙文、葡萄牙文与俄文十种随包语言资源。手动选择优先，未支持语言回退英文；部分高级工具和原始服务日志仍显示英文。Windows 安装器提供对应语言选择。
- 桌面监控默认关闭，以开关控制显示；默认清晰双行，可选三种布局、8–36px 字号，从十一项指标中选择一至八项并排序。支持逐项默认色、自定义颜色与恢复，标签、单位、采样时间和折线可独立切换；标签默认开启，状态文字和贴边吸附默认关闭。
- 浮条按指标分配稳定列宽，指标间距缩至 2px；隐藏标签时移除标签行。修复贴边后拖动无法拉离、放大越出工作区、隐藏窗口继续采样，以及连续偏好事件覆盖刚修改指标的问题。浮条仅显示数据，操作集中在原生右键／托盘菜单；移除任务栏模式入口，旧偏好迁回桌面浮条，任务栏宿主仅为内部实验。
- 空闲释放模型内存后的再次请求显示实际自动载入阶段与已用时间；成功和异常退出清除载入标记，读取／生成开始前不沿用历史吞吐。信号来自随包 observer 对已核验上游接口的包装，不修改上游源码。
- 设置拆为公共设置、桌面监控、聊天默认、API 与外部助手、显存与会话、应用更新、关于等工作区；恢复圆角分段 Tab，保留白色选择环线并移除外层光晕，窄窗口支持滚动与键盘切换。
- 总览加入装饰性本地算力插图、资源环形图和请求／生成趋势；图表来自已有采样与统计，缺失值保留未知，空闲状态的历史吞吐标为最近生成，不当作实时速度。
- 同步 README、官网与使用说明，重新采集六十二张中英文实际界面／组件截图，并更新三份封面文件。配图使用隔离示例数据，非真实性能测量；历史版本日志保留原图。真实 GPU 自动载入、长时稳定性、用户设备升级与完整原生窗口交互仍需独立验收。

### English

- On Windows, detect running services and show their confirmed loaded state, current model, configuration, PID, engine version and OpenAI API Base URL. Reconnect to an existing Manager backend first; ownership of a plain external instance is allowed only after confirming no backend owner. An idle backend automatically connects to one unambiguous running candidate. Automatic takeover additionally requires a healthy, loaded, idle model; multiple candidates remain available for manual selection. Discovery and monitoring never start a stopped model. External-process identity verification and takeover on Linux are outside this release's support scope.
- Use an inter-process runtime lease to prevent a second backend from starting or taking ownership of the same installation. Upgraded copies also verify the original runtime owner. Release the lease only after the process tree is confirmed stopped; conflicts preserve the existing service and return a readable diagnostic.
- Follow the Windows system language, confirm language at first launch, and bundle ten language resources: Simplified Chinese, Traditional Chinese, English, Japanese, Korean, German, French, Spanish, Portuguese and Russian. Manual choices take precedence and unsupported languages fall back to English. Some advanced tools and original service logs remain in English. The Windows installer offers corresponding language choices.
- Desktop monitoring defaults off and uses a visibility switch. The default two-row view supports three layouts, 8–36px text and one to eight ordered metrics from eleven. Each metric has a default color, hexadecimal override and reset. Labels, units, sample time and graphs are independent; labels default on, while status text and edge snapping default off.
- Assign stable metric widths with 2px spacing and remove the label row when labels are hidden. Fix edge dragging, off-screen growth, hidden sampling and consecutive preference events overwriting changes. The strip displays data, with actions in native context/tray menus. Remove the taskbar-mode entry and migrate older preferences to desktop monitoring; the native taskbar host remains an internal experiment.
- Show the actual automatic-loading phase and elapsed time when a request reloads an idle-released model. Clear loading markers on success and failure, and suppress historical throughput until prefill or generation begins. The bundled observer wraps verified upstream interfaces without changing upstream source.
- Split settings into shared settings, desktop monitoring, chat defaults, API and assistants, VRAM and sessions, application updates and About. Restore rounded workspace tabs and retain white selection borders without an outer halo. Narrow windows keep scrolling and keyboard navigation.
- Add decorative local-compute artwork, resource rings and request/generation trends to Overview. Charts use existing telemetry and statistics, missing values remain unknown, and idle historical throughput is labelled as the last generation rather than a live rate.
- Refresh the README, website and guides, recapture sixty-two bilingual interface/component screenshots and update three cover files. Isolated examples are not performance measurements; historical release illustrations retain their original bytes. Real GPU reloads, prolonged stability, upgrades on user devices and complete native-window interactions still require separate acceptance.

## [0.1.7] - 2026-10-13

### 中文

- 模型下载分为目录与详情，下载来源、目录和显卡默认值集中在公共下载配置中，模型详情保留量化与启动预设，按当前选择显示资源评估与未知项；建议保留手动设置，评估不构成容量保证。
- 启动失败保留阶段、耗时、原因与脱敏证据；聊天区分等待、思考、工具及正文阶段，分别记录 TTFT、首正文和总耗时，并区分本地操作与服务实际返回的请求／响应 ID。
- 服务能力统一显示可用、不支持、未核验及需要重启；聊天、API 与 Benchmark 使用相同证据规则，保存配置不代替当前服务证据。
- API 接入新增显式的文本、工具结构与图片验证，每次限制 256 token／60 秒；工具验证不执行 MCP。局域网配置先预览再保存，保留多密钥与备份，重启独立执行。
- Benchmark 报告保留模型／引擎／启动配置身份与首正文时间，兼容历史记录；历史和升级前基线展示条件差异，未知条件或弱身份不产生直接提速结论。默认导出省略测试正文与错误响应。
- API 使用统计加入实时负载、趋势图和均值／分位数；帮助提示统一支持键盘、禁用控件和弹窗。开发 EXE 嵌入前端并使用独立默认数据目录。
- 单选与复选控件统一使用白色亮环、对比描边和键盘焦点，保留原生单选／多选语义；下载、MCP、导出与启动参数使用共享组件。
- 截图为隔离示例，完整原生窗口、真实 GPU／长时和跨设备 LAN 仍待验收，见 [验收记录](https://github.com/hongfaqiu/strata-manager/blob/v0.1.7/docs/VERIFICATION.md)。

#### 界面示例

以下截图来自版本号更新前的实际组件，捕获源码为 `e4b8fa651eb0c021b6f8979b5f8affd847a8dbb2`，界面标记为 0.1.6。示例数据不代表真实推理或 0.1.7 安装包验收；出处见 [截图说明与捕获记录](https://github.com/hongfaqiu/strata-manager/blob/v0.1.7/docs/screenshots/README.md)。

[![模型下载详情与资源评估](docs/screenshots/changelog/0.1.7/model-download-detail.zh.webp)](docs/screenshots/changelog/0.1.7/model-download-detail.zh.webp)

[![API 在线验证](docs/screenshots/changelog/0.1.7/api-verification.zh.webp)](docs/screenshots/changelog/0.1.7/api-verification.zh.webp)

[![历史 Benchmark 条件对照](docs/screenshots/changelog/0.1.7/history-comparison.zh.webp)](docs/screenshots/changelog/0.1.7/history-comparison.zh.webp)

### English

- Split model downloads into a catalog and details. Shared download settings hold the source, location and GPU defaults; model details retain quantization and startup presets, with resource assessment for the current selection. Suggestions preserve manual settings, unknown values remain explicit, and assessment does not guarantee capacity.
- Retain startup failure stages, timing, reasons and sanitized evidence. Chat separates waiting, reasoning, tools and answer generation, records TTFT, first-answer timing and total duration, and distinguishes local operations from actual service request/response IDs.
- Use shared evidence rules for available, unsupported, unverified and restart-required capabilities across chat, API and Benchmark. Saved configuration does not establish current service support.
- Add explicit text, tool-structure and image API checks, bounded to 256 tokens and 60 seconds. Tool checks never execute MCP. LAN settings use preview and save, preserve multiple keys and backups, and keep restarting separate.
- Retain model/engine/startup identity and first-answer timing in compatible benchmark reports. Historical and pre-upgrade baseline comparisons show condition differences; unknown conditions or weak identity do not produce direct speedup claims. Exports omit test bodies and error responses by default.
- Add live API load, trends, means and percentiles. Unified hints support keyboard focus, disabled controls and dialogs. Development executables embed the frontend and use a separate default data directory.
- Unify radio buttons and checkboxes with white selection rings, contrast borders and keyboard focus while retaining native selection semantics. Downloads, MCP, exports and startup options use shared controls.
- Screenshots contain isolated examples; complete native window flows, real GPU/prolonged stability and cross-device LAN acceptance remain outstanding. See the [verification record](https://github.com/hongfaqiu/strata-manager/blob/v0.1.7/docs/VERIFICATION.md).

#### Interface examples

These screenshots show the actual components before the version bump, captured from source `e4b8fa651eb0c021b6f8979b5f8affd847a8dbb2` with a 0.1.6 UI marker. Demonstration data does not establish real inference or 0.1.7 installer acceptance. See the [screenshot scope and capture records](https://github.com/hongfaqiu/strata-manager/blob/v0.1.7/docs/screenshots/README.md).

[![Model download details and resource assessment](docs/screenshots/changelog/0.1.7/model-download-detail.en.webp)](docs/screenshots/changelog/0.1.7/model-download-detail.en.webp)

[![API verification](docs/screenshots/changelog/0.1.7/api-verification.en.webp)](docs/screenshots/changelog/0.1.7/api-verification.en.webp)

[![Historical benchmark condition comparison](docs/screenshots/changelog/0.1.7/history-comparison.en.webp)](docs/screenshots/changelog/0.1.7/history-comparison.en.webp)

## [0.1.6] - 2026-10-12

### 中文

- 运行配置支持自定义 API 端口与监听地址，可开放局域网访问或绑定本机指定 IP。运行中保存保留现有连接，重启后更新地址；新端口被占用时保留原服务，停止状态下保存不会启动服务。
- 新增 NVIDIA GPU 功耗上限和显卡编号设置，启动时校验驱动支持范围并应用。停止受管服务后恢复原值；其他程序已修改功耗上限时保留其修改。留空沿用显卡原有设置。
- 精简网络与功耗卡片，把详细说明移到问号帮助，只保留字段、API 地址预览与生效提示。
- 修复多个页面 Tab 和分段切换区域过宽的问题，按钮与容器按内容占宽，窄窗口下保留全部选项及键盘切换。
- 修复调优候选服务崩溃时的恢复竞态，确认原受管进程退出后恢复配置与服务，避免继续等待已关闭的 API。

### English

- Configure API ports and listen addresses, including LAN access and binding to a specific local IP. Saving a running configuration retains its live connection until restart; a conflicting new port leaves the old service running. Saving a stopped configuration never starts it.
- Add NVIDIA GPU power-limit and GPU-index settings, validated against the driver before startup. Stopping a managed service restores the previous limit while preserving later changes from other programs. Empty limits keep the existing GPU setting.
- Simplify network and power cards, moving details into help dialogs and keeping fields, an API address preview and an apply reminder visible.
- Fix oversized tabs and segmented controls across multiple pages. Size buttons and containers to their content while keeping all options and keyboard navigation available in narrow windows.
- Fix a recovery race when a tuning candidate crashes: verify that the owned process exited before restoring the original configuration and service instead of waiting for its closed API.

## [0.1.5] - 2026-10-12

### 中文

- 新增上下文档位 Benchmark，按核验的模型容量生成可选档位：预置 8K–1M 档位，并补充模型的实际上下文上限。逐档串行测试，预留输出与模板余量，跳过超出服务容量的档位。报告记录实际输入／输出 Token、输入处理与生成速度、首 Token 延迟、总耗时和资源采样，支持历史记录及 JSON／CSV 导出；分词不可用时标明估算。
- Benchmark 移到独立菜单，分为“上下文档位”和“场景测试”。场景测试固定一次发送一个请求，保留七种场景、预热、输入模式、实时进度与分场景结果。
- 按已加载服务或本机配置核验上下文上限，统一主题色勾选框与开始按钮；结果图表沿用监控页面风格，支持复制结果图片和导出 PNG。
- 监控浮条改为紧凑的小字堆叠布局，仅显示监控数据；主窗口与工作区跳转、复制 API 地址、刷新／暂停采样、置顶、收起与关闭等操作集中到原生右键菜单。设置中可调整默认置顶、采样时间显示和系统托盘监控，自动保存并恢复默认。
- 新增独立系统托盘监控，显示状态与速度，点击图标恢复浮条。右键菜单提供快速测速入口，由主窗口串行执行短回复和连续生成两个场景；模型未就绪或应用忙碌时不执行测试。只读采样仍不启动服务，测速会发送推理请求。
- 更新日志加入功能截图，桌面日志支持离线显示随应用打包的图片；官网递归发布截图资源，并支持点击查看原图。
- 介绍页与官网默认宣传图改用完整总览及展开的服务状态弹层；截图保持原比例，放大预览适配屏幕，操作按钮移至图外，避免裁剪或遮挡。

#### 新界面截图

以下为 0.1.5 界面的隔离演示截图。图中数值仅用于界面展示，非性能实测；原生右键菜单与真实窗口操作需独立验收。点击图片可查看原图。

##### 串行上下文档位 Benchmark

[![串行上下文档位 Benchmark](docs/screenshots/changelog/0.1.5/benchmark.zh.webp)](docs/screenshots/changelog/0.1.5/benchmark.zh.webp)

##### Benchmark 结果图表与图片导出

[![Benchmark 结果图表与图片导出](docs/screenshots/changelog/0.1.5/benchmark-report.zh.webp)](docs/screenshots/changelog/0.1.5/benchmark-report.zh.webp)

此报告为隔离演示数据，用于展示图表、复制与导出入口，非真实性能测量。

##### 串行场景测试

[![串行场景测试](docs/screenshots/changelog/0.1.5/scenario-benchmark.zh.webp)](docs/screenshots/changelog/0.1.5/scenario-benchmark.zh.webp)

##### 紧凑监控浮条

[![紧凑监控浮条](docs/screenshots/changelog/0.1.5/floating-monitor.zh.webp)](docs/screenshots/changelog/0.1.5/floating-monitor.zh.webp)

##### 监控浮条配置

[![监控浮条配置](docs/screenshots/changelog/0.1.5/floating-monitor-settings.zh.webp)](docs/screenshots/changelog/0.1.5/floating-monitor-settings.zh.webp)

##### 总览接入 API 指引

[![总览接入 API 指引](docs/screenshots/changelog/0.1.5/overview-api-guide.zh.webp)](docs/screenshots/changelog/0.1.5/overview-api-guide.zh.webp)

##### 公共聊天默认值

[![公共聊天默认值](docs/screenshots/changelog/0.1.5/common-chat-settings.zh.webp)](docs/screenshots/changelog/0.1.5/common-chat-settings.zh.webp)

##### API 与外部助手

[![API 与外部助手](docs/screenshots/changelog/0.1.5/connections.zh.webp)](docs/screenshots/changelog/0.1.5/connections.zh.webp)

##### 下载来源与网络测试

[![下载来源与网络测试](docs/screenshots/changelog/0.1.5/runtime-download.zh.webp)](docs/screenshots/changelog/0.1.5/runtime-download.zh.webp)

##### 服务状态与实时指标

[![服务状态与实时指标](docs/screenshots/changelog/0.1.5/service-status.zh.webp)](docs/screenshots/changelog/0.1.5/service-status.zh.webp)

##### 应用版本与图文更新日志

[![应用版本与图文更新日志](docs/screenshots/changelog/0.1.5/app-updates.zh.webp)](docs/screenshots/changelog/0.1.5/app-updates.zh.webp)

### English

- Add serial context-tier benchmarks with selectable tiers based on verified model capacity: presets from 8K to 1M plus the model's exact context limit. Reserve output/template headroom and skip tiers beyond service capacity. Reports include actual input/output tokens, prefill/decode rates, TTFT, wall time and resource samples, with history and JSON/CSV export; mark estimates when tokenization is unavailable.
- Move Benchmark to its own navigation entry with Context tiers and Scenario suite tabs. Scenario tests send one request at a time and retain seven scenarios, warmup, input modes, live progress and per-scenario results.
- Verify context limits against the loaded service or local configuration, unify themed checkboxes/start buttons, and match report charts to the monitoring workspace. Support copying report images and exporting PNG files.
- Compact the floating monitor into small stacked metrics. Move window/workspace navigation, API address copying, sampling refresh/pause, pinning, hiding and closing to the native context menu. Settings cover default pinning, sample-time visibility and system-tray monitoring, with automatic saving and restoring defaults.
- Add independent system-tray monitoring for status and speed; clicking its icon restores the monitor. Context menus provide a quick speed test. The main window runs short-response and decode scenarios serially, requiring a ready, idle model. Read-only sampling never starts services; the speed test sends inference requests.
- Add feature screenshots to the changelog, offline display of bundled images in desktop release notes, and recursive screenshot publication with links to the original images on the website.
- Use the complete Overview with its service-status popover open as the default introduction and website preview. Preserve image proportions, fit enlarged previews within the viewport, and place controls outside images to avoid cropping or obstruction.

#### New interface screenshots

These isolated demonstration screenshots show the 0.1.5 interface. Displayed values illustrate the interface, rather than measured performance. Native context menus and real window operations require separate acceptance checks. Click an image to open the original.

##### Serial context-tier Benchmark

[![Serial context-tier Benchmark](docs/screenshots/changelog/0.1.5/benchmark.en.webp)](docs/screenshots/changelog/0.1.5/benchmark.en.webp)

##### Benchmark report charts and image export

[![Benchmark report charts and image export](docs/screenshots/changelog/0.1.5/benchmark-report.en.webp)](docs/screenshots/changelog/0.1.5/benchmark-report.en.webp)

This report uses isolated demonstration data to show the charts, copy and export controls. It is not a real performance measurement.

##### Serial scenario tests

[![Serial scenario tests](docs/screenshots/changelog/0.1.5/scenario-benchmark.en.webp)](docs/screenshots/changelog/0.1.5/scenario-benchmark.en.webp)

##### Compact floating monitor

[![Compact floating monitor](docs/screenshots/changelog/0.1.5/floating-monitor.en.webp)](docs/screenshots/changelog/0.1.5/floating-monitor.en.webp)

##### Floating-monitor settings

[![Floating-monitor settings](docs/screenshots/changelog/0.1.5/floating-monitor-settings.en.webp)](docs/screenshots/changelog/0.1.5/floating-monitor-settings.en.webp)

##### API integration from Overview

[![API integration from Overview](docs/screenshots/changelog/0.1.5/overview-api-guide.en.webp)](docs/screenshots/changelog/0.1.5/overview-api-guide.en.webp)

##### Common chat defaults

[![Common chat defaults](docs/screenshots/changelog/0.1.5/common-chat-settings.en.webp)](docs/screenshots/changelog/0.1.5/common-chat-settings.en.webp)

##### API and external assistants

[![API and external assistants](docs/screenshots/changelog/0.1.5/connections.en.webp)](docs/screenshots/changelog/0.1.5/connections.en.webp)

##### Download sources and network test

[![Download sources and network test](docs/screenshots/changelog/0.1.5/runtime-download.en.webp)](docs/screenshots/changelog/0.1.5/runtime-download.en.webp)

##### Service status and live metrics

[![Service status and live metrics](docs/screenshots/changelog/0.1.5/service-status.en.webp)](docs/screenshots/changelog/0.1.5/service-status.en.webp)

##### App version and illustrated release notes

[![App version and illustrated release notes](docs/screenshots/changelog/0.1.5/app-updates.en.webp)](docs/screenshots/changelog/0.1.5/app-updates.en.webp)

## [0.1.4] - 2026-10-12

### 中文

- 新增 Benchmark 工作区，提供七类场景套件、固定并发和逐级升压；支持提示词与输出长度、预热、重复输入缓存、停止测试、历史报告和 JSON / CSV 导出。
- 公共设置集中管理八项聊天默认值、API 与外部助手以及显存/会话工具；新模型默认继承，旧模型保留专用值，可按模型切换继承，公共修改从下一次请求生效。修复仅编辑高级参数时覆盖原专用值的问题。
- 分别记录首 Token 延迟、请求耗时、P50/P95、输入/输出 Token、输入处理与生成速度和缓存命中，并协调聊天、调优、服务启停与更新操作。
- 收紧调优和 Benchmark 页面，将常用参数与开始按钮放在首屏；右上角服务状态显示速度/GPU 趋势、显存/内存占用和上下文进度，并保留服务控制与工作区跳转，移除最近调优卡片。底部状态栏集中显示速度、运行与排队请求、CPU/GPU 负载、温度和功耗；空闲速度标明“最近生成”，采集失败不显示旧实时指标，进程变化后重新核验并采样。
- 新增可手动打开的桌面监控浮条，支持拖动、调整大小、置顶和返回主窗口，关闭浮条不影响主应用；只读采样不启动或恢复后台与模型服务。
- 监控浮条只允许读取监控和显示主窗口，拒绝其他应用命令；状态查询失败时不再用旧进程数据授权操作，断联恢复后等待新的成功指标采样，正常后台刷新保留有效数据显示。
- 停止服务后立即应用已核验的停止结果，切换为“未启动”及启动按钮；后台路径核验导致升级暂缓时继续兼容的状态查询，显式停止不触发后台升级或重启。
- 菜单按“日常使用、模型与服务、应用”分组排序，将设置放在菜单最后；应用更新卡片自适应可用宽度，日志在窄窗口中正常换行。
- 修复调优 Agent 工具契约、最终 JSON 格式、旧任务恢复和 Windows 端口释放竞态；更新与恢复等待原受管进程释放端口，继续拒绝外部监听占用。
- 修复 Windows 安装包路径及应用父进程核验，改善更新元数据复用；兼容已审阅 Strata 0.1.43 的 API 使用统计，保留引擎核验、配置保护与回滚检查。
- Strata 下载默认使用官方 GitHub，新增 GH Proxy、GHProxy、自定义 HTTPS 模板/固定地址和本地 ZIP；各来源按当前 CUDA12/CUDA13/HIP 引擎自动匹配官方包。保存来源后可测试可用性与续传，已是最新版本时仍可测试且不停止服务。网络测试最多读取 64 KiB，安装继续完整长度与 SHA256 校验；中断后保留断点，网络故障最多三次尝试，连续 60 秒无响应才重试。
- 外部助手默认通过独立后台管理当前档案，提供可复制的 MCP 配置、连接检查和受控工具；独立接管仍为可选模式，断开助手后服务继续运行，停止后保持未启动。通过本应用后台模式生成的 Codex MCP 配置使用 600 秒调用超时，以容纳模型冷加载。
- 左上角统一软件 Logo 与当前版本，点击进入独立应用更新页；发现新版本时显示标签，更新页支持离线查看当前版本的中英文日志。
- 总览服务卡片新增“接入 API”，提供代码调用、Cherry Studio、OpenCode 和 Claude Code 指引，按当前服务地址及模型名生成可复制配置。
- 调整启动和下载设置的布局，并修复 Linux 本机扫描被无关或权限受限的 Python 进程打断的问题。
- 重截 0.1.4 双语工作区、公共设置、连接、更新与监控截图，同步产品封面、官网功能说明和文档中心；新增系统说明并更新接口约定，官网更新日志从本文件生成。
- 发布优先复用同一源码提交的完整 CI 安装包；Windows 与 Linux 各三个独立原生测试 runner 和安装包编译并行，要求同一 attempt 全部八个 job 成功并汇总核验完整覆盖。缩小 Rust 依赖缓存，保留原测试超时、安装启动、版本签名、实际资产验签与校验和门禁。
- Windows 实机完成 MCP 启停、断开后继续运行、停止不自动恢复、模型恢复和推理检查；配置文件哈希保持一致。Benchmark、调优和下载流程完成隔离浏览器检查，Benchmark 和调优界面另经安装后桌面交互验收。真实 GPU Benchmark 测量、完整调优、GPU 长时压测、Linux 系统 DEB 安装及客户端跨版本自动更新仍需独立验收。


#### 功能截图

以下为 0.1.4 发布时的界面截图，使用隔离演示数据；图中数值仅用于展示界面。点击图片可查看原图。

##### Benchmark 场景与压力测试

[![Benchmark 场景与压力测试](docs/screenshots/changelog/0.1.4/benchmark.zh.webp)](docs/screenshots/changelog/0.1.4/benchmark.zh.webp)

##### 公共聊天默认值

[![公共聊天默认值](docs/screenshots/changelog/0.1.4/common-chat-settings.zh.webp)](docs/screenshots/changelog/0.1.4/common-chat-settings.zh.webp)

##### API 与外部助手

[![API 与外部助手](docs/screenshots/changelog/0.1.4/connections.zh.webp)](docs/screenshots/changelog/0.1.4/connections.zh.webp)

##### 显存与会话工具

[![显存与会话工具](docs/screenshots/changelog/0.1.4/runtime-tools.zh.webp)](docs/screenshots/changelog/0.1.4/runtime-tools.zh.webp)

##### Strata 下载来源与网络测试

[![Strata 下载来源与网络测试](docs/screenshots/changelog/0.1.4/runtime-download-settings.zh.webp)](docs/screenshots/changelog/0.1.4/runtime-download-settings.zh.webp)

##### 服务状态与实时监控

[![服务状态与实时监控](docs/screenshots/changelog/0.1.4/service-status.zh.webp)](docs/screenshots/changelog/0.1.4/service-status.zh.webp)

##### 桌面监控浮条

[![桌面监控浮条](docs/screenshots/changelog/0.1.4/floating-monitor.zh.webp)](docs/screenshots/changelog/0.1.4/floating-monitor.zh.webp)

##### 版本与应用更新

[![版本与应用更新](docs/screenshots/changelog/0.1.4/app-updates.zh.webp)](docs/screenshots/changelog/0.1.4/app-updates.zh.webp)


### English

- Add a Benchmark workspace with seven scenario suites, fixed concurrency and ramp-up stress tests, configurable prompt/output lengths, warmup, repeated-input cache tests, cancellation, report history and JSON / CSV export.
- Centralize eight common chat defaults, API/external-assistant connections and VRAM/session tools in Settings. New models inherit by default; existing models retain their own values, with per-model inheritance controls and changes taking effect on the next request. Preserve previous model-specific values when only advanced options are edited.
- Record time to first token, request duration, P50/P95, input/output tokens, input-processing and generation rates, and cache hits separately; coordinate chat, tuning, service controls and updates while a test runs.
- Compact Tuning and Benchmark so common parameters and start actions fit on the first screen. Show speed/GPU trends, VRAM/RAM usage and context progress in the service-status panel, retaining service controls and workspace links and removing recent tuning. Show throughput, running/queued requests, CPU/GPU load, temperature and power in the bottom status bar. Label idle throughput as the last generation, hide stale live values during collection failures, and recheck health and metrics after a process changes.
- Add an optional floating desktop monitor with drag, resize, keep-on-top and return-to-main controls. Closing it preserves the main application; read-only sampling never starts or restores the background or model service.
- Restrict the monitor window to sampling and showing the main window, rejecting other application commands. Failed status checks no longer authorize operations with cached process data; reconnections wait for fresh metrics while normal background refresh retains valid readings.
- Apply verified stop results immediately and replace stop controls with a not-started state and start actions. Continue compatible status queries when background path checks defer an upgrade; explicit stop never upgrades or restarts the background.
- Group navigation by Daily use, Models & services and Application, placing Settings last. Let the App updates card fill the available width and wrap release notes in narrow windows.
- Fix tuning Agent tool contracts, final JSON output, interrupted-task recovery and Windows port-release races. Updates and recovery wait for the original managed processes to release their ports while continuing to reject external listeners.
- Fix Windows package-path and application-parent identity checks and improve update-metadata reuse. Add API usage compatibility for the reviewed Strata 0.1.43 source, retaining engine validation, configuration protection and rollback checks.
- Keep official GitHub as the default runtime source and add GH Proxy, GHProxy, custom HTTPS templates/fixed URLs and local ZIPs. All sources match the official package to the current CUDA12/CUDA13/HIP engine. Saved sources can be tested for availability and resumption even when current, without stopping services. Network tests read at most 64 KiB; installation still validates full length and SHA256. Interrupted downloads retain partial data, with up to three attempts and retries after 60 seconds without a response.
- Let external assistants manage the current profile through the independent background by default, with copyable MCP configuration, connection checks and controlled tools. Independent handoff remains optional; disconnecting preserves running services and stopped services stay stopped. Codex MCP configurations generated for this background-managed mode use a 600-second call timeout for cold model loading.
- Use the application logo and current version in the top-left corner, linking to a dedicated App updates page. Mark available updates and provide offline bilingual notes for the installed version.
- Add an API integration entry to the Overview service card with code, Cherry Studio, OpenCode and Claude Code guides and copyable configuration based on the current service address and model name.
- Refine startup/download settings and fix Linux local scans being interrupted by unrelated or permission-restricted Python processes.
- Recapture bilingual 0.1.4 workspaces, common settings, connections, updates and monitors; refresh product covers, website features and documentation. Add system explanations, update interface contracts and generate website release notes from this file.
- Reuse installers only from complete CI for the exact source commit. Three independent native runners on each of Windows and Linux run alongside installer builds; all eight jobs from one attempt must succeed with complete aggregate coverage. Reduce Rust dependency caches while retaining original test deadlines, installation/startup, signed-version, actual-asset signature and checksum gates.
- Windows hardware checks covered MCP start/stop, continued operation after disconnect, stopped-service preservation, model restoration and inference; configuration hashes remained unchanged. Benchmark, tuning and download flows passed isolated browser checks, with additional installed-desktop interaction checks for the Benchmark and Tuning interfaces. Real GPU Benchmark measurements, full tuning, sustained GPU stress, Linux system-level DEB installation and client cross-version automatic updates still require separate validation.


#### Feature screenshots

These screenshots show the interface at the 0.1.4 release, using isolated demonstration data. Displayed values illustrate the interface. Click an image to open the original.

##### Benchmark scenarios and stress tests

[![Benchmark scenarios and stress tests](docs/screenshots/changelog/0.1.4/benchmark.en.webp)](docs/screenshots/changelog/0.1.4/benchmark.en.webp)

##### Common chat defaults

[![Common chat defaults](docs/screenshots/changelog/0.1.4/common-chat-settings.en.webp)](docs/screenshots/changelog/0.1.4/common-chat-settings.en.webp)

##### API and external assistants

[![API and external assistants](docs/screenshots/changelog/0.1.4/connections.en.webp)](docs/screenshots/changelog/0.1.4/connections.en.webp)

##### VRAM and session tools

[![VRAM and session tools](docs/screenshots/changelog/0.1.4/runtime-tools.en.webp)](docs/screenshots/changelog/0.1.4/runtime-tools.en.webp)

##### Strata download sources and network test

[![Strata download sources and network test](docs/screenshots/changelog/0.1.4/runtime-download-settings.en.webp)](docs/screenshots/changelog/0.1.4/runtime-download-settings.en.webp)

##### Service status and live monitoring

[![Service status and live monitoring](docs/screenshots/changelog/0.1.4/service-status.en.webp)](docs/screenshots/changelog/0.1.4/service-status.en.webp)

##### Floating desktop monitor

[![Floating desktop monitor](docs/screenshots/changelog/0.1.4/floating-monitor.en.webp)](docs/screenshots/changelog/0.1.4/floating-monitor.en.webp)

##### Version and app updates

[![Version and app updates](docs/screenshots/changelog/0.1.4/app-updates.en.webp)](docs/screenshots/changelog/0.1.4/app-updates.en.webp)


## [0.1.3] - 2026-10-12

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
