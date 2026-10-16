# D2 页面改版：功能清单与保留核对

范围：12 个已批准的 D2 页面（我的模型、下载模型、运行配置、Strata 运行环境、参数调优、任务与日志、Benchmark、公共设置、API 与外部助手、显存与会话、应用更新、关于）。

做法：改版前，用 `scripts/design/page-inventory.mjs write` 从 main（8bd5c60）抽取每页源代码里的可见文案、i18n 键、无障碍标签、交互处理器、控件和状态组件，存为 `feature-inventory.baseline.json`。改版只**新增**可视层和交互，不删除、不改写原有组件。`node scripts/design/page-inventory.mjs check design/pages-d2/feature-inventory.baseline.json` 的结果为 `all inventory items present`。

## 各页功能与新位置（人工核对）

### 我的模型（ServiceManagerPage）
- [x] 模型分组卡片、配置下拉（含删除配置）、当前、准备中、上次使用标记 → 原位置不变
- [x] 聊天、配置、启动、停止、重启、接管、加载、卸载、查看日志、编辑、删除模型、展开详情 → 原 `service-manager-actions` 与 `service-manager-details`
- [x] 添加目录、扫描，扫描中、扫描失败、空列表（含添加目录按钮）、待修复配置折叠区 → 原位置
- [x] 确认对话框、模型删除对话框、配置删除对话框 → 原位置
- [x] 健康检查错误、无效服务、进程检查失败、操作失败、需要修复、外部服务提示、认证提示 → 原位置
- [+] 新增：页首“本机容量”区：显存环、内存环；显卡、内存总量与空闲；本机模型数与配置数；当前运行的模型。服务停止时显示“未实测”和说明 → `D2PageStrips.ModelsLead`
- [+] 新增：每份配置的“运行约需 X GB 内存”刻度条，对照本机内存。无法从目录识别时显示“资源需求 未实测” → `RequirementMeter`

### 下载模型（ModelDownloadPage）
- [x] 搜索、清除搜索、模型数、模型列表、无匹配空态（含清除按钮）、目录快照说明与日期 → 原位置
- [x] 详情：返回、官方目录链接、量化单选（下载大小、参考 RAM）、实验版、仅 NVIDIA、图像未验证警告 → 原位置；表格多一列
- [x] 启动预设：上下文 NumberField 与校验、图像 Toggle、资源说明 → 原位置
- [x] 资源评估面板、提交栏“下载并准备”、磁盘预检、错误 → 原位置
- [x] 已有模型与兼容性检查：导入配置、ModelInspectPanel、本机模型列表、重新扫描与导入 → 原位置
- [x] 模型下载配置对话框、下载任务按钮与计数、公共配置条、读取失败、需要运行环境提示（选择、安装） → 原位置
- [+] 新增：“适合这台电脑”依据行，按内存和磁盘可用空间判断。内存未知时显示“未实测” → 列表顶部
- [+] 新增（实时更新）：本机模型列表每 30 s 轮询（原来只在展开“已有模型”时查询）；磁盘每 60 s 轮询（原有）；有下载任务运行时每 3 s 刷新共享任务列表。行内状态原地更新：下载进度（从任务消息解析百分比或 “x / y GB”）、已下载、上次失败、适配等级与推荐量化。状态变化时该行淡入高亮 1.6 s（遵守 reduced-motion）。依据行显示“实时更新 · 时间”；本机模型读取失败时显示错误状态
- [+] 新增：目录条目新增或数据变化时显示“新 / 已更新”徽标（与本机上次看到的快照签名比较，存在 localStorage）
- [+] 新增：量化表加一列“本机 N GB”：点轴（参考内存的位置与本机内存虚线）、适配、下载中百分比、已下载

### 运行配置（ConfigurationList + RuntimeConfigPage）
- [x] 配置列表、图形与 JSON 编辑、复制为新配置、删除、保存、保存并重启、重新读取、图像支持、资源适配建议、分类、搜索参数等全部原样保留
- [+] 新增：页首“资源估算”：模型约需内存环（目录量化参考内存 / 本机内存，80% 阈值标记）、当前显存环、适配结论。无法识别或服务未运行时显示“未实测”，并明确写出“非实测” → `ConfigEstimate`

### Strata 运行环境
- [x] InstallRuntimePage、OfficialUpdatePanel、系统信息面板（刷新、错误、空态、需要桌面端） → 原位置
- [+] 新增：设备条：处理器、内存、显卡图标与数值，PCIe 代际与通道数（来自 /metrics），缺失项显示“未实测” → `EnvironmentDevices`

### 参数调优（TuningPage）
- [x] 所有测试设置、开始、取消、应用、恢复、结果、候选表、帮助对话框 → 原位置
- [+] 新增：结果摘要里的候选收益点图（0 为当前参数，推荐项高亮，未通过的为空心点），没有收益数据时显示“未实测” → `GainDotPlot`

### 任务与日志（App TasksPage）
- [x] 导出诊断、刷新、错误块、任务列表（下一步、查看日志、取消、重试）、空态、日志搜索、日志来源、日志视图、空态提示 → 原位置
- [+] 新增：近 24 小时时间线，按状态着色。点击圆点会选中该任务的日志并滚动到该行；选中的行有标记 → `TasksTimeline`

### Benchmark（ContextBenchmarkPage 等）
- [x] 档位复选、测试配置名、轮数、最大输出、超时、出错即停、开始与停止、实时进度、结果图表、逐次测量表、复制图片、历史对比、场景测试 → 原位置
- [+] 新增：档位对数轴：已选档位为实心点，并用虚线标出模型上下文上限 → `TierAxis`

### 公共设置（App SettingsPage + DesktopLifecycleSettings background）
- [x] 主题 Segmented（深色、浅色、跟随系统）、界面语言 Dropdown（含跟随系统）、非中英语言的翻译回退提示 → 外观分区，改为左标签右控件的行；回退提示拼在语言行的说明里
- [x] 关闭窗口后在后台运行 Toggle（提示仍在 tooltip 里）、关闭时出现的“退出前询问” Toggle → 运行行为分区
- [x] 本机后台：登录时启动、保持模型就绪、自动恢复服务、空闲释放下拉、帮助对话框、读取失败、后端更新待处理、需要修复、迁移失败提示 → 本机后台分区，原组件
- [+] 新增：三个分区合成单列卡片，用分隔线隔开；语言行显示“共 N 种随包语言”；关闭到托盘和自动恢复服务的说明直接显示在行下（原来只在 tooltip 里）

### 应用更新（DesktopLifecycleSettings updates）
- [x] 当前版本、自动检查 Toggle、阶段状态（role=status）、检查、下载、安装失败提示与“查看原因”对话框、下载字节进度、检查更新、查看更新日志、安装、重启按钮、可用更新日志、最近一次更新日志、帮助对话框 → 原位置
- [+] 新增：版本号放大，用等宽字体作为焦点；右侧状态徽标（尚未检查、正在检查、已是最新、有新版本 vX、下载中、已下载、重启后生效、出错）；非桌面端提示
- [+] 新增：操作行右侧的“更新日志 →”链接，指向 GitHub Releases

### 关于（OfficialAbout）
- [x] 模型与引擎、这台电脑、连接你的工具（含复制）、运行配置与偏好（两个跳转按钮） → 原卡片不变
- [x] 原 Strata Manager 卡片的应用版本、aboutHint、项目说明、存储说明、源码与上游链接、第三方许可 details（含全文） → 移到页首身份卡
- [+] 新增：身份卡带图标、名称、一句话定位；GitHub 与官网链接；Strata 引擎版本和当前模型的事实行；许可摘要行，“全部许可 →”展开全文

### API 与外部助手
- [x] 连接目标下拉、接入 API、服务能力、服务连接与 API Key、局域网共享、外部助手（MCP）、接入对话框 → 原位置
- [+] 新增：页面焦点为大号 API 地址（`/v1`）、复制按钮、在线状态与模型名 → `EndpointHero`

### 显存与会话
- [x] RuntimeOperationsPanel 全部功能（让出显存、恢复默认预留、存档检查、保存会话、恢复会话、刷新状态） → 原位置
- [+] 新增：显存条（D2 中唯一保留的堆叠条）：专家 / 模型与运行时 / 空闲。服务停止时显示空态说明 → `VramReserveBar`

## 自动核对结果
基线条目保留：855 / 855

## 自动核对清单（基线：feature-inventory.baseline.json，改版前从 main 抽取）

每一项为改版前该页面源代码中的一个可见文案、i18n 键、控件、交互处理器或状态。`[x]` 表示改版后仍存在，后面是它现在所在的文件。

### 我的模型 (models/profiles)

**文案 zh ?**（20）

- [x] `上次使用` → pages/ConfigurationList.tsx
- [x] `上次启用` → pages/ConfigurationList.tsx
- [x] `使用并重启` → pages/ConfigurationList.tsx
- [x] `使用此配置` → pages/ConfigurationList.tsx
- [x] `修改` → pages/ConfigurationList.tsx
- [x] `删除配置文件` → pages/ConfigurationList.tsx
- [x] `取消` → pages/ConfigurationList.tsx
- [x] `将结束当前模型服务，并按以下文件启动。未保存的编辑不会生效。` → pages/ConfigurationList.tsx
- [x] `展开此模型的配置列表` → pages/ConfigurationList.tsx
- [x] `应用运行配置` → pages/ConfigurationList.tsx
- [x] `当前运行` → pages/ConfigurationList.tsx
- [x] `扫描` → pages/ConfigurationList.tsx
- [x] `未记录` → pages/ConfigurationList.tsx
- [x] `正在应用…` → pages/ConfigurationList.tsx
- [x] `正在读取配置…` → pages/ConfigurationList.tsx
- [x] `此模型的全部配置` → pages/ConfigurationList.tsx
- [x] `此模型的配置列表` → pages/ConfigurationList.tsx
- [x] `还没有本机配置。` → pages/ConfigurationList.tsx
- [x] `配置列表` → pages/ConfigurationList.tsx
- [x] `重启模型服务并应用配置` → pages/ConfigurationList.tsx

**交互处理器**（28）

