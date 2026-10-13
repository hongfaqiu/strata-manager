# 日常体验增量 / Daily experience increment

2026-10-13 工作区实现，尚未发行。资源规则固定来自 Strata v0.1.43.1 的 `a0116b2782a5b82622358c04a06496485d12b2d6`；安装的运行时仍独立核验。源码、夹具、WSL 测试与真实 GPU / 最终安装包验收分开记录。

## 功能与使用入口

1. **模型下载与运行配置**：按当前选择展示官方安装建议、RAM/逐卡显存总量与可用量、有限 KV/槽位分项。建议不覆盖手动输入；非法草稿、自定义及超出规则的模式显示未知。历史峰值只来自匹配资源选择、静态硬件及真实启动证明的报告。
2. **启动失败**：总览和任务保留阶段、耗时、原因、可信度和脱敏证据。401/403 不被最终超时覆盖；日志资源关键词仅是疑似原因。主要操作打开对应配置、凭据、日志或只读状态检查，成功后清除失败登记。
3. **聊天与能力**：区分本地操作、服务请求和响应 ID；TTFT 从实际请求开始计算，首正文和整轮耗时分别保存。无关联证据时不把全局排队/prefill 当作本次阶段。缺能力字段显示未核验，服务/引擎身份及加载状态变化会使旧证据失效。
4. **API 与外部助手**：显式验证服务身份、模型和一次最多 256 token / 60 秒请求。工具只检查调用结构，不执行 MCP；图片使用内置小图。共享设置预览后 CAS 保存并备份，重启是独立操作。服务端密钥与客户端凭据独立，已有多密钥默认保留，不回显秘密。
5. **Benchmark**：场景报告 schema 3 兼容旧版，上下文 schema 3 增加可选身份/首正文时间。两份历史显示条件差异及未知项，弱模型身份不形成直接提速结论。保存升级前基线不会更新或启动模型；手动更新后复用原任务串行重跑。场景导出默认省略测试文本、回答和服务错误正文，内容可显式勾选。

资源各分项不能直接相加为完整容量保证。峰值是整机/整卡采样，可能包含其它程序。局域网地址来自本机网卡；跨设备可达性、语义质量、GPU容量与长时稳定性需独立验证。

## Interfaces and compatibility

- `assess_setup_resources({request})` returns read-only `SetupResourceAssessment`: rule revision, timestamp, hardware, component estimates, recommendations and unknowns. Disk space preflight remains independent.
- `supervisor_status.startupFailures?` contains optional structured diagnostics. Legacy `preparationFailures` keeps its meaning; old error strings remain unclassified.
- `service_sharing_status({profile})` returns revision, key count, local addresses and saved/live listen settings, never key values.
- `set_service_auth({profile,request})` checks registered target, ownership, idle state and revision, preserves a backup and never restarts, changes client credentials or edits the firewall automatically.
- `benchmark_identity({profile})` verifies an owned engine command and collects bounded model/executable metadata. Metadata hashes are not verified content digests. Core stores only safe resource fields; full commands and credentials stay out of reports.
- `ChatMessage.execution`, report identity and first-answer timing are additive. Old records stay readable; missing evidence stays unknown. No destructive database migration is required.

## Later roadmap

Linux same-host replicas → node/deployment/resource domains → cross-host routing, bounded queues, affinity and draining. Remote control, RAG, automatic compaction, public rankings and automatic downgrade remain outside this increment.

## Verification

See [VERIFICATION.md](VERIFICATION.md). Browser fixtures mount real components with in-memory native IO, block external origins and never connect to real models or credentials. Installed-app, GPU and LAN acceptance remain separate release gates.
