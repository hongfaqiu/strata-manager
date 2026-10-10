# 开发与验收记录

更新日期：2026-10-10。上游参考 revision：`fb58e0dbc8399662c0e47c76578c6e878b14f6cf`。

本文件区分本轮独立后台实现与此前原型验证。自动检测/导入、运行时准备、元数据统计、调优、自启动与更新已经进入实现和测试阶段，不再只是方案；实现存在、夹具通过、真实 GPU 运行、最终安装包和跨版本更新是不同验收层级。下面记录阶段证据，最终提交后仍需统一检查及真实发布验收。

## 本轮独立后台与本机流程

| 项目 | 已取得的证据 | 实际范围 |
| --- | --- | --- |
| 后台架构 | Rust workspace、独立 `strata-supervisor`、用户限定 IPC 与打包 sidecar 已实现 | Windows 使用 Job Object 管理子树；Linux IPC/进程实现尚待真实系统验收 |
| Core / IPC | 后端阶段快照：`cargo test -p strata-runtime-core -p strata-local-ipc --lib --target-dir apps/desktop/src-tauri/target`，Core 60 passed / 2 ignored，IPC 5 passed | ignored 包括只读本机发现及真实官方安装；真实安装另行显式运行。后续新增测试与最终总数须统一复验 |
| Supervisor 生命周期 | `cargo test -p strata-supervisor --test lifecycle --target-dir apps/desktop/src-tauri/target`，2 passed，56.41 秒 | 真实后台进程与 Python HTTP 夹具：客户端退出服务继续、重复启动/重连、显式停止、有限 3 次恢复、后台硬崩溃释放 Job 子树、恢复时受控清理遗留维护 gate |
| 模型切换 | 同一生命周期测试覆盖双服务切换 | 繁忙时拒切换、目标加载失败恢复旧模型、成功切换维持单模型；夹具不执行 GPU 推理 |
| GUI HTTP 归属 | 后端报告 2 个新增所有权合同测试通过 | 未导入/未受管实例不能接收桌面变更；流式请求使用已登记且存活的受管身份。最终 workspace 总数待合并复验 |
| 后台包升级 | `cargo test -p strata-manager supervisor_client::tests --lib --target-dir apps/desktop/src-tauri/target`，1 passed，4.08 秒 | 真实 staged old/new Windows PE 切换与启动失败回滚，不等于正式 updater 下载/验签/安装 |
| 登录自启动 | `cargo test -p strata-manager startup::tests --lib --target-dir apps/desktop/src-tauri/target`，2 passed | 隔离 HKCU 测试键的真实写入/读取/删除、命令行转义；启动目标是后台，无真实注销/重登验收 |
| 官方运行环境准备 | `cargo test -p strata-runtime-core installation::tests --target-dir .local/install-test-target`，6 passed / 1 ignored；ignored 真实测试另行运行通过 | 危险路径拒绝、未知/不同文件保留、SQLite token + marker 归属校验、解包取消、下载 hash 失败、损坏缓存保留后重试、下载中取消 |
| 无 Git 真实准备 | 限制测试进程 PATH 到 Python 目录并确认 Git 不可用；显式运行 `official_archive_prepares_without_git_and_returns_only_a_setup_profile` | 使用 Rust HTTPS 下载固定官方 ZIP、安全解包、真实私有 venv/pip；27.46 秒完成；不下载模型、不登记未完成模型配置 |
| Python 来源校验 | 官方 Python 3.13.16 x64 安装器真实下载 29,935,584 字节，SHA256 与 Python.org .sigstore 元数据一致 | 仅校验下载；本机已有 Python 3.10.11，没有实际执行缺 Python 时的安装分支 |
| 格式与静态检查 | 本轮后台报告四 crate Clippy 通过；安装模块最终 `cargo clippy -p strata-runtime-core --all-targets --target-dir .local/install-test-target -- -D warnings` 通过 | 后续代码变更仍需在最终提交运行统一 fmt、Clippy 和 tests |

准备完成返回的 profile 只用于现有模型 setup；生成实际配置和模型文件后，需检测/导入才可启动。模型准备使用官方 `setup.py --yes --setup --no-start --no-browser` 流程，不重造模型下载器。Linux 缺少 Python/venv 时给出可行动诊断，不执行 sudo；此分支未实际验收。

固定源下载：`https://codeload.github.com/Niko1221/Strata/zip/fb58e0dbc8399662c0e47c76578c6e878b14f6cf`，实际 19,149,640 字节，SHA256：

```text
b6b559866cf7d422d7acace638d542049ea7e3543720f574cb97b2d0bd530d7b
```