- [x] `onAdd` → App.tsx
- [x] `onBlurCapture` → pages/ConfigurationList.tsx
- [x] `onChat` → App.tsx
- [x] `onClick` → pages/ServiceManagerPage.tsx, pages/ConfigurationList.tsx
- [x] `onClose` → pages/ServiceManagerPage.tsx, pages/ConfigurationList.tsx
- [x] `onConfig` → App.tsx
- [x] `onConfigCandidate` → App.tsx
- [x] `onDelete` → pages/ServiceManagerPage.tsx, App.tsx
- [x] `onDeleted` → pages/ServiceManagerPage.tsx
- [x] `onEdit` → App.tsx
- [x] `onError` → App.tsx
- [x] `onFocusCapture` → pages/ConfigurationList.tsx
- [x] `onImport` → App.tsx
- [x] `onKeyDown` → pages/ConfigurationList.tsx
- [x] `onLoad` → App.tsx
- [x] `onLogs` → App.tsx
- [x] `onModelDeleted` → App.tsx
- [x] `onPointerEnter` → pages/ConfigurationList.tsx
- [x] `onPointerLeave` → pages/ConfigurationList.tsx
- [x] `onRefreshDiscovery` → App.tsx
- [x] `onRestart` → App.tsx
- [x] `onSelect` → App.tsx
- [x] `onStart` → App.tsx
- [x] `onStop` → App.tsx
- [x] `onTakeover` → App.tsx
- [x] `onUnload` → App.tsx
- [x] `onUseCandidate` → App.tsx
- [x] `onValueChange` → pages/ServiceManagerPage.tsx

**控件 / 状态组件**（3）

- [x] `Dialog` → pages/ConfigurationList.tsx
- [x] `Empty` → pages/ServiceManagerPage.tsx
- [x] `details` → pages/ServiceManagerPage.tsx

**状态角色 (alert/status/log)**（2）

- [x] `alert` → pages/ServiceManagerPage.tsx, pages/ConfigurationList.tsx
- [x] `status` → pages/ServiceManagerPage.tsx

### 下载模型 (catalog)

**文案 text()**（74）

- [x] ` 起` → pages/ModelDownloadPage.tsx
- [x] `1. 选择量化版本` → pages/ModelDownloadPage.tsx
- [x] `HF 镜像` → pages/ModelDownloadPage.tsx
- [x] `。选择适合自己的量化版本。` → pages/ModelDownloadPage.tsx
- [x] `上下文` → pages/ModelDownloadPage.tsx
- [x] `上下文长度` → pages/ModelDownloadPage.tsx
- [x] `上下文需为 512–1,048,576 的整数。` → pages/ModelDownloadPage.tsx
- [x] `下载 → 打包 → 生成配置，完成后在“我的模型”手动启用。` → pages/ModelDownloadPage.tsx
- [x] `下载与显卡` → pages/ModelDownloadSettingsDialog.tsx
- [x] `下载任务` → pages/ModelDownloadPage.tsx
- [x] `下载大小` → pages/ModelDownloadPage.tsx
- [x] `下载并准备` → pages/ModelDownloadPage.tsx
- [x] `下载模型` → pages/ModelDownloadPage.tsx
- [x] `仅支持 NVIDIA` → pages/ModelDownloadPage.tsx
- [x] `使用当前所选环境` → pages/ModelDownloadSettingsDialog.tsx
- [x] `保存中…` → pages/ModelDownloadSettingsDialog.tsx
- [x] `保存后根据所选环境检查` → pages/ModelDownloadSettingsDialog.tsx
- [x] `保存配置` → pages/ModelDownloadSettingsDialog.tsx
- [x] `公共配置` → pages/ModelDownloadPage.tsx
- [x] `公共配置读取失败，请打开配置检查后保存。` → pages/ModelDownloadPage.tsx
- [x] `参考 RAM` → pages/ModelDownloadPage.tsx
- [x] `取消` → pages/ModelDownloadSettingsDialog.tsx
- [x] `启动预设` → pages/ModelDownloadPage.tsx
- [x] `启用图像支持` → pages/ModelDownloadPage.tsx
- [x] `图像关闭` → pages/ModelDownloadPage.tsx
- [x] `图像开启` → pages/ModelDownloadPage.tsx
- [x] `图像能力未验证` → pages/ModelDownloadPage.tsx
- [x] `安装运行环境` → pages/ModelDownloadPage.tsx
- [x] `官方目录` → pages/ModelDownloadPage.tsx
- [x] `实验版本` → pages/ModelDownloadPage.tsx
- [x] `导入已有配置，或检查其它模型文件是否可用于当前环境。` → pages/ModelDownloadPage.tsx
- [x] `导入配置` → pages/ModelDownloadPage.tsx
- [x] `尚未选择运行环境` → pages/ModelDownloadPage.tsx
- [x] `已提交的任务保留提交时的设置。` → pages/ModelDownloadSettingsDialog.tsx
- [x] `已有模型与兼容性检查` → pages/ModelDownloadPage.tsx
- [x] `已选择` → pages/ModelDownloadPage.tsx
- [x] `已选择全部 GPU，当前规则无法完整估算多卡配置。` → pages/ModelDownloadPage.tsx
- [x] `所有模型共用的下载与显卡默认设置。保存后用于新建下载任务。` → pages/ModelDownloadSettingsDialog.tsx
- [x] `所选运行环境没有可识别的本地模型配置。` → pages/ModelDownloadPage.tsx
- [x] `搜索模型` → pages/ModelDownloadPage.tsx
- [x] `新下载任务使用这些默认设置。` → pages/ModelDownloadPage.tsx
- [x] `显卡` → pages/ModelDownloadPage.tsx
- [x] `显卡自动选择` → pages/ModelDownloadPage.tsx
- [x] `本地模型配置` → pages/ModelDownloadPage.tsx
- [x] `模型下载配置` → pages/ModelDownloadPage.tsx, pages/ModelDownloadSettingsDialog.tsx
- [x] `模型位置由所选 Strata 运行环境决定；已有模型文件保留在原位置。` → pages/ModelDownloadSettingsDialog.tsx
- [x] `模型数据目录` → pages/ModelDownloadSettingsDialog.tsx
- [x] `模型目录` → pages/ModelDownloadPage.tsx
- [x] `正在检查并提交…` → pages/ModelDownloadPage.tsx
- [x] `正在读取…` → pages/ModelDownloadPage.tsx
- [x] `此目录尚未识别为就绪的 Strata 运行环境，请先在 Strata 页面检测或准备。` → pages/ModelDownloadSettingsDialog.tsx
- [x] `没有匹配的模型` → pages/ModelDownloadPage.tsx
- [x] `浏览官方模型目录，选择版本并准备到本机。` → pages/ModelDownloadPage.tsx
- [x] `清除搜索` → pages/ModelDownloadPage.tsx
- [x] `目录来自官方安装器快照，实际支持以所选运行环境为准。` → pages/ModelDownloadPage.tsx
- [x] `磁盘空间不足，请检查存储位置或清理空间。` → pages/ModelDownloadPage.tsx
- [x] `磁盘空间尚未核验，请重新检查。` → pages/ModelDownloadPage.tsx
- [x] `自动` → pages/ModelDownloadPage.tsx
- [x] `试试模型名称或用途，例如 Qwen、Swift、代码。` → pages/ModelDownloadPage.tsx
- [x] `请填写有效的上下文长度后重新预估。` → pages/ModelDownloadPage.tsx
- [x] `请等待当前操作完成后再准备模型。` → pages/ModelDownloadPage.tsx
- [x] `起步版本` → pages/ModelDownloadPage.tsx
- [x] `较长上下文和图像支持可能增加资源占用。` → pages/ModelDownloadPage.tsx
- [x] `运行环境与存储位置` → pages/ModelDownloadSettingsDialog.tsx
- [x] `返回模型列表` → pages/ModelDownloadPage.tsx
- [x] `选择中…` → pages/ModelDownloadSettingsDialog.tsx
- [x] `选择其他目录` → pages/ModelDownloadSettingsDialog.tsx
- [x] `选择已有 Strata 运行环境，或先安装运行环境。模型目录可以先浏览。` → pages/ModelDownloadPage.tsx
- [x] `选择运行环境` → pages/ModelDownloadPage.tsx
- [x] `选择运行环境后可检查本机资源。` → pages/ModelDownloadPage.tsx
- [x] `重新扫描` → pages/ModelDownloadPage.tsx
- [x] `量化` → pages/ModelDownloadPage.tsx
- [x] `需要桌面后台执行模型准备。` → pages/ModelDownloadPage.tsx
- [x] `默认运行环境` → pages/ModelDownloadSettingsDialog.tsx

**文案 zh ?**（24）

- [x] `代码任务` → pages/ModelDownloadPage.tsx
- [x] `全部版本` → pages/ModelInspectPanel.tsx
- [x] `取消` → pages/ModelInspectPanel.tsx
- [x] `只读取模型信息，不加载模型。识别到格式不代表已经验证此文件能够运行。` → pages/ModelInspectPanel.tsx
- [x] `官方模型` → pages/ModelDownloadPage.tsx
- [x] `官方系列模型` → pages/ModelDownloadPage.tsx
- [x] `已识别为官方支持的模型格式。` → pages/ModelInspectPanel.tsx
- [x] `帮助` → pages/ModelInspectPanel.tsx
- [x] `指定量化版本（可选）` → pages/ModelInspectPanel.tsx
- [x] `查看详细结果` → pages/ModelInspectPanel.tsx
- [x] `检查兼容性` → pages/ModelInspectPanel.tsx
- [x] `检查模型文件兼容性` → pages/ModelInspectPanel.tsx
- [x] `检测到多个版本，请指定量化版本后重新检查。` → pages/ModelInspectPanel.tsx
- [x] `模型位置` → pages/ModelInspectPanel.tsx
- [x] `模型检查帮助` → pages/ModelInspectPanel.tsx
- [x] `模型检查结果` → pages/ModelInspectPanel.tsx
- [x] `此模型尚未经过官方验证。` → pages/ModelInspectPanel.tsx
- [x] `浏览` → pages/ModelInspectPanel.tsx
- [x] `请先准备或选择一个本机运行环境。` → pages/ModelInspectPanel.tsx
- [x] `选择文件，或填写模型地址` → pages/ModelInspectPanel.tsx
- [x] `选择本地模型文件，或填写目录、HTTPS 地址、hf:owner/repo、ms:owner/repo。多个量化版本时填写 IQ3_S 等版本名称。` → pages/ModelInspectPanel.tsx
- [x] `选择模型文件` → pages/ModelInspectPanel.tsx
- [x] `通用对话与长文` → pages/ModelDownloadPage.tsx
- [x] `量化分发版本` → pages/ModelDownloadPage.tsx

