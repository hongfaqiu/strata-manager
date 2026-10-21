# 开发接口约定

## 2026-10-13 日常体验增量（源码，待发行）

新增 `assess_setup_resources({request})`、`service_sharing_status({profile})`、`benchmark_identity({profile})` 和具名变更 `set_service_auth({profile,request})`，Core 对应 `assessSetupResources`、`serviceSharingStatus`、`benchmarkIdentity`、`setServiceAuth`。类型与范围见 [增量接口](DAILY_EXPERIENCE.md#interfaces-and-compatibility)。共享保存复用归属/空闲/CAS及备份，不重启、不回显密钥；客户端凭据不再注入服务端环境。

`SupervisorStatus.startupFailures`、`ChatMessage.execution` 和报告身份可选，旧后台/旧历史保留未知。场景报告 schema 3 保留 schema 2 读取；上下文 schema 3 新增可选身份与首正文时间。诊断导出保留分类元数据，不带错误正文或日志片段。

0.1.4 工作区更新草稿，核对日期为 2026-10-12；正式文档和活动代码未修改。本契约说明当前实现，不代替最终源码、安装包或实机验收。基础类型在 `packages/core/src/types.ts`；聊天、调优、运行时、安装及统计类型分别位于同目录对应模块，UI 从 `@strata-manager/core` 导入。

## 三层调用关系

前端调用 Tauri invoke 时，命令名为 snake_case，参数对象为 camelCase。下文返回类型以 Core 的 JS 契约为准；Rust 的 JSON 空值对应被 JS 忽略的 void 结果。大多数 Tauri 命令经 `SupervisorClient.request` 转发到独立 Supervisor；少数文件操作、流式 HTTP 和窗口操作在桌面进程执行。Tauri 命令名与后台 RPC 名不必相同。Core 通过 normalizeError 统一拒绝结果；部分 Tauri 命令把后台 `{code,message,retriable}` 序列化为错误字符串，调用方不应只按原始字符串匹配全部错误。

`SupervisorClient.request` 会核验并连接兼容后台，必要时执行受控包交接。变更请求遇到结果不明确的传输失败不自动重发；调用方查询持久任务或状态确认结果。只读 ZIP 来源测试与包匹配例外：直接调用当前后台，不经自动启动或包交接，具体规则见后文。

## Rust invoke：状态、凭据与 HTTP

- `store_get({key}) -> JSON|null`、`store_set({key,value}) -> void`：SQLite JSON KV。保留旧状态键；公共参数使用 `commonChatDefaults`、`chatDefaultsInheritance`、`chatOptionsByProfile`，下载偏好使用 `runtimeDownloadPreferences`。
- `set_api_key({profileId,apiKey}) -> void`、`has_api_key({profileId}) -> bool`：系统凭据库；空密钥移除凭据，不读取秘密回前端，也不修改 Strata 服务端鉴权。
- `strata_request({profile,path,method,body?}) -> JSON`：profile 为 `ServiceProfile`，path 为 Strata 相对 API 路径；经后台的登记与归属校验。
- `strata_stream({profile,path,body,requestId,onEvent}) -> void`：Tauri `Channel<StreamEvent>`。data 为可拼接 SSE 字符串，error 的 data 为错误信息。流式 HTTP 在桌面进程；后台通过内部 `resolve_profile` 授权已登记、活体受管服务。
- `cancel_stream({requestId}) -> void`：取消桌面流式请求。Core `streamChat` 生成 UUID 并绑定 AbortSignal，当前固定请求 `/v1/chat/completions`。
- `environment_info() -> EnvironmentInfo`、`apply_settings({settings}) -> void`：本机环境与窗口退出等设置。
- `analytics_query({query?}) -> ApiAnalyticsResult`：空对象为默认查询。`query.action` 支持 `summary`、`recent`、`trends`、`requests`、`request_options`、`export_csv`；分页、筛选、快照及导出字段见 `analytics-types.ts`。CSV 从后台统计元数据生成；`path` 来自显式保存目标。
- `request_capture_status({profileId}) -> RequestCaptureStatus`、`request_capture_set({profileId,minutes}) -> RequestCaptureStatus`：正文捕获的独立状态与临时开关；minutes 为 `0|5|15|30`，0 关闭。日常统计不要求开启正文捕获。

普通原生 HTTP 请求超时 90 秒；`/load`、`/v1/load`、`/v1/vram`、`/slots/0?action=save`、`/slots/0?action=restore` 为 300 秒。不得把这些控制请求超时理解为聊天流或 Benchmark 的统一超时。

## Rust invoke：服务与本机登记

- `start_service({profile}) -> ProcessStatus`、`stop_service({profileId}) -> ProcessStatus`、`service_status({profileId,profile?}) -> ProcessStatus`。可选 profile 用于本机外部进程只读核验，不登记进程清理归属。
- `restart_service({profile}) -> ProcessStatus`：仅重启应用管理的进程。
- `take_over_service({profile}) -> ProcessStatus`：明确接管后重新核验外部身份和空闲状态，结束核验通过的进程树并以受管进程启动；失败不结束未核验的源实例。
- `ensure_local_service({profileId}) -> ProcessStatus`：准备已登记模型。`switch_local_service({profileId}) -> ProcessStatus` 串行切换，检查活动请求并在失败时恢复原选择与服务。
- `local_installations() -> ServiceProfile[]`：桌面列表的权威来源。首次迁移旧版有效档案，保留 ID、名称、选中状态、密钥关联和会话；延迟恢复模式不因读取登记自动恢复服务。
- `local_installation_details() -> LocalInstallationDetails[]`：配置显示快照、原配置路径、修改时间及成功显式启用的 `lastActivatedAt`。Tauri 从 SQLite 激活记录补充时间；旧后台不支持详情 RPC 时使用只读兼容读取。未知或旧记录的激活时间为空。
- `local_installation_migration() -> LocalInstallationMigration`：逐项迁移结果；只核验和登记，不启停服务或下载权重。
- `discover_local({directories?}) -> LocalCandidate[]`：只读检测。`import_local({candidate}) -> ServiceProfile` 重新核验后保存应用专用配置快照，保留源配置和模型文件。
- `rename_local_installation({profileId,name}) -> ServiceProfile`：只改名称。`remove_local_installation({profileId}) -> void` 只移除登记，拒绝移除运行中的受管服务，不删除安装或模型文件。
- `supervisor_status() -> SupervisorStatus`：后台版本、包身份、进程、恢复状态、迁移、能力和 `preparationFailures`。准备失败按档案保存 `{profileId,lastError,failedAt,retryable,phase:'prepare'}`，成功重试后清除。
- `shutdown_supervisor() -> void`：明确停止后台；Supervisor 完成 `prepare_shutdown` 检查后响应 `{stopped:true}` 并退出，Core 忽略响应内容。不能用停止后台代替仅关闭或重启界面。

原生修改请求和聊天流须对应权威登记与活体受管进程，前端路径本身不授予权限。端口监听不等于受管归属。接管核验配置、PID、创建时间、监听端口与空闲状态；Windows 对既有嵌套 Job 的已核验支树分别捕获，保留原 Job 中无关进程。

## Rust invoke：模型准备与任务

- `setup_disk_preflight({profile,model,quant,images}) -> SetupDiskPreflight`：模型下载、复用和准备空间的只读计划。
- `run_setup({profile,model,quant,context,images,options?}) -> TaskStatus`：官方非交互模型准备任务。options 为 `OfficialSetupOptions`；后台按 `SetupOptions` 验证，不接受任意命令字符串。返回 task ID，日志由任务页读取。
- `inspect_gguf({request}) -> TaskStatus`：模型文件检查任务；request 为 `ModelInspectRequest`，Core 名为 `inspectModel`。
- `install_runtime({directory}) -> TaskStatus`：官方运行环境准备；拒绝覆盖未知非空目录，只有本应用数据库与目录标记均匹配的失败安装允许重试，保留旧半成品，不自动下载模型权重。
- `managed_python_status() -> ManagedPythonStatus`、`install_managed_python({source?}) -> TaskStatus`：macOS / glibc Linux 的应用内 Python（python-build-standalone 20261009 · CPython 3.12.15）。只读状态含 `supported/installed/interpreter/downloadBytes/task`；安装任务按固定的官方长度与 SHA-256 校验（`source` 只能是含 `{url}` 的 HTTPS GitHub 代理模板或完整 HTTPS 地址，不改变摘要），逐项检查解包条目后原子移入 `toolchains/`，可用 `cancel_task` 取消。安装后 `install_runtime` 与 `environment_info` 优先使用它（`pythonManaged: true`）；不改 PATH、系统或 Homebrew Python。Windows 仍由 `install_runtime` 下载 python.org 安装器。
- `prepare_local_runtime() -> TaskStatus`、`local_runtime_installation() -> RuntimeInstallationStatus`：创建源码和私有 Python 环境的后台任务，以及恢复任务 ID/经过核验的结果，不下载模型权重。
- `storage_locations(installDir?, probePath?) -> StorageLocations`、`set_engine_install_root(directory | null) -> StorageLocation`、`set_model_data_directory(directory, installDir?, moveFiles) -> { directory, moving, taskId? }`：查看并更改模型保存位置（上游 `settings.json` 的 `data_dir`）和新引擎安装位置。`moveFiles` 时创建 `move-model-data` 任务：复制 → SHA-256 核对 → 改写运行配置中的路径 → 写入设置 → 删除旧文件；任一步失败都恢复配置和设置并保留旧文件。移动期间与运行时更新共用同一把锁，模型不能启动。旧版后台不认识这些方法时返回 `unknown_method`，界面提示重启应用。
- `update_runtime({profile}) -> TaskStatus`：官方运行时更新流程，禁止盲目覆盖配置；ZIP 更新是后文的独立入口。
- `list_tasks() -> TaskStatus[]`、`cancel_task({taskId}) -> void`：含桌面维护的持久 ZIP 更新队列与后台任务协调；不是仅内存任务列表。
- `read_logs({profile,limit}) -> LogEntry[]`：读取服务或任务日志。Core `readTaskLogs(taskId,limit)` 把 taskId 放入只用于日志查询的 profile.id；后台按 TaskRecord 查所属日志，不把该伪档案用于模型控制。
- `list_setup_handoffs() -> SetupHandoff[]`：最近 100 个准备任务的持久登记结果，状态 `pending|registered|needs-choice|failed|cancelled`，可包含 profileId、error 和 `{configPath,name}[]`。
- `resolve_setup_handoff({taskId,configPath?}) -> SetupHandoff`：重新核验成功任务并登记模型；候选须在同一安装目录且匹配任务模型/量化。任务及准备意图在子进程启动前同事务落盘；失败、取消或不完整文件不登记，也不自动启动或切换当前模型。

任务日志按每秒及结束写入 SQLite，最多 100 个任务，每任务 500 行、每行 4096 字符。脱敏状态与输出跨重启可读。

## Rust invoke：配置、文件与诊断

- `read_config({profile}) -> JSON`：读取 profile.configPath 指定的配置。
- `read_config_snapshot({profile}) -> {config:JSON,revision:string}`：Tauri 转发 `read_config_snapshot_v1`；revision 是原始配置字节的 SHA256，不是 JSON 对象的语义版本。
- `write_config({profile,config,expectedRevision}) -> {revision:string}`：Tauri 只转发 `write_config_cas_v1`；expectedRevision 必须是读取时的 64 字符十六进制 revision。原字节变化时拒绝写入并返回包含 `CONFIG_REVISION_CONFLICT` 的错误，草稿由 UI 保留、重读并合并。成功执行校验、备份、同步临时文件和原子替换，再返回新 revision，不自动重启模型。
- `validate_vision_files({profile,config}) -> void`：桌面进程对服务工作目录下必需视觉文件做只读核验，无同名 Supervisor RPC。
- `copy_configuration({profile,filename,config}) -> ServiceProfile`：桌面通过配置操作锁和管理文件锁，先请求后台 `assert_profile_management`，再把完整草稿保存为新配置文件；不自动登记、发现或启用。
- `delete_configuration({profile}) -> {archivedPath:string}`：桌面重查实际配置路径、登记引用及停止状态，归档配置（`config-trash/manifest.json` 记录原路径）并移除匹配登记；失败尝试还原归档。不是权重删除。
- `plan_config_cleanup({currentInstallDir,directories?}) -> {currentInstallDir,currentVersion?,items:[{profile,configPath,installDir,runtimeVersion?,modelName?,identical,identicalTo?}]}`：只读。列出当前运行环境以外、各版本安装目录根或 `configs/` 下的 `strata-*.json`；排除 `.shared-settings.json`、`models/` `packs/` `mtp/` 下的文件、共享数据目录中的配置、正在运行或已登记（含导入来源）的配置。删除仍逐个调用 `delete_configuration`。
- `plan_model_deletion({profiles}) -> ModelDeletionPlan`：只读检查主 GGUF 文件组、引用及停止状态；不可执行时返回 blockedReason。
- `delete_model_files({profiles,expectedFiles}) -> ModelDeletionSummary`：永久删除显式确认的主文件；expectedFiles 包含 path、sizeBytes、modifiedAt。执行前及进程检查后重查配置引用与文件身份。保留配置与伴随文件，不能以旧计划直接删除变化后的文件。
- `list_local_models({profile}) -> LocalModel[]`：返回配置/安装器识别的模型，不默认全系统扫描。
- `export_diagnostics({profile}) -> string`：返回脱敏诊断文件路径。
- `write_markdown_export({path,content}) -> string`：原子写 UTF-8 Markdown，返回绝对路径；仅 .md、最多 16 MiB，拒绝目录和符号链接。文件选择由桌面保存对话框完成。

配置快照或 CAS RPC 遇到旧后台 `unknown_method` 时映射 `SUPERVISOR_CAPABILITY_REQUIRED`，不会回退到旧 `write_config` 无版本写入。后台仍保留旧 RPC 供既有协议使用，不是新前端的可用兼容退路。CAS 同时检查登记/管理归属、运行时更新、调优、模型切换及退出状态。

## Rust invoke：ZIP 来源、匹配与更新

- `runtime_update_info({force?}) -> RuntimeUpdateInfo`：官方发布版本、源码、可校验资产、安装支持范围与错误；Core 默认 force=false，桌面元数据层复用已核验数据。
- `resolve_runtime_zip_asset({installDir,assetName?}) -> RuntimeReleaseAsset`：Tauri 直接调用当前后台 `resolve_runtime_zip_asset_v1`。显式 assetName 做核验；未指定时按已安装引擎的 CUDA/HIP 信息选择当前官方可用包，无法可靠匹配时返回错误，不猜测任意来源。
- `test_runtime_zip_download({assetName,localArchivePath?,downloadUrl?}) -> RuntimeZipDownloadCheckResult`：Tauri 直接调用当前后台 `test_runtime_zip_download_v1`，只做来源测试，不创建安装任务或下载缓存文件。
- `update_runtime_zip({installDir,assetName?,stopCurrentService?,localArchivePath?,downloadUrl?}) -> TaskStatus`：经桌面持久更新队列提交。stopCurrentService 默认 false；服务中断授权仅来自显式更新确认。官方来源使用后台 `update_runtime_zip`，自定义来源使用 `update_runtime_zip_download_v1`。队列分配持久 requestId 并协调批准的服务停止、后台能力/包交接、任务状态与原状态恢复；requestId 不是额外的前端 invoke 参数。

- `runtime_release_versions({force?}) -> RuntimeReleaseVersions`：只读。上游发布列表（`releases?per_page=100`），去掉草稿和无效标签，从新到旧排序；每项含 `version`、`tag`、`prerelease`、`packaging`（`feed`/`zip`）和 `installable`（本平台有安装包，旧版 ZIP 还需有 GitHub SHA256 摘要）。缓存 6 小时，失败后 10 分钟内不重试，失败时保留上次列表并返回 `error`。
- `runtime_release_info({version}) -> RuntimeUpdateInfo`：只读。按 `releases/tags/v{version}` 读取并核验指定版本，校验规则与 `runtime_update_info` 相同（签名清单的签名、格式、通道、有效期，以及清单版本等于所选版本），但不做序号防回放、也不保存序号；结果不写入最新版本缓存。
- `update_runtime_zip(...,targetVersion?)`：可选 `targetVersion` 指定安装某个版本（可低于当前版本）。队列此时调用后台 `update_runtime_zip_version_v1`；旧后台返回 `unknown_method` 时直接报错，不会退回到安装最新版本。只有指定了 `targetVersion` 时才跳过“禁止降级”检查；包核验、源码核验、试启动与自动回滚不变。`resolve_runtime_zip_asset` 同样接受 `targetVersion`，按所选版本匹配安装包。
- 固定版本保存在 store 键 `runtimePinnedVersion`（空字符串表示未固定），只由前端用来停止比它新的更新提示。

localArchivePath 与 downloadUrl 互斥。镜像只接受经过校验的 HTTPS 地址；传输来源不改变官方版本、文件名、长度和 SHA256 校验条件。本地来源测试读取完整文件并核验长度/摘要；网络来源测试最多 64 KiB，核验可访问性、长度和 Range，不声明完整 SHA256 已验证。实际安装始终校验完整 ZIP 的官方 SHA256/长度及对应源码，并执行解包与替换范围检查。

只读测试和包匹配不调用 `ensure_connected`，因此不为了“测试”启动后台或发起包切换；旧后台 `unknown_method` 返回明确的“后台不支持下载来源测试/自动匹配更新包”错误。它们可以读取官方元数据，不等于完全无网络请求。不得遇到旧后台拒绝便改用其他变更 RPC。

## Rust invoke：调优与应用生命周期

- `tuning_start({profileId,request}) -> TuningJob`：request 为 `TuningStartRequest`。带 useCase 时，Core 先核验 `capabilities.fullScenarioTuning>=1`，SupervisorClient 再核验并转发 `tuning_start_full_v1`；能力或 RPC 缺失返回 `SUPERVISOR_CAPABILITY_REQUIRED`，不把完整场景静默降级为旧短诊断。
- `tuning_status({profileId}) -> TuningJob|null`、`tuning_cancel({jobId}) -> void`：读取持久状态、请求取消。取消不等于恢复已经核验完成，须继续检查任务/recovery 状态。
- `tuning_live({jobId}) -> TuningLiveSnapshot|null`：只读内存快照（步骤、轮次、当前参数、已完成/总数、当前 tok/s、ETA、最近 200 行日志）；任务结束时把清洗后的日志（只保留元数据键、去掉 prompt/content 等文本字段与长字符串，最多 200 行、32 KiB）写入报告的 `liveLog`，结束后仍可查看；能力位 `tuningLive`。
- `calibrate_start(CalibrateRequest) -> CalibrationJob`、`calibrate_status({profileId}) -> CalibrationJob|null`、`calibrate_cancel({jobId}) -> void`：快速校准（对应官方 `tools/calibrate.py`：预热→prefill pipe→PCIe 专家比例→MTP 草稿阈值→交叉复核，每项须超过当前值 3% 才推荐）。只通过 `strata_tune` 临时覆盖请求参数，不改配置、不重启；AMD/非 CUDA 后端从不测量或推荐 `pcie_frac 0`。应用前客户端比较当前配置快照 revision 与报告的 `configFingerprint`（均为文件字节 SHA-256），不一致时提示并需用户明确确认（不硬阻止）；结果经 `validate_startup_configuration` 后默认另存为新配置版本（`copy_configuration`），覆盖当前配置需确认且原文件保留 `.bak`；能力位 `quickCalibration`。
- `tuning_apply({jobId,candidateId}) -> TuningJob`、`tuning_restore({jobId}) -> TuningJob`：应用经过任务记录验证的候选或恢复原配置；失败与恢复核验结果保留在 job 中。
- `get_startup_status() -> StartupStatus`、`set_startup_enabled({enabled}) -> StartupStatus`：独立后台登录启动注册及状态，不代表实际重登验收已完成。
- `get_background_policy() -> BackgroundPolicy`、`set_background_policy({mode,autoRecover,idleUnloadMinutes?}) -> BackgroundPolicy`：mode=`lazy|alwaysReady`，idleUnloadMinutes 为 0–1440 整数，省略默认 15；0 关闭空闲卸载。旧后台响应可能无该字段，UI 不据此声称支持调节。
- `check_app_update({timeoutMs?}) -> AppUpdateCheckResult`：读取 `runtimeDownloadPreferences`，对 `latest.json` 并行测速或按已选镜像检查，失败后回退官方 GitHub。返回来源、回退链与尝试记录；候选会话由桌面进程持有。
- `download_app_update({updateId,timeoutMs?,onEvent}) -> void`：按同一来源顺序下载安装包并通过 Tauri updater 内置公钥校验签名；事件包含进度与当前来源。
- `install_app_update({updateId,restartAfterInstall?}) -> void`、`close_app_update({updateId}) -> void`：安装或释放已校验的候选。
- `prepare_app_update() -> void`：桌面拒绝正在生成的流；后台核验运行任务、调优、加载/维护锁和受管服务空闲，并备份 SQLite。签名校验仍由 Tauri updater 公钥完成，不因镜像主机而放宽。
- `restart_interface() -> void`：清理 UI 流并重启桌面界面，不以此显式停止 Supervisor。
- `confirm_window_close() -> void`：明确退出入口，发送内部 `shutdown_supervisor({forClose:true})`，后台按窗口退出策略检查任务和服务；成功后清理 UI 并退出，失败保留窗口并恢复可重试状态。后台更新交接使用内部 forUpdate=true，普通 shutdown 使用 prepare_shutdown；三者不能互换。

独立 Supervisor 持有受管进程归属：Windows 使用 Job Object，Linux 使用进程监护。仅关闭到托盘、重启界面与明确退出/停止后台是不同操作。第二次桌面启动通过单实例插件聚焦已有主窗口。

## Rust invoke：MCP 与管理归属

- `manager_mcp_connection({profileId}) -> ManagerMcpConnection`：读取已登记模型的固定 stdio 桥命令及工具列表；后台返回其绝对可执行路径、数据目录和绑定 profileId，不接受前端提供任意可执行文件或安装根。
- `probe_official_mcp({profileId}) -> OfficialMcpProbe`：后台重新读取登记，通过受限自检核验官方 Python/脚本和 MCP 工具列表；readOnlyProbe=true，不把该检查当作模型已启动或推理已验收。
- `external_management_status({profileId}) -> ExternalManagementStatus`：查询同一安装根的归属及 canHandoff/canResume、原因。scope 固定为 installation，不能理解成仅当前配置文件。
- `set_external_management({profileId,external}) -> ExternalManagementStatus`：持久移交或收回安装根归属；核验该根的受管/外部服务、管理进程及相关任务已经停止。外部模式下，桌面及管理 MCP 的受控变更被拒绝，状态/日志等允许的只读工具仍可用。
- `chat_runtime_evidence({profileId}) -> ChatRuntimeEvidence`：核验当前运行参数和依赖能力的聊天证据；不能用持久保存的旧 capabilities 替代发送时的新证据。

管理 MCP 的 stdio 进程固定以 `strata-supervisor --mcp-server --data-dir <绝对目录> --profile-id <已登记ID>` 启动，通过认证本机 IPC 连接已运行的 Supervisor；桥本身不创建模型后台。内部 `manager_mcp_call({profileId,name,arguments})` 只暴露给 stdio 桥，不是 Tauri invoke 或公开任意 RPC 代理。

后台每次工具调用重新解析登记，客户端不能提供 profile、配置路径、安装目录、可执行文件或 RPC 方法。工具参数使用白名单并拒绝未知字段。八个工具为 `strata_status`、`strata_models`、`strata_start`、`strata_stop`、`strata_logs`、`strata_install`、`strata_connect_info`、`strata_task_status`：

- start/stop 复用受控 `ensure_local_service`/`stop_service`，沿用单模型、空闲、归属和停止不自动恢复规则；断开 MCP 不等于停止已启动服务。
- install 默认 confirm=false，仅返回磁盘计划；显式授权后 confirm=true 才提交官方 run_setup，仍须满足服务停止及参数校验。
- models 仅列同安装根登记，任务查询只返回绑定模型相关任务；日志脱敏；连接信息不返回 API Key。

Core 的 MCP 配置函数只生成文本，不写入第三方客户端配置、不内嵌凭据，也不执行 shell。Codex 后台配置工具超时 600 秒；官方独立 MCP Codex 配置默认 180 秒。Cursor、Claude Desktop、VS Code 输出其各自 stdio 结构，不自动设置 tool_timeout_sec。

## Core JS exports 与纯 JS 功能

原生桥映射保持 camelCase：`isDesktop`、`loadStore<T>`、`saveStore`、`setApiKey`、`hasApiKey`、`request`、`streamChat`、`startService`、`stopService`、`serviceStatus`、`restartService`、`takeOverService`、`readLogs`、`readTaskLogs`、`environmentInfo`、`setupDiskPreflight`、`runSetup`、`inspectModel`、`getChatRuntimeEvidence`、`installRuntime`、`prepareLocalRuntime`、`localRuntimeInstallation`、`updateRuntime`、`runtimeUpdateInfo`、`updateRuntimeZip`、`testRuntimeZipDownload`、`resolveRuntimeZipAsset`、`listTasks`、`listSetupHandoffs`、`resolveSetupHandoff`、`cancelTask`、`readConfig`、`readConfigSnapshot`、`validateVisionFiles`、`writeConfig`、`copyConfiguration`、`deleteConfiguration`、`planModelDeletion`、`deleteModelFiles`、`listLocalModels`、`exportDiagnostics`、`saveMarkdown`、`applySettings`、`discoverLocal`、`importLocal`、`ensureLocalService`、`switchLocalService`、`supervisorStatus`、`shutdownSupervisor`、`localInstallations`、`localInstallationDetails`、`renameLocalInstallation`、`removeLocalInstallation`、`startupStatus`、`setStartupEnabled`、`backgroundPolicy`、`setBackgroundPolicy`、`checkAppUpdate`、`downloadAppUpdate`、`installAppUpdate`、`closeAppUpdate`、`prepareAppUpdate`、`restartInterface`、`tuningStart`、`tuningStatus`、`tuningCancel`、`tuningApply`、`tuningRestore`、`analyticsQuery`、`requestCaptureStatus`、`setRequestCapture`。MCP 映射为 `managerMcpConnection`、`probeOfficialMcp`、`externalManagementStatus`、`setExternalManagement`。

以下是 JS 实现或基于既有原生调用的组合，不添加对应 native invoke：

- 聊天：`buildChatRequest`、`buildSharedDefaults`、`buildAdvancedChatFields`、`normalizeMetrics` 及能力解析。运行能力字段只有核验成功才发送；高级参数为 request-local，不进入官方 /settings 默认值。
- 公共聊天：`DEFAULT_COMMON_CHAT_DEFAULTS`、`normalizeCommonChatDefaults`、`usesCommonChatDefaults`、`resolveCommonChatOptions`；保存使用既有 store_set。新模型默认继承，旧专用值默认独立；共享字段不含 model/advanced，结构化输出仍约束 MCP。公共值影响下一次请求，正在生成的请求不变。
- Benchmark：`runBenchmark`、`runBenchmarkSuite`、选项/场景/报告辅助函数；复用 health、serviceStatus、strata_stream、strata_request 和 store。端点互斥、场景计划、取消和报告在 JS 层；没有 `benchmark_start`、`benchmark_cancel` 或独立 Supervisor Benchmark 任务契约。桌面协调互斥不保证其他 API 客户端无并发负载。
- 下载偏好：`getRuntimeDownloadPreferences`、`saveRuntimeDownloadPreferences`、`resolveRuntimeDownloadPreferences`、`runtimeDownloadSources`；使用 KV 存储与当前官方资产，HTTPS 模板支持 `{url}`、`{version}`、`{asset}`。固定 URL/本地文件绑定特定 release，模板可按规则跟随后续版本。
- 运行工具：`resizeRuntimeVram`、`probeSessionStorage`、`operateSessionStorage`、`runtimeSlots` 等复用受控 Strata HTTP，不构造新 invoke。
- 配置辅助：`startupTuningOf`/`applyStartupTuning` 只操作已知上下文、KV 和线程覆盖；保留未知配置，拒绝重复或缺值参数、非法数值及小于现有 KV 驻留窗口的上下文。模型目录、服务选择、官方准备选项等辅助模块及 `MODEL_CATALOG` 由 core index 导出。

## 关键数据类型与存储约束

- `ProcessStatus`：running、owned、pid?、startedAt?、exitCode?、external?、canTakeOver?、reason?、creationTime?。creationTime 为十进制 Windows FILETIME 字符串，避免 JS 精度丢失。
- `ChatOptions`：model、reasoningEffort=`off|low|medium|high`、temperature、topP、topK?（1–64）、maxTokens（0 表示默认）、seed?（正整数/null）、systemPrompt、mcp、images?、experimentalSpeedProjection?、advanced?、fixedPrefix?、capabilities?。图像/投影/前缀能力依赖新证据；具体高级字段以 chat.ts 为准。
- `ChatDelta`：content?、reasoning?、tool?、usage?、done?、error?；`MetricSnapshot` 保留 state/model、吞吐、GPU/CPU/RAM、队列/运行数、缓存、requests、history 与 raw，缺失数值为 null，不伪造为零。
- `LocalModel`：name、configPath、modelPath、sizeBytes（number|null）；`RuntimeReleaseAsset`：name、url、size、sha256、variant=`cuda13|cuda12|hip`。
- `RuntimeZipDownloadCheckResult`：source、assetName、checkedAt、checkedBytes、totalBytes、rangeSupported?、sha256Verified。网络样本测试的 sha256Verified=false；不能把 checkedBytes 当完整下载进度。
- `RequestCaptureStatus`：state=`disabled|temporary|external|unavailable`、expiresAtMs、reason。统计返回 data 与 coverage；coverage 保留观察器身份、采集间隙、范围和保留期限，不以没有记录推断没有请求。

`conversations` 保存事务把附件正文拆入 SQLite attachments 表，读取时还原，失败保留原值并清理不再引用的附件；图片不全部内联进一个大 JSON。SQLite 会话不属于系统凭据保险库。应用更新备份为应用数据库一致快照，不包含 OS 凭据或模型文件。

前端开发使用 IndexedDB 状态和会话内存密钥。Vite 代理只允许回环目标；需要原生能力的操作返回明确 `DESKTOP_REQUIRED`。桌面与代理接受本机回环 HTTP，不能把预览夹具通过当作凭据、进程管理、签名安装或 GPU 的原生验收。

## 核对依据

`packages/core/src/{bridge,mcp-integration,shared-chat-settings,runtime-download,benchmark,benchmark-suite,runtime-operations}.ts`；`apps/desktop/src-tauri/src/{lib,http,supervisor_client,runtime_update_queue}.rs`；`crates/runtime-core/src/{lib,storage,manager_mcp,manager_mcp_stdio,external_management,http}.rs`；`apps/supervisor/src/main.rs`。本稿覆盖当前 generate_handler 清单，保留有效的旧契约并补充版本化 RPC；活动会话结束后仍须按冻结源码再核对。

## 可选监控窗口

- `open_monitor_window() -> void`：仅主窗口显式打开一个 `service-monitor` 窗口，默认置顶；关闭后不自动重开。
- `monitor_snapshot() -> FloatingMonitorSnapshot`：仅监控窗口直接查询已存在后台及固定 GET `/health`、`/metrics`，不走可启动/升级后台的连接恢复。
- `show_main_from_monitor() -> void`：仅监控窗口显示并聚焦主窗口。
- 应用 invoke 入口核对 Window/WebView 标签，主窗口保持原命令权限；监控窗口只放行后两条，拒绝存储、配置和服务修改及未知窗口。内置关闭、拖动和置顶按独立 capability 授权。