Python 校验来源：[Python 3.13.16 官方发布页](https://www.python.org/downloads/release/python-31316/)及[安装器签名元数据](https://www.python.org/ftp/python/3.13.16/python-3.13.16-amd64.exe.sigstore)。安装器 SHA256：

```text
fb4f9f5d438b2396da0086dc70b935c530cb578e37adc6d354f7ad2037fee83b
```

## 本轮 API 元数据统计

观测器通过应用私有 bootstrap 注入经过 hash 核验的上游模块，原有源码保持不变。Supervisor 持续读取事件 journal，SQLite 持久化、幂等去重及提交后 ACK；数据与页面轮询分离。统计保存元数据，聊天存储和官方 API Monitor 正文捕获分别管理。

`py -3 -m unittest discover -s apps/supervisor/tests -p test_strata_observer.py -v` 在只读上游源码和 MockEngine 下 **13 passed，9.248 秒**。重放此测试需设置 `STRATA_TEST_ROOT` 指向经过核验的上游 checkout。覆盖 Chat Completions / Responses / Anthropic，普通/SSE usage、早期鉴权/来源/JSON 错误、HTTP 200 中的引擎错误、断流取消、MCP 一次 HTTP 多轮推理、token-count 不增加推理 token、维护排空、新请求拒绝、维护令牌不绕过鉴权、Anthropic 缓存不重复、journal 错误不改变 API 异常、保留上限/断档、不支持版本降级、真实 `python -m serve.server` bootstrap 且原源码不变。MockEngine 的 token/s 不是实际 GPU 性能。

Core 的 analytics 测试覆盖事务重放/重启去重、未知值与成功率分母、跨日分桶/单 HTTP 多轮推理、保留和崩溃中断、恶意正文不写入、未结束 run 的崩溃恢复、分位数插值及非法样本过滤。元数据保留 **90 天**；HTTP usage、推理工作量和工具调用分别计数。今日范围由界面按本机时区提供，未知数据不补零，断档和兼容性通过 coverage 显示。

这些合同与 SQLite 验证不能替代真实 GPU 的跨进程、长期持续使用及容量验收。不得将首次采集之前的时间段或不兼容运行时描述为完整全天统计。

## 本轮实测调优实现

`cargo test -p strata-runtime-core tuning::tests -- --nocapture --test-threads=1` **10 passed**；对应 Core Clippy 通过。包含实际回环 SSE 分块/UTF-8/no-DONE 拒绝、受管 HTTP 夹具 A/B/A、候选采用后参数写入及重启/load/probe、恢复原配置、较慢候选不推荐、加载失败回滚、只取消自身流、维护 gate 清理、服务退出时收尾、不碰未知 PID，以及配置 CLI/SHA256 恢复。

`request-aba-v1` 对有限请求级候选执行基线 A → 候选 B → 恢复 A；distinctPrompt 使用新 nonce，repeatedPrefix 立即重复同一提示，记录实际缓存。推荐要求完整且一致的确定性输出，收益超过该轮 A 漂移。输出 hash 一致只证明一致性，不证明语义质量；这些探针不测试冷加载、会话恢复、完整 Agent、视觉或长上下文。

采用结果会保存恢复 journal，变更受管配置、重启、加载并探测；失败恢复。fixture 的受控解码耗时只验证算法与流程，不证明 GPU 收益。本轮真实 GPU 调优结果由主流程单独验收，在结果记录前不得声称自动调优已经带来实际加速。

## 发布与桌面界面状态

公开仓库已创建；正式 GitHub updater endpoint、公钥、updater artifacts 与 Actions 私钥 secret 已配置。发布门禁单元测试 **5 passed**，GitHub workflow actionlint 检查通过；跨平台 sidecar 脚本已实际构建 Windows debug 后台，并核对目标与打包副本 SHA256 一致。

当前尚未记录完整 Windows/Linux tag Release 构建结果、公开安装包资产核验、更新器密码学验签及上一版 → 新版安装闭环。更新签名不是 Windows Authenticode 发布者签名，尚未配置发布者证书。安装成功、后台版本切换和 API/模型恢复必须分别验收。

首次公开提交为 `65298a066c5fd48420729b437589cdf2cdce9e3f`；[首次 Windows/Linux CI](https://github.com/hongfaqiu/strata-manager/actions/runs/38060267872) 已实际运行，两平台均失败，不能作为安装包验收通过：

| 平台 | 已通过的实际检查 | 未通过检查 |
| --- | --- | --- |
| Windows x64 | 固定上游 observer 13 passed（9.425 秒、无跳过），前端协议 35 passed、HTTP 契约 5 passed、发布门禁 5 passed、前端构建、debug 后台构建、Rust fmt、IPC 5 passed、隔离自启动 2 passed | 桌面后台包升级测试读取硬编码 `target/debug` fixture 路径失败；CI 使用 `target/<triple>/debug`，未继续完成其余 Rust 检查和安装包 |
| Ubuntu 22.04 x64 | 固定上游 observer 13 passed（7.773 秒、无跳过），最小 Python 依赖、Linux 系统依赖安装、发布门禁 5 passed、前端类型检查 | `packages/core/tests/native.test.ts:96` 原生错误归一化 mock 未命中，得到 `NETWORK_ERROR` 而不是预期 `UNAUTHORIZED`，34 passed / 1 failed；尚未进入 Rust/安装包检查 |

上述失败须由后续提交的完整 CI 复验关闭。工作流另加入上游 LF 字节保留和 hash 前置门禁，避免不支持源码触发 `SkipTest` 后仍把 observer 步骤误报为完整覆盖。

桌面保留官方 Strata 视觉与组件，沿用共享页头、可折叠侧栏和嵌套管理布局。本轮新的自动准备入口、最新布局、中英文、键盘操作、托盘和三张 WebP 截图仍需在最终 Tauri WebView 中统一验收。此前页面几何对照的结果保留在历史部分，不据此宣称当前全部页面逐像素一致或新的原生视觉已经验收。

## 发布前尚需完成

- 最终源码的 `pnpm check`、workspace fmt/Clippy/tests，以及 Windows/Linux CI 和安装包构建；记录实际 revision 与 artifacts。
- Windows 干净环境：无 Git、无 Python 的自动准备完整安装；已有安装检测/导入及自动就绪；新模型 setup、失败重试与取消。
- 最新 Tauri 界面的自动引导、官方功能、中英布局、窗口/托盘行为和真实截图。
- 真实 GPU：新架构聊天/附件/MCP、背景持续统计、重连/切换/恢复和调优完整闭环；不能只引用旧原型证明本轮通过。
- 注销并重新登录后的后台自启动；正式签名更新下载、验签、安装、后台接续与失败恢复。
- Linux 实机 IPC、进程树、崩溃、自动准备、安装/卸载、自启动及 GPU；缺项继续在 Release 标明。
- 发布隐私检查、来源/许可证、版本一致、全部 Release 资产与 `latest.json` 对应关系。

## 历史原型验证快照

验证日期：2026-10-10。平台：Windows 11、Node 22.20、pnpm 11.21、Rust 1.94 / MSVC、WebView2。参考上游版本：`fb58e0dbc8399662c0e47c76578c6e878b14f6cf`。

以下为独立后台改造前的原型验收快照，保留当时的通过项与未完成项。它不能替代本轮新架构验收；当时的设计与现场审查见 [生产化改造方案](PRODUCTION_REDESIGN.md)和 [UX 审查](PRODUCTION_UX_AUDIT.md)。该研究阶段未执行新的模型基准或运行时升级，后续实现和验收另见本文件上方。

### 已取得的运行证据

| 项目 | 结果与范围 |
| --- | --- |
| Git / monorepo（历史状态） | 已初始化本地 `main`，pnpm workspace + Cargo；当时未提交或推送 |
| 核心协议测试 | 33 项通过，覆盖 SSE 分块、UTF-8、取消、reasoning、MCP 历史、参数、配置导入/调优、原生导出与新进程桥接；前端生产构建通过，最终安装包尚未重新构建 |
| HTTP 契约测试 | 5 项独立 HTTP 测试通过，覆盖官方 15 项配置、原子验证、SSE usage 与 metrics 统计一致性、取消、请求正文捕获及保留上限；使用独立随机端口 |
| 原生测试 | 28 项通过；`cargo clippy --all-targets -- -D warnings` 通过；含受管重启、外部实例身份/活动拒绝、标准venv父子身份、端口被替代拒绝操作、重启预检失败旧进程保活、精确子树退出、安装重试及跨重启日志 |
| 浏览器完整流 | 独立无头浏览器通过 UI 创建协议服务档案，SSE 中文/思考输出、usage、409、取消和 IndexedDB 刷新恢复通过；无页面异常 |
| 原生生命周期 | Tauri IPC 和真实 UI 启动 → HTTP 健康 → 加载 → 停止通过；Windows Job Object 清理 Python 子进程通过 |
| 原生持久化 | SQLite 中文状态、API Key 写入/删除、配置保存/备份和非法配置拒绝通过；release 应用重启后中文状态和独立存储的图片/文本附件均可还原 |
| 原生 SSE / 附件 | 在实际 WebView2 中调用共享协议层，经 Tauri Channel / Rust HTTP 收到完整 SSE、reasoning、usage，取消成功；图片与中文文本进入请求，SQLite 附件拆分并还原成功 |
| 真实运行时安装 | Tauri 调用 Git 从官方 GitHub 克隆到独立 `.local/installed-runtime`；任务 completed，HEAD 与参考版本一致。任务状态与有界脱敏 stdout/stderr 持久化；数据库关闭/重开读取日志通过 |
| 模型准备流程 | 对独立无推理 Python 夹具运行 venv / setup 完成；不支持的量化参数拒绝；取消慢任务后子进程退出 |
| 安装目录保护 | 未知非空目录拒绝；SQLite token 与目录标记双重匹配才可重试，旧半成品保留。实际失败、取消、独立本地 Git 仓库重试通过 |
| 单实例 | 二次启动退出，原主实例保留；进程数量为 1 |
| 环境探测 | 最新原生构建返回 OS/CPU/RAM/GPU/Python/Git；探测约 2.6 秒，异步执行 |
| 真实 GPU 聊天 | 实际 WebView2 经 Rust HTTP 连接 18081 的 Qwen3.8-Flash-Next SC117 IQ3_S；两轮中文暗号“青松”、SQLite 刷新恢复、真实监控通过 |
| 真实附件/取消 | 文本附件回答“松柏742”；480×240 PNG 回答“左侧红色圆形、右侧蓝色正方形”，SQLite 图片恢复；收到实际思考后停止，保留部分思考且活动数回到 0 |
| 真实 MCP / API 请求 | 单实例临时配置 18094，用同一组真实模型权重与本地 stdio 整数加法工具；123456 + 789012 = 912468，真实 tool_call.done.ok；API 请求 HTTP 200、输入/输出/思考/响应四页、过滤和复制通过 |
| 真实配置/模型控制 | 临时服务的共享采样 off/max64/seed7 写入读取一致；官方配置 temperature=.45 保存一致，再恢复；实际 UI 卸载模型、加载模型、停止受管服务通过 |
| 既有服务恢复 | 测试采用单实例切换；18094 引擎/图像/MCP 子进程已退出，18081 原服务已恢复，loaded=true、上下文 524288、images=true；原配置、共享设置和 Start/Stop 脚本 SHA256 逐字节一致 |
| 服务管理和参数 UI | 隔离 IPC 验证 owned/external/未核验/未启动、接管确认、逐服务失败/重试、加载/卸载、移除连接；15 项分组/校验/默认值，启动参数保留安全/MCP/模型/未知字段且外部改动时拒绝覆盖；4 宽度、中英，无页面异常 |

### 验证边界

协议服务 `scripts/contract-server.mjs` 在 18091 运行；原生生命周期夹具在 18092 运行。它们明确标记为夹具，不执行模型推理，不产生硬件性能指标。真实 Git 克隆只获取源码，未下载大型模型权重。

实际 GPU 推理已完成上述限定流程。大型权重使用本机已有文件，没有重新下载约 78 GiB 的模型；上游大模型下载/断点续传、本机 512K 满载长对话性能和任意第三方 MCP 服务不在这次验证范围。MCP 验收使用真实 stdio 工具执行，工具仅整数计算，没有网络或文件访问。

单实例切换重启清空了 Strata 内存中的请求计数和会话缓存；切换前监控快照已保存至 `.local/real-service-acceptance/original-metrics-before-restart.json`。原配置的 API 正文记录与 MCP 设置保持原样，临时开关没有写入原服务配置。

真实 GPU 测试脚本与控制记录位于 `.local/real-service-acceptance` 和 `.local/real-model-*.js`，截图位于 `output/playwright/real-model-*.png`。它们是忽略的本机验收产物，不提交个人路径、模型内容或配置备份。

官方基础页面整合时，在相同协议数据、英文、浅色和 1216px 可用工作区下对照上游，34 个检查点的几何、字体和间距在 1px 容差内匹配；记录位于 `output/playwright/layout-comparison.json`。这不是全页逐像素一致证明。随后按用户最新要求重组侧栏、Header、聊天历史和配置位置，最终版本以功能完整、视觉样式复用及新信息架构验收为准。

该原型阶段的服务管理、引导与参数入口经过隔离 IPC 与前端整合检查；当时最终安装包尚未重新生成。此前安装包构建成功，不作为本轮独立后台版本的交付证明。

### 并行工作说明

前端、原生、协议、服务管理与独立运行复核由子 Agent 分工，主 Agent 负责接线、真实 GPU 测试及交付。早期调用请求配置为 `gpt-6.1-sol` / `high`，后续任务继承主 Agent 设置；工具未提供实际运行模型与推理档位的独立确认，不把请求配置或继承设置当成已验证的执行信息。