**交互处理器**（22）

- [x] `onChange` → pages/ModelDownloadPage.tsx, pages/ModelDownloadSettingsDialog.tsx, pages/ModelInspectPanel.tsx
- [x] `onCheckedChange` → pages/ModelDownloadPage.tsx
- [x] `onChooseDirectory` → pages/ModelDownloadPage.tsx, App.tsx
- [x] `onChooseFile` → App.tsx
- [x] `onChooseTarget` → pages/ModelDownloadPage.tsx
- [x] `onClick` → pages/ModelDownloadPage.tsx, pages/ModelDownloadSettingsDialog.tsx, pages/ModelInspectPanel.tsx, pages/ResourceAssessmentPanel.tsx
- [x] `onClose` → pages/ModelDownloadPage.tsx, pages/ModelDownloadSettingsDialog.tsx, pages/ModelInspectPanel.tsx
- [x] `onDirtyChange` → pages/ModelDownloadPage.tsx, App.tsx
- [x] `onEnvironment` → App.tsx
- [x] `onImportConfig` → App.tsx
- [x] `onInspect` → pages/ModelDownloadPage.tsx
- [x] `onPrepare` → App.tsx
- [x] `onRefresh` → pages/ResourceAssessmentPanel.tsx
- [x] `onRefreshDisk` → pages/ModelDownloadPage.tsx
- [x] `onRuntimeChange` → App.tsx
- [x] `onSave` → pages/ModelDownloadPage.tsx
- [x] `onSaveDraftReady` → pages/ModelDownloadPage.tsx, App.tsx
- [x] `onSubmit` → pages/ModelDownloadSettingsDialog.tsx
- [x] `onTasks` → App.tsx
- [x] `onToggle` → pages/ModelDownloadPage.tsx
- [x] `onValidityChange` → pages/ModelDownloadSettingsDialog.tsx
- [x] `onValueChange` → pages/ModelDownloadSettingsDialog.tsx

**控件 / 状态组件**（8）

- [x] `Dialog` → pages/ModelDownloadSettingsDialog.tsx, pages/ModelInspectPanel.tsx
- [x] `Dropdown` → pages/ModelDownloadSettingsDialog.tsx
- [x] `Field` → pages/ModelDownloadSettingsDialog.tsx
- [x] `NumberField` → pages/ModelDownloadPage.tsx
- [x] `Radio` → pages/ModelDownloadPage.tsx
- [x] `Toggle` → pages/ModelDownloadPage.tsx
- [x] `details` → pages/ModelDownloadPage.tsx, pages/ResourceAssessmentPanel.tsx
- [x] `input` → pages/ModelDownloadPage.tsx, pages/ModelInspectPanel.tsx

**状态角色 (alert/status/log)**（2）

- [x] `alert` → pages/ModelDownloadPage.tsx, pages/ModelDownloadSettingsDialog.tsx, pages/ModelInspectPanel.tsx, pages/ResourceAssessmentPanel.tsx
- [x] `status` → pages/ModelDownloadPage.tsx, pages/ModelInspectPanel.tsx, pages/ResourceAssessmentPanel.tsx

### 运行配置 (config)

**文案 zh ?**（44）

- [x] `上次使用` → pages/ConfigurationList.tsx
- [x] `上次启用` → pages/ConfigurationList.tsx
- [x] `使用并重启` → pages/ConfigurationList.tsx
- [x] `使用此配置` → pages/ConfigurationList.tsx
- [x] `保存中…` → pages/RuntimeConfigPage.tsx
- [x] `保存后重启模型生效。“默认”会清除该项的自定义值。` → pages/RuntimeConfigPage.tsx
- [x] `保存后重启生效` → pages/RuntimeConfigPage.tsx
- [x] `保存配置（重启后生效）` → pages/RuntimeConfigPage.tsx
- [x] `修改` → pages/ConfigurationList.tsx
- [x] `其他服务参数` → pages/RuntimeConfigPage.tsx
- [x] `删除配置文件` → pages/ConfigurationList.tsx
- [x] `前往服务管理重启` → pages/RuntimeConfigPage.tsx
- [x] `取消` → pages/ConfigurationList.tsx
- [x] `图形界面与 JSON 编辑同一份完整配置。保存会备份原文件；当前服务在重启前继续使用已有配置。` → pages/RuntimeConfigPage.tsx
- [x] `将结束当前模型服务，并按以下文件启动。未保存的编辑不会生效。` → pages/ConfigurationList.tsx
- [x] `展开此模型的配置列表` → pages/ConfigurationList.tsx
- [x] `应用运行配置` → pages/ConfigurationList.tsx
- [x] `当前运行` → pages/ConfigurationList.tsx
- [x] `快捷配置图像支持` → pages/RuntimeConfigPage.tsx
- [x] `恢复默认` → pages/RuntimeConfigPage.tsx
- [x] `打开设置` → pages/RuntimeConfigPage.tsx
- [x] `扫描` → pages/ConfigurationList.tsx
- [x] `服务提供的运行配置字段只写入配置文件，重启后生效。完整本地 JSON 可在桌面应用中编辑。` → pages/RuntimeConfigPage.tsx
- [x] `服务离线。连接成功后会自动读取运行配置；API Key 可在设置的“API 与外部助手”中保存。` → pages/RuntimeConfigPage.tsx
- [x] `服务配置文件字段` → pages/RuntimeConfigPage.tsx
- [x] `未记录` → pages/ConfigurationList.tsx
- [x] `模型启动配置` → pages/RuntimeConfigPage.tsx
- [x] `正在应用…` → pages/ConfigurationList.tsx
- [x] `正在读取配置…` → pages/ConfigurationList.tsx
- [x] `此服务未提供可编辑的运行配置字段。` → pages/RuntimeConfigPage.tsx
- [x] `此模型的全部配置` → pages/ConfigurationList.tsx
- [x] `此模型的配置列表` → pages/ConfigurationList.tsx
- [x] `清除自定义值，保存后采用默认值` → pages/RuntimeConfigPage.tsx
- [x] `读取中…` → pages/RuntimeConfigPage.tsx
- [x] `返回我的模型` → pages/RuntimeConfigPage.tsx
- [x] `还没有本机配置。` → pages/ConfigurationList.tsx
- [x] `选择服务后可读取运行配置。` → pages/RuntimeConfigPage.tsx
- [x] `选择本机模型后可读取资源建议。` → pages/RuntimeConfigPage.tsx
- [x] `配置列表` → pages/ConfigurationList.tsx
- [x] `配置尚未读取或当前草稿不完整，容量保持未知。` → pages/RuntimeConfigPage.tsx
- [x] `重启模型服务并应用配置` → pages/ConfigurationList.tsx
- [x] `重新读取` → pages/RuntimeConfigPage.tsx
- [x] `重新读取会舍弃未保存的改动。` → pages/RuntimeConfigPage.tsx
- [x] `默认` → pages/RuntimeConfigPage.tsx

**i18n key t()**（5）

- [x] `configDefault` → pages/RuntimeConfigPage.tsx
- [x] `configNothingChanged` → pages/RuntimeConfigPage.tsx
- [x] `configSavedRestart` → pages/RuntimeConfigPage.tsx
- [x] `enabledOff` → pages/RuntimeConfigPage.tsx
- [x] `enabledOn` → pages/RuntimeConfigPage.tsx

**交互处理器**（25）

- [x] `onBlurCapture` → pages/ConfigurationList.tsx
- [x] `onChange` → pages/RuntimeConfigPage.tsx
- [x] `onClick` → pages/RuntimeConfigPage.tsx, pages/ConfigurationList.tsx
- [x] `onClose` → pages/ConfigurationList.tsx
- [x] `onCopied` → pages/RuntimeConfigPage.tsx, App.tsx
- [x] `onDelete` → App.tsx
- [x] `onDeleted` → pages/RuntimeConfigPage.tsx, App.tsx
- [x] `onDirtyChange` → pages/RuntimeConfigPage.tsx, App.tsx
- [x] `onDraftConfigChange` → pages/RuntimeConfigPage.tsx
- [x] `onError` → pages/RuntimeConfigPage.tsx, App.tsx
- [x] `onFocusCapture` → pages/ConfigurationList.tsx
- [x] `onImages` → App.tsx
- [x] `onKeyDown` → pages/ConfigurationList.tsx
- [x] `onMessage` → pages/RuntimeConfigPage.tsx, App.tsx
- [x] `onOpen` → App.tsx
- [x] `onPointerEnter` → pages/ConfigurationList.tsx
- [x] `onPointerLeave` → pages/ConfigurationList.tsx
- [x] `onRefresh` → App.tsx
- [x] `onRestart` → pages/RuntimeConfigPage.tsx, App.tsx
- [x] `onSaveDraftReady` → pages/RuntimeConfigPage.tsx, App.tsx
- [x] `onServices` → App.tsx
- [x] `onSharedSettings` → App.tsx
- [x] `onSubmit` → pages/RuntimeConfigPage.tsx
- [x] `onUse` → App.tsx
- [x] `onValueChange` → pages/RuntimeConfigPage.tsx

**控件 / 状态组件**（4）

- [x] `Dialog` → pages/ConfigurationList.tsx
- [x] `Dropdown` → pages/RuntimeConfigPage.tsx
- [x] `NumberField` → pages/RuntimeConfigPage.tsx
- [x] `input` → pages/RuntimeConfigPage.tsx

**状态角色 (alert/status/log)**（2）

- [x] `alert` → pages/RuntimeConfigPage.tsx, pages/ConfigurationList.tsx
- [x] `status` → pages/RuntimeConfigPage.tsx

### Strata 运行环境 (environment)

**i18n key t()**（12）

