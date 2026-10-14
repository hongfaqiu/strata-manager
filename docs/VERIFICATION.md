# 开发与验收记录

## 2026-10-14 v0.1.8 发布候选

- 候选包含 Windows 运行中服务连接与托管保护、系统语言和十种随包资源、监控浮条布局与显示控制、自动载入进度、设置工作区及总览图形更新。此记录写于公开发布前；最终安装包以对应版本的完整 CI、签名发布和公开资源核验为准。
- Core **434/434**、Desktop **135/135**、脚本 **23/23**；TypeScript 与前端生产构建通过。Rust 格式及 workspace/all-targets Clippy 通过。发布门禁 **258/258**；原生分片与缓存策略回归 **43/43**。
- 第一轮候选 CI `f9fa71a3e9f7c8de26ab46f354311525a2636880` 在 Windows/Linux 的 Rust 检查被 Rust 1.99 新增的排序写法检查阻断。将内部任务栏布局的降序比较改为等价的 `sort_unstable_by_key(Reverse(...))`，保留所有门禁和排序规则；新源码必须重新完成十个 CI job，不能复用失败候选的产物。这一原生写法调整不改变已捕获的 React 界面或示例数据。
- 本地 Windows 原生检查合计 **642 个唯一测试通过、15 项明确忽略**。首次完整运行的五项 request-capture 失败源于缺少 CI 固定上游 fixture；补齐 `fb58e0dbc8399662c0e47c76578c6e878b14f6cf` 并核验原始源码字节后，该模块 **9/9** 通过。剩余 supervisor/update-verifier **11/11** 与四个 workspace 文档测试目标分别完成。此合并结果不是一次完整运行全绿，也不是 CI 或安装包验收；本地汇总保存在 `output/release-v0.1.8/native-verification-aggregate.json`。
- Windows ignored 清单由原十四项增加为十五项，仅登记新增的“用户显式指定真实运行服务的只读所有者验收”。Linux 七项、全部已有测试、严格清单比对、超时与分片规则保持不变。实际 Windows libtest 枚举 **657 项**，与本轮清单完全一致。
- 固定 Strata 0.1.44 MockEngine HTTP observer **36/36**、自动服务连接浏览器 **3/3**、系统语言浏览器 **18/18** 通过；均使用隔离数据或临时目录，未通过这些用例启动真实模型。
- README、官网及指南改用当前组件的隔离示例配图。截图捕获核对前后源码摘要，无损 WebP 与 PNG 逐像素一致；历史 0.1.4 的十六张图与 0.1.7 的六张图按原字节归档。截图记录分别为 `docs/screenshots/manifest.json` 与 `daily-experience/manifest.json`。
- 真实 GPU 自动载入、长时稳定性、用户设备上的跨版本安装、完整原生窗口／拖拽／菜单交互和完整安装器的人工语言选择仍待独立验收；Linux 外部运行服务身份核验与接管不在此版本支持范围。内部实验任务栏宿主未作为可用产品入口发布。

## 2026-10-14 空闲释放后的自动载入状态

- 应用自有 observer 包装已核验上游的 `Service.ensure_loaded` 与 `metrics`：实际载入期间提供 `live.state=loading`、`load_elapsed_s`，成功和异常退出均清除；不依赖可选请求正文采集，不修改上游文件或发起推理。
- 主状态栏显示载入动画与实际已用秒数，载入状态优先于排队数和 `health.loaded=false`；浮条、托盘及内部实验任务栏呈现保留转换状态并抑制旧吞吐。
- 官方 Strata 0.1.44 CPU HTTP 夹具 **36/36** 通过、无跳过，包括空闲卸载后的并发自动重新载入、READY 后清除和失败时保留原 503。Core 定向回归 **25/25**、监控历史回归 **9/9**、Rust 转换状态回归 **2/2** 通过；Core 类型检查和 Desktop 生产构建通过。
- Playwright CLI 使用真实 App 与隔离原生 IO，中文 560px、英文 900px 和浮条三组全部通过；覆盖已卸载→载入→读取→生成，以及载入失败和采样失败，真实生命周期写操作为 0。截图位于 `output/playwright/model-reload/`，回放为 `apps/desktop/tests/optimization/verify-model-reload.cli.js`。
- 仅为源码与隔离夹具验证，未更新已安装应用、未重启 supervisor 或真实模型；新增 observer 信号随更新后的服务进程下次启动生效。真实 GPU 自动载入与 Windows 原生窗口仍待安装版验收。

## 2026-10-13 控件细节与最终官网记录

