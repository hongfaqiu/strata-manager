# 开发接口约定

共享类型在 `packages/core/src/types.ts`，主 Agent 管理基础类型。UI 使用 `@strata-manager/core` 导出。

## Rust invoke

- `store_get({key}) -> JSON|null`、`store_set({key,value}) -> void`：SQLite JSON KV，应用状态使用 `profiles`、`settings`、`conversations` 等键。
- `set_api_key({profileId,apiKey}) -> void`、`has_api_key({profileId}) -> bool`：系统凭据库，不读取秘密回前端。
- `strata_request({profile,path,method,body?}) -> JSON`：profile 为 ServiceProfile；path 仅 Strata 相对 API 路径。
- `strata_stream({profile,path,body,requestId,onEvent}) -> void`：Tauri Channel<StreamEvent>，data 为可拼接 SSE 字符串，error 的 data 为错误信息。
- `cancel_stream({requestId}) -> void`。
- `start_service({profile}) -> ProcessStatus`、`stop_service({profileId}) -> ProcessStatus`、`service_status({profileId,profile?}) -> ProcessStatus`。可选 profile 启用本机外部进程只读核验，不登记进程清理归属。
- `restart_service({profile}) -> ProcessStatus`：仅重启应用管理的进程。
- `take_over_service({profile}) -> ProcessStatus`：用户明确接管后重新核验外部身份和空闲状态，结束核验通过的进程树并以应用受管进程重启。
- `read_logs({profile,limit}) -> LogEntry[]`。
- `environment_info() -> EnvironmentInfo`。
- `run_setup({profile,model,quant,context,images}) -> TaskStatus`：后台运行上游非交互安装/模型准备；返回 task ID，日志供任务页读取。
- `install_runtime({directory}) -> TaskStatus`：获取官方 Strata 仓库到新目录，拒绝覆盖未知非空目录；仅本应用数据库与目录标记均匹配的失败安装允许重试，保留旧半成品；后台任务，不下载模型直到用户选择。
- `update_runtime({profile}) -> TaskStatus`：上游官方更新脚本/明确版本记录，失败可报告；禁止盲目覆盖配置。
- `list_tasks() -> TaskStatus[]`、`cancel_task({taskId}) -> void`。
- `read_config({profile}) -> JSON`、`write_config({profile,config}) -> void`：仅 profile.configPath 指定的配置，原子写入并备份。
- `list_local_models({profile}) -> LocalModel[]`：返回配置/安装器可识别的模型，不默认扫描整个系统。
- `export_diagnostics({profile}) -> string`：返回写出的脱敏诊断路径。
- `write_markdown_export({path,content}) -> string`：原子写出 UTF-8 Markdown，返回绝对路径；仅 .md、最多 16 MiB，拒绝目录和符号链接。文件选择由桌面保存对话框处理。
- `apply_settings({settings}) -> void`：窗口退出策略等运行设置。

## Core JS exports (camelCase)

`isDesktop`, `loadStore<T>(key,fallback)`, `saveStore(key,value)`, `setApiKey(profileId,key)`, `hasApiKey(profileId)`, `request(profile,path,method='GET',body?)`, `streamChat(profile,body,onDelta,signal?)`, `buildChatRequest(messages,options)`, `normalizeMetrics(raw)`, `startService(profile)`, `stopService(profileId)`, `serviceStatus(profileId,profile?)`, `restartService(profile)`, `takeOverService(profile)`, `readLogs(profile,limit=200)`, `environmentInfo()`, `runSetup(profile,model,quant,context,images)`, `installRuntime(directory)`, `updateRuntime(profile)`, `listTasks()`, `cancelTask(taskId)`, `readConfig(profile)`, `writeConfig(profile,config)`, `listLocalModels(profile)`, `exportDiagnostics(profile)`, `saveMarkdown(path,content)`, `applySettings(settings)`，及 `MODEL_CATALOG`。

`startupTuningOf(config)` / `applyStartupTuning(config,tuning)` 仅操作已知上下文、KV 和线程覆盖值；保留其余配置，拒绝重复或缺值参数、非法数值，以及小于现有 KV 驻留窗口的上下文。

`ProcessStatus`: running, owned, pid?, startedAt?, exitCode?, external?, canTakeOver?, reason?, creationTime?。creationTime 使用十进制字符串表示 Windows FILETIME，避免 JavaScript 整数精度丢失。

`ChatOptions`: model, reasoningEffort ('off'|'low'|'medium'|'high'), temperature, topP, topK (1–64), maxTokens (0 表示默认), seed (正整数或 null), systemPrompt, mcp, images, experimentalSpeedProjection（仅引擎确认 cvec 能力时发送）。

`ChatDelta`: content?, reasoning?, tool?: ToolEvent, usage?: JsonObject, done?, error?。

`MetricSnapshot`: state:string, model:string, decodeTokS:number|null, prefillTokS:number|null, gpuUtil:number|null, gpuMemoryUsed:number|null, gpuMemoryTotal:number|null, gpuTemperature:number|null, gpuPower:number|null, cpuUtil:number|null, ramUsed:number|null, ramTotal:number|null, queued:number|null, running:number|null, cacheHitRate:number|null, requests:JsonObject[], history:Record<string,(number|null)[]>, raw:JsonObject。

`LocalModel`: name:string, configPath:string, modelPath:string, sizeBytes:number|null。

前端开发使用 IndexedDB 保存应用状态、会话内存保存密钥，Vite 代理仅允许回环目标；原生操作返回明确的 DESKTOP_REQUIRED。桌面与开发代理仅接受本机回环 HTTP 地址。原生修改和聊天必须通过权威登记、活体后台持有服务的校验。

## 生命周期和存储补充

- `strata_request` 透传官方 `/config` 的 GET `{file,keys,note}` 和 POST `{set}`，以及 `/settings` 的 GET `{shared,defaults}` 和 POST `{defaults:对象|null}`。加载与 VRAM 控制超时为 300 秒，普通请求为 90 秒。
- `conversations` 保存时将附件正文拆入 SQLite attachments 表，读回时还原；事务失败保留原值，并清理不再引用的附件。不是将全部图片内联到单个大 JSON。
- `read_logs` 接受任务 ID，并根据 TaskRecord 映射到所属服务日志；运行时安装任务也可读取其 stdout/stderr。
- 任务日志按每秒及任务结束写入 SQLite，最多保留 100 个任务、每任务 500 行、每行 4096 字符；任务状态与脱敏输出跨重启可读。
- 独立 Supervisor 使用 Windows Job Object 约束受管进程树；停止服务、取消任务及明确停止后台才清理它创建的子进程。关闭 GUI 保持后台 API 运行。
- 二次启动通过单实例插件聚焦已有主窗口。