- [x] `appVersion` → App.tsx
- [x] `architecture` → App.tsx
- [x] `availableMemory` → App.tsx
- [x] `cpu` → App.tsx
- [x] `empty` → App.tsx
- [x] `gpus` → App.tsx
- [x] `loading` → App.tsx
- [x] `missing` → App.tsx
- [x] `nativeRequired` → App.tsx
- [x] `refresh` → App.tsx
- [x] `system` → App.tsx
- [x] `totalMemory` → App.tsx

**交互处理器**（3）

- [x] `onClick` → pages/InstallRuntimePage.tsx, pages/OfficialUpdatePanel.tsx, App.tsx
- [x] `onUpdateStarted` → pages/InstallRuntimePage.tsx, App.tsx
- [x] `onValueChange` → pages/InstallRuntimePage.tsx

**控件 / 状态组件**（4）

- [x] `Dropdown` → pages/InstallRuntimePage.tsx
- [x] `Empty` → pages/InstallRuntimePage.tsx, App.tsx
- [x] `ErrorBlock` → App.tsx
- [x] `details` → pages/OfficialUpdatePanel.tsx

**状态角色 (alert/status/log)**（3）

- [x] `alert` → pages/InstallRuntimePage.tsx, pages/OfficialUpdatePanel.tsx
- [x] `log` → pages/InstallRuntimePage.tsx
- [x] `status` → pages/InstallRuntimePage.tsx, pages/OfficialUpdatePanel.tsx

### 参数调优 (tuning)

**文案 ==='zh-CN'**（2）

- [x] `保存后重启生效` → App.tsx
- [x] `调整模型设置` → App.tsx

**i18n key t()**（1）

- [x] `config` → App.tsx

**交互处理器**（6）

- [x] `onChange` → pages/TuningPage.tsx
- [x] `onChanged` → App.tsx
- [x] `onCheckedChange` → pages/TuningPage.tsx
- [x] `onClick` → pages/TuningPage.tsx, App.tsx
- [x] `onClose` → pages/TuningPage.tsx
- [x] `onValueChange` → pages/TuningPage.tsx

**控件 / 状态组件**（5）

- [x] `Dialog` → pages/TuningPage.tsx
- [x] `Dropdown` → pages/TuningPage.tsx
- [x] `Segmented` → pages/TuningPage.tsx
- [x] `Toggle` → pages/TuningPage.tsx
- [x] `details` → pages/TuningPage.tsx

**状态角色 (alert/status/log)**（2）

- [x] `alert` → pages/TuningPage.tsx
- [x] `status` → pages/TuningPage.tsx

### 任务与日志 (tasks)

**i18n key t()**（16）

- [x] `cancelTask` → App.tsx
- [x] `diagnostics` → App.tsx
- [x] `logSource` → App.tsx
- [x] `logs` → App.tsx
- [x] `nativeRequired` → App.tsx
- [x] `noLogs` → App.tsx
- [x] `noTasks` → App.tsx
- [x] `refresh` → App.tsx
- [x] `retry` → App.tsx
- [x] `retryUnavailable` → App.tsx
- [x] `searchLogs` → App.tsx
- [x] `selectLogSourceHint` → App.tsx
- [x] `serviceLogs` → App.tsx
- [x] `taskIntro` → App.tsx
- [x] `tasks` → App.tsx
- [x] `viewLogs` → App.tsx

**交互处理器**（3）

- [x] `onChange` → App.tsx
- [x] `onClick` → App.tsx
- [x] `onValueChange` → App.tsx

**控件 / 状态组件**（5）

- [x] `Dropdown` → App.tsx
- [x] `Empty` → App.tsx
- [x] `ErrorBlock` → App.tsx
- [x] `Field` → App.tsx
- [x] `input` → App.tsx

**状态角色 (alert/status/log)**（1）

- [x] `log` → App.tsx

### Benchmark

**文案 text()**（180）