- 新增未发布样式提交 `0497b6c77fafededcebab671c0b31f6240d4e394`：工作区及 API 用量切换器恢复圆角分段样式，选择控件保留绿色底色和白色环线、去掉外扩光晕。
- desktop 类型检查和生产构建通过，桌面测试 **110/110**。构建保留既有 chunk 大小和 Tauri 动态/静态导入提示。浏览器核对浅色/深色 `box-shadow: none`、Tab 外框 14px；820px 下无页面横向溢出，Tab + Enter 正常切换设置页面。
- 两张中英文开发版截图与 `manifest.json` 位于 `docs/screenshots/ui-refinements/`，源码绑定上述提交；PNG 与无损 WebP 逐像素一致。原有 v0.1.7 截图保持不变。
- 官网文档与资源检查 **34 passed / 0 failed / 2 skipped**，2 项为显式外网场景；本地静态构建验证 **15 篇文档、818 个本地链接/资源**。修正截图目录中的 README/manifest 被误当作图片资源的问题，新增回归先失败后通过；证据文件保持链接到 GitHub，WebP 使用官网资源路径。
- 补核前序收尾：[官网部署 38404492411](https://github.com/hongfaqiu/strata-manager/actions/runs/38404492411) 已成功，对应公开文档提交 `489c964287775356c7ee7957d509345c260a9a5c`；该文档提交与本地历史 `d734795` 的 Git tree 相同。此次仅将新增样式提交接到远端历史，未重做 v0.1.7 发布或改写发布 tag。

以下带“发布前历史记录”的章节保留当时的检查结果；当前发行状态以“v0.1.7 正式发布”一节为准。真实 GPU 容量/长时与跨设备 LAN 等未验证范围仍然有效。

## 2026-10-13 v0.1.7 正式发布

- [v0.1.7](https://github.com/hongfaqiu/strata-manager/releases/tag/v0.1.7) 于 2026-10-13 13:06:22 UTC 公开，稳定更新通道已指向该版本。不可变 tag 源码为 `62192c11876d337e2637fe5141f9f57c06717adf`。
- [完整 CI 38399951175](https://github.com/hongfaqiu/strata-manager/actions/runs/38399951175) 的 attempt 1 **10/10 jobs 成功**：两平台桌面构建、六个原生测试分片、两个 Strata 0.1.44 observer job，包含 Windows 安装／启动／IPC／卸载与 Linux AppImage／DEB 的 Xvfb 启动验收。
- [发布工作流 38402053776](https://github.com/hongfaqiu/strata-manager/actions/runs/38402053776) 成功复用该 CI 的三个原始安装包，仅追加 Tauri updater 签名、`latest.json` 和 `SHA256SUMS`。发布前已下载草稿的全部实际资产并验证公钥、签名版本与原始字节。
- 13:18:20 UTC 独立公开核验通过：8 项资产的大小与 GitHub digest 全部相符；三种安装包的 SHA256 与 CI 字节证明相同，内置公钥验证器再次验证更新签名及签名版本 0.1.7。公开 `releases/latest/download/latest.json` 与版本资产完全一致，五个平台／别名均指向本次安装包及对应签名。大文件通过公开地址分段下载后重组并核对完整 SHA256，没有绕过 TLS。
- 本地证据为 `output/release-v0.1.7/public/verification.json`、`ci-evidence.json` 和 `ci-byte-proof/proof.json`；发行源码与后续官网文档状态更新分开记录。

| 公开安装包 | 字节数 | SHA256 |
| --- | ---: | --- |
| Windows x64 NSIS | 12811429 | `3bf6d6e1bfef2062b39bfe9d42c94597d10e13f937fddb6ae943bfb4b59560a6` |
| Linux x64 AppImage | 95730168 | `8a0f2e57d745cc744eac8370e2434608d96e9145765cd9eda73d04696b022c7f` |
| Linux x64 DEB | 18146446 | `a0440cddea5d884f9dfcb8b2af19182f8598b3f23cf3c7e8e6d1c858e142e889` |

本轮没有启动本机真实模型或操作已安装应用。真实 GPU 容量／长时稳定性、跨设备 LAN、完整原生窗口交互及用户设备上的跨版本升级仍待独立验收。回退时使用既有 v0.1.6 的完整签名发行包，先备份应用数据；不改写版本 tag 或覆盖既有资产。

## 2026-10-13 v0.1.7 发布准备（发布前历史记录）

- 版本、Cargo 锁文件与中英文更新日志已同步为 0.1.7。`release-check --tag v0.1.7`、`cargo metadata --locked --no-deps`、Rust 格式检查通过。
- 候选的 `pnpm check` 通过：448 项测试、类型检查和前端生产构建成功；发布合同测试 **194/194 passed，无跳过**，包含实际公钥验证器的篡改／错误签名拒绝测试。日志在 `output/release-v0.1.7/`。
- 上一源码 `51ab62f290ca8ebe53c2a537ab20bb9f0734e26b` 的 CI 两平台均因 PNG 导出分支格式检查失败，尚未产生可发布安装包；已按 rustfmt 修正。这是下方早前本地格式记录之后的补正，不把旧 CI 视为通过。
- 首次候选 `d38be3794f11945c086215859c0f588d1b59773e` 在 CI Rust 1.99 的 Clippy 检出 LAN 地址枚举仅使用映射值；已等价改用 `values()`。本机工具链为 Rust 1.94，本地 Clippy 结论不替代 CI 新工具链检查。
- 修正后共享配置回归 **5/5 passed**；补齐 v0.1.7 更新日志的六张离线截图与封闭路径注册，相关回归 **12/12 passed**，生产构建的六张图片均与源文件 SHA256 相同。最终 `pnpm check` 为 **449/449 passed**（Core 318、Desktop 110、脚本 21），类型检查和生产构建通过，日志为 `output/release-v0.1.7/check-final.log`。
- 后续候选 `d2c13387ddbe3281788d0dbc2aba9f0093c2bb02` 的 Windows Clippy 已通过；Linux 的资源评估发现可变 GPU 列表仅在 Windows fallback 中修改，已将可变声明限定到 Windows。仍须以最终同源码的完整两平台 CI 为发布依据。
- 发布复用门禁纳入新增的 Windows/Linux Strata 0.1.44 observer jobs，必须同源码、同 run、同 attempt 的全部十个 job 及安装包验收通过。候选等待新的完整 CI、签名发布与公开下载核验。
- 页面示例沿用下方已记录的版本号更新前截图，原始 capture HEAD 和 source hash 保持不变；截图不构成 0.1.7 安装包或 GPU 推理验收。

## 2026-10-13 收尾复核（发布前历史记录）

本轮仅使用隔离浏览器、测试夹具和构建，不启动真实模型，不操作已安装应用或原生窗口。下载页在原会话交接后单独整合；以下实测与历史记录分开。

- 最终 `pnpm check`：Core **318**、Desktop **109**、脚本 **21**，合计 **448/448 passed**；类型检查和前端生产构建通过。包含白色亮环追加样式。日志为 `output/finishing/final-check.log`；保留现有 chunk size/Tauri 导入警告。
- 日常流程浏览器 **7/7 passed**：资源选择、停止诊断、已保存但需重启的能力／PID变化失效、文本／工具／图片验证、共享保存、聊天请求证据及英文深色窄窗。日志为 `output/finishing/final-daily-browser.log`。
- 下载工作区浏览器最终 **13 项通过**，其中搜索返回断言跨过 HMR 后已定向重跑；明暗／窄窗、公共配置保存取消重载、任务参数快照、磁盘不足和保存失败均有隔离记录。见 `output/playwright/model-download/results.json`。白色选择控件的方向键、Space、焦点和禁用状态另见 `output/playwright/selection-controls/`；forced-colors 仅静态检查。
- `pnpm desktop:debug` 成功生成 `output/dev-desktop/StrataManager-dev.exe` 与同目录后台。默认 host 产物路径、独立 dev 标识和嵌入前端已核对，8 项构建路径合同测试包含在上述脚本测试中；跨目标实际编译、离线实窗和签名发行未验证。日志为 `output/finishing/final-debug-build.log`。
- 最终文档截图 **16/16**、中英明暗 800px 窄窗 **32/32**、PNG/WebP 像素一致 **16/16**。下载图使用真实 1440×1200 视口，完整资源卡片与底部操作区间隔 16px；其它图为 1440×960。修复了英文历史报告选择框的内部裁切，并补控件边界断言。来源为隔离真实组件，API 使用统计图来自独立 ApiUsagePage 场景；详情存于 `docs/screenshots/manifest.json` 的 `dailyExperienceUnreleased`，最终源码摘要为 `6dc7793fa75b24f4e659d723a09ede5962f555cfd28f21344f30e3f562285640`。
- 官网本地中英×1440/375×明暗 **8/8**、新图放大 **24/24** 通过，覆盖键盘开启／关闭、焦点返回、语言与主题保持和溢出检查。静态构建为 **15 篇文档、812 个本地链接／资源**，下载元数据使用真实公开 v0.1.6。此记录与部署后的公开内容核验分开。

- Runtime 串行运行：**420 passed / 5 failed / 11 ignored**。5 项失败均缺少固定上游夹具，日志为 `output/finishing/native-runtime.log`；不能称为一次完整通过。
- 补齐私有 Python 测试环境及固定 `fb58e0dbc8399662c0e47c76578c6e878b14f6cf` 内容后，request-capture **9/9 passed**，日志为 `output/finishing/native-capture.log`，不与前项合并计数。
- 固定 Strata `ed4773eb7c8f1f1531ba2bc70e0e1987de2661af`（0.1.44）源码，observer loopback HTTP **33/33 passed，无跳过**，使用 MockEngine，无模型权重／GPU；日志为 `output/finishing/observer-0.1.44.log`。
- 诊断包装回归先复现非对象 `details` 导致 panic，修复后 **9/9 passed**；现在只保留非对象详情的类型标记，并保留原错误码、消息及状态。PNG 原生导出 **5/5 passed**，日志为 `output/finishing/png-native-tests.log`。
- Windows Tauri / runtime-core `cargo check --locked` 和 Rust 格式检查通过，日志为 `output/finishing/native-check.log`、`native-fmt.log`。
- 最终严格工作区 Clippy（`--locked --workspace --all-targets -- -D warnings`）通过，日志为 `output/finishing/native-clippy-after.log`；修正后四个原生模块定向 **23/23**、PNG **5/5** 通过。测试中的串行锁改为 async 锁，生产归属锁未改变。
- 官网文档、双语 SEO、发行元数据及截图合同 **33 passed / 0 failed / 2 skipped**；2 项需要显式网络测试环境，本地未执行。日志为 `output/finishing/website-tests.log`。
- 独立 Benchmark 浏览器 **29/29 passed**，覆盖停止状态、运行前复查、外部加载、取消、模型切换、旧历史和中英窄窗口。日志为 `output/finishing/benchmark-browser.log`，JSON 为 `output/playwright/benchmark-compact/browser-results.json`；SSE 与指标来自隔离夹具，不是 GPU 性能证据。

能力状态、聊天首正文计时、历史可比性及开发构建路径的专项测试已补入默认 JS 检查。原生文件身份目前是 metadata，未核验内容摘要，因此真实历史可并列展示，但不能据此直接宣称提速。真实 GPU A/B、长时、跨设备 LAN、离线 Tauri 实窗及签名发行仍未验收。

## 2026-10-13 日常体验增量（发布前历史记录）

### 浏览器 Vite 验收

按用户要求仅在应用内浏览器操作 Vite 隔离页面，未操作原生窗口、启动真实模型或写真实配置。检查资源风险随选择变化、未启动时禁用在线验证、能力与来源说明、API 分阶段结果、聊天 TTFT/首正文/请求标识、失败诊断以及历史条件对照。样例数据不代表真实 GPU 或 LAN 结果。

本轮发现并修复两处布局问题：API 弹窗标题原位于 24.8px、被 64px 标题栏覆盖，修复后位于 88.8px；三列对照表继承 860px 最小宽度，修复后容器与 scrollWidth 同为 927px，无多余横向滚动。补齐隔离 benchmark_identity，以及 /load、/unload 等变更请求的拒绝/计数。证据位于 `output/playwright/browser-only-acceptance/`；Vite 标签页与服务保留供用户检查。

开发版直接打开拒绝连接的原因是原始 Cargo debug 构建仍使用 `devUrl`。已新增 `pnpm desktop:debug`，通过 Tauri CLI 的 custom-protocol 构建嵌入前端，使用独立 dev 标识，输出 `output/dev-desktop/StrataManager-dev.exe` 及刚构建的独立后台。构建成功；关闭 Vite 后尝试实窗验收时用户再次以 Esc 停止 Computer Use，未宣称离线窗口已验收。本轮测试窗口已清理，保留构建和启动日志。

实现范围见 [日常体验增量](DAILY_EXPERIENCE.md)。原有未提交修改保留，未操作已安装应用的更新或真实模型配置。

- `pnpm typecheck`、生产前端构建通过；JS/Core 273、Desktop 104、脚本 13，共 390 项通过。资源面板测试已纳入默认 desktop test。
- 新增日常流程浏览器 6/6 通过：停止诊断、资源选择、文本/工具/图片 API 验证、共享预览保存、聊天请求证据及英文深色窄窗口。
- Benchmark 浏览器 29 场景：28 项整组通过，1M 初始状态用例定向复核通过；等待异步状态及 schema/新增控件断言已适配。不能把合成 SSE 当作真实 GPU 性能。
- Windows 原生编译和调试应用/后台构建通过。Runtime 串行检查 420 项通过，5 项因缺上游夹具失败；配置固定 revision `fb58e0dbc8399662c0e47c76578c6e878b14f6cf` 后 request-capture 9/9 通过。并发假服务的进程清单竞争记录另保留，不放宽生产归属检查。
- WSL Ubuntu 20.04 资源规则 6/6 通过；无桌面 Secret Service 环境的鉴权夹具需要隔离测试凭据提供器，结果须以最终定向日志为准。
- 原生验收采用独立应用标识和数据目录以避开已安装实例，调试资源连接后用户以 Esc 停止 Computer Use。本轮隔离 UI/开发服务已清理；完整 Tauri 点击、真实 GPU 长时、跨设备 LAN 和统一发行未完成。

证据：`output/daily-experience-js-tests.log`、`output/daily-experience-native-tests.log`、`output/daily-experience-capture-tests.log`、`output/daily-experience-benchmark-browser.log`、`output/playwright/daily-experience/results.json` 和 `output/daily-experience-native-ui/`。不同运行及补测不合并宣称一次完整原生全套通过。

更新日期：2026-10-12。上游参考 revision：`fb58e0dbc8399662c0e47c76578c6e878b14f6cf`。

本文件区分本轮独立后台实现与此前原型验证。自动检测/导入、运行时准备、元数据统计、调优、自启动与更新已经进入实现和测试阶段，不再只是方案；实现存在、夹具通过、真实 GPU 运行、最终安装包和跨版本更新是不同验收层级。下面记录阶段证据，最终提交后仍需统一检查及真实发布验收。

## 0.1.4 提交前验证与发行门禁

以下记录 2026-10-12 在 0.1.4 提交前完成的本地分项检查，整合基底为 `f579311205364c503fa1560fb594d8082ba773a3`。日志与浏览器 JSON 保存在工作目录，不随安装包发布；各项不能累加为一次完整原生测试。历史版本、CI 优化分支及此前实机验证继续保留在后文。提交后的 CI 和发行证据以源码 SHA 及公开资产核验为准。

| 检查 | 实际结果 | 证据 |
| --- | --- | --- |
| 前端与核心检查 | `pnpm check` 的类型检查、生产构建通过；核心 196、桌面 95、HTTP/日志 8，合计 **299 项通过、0 失败** | `.local/release-0.1.4/final-check.log`；独立较早的构建记录另见 `final-build.log`，不重复计数 |
| 发布与 CI 门禁合同 | **228 passed / 0 failed / 0 skipped**；覆盖缓存政策、源码/产物身份、run attempt、两平台测试分片覆盖、精确外部验收名单、签名及安装/升级门禁逻辑 | `.local/release-0.1.4/final-release-guards.log`；早期 `final-guards.log` 单列，不与本次数量相加 |
| 网站与文档合同 | **27 passed / 0 failed / 0 skipped**；覆盖文档渲染、双语首页/SEO、版本选择、发布快照及缺失链接/资产拒绝 | `.local/release-0.1.4/final-website-tests.log` |
| 公共设置浏览器流程 | **12/12 passed**；覆盖公共入口、无模型编辑、继承/旧专用值、参数抽屉模型隔离与晚到保存、MCP/结构化输出、重载及导航草稿保护 | `.local/release-0.1.4/final-common-settings.log`、`output/playwright/common-settings/browser-results.json` |
| 引擎下载浏览器流程 | **26 个流程通过、0 浏览器错误**；覆盖来源、自动匹配包、包信息、来源测试、确认/取消和窄屏展示 | `.local/release-0.1.4/final-runtime-download.log`、`output/playwright/runtime-update-download/results.json` |
| 状态故障与恢复浏览器流程 | **7/7 passed，0 原生变更操作**；覆盖同 PID 健康恢复后等待新指标、正常后台刷新保留显示、指标失败隐藏旧值，以及中英文运行/停止缓存下的进程查询失败 | `output/playwright/service-status-faults/results.json`；临时故障注入按独立 query 触发，保存 query 时间戳与 DOM 证据 |
| Rust Clippy | 0.1.4 runtime-core、desktop 与 Supervisor 检查完成，无 Clippy 错误 | `.local/release-0.1.4/final-clippy.log` |
| Rust 格式 | `cargo fmt --all --check` 通过 | `.local/release-0.1.4/final-fmt.log` |
| 正式文档截图与产品封面 | **36/36** 中英文截图通过；无页面/控制台错误、外部请求、禁止原生操作或页面横向溢出；WebP 与 PNG 逐像素一致。两个产品封面及英文别名哈希通过，关键新增界面完成目视检查 | `output/playwright/release-0.1.4/capture-2026-10-11T21-20-51-409Z/capture-checks.json`、`output/playwright/product-hero/validation.json`、`docs/screenshots/manifest.json` |
| 完整静态官网构建 | **15 篇文档、682 个本地链接/资源**验证通过 | `.local/release-0.1.4/final-website-build.log`；此项不替代部署后的公开检查 |
| 官网本地浏览器 | 中文/英文 × 1440/375 共 **4/4** 通过；20 次新截图解码和放大、键盘焦点/关闭、双语系统说明导航正常，无横向溢出或浏览器错误。下载列表仅使用合成 0.1.4 元数据核对链接 | `output/playwright/release-0.1.4/website-local-2026-10-11T21-24-24-054Z/results.json`；前后构建摘要一致，服务器与浏览器已关闭 |

公共设置、下载、状态故障与独立浮条的浏览器证据使用真实 React 组件和隔离合成 Tauri RPC；保存/重载使用浏览器夹具持久化，服务、指标、密钥和窗口命令仍为模拟数据。独立浮条另有 `output/playwright/service-status-trends/floating-results.json`，其 scope 明确未认证原生置顶行为。以上证明对应界面状态和调用合同，不能据此标记系统凭据写入、真实引擎下载/升级、Windows 浮条拖动/置顶/关闭、真实桌面后台生命周期或模型 API 请求已经通过。发布脚本的合同检查也不等于 GitHub Runner 已实际完成本次包安装与升级。

真实桌面与真实请求必须另行绑定实际安装版本/二进制、进程归属和请求结果。后文 `output/windows-real-test` 的 0.1.3-test.2/test.4、特定 Windows Strata 引擎更新和真实短请求继续属于其各自版本与环境，不作为最终 0.1.4 包的同源码验收；真实 GPU Benchmark、完整调优、长时间压力、Linux 系统级 DEB 安装及 Tauri 客户端跨版本在线更新仍需各自的实测证据。

**提交后的发行门禁：** 必须取得最终源码同 SHA、同 attempt 的完整 Windows/Linux **8 个 CI job 成功**，再复用已核验产物签名发布。发行后核对 tag→commit、稳定 latest、8 个资产及下载字节/大小/SHA256/GitHub digest、三个安装包签名和 signed version、`SHA256SUMS` 与 `latest.json` 精确链接；官网须等待部署完成，再检查下载版本、双语文档、全部截图的公开字节/哈希及浏览器展示。本节是提交前证据，不预先宣称这些发布后步骤通过；实际结果见 [Actions](https://github.com/hongfaqiu/strata-manager/actions) 与 [v0.1.4 Release](https://github.com/hongfaqiu/strata-manager/releases/tag/v0.1.4)。

0.1.4 首轮提交 `81e0ec35c266951c0d0badf6fe2c3ae8ce42b9ac` 的 [CI 38176396349](https://github.com/hongfaqiu/strata-manager/actions/runs/38176396349)未通过：Linux 严格 Clippy 发现 Windows 测试辅助函数的平台条件缺失，两平台精确 ignored 政策也未登记两个新增的显式外部验收夹具。修复将辅助函数限制为 Windows 测试，并按精确名称登记外网来源只读检查和显式 Agent 源文件静态检查；旧名单和默认离线测试保持，未知名称仍拒绝。修复后的本地严格 Clippy、格式及 228 项发行合同通过，最终完整 CI 仍须绑定修复后的源码重新执行。

后续源码 `3fc9adffdad8f59e0550557ce54535139c017b6b` 的 [CI 38177234879](https://github.com/hongfaqiu/strata-manager/actions/runs/38177234879)通过 Linux Clippy，但 Linux 原生分片发现浮条只读测试的平台断言错误：Unix IPC 客户端会创建空的私有 `.ipc` 目录，Windows 则保持空根目录。测试修复保留 Windows 空目录要求；Unix 严格核对根目录仅含 `.ipc`、真实非符号链接目录、当前用户所有、权限 `0700` 且目录为空，不允许套接字、锁文件或数据库。生产行为未修改，本地四项浮条合同、格式和严格 Clippy 通过；修复后的 Unix 分支仍由最终完整 CI 验证。

应用源码 `a2f8f78aa71914178a306a6458518ec4a0be8e01` 的 [最终 CI 38177753892](https://github.com/hongfaqiu/strata-manager/actions/runs/38177753892)在同一次 attempt 1 完成全部 **8/8 job 成功**，包含六个完整原生分片及 Windows/Linux 安装包门禁。Linux 日志实际确认修复后的浮条只读断言和调用白名单通过；Windows 安装、GUI、后台 IPC、正常退出与卸载通过。升级工具合同测试通过，但实际 beta.2 升级步骤仅对 0.1.2 执行，本轮 0.1.4 按版本条件跳过，不能记录为实际跨版本升级验收。`v0.1.4` 标签固定指向该应用源码。

首轮 [Release 38178757394](https://github.com/hongfaqiu/strata-manager/actions/runs/38178757394)成功复用同源 CI 并完成三个安装包签名，但创建 draft 的 `gh api --input -` 命令失败，未留下该版本的 Release 或资产。发布控制器的统一子进程包装器将标准输入设为 `ignore`；真实 Node 子进程实测确认传入 JSON 收到零字节，而 `pipe` 可完整传递。修复只让显式请求体走 `pipe`，无输入仍关闭 stdin，并补充真实子进程合同；原始 GitHub stderr 已被旧包装器丢弃，因此不推断具体 HTTP 错误。恢复发布使用新 main 控制器及显式应用标签、源码 SHA 和 CI id，保留应用标签与所有签名、资产和发布门禁，不重建或移动已验证的应用源码。

修复控制器的本地发行与 CI 门禁合同 **232 passed / 0 failed / 0 skipped**，证据为 `.local/release-0.1.4/controller-release-guards.log`。新增四项真实子进程合同覆盖 POST/PATCH Unicode JSON 字节完整传递、无输入立即 EOF，以及失败不泄漏请求体或敏感 stderr；这不替代重新执行的发布任务和公开资产核验。

新控制器的 [发布任务 38179212470](https://github.com/hongfaqiu/strata-manager/actions/runs/38179212470)实际创建了空 draft `409952505`，但 GitHub 的说明刷新响应将缺省标签改为 `untagged`，被精确草稿校验拒绝，未上传或公开资产。控制器随后让 POST/PATCH 共用完整草稿元数据，显式保留应用标签、`draft=true` 与稳定/预发布状态；真实子进程合同同时检查稳定版和预发布版完整请求体。该空草稿仅在核对 id、来源日志、应用更新日志、零资产及前后不变的应用源码标签后恢复为 `v0.1.4`，保留所有后续上传与公开验证门禁。

最终发布控制器 `ed8c93b7d688472b3283e221a7bc26ef78203d70` 的 [CI 38179609349 attempt 2](https://github.com/hongfaqiu/strata-manager/actions/runs/38179609349/attempts/2)完成 **8/8 job 成功**。attempt 1 的 Windows 安装包验收在 PowerShell 查询上达到原有 15 秒期限；重跑完整 CI 后，实际 GUI/协议与版本、sidecar 字节身份、空私有存储、正常退出及安装/卸载全部通过，未修改产品或放宽期限。真实旧版本升级步骤仍按上述版本条件跳过。

[发布任务 38179620747](https://github.com/hongfaqiu/strata-manager/actions/runs/38179620747)使用该控制器，复用应用源码 `a2f8f78` 的完整 CI 安装包，正式公开 [v0.1.4](https://github.com/hongfaqiu/strata-manager/releases/tag/v0.1.4)（Release id `409952505`，公开时间 `2026-10-11T22:16:17Z`）。八个资产实际公网下载的大小、SHA256 和 GitHub digest 一致；三个安装包签名及 signed version `0.1.4`、`SHA256SUMS`、`latest.json` 精确链接、稳定 latest 和 tag→commit 核验通过。发布产物中的字节证明与原 CI attempt 1 的三个安装包及公开资产一致。证据为 `.local/release-0.1.4/evidence-2026-10-11T22-16-52.006Z-0c62749f/verification.json` 与 `byte-proof-verification.json`，应用标签和资产未被重建或替换。

[官网部署 38179827062](https://github.com/hongfaqiu/strata-manager/actions/runs/38179827062)完成后，公开十份双语页面的 HTTP 及内容检查通过并记录字节与哈希；全部 39 张截图/封面与源码的字节及哈希一致，下载元数据对应上述稳定 v0.1.4。中文/英文 × 1440/375 × 首页/指南/系统说明/更新日志共 **16 个公开浏览器场景通过**，无页面异常、站内 HTTP 错误或横向溢出。证据为 `.local/release-0.1.4/public-website-verification.json` 与 `output/playwright/release-014-public/browser-results.json`；这些结果仍不替代真实 GPU Benchmark、完整调优、长时压测、Linux 系统级 DEB 安装或客户端跨版本在线自动更新。

## 0.1.2 发版准备与 0.1.1 未公开记录

- **新候选为 0.1.2，尚未公开。** 版本、当前用户文档、官网默认日志入口与 Windows beta.2 升级门禁已同步；完整 Linux 原生测试改为串行执行，后台生命周期夹具补充启动诊断。测试断言、原就绪期限、生产资源/质量/身份门槛、Clippy、签名及安装门禁保持。须在冻结后记录本次同源码 Windows/Linux CI、签名 Release、公开资产及实际验签结果，不能归用旧版本的通过证据。
- **0.1.1 同源 main CI 已通过，签名发布未通过。** 源码 `33190cf6294ae11787f40b0f5fd6dc29e072cee3` 的 [main CI 38100739579](https://github.com/hongfaqiu/strata-manager/actions/runs/38100739579)两平台成功；Linux 完整原生 288 项通过、0 失败、4 项显式 ignored，三个后台生命周期合同均通过，AppImage 和解包 DEB 的实际 GUI/私有 IPC/关闭门禁通过。[签名 Release 38102509861](https://github.com/hongfaqiu/strata-manager/actions/runs/38102509861)的 Windows 构建、安装和 beta.2 升级门禁成功，但 Linux 原生核心 226 项通过、0 失败、3 项显式 ignored 后，三个后台生命周期测试均在首次 IPC 就绪检查约 5.2 秒后失败，publish 跳过。`v0.1.1` 标签保持指向上述源码；该版本未公开，不能称为可下载稳定发行。
- **实际启动失败原因尚未确定。** 旧夹具丢弃子进程 stderr，没有记录退出状态或最后一次 IPC 错误，日志只证明初次就绪检查到期。后台在 IPC 监听发布前同步读取完整自身二进制计算 SHA256，三个 debug 后台并发冷启动的资源竞争仅为待验证假设。Release 命中 main CI 的依赖缓存，但测试前重新编译了 debug supervisor；测试固定使用 Cargo 的二进制，没有 release 路径回退或 `STRATA_SUPERVISOR_TEST_BIN` 选择。当前没有证据确认 keyring、缓存损坏或旧产品二进制为故障原因。

### 0.1.2 候选的本地文档与版本检查

`node scripts/release-check.mjs --tag v0.1.2` 通过；18 项版本日志、官网和文档合同通过，网站构建核验 11 份文档与 401 项本地链接/资源。两份 workflow 的 YAML/actionlint 与 diff-check 通过，旧 actionlint 仅精确忽略既有 `queue: max` 字段兼容错误。自动 diff 核验确认 workflow 只更新 beta.2→0.1.2 的条件及 Linux 串行测试参数；完整双语功能日志已移入 0.1.2，0.1.0 和 beta 的日志内容保持，pnpm 依赖锁未变。这些局部检查不证明本候选已通过完整原生测试、CI 或签名发行。

本候选的本地 Windows 隔离后台生命周期测试串行执行，3 项通过、0 失败、0 忽略，耗时 72.06 秒；场景内部并发、单实例、服务恢复和 ACK 退出断言均保留。工作区 `cargo clippy --workspace --locked --all-targets -j 1 -- -D warnings` 通过，使用本候选实际编译的 Rust 验签器运行发布合同，82 项通过、0 跳过。以上不替代新候选的 Linux、最终安装包、公开资产或客户端在线更新验收。

## 0.1.1 历史准备与前次失败记录

- **0.1.0 最终源码的两平台 CI 已通过。** `ecb21a492fbe8acd285ec8ef33c58cbf4867607d` 的 [CI 38094958613](https://github.com/hongfaqiu/strata-manager/actions/runs/38094958613)成功：Windows 原生 354 项通过、0 失败、11 项显式 ignored；Linux 288 项通过、0 失败、4 项显式 ignored。实际 NSIS 新装/GUI/私有 IPC/关闭/卸载及 beta.2→0.1.0 离线原位升级与私有 KV 保留通过；Linux AppImage、解包 DEB 的 GUI/IPC/关闭检查通过。
- **v0.1.0 未公开。** [签名 Release 38096197942](https://github.com/hongfaqiu/strata-manager/actions/runs/38096197942)首次 Windows 测试在失败恢复夹具的推荐前置条件失败；诊断显示实际墙钟噪声下生产评估器正确拒绝不可靠收益。仅执行了一次定向重跑，第二次在重启 worker 夹具的推荐前置条件失败，未记录足以断定噪声来源的详细评估数据。两次均为 274 项通过、1 项失败、8 项显式 ignored，publish 跳过。原标签指向上述源码并保持不变；包含 Linux 产物的草稿不作为公开发行。
- **同次 Linux 签名打包通过。** 原生 288 项通过；AppImage 和解包 DEB 的实际 GUI/私有 IPC、包版本、后台载荷哈希、正常关闭与后台退出检查通过。它不能替代缺失的 Windows 成功结果。
- **0.1.1 曾作为首次稳定版候选。** 真实私有 HTTP A/B/A 测量及原报告保留并验证统计决策；应用/恢复合同使用另一个 UUID、显式标记且引用实测来源的合成计时报告，由原有统计评估器和公开 apply 门禁判定。收益阈值、资源/质量/身份检查、时间限制及发版门禁保持；最终同源 CI 与未公开的签名发布结果见上节。
- **首次 0.1.1 CI 发现完成阶段竞态。** `23825d7fe45ca3a1f5ae88bc42eea23ea017d796` 的 [CI 38099998722](https://github.com/hongfaqiu/strata-manager/actions/runs/38099998722)中 Linux 核心 224 项通过、2 项失败、3 项显式 ignored。两次失败均为新增原报告语义不变断言，磁盘字节不变断言已通过；完整诊断只有完成/更新时间相差 4/6ms，其他字段一致。成功测量已经持久化 Completed 后，外层成功回调再次写时间；修复为成功保留内层终结结果，错误/取消继续原有最终状态与恢复诊断更新。原有字节及语义 exact 断言保留，不以容差或延时掩盖差异。该源码未创建版本标签或公开发行，修复仍使用 0.1.1 并重新执行同源码全量 CI。

### 0.1.1 本地定向验证

三项真实 HTTP 与公开事务合同在 0.1.1 下均通过：完整请求 A/B/A 与采用/恢复、采用失败与恢复失败、worker 重启参数及恢复。每项同时校验实测报告原字节不变及合成夹具拒绝不完整、质量失败、缺计时、未知/高压资源、旧基准身份；重启项额外拒绝缺失启动核验。没有新增跳过或放宽超时。workspace Clippy `-D warnings`、格式/diff 检查通过；实际 Rust 验签器执行的 82 项发布合同全部通过、0 skipped；18 项版本日志/官网/文档合同通过，网站构建验证 401 项本地链接与资源。以上为本地定向结果，完整 CI 和公开发布仍须记录其实际运行结果。

消除成功回调重复终结后，上述三项及现有短请求 A/B/A、公开采用/恢复和无收益拒绝合同共四项定向通过；报告 exact 断言保持。再次通过 workspace Clippy/格式检查，变更后的双语版本日志与文档合同 9 项通过，网站 401 项本地链接/资源核验通过。这些局部结果仍不代替修复提交的两平台完整 CI 与签名发布。

## 历史公开发布证据与 0.1.0 候选

- **v0.1.0-beta.2 已公开发布。** 对应源码 `0db2fea5128144fe2fe00cca992bd5139c831508`；[签名发布流水线](https://github.com/hongfaqiu/strata-manager/actions/runs/38080808731)的 Windows、Linux、publish 均成功。[发布页](https://github.com/hongfaqiu/strata-manager/releases/tag/v0.1.0-beta.2)的公开时间为 `2026-10-10T20:25:24Z`，共有八项资产：NSIS、AppImage、DEB、三份 Tauri 签名、`latest.json`、`SHA256SUMS`。发布门禁已执行真实更新包验签及资产/元数据检查；beta.2 不替换稳定 `latest` 通道。
- **后续 main CI 已通过。** 源码 `ac16c4ce537b7e42e976c04791c3bad907f2c7ea` 的 [Windows/Linux CI](https://github.com/hongfaqiu/strata-manager/actions/runs/38088221840)均成功，包含隔离的原生私有凭据库、安装包 GUI、私有后台 IPC，以及 Windows 新装/关闭/卸载门禁。Linux 包在 Ubuntu 22.04 Xvfb/DBus 下启动 AppImage 和解包 DEB；这不等于系统 DEB 安装、真实登录或 GPU 模型验收。
- **0.1.0 候选已冻结，本地检查通过。** 全部共享编辑完成后，候选快照及版本已同步。本地结果见下一节；上述历史 revision 的 CI 结果不能归到此候选。正式版仍须记录本次提交的 Windows/Linux CI、签名 Release、公开资产及验签结果。本文中新增下载入口和功能说明不构成该候选已经公开发布的证据。
- **跨版本检查分开记录。** NSIS 将旧版覆盖安装为新版、文件/注册项和私有 IPC 检查，与 Tauri 客户端检查更新、从正式端点下载、验签、执行原生安装、后台接续和真实模型/API 恢复是不同合同。只通过安装器检查或发布侧验签不能将客户端自动更新端到端项记为通过。下述 Windows Strata 实机更新是局部验证；登录自启动、Tauri 客户端跨版本更新、其他 GPU/模型与 Linux 系统安装仍需各自的环境验收。

### 0.1.0 冻结候选的本地检查

2026-10-11，隔离发布工作树完成 `pnpm check`：前端与核心合同共 **180 项通过**，类型检查和生产构建通过。Windows 原生 `cargo test --workspace --locked -j 1 -- --test-threads=1` 共 **350 项通过、0 失败、11 项显式 ignored**：IPC 6、桌面 63、核心 271、独立后台进程集成 3、更新验签 7。单编译任务用于避免本机并行编译的内存不足，原有测试与时间限制未放宽。

显式 ignored 包括需单独授权的真实服务检查、下载与安装夹具、符号链接权限及 child-only TCP 夹具；最后一项由归属回归测试实际作为子进程调用。它们不记作常规全量测试通过。独立后台的冷启动停止状态、升级恢复及跨客户端持续运行检查通过，使用私有临时目录和 CPU 模拟引擎，不启动原有模型。

workspace fmt 与 Clippy `-D warnings` 通过；使用实际构建的 Rust 验签器运行发布门禁，**82 项通过、0 skipped**，覆盖 NSIS/AppImage/DEB 验签、版本与 tag/SHA 绑定、不可变公开版本、安装及 beta.2 升级合同。门禁单元合同不能替代 GitHub Runner 的实际安装、升级或公开资产验收。本地真实模型没有为构建释放或改变。

首轮冻结提交 `be27346b4ddf061a7a82dfe02cf872022923267a` 的 [Windows/Linux CI](https://github.com/hongfaqiu/strata-manager/actions/runs/38093701346) 未通过：Windows 原生核心测试 262 通过、9 失败、8 ignored；Linux 219 通过、3 失败、3 ignored。因此该提交没有创建正式 tag 或发布。后续修正按平台断言、HTTP 请求完成边界、空闲到期状态及资源采样等夹具条件进行；本地通过不能代替修正提交的完整两平台 CI 和发行包验收。

夹具修正后的 Windows 定向检查通过：空闲释放 **16 项**，ZIP 资产选择与重复请求 **2 项**，完整调优采用及失败恢复 **2 项**；请求诊断 **9 项**分别在本机 fallback 和 CI `pythonLocation` 模式通过，其中包括四项解释器及真实无依赖 venv 合同。统一 fmt、Clippy `-D warnings` 和 diff-check 通过。生产策略、资源/质量门槛与原有严格断言没有放宽，四份源码变动均限于测试；Linux 新平台拒绝分支和最终安装包仍由后续实际 CI 验证。

### 特定 Windows 机器的 Strata 0.1.42 实机更新

2026-10-11，在一台 Windows 机器上通过原生开发构建的后台 IPC 完成既有 Strata 从 0.1.41 到 0.1.42 的更新。使用上游 `strata-windows-x64.zip`（CUDA 13），大小 **137,300,495 字节**，SHA256 为 `bbf2fca32f98e490bc3c53c05c29136dcc53c606fbb619d842558ea69c50c9d6`；对应上游源码 commit 为 `61b3fb5dd3f1e8ec09cf7e4e05208bc6d3c46406`。实际更新任务为 completed、error 为空，检测返回 version=0.1.42、readiness=ready；旧失败任务仍保留 failed 状态。

安装后的 `setup.py`、`serve/server.py` 和三个引擎文件与解包暂存一致，原有 data 中的两份文件按保留策略未替换。**24 份原配置的 SHA256 全部不变**，原有模型和配置未删除。更新前正在运行的服务及已有模型加载状态恢复，健康结果为 status=ok、loaded=true、max_context=131072。这里的 131072 是恢复后的上下文配置值，不是填满 128K 上下文的容量或检索测试。

实际 `/v1/chat/completions` 短请求在 64 token 输出上限下返回 `OK`、finish_reason=stop；此前 16 token 上限请求只产生推理内容，未得到最终回答，不记作成功回答。只读检测阶段的原进程保持不变；真正更新后后台和模型进程已更换，不能将两个阶段混为一谈。

用户按 Esc 中止桌面自动操作后，最终核验通过后台 IPC 与本机 HTTP 完成，没有继续点击或视觉复核原生界面。该记录证明这台机器、这个已有模型的更新、配置保留、加载恢复和短 API 推理，不代表所有 GPU/模型、Linux、完整原生 GUI、调优收益、长上下文持续稳定性或 Tauri 应用自身跨版本更新已经通过，也不是最终 0.1.0 发行安装包的验收。

本机原始报告保留在忽略产物 `output/native-detection/verification.md`，更新与短请求记录为 `completed-update-proof.json`、`confirmed-update-retry-3-after.json` 和 `update-inference-smoke.json`。公开文档不收录机器绝对路径、凭证、私人模型标识或原始配置；这些实测结果不替代尚待记录的 0.1.0 最终候选 CI、签名发布与公开资产验证。

下方保留阶段历史。各段的“最新”“最终”指当段测试快照；测试数量、失败和待验证项不能跨 revision 累加或作为当前候选结论。

### 0.1.0 文档与官网定向检查（候选未冻结）

中英文 README、下载/使用/故障文档的当前下载入口统一为 v0.1.0；对应版本的中英文 CHANGELOG 已可由实际 `releaseNotes` 函数严格提取，beta.1 和 beta.2 历史保留。文档明确 Windows x64 ZIP 引擎更新边界、兼容受管运行时的 5/15/30 分钟 RAM 临时正文诊断、原 `api_monitor` 配置单独管理及 MCP 网络行为。

`node --test scripts/website-releases.test.mjs scripts/render-website-docs.test.mjs scripts/release-notes.test.mjs` **18 passed / 0 skipped**，其中官网新增 **9** 项合同测试调用实际生产目录选择函数，覆盖稳定 SemVer 优先、稳定版不存在时才回退预览、未知稳定端点不误判、其它仓库/缺失/重复资产拒绝、清除旧下载链接及首屏禁用。下载属性使用隔离 DOM 对象；不是浏览器、真实 GitHub 请求或客户端更新验收。`node --check website/app.js` 和限定文件 `git diff --check` 通过。静态站构建生成 **11** 篇用户文档，核验 **401** 个本地链接/资产。该范围不启动服务、GUI 或模型，也不把本轮候选视为已经通过跨平台 CI/签名 Release。

## 早期独立后台与本机流程

| 项目 | 已取得的证据 | 实际范围 |
| --- | --- | --- |
| 后台架构 | Rust workspace、独立 `strata-supervisor`、用户限定 IPC 与打包 sidecar 已实现 | Windows 使用 Job Object 管理子树；Linux 编译、隔离 IPC 和包启动后续已由上方 CI 记录，真实登录/GPU 仍需实机验收 |
| Core / IPC | 早期后端快照：Core **79 passed / 2 ignored**；此前 IPC 5 passed | 包括新模型准备后自动登记的 10 项测试；ignored 为只读本机发现及真实官方安装，真实安装另行显式运行。最终跨平台结果由 CI 单独记录 |
| Supervisor 生命周期 | `cargo test -p strata-supervisor --test lifecycle --target-dir apps/desktop/src-tauri/target`，2 passed，56.41 秒 | 真实后台进程与 Python HTTP 夹具：客户端退出服务继续、重复启动/重连、显式停止、有限 3 次恢复、后台硬崩溃释放 Job 子树、恢复时受控清理遗留维护 gate |
| 模型切换 | 同一生命周期测试覆盖双服务切换 | 繁忙时拒切换、目标加载失败恢复旧模型、成功切换维持单模型；夹具不执行 GPU 推理 |
| GUI HTTP 归属 | 后端报告 2 个新增所有权合同测试通过 | 未导入/未受管实例不能接收桌面变更；流式请求使用已登记且存活的受管身份。最终 workspace 总数待合并复验 |
| 后台包升级 | `cargo test -p strata-manager supervisor_client::tests --lib --target-dir apps/desktop/src-tauri/target`，1 passed，4.08 秒 | 真实 staged old/new Windows PE 切换与启动失败回滚，不等于正式 updater 下载/验签/安装 |
| 登录自启动 | `cargo test -p strata-manager startup::tests --lib --target-dir apps/desktop/src-tauri/target`，2 passed | 隔离 HKCU 测试键的真实写入/读取/删除、命令行转义；启动目标是后台，无真实注销/重登验收 |
| 官方运行环境准备 | `cargo test -p strata-runtime-core installation::tests --target-dir .local/install-test-target`，6 passed / 1 ignored；ignored 真实测试另行运行通过 | 危险路径拒绝、未知/不同文件保留、SQLite token + marker 归属校验、解包取消、下载 hash 失败、损坏缓存保留后重试、下载中取消 |
| 无 Git 真实准备 | 限制测试进程 PATH 到 Python 目录并确认 Git 不可用；显式运行 `official_archive_prepares_without_git_and_returns_only_a_setup_profile` | 使用 Rust HTTPS 下载固定官方 ZIP、安全解包、真实私有 venv/pip；27.46 秒完成；不下载模型、不登记未完成模型配置 |
| Python 来源校验 | 官方 Python 3.13.16 x64 安装器真实下载 29,935,584 字节，SHA256 与 Python.org .sigstore 元数据一致 | 仅校验下载；本机已有 Python 3.10.11，没有实际执行缺 Python 时的安装分支 |
| 格式与静态检查 | 本轮后台报告四 crate Clippy 通过；安装模块最终 `cargo clippy -p strata-runtime-core --all-targets --target-dir .local/install-test-target -- -D warnings` 通过 | 后续代码变更仍需在最终提交运行统一 fmt、Clippy 和 tests |

运行环境准备返回的 profile 只用于模型 setup。模型准备任务和意图在启动子进程前同事务保存；官方命令成功后，核验配置、模型资产及任务选择并自动登记，后台重开可恢复。失败、取消或资产不完整不会登记，多配置和旧快照冲突返回明确选择结果；保留当前选用模型与源文件，不自动启动或切换。新增 10 项夹具覆盖实际 setup RPC、Python 子进程、登记、跨重开恢复、去重、取消、非法候选和事务失败时不启动子进程。模型准备使用官方 `setup.py --yes --setup --no-start --no-browser` 流程，不重造模型下载器。Linux 缺少 Python/venv 时给出可行动诊断，不执行 sudo；此分支未实际验收。

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

完整场景实现另见 [中文调优指南](TUNING.md) / [English tuning guide](TUNING.en.md)：新增按日常聊天、编程 Agent、长文分析选择的有限任务、独立重启候选、A/B/A、启动参数核验、资源门槛和原配置恢复 journal。普通生成耗时与包含计数校准的任务总耗时分别记录，Agent 保留含工具处理的总耗时；完整推荐按实测漂移复验，不套固定百分比。未知资源／有效状态不当作通过；旧报告和短诊断不可新应用，历史已应用报告仍能恢复。

workload 的 **13 项隔离真实 HTTP 合同通过（0 ignored，6.91 秒）**，覆盖工具 SSE ID/index 与多轮参数、实际 Token 计数后的长文冷／热／会话、截断及语义拒绝、条件视觉、自身流取消、资源单位及归属、报告不含正文。实际 App + 内存 RPC 的初轮中英 × 600/1440 浏览器 **48/48 用例通过**，文档／页面溢出和错误为零；资源推荐门槛最后接线仍在定向复测。后端重启、故障和 journal 的最终定向及 workspace 结果在完成后追加。这里没有启动真实大模型、GPU 或默认本机服务，不据此声称完整 P3／生产安装验收通过。

以下保留较早的短请求实现证据，不能替代新版完整任务验收：

`cargo test -p strata-runtime-core tuning::tests -- --nocapture --test-threads=1` **10 passed**；对应 Core Clippy 通过。包含实际回环 SSE 分块/UTF-8/no-DONE 拒绝、受管 HTTP 夹具 A/B/A、候选采用后参数写入及重启/load/probe、恢复原配置、较慢候选不推荐、加载失败回滚、只取消自身流、维护 gate 清理、服务退出时收尾、不碰未知 PID，以及配置 CLI/SHA256 恢复。

`request-aba-v1` 对有限请求级候选执行基线 A → 候选 B → 恢复 A；distinctPrompt 使用新 nonce，repeatedPrefix 立即重复同一提示，记录实际缓存。推荐要求完整且一致的确定性输出，收益超过该轮 A 漂移。输出 hash 一致只证明一致性，不证明语义质量；这些探针不测试冷加载、会话恢复、完整 Agent、视觉或长上下文。

采用结果会保存恢复 journal，变更受管配置、重启、加载并探测；失败恢复。fixture 的受控解码耗时只验证算法与流程，不证明 GPU 收益。本轮真实 GPU 调优结果由主流程单独验收，在结果记录前不得声称自动调优已经带来实际加速。

## 发布与桌面界面状态

公开仓库已创建；正式 GitHub updater endpoint、公钥、updater artifacts 与 Actions 私钥 secret 已配置。最初的发布门禁单元测试为 **5 passed**；后续加入实际更新包验签及草稿查询，最新 Node 门禁 **17 passed / 0 skipped**、Rust 验签 **7 passed**，此前 release 模式 CLI 的三个密码学集成场景也通过。测试覆盖内置公钥、载荷篡改、签名及唯一合法版本、平台别名去重、DEB 签名、下载截断/失败/超时、自建临时目录清理及有界分页草稿查找；公开夹具不包含私钥。最终五 crate workspace Clippy `-D warnings`、fmt、版本一致和 GitHub workflow actionlint 通过。跨平台 sidecar 脚本已实际构建 Windows debug 后台，并核对目标与打包副本 SHA256 一致。

本段写作时尚未完成完整 Windows/Linux tag Release；后续 beta.2 已完成两平台签名发布、公开资产和密码学验签，逐 revision 证据见上方。客户端上一版 → 新版的 Tauri 更新安装、后台接续和实际模型/API 恢复仍不能据此判定通过。更新签名不是 Windows Authenticode 发布者签名，尚未配置发布者证书。

首次公开提交为 `65298a066c5fd48420729b437589cdf2cdce9e3f`；[首次 Windows/Linux CI](https://github.com/hongfaqiu/strata-manager/actions/runs/38060267872) 已实际运行，两平台均失败，不能作为安装包验收通过：

| 平台 | 已通过的实际检查 | 未通过检查 |
| --- | --- | --- |
| Windows x64 | 固定上游 observer 13 passed（9.425 秒、无跳过），前端协议 35 passed、HTTP 契约 5 passed、发布门禁 5 passed、前端构建、debug 后台构建、Rust fmt、IPC 5 passed、隔离自启动 2 passed | 桌面后台包升级测试读取硬编码 `target/debug` fixture 路径失败；CI 使用 `target/<triple>/debug`，未继续完成其余 Rust 检查和安装包 |
| Ubuntu 22.04 x64 | 固定上游 observer 13 passed（7.773 秒、无跳过），最小 Python 依赖、Linux 系统依赖安装、发布门禁 5 passed、前端类型检查 | `packages/core/tests/native.test.ts:96` 原生错误归一化 mock 未命中，得到 `NETWORK_ERROR` 而不是预期 `UNAUTHORIZED`，34 passed / 1 failed；尚未进入 Rust/安装包检查 |

上述失败须由后续提交的完整 CI 复验关闭。工作流另加入上游 LF 字节保留和 hash 前置门禁，避免不支持源码触发 `SkipTest` 后仍把 observer 步骤误报为完整覆盖。

[第二轮 CI](https://github.com/hongfaqiu/strata-manager/actions/runs/38061810219) 对应 `6c50b72758360fd2e117e3b4d413099296138e13`：Windows 的 target-triple fixture 路径已实际修复（升级测试通过），Linux 的动态 mock 竞争已实际修复（前端 35 passed）。两平台仍未完成安装包构建：Windows Core 64 passed / 5 failed / 2 ignored，失败集中在并行 WMI/监听端口探测超时；Linux Core 46 passed / 4 failed / 2 ignored，失败为缺失解锁的默认 Secret Service 集合。

本地后续修复保持全部断言和超时：Windows 原生测试改为串行；Linux 测试使用隔离的空凭据库、显式创建和解锁 login/default 集合，并先实际存取删除验证。Linux 会话脚本在 Ubuntu 22.04 容器实测退出码 0；三个 Linux 条件编译 Clippy 警告也已修复。当时两项环境修复待完整 Actions 复验，结果见下方第三轮记录。

[第三轮 CI](https://github.com/hongfaqiu/strata-manager/actions/runs/38063646588) 对应 `38a3bb13b987f4ab44f56594370516ce6969b909`，Linux 完整构建通过：observer 13、前端 36、HTTP 5、发布检查 5；IPC 4、desktop 2、Core 60 passed / 2 ignored；隔离凭据库存读删、workspace Clippy、release sidecar、AppImage 与 DEB 构建均成功。已上传 [AppImage 产物](https://github.com/hongfaqiu/strata-manager/actions/runs/38063646588/artifacts/11674084782)和 [DEB 产物](https://github.com/hongfaqiu/strata-manager/actions/runs/38063646588/artifacts/11675085686)，分别约 85.12 MiB 和 10.96 MiB。这是 CI 安装包，不是正式 Release，也不证明 Linux GPU 或实机崩溃恢复。

该轮 Windows 前端 36、observer 13、IPC 5、desktop 4 均通过；Core 78 passed / 1 failed / 2 ignored。唯一失败是标准 venv fixture 的监听进程列表返回空，未进入 Python 身份核验；Windows Clippy 和 NSIS 因此没有执行。本地后续改为 Windows 原生 IPv4/IPv6 TCP owner-PID 表，并保留完整身份、创建时间、参数、活动请求与二次核验；修复须由下一轮 Windows CI 确认。

原生监听修复的本地回归：Windows platform 6 passed（52.83 秒），包括实际 IPv4/IPv6 监听 PID、标准 venv 身份及精确 Job 子树；Discovery 6 passed（7.91 秒），API 错误拒绝另单独 1 passed。保留原有身份不匹配时拒绝接管的断言，没有操作原有模型进程。以上范围不能替代下一轮完整 CI 和 NSIS 安装包验收。

[第四轮 CI](https://github.com/hongfaqiu/strata-manager/actions/runs/38066271017) 对应 `d1e2155ddcb140fba53cc02895d152a2721f4b2e`。两平台 observer 13、前端 36、HTTP 5 和 Node 真实验签 12 passed / 0 skipped。Linux 完整通过：IPC 4、desktop 2、Core 60 passed / 2 ignored、Rust 验签 7、Clippy、release sidecar 和安装包；同 revision 的 [AppImage](https://github.com/hongfaqiu/strata-manager/actions/runs/38066271017/artifacts/11674709903) 与 [DEB](https://github.com/hongfaqiu/strata-manager/actions/runs/38066271017/artifacts/11675278930) 已上传。Windows IPC 5 passed，desktop 3 passed / 1 failed，失败为后台包切换后的身份断言；尚未运行到 Core、Rust 验签、Clippy 或 NSIS，不能据此关闭上一轮 venv 失败。

后台包切换的后续修复等待 RPC 关闭且同用户/数据目录的单实例锁真正释放，再启动候选或回滚，不以端口关闭代替进程退出完成，也不停止未知 PID。新增确定性夹具在旧逻辑下失败、修复后通过；最新 desktop 库 5 passed（4.60 秒），相关两项再连续两轮通过，Clippy 和 fmt 通过。回滚继续验证原 hash/version；测试编译隔离真实自启动注册项。CI 当次缺少锁状态日志，因此此修复的代码与回归证据不能写成当次具体竞态已实测，完整流水线待下一轮确认。

[第五轮 CI](https://github.com/hongfaqiu/strata-manager/actions/runs/38068353432) 对应 `b539e1291f64f9737dcc22b165eb92d0b8fd412f`。两平台 Node 17 passed / 0 skipped、observer 13、前端 36 和 HTTP 5 均通过。Linux IPC 4、desktop 2、Core 60 passed / 2 ignored、Rust 验签 7、Clippy、AppImage 和 DEB 全部通过；已上传同提交的 [AppImage](https://github.com/hongfaqiu/strata-manager/actions/runs/38068353432/artifacts/11675433479) 与 [DEB](https://github.com/hongfaqiu/strata-manager/actions/runs/38068353432/artifacts/11675538299)。Windows IPC 5、desktop 5 通过，后台包交接及锁释放回归已由此 CI 关闭。Core 80 passed / 1 failed / 2 ignored，原生监听表与 PID 检查通过；唯一失败是标准 venv fixture 中 `candidate.launcher` 为 None，尚未运行到其余 crate、Clippy 和 NSIS。

venv 后续修复要求实际进程 image 与所选 venv Python 不同时核验存活的启动器父进程，不因子进程 argv[0] 保留 venv 路径而跳过父子归属。子进程 argv[0] 仅接受已核验的基础解释器或所选 venv 路径，完整参数、venv home、父 PID、创建顺序和再次核验全部保留。新增两种 argv 形式、缺失父进程和未知可执行文件的断言；本机真实 venv/监听进程夹具 1 passed（19.85 秒），Windows platform 合同共 6 passed（41.11 秒），包含精确 Job 子树与未知实例拒绝；完整 Windows CI 仍待下一轮确认。

本地最新前端检查为核心协议 **36 passed**、HTTP 合同 **5 passed**、类型检查及生产构建通过；四 crate 的 workspace Clippy `-D warnings` 和 fmt 通过。独立实际 App + 内存 RPC 验证了中英、侧栏展开/收起与 10 个路由的 **180 个宽度组合**，未发现页面整体横向溢出。设置页另外验证 600、800、1440、2560 宽度，去除内容宽度上限，按工作区宽度使用单列或两列。长表格与代码允许在组件内滚动。这些界面测试使用演示数据，不作为真实 GPU/采集证据。

准备结果的界面接线另在真实 App、QueryClient、StrictMode 和 core bridge 的隔离内存 RPC 夹具中验证：新登记刷新模型列表并保留已有选择；移除当前模型后再登记不自动选用；首次空列表只自动准备一次；明确点击使用等待一次受管切换成功再进入聊天。组件覆盖双击去重、跨刷新保留配置选择、旧快照冲突使用现有配置、准备命令失败无无效登记重检，以及命令成功但登记失败时的重新核验。没有使用真实 GPU 数据。

Tauri 窗口启动尺寸按显示器工作区和缩放计算，常见分辨率及 100/125/150/200% 缩放的尺寸计算单元测试通过；真实高 DPI 桌面视觉仍待验收。旧版有效档案的真实迁移已恢复模型登记与会话，未重新下载权重。启动最新版桌面程序以验证既有 GPU 服务接管时，自动审批返回 `blocked by policy`；该次启动未执行，原有服务未停止，不能声称最新实际接管、持续采集或 GPU 调优已经通过。

桌面保留官方 Strata 视觉与组件，沿用共享页头、可折叠侧栏和嵌套管理布局。本轮新的自动准备入口、最新布局、中英文、键盘操作、托盘和页面截图仍需在最终 Tauri WebView 中统一验收。此前页面几何对照的结果保留在历史部分，不据此宣称当前全部页面逐像素一致或新的原生视觉已经验收。

产品 README 改为中英文用户入口，详细口径移至双语用户指南。产品封面与总览/聊天/模型/API 用量/调优/监控/设置共 8 张无损 WebP，总计约 1.2 MiB，来源为实际 App 的隔离内存 RPC 演示；README 与网站在图片外说明演示数据来源，统一使用 Qwen3.8-Flash-Next 演示模型。按用户清晰度反馈，截图以浏览器 2 倍像素密度重新渲染：页面图 2880×1920，封面 3200×1800，WebP 解码像素与原始浏览器 PNG 完全一致，README 可点击打开高清原图。封面由 HTML/CSS 组合实际总览图，非真实运行或性能证据。已逐张解码和视觉检查，CSS 1440×960 页面无整体横向溢出、控制台零错误。GitHub 仓库简介与 Topics 已加入 Strata、Qwen3.8-Flash-Next、本机模型、API 监控和 Tauri 等关键词。

## 发布前尚需完成

- 最新提交的 Windows/Linux CI 和安装包构建；记录实际 revision 与 artifacts。本批本机前端、workspace 原生测试、fmt/Clippy 及最后补丁的定向回归已通过，详见下方汇总。
- Windows 干净环境：无 Git、无 Python 的自动准备完整安装；已有安装检测/导入及自动就绪；新模型 setup、失败重试与取消。
- 最新 Tauri 界面的自动引导、官方功能、中英布局、窗口/托盘行为和真实截图。
- 真实 GPU：新架构聊天/附件/MCP、背景持续统计、重连/切换/恢复和调优完整闭环；不能只引用旧原型证明本轮通过。
- 按已接受方案验收完整场景调优：编程 Agent 和长文分析、worker/异步换入/prefill/reserve 分阶段重启候选、工具参数及续答/视觉/长文检索质量检查、冷输入/热前缀/切换会话/持续生成/完整 Agent 总耗时分别评分。新版实现与隔离合同见上方；真实 GPU、目标上下文持续稳定性及最终安装包中的完整闭环尚未验收，不能据此称 P3 已整体通过。
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

## 2026-10-11 后台健康与运行时更新入口

后台健康检测使用真实受管进程身份和监听归属，健康 GET 最长 3 秒、响应最多 64 KiB、间隔至少 5 秒。活动请求、维护、模型切换和更新期间延后检查；未知观察器状态不推断空闲。异常只记录诊断和最多 8 个故障样本，保留当前进程。新鲜、有效且可核验活动状态的健康检查才允许清除已有恢复计数；提前加载继续受策略、退避和最多 3 次恢复限制约束。

`health_watch::tests` 本机真实隔离 Python HTTP 与 OwnedProcess 共 **11 passed / 0 ignored**（最终 9.26 秒），覆盖正常/未加载、HTTP/JSON/身份/大小错误、头部与响应体超时、持续 POST、维护/加载/更新延迟、5 秒缓存、未知观察器、监听与登记变化，以及 `recover_tick` 写入 `supervisor_status.health`。关闭自动恢复仍检查健康，但不自动加载；busy、invalid 和缓存不清除恢复计数，明确停止或退出不保留正常状态。本批不操作原有模型、默认数据、GPU 或桌面应用。

总览健康显示的实际 App + StrictMode + core bridge 内存 RPC 夹具 **8 个组合通过**：中文 600px、英文 1440px，各覆盖正常、连续异常、观察不完整和不同 PID 的旧状态；无整体横向溢出或浏览器错误，未发送停止/重启/更新命令。该界面夹具不证明真实采集或硬件性能。

模型详情的运行时更新入口复用官方对话框。实际 App 内存 RPC 夹具在中英 × 600/1440px 共 **4 个组合通过**：确认前不更新、确认后只发送一次、任务完成后重查登记路径、返回模型页展示候选路径；无整体横向溢出或浏览器错误。真实运行时下载、切换与回滚的后端验收另行记录，不能用界面模拟任务代替。

[第六轮 CI](https://github.com/hongfaqiu/strata-manager/actions/runs/38069240287) 对应 `99d1882481ca6cd5e8d73e0704af172d62a57883`，因后续网站提交触发同组并发流水线而取消，未完成 Rust/安装包验收。[第七轮流水线](https://github.com/hongfaqiu/strata-manager/actions/runs/38069405879) 对应 `e0986c3362bee2216373f2cca8704c110c658d90`，Linux 全流程通过。Windows IPC 5、desktop 5 通过；Core 80 passed / 1 failed / 2 ignored。第五轮失败的标准 venv 双参数形式核验已通过，唯一新失败是旧档案迁移夹具未登记运行中的 venv 实例。该次日志没有输出迁移报告原因；本机同一夹具 1 passed（25.32 秒），不足以解释 CI 失败。

[第九轮诊断流水线](https://github.com/hongfaqiu/strata-manager/actions/runs/38070431653) 对应 `ab132ee42553b8ac5cce4760983eb7d59f596450`，Linux 全流程通过。Windows IPC 5、desktop 5、Core 80 passed / 1 failed / 2 ignored（102.30 秒）；失败仍为同一迁移夹具。新增报告明确原因是本机 Strata 进程清单的 PowerShell/CIM 读取失败（超时或权限），并非 venv 参数或监听 PID 核验失败。后续实现使用完整 Windows Toolhelp 快照及已有 sysinfo 的原生命令行读取，保持 3 秒结果接纳预算、进程数/参数大小上限和无法读取时拒绝自动操作；外部实例的完整身份、创建时间、参数与监听归属检查全部保留。该修改在下方本机完整 workspace 测试中通过真实 venv 迁移回归，最新 CI 仍待验证。Windows 当次尚未运行到 Rust 验签、Clippy 或 NSIS；取消或正在执行的任务不算通过。

## 2026-10-11 请求历史、候选更新与代码检查

API 明细增加实际模型、客户端、终态与本机时间范围筛选、双向 keyset 翻页和原生 CSV 保存入口。采集边界使用独立递增序列，新增请求不插入正在浏览的旧页；已有进行中请求的结果或模型标识仍可补全。游标绑定全部筛选条件，并明确区分“全部”和“未知”。CSV 只包含白名单元数据，单次最多 5000 条，超额拒绝且不写文件；保留原 90 天历史，不实施额外容量删除或旧日聚合。

SQLite 定向 **14 passed**（最终 0.94 秒），含一万行分页、相同时间、旧 schema、未知筛选、标签上限、公式转义、超额拒绝及真实 Windows junction。观察器 **16 passed / 0 skipped**（11.507 秒），只记录实际加载模型的标识，未加载、路径和未知值保持空值，不按请求别名猜测。实际 App 内存 RPC **16 组 UI 检查通过**，中英 600/800/1440/2560px 无外层溢出；覆盖分页失败不显示旧行、命名碰撞、筛选、保存取消/失败/超额/成功。保存对话框为模拟调用，不等于原生 GUI 验收。

运行时更新改为固定版本候选目录和私有 Python；维护 gate 排空后冻结原加载状态，核验候选健康、加载与完整短 SSE，失败/取消恢复原登记和加载状态，崩溃记录在后台重启时恢复。隔离 Python HTTP/OwnedProcess 更新夹具 **14 passed / 1 ignored**（35.93 秒），安装夹具 **6 passed / 1 ignored**（1.27 秒）；包含在途卸载排空、失败/取消、配置变化与硬退出。正常测试不下载权重、不加载 GPU、不操作默认数据或原有服务。

显式网络验收已验证固定官方引擎 **137,164,559 字节**、SHA256 `3dd7715f4844c0f9d2f28eb5067af0198f386df060c93523cd17e1d65b757f13`，固定源码 **19,149,640 字节**及 SHA256、私有 venv 创建。扩大后的候选准备验收在独立测试的 5 分钟界限内未完成 numpy wheel 下载，测试失败；requirements/CUDA wheels、完整候选准备与真实 GPU 更新未通过，不能用正常测试的 ignored 状态掩盖这次失败。该测试 pip 子树已退出；旧临时目录删除被自动审批以 `blocked by policy` 拒绝，目录保留用于诊断。

Code 调优使用有限 Rust 检查器验证 `merge_sorted(a,b)`，不启动或执行模型生成的 Python。46 组固定输入检查合并结果、输入保留和有限工作量；源码/语法/深度/列表/整数/步数/时间均有上限，拒绝不支持的语法。质量失败不能被后续一致性检查重新标成通过，旧 Code 报告不能重新应用但已应用参数仍可恢复。调优定向 **21 passed**、新增登记/40 轮升级竞争 **2 passed**，最新解释器独立编译 **10 passed**（0.08 秒），含最大 token、长链和截断不 panic。以上不证明一般 Python 渐进复杂度、完整 Agent、视觉或长上下文质量。

独立复核发现候选准备期间已准入的 `/settings` 可能保存新共享采样设置，而候选仍保留早期副本。修复在维护排空后、停止原服务前重新读取并原子发布最新共享文件，处理修改、创建和删除；原文件仅读取。再次检查共享字节及主配置 hash，变化时拒绝切换并保留原服务。补丁的运行时更新定向回归 **17 passed / 1 ignored**（48.28 秒），包含真实 HTTP 在途保存的三种情况以及主配置同时变化时保留原 PID、加载状态和用户修改；网络安装测试未重跑。补丁 Core all-targets Clippy `-D warnings` 和 workspace fmt 通过。

本批最终前端 `pnpm check` 通过：核心 **36 passed**、HTTP **5 passed**、类型检查及生产构建成功。本机串行 `cargo test --workspace --locked` 全部通过：IPC **5**、desktop **5**、Core **128 passed / 3 ignored**（163.98 秒）、独立后台生命周期 **2**（59.14 秒）、Rust 更新验签 **7**。Core 包含真实标准 venv 和旧档案迁移、健康检查、请求历史、Code 检查及更新基础夹具；生命周期覆盖客户端断开后后台继续运行、单实例、双模型排空与切换失败恢复。该完整快照在最后共享采样补丁前编译，补丁用上述 17 项定向回归闭合，不能把两次数量相加作为一次完整运行。ignored 为只读本机发现、官方安装和完整网络候选准备，不代表通过。测试均使用隔离 HTTP/OwnedProcess，不操作真实 GPU、默认数据或原服务。

workspace Clippy `-D warnings` 通过（8.25 秒），共享采样补丁后的 Core Clippy 与 fmt 再次通过。最新独立后台 debug sidecar 已重新构建并暂存（6.53 秒编译）；它是打包前构建证据，不是原生界面或真实模型接管验收。最新跨平台 CI 和最终安装包另行记录。

## 目标磁盘、自动下载和 Linux 崩溃保护补测

[第十轮 CI](https://github.com/hongfaqiu/strata-manager/actions/runs/38072257350) 对应 `d70535ccec9f8280af0d546fa3eb8c8c7fe85717`，两平台 observer 16（无跳过）、前端 Core 36、HTTP 5、Node 真实验签 17 均通过。Linux IPC 4、desktop 2、Core 108 passed / 2 ignored 和 Rust 验签 7 通过；Clippy 在 `health_watch.rs` 的 `chunks_exact_to_as_chunks` 新 lint 失败，未进入安装包。Windows IPC 5、desktop 5、Core 130 passed / 1 failed / 3 ignored；原有运行中 venv 的迁移夹具已通过，唯一失败转为外部引擎 Job 子树夹具读取完整 PowerShell/CIM 命令行超时或权限错误，尚未完成 Rust 验签、Clippy 和 NSIS。本轮不是完整跨平台通过。

后续修复改为从同一已持有 Windows 进程句柄读取完整原生命令行，动态解析系统接口，严格验证缓冲范围、长度、对齐和 UTF-16；保留创建时间、映像、完整参数、venv 父链、监听归属和空闲条件。8 项本机 platform 回归通过（3.06 秒），包括上述 CI 失败用例、精确子树、真实 venv 及损坏响应拒绝。系统查询不可用时拒绝接管，不重新按 PID 查询替代已核验句柄。Linux lint 改为 `as_chunks::<4>()`，保留原 IPv6 地址解析。

准备磁盘接口及模型卡片显示实际数据目录和目标卷可用容量。后台在配置备份、任务登记及 Python 启动前再次预检，并固定传入 `--data-dir`；完整 GGUF 分片原位通过 `--gguf-dir` 复用，不强加第二份权重的下载空间。不完整分片按完成文件或可续传 `.part` 扣减一次，不同卷分别比较，同卷合计；未知挂载、权限或不足均拒绝启动准备。10 项 Rust 磁盘测试通过（0 ignored），包含实际只读卷查询和拒绝后零任务/零子进程。所有需求数字是估计，GGUF 内容仍由上游核验，不代表内存、驱动或完整安装已就绪。

磁盘提示的实际 App 浏览器内存 RPC 验证 **20/20 passed**：中英、600/1440 宽度、ready/insufficient/unknown/error 共 16 组，加上 4 组选项及刷新交互。量化和图像切换重新预检，待查询或阻断状态不能准备；恢复 ready 后点击仅发一次模拟任务且参数正确。所有阻断状态仍可导入已有模型，不额外要求下载预检。长路径、展开说明及卡片均无横向溢出，页面/控制台错误为 0。独立随机端口服务和浏览器已关闭。此证据使用真实页面与 bridge、模拟 native RPC，不代表真实模型安装或最终 Tauri WebView 已通过。

自动更新新增独立下载状态：打开应用及每 12 小时检查/下载，成功下载并验证后由用户选择安装；下载不调用后台维护准备，只有显式安装前调用安全检查。11 项 controller 行为测试已加入 `pnpm test` / CI，覆盖关闭开关、StrictMode、晚到事件、下载失败重试、签名拒绝模拟和准备失败保留已下载内容。实际 App/React hook 的隔离浏览器内存 IPC 测试 8 项通过：中英 390/1280 宽度无整体横向溢出，自动下载前后没有提前 prepare/install，显式安装、进度和失败重试符合状态。该测试使用真实 updater JavaScript API，native IPC 为内存模拟；它不证明正式端点下载、真实签名或原生安装。

Linux 新 guardian 在真实 owner 预先持有 pidfd，跟随新进程组并监测 owner/根进程和私有控制 socket；退出时终止它自身仍所属的组，父端不向已退出的历史 PGID 补发信号。ACK 前封闭继承文件描述符，避免阻塞 exec 或日志 EOF。新增 3 个 Linux Rust 夹具覆盖 owner 真 SIGKILL、Python TCP 孙进程清理/外部进程保留、根自行退出/日志 EOF、20 次线程创建与反复停止、快速退出和 exec 失败；原有 2 个 Supervisor lifecycle 夹具已移植到 Linux，不再以 Windows gate 跳过。需要 64 位 Linux 5.9+ 和允许 pidfd/clone/close_range；失败时拒绝受管子进程启动。当前普通继承进程组的后代属于覆盖范围，官方 MCP 的主动 `start_new_session` 脱组尚未纳入，不能声称所有 Linux 工具树已被清理。此处新增 Linux 实际运行证据须由下一轮 CI 提供，本机 Windows 测试不能替代。

集中本机 workspace：IPC 5、desktop 5、Core **143 passed / 3 ignored**（116.96 秒）、Supervisor lifecycle **2 passed**（51.74 秒）、Rust 验签 7 全部通过；workspace Clippy `-D warnings` 通过（5.57 秒），fmt / workflow actionlint / diff check 通过。3 个 ignored 分别是只读本机安装发现、真实官方源码安装、完整候选网络下载；已明确记录候选依赖下载曾失败，未把 ignored 算通过。子 Agent 分别实施磁盘、自动下载和 Linux guardian，另有独立只读身份/guardian复核及完整调优范围核查；它们继承当前设置，工具未提供可独立确认的实际模型或推理档位。

本批最终 `pnpm check` 包含核心协议 **36**、更新 controller **11**、HTTP 契约 **5**，全部通过；类型检查及生产构建通过。最新 debug sidecar 重新构建成功（21.10 秒）。这些是构建与隔离夹具证据，真实签名安装和 GPU 验收仍按上面的边界记录。

提交 `41a0e99d696d473afb3d59ff788458bed1785a6f` 的本机 Windows x64 NSIS 完整构建成功，包含 release Supervisor 和前端；Tauri 主程序 release 编译 4 分 25 秒，产物约 6.43 MiB。本次仅构建，没有启动安装包或应用，没有改变已有模型服务。为了验证打包结构，使用本机临时配置关闭 updater 产物生成；因此它不是正式签名发行版，也不代表安装、真实升级或运行验收。该提交的[完整跨平台 CI](https://github.com/hongfaqiu/strata-manager/actions/runs/38074545936)结果另行记录。

该轮 CI 两平台均未整体通过：Windows IPC 5、desktop 5、Core **142 passed / 1 failed / 3 ignored**（144.65 秒）；Linux IPC 4、desktop 2、Core **120 passed / 1 failed / 2 ignored**（58.30 秒）。Windows 完整原生命令行、真实 venv、精确 Job 子树通过；Linux 新 guardian 3 项实际通过。唯一失败均为 CPU-only handoff 夹具模拟已有模型却未提供对应的可复用资产，被真实磁盘预检按完整下载及打包需求拒绝（Windows 可用 33.94 GB，Linux 82.36 GB，需求 114.50 GB）。补齐该夹具的已有模型、pack 与 MTP 小型占位资产，文件明确不加载；生产空间校验及不足时零任务/零子进程断言保持。本机修复后的 handoff 定向 **1 passed**（8.62 秒）。尚未进入该轮 Supervisor lifecycle、Clippy 或安装包步骤，不能标为完整 CI 通过。

Linux MCP stdio 新增同步 wrapper，在 Tokio/数据库初始化之前接收真实 Strata 父进程的 pidfd 和独立 ACK 管道。内核 fdinfo 必须匹配当前父进程；guardian 附着新工具组，ACK 前关闭继承管道，工具 stdin/stdout 原样保留，TERM 优雅退出时间沿用官方行为。固定上游 MCP 源码 hash 的独立适配由应用自有 bootstrap 导入，不修改用户仓库，不回退到无守护启动。未知版本或不支持 pidfd 时该 stdio 工具明确不可用；HTTP MCP 保持原逻辑。Python 拒绝/导入/固定 hash 检查 **4 passed / 0 skipped**，Windows bootstrap 幂等检查 **1 passed**。独立只读复核未发现阻断项，工具未提供可确认的子 Agent 实际模型或推理档位。

新增 4 项 Linux 集成测试覆盖官方多字节 stdio、自然退出、TERM grace、忽略 TERM 的硬退出、真实 Strata owner SIGKILL、TCP 孙进程结束、外部进程保留、错误/foreign pidfd 拒绝。它们须由后续 Linux CI 实际运行；本机 Windows 检查不替代这些证据。普通继承进程组的 MCP 后代属于设计范围；自行再调用 setsid/setpgid 脱组的任意第三方工具需要额外 cgroup 机制，尚未实现，不能宣称任意工具全部子树均已受控。


## 0.1.3 发布候选与 Windows 实测边界

本轮将官方运行能力接入、精简界面及 Windows 启动路径修复整合进 0.1.3，同时保留远程 0.1.2 的调优报告保护、确定性测试、Supervisor 诊断和运行环境更新保护。最终源码、跨平台构建和正式签名安装包的结果须与实际提交及 Actions 运行绑定，不能由早期测试结果替代。

此前 Windows 0.1.3-test.2 实机使用已有模型，验证了中文与采样、JSON/Schema、文档缓存（1523/1542 token）、约 1600 token 会话保存与恢复、双并发槽位和管理交接；MCP 工具与 GGUF 检查另有只读验收。0.1.3-test.4 已安装启动，设置、调优和配置界面完成原生截图检查，开机启动登记的版本及哈希一致，未自动加载模型。实测证据保存在工作目录的 output/windows-real-test，不作为发行资产。

当前低 RAM 驻留模式由上游拒绝动态显存调整，不能记录为 resize 成功。完整 A/B/A 长时间调优、新模型下载、跨 Windows 登录/重启和会话恢复后的长回答质量未验收。最终 0.1.3 合并后的真实前端组件隔离 RPC 回归 **35/35 passed**，包括 23 项界面优化与 12 项官方功能。公开说明截图使用隔离 CPU 文档示例，不代表真实 GPU 性能。

最终前端 `pnpm check` 的类型检查、核心 127 项、桌面 55 项、HTTP/日志 8 项及生产构建通过；发布/签名/升级脚本 90 项与网站/文档脚本 15 项全部通过，0 skipped。版本和双语日志与 `v0.1.3` 一致。20 张中英文页面图重新从当前源码捕获，版本与内容摘要记录在截图 manifest；品牌封面仍保留早期 0.1.2 合成图并单列来源。

合并候选的 Windows 串行原生全套通过：IPC 6、desktop 67 passed / 3 ignored、runtime-core 316 passed / 9 ignored、Supervisor lifecycle 3、更新验签 7，合计 **399 passed / 0 failed / 12 ignored**。固定上游源码为 `fb58e0dbc8399662c0e47c76578c6e878b14f6cf`，未使用模型权重或默认数据。Observer 的 28 项测试中 26 passed / 2 skipped，两项仅适用于另一官方 0.1.42 源码 hash；MCP guard 4 passed / 0 skipped。本机 MarkupSafe 为既有 3.0.2，CI 使用固定 3.0.3，未修改全局依赖。

完整测试后最小修正了 Clippy 类型别名、显式 lifetime、冗余引用以及 Supervisor 重复条件分支。修正后的完整 workspace/all-targets Clippy `-D warnings` 与 fmt 通过；发现/安装/存储/后台生命周期定向回归 **39 passed / 0 failed / 5 ignored**。未把两次数量累加成一次全套测试，也未重复真实 GPU 测试。跨平台正式安装包验收仍由最终提交的 Actions 完成。

首轮跨平台 CI 的 Ubuntu 原生步骤在 Linux-only MCP 测试的旧 `HashMap` 日志初始化处编译失败，原生测试未执行。夹具改为 `LogStore` 默认初始化，并使 MCP 探针仅在 Windows 使用可变子进程绑定；修正后的 fmt 与 Windows 完整 all-targets Clippy 通过，Linux 结果以新一轮 CI 为准。

官网部署工作流 `38152552942` 对应 `1fbcc4bad0ca71cae738c2a55e5dc2581ea6b166`。公开 20 张页面 WebP 与该提交的截图 manifest 逐字节哈希一致；中英首页/下载/指南在 1440px、375px 的 12 组检查，以及 40 次图片切换通过。英文启动的一次旧语言图片取消请求单独复核正常。此时公开 stable latest 仍为 0.1.2，0.1.3 下载资产仍需正式发布后补验。

本轮由三个子 Agent 分别处理原生验证、发布/前端回归和范围/截图审查，均继承主 Agent 当前配置；工具未返回可独立确认的实际模型或推理档位。主 Agent 完成合并、版本/文档整理与最终发布验收。

## 2026-10-12 跨平台发布回归修正

提交 `acb24bf` 的 CI `38153257135` 两平台均未整体通过：Windows 核心 315 passed / 1 failed / 9 ignored，PID 标记夹具创建文件后尚未写完就被读取；Linux 核心 264 passed / 2 failed / 4 ignored，全局管理扫描先读取无关进程的可执行文件身份，遇到权限拒绝。后续 Clippy 和安装包 smoke 未执行，不能以这轮结果证明发行包通过。

Windows 夹具改为写完同目录临时文件后原子发布标记，全部断言与等待期限保留，相关测试连续 5 次通过。Linux 先用与原管理判定相同的真实 `setup.py` / `strata_mcp.py` 脚本或模块入口筛选；完整参数明确无关的进程不读取可执行文件身份，受限或身份不明的真实候选仍拒绝恢复管理。WSL 实测确认无关的 root 所有系统自动更新 Python 服务触发了原错误，并加入相应负对照。空参数只允许内核线程或死亡状态跳过，无法确认的存活进程继续拒绝。

独立工作目录使用与 CI 相同的 Rust 1.99.0，在 Ubuntu 24.04 实际运行发现回归 21 passed / 1 ignored、外部管理 5 passed / 0 ignored；原生核心、Supervisor、IPC 和更新验签的 all-targets Clippy `-D warnings` 通过。Windows 发现回归 22 passed / 2 ignored、监听交接回归 1 passed；ignored 是既有显式实机只读验收，不计通过。此处为定向 CPU 回归，不替代最终源码的完整 Windows / Linux CI、正式签名及安装包启动验收；未操作真实模型或默认应用数据。

提交 `2ed125756cf129445a6d201ad19c58e7b2852ac9` 的完整 CI `38156107537`：Windows 原生 **404 passed / 0 failed / 12 ignored**，Rust 1.99 Clippy、NSIS 构建、隔离安装、GUI 启动、后台 IPC、关闭与卸载全部通过。升级保留数据步骤仅适用于 0.1.2，本轮按版本条件跳过，不能记录为 0.1.3 升级验收。Linux 原生已执行部分 **321 passed / 2 failed / 5 ignored**；两个管理扫描失败用例已通过，新的两项失败伴随原隔离 GNOME keyring daemon 的断言崩溃与 DBus 断线。Linux 后续检查和安装包启动尚未执行，整轮 CI 未通过。

独立核查将该崩溃链对应到 GNOME keyring 的首次客户端注册竞态及协商失败后空结果被当作成功返回；官方 [MR !112](https://gitlab.gnome.org/GNOME/gnome-keyring/-/merge_requests/112) 的固定 head 为 `8fcdeffe67ae8c1600eae9637816acbf73f66b81`，核查时仍未合并。CI 使用固定官方 40.0 源码、校验和及窄范围回移补丁，构建到私有目录；不替换用户系统 daemon，不修改生产凭据客户端，不跳过或吞掉凭据错误。保留真实 Secret Service 读写删除、原 owner/PID 检查、断言和全部原生测试，并增加直接首次 OpenSession 的新连接压力门禁。Linux 发行程序仍使用用户的系统凭据服务；该 CI 环境修复不能证明所有未修复系统 daemon 均无此上游问题。

回移补丁 SHA256 为 `e0e33127048532ed6b6a39a319a1fcd7ee51f6765ec018157dd0efde964e54bd`，仅比固定上游 diff 多保留既有 `error != NULL` 防御条件。WSL Ubuntu 24.04 实际构建成功，确认 `G_DISABLE_ASSERT` 未定义；私有 daemon 的真实存取删除通过。上述两项原失败 Rust 用例分别通过（10.36 秒、28.39 秒），0 ignored。直接首次 OpenSession 压力覆盖单线程 1000 次及 16 线程各 200 次，全部 **4200** 个独立连接、会话关闭和连接关闭通过；原 unique owner、PID 和进程启动时间保持一致，daemon 正常退出。原有 wrapper 的 8 项故障/隔离合同全部通过，0 skipped；合同使用 PATH stub，真实压力及 Rust 用例使用实际 daemon，两类证据单列。后续完整 CI 和公开发行验收仍须绑定最终提交。


## 2026-10-13 监控自定义与任务栏专项（未发布）

源码提交 `74ef98d0523382c4439bf167154b7a17f5c945a1`；本节不替代真实 Windows 任务栏验收。

- Core：27 文件 / 352 测试通过，包含新增 34 项偏好、预设和尺寸边界测试；Core typecheck 通过。
- Desktop：112 项单元测试通过（新增历史实时/空闲/去重/身份重置测试）；typecheck 与生产构建通过。既有打包 chunk 提示仍存在。
- Native：`cargo test -p strata-manager monitor --lib` 44 项通过；`cargo clippy -p strata-manager --all-targets -- -D warnings`、`cargo fmt --all -- --check` 通过。`cargo build -p strata-manager --bin strata-manager` 通过，未执行生成的程序。
- Codex 内置浏览器 + Vite 隔离夹具：中英、明暗、720px 窄窗口无页面横向溢出；默认双行、16px 数值、读取蓝色/生成绿色、动态折线显示；6→8 项上限、24px 字号、按钮/Alt+方向键排序、预设恢复通过；刷新保留字号和折线设置；模拟模式成功与失败回退通过。
- 回归：连续“指标修改→模式改变”事件保留 CPU 选择；模拟任务栏关闭后 10 秒以上仅保留首次 snapshot，隐藏浮窗不恢复采样。停止与过期场景所有数值显示缺测，监控窗口调用记录无模型启动、加载或推理操作；浏览器错误日志为空。
- 截图：[范围与文件](screenshots/monitor-customization/README.md)。原图在 `output/playwright/monitor-customization/`。现有 Playwright 回放脚本已更新并通过语法检查，本轮没有运行该脚本，以上浏览器结论来自直接交互验收。
- 未覆盖：真实任务栏挂载、右键菜单、拖动/复制、自动隐藏、Explorer 重启、多屏/DPI、Linux 构建与真实硬件。新宿主只在用户显式切换时启动；普通托盘图标不是任务栏宽条。任务栏形态仍为实验功能，不进入已发布的 0.1.7。
- 并行完成 Core/设置、窗口几何、原生宿主与独立复核；工具未提供可核实的子 Agent 模型或推理档位，记录为未知。


## 2026-10-14 监控密度与开关修订

工作区增量，尚未形成独立发布。新增实际可见性开关、全标签隐藏、默认关闭状态行、2px间距、8–36px字号、默认关闭的吸附选项，以及以累计鼠标位移计算的拖动修复。

- 拖动回归先临时恢复旧 x 计算，确认连续小位移测试失败（实际 0，预期 15）；恢复修复后定向 24 项通过。最终 `cargo test -p strata-manager monitor --lib` 59 项通过；严格 Clippy 通过。
- Core 388 项通过（包括 70 项监控偏好、尺寸、排序边界）；桌面测试 122 项通过。工作区还包含其它并行任务，以上总数包含其测试。
- 隔离浏览器确认 8px/36px 实际字号，36px下无指标溢出；紧凑标签开启 225×40，关闭后标签数量为0、高度28；默认无状态header；格间距2px；显示开关往返成功，关闭时换形态不触发打开命令。
- 截图与记录：`output/native-monitor-acceptance/compact-controls.png`、`compact-controls-evidence.json`。采用示例数据，不是模型性能证据。本轮未操作物理鼠标，不能将自动回归视为已完成真实拖动验收。

## 2026-10-14 按指标列宽、配色与精简说明（未发布增量）

本节记录后续工作区增量，不沿用前节尺寸或测试数量作为最新结果。独立开发产物已构建并核对哈希，尚未启动；发行验收未完成。

- 浮条改为按指标分配稳定列宽。当前预设示例的逻辑尺寸为：紧凑 180×40，隐藏标签后 180×28，双行 244×120；尺寸随所选指标、布局和字号变化。11 项指标提供独立主题默认色、逐项十六进制颜色及恢复默认。
- 自定义设置移除逐项重复的“自动主题／自定义”说明，保留统一一句与错误提示；开关详情移入提示，避免重复说明占据面板。最终浏览器核对重复 `color-note` 数量为 0、开关下方 `small` 说明数量为 0，只保留一处主题说明；非法颜色设置 `aria-invalid=true`，恢复默认后清除错误及 `aria-describedby`。
- 用户已在另一会话要求删除常驻任务栏切换。本轮保留该移除结果，旧任务栏偏好迁回 `floating`；README、未发布日志和官网开发中说明不再将任务栏宽条列为可用功能。
- 本轮已通过 `pnpm typecheck`、`pnpm test`（Core 402 项，桌面测试全部通过）、`cargo test -p strata-manager monitor --lib` 74 项，以及严格 Clippy。测试总数包含工作区内相关并行改动，不代表完整 Windows／Linux 原生全套或正式安装包验收。
- 隔离浏览器使用真实组件及示例数据，确认中文深色、英文浅色下的列宽、无溢出、颜色修改与恢复；8px／36px 字号检查通过。以上不证明真实鼠标拖拽、吸边或真实模型采样已通过。
- [monitor-density](screenshots/monitor-density/README.md) 的中英文紧凑／双行预览及最终完整设置截图均已落盘；完整设置文件为 `docs/screenshots/monitor-density/settings.zh.png`。
- 任务栏内部探针最后一次报告 `leftSide`、全部采样点命中我方窗口，宿主正常退出（退出码 0）。该记录仅是实验诊断证据：可复用窗口的持续遮挡检查尚未闭合，通知区边界改变后的位置信息也可能过期；不作为任务栏发布验收或可用性承诺。
- 最终精简文案的生产前端与 Tauri debug 构建通过。独立产物为 `output/dev-monitor-density/StrataManager-dev.exe`，已嵌入前端，SHA-256 为 `07B1BE055CFC6A1C339ABB626A3C748D0CEBE8BB0DB1FB08D00724398218F713`。旧开发程序仍被用户占用，未覆盖；新产物尚未启动，不将构建通过记录为原生运行验收。
- 官网本地构建通过：15 份文档、818 个本地链接与资源检查通过；本轮未发布官网，不以本地构建替代公开部署核验。