- [x] `CPU 使用率` → pages/ScenarioBenchmarkPage.tsx
- [x] `GPU 使用率` → pages/ScenarioBenchmarkPage.tsx
- [x] `RAM 峰值` → pages/ContextBenchmarkPage.tsx
- [x] `RAM 峰值 (GiB)` → pages/ContextBenchmarkPage.tsx
- [x] `TTFT 从请求发出计至首个内容或推理 token；总耗时包含等待与传输。Prefill 和 Decode 使用各请求返回的引擎速度，实际输入和输出 token 来自服务用量。预热、失败和停止的样本不计入速度和延迟汇总。` → pages/ScenarioBenchmarkPage.tsx
- [x] `上下文历史对照` → pages/ContextBenchmarkPage.tsx
- [x] `上下文档位` → pages/ContextBenchmarkPage.tsx
- [x] `上下文档位实测` → pages/ContextBenchmarkPage.tsx
- [x] `上下文测试历史` → pages/ContextBenchmarkPage.tsx
- [x] `个请求完成` → pages/ScenarioBenchmarkPage.tsx
- [x] `串行测试` → pages/ScenarioBenchmarkPage.tsx
- [x] `仅并列展示测量值` → pages/ContextBenchmarkPage.tsx
- [x] `以上方当前记录为 A，选择另一份记录为 B。旧记录仍可对照测量值；身份或条件未核验时不显示提速结论。` → pages/ContextBenchmarkPage.tsx
- [x] `停止测试` → pages/ContextBenchmarkPage.tsx, pages/ScenarioBenchmarkPage.tsx
- [x] `先预热一次` → pages/ScenarioBenchmarkPage.tsx
- [x] `全部场景` → pages/ScenarioBenchmarkPage.tsx
- [x] `出错即停` → pages/ContextBenchmarkPage.tsx
- [x] `分场景对比` → pages/ScenarioBenchmarkPage.tsx
- [x] `单请求平均输出速度` → pages/ScenarioBenchmarkPage.tsx
- [x] `历史最多保留最近 20 组，总容量 16 MiB；始终保留最新整组报告。` → pages/ScenarioBenchmarkPage.tsx
- [x] `历史测试` → pages/ScenarioBenchmarkPage.tsx
- [x] `发生错误后停止` → pages/ScenarioBenchmarkPage.tsx
- [x] `变化输入` → pages/ScenarioBenchmarkPage.tsx
- [x] `各上下文档位实测` → pages/ContextBenchmarkPage.tsx
- [x] `图表：成功请求的档位均值` → pages/ContextBenchmarkPage.tsx
- [x] `场景` → pages/ScenarioBenchmarkPage.tsx
- [x] `场景测试` → pages/ScenarioBenchmarkPage.tsx
- [x] `场景测试固定一次只发送一个请求，按轮数跑完有限计划。对话的每一轮分别计为一个请求。` → pages/ScenarioBenchmarkPage.tsx
- [x] `场景测试说明` → pages/ScenarioBenchmarkPage.tsx
- [x] `复制图片` → pages/ContextBenchmarkPage.tsx
- [x] `失败` → pages/ContextBenchmarkPage.tsx, pages/ScenarioBenchmarkPage.tsx
- [x] `字符` → pages/ScenarioBenchmarkPage.tsx
- [x] `完成` → pages/ContextBenchmarkPage.tsx, pages/ScenarioBenchmarkPage.tsx
- [x] `完成测试后，在这里查看结果。` → pages/ScenarioBenchmarkPage.tsx
- [x] `完整成功测量` → pages/ContextBenchmarkPage.tsx
- [x] `实时测试进度` → pages/ContextBenchmarkPage.tsx, pages/ScenarioBenchmarkPage.tsx
- [x] `实际缓存计数` → pages/ContextBenchmarkPage.tsx
- [x] `实际输入` → pages/ContextBenchmarkPage.tsx
- [x] `实际输入 / 输出` → pages/ScenarioBenchmarkPage.tsx
- [x] `实际输入 / 输出 token` → pages/ScenarioBenchmarkPage.tsx
- [x] `实际输入量与缓存复用` → pages/ContextBenchmarkPage.tsx
- [x] `实际输出` → pages/ContextBenchmarkPage.tsx
- [x] `对照上下文测试记录` → pages/ContextBenchmarkPage.tsx
- [x] `对话轮次` → pages/ScenarioBenchmarkPage.tsx
- [x] `导出 CSV` → pages/ScenarioBenchmarkPage.tsx
- [x] `导出 JSON` → pages/ScenarioBenchmarkPage.tsx
- [x] `尚未取得模型上下文上限` → pages/ContextBenchmarkPage.tsx
- [x] `差异` → pages/ContextBenchmarkPage.tsx
- [x] `已停止` → pages/ContextBenchmarkPage.tsx, pages/ScenarioBenchmarkPage.tsx
- [x] `已发出` → pages/ScenarioBenchmarkPage.tsx
- [x] `已取消` → pages/ScenarioBenchmarkPage.tsx
- [x] `已完成` → pages/ScenarioBenchmarkPage.tsx
- [x] `已跳过` → pages/ContextBenchmarkPage.tsx
- [x] `已选` → pages/ScenarioBenchmarkPage.tsx
- [x] `平均总耗时` → pages/ScenarioBenchmarkPage.tsx
- [x] `平均输入处理速度` → pages/ScenarioBenchmarkPage.tsx
- [x] `平均首 token 延迟` → pages/ScenarioBenchmarkPage.tsx
- [x] `开始` → pages/ScenarioBenchmarkPage.tsx
- [x] `开始测试` → pages/ContextBenchmarkPage.tsx, pages/ScenarioBenchmarkPage.tsx
- [x] `引擎` → pages/ContextBenchmarkPage.tsx
- [x] `引擎身份` → pages/ContextBenchmarkPage.tsx
- [x] `当前模型上限` → pages/ContextBenchmarkPage.tsx
- [x] `性能统计` → pages/ScenarioBenchmarkPage.tsx
- [x] `总耗时` → pages/ContextBenchmarkPage.tsx
- [x] `总耗时 (s)` → pages/ScenarioBenchmarkPage.tsx
- [x] `成功 / 失败` → pages/ScenarioBenchmarkPage.tsx
- [x] `按场景逐个发送单请求，观察首 token 延迟、输入处理和输出速度。` → pages/ScenarioBenchmarkPage.tsx
- [x] `提示缓存命中率` → pages/ScenarioBenchmarkPage.tsx
- [x] `收起设置` → pages/ScenarioBenchmarkPage.tsx
- [x] `整卡显存` → pages/ScenarioBenchmarkPage.tsx
- [x] `整卡显存峰值` → pages/ContextBenchmarkPage.tsx, pages/ScenarioBenchmarkPage.tsx
- [x] `整机 RAM` → pages/ScenarioBenchmarkPage.tsx
- [x] `整机 RAM 峰值` → pages/ScenarioBenchmarkPage.tsx
- [x] `旧版串行报告` → pages/ScenarioBenchmarkPage.tsx
- [x] `旧版压力测试` → pages/ScenarioBenchmarkPage.tsx
- [x] `时间与速度为成功请求均值；RAM/显存为对应档位整机采样峰值。不同输入量、缓存命中或生效配置不合并为性能结论。` → pages/ContextBenchmarkPage.tsx
- [x] `显存使用` → pages/ScenarioBenchmarkPage.tsx
- [x] `显存峰值 (GiB)` → pages/ContextBenchmarkPage.tsx
- [x] `显示最近 360 次采样，完整数据在 JSON 中。缺失指标显示 —；资源读数是整机观测，可能包含其他进程。` → pages/ScenarioBenchmarkPage.tsx
- [x] `最低空闲显存` → pages/ContextBenchmarkPage.tsx
- [x] `最大输出 token` → pages/ContextBenchmarkPage.tsx
- [x] `最近 Decode` → pages/ScenarioBenchmarkPage.tsx
- [x] `最近 TTFT` → pages/ScenarioBenchmarkPage.tsx
- [x] `服务与引擎进程证明` → pages/ContextBenchmarkPage.tsx
- [x] `未启动或模型未就绪` → pages/ContextBenchmarkPage.tsx, pages/ScenarioBenchmarkPage.tsx
- [x] `未执行` → pages/ContextBenchmarkPage.tsx
- [x] `未核验` → pages/ContextBenchmarkPage.tsx
- [x] `条件匹配` → pages/ContextBenchmarkPage.tsx
- [x] `条件核验` → pages/ContextBenchmarkPage.tsx
- [x] `查看最近输出片段` → pages/ScenarioBenchmarkPage.tsx
- [x] `查看设置` → pages/ScenarioBenchmarkPage.tsx
- [x] `档位` → pages/ContextBenchmarkPage.tsx
- [x] `档位测试进度` → pages/ContextBenchmarkPage.tsx
- [x] `模型` → pages/ContextBenchmarkPage.tsx
- [x] `模型上下文` → pages/ContextBenchmarkPage.tsx
- [x] `模型发生变化` → pages/ScenarioBenchmarkPage.tsx
- [x] `模型名称` → pages/ContextBenchmarkPage.tsx
- [x] `模型已切换，测试已停止。` → pages/ContextBenchmarkPage.tsx
- [x] `模型已就绪` → pages/ContextBenchmarkPage.tsx, pages/ScenarioBenchmarkPage.tsx
- [x] `模型文件内容` → pages/ContextBenchmarkPage.tsx
- [x] `模型文件身份` → pages/ContextBenchmarkPage.tsx
- [x] `次成功` → pages/ContextBenchmarkPage.tsx
- [x] `正在停止` → pages/ContextBenchmarkPage.tsx
- [x] `正在执行首个档位，完成后逐项显示结果。` → pages/ContextBenchmarkPage.tsx
- [x] `正在核验服务` → pages/ScenarioBenchmarkPage.tsx
- [x] `正在核验服务与输入` → pages/ContextBenchmarkPage.tsx
- [x] `正在读取模型上下文…` → pages/ContextBenchmarkPage.tsx
- [x] `此历史记录未保存测量身份，可以查看测量值，无法据此判断升级提速。` → pages/ContextBenchmarkPage.tsx
- [x] `此报告来自旧版压力测试，仅供查看和导出；并发条件可在测试条件中查看。` → pages/ScenarioBenchmarkPage.tsx
- [x] `每个场景先预热一次` → pages/ScenarioBenchmarkPage.tsx
- [x] `每档轮数` → pages/ContextBenchmarkPage.tsx
- [x] `每次超时（秒）` → pages/ContextBenchmarkPage.tsx
- [x] `每轮最大输出 token` → pages/ScenarioBenchmarkPage.tsx
- [x] `每轮超时（秒）` → pages/ScenarioBenchmarkPage.tsx
- [x] `测试因请求错误结束，详情见测量结果。` → pages/ContextBenchmarkPage.tsx
- [x] `测试场景` → pages/ScenarioBenchmarkPage.tsx
- [x] `测试已停止，已完成的结果已保留。` → pages/ContextBenchmarkPage.tsx
- [x] `测试提示词` → pages/ScenarioBenchmarkPage.tsx
- [x] `测试文本` → pages/ContextBenchmarkPage.tsx
- [x] `测试条件` → pages/ScenarioBenchmarkPage.tsx
- [x] `测试结果` → pages/ScenarioBenchmarkPage.tsx
- [x] `测试计划` → pages/ContextBenchmarkPage.tsx, pages/ScenarioBenchmarkPage.tsx
- [x] `测试说明` → pages/ScenarioBenchmarkPage.tsx
- [x] `测试轮数` → pages/ScenarioBenchmarkPage.tsx
- [x] `测试配置` → pages/ContextBenchmarkPage.tsx
- [x] `测试配置名称` → pages/ContextBenchmarkPage.tsx
- [x] `测量身份与生效条件` → pages/ContextBenchmarkPage.tsx
- [x] `状态` → pages/ContextBenchmarkPage.tsx, pages/ScenarioBenchmarkPage.tsx
- [x] `生效配置` → pages/ContextBenchmarkPage.tsx
- [x] `生效配置已核验` → pages/ContextBenchmarkPage.tsx
- [x] `生效配置未核验` → pages/ContextBenchmarkPage.tsx
- [x] `用户停止` → pages/ScenarioBenchmarkPage.tsx
- [x] `硬件条件` → pages/ContextBenchmarkPage.tsx
- [x] `离开页面后测试继续运行。停止会取消请求并保留结果；引擎释放已在处理的请求可能需要时间。` → pages/ScenarioBenchmarkPage.tsx
- [x] `筛选场景` → pages/ScenarioBenchmarkPage.tsx
- [x] `系统内存使用` → pages/ScenarioBenchmarkPage.tsx
- [x] `结束` → pages/ScenarioBenchmarkPage.tsx
- [x] `缓存 token` → pages/ScenarioBenchmarkPage.tsx
- [x] `缓存命中` → pages/ScenarioBenchmarkPage.tsx
- [x] `解码` → pages/ContextBenchmarkPage.tsx
- [x] `解码 (tok/s)` → pages/ContextBenchmarkPage.tsx
- [x] `计划完成` → pages/ScenarioBenchmarkPage.tsx
- [x] `计划进度` → pages/ScenarioBenchmarkPage.tsx
- [x] `记录` → pages/ContextBenchmarkPage.tsx
- [x] `请先启用服务并等待模型就绪` → pages/ScenarioBenchmarkPage.tsx
- [x] `请先启用服务并等待模型就绪。` → pages/ContextBenchmarkPage.tsx
- [x] `请先选择模型` → pages/ContextBenchmarkPage.tsx, pages/ScenarioBenchmarkPage.tsx
- [x] `请求` → pages/ScenarioBenchmarkPage.tsx
- [x] `请求样本` → pages/ScenarioBenchmarkPage.tsx
- [x] `请求耗时 (s)` → pages/ContextBenchmarkPage.tsx
- [x] `请求超时或模型变化会停止整组测试。` → pages/ScenarioBenchmarkPage.tsx
- [x] `资源曲线是整机和 GPU 的总体观测，可能包含其他进程；缺少的指标不会推断。请求表只显示最近 100 条，JSON 和 CSV 可导出全部样本。` → pages/ScenarioBenchmarkPage.tsx
- [x] `资源趋势` → pages/ScenarioBenchmarkPage.tsx
- [x] `超出上限不可选` → pages/ContextBenchmarkPage.tsx
- [x] `超时` → pages/ScenarioBenchmarkPage.tsx
- [x] `轮次` → pages/ContextBenchmarkPage.tsx
- [x] `轮次 / 场景` → pages/ScenarioBenchmarkPage.tsx
- [x] `输入、缓存与测试协议` → pages/ContextBenchmarkPage.tsx
- [x] `输入模式` → pages/ScenarioBenchmarkPage.tsx
- [x] `达到持续时间` → pages/ScenarioBenchmarkPage.tsx
- [x] `达到请求预算` → pages/ScenarioBenchmarkPage.tsx
- [x] `达到输出上限` → pages/ScenarioBenchmarkPage.tsx
- [x] `运行时/模型身份` → pages/ContextBenchmarkPage.tsx
- [x] `运行时内容摘要` → pages/ContextBenchmarkPage.tsx
- [x] `连续对话轮数` → pages/ScenarioBenchmarkPage.tsx
- [x] `选择另一份历史记录` → pages/ContextBenchmarkPage.tsx
- [x] `选择档位并开始测试，结果会按此表逐项记录。` → pages/ContextBenchmarkPage.tsx
- [x] `逐档测试，单请求串行执行` → pages/ContextBenchmarkPage.tsx
- [x] `逐次测量` → pages/ContextBenchmarkPage.tsx
- [x] `重复输入 · 测试缓存` → pages/ScenarioBenchmarkPage.tsx
- [x] `错误分类` → pages/ScenarioBenchmarkPage.tsx
- [x] `长输入字符数` → pages/ScenarioBenchmarkPage.tsx
- [x] `长输入按真实字符数构造，不是 token 数；实际 token 用量由服务返回。变化输入减少前缀命中，缓存场景仍重复输入；模型和专家缓存可能保留。` → pages/ScenarioBenchmarkPage.tsx
- [x] `阶段` → pages/ScenarioBenchmarkPage.tsx
- [x] `预填充` → pages/ContextBenchmarkPage.tsx
- [x] `预填充 (tok/s)` → pages/ContextBenchmarkPage.tsx
- [x] `预热` → pages/ScenarioBenchmarkPage.tsx
- [x] `预热为每个所选场景各发送一个额外请求，不计入测量汇总。请求超时或模型变化会停止整组测试；其他错误是否停止由高级选项决定。` → pages/ScenarioBenchmarkPage.tsx
- [x] `首正文 (s)` → pages/ContextBenchmarkPage.tsx
- [x] `高级测试选项` → pages/ScenarioBenchmarkPage.tsx

**文案 zh ?**（8）

- [x] `Benchmark 类型` → pages/BenchmarkPage.tsx
- [x] `上下文档位` → pages/BenchmarkPage.tsx
- [x] `场景测试` → pages/BenchmarkPage.tsx
- [x] `已有性能测试正在运行，请先停止或等待完成。` → pages/ScenarioBenchmarkPage.tsx
- [x] `无法开始测速：应用正在执行其他操作，请稍后重试。` → pages/ScenarioBenchmarkPage.tsx
- [x] `无法开始测速：服务未启动或模型未就绪，请先启用并等待模型就绪。` → pages/ScenarioBenchmarkPage.tsx
- [x] `无法开始测速：测试历史尚未读取完成。` → pages/ScenarioBenchmarkPage.tsx
- [x] `无法开始测速：请先选择模型。` → pages/ScenarioBenchmarkPage.tsx

**交互处理器**（8）

- [x] `onBaseline` → pages/ScenarioBenchmarkPage.tsx
- [x] `onChange` → pages/ContextBenchmarkPage.tsx, pages/ScenarioBenchmarkPage.tsx
- [x] `onCheckedChange` → pages/ContextBenchmarkPage.tsx, pages/ScenarioBenchmarkPage.tsx
- [x] `onClick` → pages/ContextBenchmarkPage.tsx, pages/ScenarioBenchmarkPage.tsx, pages/BenchmarkComparisonPanel.tsx
- [x] `onClose` → pages/ContextBenchmarkPage.tsx, pages/ScenarioBenchmarkPage.tsx
- [x] `onReplay` → pages/ScenarioBenchmarkPage.tsx
- [x] `onRunningChange` → pages/BenchmarkPage.tsx
- [x] `onValueChange` → pages/BenchmarkPage.tsx, pages/ContextBenchmarkPage.tsx, pages/ScenarioBenchmarkPage.tsx, pages/BenchmarkComparisonPanel.tsx

**控件 / 状态组件**（10）

- [x] `Dialog` → pages/ScenarioBenchmarkPage.tsx
- [x] `Dropdown` → pages/ContextBenchmarkPage.tsx, pages/ScenarioBenchmarkPage.tsx, pages/BenchmarkComparisonPanel.tsx
- [x] `Empty` → pages/ContextBenchmarkPage.tsx, pages/ScenarioBenchmarkPage.tsx
- [x] `Field` → pages/ContextBenchmarkPage.tsx, pages/ScenarioBenchmarkPage.tsx
- [x] `NumberField` → pages/ContextBenchmarkPage.tsx, pages/ScenarioBenchmarkPage.tsx
- [x] `Segmented` → pages/BenchmarkPage.tsx
- [x] `Toggle` → pages/ContextBenchmarkPage.tsx, pages/ScenarioBenchmarkPage.tsx
- [x] `details` → pages/ContextBenchmarkPage.tsx, pages/ScenarioBenchmarkPage.tsx
- [x] `input` → pages/ContextBenchmarkPage.tsx
- [x] `textarea` → pages/ScenarioBenchmarkPage.tsx

**状态角色 (alert/status/log)**（2）

- [x] `alert` → pages/ContextBenchmarkPage.tsx, pages/ScenarioBenchmarkPage.tsx
- [x] `status` → pages/ContextBenchmarkPage.tsx, pages/ScenarioBenchmarkPage.tsx, pages/BenchmarkComparisonPanel.tsx

### 公共设置 (settings)

**文案 zh ?**（12）

- [x] `zh-CN` → pages/DesktopLifecycleSettings.tsx
- [x] `先关闭“保持模型就绪”` → pages/DesktopLifecycleSettings.tsx
- [x] `可用更新日志` → pages/DesktopLifecycleSettings.tsx
- [x] `应用更新帮助` → pages/DesktopLifecycleSettings.tsx
- [x] `当前版本` → pages/DesktopLifecycleSettings.tsx
- [x] `当前版本的更新日志未包含在此安装包中。` → pages/DesktopLifecycleSettings.tsx
- [x] `更新失败原因` → pages/DesktopLifecycleSettings.tsx
- [x] `最近一次更新日志` → pages/DesktopLifecycleSettings.tsx
- [x] `有更新` → pages/DesktopLifecycleSettings.tsx
- [x] `本机后台帮助` → pages/DesktopLifecycleSettings.tsx
- [x] `查看原因` → pages/DesktopLifecycleSettings.tsx
- [x] `此版本尚未提供更新日志。` → pages/DesktopLifecycleSettings.tsx

**i18n key t()**（35）

- [x] `appUpdates` → pages/DesktopLifecycleSettings.tsx
- [x] `appearance` → App.tsx
- [x] `backendRepair` → pages/DesktopLifecycleSettings.tsx
- [x] `backendUpdatePending` → pages/DesktopLifecycleSettings.tsx
- [x] `backendVersion` → pages/DesktopLifecycleSettings.tsx
- [x] `backgroundSettings` → pages/DesktopLifecycleSettings.tsx
- [x] `behavior` → App.tsx
- [x] `checkUpdates` → pages/DesktopLifecycleSettings.tsx
- [x] `checkUpdatesAutomatically` → pages/DesktopLifecycleSettings.tsx
- [x] `checkUpdatesAutomaticallyHint` → pages/DesktopLifecycleSettings.tsx
- [x] `closeToTray` → App.tsx
- [x] `closeToTrayHint` → App.tsx
- [x] `idleModelRelease` → pages/DesktopLifecycleSettings.tsx
- [x] `idleModelReleaseHint` → pages/DesktopLifecycleSettings.tsx
- [x] `idleModelReleaseMinutes` → pages/DesktopLifecycleSettings.tsx
- [x] `idleModelReleaseOff` → pages/DesktopLifecycleSettings.tsx
- [x] `idleModelReleaseUpdate` → pages/DesktopLifecycleSettings.tsx
- [x] `language` → App.tsx
- [x] `launchOnLogin` → pages/DesktopLifecycleSettings.tsx
- [x] `launchOnLoginHint` → pages/DesktopLifecycleSettings.tsx
- [x] `migrationNeedsAttention` → pages/DesktopLifecycleSettings.tsx
- [x] `nativeRequired` → pages/DesktopLifecycleSettings.tsx
- [x] `prepareAtStartup` → pages/DesktopLifecycleSettings.tsx
- [x] `prepareAtStartupHint` → pages/DesktopLifecycleSettings.tsx
- [x] `recoverService` → pages/DesktopLifecycleSettings.tsx
- [x] `recoverServiceHint` → pages/DesktopLifecycleSettings.tsx
- [x] `restartForUpdate` → pages/DesktopLifecycleSettings.tsx
- [x] `reviewAppUpdate` → pages/DesktopLifecycleSettings.tsx
- [x] `reviewDownloadedUpdate` → pages/DesktopLifecycleSettings.tsx
- [x] `settings` → App.tsx
- [x] `settingsUnavailable` → pages/DesktopLifecycleSettings.tsx
- [x] `systemLanguage` → App.tsx
- [x] `theme` → App.tsx
- [x] `translationFallbackHint` → App.tsx
- [x] `updaterHint` → pages/DesktopLifecycleSettings.tsx

**交互处理器**（9）

- [x] `onAutoCheck` → App.tsx
- [x] `onCheck` → App.tsx
- [x] `onCheckedChange` → pages/DesktopLifecycleSettings.tsx, App.tsx
- [x] `onClick` → pages/DesktopLifecycleSettings.tsx
- [x] `onClose` → pages/DesktopLifecycleSettings.tsx
- [x] `onDownload` → App.tsx
- [x] `onError` → App.tsx
- [x] `onInstall` → App.tsx
- [x] `onValueChange` → pages/DesktopLifecycleSettings.tsx, App.tsx

**控件 / 状态组件**（5）

- [x] `Dialog` → pages/DesktopLifecycleSettings.tsx
- [x] `Dropdown` → pages/DesktopLifecycleSettings.tsx, App.tsx
- [x] `Field` → App.tsx
- [x] `Segmented` → App.tsx
- [x] `Toggle` → pages/DesktopLifecycleSettings.tsx, App.tsx

**状态角色 (alert/status/log)**（2）

- [x] `alert` → pages/DesktopLifecycleSettings.tsx
- [x] `status` → pages/DesktopLifecycleSettings.tsx

### API 与外部助手 (connections)

**文案 zh ?**（113）

- [x] `API Key 已保存。` → ServiceConnectionPanel.tsx
- [x] `API Key 已移除。` → ServiceConnectionPanel.tsx
- [x] `MCP 客户端` → McpIntegrationPanel.tsx
- [x] `个工具` → McpIntegrationPanel.tsx
- [x] `交接前先停止模型、完成安装，并断开助手连接。切换本身不会启停模型。` → McpIntegrationPanel.tsx
- [x] `交给外部助手独立管理` → McpIntegrationPanel.tsx
- [x] `仅本机 · 127.0.0.1` → ServiceSharingPanel.tsx
- [x] `以下更改将在同一次配置写入中保存，并保留原配置备份。` → ServiceSharingPanel.tsx
- [x] `保存中…` → ServiceConnectionPanel.tsx, ServiceSharingPanel.tsx
- [x] `保存密钥` → ServiceConnectionPanel.tsx
- [x] `保存配置` → ServiceSharingPanel.tsx
- [x] `保持本应用管理，无需停止模型或切换管理权即可接入。` → McpIntegrationPanel.tsx
- [x] `保留` → ServiceSharingPanel.tsx
- [x] `允许同一局域网的设备调用本机 API。保存只修改受管配置并保留备份，不启动模型、不改防火墙。服务端密钥保护共享 API，与上方客户端密钥分别管理。` → ServiceSharingPanel.tsx
- [x] `共享端口` → ServiceSharingPanel.tsx
- [x] `共享设置不可用。` → ServiceSharingPanel.tsx
- [x] `刷新状态` → McpIntegrationPanel.tsx
- [x] `助手直接控制 Strata，需先交接管理权。` → McpIntegrationPanel.tsx
- [x] `助手通过本应用后台执行操作，可继续使用本应用。` → McpIntegrationPanel.tsx
- [x] `取消草稿` → ServiceSharingPanel.tsx
- [x] `可修改` → McpIntegrationPanel.tsx
- [x] `复制地址` → ServiceSharingPanel.tsx
- [x] `复制失败，请在文本框中选择并复制。` → McpIntegrationPanel.tsx
- [x] `复制失败，请手动选择地址。` → ServiceSharingPanel.tsx
- [x] `复制接入配置` → McpIntegrationPanel.tsx
- [x] `复制调用示例` → ServiceSharingPanel.tsx
- [x] `外部助手 MCP 接入` → McpIntegrationPanel.tsx
- [x] `外部助手接入帮助` → McpIntegrationPanel.tsx
- [x] `外部助手接入说明` → McpIntegrationPanel.tsx
- [x] `外部独立接管` → McpIntegrationPanel.tsx
- [x] `外部独立接管使用 Strata 官方 MCP，由助手直接控制服务。本应用暂停同一安装目录内的启动、自动加载和恢复。选择模式不会自动交接，切换管理权本身也不会启停模型。` → McpIntegrationPanel.tsx
- [x] `官方 MCP 的安装目录与当前档案不一致，请重新检查。` → McpIntegrationPanel.tsx
- [x] `客户端地址` → ServiceSharingPanel.tsx
- [x] `客户端密钥不会随这次保存而改变。` → ServiceSharingPanel.tsx
- [x] `密钥不会回显。` → ServiceConnectionPanel.tsx
- [x] `局域网共享` → ServiceSharingPanel.tsx
- [x] `局域网共享与服务端鉴权` → ServiceSharingPanel.tsx
- [x] `局域网共享需要服务端密钥。请填写新密钥，或保留现有密钥。` → ServiceSharingPanel.tsx
- [x] `局域网设置需要桌面应用。` → ServiceSharingPanel.tsx
- [x] `已保存；输入以替换` → ServiceConnectionPanel.tsx
- [x] `已复制` → McpIntegrationPanel.tsx
- [x] `已复制。` → ServiceSharingPanel.tsx
- [x] `已提供的工具` → McpIntegrationPanel.tsx
- [x] `已请求重启。请等待模型就绪，再从另一台设备测试；跨设备连接尚未验证。` → ServiceSharingPanel.tsx
- [x] `应用客户端密钥没有改变，请在上方另行更新。` → ServiceSharingPanel.tsx
- [x] `当前安装目录已由外部助手接管。先停止模型、完成安装并断开助手连接，再恢复本应用管理后检查连接。` → McpIntegrationPanel.tsx
- [x] `当前服务保持未启动，下次手动启动时生效。` → ServiceSharingPanel.tsx
- [x] `当前服务将继续运行，保存后仍需单独点击重启。` → ServiceSharingPanel.tsx
- [x] `当前服务未启动或不属于本应用，未重启。` → ServiceSharingPanel.tsx
- [x] `当前服务能力` → ServiceCapabilityPanel.tsx
- [x] `恢复本应用管理` → McpIntegrationPanel.tsx
- [x] `所有 IPv4 接口 · 0.0.0.0` → ServiceSharingPanel.tsx
- [x] `把配置添加到助手的 MCP 设置中，保留已有条目。` → McpIntegrationPanel.tsx
- [x] `接入帮助` → McpIntegrationPanel.tsx
- [x] `接入操作未完成。` → McpIntegrationPanel.tsx
- [x] `接入模式` → McpIntegrationPanel.tsx
- [x] `推荐模式下，助手和本应用通过同一后台管理模型，启动、停止、安装等操作使用统一的锁和任务记录。检查连接只读取连接信息和工具清单，不启停模型。` → McpIntegrationPanel.tsx
- [x] `新密钥需为非空文本，不能包含换行或控制字符。` → ServiceSharingPanel.tsx
- [x] `新的服务端密钥` → ServiceSharingPanel.tsx
- [x] `无密钥 MCP 客户端配置` → McpIntegrationPanel.tsx
- [x] `无密钥时留空` → ServiceConnectionPanel.tsx
- [x] `替换为单个新密钥（不回显）` → ServiceSharingPanel.tsx
- [x] `服务或引擎身份已改变，旧结果已失效。请重新核验。` → ServiceCapabilityPanel.tsx
- [x] `服务未启动或未就绪。` → ServiceCapabilityPanel.tsx
- [x] `服务端密钥操作` → ServiceSharingPanel.tsx
- [x] `服务端鉴权` → ServiceSharingPanel.tsx
- [x] `服务连接与 API Key` → ServiceConnectionPanel.tsx
- [x] `未检测到与监听设置匹配的本机局域网地址。` → ServiceSharingPanel.tsx
- [x] `查看诊断` → McpIntegrationPanel.tsx
- [x] `核验中…` → ServiceCapabilityPanel.tsx
- [x] `核验服务能力` → ServiceCapabilityPanel.tsx
- [x] `检查连接` → McpIntegrationPanel.tsx
- [x] `正在切换…` → McpIntegrationPanel.tsx
- [x] `正在检查…` → McpIntegrationPanel.tsx
- [x] `正在读取共享设置…` → ServiceSharingPanel.tsx
- [x] `正在读取管理方式…` → McpIntegrationPanel.tsx
- [x] `浏览器预览中的密钥仅在当前会话保留。` → ServiceConnectionPanel.tsx
- [x] `添加模型后，可在这里统一管理连接信息。` → ServiceConnectionPanel.tsx
- [x] `点击核验只读取元数据；停止、切换或加载状态改变后需重新核验。保存配置不代表已经生效。` → ServiceCapabilityPanel.tsx
- [x] `版本未知` → ServiceCapabilityPanel.tsx
- [x] `独立接管时，本应用暂停同一安装目录内所有模型的启动、自动加载和恢复。` → McpIntegrationPanel.tsx
- [x] `由外部助手管理` → McpIntegrationPanel.tsx
- [x] `由本应用管理` → McpIntegrationPanel.tsx
- [x] `监听地址` → ServiceSharingPanel.tsx
- [x] `监听范围` → ServiceSharingPanel.tsx
- [x] `确认局域网设置变更` → ServiceSharingPanel.tsx
- [x] `示例使用 STRATA_API_KEY 环境变量占位；请在客户端自行填写服务端密钥。地址来自本机网卡，跨设备连通性需实际验证。` → ServiceSharingPanel.tsx
- [x] `移除密钥` → ServiceConnectionPanel.tsx
- [x] `移除服务端鉴权` → ServiceSharingPanel.tsx
- [x] `移除鉴权` → ServiceSharingPanel.tsx
- [x] `端口` → ServiceSharingPanel.tsx
- [x] `端口需为 1–65535 的整数。` → ServiceSharingPanel.tsx
- [x] `让 Codex、Cursor 等助手查看状态并管理模型。` → McpIntegrationPanel.tsx
- [x] `设置单个新密钥` → ServiceSharingPanel.tsx
- [x] `诊断` → McpIntegrationPanel.tsx
- [x] `请先导入本机模型配置；未受管的服务不可在这里修改。` → ServiceSharingPanel.tsx
- [x] `请先预览并保存局域网设置，或取消该草稿，再切换服务。` → ServiceConnectionPanel.tsx
- [x] `返回编辑` → ServiceSharingPanel.tsx
- [x] `连接信息与当前模型档案不一致，请重新检查。` → McpIntegrationPanel.tsx
- [x] `连接信息属于上方所选服务。切换目标不会启动模型，密钥仍分别保存在系统凭据库。这里保存的是应用访问服务的密钥，不会修改服务端鉴权。` → ServiceConnectionPanel.tsx
- [x] `连接可用` → McpIntegrationPanel.tsx
- [x] `连接外部助手` → McpIntegrationPanel.tsx
- [x] `退出助手不会停止本应用后台或模型。后台未运行时，请先启动本应用，再重新连接助手。` → McpIntegrationPanel.tsx
- [x] `选择助手` → McpIntegrationPanel.tsx
- [x] `选择模式只改变展示；检查连接后，仍需手动交接才能复制独立接管配置。` → McpIntegrationPanel.tsx
- [x] `通过本应用管理（推荐）` → McpIntegrationPanel.tsx
- [x] `配置不含 API Key。安装操作需要工具中的明确确认；将配置添加到助手的 MCP 设置时保留已有条目。` → McpIntegrationPanel.tsx
- [x] `配置已备份并保存。当前服务仍使用原设置；点击“重启使共享生效”才会重启。` → ServiceSharingPanel.tsx
- [x] `配置已备份并保存。服务保持未启动，下次手动启动时生效。` → ServiceSharingPanel.tsx
- [x] `配置已被其它操作修改，草稿已保留。请重新读取后预览并保存。` → ServiceSharingPanel.tsx
- [x] `重启使共享生效` → ServiceSharingPanel.tsx
- [x] `重新读取` → ServiceSharingPanel.tsx
- [x] `预览变更` → ServiceSharingPanel.tsx

**文案 ==='zh-CN'**（6）

- [x] `API 与外部助手` → App.tsx
- [x] `API 密钥与 MCP 配置明确绑定所选服务。` → App.tsx
- [x] `在这里统一配置服务接入。选择目标不会启动或切换正在运行的模型。` → App.tsx
- [x] `接入 API` → App.tsx
- [x] `目标服务` → App.tsx
- [x] `连接目标` → App.tsx

**无障碍标签**（1）

- [x] `API Key` → ServiceConnectionPanel.tsx

**交互处理器**（11）

- [x] `onChange` → ServiceConnectionPanel.tsx, McpIntegrationPanel.tsx, ServiceSharingPanel.tsx
- [x] `onClick` → ServiceConnectionPanel.tsx, ServiceCapabilityPanel.tsx, McpIntegrationPanel.tsx, ServiceSharingPanel.tsx, App.tsx
- [x] `onClose` → McpIntegrationPanel.tsx, ServiceSharingPanel.tsx, App.tsx
- [x] `onCopy` → App.tsx
- [x] `onDirtyChange` → ServiceConnectionPanel.tsx, App.tsx
- [x] `onError` → App.tsx
- [x] `onOwnershipChange` → App.tsx
- [x] `onSaveDraftReady` → App.tsx
- [x] `onSaved` → ServiceConnectionPanel.tsx, App.tsx
- [x] `onSubmit` → ServiceConnectionPanel.tsx
- [x] `onValueChange` → McpIntegrationPanel.tsx, ServiceSharingPanel.tsx, App.tsx

**控件 / 状态组件**（8）

- [x] `Dialog` → McpIntegrationPanel.tsx, ServiceSharingPanel.tsx
- [x] `Dropdown` → McpIntegrationPanel.tsx, ServiceSharingPanel.tsx, App.tsx
- [x] `Field` → App.tsx
- [x] `Radio` → McpIntegrationPanel.tsx
- [x] `Segmented` → ServiceSharingPanel.tsx
- [x] `details` → ServiceCapabilityPanel.tsx
- [x] `input` → ServiceConnectionPanel.tsx, ServiceSharingPanel.tsx
- [x] `textarea` → McpIntegrationPanel.tsx

**状态角色 (alert/status/log)**（2）

- [x] `alert` → ServiceConnectionPanel.tsx, ServiceCapabilityPanel.tsx, McpIntegrationPanel.tsx, ServiceSharingPanel.tsx
- [x] `status` → ServiceConnectionPanel.tsx, ServiceCapabilityPanel.tsx, McpIntegrationPanel.tsx, ServiceSharingPanel.tsx

### 显存与会话 (runtime-tools)

**文案 ==='zh-CN'**（6）

- [x] `先在我的模型中启用一个模型。` → App.tsx
- [x] `尚未选择模型` → App.tsx
- [x] `工具作用于当前模型，执行结果和会话存档随模型区分。` → App.tsx
- [x] `当前服务已连接` → App.tsx
- [x] `当前服务未启动或尚未连接` → App.tsx
- [x] `显存与会话` → App.tsx

**i18n key t()**（1）

- [x] `myModels` → App.tsx

**交互处理器**（5）

- [x] `onChange` → RuntimeOperationsPanel.tsx
- [x] `onClick` → RuntimeOperationsPanel.tsx, App.tsx
- [x] `onClose` → RuntimeOperationsPanel.tsx
- [x] `onError` → App.tsx
- [x] `onMessage` → App.tsx

**控件 / 状态组件**（3）

- [x] `Dialog` → RuntimeOperationsPanel.tsx
- [x] `NumberField` → RuntimeOperationsPanel.tsx
- [x] `input` → RuntimeOperationsPanel.tsx

**状态角色 (alert/status/log)**（1）

- [x] `alert` → RuntimeOperationsPanel.tsx

### 应用更新 (updates)

**文案 zh ?**（12）

- [x] `zh-CN` → pages/DesktopLifecycleSettings.tsx
- [x] `先关闭“保持模型就绪”` → pages/DesktopLifecycleSettings.tsx
- [x] `可用更新日志` → pages/DesktopLifecycleSettings.tsx
- [x] `应用更新帮助` → pages/DesktopLifecycleSettings.tsx
- [x] `当前版本` → pages/DesktopLifecycleSettings.tsx
- [x] `当前版本的更新日志未包含在此安装包中。` → pages/DesktopLifecycleSettings.tsx
- [x] `更新失败原因` → pages/DesktopLifecycleSettings.tsx
- [x] `最近一次更新日志` → pages/DesktopLifecycleSettings.tsx
- [x] `有更新` → pages/DesktopLifecycleSettings.tsx
- [x] `本机后台帮助` → pages/DesktopLifecycleSettings.tsx
- [x] `查看原因` → pages/DesktopLifecycleSettings.tsx
- [x] `此版本尚未提供更新日志。` → pages/DesktopLifecycleSettings.tsx

**i18n key t()**（26）

- [x] `appUpdates` → pages/DesktopLifecycleSettings.tsx, App.tsx
- [x] `backendRepair` → pages/DesktopLifecycleSettings.tsx
- [x] `backendUpdatePending` → pages/DesktopLifecycleSettings.tsx
- [x] `backendVersion` → pages/DesktopLifecycleSettings.tsx
- [x] `backgroundSettings` → pages/DesktopLifecycleSettings.tsx
- [x] `checkUpdates` → pages/DesktopLifecycleSettings.tsx
- [x] `checkUpdatesAutomatically` → pages/DesktopLifecycleSettings.tsx
- [x] `checkUpdatesAutomaticallyHint` → pages/DesktopLifecycleSettings.tsx
- [x] `idleModelRelease` → pages/DesktopLifecycleSettings.tsx
- [x] `idleModelReleaseHint` → pages/DesktopLifecycleSettings.tsx
- [x] `idleModelReleaseMinutes` → pages/DesktopLifecycleSettings.tsx
- [x] `idleModelReleaseOff` → pages/DesktopLifecycleSettings.tsx
- [x] `idleModelReleaseUpdate` → pages/DesktopLifecycleSettings.tsx
- [x] `launchOnLogin` → pages/DesktopLifecycleSettings.tsx
- [x] `launchOnLoginHint` → pages/DesktopLifecycleSettings.tsx
- [x] `migrationNeedsAttention` → pages/DesktopLifecycleSettings.tsx
- [x] `nativeRequired` → pages/DesktopLifecycleSettings.tsx
- [x] `prepareAtStartup` → pages/DesktopLifecycleSettings.tsx
- [x] `prepareAtStartupHint` → pages/DesktopLifecycleSettings.tsx
- [x] `recoverService` → pages/DesktopLifecycleSettings.tsx
- [x] `recoverServiceHint` → pages/DesktopLifecycleSettings.tsx
- [x] `restartForUpdate` → pages/DesktopLifecycleSettings.tsx
- [x] `reviewAppUpdate` → pages/DesktopLifecycleSettings.tsx
- [x] `reviewDownloadedUpdate` → pages/DesktopLifecycleSettings.tsx
- [x] `settingsUnavailable` → pages/DesktopLifecycleSettings.tsx
- [x] `updaterHint` → pages/DesktopLifecycleSettings.tsx

**交互处理器**（9）

- [x] `onAutoCheck` → App.tsx
- [x] `onCheck` → App.tsx
- [x] `onCheckedChange` → pages/DesktopLifecycleSettings.tsx
- [x] `onClick` → pages/DesktopLifecycleSettings.tsx
- [x] `onClose` → pages/DesktopLifecycleSettings.tsx
- [x] `onDownload` → App.tsx
- [x] `onError` → App.tsx
- [x] `onInstall` → App.tsx
- [x] `onValueChange` → pages/DesktopLifecycleSettings.tsx

**控件 / 状态组件**（3）

- [x] `Dialog` → pages/DesktopLifecycleSettings.tsx
- [x] `Dropdown` → pages/DesktopLifecycleSettings.tsx
- [x] `Toggle` → pages/DesktopLifecycleSettings.tsx

**状态角色 (alert/status/log)**（2）

- [x] `alert` → pages/DesktopLifecycleSettings.tsx
- [x] `status` → pages/DesktopLifecycleSettings.tsx

### 关于 (about)

**文案 ==='zh-CN'**（2）

- [x] `未报告版本` → OfficialAbout.tsx
- [x] `未知` → OfficialAbout.tsx

**i18n key t()**（41）

- [x] `aboutConfigHint` → OfficialAbout.tsx
- [x] `aboutCpu` → OfficialAbout.tsx
- [x] `aboutDefaultsHint` → OfficialAbout.tsx
- [x] `aboutGpu` → OfficialAbout.tsx
- [x] `aboutHint` → OfficialAbout.tsx
- [x] `aboutImages` → OfficialAbout.tsx
- [x] `aboutManagerSource` → OfficialAbout.tsx
- [x] `aboutPreferences` → OfficialAbout.tsx
- [x] `aboutProjectHint` → OfficialAbout.tsx
- [x] `aboutRam` → OfficialAbout.tsx
- [x] `aboutUpstreamSource` → OfficialAbout.tsx
- [x] `allInVram` → OfficialAbout.tsx
- [x] `anthropicBase` → OfficialAbout.tsx
- [x] `appVersion` → OfficialAbout.tsx
- [x] `configuration` → OfficialAbout.tsx
- [x] `connectTools` → OfficialAbout.tsx
- [x] `connectToolsHint` → OfficialAbout.tsx
- [x] `context` → OfficialAbout.tsx
- [x] `engine` → OfficialAbout.tsx
- [x] `esp` → OfficialAbout.tsx
- [x] `expertsInVram` → OfficialAbout.tsx
- [x] `kv16` → OfficialAbout.tsx
- [x] `kv4` → OfficialAbout.tsx
- [x] `kv8` → OfficialAbout.tsx
- [x] `kvCache` → OfficialAbout.tsx
- [x] `layerDirection` → OfficialAbout.tsx
- [x] `localEngine` → OfficialAbout.tsx
- [x] `lookupOn` → OfficialAbout.tsx
- [x] `model` → OfficialAbout.tsx
- [x] `modelName` → OfficialAbout.tsx
- [x] `mtpDrafts` → OfficialAbout.tsx
- [x] `nvmlUnavailable` → OfficialAbout.tsx
- [x] `openAiBase` → OfficialAbout.tsx
- [x] `projectionDescription` → OfficialAbout.tsx
- [x] `settings` → OfficialAbout.tsx
- [x] `speculation` → OfficialAbout.tsx
- [x] `streamedKv` → OfficialAbout.tsx
- [x] `thirdPartyLicenses` → OfficialAbout.tsx
- [x] `thisPc` → OfficialAbout.tsx
- [x] `threadsCount` → OfficialAbout.tsx
- [x] `tokensUnit` → OfficialAbout.tsx

**交互处理器**（5）

- [x] `onClick` → OfficialAbout.tsx
- [x] `onCopy` → OfficialAbout.tsx, App.tsx
- [x] `onError` → App.tsx
- [x] `onOpenConfig` → App.tsx
- [x] `onOpenSettings` → App.tsx

**控件 / 状态组件**（1）

- [x] `details` → OfficialAbout.tsx
