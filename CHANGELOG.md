# Changelog

按版本维护中英文更新日志。发布前将未发布内容归入实际版本；更新弹窗只展示该版本、该语言的内容。
Maintain both languages for each version. Move unreleased changes into the actual version before publishing.

## [Unreleased]

## [0.2.16] - 2026-10-22

### 中文

- **修复 Windows AMD 显卡监控一直没有读数（#127）**：0.2.15 把 ADLX 读数移到独立小进程后，模型能正常启动了，但监控页、总览和浮条上的 AMD GPU 负载、显存、温度、功耗仍是空的。原因是 Manager 用的 `adlx` crate（crates.io 上的 `0.0.0-alpha.1`）有一个引用计数错误：每次把显卡对象转换成新接口（`cast`）都会多释放一次引用。Manager 以前每次采样都做这个转换，第一次采样后显卡对象就被提前释放，下一次读数时小进程崩溃，5 分钟后才重试，所以几乎看不到读数。上游已修复但未发布。现在转换时先多持有一份引用，每次会话只转换一次；显卡名称、显存总量和 PCIe 只在开始时读一次，其余各项分别读取，某一项读不到不影响其他项，也不再用 `IsSupported*` 判断是否读取（例如 RX 7900 XTX 报告不支持功耗，实际能读到整卡功耗）。显卡名称优先显示「AMD Radeon RX 7900 XTX」而不是板卡代号，并识别 PCIe 5.0。这个修复还没有在 Windows AMD 真机上验证过。
- **更新应用时不再停止 Strata 服务，更新弹窗可以关掉**：以前只要有模型服务在处理请求，应用更新就提示「当前有任务正在进行，结束后可确认更新」。其实应用更新本来就不会停掉后台和引擎，重启后的新版会接着管理正在运行的模型。现在应用更新不再要求服务空闲，确认文字也会说明模型服务和本地 API 会继续运行、重启后重新接管；Strata 运行环境更新会重启引擎，仍要求请求处理完。下载和安装过程中可以点右上角关闭，或点「在后台继续」，更新在后台继续；标题栏的版本标记会显示「下载中 42%」「安装中」「待安装」，点击可重新打开弹窗。还没有在 Windows、macOS、Linux 的真实安装包上做过带模型的更新验收。
- **点右上角关闭默认最小化到托盘**：一些从 0.1.0 测试版一路升级上来的 Windows 电脑，点关闭按钮会弹出「退出 Strata Manager？」，而不是缩到托盘。原因是早期测试版把「关闭时最小化到托盘」保存成了关闭，之后的版本一直沿用这个旧值。现在会一次性把这类旧设置改回最小化到托盘；之前明确选过「直接退出、不再提示」的不受影响，迁移之后也始终尊重你自己的选择。退出弹窗新增「最小化到托盘」按钮，勾选「不再提示」时会记住这个选择。
- **聊天里的 HTML 预览**：一是修复点「预览」后一秒左右又跳回代码的问题（模型运行时界面每秒刷新，代码块被整个重建，选择丢失）。二是 HTML 代码块默认收起，只显示一行标题（语言、页面标题、行数、复制和「预览」），点击才展开代码；回答还在生成时「预览」不可用。三是预览改为在聊天右侧打开面板，可以拖动左边缘调整宽度（宽度会记住）、重新运行、全屏、另存为 HTML；窗口较窄时改为浮层抽屉，按 Esc 关闭。四是预览可以联网：允许通过 `https:` / `wss:` 加载外部脚本、样式、字体、图片，以及访问 API；`http:`、本机服务（包括本地 Strata API）和应用内部接口仍被拦截，预览依旧运行在沙箱里，碰不到应用和你的文件。五是新增「在浏览器中打开」按钮，把页面另存为临时文件后用系统浏览器打开（在浏览器里不再受应用沙箱限制）。
- **公共设置页改为两栏布局**：宽窗口下「外观」「运行行为」在左，「本机后台」「开始使用指南」在右，两栏高度大致相同，不再一侧空着；窗口窄于 1240 像素时仍是一栏。行高、卡片标题和下拉框宽度也统一了。

### English

- **Fixed empty AMD GPU monitoring on Windows (#127)**: after 0.2.15 moved the ADLX readings into a separate helper process, models started normally, but AMD GPU load, VRAM, temperature and power stayed empty on the monitor, overview and floating bar. The cause is a reference-counting bug in the `adlx` crate Manager uses (`0.0.0-alpha.1` on crates.io): every conversion of the GPU object to another interface (`cast`) releases one reference too many. Manager did that conversion on every sample, so the GPU object was freed after the first sample, the helper crashed on the next reading and only retried after 5 minutes, which left the readings almost always empty. Upstream fixed this but never published the fix. Manager now holds an extra reference for the conversion and converts once per session. The card name, total VRAM and PCIe are read once at the start; every other value is read on its own, so one missing value does not hide the rest, and `IsSupported*` flags no longer decide what is read (an RX 7900 XTX reports power as unsupported but does give total board power). The card name now prefers "AMD Radeon RX 7900 XTX" over the board code, and PCIe 5.0 is recognised. This fix has not been verified on real Windows AMD hardware yet.
- **App updates no longer stop Strata services, and the update dialog can be closed**: while any model service was handling requests, the app update used to say "a task is in progress; you can confirm the update when it finishes". App updates never stopped the background process or the engine, and the new version takes over the running model after the restart. App updates no longer wait for services to be idle, and the confirmation text says model services and the local API keep running and are managed again after the restart. Strata runtime updates restart the engine, so they still wait for requests to finish. During download and install you can close the dialog with the close button or "Continue in background", and the update keeps running; the version badge in the title bar shows "Downloading 42%", "Installing" or "Ready to install" and reopens the dialog. An update with a loaded model has not been tested with real installers on Windows, macOS or Linux yet.
- **The close button minimizes to the tray by default**: on some Windows computers upgraded all the way from the 0.1.0 betas, the close button opened "Quit Strata Manager?" instead of minimizing to the tray, because the early betas saved "minimize to tray on close" as off and later versions kept that old value. That old setting is now switched back to minimizing to the tray once; if you had chosen to quit without asking, it is left alone, and your own choice is always respected after this. The quit dialog has a new "Minimize to tray" button, remembered when "Don't ask again" is ticked.
- **HTML previews in chat**: First, clicking Preview no longer jumps back to the code after about a second (while a model runs the window refreshes every second, and the code block was rebuilt and lost the choice). Second, HTML code blocks start collapsed to a single header row (language, page title, line count, copy and Preview) and expand on click; Preview is unavailable while the answer is still streaming. Third, the preview opens in a panel to the right of the chat: drag its left edge to resize (the width is remembered), rerun, go full screen or save as HTML; in narrow windows it becomes an overlay drawer that Esc closes. Fourth, previews can use the network: external scripts, styles, fonts, images and API calls over `https:` / `wss:` are allowed, while `http:`, local services (including the local Strata API) and the app's internal interfaces stay blocked, and the preview still runs in a sandbox with no access to the app or your files. Fifth, a new "Open in browser" button saves the page to a temporary file and opens it in your default browser, where the app's sandbox no longer applies.
- **Two-column shared settings page**: in wide windows, Appearance and Behavior are on the left and Local background and Getting started on the right, at about the same height, instead of one column with empty space beside it. Below 1240 pixels wide it stays one column. Row heights, card titles and dropdown widths are consistent now.

## [0.2.15] - 2026-10-22

### 中文

- **修复 Windows AMD 显卡上启动模型几秒后报「读取后台消息失败: unexpected end of file」（#124、#127）**：0.2.12 加入的 AMD 显卡监控会在后台进程里直接加载 AMD 驱动的 ADLX 库（`amdadlx64.dll`）。模型启动几秒后第一次读取监控数据时，如果这个库出错，后台进程会整个退出，正在加载的引擎也被一起结束，界面上只剩这条报错，启动诊断也是空的。现在 ADLX 改到一个独立的小进程里读取，后台和无头 Server 只接收它每秒输出的一行读数。这个小进程出错时，只是暂时没有 AMD 显卡读数，5 分钟后再重试，不会影响后台和模型启动。如果仍有问题，可以设置环境变量 `STRATA_MANAGER_AMD_TELEMETRY=0`，完全关闭 AMD 读数。这个修复还没有在 Windows AMD 真机上验证过。
- **内置的两个 GitHub 代理改为按域名显示（#126）**：更新 Strata 和 Manager 时，下载来源里的「GH Proxy」和「GHProxy」只差一个空格，看起来像重复项，其实是两个不同的代理。现在直接显示为 `gh-proxy.org` 和 `ghproxy.net`。已经选好的下载来源不受影响。
- **CI 提速（不影响应用）**：Windows 和 Linux 的原生测试从每个平台 3 个分片增加到 5 个，并按实测耗时分配，各分片跑测试的时间基本一致（新增 `scripts/native-test-timings.mjs`，可以用最新一次 CI 重新生成耗时表）。Linux 的系统依赖改为从缓存安装，不再受 Ubuntu 软件源快慢影响；缓存装不上时自动改回联网安装。

### English

- **Fixed "failed to read background message: unexpected end of file" a few seconds after starting a model on Windows with AMD graphics (#124, #127)**: the AMD GPU monitoring added in 0.2.12 loaded AMD's ADLX driver library (`amdadlx64.dll`) straight into the background process. When that library failed on the first monitoring read, a few seconds after a model started, the whole background process exited and took the loading engine with it, leaving only this error and an empty startup diagnostic. ADLX now runs in a separate small helper process, and the background process and the headless server only read the one line of readings it prints each second. If the helper fails, AMD GPU readings are missing for a while and retried after 5 minutes; the background process and the model start are not affected. If problems remain, set the environment variable `STRATA_MANAGER_AMD_TELEMETRY=0` to turn AMD readings off completely. This fix has not been verified on real Windows AMD hardware yet.
- **The two built-in GitHub proxies are labelled by host name (#126)**: when updating Strata or Manager, the download sources "GH Proxy" and "GHProxy" differed only by a space and looked like duplicates, although they are two different proxies. They now show as `gh-proxy.org` and `ghproxy.net`. A download source you already chose is not affected.
- **Faster CI (no app changes)**: Windows and Linux native tests now run in 5 shards per platform instead of 3, balanced by measured test times so every shard spends about the same time testing (the new `scripts/native-test-timings.mjs` regenerates the timing table from the latest CI run). Linux system dependencies are installed from a cache, so a slow Ubuntu mirror no longer slows the jobs down; if the cache cannot be installed, the job falls back to installing online.

## [0.2.14] - 2026-10-22

### 中文

- **兼容上游 Strata 0.2.2**：一是 0.2.2 新增的 RX 6000 引擎包（Linux `hip-rx6000`、Windows `hip-rdna2`，gfx1030/gfx1031）以前不在 Manager 的包列表里，RX 6800/6900/6950、RX 6700/6750 和 PRO W6800 只能看到「没有官方引擎包」。现在会按显卡自动选这个包，下拉框里显示为「AMD HIP · RX 6000（上游未经实机测试）」：上游只编译了这个包，还没有在真实的 RX 6000 显卡上跑过。二是用量统计和请求记录在 0.2.2 上会整体停用：0.2.2 的 `Service.run` 多了 `declared_only` 参数，observer 的签名检查不通过。现在 observer 接受这个签名并把参数原样转给上游，0.2.1 和 0.2.2 的 `server.py` 也已审核并加入白名单；CI 新增 Windows/Linux 两个 Strata 0.2.2 observer 任务，发版门禁要求它们全部通过。三是 0.2.2 起 Terminal 的 `settings.json` 和上游桌面 App 的 `app-settings.json` 共用一个模型目录，以较晚选择的为准（`data_dir_at`）。Manager 改模型目录时没有更新这个时间，旧时间会让上游把目录改回去。现在 Manager 会写入当前时间，上游 App 的设置文件存在时也一并更新，读取时取两者中较新、且目录确实存在的那个。另外用 v0.2.2 全部 12 个引擎包的真实文件清单测试了白名单，11 个 Windows/Linux 包都能解包，并通过签名清单校验。
- **使用统计不再因上游给核心函数加可选参数而整体停用**：Manager 的请求统计会检查上游 `serve/server.py` 里几个核心函数（如 `Service.run`、`begin_request`、HTTP 处理器的 `_json` / `_capture`）的参数，以前要求逐字一致，上游只是在末尾加一个带默认值的参数（像 0.2.2 的 `declared_only=False`）也会让未审核过的源码停用统计。现在只要原有的必填参数名称、顺序和“必填/可选”都没变，末尾新增的参数都有默认值（或是 `*args` / `**kwargs`），就照常统计，包装层会把这些多出来的参数原样转交上游；删掉、改名、调换必填参数，或新增必填参数，仍会停用统计、不影响推理。另修正调优的一个小问题：“异步专家切换”候选原本只看启动参数里有没有 `--layer-split` 来判断多卡，配置文件顶层写了 `layer_split`、`"gpu": [0, 1]` 或多张卡的 `gpu_roles` 时漏判，现在统一按同一个多卡判断拒绝这个候选。
- **Mac 上的 Metal 引擎更新到 0.1.47（上游 Strata v0.2.2）**：Manager 原来固定安装 v0.2.0-beta 的 Metal 引擎 0.1.45.3，低于上游 0.2.2 要求的最低引擎版本 0.1.46。现在改装 v0.2.2 的 `strata-engine-0.1.47-macos-arm64-metal.tar.gz`（5,133,090 字节，固定 SHA256）。这个包新增了图片识别程序 `strata-vision` 和 `metal/data`、`metal/engine-msl` 目录，都已加入白名单。解包后，Manager 会用包内签名清单 `engine-component.json` 逐个核对文件的 SHA256 和大小：清单的摘要必须与签名 feed 一致、签名必须有效，清单之外的文件或改动过一个字节都会被拒绝，并清掉解包出来的文件。以前由 Manager 安装的旧版 Metal 引擎，在下次安装或修复运行环境时会自动换成新版；你自己选的引擎目录和源码构建（`build-metal`）不会被替换。
- **Windows 首次安装按 NVIDIA 显卡选 CUDA 包**：以前 Windows 上还没装引擎、又检测到 NVIDIA 显卡时，一律装 CUDA 13。但 CUDA 13 包不支持 Pascal/Volta（GTX 10 系列、Titan V 等，计算能力低于 7.5），也要求驱动 580.65 以上，这些电脑装上后引擎根本启动不了。现在 Manager 用 `nvidia-smi` 读驱动版本和计算能力，按签名 feed 里每个 CUDA 包的架构列表和最低驱动版本来选：GTX 1080 或驱动在 576.02 到 580.65 之间时装 CUDA 12；驱动比两个包的要求都旧时，会提示先更新驱动，或者在「官方更新包」里手动选。同时有 AMD 核显也不影响选择。`nvidia-smi` 读不出计算能力，或者什么显卡都没检测到时，仍然用 CUDA 13。
- **新装的运行环境改用上游 Strata v0.2.2 源码**：以前「一键安装」新建的运行环境固定在上游 2026-10-08 的一个提交（fb58e0d，Control 0.1.41），比 v0.2.2 落后两千多个提交，新装环境里的 `setup.py` 和 `serve/server.py` 都是旧版。现在固定到 v0.2.2（011c9e6，codeload ZIP 32,149,291 字节，SHA256 `0c3139c3…`）。新环境装在新目录 `strata-011c9e600a93`，以前准备的运行环境原样保留，仍可以用「运行环境更新」升级。核对过的兼容点：Manager 传给 `setup.py` 的参数和取值在 v0.2.2 里都还在；v0.2.2 固定的 Python 包是旧版的子集（cmake/ninja 移到只在本机编译时安装的单独文件）；`server.py` 已通过 observer 审核。请求诊断（临时记录请求内容）也加入了 v0.2.2 的源码 hash，以前只对 0.1.41/0.1.42 开放。CI 里原生测试和桌面任务用的上游参考代码同步换成 v0.2.2，并补装上游固定版本的 `regex`（0.2 起 `server.py` 需要它）。
- **显卡角色（主卡 / 辅助 / 关闭，跟进上游 Strata 0.2.2）**：「模型 → 运行配置 → 内存与显卡」新增显卡角色编辑，每张卡选择主卡（运行每次回答的最后一段）、辅助（分担模型）或关闭。保存方式与上游应用一致：写入 `gpu_roles`，同时写 `gpu`（主卡在最后）和 `gpu_order: "as_given"`，供旧版本和监控读取；全部关闭时写 `gpu: []` 和 `gpu_none: true`。如果 `gpu` 被手动改过、与角色不一致，上游以 `gpu` 为准、忽略 `gpu_roles`，界面会提示这一点。全部关闭时：CUDA / HIP / SYCL 引擎会直接拒绝启动，界面显示错误；Metal/CPU 只提示会只用 CPU、速度变慢。启动因此失败时，启动诊断不再是笼统的「引擎退出」，而是指向显卡角色。资源评估、并发建议和加速评估改为按 `gpu_roles` 实际打开的卡计算。安装器的「下载与显卡设置」里指定多张卡后可选主卡，以 `setup.py --gpu-roles` 传给安装器；运行环境的 setup.py 不支持这个参数（早于 0.2.2）时会提前报错，不会启动安装。角色规则移植自上游 `apps/host/src/lib/gpu-roles.ts`（MIT），并用上游的测试向量做了回归测试。
- **明确不使用 API 密钥（`"api_key": "none"`）**：「设置 → API 与外部助手 → 局域网共享与服务端鉴权」新增「明确不使用密钥」，写入上游 0.2.2 的 `"api_key": "none"`。选了这一项后，局域网监听不再强制要求设置密钥（上游的决定：网络上推荐设密钥，但不强制），界面会提示风险，并说明更早的版本会把 none 当成一个名为 none 的密钥。导入配置时，`"none"` 不会再被当成客户端密钥存进系统凭据库。
- **CPU 专家线程使用的逻辑处理器（`pool_cores`，进阶、默认关闭）**：「处理器」分类新增可选字段，例如 `0,2,4,6` 或 `2-14:2`，校验规则与上游 `serve/server.py` 相同。需要 Strata 0.2.2（引擎 0.1.47）及以上；留空保持默认分配。

### English

- **Upstream Strata 0.2.2 compatibility**: First, 0.2.2 adds RX 6000 engine packages (Linux `hip-rx6000`, Windows `hip-rdna2`, gfx1030/gfx1031) that Manager did not list, so RX 6800/6900/6950, RX 6700/6750 and PRO W6800 owners only saw "no official engine package". They are now picked from the GPU automatically and labelled "AMD HIP · RX 6000 (untested by upstream on a real card)": upstream built them but has not run them on a real RX 6000. Second, usage statistics and request records switched off entirely on 0.2.2, because `Service.run` gained a `declared_only` parameter and failed the observer's signature check. The observer now accepts that signature and passes the keyword through; the 0.2.1 and 0.2.2 `server.py` sources are reviewed and allow-listed, and CI adds Windows/Linux Strata 0.2.2 observer jobs that the release gate requires. Third, from 0.2.2 the Terminal's `settings.json` and the upstream desktop app's `app-settings.json` share one models folder, and the later choice (`data_dir_at`) wins. Manager did not update that time when you changed the folder, so an older timestamp could make upstream switch it back. Manager now writes the current time, updates the app's settings file too when it exists, and reads whichever of the two is newer and still exists. The allowlist is also tested against the real file lists of all 12 v0.2.2 engine packages; all 11 Windows/Linux packages unpack and pass the signed-manifest check.
- **Usage stats no longer switch off when upstream adds an optional parameter to a core function**: Manager's request stats check the parameters of a few core functions in upstream `serve/server.py` (such as `Service.run`, `begin_request`, and the HTTP handler's `_json` / `_capture`). They used to require an exact match, so an unreviewed source that only appended a parameter with a default (like 0.2.2's `declared_only=False`) turned the stats off. Now, as long as the existing required parameters keep their names, order and required/optional split, and every new trailing parameter has a default (or is `*args` / `**kwargs`), stats keep working and the wrappers pass the extra arguments through to upstream untouched. Removing, renaming or reordering a required parameter, or adding a new required one, still turns the stats off without affecting inference. Also fixed a small tuning gap: the "async expert swaps" candidate only looked for `--layer-split` in the start arguments to spot a multi-card setup, and missed a top-level `layer_split`, `"gpu": [0, 1]` or a multi-card `gpu_roles`; it now uses the same multi-card check everywhere and declines the candidate.
- **The Mac Metal engine moves to 0.1.47 (upstream Strata v0.2.2)**: Manager used to install the v0.2.0-beta Metal engine 0.1.45.3, which is below the minimum engine 0.1.46 that upstream 0.2.2 requires. It now installs v0.2.2's `strata-engine-0.1.47-macos-arm64-metal.tar.gz` (5,133,090 bytes, pinned SHA256). That package adds the `strata-vision` picture reader and the `metal/data` and `metal/engine-msl` folders, all of which are allowed now. After unpacking, Manager checks each file's SHA256 and size against the package's signed manifest `engine-component.json`: the manifest must match the digest in the signed feed and carry a valid signature, and any file outside the manifest or a single changed byte is refused and the unpacked files are removed. A Metal engine that Manager installed earlier is replaced with the new one the next time you install or repair the runtime; engine folders you chose yourself and source builds (`build-metal`) are never replaced.
- **Windows first installs pick the CUDA package from the NVIDIA card**: when Windows had no engine yet and an NVIDIA GPU was found, Manager always installed CUDA 13. The CUDA 13 package does not support Pascal/Volta (GTX 10 series, Titan V and others below compute capability 7.5) and needs driver 580.65 or newer, so on those computers the engine could not start. Manager now reads the driver version and compute capability with `nvidia-smi` and picks by each CUDA package's architecture list and minimum driver from the signed feed: a GTX 1080, or a driver between 576.02 and 580.65, gets CUDA 12. When the driver is too old for both packages, you are asked to update it or choose a package under "Official update package". An AMD iGPU alongside does not change the choice. If `nvidia-smi` cannot report the compute capability, or no GPU is detected, CUDA 13 is still used.
- **New runtimes use the upstream Strata v0.2.2 source**: a runtime created by one-click install used to be pinned to an upstream commit from 2026-10-08 (fb58e0d, Control 0.1.41), more than two thousand commits behind v0.2.2, so its `setup.py` and `serve/server.py` were old. The pin is now v0.2.2 (011c9e6; codeload ZIP 32,149,291 bytes, SHA256 `0c3139c3…`). New runtimes go to a new folder, `strata-011c9e600a93`; runtimes prepared earlier stay as they are and can still be upgraded with the runtime update. Compatibility checks: every flag and value Manager passes to `setup.py` still exists in v0.2.2; v0.2.2's pinned Python packages are a subset of the old ones (cmake/ninja moved to a separate file installed only for local builds); `server.py` passes the observer review. Request diagnostics (temporary request recording) also accept the v0.2.2 source hash; before, they were only enabled for 0.1.41/0.1.42. In CI, the upstream reference checkout used by the native tests and desktop jobs is now v0.2.2 too, and they also install upstream's pinned `regex`, which `server.py` needs from 0.2 on.
- **GPU roles (Main / Helper / Off, following upstream Strata 0.2.2)**: Models → Runtime configuration → Memory and GPUs now has a GPU roles editor. Each card is Main (runs the last stage of every answer), Helper (holds a share of the model) or Off. Saving works like the upstream app: it writes `gpu_roles`, plus `gpu` (Main last) and `gpu_order: "as_given"` for older versions and monitoring. When every card is Off it writes `gpu: []` and `gpu_none: true`. If `gpu` was edited by hand and no longer matches the roles, upstream uses `gpu` and ignores `gpu_roles`, and the editor says so. When every card is Off, the CUDA / HIP / SYCL engines refuse to start and the editor shows an error; for Metal/CPU it only warns that Strata runs on the CPU and is slower. A start that fails for this reason now gets a startup diagnostic that points to GPU roles instead of a generic "engine exited". Resource, concurrency and speed assessments now count the cards that `gpu_roles` actually turns on. In the installer's "Download and GPU settings", choosing several cards lets you pick the Main card, which is passed to setup as `setup.py --gpu-roles`. If the runtime's setup.py does not support that option (older than 0.2.2), the app reports it up front instead of starting setup. The role rules are ported from upstream `apps/host/src/lib/gpu-roles.ts` (MIT) and regression-tested against upstream's test vectors.
- **Serve without an API key on purpose (`"api_key": "none"`)**: Settings → API & external assistants → LAN sharing and server authentication has a new "Serve without a key" option, which writes upstream 0.2.2's `"api_key": "none"`. With it, LAN listening no longer insists on a key (upstream's decision: a key is recommended on a network, never required). The panel explains the risk and notes that older versions treat none as a key named none. Importing a config no longer saves `"none"` as the client key in the system credential store.
- **Logical processors for CPU expert workers (`pool_cores`, advanced, off by default)**: the CPU category has a new optional field, for example `0,2,4,6` or `2-14:2`, validated with the same rules as upstream `serve/server.py`. It needs Strata 0.2.2 (engine 0.1.47) or newer; leave it empty for the default placement.

## [0.2.13] - 2026-10-22

### 中文

- **Mac 上「剩余空间未知」（用户反馈，macOS 27）**：在 Mac 上，「开始使用 → 检查运行环境」里的「新引擎安装位置」和「模型文件」两行总是显示「剩余空间未知」，存储位置页和安装前的磁盘检查也读不到剩余空间。原因是：macOS 的系统卷「/」是只读的，用户文件夹实际在可写的「数据」卷上，但以前按挂载列表找目录所在磁盘时只匹配到「/」，于是判断为「目标磁盘为只读」。现在 macOS 和 Linux 直接向目录所在的文件系统查询剩余空间和是否只读（`statvfs`，macOS 另用 `statfs` 取真实挂载点）；目录还不存在时按最近的已存在上级目录计算。Windows 不变。
- **Mac / Linux 首次使用卡在「安装 Strata」（用户反馈，macOS · M5 Pro）**：点「开始安装」后日志显示「Strata 源码与私有 Python 环境已就绪：下一步准备模型」，页面却仍停在第 2 步、提示「检测到 Strata 文件但运行依赖未就绪」，再点安装也一样，步骤条也点不到「选择模型」。原因是 Mac 和 Linux 的安装只创建了私有 Python 环境、检查了 pip，没有安装 Strata 的 Python 依赖；而检测运行环境时要求 `regex`、`jinja2` 能导入，于是安装任务说「已就绪」，检测却一直判为「需要修复」。现在安装会在私有环境里按源码自带的固定版本 `requirements.txt` 安装依赖（只用官方 PyPI 的预编译包，不改系统或 Homebrew 的 Python），装完再检查一次，仍缺就明确报错，不会再假装成功。已经装过的用户不用重装，再点一次「开始安装」就会补装依赖并进入下一步。安装结束后会立即重新检测，不用等下一次轮询；如果运行环境仍需修复，页面会直接显示具体原因（例如缺了哪些依赖）。Windows 的安装流程原本就会安装依赖，不受影响。
- **启动配置可以设置“默认实验投影”（用户反馈 #104）**：聊天页早就有按会话开关实验投影，但模型启动配置的“默认采样”里没有对应选项，只能手改 JSON。现在“运行配置 → 默认采样”新增“默认实验投影”，可选开启、关闭或使用默认设置：开启和关闭分别写入 JSON 的 `true` / `false`，使用默认设置会删除 `sampling.experimental_speed_projection`，不强制开或关。原来没有这一项或值为 `null` 的配置显示为“使用默认设置”，只打开页面不会改写文件；`"false"`、`0`、`1` 这类非布尔值在图形界面和 JSON 保存时都会被拒绝（Strata 遇到这类值会拒绝启动）。保存时只改这一项，其他采样参数、未知字段和启动参数保持原样。优先级不变：请求里的值优先，其次是共享采样设置，最后才是启动配置里的默认值；Manager 聊天仍按会话开关显式发送。这个选项需要引擎已经加载实验投影控制向量才会起作用，Manager 不会帮你加载或下载向量；保存后重启模型生效。
- **Windows AMD 显卡装不上 AMD 引擎（用户反馈 #103，RX 9070 XT）**：这台电脑只有 AMD 显卡（RX 9070 XT，gfx1201，外加一块 gfx1036 核显），却卡在三个地方。一是首次安装运行环境时，Windows 上没有已装引擎就一律选 CUDA 13 引擎包，装上的引擎在这台电脑上根本启动不了。现在 Windows 会读系统显卡列表（`Win32_VideoController`），按显卡型号判断 AMD 架构：只有 AMD 显卡时安装对应的 HIP 包（RX 9000 / R9700 选 RX 9070 包，RX 7000 / Strix Halo 选 RDNA3 包）；有 NVIDIA 显卡或什么都没检测到时仍然用 CUDA 13。Linux 和 Windows 选包时都会忽略没有官方引擎包的核显，不再因为多一块核显就要求手动选择。二是官方 HIP 引擎包下载并校验通过后，解包时报「引擎包含未识别的运行文件：tuning/gfx1201-hipblaslt-100500.txt」。这是包里自带的 hipBLASLt 调优表，Manager 的文件白名单漏了 `tuning/` 目录；现在已加入，每个文件仍要和签名清单逐一核对。三是准备模型时上游 `setup.py` 只认 `BUILD.json` 里 `source` 为 `prebuilt` 的 HIP 引擎，官方 0.2 包写的是别的值，于是安装器去下载早已不再发布的 `strata-windows-x64-hip.zip`，返回 404。这一处的根因在上游安装器；Manager 现在会在 Windows 上准备模型前，先核对 `engine/` 里的官方 HIP 引擎（签名清单有效、`BUILD.json` 与清单摘要一致），确认无误后把 `source` 标为 `prebuilt`，原值另存一份，安装器就会直接用它。另外修复了桌面端「复制诊断信息」和「修复 Python 依赖」报 `Command … not found` 的问题：这两个命令后台早就有，桌面端漏注册了。
- **AMD 显卡也能看到 GPU 读数（用户反馈 #86，RX 7900 XTX）**：引擎的硬件采样只读 NVIDIA，AMD 显卡上 GPU 负载、显存、温度、功耗、PCIe 一直显示「–」。现在服务跑在本机、引擎又没给出任何 GPU 读数时，管理器会自己从 AMD 驱动读数补上：Windows 用 Adrenalin 驱动自带的 ADLX（`System32\amdadlx64.dll`），Linux 读内核 amdgpu 的 sysfs，不需要额外安装。监控页、总览、浮条和任务栏监控都会显示 GPU 负载、显存、温度和热点温度、功耗、核心与显存频率、风扇转速；驱动没给的项显示「–」并注明「AMD 驱动未提供此项」。引擎已有的读数一律不改，NVIDIA 机器显示不变。「关于」页会写明 GPU 读数来自 AMD 驱动。
- **「选择模型」列表更清楚，并加入标注清楚的社区（无审查）版本（用户反馈）**：引导页第 3 步和「下载模型」页的模型列表改版。模型名不再折成三行：每行只有两行文字，第一行是名称和量化，第二行是标签、内存需求和下载大小。原来的「尚无实测」换成按本机硬件给出的「估算」生成速度，悬停可看依据；详情里再给出首字延迟（4K 提示词）和内存/显存需求，并写明参考的是哪台机器的公开实测、是否为外推。估算全部取自 Strata 上游文档（MAC.md、MODELS.md、QWEN36.md，固定在提交 9de04cd）里同一模型和量化的实测，或由这些实测按量化比例外推，不是本机实测。48 GB 这类内存放不下整个模型的 Mac 会直接说明：引擎会把专家从 SSD 流式读取，能运行、不会失败，只是更慢（上游实测 M4 32 GB 的 Q2_0 为 13.5–14.1 tok/s，M1 Max 34 GB 为 7.9 tok/s），并附 MAC.md 链接。
- 列表顶部新增「官方 / 社区 · 无审查」切换，默认仍是官方，推荐也只来自官方。社区页内置三个条目：SC117 的 Qwen3.8-Flash-Next GSQ-RCO abliterated（Q2_0 / IQ2_XS / IQ3_XXS / IQ3_S，固定版本，每个分片都有字节数和 SHA-256）、alesha-pro 的去拒答控制向量版、OrcaRouter IQ3_XXS。社区条目都有「社区」标记、来源仓库链接（指向固定的提交）和风险提示：去掉了安全拒答、MTP 草稿头没有做 abliteration、作为智能体长期运行时可能又开始拒答。SC117 和 alesha-pro 可以一键下载：走现有的任务流程，先按固定版本下载并逐个核对大小和 SHA-256，再用官方安装程序的 `--gguf-dir` 打包；安装放在单独的 `community/` 数据目录，生成 `strata-community-…json` 配置，不会覆盖同尺寸的官方配置，也不会改动已记住的数据目录。图像功能使用官方、经过 SHA-256 校验的图像投影文件。OrcaRouter 仍走原来的 ORCA 导入流程。
- **社区版复用已下载的官方分片，下载前写明额外占用**：社区文件如果和官方 ISTA-DASLab 分片逐字节相同（alesha-pro 的全部分片，以及各版本共用的 n-gram 第 2 分片），且本机已经下载过官方版，会先确认大小和 SHA-256 一致（读取官方的校验记录，或重新计算），再用硬链接复用，不再下载，也不额外占用磁盘；跨磁盘无法硬链接时改为本地复制并重新校验；对不上就照常下载。官方文件只读、不改动。社区版仍装在独立的数据目录，下载前的详情里会写明预计额外占用：模型文件 + 独立打包（2 GB，Q2_0 为 40 GB）+ MTP 草稿层最多 8 GB（已有则复用），并单独列出可复用的官方分片。
- **Mac 上不能用的条目会变灰并写明原因**：Swift、Coder、Qwen3.6 在 Mac 上变灰（Metal 引擎不支持），官方 Unsloth 也变灰（应用驱动的上游 Mac 安装器只接受 `--family qwen` 的 Q2_0 / IQ3_XXS / IQ3_S，Unsloth 多分片文件目前要用 `./setup.sh` 重新打包，见 MAC.md），都不再出现在推荐里。OrcaRouter 在 Mac 上不可用：Metal 引擎没有 IQ3_XXS 的 gemv 内核，附上游 PR 链接。alesha-pro 在 Mac 上显示「去拒答向量在 Mac 引擎未移植，等同官方版」。Mac 安装程序不接受的量化（例如 IQ2_XS）也会单独标出。
- **自动发现社区模型**：社区页会通过 Hugging Face API 搜索 Strata 能直接运行的 GGUF：量化必须在支持列表里，文件布局和系列必须是 Strata 支持的（GSQ-RCO 双分片或 Unsloth UD），分片齐全、都有 SHA-256，并排除剪枝或蒸馏版本；在 Mac 上只保留 Qwen 和 Unsloth 系列。结果缓存 24 小时，可以手动刷新；离线或请求失败时显示上次的缓存或内置条目，不影响页面。发现的条目标为「社区 · 未验证」，同样可以一键下载（固定到发现时的提交并核对 SHA-256）。桌面端只允许三种只读的 Hugging Face API 请求。
- **应用更新可以走 GitHub 镜像，失败自动回退官方源**：以前应用更新只从 `github.com` 下载，国内网络下检查和下载都很慢，甚至失败。现在应用更新沿用引擎下载的来源设置：选了 GH Proxy、GHProxy 或自定义 `{url}` 镜像时，先走该镜像，失败再回退官方 GitHub；没有指定镜像（官方、本地 ZIP 或无效模板）时，先对官方和内置镜像各做一次 3 秒测速，按速度排序，官方没测赢就排在最后。检查、下载或验签任一步失败都会自动换下一个来源，最后落到官方 GitHub。镜像只用来传输：更新清单里的安装包地址必须仍是官方 GitHub Release 地址，安装包照常用内置公钥验证签名，镜像只接受不带账号密码、不带片段的 HTTPS 地址。更新页会显示实际使用的来源和回退顺序。镜像回答「没有更新」而官方 GitHub 连不上时，会显示「已是最新版本」，不再报错。
- **聊天里的数学公式会排版显示（跟进上游 Strata #3268）**：以前回答里的 LaTeX 公式显示成一串 `$...$` 原文。现在行内公式 `$...$`、`\(...\)` 和独立公式 `$$...$$`、`\[...\]` 都用 KaTeX 排版。KaTeX 和它的字体随应用打包，不联网；只有回答里出现公式时才加载，没有公式的对话不受影响。金额不会被当成公式（「花费 $5 和 $10」保持原文），`\$` 是普通美元符号，代码块和行内代码里的内容也不会被识别；还没写完的公式（例如正在流式输出）先按原文显示。KaTeX 的 `trust` 保持关闭，公式里不能插入链接或图片。
- **可以设置思考长度上限（跟进上游 Strata #2141）**：生成设置里「思考」下面新增「思考长度上限」，填一个 token 数，模型想到上限时会收尾思考并直接作答；留空表示不限，和以前一样。请求里同时带上 Strata 的 `reasoning_budget_tokens` 和 llama-server 的 `thinking_budget_tokens`；思考关闭时不发送。这个上限只用于本应用的聊天请求，不会写进服务的共享默认参数。
- **对话里可以直接预览模型写的 HTML**：回答里的 ```` ```html ```` 代码块多了「代码 / 预览」切换，默认显示代码，点「预览」后才运行；回答还在生成时不能预览。预览在沙箱里运行：页面里的脚本可以执行，但不能联网、不能访问应用页面、Tauri 接口、本地存储或你的文件，也不能弹窗、提交表单或跳转主窗口。桌面版通过独立的 `strata-preview` 协议加载页面，并附带禁止所有网络请求的 CSP。预览可以重新运行、全屏查看，也可以另存为 `.html` 文件。

### English

- **"Free space unknown" on a Mac (user report, macOS 27)**: on a Mac, the "New engine location" and "Model files" rows under Get started → Check environment always said "Free space unknown", and the Storage location page and the pre-install disk check could not read free space either. macOS keeps its system volume "/" read-only and user folders live on the writable Data volume, but the app matched the folder against the mount list, found only "/", and decided the disk was read-only. macOS and Linux now ask the folder's own file system for free space and the read-only flag (`statvfs`, plus `statfs` for the real mount point on macOS); a folder that does not exist yet is measured on its nearest existing parent. Windows is unchanged.
- **First run on Mac / Linux got stuck at "Install Strata" (user report, macOS · M5 Pro)**: after "Start install" the log said "Strata source and private Python environment are ready; next, prepare a model", yet the guide stayed on step 2 saying "Strata files were found but runtime dependencies are not ready". Installing again did the same, and the step list would not move on to "Choose a model". On Mac and Linux the installer only created the private Python environment and checked pip; it never installed Strata's Python packages, while runtime detection requires `regex` and `jinja2` to import. So the task reported "ready" and detection kept saying "needs repair". Installation now installs the source's pinned `requirements.txt` into the private environment (pre-built wheels from the official PyPI only; the system and Homebrew Python are not touched), checks again afterwards, and reports a clear error instead of succeeding when something is still missing. Existing installs do not need a reinstall: pressing "Start install" once more adds the missing packages and moves on. Readiness is re-read as soon as the install finishes instead of on the next poll, and if the runtime still needs repair the guide shows the exact reason (for example which packages are missing). Windows installation already installed the packages and is unchanged.
- **Set a default experimental speed projection in the startup configuration (user request #104)**: Chat has long had a per-chat experimental projection switch, but a model's startup configuration had no matching entry under Default sampling, so it had to be edited in JSON. **Runtime configuration → Default sampling** now has **Default experimental speed projection** with On, Off and Use default. On and Off write JSON `true` / `false`; Use default removes `sampling.experimental_speed_projection` instead of forcing either. A configuration without the entry, or with `null`, shows Use default, and just opening the page does not rewrite the file. Values that are not booleans, such as `"false"`, `0` or `1`, are refused in both the graphical editor and JSON saves (Strata refuses to start with them). Saving changes only this entry and keeps other sampling settings, unknown fields and startup arguments as they were. The order of precedence is unchanged: the request's own value first, then the shared sampling settings, then the startup configuration default; Manager chat keeps sending its per-chat switch. The setting only takes effect when the engine has already loaded an experimental projection control vector, and Manager does not load or download one; restart the model after saving.
- **Windows AMD GPUs could not get the AMD engine (user report #103, RX 9070 XT)**: on a computer with only AMD graphics (an RX 9070 XT, gfx1201, plus a gfx1036 iGPU) the engine step failed three ways. First, a new runtime on Windows always got the CUDA 13 package when no engine was installed yet, and that engine cannot start there. Windows now reads the system's GPU list (`Win32_VideoController`) and maps the card name to its AMD architecture: with only AMD GPUs it installs the matching HIP package (RX 9000 / R9700: the RX 9070 package; RX 7000 / Strix Halo: the RDNA3 package); with an NVIDIA GPU, or when nothing is detected, it still uses CUDA 13. On both Linux and Windows an integrated GPU that no official package supports is ignored instead of forcing a manual choice. Second, the official HIP package downloaded and verified, then failed to unpack with "unknown runtime file: tuning/gfx1201-hipblaslt-100500.txt". That is the package's own hipBLASLt tuning table, and Manager's file allowlist was missing the `tuning/` folder; it is allowed now, and every file is still checked against the signed manifest. Third, upstream `setup.py` only reuses a HIP engine whose `BUILD.json` says `source: prebuilt`. The official 0.2 packages say something else, so the installer tried to download the retired `strata-windows-x64-hip.zip` and got a 404. The cause is in the upstream installer. Before model preparation on Windows, Manager now checks the official HIP engine in `engine/` (valid signed manifest, `BUILD.json` matching its listed digest), marks `source` as `prebuilt`, keeps the original value alongside, and the installer then uses it. Also fixed: **Copy diagnostics** and **Repair Python dependencies** failed on the desktop with `Command … not found`. The background service has had both for a long time, but the desktop app never registered them.
- **AMD GPUs now show GPU readings (user report #86, RX 7900 XTX)**: the engine's hardware sampling only reads NVIDIA, so GPU load, VRAM, temperature, power and PCIe always showed "–" on AMD cards. When the service runs on this computer and the engine reports no GPU readings at all, the manager now reads them from the AMD driver: ADLX from the Adrenalin driver (`System32\amdadlx64.dll`) on Windows, and the kernel amdgpu sysfs on Linux, with nothing extra to install. The Monitor page, Overview, the floating strip and the taskbar monitor show GPU load, VRAM, temperature and hotspot, power, core and memory clocks and fan speed; anything the driver does not provide shows "–" with "Not provided by the AMD driver". Readings the engine already reports are never changed, and NVIDIA machines look the same as before. The About page says the GPU readings come from the AMD driver.
- **A clearer "Choose a model" list, with clearly labelled community (uncensored) builds (user report)**: the model list in step 3 of the guide and on Download models is redesigned. Model names no longer wrap onto three lines: each row has two lines, the name and quantization first, then tags, memory need and download size. "Not measured yet" is replaced by an **estimated** generation speed for this machine, with its basis on hover; the details add the time to first token (4K prompt) and the memory/VRAM need, and name the reference machine and whether a figure is extrapolated. Every estimate comes from upstream Strata's own measurements of the same model and quantization (MAC.md, MODELS.md, QWEN36.md, pinned at commit 9de04cd), or is extrapolated from them by quantization size. Nothing is measured on this machine. A Mac whose memory cannot hold the whole model, such as 48 GB, now says so plainly: the engine streams the experts from the SSD, so it runs and does not fail, it is just slower (upstream measured 13.5–14.1 tok/s for Q2_0 on an M4 32 GB and 7.9 tok/s on an M1 Max 34 GB). A link to MAC.md is shown.
- A new **Official / Community · uncensored** switch sits above the list. Official stays the default, and recommendations still come only from official models. The community view ships three entries:
  - SC117's Qwen3.8-Flash-Next GSQ-RCO abliterated (Q2_0 / IQ2_XS / IQ3_XXS / IQ3_S, pinned revision, size and SHA-256 for every shard)
  - alesha-pro's refusal-direction control vector build
  - OrcaRouter IQ3_XXS

  Each community entry carries a "Community" badge, a link to its source repository at the pinned commit, and the risks: safety refusals are removed, the MTP draft head is not abliterated, and long-running agents may start refusing again. SC117 and alesha-pro download with one click through the existing task flow. The files are fetched at the pinned revision and each one is checked for size and SHA-256, then packed by the official installer with `--gguf-dir`. The install goes into its own `community/` data folder and gets a `strata-community-…json` configuration. It never overwrites the official configuration of the same size or the remembered data folder. Images use the official, SHA-256-checked projector. OrcaRouter keeps the existing ORCA import flow.
- **Community builds reuse official shards you already downloaded, and show the extra disk first**: a community file that is byte-identical to an official ISTA-DASLab shard (all of alesha-pro's shards, and the n-gram shard 2 every size shares) is taken from an official download already on this PC. Its size and SHA-256 are confirmed first (from the official verification mark, or by hashing it), then it is hard-linked, so there is no download and no extra disk. Across drives, where a hard link is impossible, it is copied locally and verified again; if nothing matches, the download runs as before. The official file is only read. Community builds still use their own data folder, and the details now state the estimated extra disk before you download: model files + a separate pack (2 GB, 40 GB for Q2_0) + the MTP draft layer up to 8 GB (reused when present), with reusable official shards listed separately.
- **Entries a Mac cannot run are greyed out with the reason**: Swift, Coder and Qwen3.6 are greyed out on Mac because the Metal engine does not run them. Official Unsloth is greyed out too: the upstream Mac installer the app drives takes only `--family qwen` at Q2_0 / IQ3_XXS / IQ3_S, and Unsloth's many-shard files need the `./setup.sh` repack for now (MAC.md). None of them is recommended there. OrcaRouter is unavailable on Mac because the Metal engine has no IQ3_XXS gemv kernel; the upstream PR is linked. alesha-pro on Mac says "the refusal-direction vector is not ported to the Mac engine, so it equals the official build". Quantizations the Mac installer does not accept (such as IQ2_XS) are marked too.
- **Automatic community discovery**: the community view uses the Hugging Face API to find GGUFs that Strata can run directly. To qualify, a build must:
  - use a quantization from the supported list
  - use a layout and family Strata supports (GSQ-RCO two-shard sets or Unsloth UD)
  - have complete, SHA-256-hashed shards
  - not be pruned or distilled

  On Mac only the Qwen and Unsloth families are kept. Results are cached for 24 hours and can be refreshed by hand. When offline, or when a request fails, the last cache or the built-in entries are shown and the page keeps working. Discovered entries are labelled "Community · unverified" and download with one click as well, pinned to the commit seen at discovery and checked against SHA-256. The desktop app allows only three read-only Hugging Face API request shapes.
- **App updates can use a GitHub mirror and fall back to the official source**: app updates used to come only from `github.com`, which is slow or fails on some networks in China. They now follow the engine download source setting: with GH Proxy, GHProxy or a custom `{url}` mirror selected, that mirror goes first and official GitHub is the fallback; with no mirror selected (official, a local ZIP or an invalid template), the official source and the built-in mirrors get one 3-second speed test each and are tried fastest first, with official GitHub last unless it won. A failed check, download or signature check moves on to the next source, ending at official GitHub. Mirrors only carry the bytes: the manifest must still point at the official GitHub release asset, the package is verified with the built-in public key as before, and a mirror must be HTTPS without credentials or a fragment. The update page shows the source in use and the fallback order. If a mirror reports no update and official GitHub cannot be reached, the app reports that it is up to date instead of showing an error.
- **Math in chat answers is typeset (following upstream Strata #3268)**: LaTeX in answers used to show as raw `$...$`. Inline `$...$` and `\(...\)` and display `$$...$$` and `\[...\]` are now drawn with KaTeX. KaTeX and its fonts ship with the app, need no network, and load only when an answer contains a formula, so chats without math are unaffected. Money is not mistaken for math ("costs $5 and $10" stays text), `\$` is a plain dollar sign, and code blocks and inline code are never searched; an unfinished formula (for example while streaming) shows as its source. KaTeX's `trust` stays off, so formulas cannot insert links or images.
- **Thinking budget (following upstream Strata #2141)**: Generation settings have a new **Thinking budget** under Thinking. Enter a number of tokens and the model wraps up its thinking at that point and answers; leave it blank for no limit, as before. Requests carry both Strata's `reasoning_budget_tokens` and llama-server's `thinking_budget_tokens`; nothing is sent while thinking is off. The budget applies to this app's chat requests only and is never saved as a shared service default.
- **Preview HTML from an answer in the chat**: ```` ```html ```` blocks in answers get a **Code / Preview** switch. Code is the default and nothing runs until you choose Preview, which is unavailable while the answer is still being written. The preview is sandboxed: its scripts run, but cannot reach the network, the app page, Tauri commands, local storage or your files, and cannot open popups, submit forms or navigate the main window. The desktop app loads the page from a separate `strata-preview` scheme with a CSP that blocks every network request. A preview can be run again, viewed full screen, or saved as an `.html` file.

## [0.2.12] - 2026-10-21

### 中文

- **macOS 安装包使用 Developer ID 签名并经 Apple 公证**：以前 Mac 上的 DMG 只有临时签名、没有公证，第一次打开会被 Gatekeeper 拦下，要右键打开或用 `xattr` 去掉隔离。现在 CI 用 Developer ID Application 证书、以硬化运行时签名应用和后台 `strata-supervisor`，用 App Store Connect API key 公证 `.app` 并 staple 公证票据，再把 DMG 换成装有这个已 staple 应用的版本，并用 Developer ID 签名（DMG 本身不单独公证，省下一次几十分钟的等待）。上传前用 `codesign`、`stapler validate` 和 `spctl` 检查；runner 联网出错（如 NSURLErrorDomain -1009）时每项重试 3 次、间隔 30 秒，仍连不上只给警告，而签名身份不对或 Apple 返回 Invalid/Rejected 一律失败。下载后双击 DMG、拖进「应用程序」即可直接打开。应用内更新照旧：Tauri 更新签名不受影响，更新包里的 `.app` 同样已签名和公证。从临时签名的旧版升级后，macOS 会把它当作签名身份不同的应用：第一次读取保存在钥匙串里的凭据时可能弹窗询问，选「始终允许」即可。没有证书的 fork 和外部 PR 构建仍回退为临时签名；本仓库可发布的构建缺少证书或公证凭据时直接失败。
- **Apple 公证慢时，先发 Windows/Linux，Mac 稍后自动补发（默认开启）**：CI 只把应用提交一次给 Apple 公证，最多等 30 分钟（可用仓库变量 `MACOS_NOTARIZATION_TIMEOUT` 调整）。按时通过就和平常一样五个安装包一起发布。还没通过时，这次发版先发 Windows、Linux 和 Server 包，`latest.json` 暂时不含 Mac，Release 说明会注明 Mac 正在公证。新的 `macos-notarize-followup.yml` 每 30 分钟查询一次，Apple 通过后给应用 staple 票据，把 CI 的 DMG 换成装有已 staple 应用的版本并重新用 Developer ID 签名，校验、加更新签名后，把 DMG 和 `.app.tar.gz` 补传到同一个 Release，再把 Mac 加进 `latest.json`。未公证的 Mac 包永远不会发布。补发完成前，Mac 上检查更新会提示找不到本平台的更新，不会安装任何东西。要关闭，把仓库变量 `MACOS_RELEASE_MODE` 设为 `include`、`MACOS_NOTARIZATION` 设为 `wait`。
- **PR 不再提交 Apple 公证**：PR 的检查（包括 `release/*` 和 `full-ci` PR）只签名、不再把应用提交给 Apple；推到 main 时只有改了版本号、还没发版的提交才公证，版本号没变就只签名。发版用的构建照常签名、公证并 staple；只签名的构建永远不会作为 Mac 安装包发布，发版时会在 tag 上重新构建并公证。

### English

- **macOS packages are signed with a Developer ID and notarized by Apple**: the Mac DMG used to be ad-hoc signed and un-notarized, so Gatekeeper blocked the first launch and you had to open it from the context menu or remove quarantine with `xattr`. CI now signs the app and the `strata-supervisor` background process with a Developer ID Application certificate and the hardened runtime, notarizes the `.app` with an App Store Connect API key and staples the ticket. It then rebuilds the DMG around the stapled app and signs the DMG with the Developer ID; the DMG itself is not notarized separately, which saves another wait that can take tens of minutes. Before uploading, CI checks everything with `codesign`, `stapler validate` and `spctl`. Runner network errors (such as NSURLErrorDomain -1009) are retried 3 times, 30 seconds apart, and only warn if Apple is still unreachable. A wrong signing identity or an Invalid/Rejected result from Apple always fails. Open the DMG, drag the app to Applications and open it normally. In-app updates work as before: the Tauri update signature is unaffected, and the `.app` inside the update archive is signed and notarized too. After upgrading from an ad-hoc signed build, macOS treats the app as a different signing identity, so the first read of credentials saved in the Keychain may ask for permission; choose "Always Allow". Fork and external PR builds without the certificate still fall back to ad-hoc signing; release-capable builds in this repository fail if the certificate or notarization credentials are missing.
- **When Apple notarization is slow, Windows/Linux ship first and macOS follows automatically (on by default)**: CI submits the app to Apple once and waits up to 30 minutes (adjust with the repository variable `MACOS_NOTARIZATION_TIMEOUT`). If Apple accepts in time, all five installers are published together as usual. If not, the release publishes Windows, Linux and the server packages first, leaves macOS out of `latest.json` for now, and its notes say macOS is being notarized. The new `macos-notarize-followup.yml` checks every 30 minutes. Once Apple accepts, it staples the app, rebuilds the CI DMG around it and signs the DMG with the Developer ID again. After verifying and update-signing both files, it adds the DMG and `.app.tar.gz` to the same release, then adds macOS to `latest.json`. Un-notarized macOS packages are never published. Until the follow-up finishes, update checks on a Mac report that no update exists for this platform and install nothing. To turn this off, set the repository variables `MACOS_RELEASE_MODE` to `include` and `MACOS_NOTARIZATION` to `wait`.
- **Pull requests no longer submit to Apple notarization**: PR checks, including `release/*` and `full-ci` PRs, sign the app but no longer submit it to Apple. A push to main is notarized only when it bumps to a version that has not been released yet; otherwise it is signed only. Release builds are still signed, notarized and stapled. A signed-only build is never published as the Mac package: the release rebuilds and notarizes on the tag instead.

## [0.2.11] - 2026-10-20

### 中文

- **苹果芯片 Mac 能识别显卡了（用户反馈，M5 Pro）**：以前在 Mac 上只用 `nvidia-smi` 找显卡，Apple 芯片的 GPU 永远找不到，环境检查一直提示「未检测到显卡，生成会很慢」，运行环境页和「我的模型」也显示「未实测」。现在 macOS 上会读 `system_profiler SPDisplaysDataType` 和 IOKit 的 `IOAccelerator`（不需要管理员权限），显示芯片名、GPU 核数和 Metal 版本，例如「Apple M5 Pro · Metal 4 · 20 核 GPU」。按厂商识别，不维护芯片型号列表，以后的 M6、Ultra 等新芯片也能认出。Apple 芯片的 GPU 和系统共用统一内存，所以显示为「统一内存 48 GB（与系统共用），GPU 最多可用约 36 GB」；其中 GPU 可用量读 Metal 的 `recommendedMaxWorkingSetSize`（与 Strata 引擎相同），读不到时按 macOS 默认比例估算。模型推荐和「是否放得下」只按内存计算，不会把统一内存再当作显存加一次。服务运行时，总览的 GPU 卡片把「显存」改称「GPU 可用」，PCIe 链路改为「片上 · 统一内存」。Intel Mac 现在也会显示显卡名称，提示仍是「不是 NVIDIA 显卡」；没有 Metal 的虚拟机显卡会提示可能很慢。诊断信息里也会写出 GPU 核数、Metal 版本和统一内存。
- **macOS 一键安装 Python（用户反馈）**：在 Mac 上，引导页会提示「需要 Python 3.10+（含 venv）」，自动安装也会因为同样的原因失败。原因是 macOS 自带的 `/usr/bin/python3` 一直是 3.9，而 Strata 需要 3.10 或更高版本。以前 Windows 会自动下载 Python，Mac 和 Linux 却只能自己装。现在，在出现这条提示的地方（引导页「检查运行环境」和「安装 Strata」、Strata 页的安装卡片）会多出「一键安装 Python」：把官方 python-build-standalone 构建的 CPython 3.12.15（和 Strata 上游 `setup.sh` 用的是同一个构建）装到应用目录，安装时显示下载进度，可以取消，装好后显示「已就绪」，之后再安装 Strata 会自动用它。整个过程不需要管理员权限，不修改 PATH，也不碰系统或 Homebrew 的 Python。下载可以选择 GitHub 或 GitHub 代理（GH Proxy / GHProxy；如果引擎包已经选了代理，这里会默认沿用），但不论从哪里下载，都要和官方发布的字节数、SHA-256 完全一致才会解包。解包时会逐个检查文件：路径不能越界，链接只能指向包内，权限位会去掉特殊位。支持 Apple 芯片和 Intel Mac，以及 glibc 的 Linux（x86_64 / aarch64）；Windows 仍使用原来的 python.org 私有安装。
- **macOS 使用原生窗口按钮和菜单（用户反馈）**：在 Mac 上，窗口右上角一直显示 Windows 风格的「最小化 / 最大化 / 关闭」三个按钮。现在 Mac 上改为系统原生的红黄绿三个按钮，位于左上角，与标题栏垂直居中；右上角那组按钮在 Mac 上不再显示。左侧品牌区和侧栏会给它们留出位置，侧栏收起时也不会被挡住；进入全屏后系统会隐藏这三个按钮，标题栏恢复原来的布局。标题栏仍可拖动窗口，双击标题栏会缩放窗口。同时新增中文 / 英文的原生菜单栏：「编辑」菜单让 Cmd+C / Cmd+V / Cmd+X / Cmd+Z / Cmd+A 在输入框里正常工作；Cmd+Q 退出界面（与托盘菜单里的「退出」相同，后台服务保持运行），Cmd+W 关闭窗口（按「关闭窗口时」设置隐藏到菜单栏图标或弹出确认），Cmd+M 最小化，Cmd+H 隐藏；窗口隐藏后点 Dock 图标会重新打开。Windows 和 Linux 的标题栏不变。
- **可以选择 Strata 版本，包括降级，并可固定版本（用户反馈）**：以前只能更新到最新版本。现在 Strata 页新增“安装指定版本”：列出上游所有版本（标出当前、最新和预发布，本平台没有安装包的不可选），选中后按升级、降级或重新安装确认。安装走与更新相同的流程：0.2 起的版本验证签名更新清单并要求清单版本与所选版本一致，旧版 ZIP 按 GitHub 的 SHA256 校验，之后试启动，失败自动恢复原版本；只有明确选择了版本时才允许降级。降级前会提示旧引擎可能不支持新模型或参数。勾选“固定在 {版本}，不再提示更新”后，比它新的版本不再弹出更新提示，仍可手动选择任何版本。旧后台不认识“安装指定版本”时会直接报错，不会改装最新版本。
- **浮条「收起到系统托盘」改为「收起到任务栏监控」，删除「托盘监控」图标（用户反馈）**：以前在浮条右键选「收起到系统托盘」，会在通知区多出第二个图标——「托盘监控」，用像素小字显示当前速度，右键菜单里还有「关闭托盘监控」；设置页「更多设置」里的「普通托盘图标」开关控制的也是它。现在这个图标连同它的代码、开关和文字全部删除。Windows 上浮条右键菜单改为「收起到任务栏监控」：浮条隐藏，由任务栏监控在任务栏上接着显示实时读数，并记住到下次启动；要换回浮条，在任务栏监控右键选「切换为桌面浮条」。其他系统没有任务栏监控，菜单里不再出现这一项。系统托盘只保留一个普通应用图标，不显示读数。以前打开过「普通托盘图标」的设置会在升级后自动移除，不会自动打开任务栏监控；需要时在「任务栏监控」设置里打开即可。
- **引擎和模型可以放到其他磁盘（用户反馈：「只能放 C 盘」）**：以前模型保存位置只能看、不能改（「模型下载配置」里的「选择其他目录」其实是换一个 Strata 运行环境），引擎固定装在 C 盘的应用数据目录下，首次向导里也只写着「应用数据目录」。现在 Strata 页新增「存储位置」，首次向导的「检查环境」和「下载模型」页顶部也都能直接更改：显示当前路径、已用大小和所在磁盘剩余空间，用系统文件夹选择器选任意磁盘，并先检查目录可写、路径不超过 120 个字符、不是符号链接。更改模型位置时可以选「把已有模型移动过去」：先复制到新位置并逐字节核对 SHA-256，再改写模型配置里的路径、写入 Strata 的 `data_dir`，最后才删除旧文件；同盘直接移动文件夹。复制、核对或改写任一步失败或被取消，配置和设置都会还原，旧文件保留不动。移动有进度条，可以取消，期间不能启动模型。也可以选「只让新下载使用新位置」。「新引擎安装位置」只影响之后安装的引擎，已装好的引擎不搬动。没改过的用户默认位置不变。「模型下载配置」里原来的按钮改名为「选择其他 Strata 目录」，并新增「更改保存位置…」。

### English

- **Apple Silicon Macs now show their GPU (user report, M5 Pro)**: the app only looked for GPUs with `nvidia-smi`, so a Mac's Apple GPU was never found. The environment check always warned "No GPU detected; generation will be slow", and the Environment and My models pages showed "Not measured". On macOS the app now reads `system_profiler SPDisplaysDataType` and IOKit's `IOAccelerator` (no admin rights needed) and shows the chip, GPU core count and Metal version, for example "Apple M5 Pro · Metal 4 · 20-core GPU". Detection goes by vendor rather than a list of chip names, so later chips (M6, Ultra and so on) are recognized too. Apple GPUs share unified memory with the system, so the app shows "Shares 48 GB unified memory with the system; the GPU can use about 36 GB". The GPU share comes from Metal's `recommendedMaxWorkingSetSize`, the same figure the Strata engine uses, and is estimated from the macOS default ratio when Metal can't be asked. Model recommendations and fit estimates count memory once and never add unified memory again as VRAM. While the service runs, the Overview GPU card says "GPU budget" instead of "VRAM" and "On-chip · unified memory" instead of a PCIe link. Intel Macs now show their GPU names and still get the "Not an NVIDIA GPU" note; a virtual machine's GPU without Metal gets a "may be slow" warning. Support diagnostics list GPU cores, Metal version and unified memory.
- **One-click Python on macOS (user report)**: on a Mac the guide said "Python 3.10+ with venv is required", and automatic installation failed for the same reason. macOS still ships Python 3.9 as `/usr/bin/python3`, while Strata needs 3.10 or newer. Windows already downloaded Python automatically, but Mac and Linux users had to install it themselves. Wherever that message appears (the guide's environment check and Strata install step, and the install card on the Strata page) there is now "Install Python". It puts CPython 3.12.15 from the official python-build-standalone build (the same build upstream Strata's `setup.sh` uses) into the app folder, shows download progress, can be cancelled, and reports when it is ready; the next Strata installation uses it automatically. It needs no administrator rights, leaves PATH alone and never touches the system or Homebrew Python. You can download from GitHub or a GitHub proxy (GH Proxy / GHProxy; an engine package proxy you already chose is used by default). Whatever the source, the file must match the official byte count and SHA-256 exactly before it is unpacked. Unpacking checks every entry: paths must stay inside, links may only point within the package, and special permission bits are removed. Apple silicon and Intel Macs are supported, as is glibc Linux (x86_64 / aarch64); Windows keeps its existing private python.org install.
- **macOS uses native window buttons and menus (user report)**: on a Mac the window still showed Windows-style minimize / maximize / close buttons in the top-right corner. Macs now get the system's red, yellow and green buttons in the top-left corner, vertically centred in the header, and the custom buttons are gone there. The brand area and the sidebar leave room for them, including when the sidebar is collapsed; in full screen macOS hides the buttons and the header returns to its usual layout. The header still drags the window, and double-clicking it zooms. A native menu bar (Chinese or English) is added too: the Edit menu makes Cmd+C / Cmd+V / Cmd+X / Cmd+Z / Cmd+A work in text fields; Cmd+Q quits the interface (like "Quit" in the tray menu, background services keep running), Cmd+W closes the window (hiding it to the menu bar icon or asking first, per the close setting), Cmd+M minimizes and Cmd+H hides; clicking the Dock icon brings a hidden window back. The Windows and Linux title bar is unchanged.
- **Choose a Strata version, including a downgrade, and pin it (user request)**: updates used to go to the latest release only. The Strata page now has **Install a specific version**: it lists every upstream release (marked current, latest and pre-release; versions without a package for this platform cannot be chosen) and confirms the choice as an upgrade, downgrade or reinstall. Installation uses the same path as updates: from 0.2 on the signed update feed is verified and its version must equal the chosen one, legacy ZIPs are checked against GitHub's SHA256, then the engine gets a trial start and the previous version is restored if it fails; a downgrade is allowed only for an explicitly chosen version. Before a downgrade the dialog warns that an older engine may not support newer models or options. With **Stay on {version} and stop update prompts** checked, newer releases no longer prompt for an update, and any version can still be chosen by hand. An older backend that does not know "install a chosen version" reports an error instead of installing the latest release.
- **The strip's "Move to system tray" is now "Move to taskbar monitor", and the "tray monitor" icon is gone (user report)**: choosing "Move to system tray" in the strip's menu used to add a second notification-area icon, the tray monitor, which drew the current speed in tiny pixel digits and had a "Close tray monitor" item; the "Standard tray icon" switch under "More settings" controlled the same icon. That icon is removed together with its code, switch and text. On Windows the strip's menu now offers "Move to taskbar monitor": the strip hides, the taskbar monitor carries on showing the live readings on the taskbar, and this is remembered for the next launch; choose "Switch to desktop strip" in the taskbar monitor's menu to go back. Other systems have no taskbar monitor and no longer show the entry. The system tray keeps a single plain app icon with no readings. An old "Standard tray icon" setting is dropped on upgrade and does not turn the taskbar monitor on by itself; switch it on under "Taskbar monitor" if you want it.
- **Engines and models can go on another drive (user report: "they can only go on C:")**: the model location used to be read-only (the "Choose another folder" button in Model download settings actually picked another Strata runtime), engines were always installed in the app data folder on C:, and the first-run guide only said "App data directory". The Strata page now has **Storage locations**, and the first-run guide's environment check and the top of Download models can change it too: each shows the current path, the space used and the free space on its drive, opens the system folder picker for any drive, and first checks that the folder is writable, at most 120 characters and not a link. When changing the model location you can choose "Move my existing models there": files are copied to the new folder and verified with SHA-256, the paths in model configurations are rewritten and Strata's `data_dir` is saved, and only then are the old files deleted; on the same drive the folders are moved in place. If copying, verifying or rewriting fails or is cancelled, configurations and the setting are restored and the old files stay. The move shows progress, can be cancelled, and blocks model starts while it runs. "Use the new location for new downloads only" is also offered. **New engine install location** applies to engines installed from now on; installed engines are not moved. Defaults are unchanged for anyone who does not change them. In Model download settings the old button is renamed "Choose another Strata folder", and a "Change location…" button is added.

## [0.2.10] - 2026-10-20

### 中文

- **一键提速支持 Strata 0.2.0（用户反馈，RTX 4080 Super）**：在 Strata 0.2.0（引擎 0.1.45.3）上打开「参数调优 → 一键提速」，会显示「测量没有完成：服务观察器版本、心跳或持久化状态不完整，保留当前服务」。原因是 0.2.0 给服务端的 `_json` 新增了 `retry_after` 参数，统计观察器的结构检查不认识这个签名，于是整体停用。观察器一停，一键提速、完整场景验收和运行中原地更新都没法安全地暂停请求，API 使用统计也会中断。现在观察器会把 `retry_after` 原样转发给上游，并已把 0.2.0 的 `serve/server.py` 和 `serve/mcp.py` 加入审核清单。上游 MockEngine 的 36 项 HTTP 合同测试全部通过，没有跳过；0.1.43.1 和 0.1.44.1 也重新跑过。已在用 0.2.0 的服务更新 Manager 后需要重启一次。
- **一键提速失败提示说清原因和做法**：观察器检查失败时，不再只显示一句笼统的报错，而是分别说明是哪种情况（版本不在兼容列表、观察器没有运行、心跳超时、数据库写不进去、观察器没有接管服务）以及该怎么做（更新 Manager、重启模型服务、检查磁盘空间），中英文等 10 种语言都已翻译。
- **打开页面不再把以前的失败当成当前报错**：打开页面之前就已失败的测量，改为灰色的「上次测量（时间）没有完成」，附上原因，可以点「不再显示」关掉。只有本次打开页面后发生的失败才显示为红色报错。旧版本留下的那条笼统报错会改成解释：常见原因是旧版 Manager 还不兼容这个 Strata 版本。
- **任务栏监控：生成与预填充上下叠放，更窄**：同时选中「生成速度」和「预填充速度」时，两项合成一列，上行是生成（星形小图标），下行是预填充（箭头小图标），各自保持原来的颜色，不再占两列、也不再显示「生成 / 预填充」文字标签。默认布局在 100% 缩放下从 134 px 缩到 87 px（150% 下从 199 px 缩到 131 px）。只选其中一项时保持原来「数字在上、标签在下」的样式。两个速度本来就不会同时有数值：生成只在生成中显示，预填充只在读取提示词时显示，另一行显示「—」。
- **任务栏监控：新增「上下文」圆环**：「圆环显示」新增「上下文」选项（设置页和任务栏右键菜单都有）：显示当前请求（空闲时为上一次请求）的输入加输出 Token 占模型最大上下文的比例，数据与概览页的「上下文」仪表相同；读不到时圆环留空。圆环用新的青色，深浅色任务栏上对比度都不低于 4.5:1，也可以在「颜色」里自定义。
- **任务栏监控：字体更细**：数字、单位和圆环中的数字由粗体改为常规字重，标签保持常规字重，看起来更接近系统时钟。
- **任务栏监控：右键菜单清晰、悬停有高亮、子菜单悬停即展开**：右键菜单一直是系统原生菜单，但宿主进程没有声明 DPI 感知，菜单在 125% / 150% 缩放下被系统按位图拉伸，看起来发虚；菜单的所属窗口又是不可激活的工具窗口，无法成为前台窗口，导致悬停没有高亮、子菜单要点击才打开。现在菜单在按显示器 DPI 感知（Per-Monitor V2）的独立隐藏窗口里创建和弹出，弹出前先切到前台，关闭后按系统要求发送 `WM_NULL`，因此文字清晰、悬停高亮、子菜单悬停展开、点外面即关闭，深浅色跟随任务栏。菜单内容不变（含新的「上下文占用」圆环选项）。

### English

- **One-click speed-up works with Strata 0.2.0 (user report, RTX 4080 Super)**: on Strata 0.2.0 (engine 0.1.45.3), "Tuning → One-click speed-up" showed "The measurement did not finish: 服务观察器版本、心跳或持久化状态不完整，保留当前服务". The cause: 0.2.0 adds a `retry_after` parameter to the server's `_json`, the usage observer's structural check did not recognize that signature, and the observer turned itself off. With the observer off, one-click speed-up, scenario verification and in-place updates of a running service cannot safely pause requests, and API usage statistics stop. The observer now passes `retry_after` through to upstream unchanged, and the 0.2.0 `serve/server.py` and `serve/mcp.py` are on the reviewed list. All 36 upstream MockEngine HTTP contract tests pass with no skips; 0.1.43.1 and 0.1.44.1 were re-run too. A service already running 0.2.0 needs one restart after updating Manager.
- **Speed-up failures say what is wrong and what to do**: when the observer check fails, you no longer get one vague message. It says which case applies (version not on the compatibility list, observer not running, no heartbeat, database not writable, observer not attached) and what to do (update Manager, restart the model service, check disk space), in all 10 interface languages.
- **Old failures are no longer shown as current errors**: a measurement that failed before the page was opened now appears as a grey "The last measurement (time) did not finish" with the reason, and can be dismissed. Only failures from this visit are red. The vague message left by older versions is replaced by an explanation: usually an older Manager did not support that Strata version yet.
- **Taskbar monitor: generation and prefill stack, narrower**: with both "Generation speed" and "Prefill speed" selected, they now share one column: generation on top (spark icon) and prefill below (arrow icon), each in its own colour, without the "Gen / Prefill" captions. The default layout shrinks from 134 px to 87 px at 100 % scaling (199 px to 131 px at 150 %). With only one of them selected the number-over-label column stays as before. The two speeds never have values at the same time anyway: generation shows while generating, prefill while reading the prompt, and the other line shows "—".
- **Taskbar monitor: new "Context" ring**: "Ring shows" gains a "Context" option (in Settings and in the taskbar right-click menu). It shows the input plus output tokens of the current request (the last one when idle) as a share of the model's maximum context, from the same data as the overview "Context" gauge; the ring stays empty when unknown. It uses a new teal with at least 4.5:1 contrast on light and dark taskbars and can be customised under "Colors".
- **Taskbar monitor: lighter text**: numbers, units and the ring value now use the regular weight instead of bold; labels stay regular, closer to the system clock.
- **Taskbar monitor: crisp right-click menu with hover highlight and hover-open submenus**: the menu was always the native Windows menu, but the host process declared no DPI awareness, so at 125 % / 150 % Windows bitmap-stretched it and it looked blurry; and its owner was a non-activatable tool window that could not become the foreground window, so items did not highlight on hover and submenus opened only on click. The menu is now created and tracked from a separate hidden, per-monitor-v2 DPI-aware owner window that is brought to the foreground first, with the documented `WM_NULL` afterwards: crisp text, hover highlight, submenus open on hover, an outside click closes it, and light/dark follows the taskbar. The items are unchanged (including the new "Context usage" ring option).

## [0.2.9] - 2026-10-20

### 中文

- **Linux 官方预编译引擎**：Linux x86_64（桌面版与无头 Server）现在也能从签名 feed 安装和更新官方引擎包：CUDA 13、CUDA 12、AMD HIP RX 9000 / R9700、AMD HIP RX 7000、AMD HIP Strix Halo。校验与 Windows 完全相同：feed Ed25519 签名、渠道、有效期和序号，整包 SHA256，安全解包，再按包内签名清单 `engine-component.json` 逐个核对文件。「自动匹配」会先看已安装引擎的 `BUILD.json`（兼容 Linux 包没有 `backend`、只有 `variant` 如 `halo` 的写法），没有引擎时按检测到的显卡选包：NVIDIA 读取驱动版本和计算能力（`nvidia-smi`，退而读 `/proc/driver/nvidia/version`），优先 CUDA 13，驱动低于 feed 要求时改选 CUDA 12 或提示升级驱动；AMD 读取 `gfx` 架构（KFD 拓扑，退而用 `rocminfo`）。同时检测到 NVIDIA 与 AMD、未检测到显卡或有多个包都合适时，不猜测，提示在「官方更新包」中手动选择，并在界面上显示匹配理由。解包后保留可执行权限；Linux 的 `.venv` 缺少新版依赖时会自动补装。源码安装方式不变；首次安装仍走源码方式，之后的版本更新使用官方预编译引擎。
- **试启动与自动回滚**：安装或更新引擎后，先用新引擎试启动（`strata --version`，加载包内库目录），再重启服务并做健康检查；任一步未通过都会自动恢复原来的引擎和程序文件，模型和配置不受影响，并重启原服务。原版本在试启动通过前一直保留。Strata 页面会显示「新引擎试启动未通过，已自动回滚」、恢复到的版本和具体原因；更新确认窗口会提前说明这一机制。
- **概览：模型名称统一、加载时不再满屏报错（小红书用户反馈，2× RTX 2080 Ti）**：
  - 上方启动卡和下方运行卡现在都显示你选中的模型名。配置里的 `model_name`（客户端调用 API 时填写的名称）作为「API 模型名」小字显示在旁边。以前下方大标题用的是 `model_name`，看起来像启动了另一个模型。
  - 修复启动日志里混进上一次运行记录的问题。上游以追加方式写引擎日志，Manager 之前会把文件末尾的旧内容（上次的请求统计，如 `missed experts skipped`、`prompt … tokens`）当成本次启动输出显示。现在只显示本次启动之后写入的内容。
  - 冷启动期间，接口还没打开或引擎忙时偶尔失败的轮询不再显示成红色报错：启动进行中、进程启动后 2 分钟内、以及 `/health` 报告模型仍在加载时，状态和指标的连接失败会被隐藏；超过这段时间仍然失败才提示。
  - 启动卡里的「引擎输出」默认收起，只在标题行显示最新一行；展开后注明这是加载进度和统计，不是报错。真正的错误行（Traceback、`…Error:`、显存不足、fatal 等）标红，并自动展开。
  - 运行卡新增「启动参数」按钮，直接打开当前模型的启动参数页（上下文长度、显卡分配、完整引擎参数列表、完整 JSON 编辑，保存前自动备份，可「保存并重启当前模型」）。
- **Strata 引擎下载与更新进度改为易读格式**：以前进度显示原始字节数（如 `1320702444 / 2254857830 字节`），现在显示为 `下载进度：1.23 GiB / 2.10 GiB（58%）· 12.4 MiB/s`，带百分比和下载速度。断点续传、重试、SHA256 校验通过、本地引擎包读取、官方同版本源码下载等提示也都改用 KiB / MiB / GiB。更新弹窗「包信息」里的精确字节数保持不变。

### English

- **Linux prebuilt engines**: Linux x86_64 (desktop and the headless Server) can now install and update the official engine packages from the signed feed: CUDA 13, CUDA 12, AMD HIP RX 9000 / R9700, AMD HIP RX 7000 and AMD HIP Strix Halo. Verification matches Windows exactly: the feed's Ed25519 signature, channel, expiry and sequence, the package SHA256, safe extraction, then every file against the signed `engine-component.json` manifest. Automatic matching reads the installed engine's `BUILD.json` first (including Linux builds that carry `variant`, such as `halo`, instead of `backend`). Without an engine it picks by the detected GPU: for NVIDIA it reads the driver and compute capability (`nvidia-smi`, falling back to `/proc/driver/nvidia/version`), prefers CUDA 13, and switches to CUDA 12 or asks for a driver update when the driver is older than the feed requires; for AMD it reads the `gfx` target (KFD topology, falling back to `rocminfo`). When both vendors or no GPU are found, or several packages fit, it does not guess: it asks you to choose under "Official update package" and shows why. Executable permissions survive extraction, and a Linux `.venv` missing new requirements is completed automatically. The source install is unchanged; first installs still build from source, and later version updates use the official prebuilt engine.
- **Trial start and automatic rollback**: after an engine install or update, Manager first trial-starts the new engine (`strata --version` with the package's library folders), then restarts services and checks their health. If any step fails, the previous engine and program files are restored automatically, models and settings stay untouched, and the previous services restart. The previous version is kept until the trial passes. The Strata page shows "The new engine failed its trial start and was rolled back", the restored version and the exact reason; the update confirmation explains this in advance.
- **Overview: one model name, no wall of errors while loading (Xiaohongshu feedback, 2× RTX 2080 Ti)**:
  - The startup card and the running card now both show the model you picked. The configuration's `model_name` (the name clients send to the API) appears next to it as a small "API model name" detail. The running card used to put `model_name` in the headline, which looked like a different model had started.
  - Fixed old runs leaking into the startup log. Upstream appends to the engine log, and Manager showed the end of the file, including the previous run's per-request statistics (`missed experts skipped`, `prompt … tokens`), as this start's output. Only lines written after this start are shown now.
  - During a cold start, polls that fail because the API port is not open yet or the engine is busy are no longer shown as red errors. Health and metrics failures are hidden while a start is pending, for 2 minutes after the process starts, and (metrics) while `/health` reports the model is still loading; failures that last longer are shown.
  - The startup card's "Engine output" is collapsed by default with only the latest line in its header; expanded, it notes that these are load progress and statistics, not errors. Real error lines (Traceback, `…Error:`, out of memory, fatal) are red and expand the panel automatically.
  - The running card has a new "Startup parameters" button that opens the current model's startup parameters (context length, GPU split, the full engine argument list and the full JSON editor; saves are backed up, and "Save and restart current model" applies them).
- **Readable Strata engine download and update progress**: progress used to show raw byte counts (e.g. `1320702444 / 2254857830 字节`). It now reads like `下载进度：1.23 GiB / 2.10 GiB（58%）· 12.4 MiB/s`, with percent and download speed. Resume, retry, SHA256-verified, local engine package and same-version source download messages also use KiB / MiB / GiB. Exact byte counts under "Package details" in the update dialog are unchanged.

## [0.2.8] - 2026-10-19

### 中文

- **支持 Strata 0.2.0**：上游 0.2.0 不再发布 `strata-windows-x64*.zip`，改为签名 feed（`strata-feed.json`）加按显卡分开的 `strata-engine-<版本>-windows-x86_64-<类型>.tar.gz` 引擎包。Manager 现在会识别 `v0.2.0-beta` 这类预发布版本号，校验 feed 的 Ed25519 签名、渠道、有效期和序号（不接受回放旧 feed），只提供 feed 与 GitHub 发布资产在长度和 SHA256 上都一致的 Windows 包：CUDA 13、CUDA 12、AMD HIP RX 9000 / R9700、AMD HIP RX 7000 / Strix Halo。下载后先核对整包 SHA256，再安全解包 tar.gz（只接受普通文件，拒绝链接、路径穿越和大小写冲突），最后用包内签名清单 `engine-component.json` 逐个核对文件和 SHA256，多一个或少一个文件都不安装。同版本源码会带上 0.2.0 服务启动所需的 `strata_control`；依赖只减少时（0.2.0 移除了 cmake / ninja）可原地更新。0.2.0 的 CUDA 包已自带 cuBLAS，新安装不再额外下载 CUDA 运行库。旧版多显卡 HIP 引擎需在更新时手动选择对应的 AMD 包。本地文件可选 `.tar.gz` 或旧版 `.zip`；旧版 ZIP 发布的安装与更新不变。尚未在真实 NVIDIA / AMD 硬件上做完整安装验收。

### English

- **Supports Strata 0.2.0**: upstream 0.2.0 no longer publishes `strata-windows-x64*.zip`; it ships a signed feed (`strata-feed.json`) and per-GPU `strata-engine-<version>-windows-x86_64-<type>.tar.gz` engine packages. Manager now accepts pre-release versions such as `v0.2.0-beta`, verifies the feed's Ed25519 signature, channel, expiry and sequence (an older feed cannot be replayed), and offers only Windows packages whose size and SHA256 agree between the feed and the GitHub release assets: CUDA 13, CUDA 12, AMD HIP RX 9000 / R9700 and AMD HIP RX 7000 / Strix Halo. After download it checks the package SHA256, extracts the tar.gz safely (regular files only; links, path traversal and case collisions are refused) and then checks every file and its SHA256 against the signed `engine-component.json` manifest inside the package; one extra or missing file stops the install. The same-version source now keeps `strata_control`, which the 0.2.0 server needs; an update whose Python requirements only shrink (0.2.0 dropped cmake / ninja) is applied in place. 0.2.0 CUDA packages bundle cuBLAS, so new installs no longer download the CUDA runtime wheels. An older multi-GPU HIP engine asks you to choose the matching AMD package. Local files can be `.tar.gz` or legacy `.zip`; installing and updating from earlier ZIP releases is unchanged. A full install on real NVIDIA / AMD hardware has not been validated yet.

## [0.2.7] - 2026-10-19

### 中文

- **无头 Server 实验版（#6 P0/P1）**：新增 `strata-manager-server`（axum），默认 `127.0.0.1:8787`，首次运行生成 Bearer 令牌；`POST /api/v1/rpc` 对接 `RuntimeState::dispatch`，可托管同一套 Web 前端。浏览器侧增加 server 传输与令牌门禁；文件选择改为服务器路径输入；隐藏托盘、悬浮监控与桌面自动更新器。附 systemd unit、`scripts/package-server.sh` 与 `docs/SERVER.md`。CI 增加 server crate 测试与 Linux 打包产物；发布资产在原 11 项之外增加 `Strata.Manager.Server_<ver>_amd64.tar.gz` / `.deb`（共 13 项，仍无 `SHA256SUMS`，Server 包不进 updater）。
- **macOS Metal 引擎预制包（#53 第二期 a）**：在 Apple Silicon 上可下载并校验上游 `strata-engine-*-macos-arm64-metal.tar.gz`（钉死 v0.2.0-beta 资产名与 SHA256，应用内校验，不附带 SHA256SUMS），解包到 `engine/`；也支持选用本地 `.tar.gz` 或已有 Strata/`engine`、`build-metal` 目录。Mac 上不提供 Windows/Linux 引擎包；模型目录隐藏上游未在 Metal 验收的 Qwen3.6 / Swift / Coder；默认 `--spec 2`，不开放 PC `--calibrate` 与 `--parallel`。`./setup.sh` 源码构建仍为手动提示，真机推理验收待进行。
- **任务栏监控（Windows，#71）**：「监控设置 → 任务栏监控（Windows）」新增开关，默认关闭。开启后在主屏任务栏通知区左侧嵌入一个小部件：圆环显示 GPU 负载（可改为显存占用或不显示），旁边每项指标一列：上方是加粗数值和小号单位（如「21.3 t/s」），下方是灰色短标签（生成、预填充、GPU、显存、温度）。每项指标有自己的颜色（生成绿、预填充蓝、GPU 橙、显存紫），GPU 温度按数值变色（低于 60℃ 绿、60–80℃ 琥珀、高于 80℃ 红）；深浅两套配色在 Win11 浅色和深色任务栏上的对比度都不低于 4.5:1。圆环用所选指标的颜色，右下角小圆点表示服务状态。数字紧凑显示（3.2k，100 以上不带小数），每列宽度固定，数值变化时不会左右跳动；默认内容在 100% 缩放下宽 134 px。「颜色」区可为生成、预填充、GPU、显存、温度分别设置自定义颜色（色块 + 8 个在深浅任务栏上都清晰的预设色 + 自定义取色，可一键恢复默认）；自定义颜色在深浅两种任务栏上都使用，对比度不足时给出提示，自定义温度颜色会取代按温度变色；服务状态圆点颜色不可改。任务栏右键菜单新增「自定义颜色…」，直接打开设置页的颜色区。还可加入 GPU 负载、显存、GPU 温度、服务状态，宽度随所选内容变化。小部件由独立的原生 Win32 辅助进程绘制（不使用 WebView），每秒最多刷新一次，数值不变时不重绘；文字颜色跟随任务栏深浅色，按 DPI 缩放；任务栏自动隐藏、全屏应用、通知区变宽和 Explorer 重启时会跟随或重新挂载，放不下时回到桌面浮条并说明原因。左键打开 Strata Manager，不抢焦点、不出现在 Alt-Tab；右键菜单可「打开 Strata Manager」、在「自定义内容」中勾选显示项和圆环指标，或「关闭任务栏监控」，与设置页同步。仅支持横向的主屏任务栏。
- **托盘图标恢复为普通应用图标**：撤回此前在托盘图标上绘制读数的实验方案，实时读数改由任务栏监控提供。

### English

- **Headless Server experiment (#6 P0/P1)**: adds `strata-manager-server` (axum), default bind `127.0.0.1:8787`, first-run Bearer token; `POST /api/v1/rpc` maps onto `RuntimeState::dispatch` and can serve the existing Web UI. Browser gains a server transport and token gate; file picks become server path inputs; tray, floating monitor and desktop updater are hidden. Includes systemd unit, `scripts/package-server.sh` and `docs/SERVER.md`. CI tests and packages the server on Linux; releases add `Strata.Manager.Server_<ver>_amd64.tar.gz` / `.deb` (13 assets total, still no `SHA256SUMS`; server packages are updater-independent).
- **macOS Metal prebuilt engine (#53 phase 2a)**: on Apple Silicon, Manager can download and verify the upstream `strata-engine-*-macos-arm64-metal.tar.gz` (pinned v0.2.0-beta asset name and SHA256; in-app checks only, no SHA256SUMS files), extract into `engine/`, or use a local `.tar.gz` / existing Strata `engine` or `build-metal` directory. Windows/Linux engine packages are never offered on Mac; the catalog hides Qwen3.6 / Swift / Coder (not measured on Metal upstream); defaults use `--spec 2` and omit PC `--calibrate` / `--parallel`. `./setup.sh` remains a manual hint; real-device inference validation is still pending.
- **Taskbar monitor (Windows, #71)**: Monitor settings → "Taskbar monitor (Windows)" adds an on/off switch, off by default. When on, a small widget sits left of the notification area on the primary taskbar: a ring shows GPU load (or VRAM usage, or no ring), followed by one column per metric: a bold value with a small unit on top (e.g. "21.3 t/s") and a short grey label below (Gen, Prefill, GPU, VRAM, Temp). Each metric has its own colour (generation green, prefill blue, GPU orange, VRAM violet), and GPU temperature changes colour with the reading (green below 60 ℃, amber 60–80 ℃, red above 80 ℃); the light and dark palettes keep at least 4.5:1 contrast on Win11 light and dark taskbars. The ring uses the selected metric's colour, and a small dot at its lower right shows the service state. Numbers are compact (3.2k, no decimals above 100) and every column has a fixed width, so values never shift sideways; the default set is 134 px wide at 100 % scaling. A "Colors" section lets you override the colour of generation, prefill, GPU, VRAM and temperature (swatch, eight presets that stay readable on both light and dark taskbars, a custom picker, and reset to default); a custom colour is used on both taskbar themes, low contrast is flagged, and a custom temperature colour replaces the graded scheme, while the service-state dot keeps its fixed colours. The right-click menu adds "Customize colors…", which opens that section in the app. GPU load, VRAM, GPU temperature and service status can be added, and the width follows the selection. It is drawn by a separate native Win32 helper process (no WebView), refreshes at most once per second and skips repaints when nothing changed; text follows the taskbar's light/dark colour and DPI scaling; it follows or re-attaches on auto-hide, fullscreen apps, notification-area width changes and Explorer restarts, and falls back to the desktop strip with a reason when there is no room. Left-click opens Strata Manager without stealing focus or appearing in Alt-Tab; the right-click menu offers "Open Strata Manager", a "Customize" submenu for items and the ring metric, and "Close taskbar monitor", all in sync with the settings page. Horizontal primary taskbars only.
- **Tray icon is the plain app icon again**: the experimental readings drawn into the tray icon were withdrawn; live readings now come from the taskbar monitor.

## [0.2.6] - 2026-10-19

### 中文

- **通过「模型 - 添加目录」加入的 Strata 能正常启动（#78）**：启动、依赖检测、一键修复、向导和 MCP 自检统一使用同一个解释器选择规则，和目录自己的 run-*.bat 一致（启动脚本指定的 Python、目录内 `.venv`、嵌入式 Python），并带上脚本设置的 PATH / PYTHONPATH，清掉系统的 PYTHONHOME；目录有自带环境时绝不改用系统 Python。配置里的引擎 exe 不存在时，扫描和启动前就会提示，不再等到加载模型时才报 WinError 2。加载失败不再只显示 `error sending request for url (.../load)`，而是按进程状态和引擎日志分成「引擎在加载模型时崩溃」「Python 环境不对」和仍在加载三种情况，原始错误保留在启动日志和诊断依据里；Windows 中文系统下的报错也不再乱码。
- **发布不再附带 `SHA256SUMS`**：从下一个版本起，GitHub 发布页只提供安装包、对应的 `.sig` 更新签名和 `latest.json`，共 11 项资产。应用内更新仍按 `latest.json` 与 `.sig` 验签；应用内对模型和引擎 ZIP 的大小与 SHA256 校验不变。已发布版本的资产保持原样。
- **「使用已有模型」面板整理**：向导与下载模型页的本地 GGUF 面板统一左对齐与间距节奏；路径放入输入框；量化行改为名称/说明在左、体积与状态点在右；状态用中性文字 + 小圆点，仅问题用色；MTP 与等效命令默认折叠；长说明收成一行。
- **使用已有模型（#75）**：向导「选择模型」一步和「下载模型」页新增「使用已有模型」。选择存放 GGUF 的文件夹或其中一个分片后，Manager 按模型与量化版本分组，检查分片是否齐全、可读、GGUF 文件头和大小，再以官方安装器的 `--gguf-dir` 原地使用这些文件，不再下载模型权重；可选择已有的 MTP 草稿层（上游 setup.py 没有 `--mtp` 安装参数，因此映射为 `--data-dir`），并显示等效的 `START-HERE.bat` 命令。文件名与官方发布名不同但量化受支持时给出提示而不再拒绝；OrcaRouter 去审查 IQ3_XXS 走 ORCA.md 兼容流程；引擎不支持的量化会说明原因。已检测到但尚未登记的 Strata 运行环境现在也可直接用于准备模型，不再显示“请先选择 Strata 运行环境”。

### English

- **Strata folders added with Models → Add folder start correctly (#78)**: starting, the dependency check, one-click repair, the wizard and the MCP self-check now share one interpreter rule that matches the folder's own run-*.bat (the launcher's Python, the folder's `.venv`, or an embedded Python), keep the PATH / PYTHONPATH the script sets and drop the host PYTHONHOME; a folder with its own environment never falls back to the system Python. A configured engine exe that does not exist is reported at scan time and before starting, instead of as WinError 2 while loading. A failed load no longer shows just `error sending request for url (.../load)`: it is classified from the process state and engine log as "engine crashed while loading", "wrong Python environment" or still loading, with the raw error kept in the startup log and diagnostic evidence; Windows error text on Chinese systems is no longer garbled.
- **Releases no longer include `SHA256SUMS`**: starting with the next version, GitHub releases provide the installers, their `.sig` updater signatures and `latest.json`, 11 assets in total. In-app updates still verify `latest.json` and `.sig`; the in-app size and SHA256 checks for model and engine ZIPs are unchanged. Assets of published releases stay as they are.
- **Existing-model panel polish**: the local-GGUF panel in the guide and on Download models now shares one left edge and spacing rhythm; the chosen path sits in a field; each quantization row keeps the name on the left and size + a quiet status dot on the right (color only for problems); MTP and the equivalent command collapse by default; long help text is shortened to one line.
- **Use an existing model (#75)**: the guide's model step and the Download models page now offer "Use an existing model". Choose the folder with your GGUF files (or one shard); Manager groups them by model and quantization, checks that every shard is present and readable with a valid GGUF header and size, and has the official installer use them in place with `--gguf-dir`, without downloading the weights again. An existing MTP draft layer can be chosen (upstream setup.py has no `--mtp` setup flag, so it maps to `--data-dir`), and the equivalent `START-HERE.bat` command is shown. Renamed files with a supported quantization get a warning instead of being refused; OrcaRouter Uncensored IQ3_XXS uses the ORCA.md compatibility workflow; quantizations the engine cannot run are explained. A detected Strata runtime that is not registered yet can now be used to prepare models directly instead of showing "Choose a Strata runtime first".

## [0.2.5] - 2026-10-19

### 中文

- **跳过向导后仍可使用本地安装包（#74）**：Strata 页面新增「使用已下载的安装包」入口。未安装时可选择本机已下载的 Strata 源码 ZIP 和（Windows）引擎 ZIP 安装，校验与安装流程与向导完全相同；运行环境需要补齐时同样可用；已安装时可通过「使用本地安装包」用官方引擎 ZIP 更新或重装当前版本，安装前按官方 SHA256 校验。

### English

- **Local packages after skipping the guide (#74)**: the Strata page now offers "Use downloaded packages". Without a runtime you can install from an already-downloaded Strata source ZIP and (on Windows) engine ZIP with the same validation and installation as the guide; this also works when the runtime needs repair. With a runtime installed, "Install from local package" updates or reinstalls the engine from an official engine ZIP, verified against the official SHA256 first.

## [0.2.4] - 2026-10-19

### 中文

- **多显卡显示（#69）**：总览按「2× 显卡型号」显示同型号多卡，并逐卡列出显存、负载和温度；运行环境卡片不再只显示首张卡加「+1」。PCIe 链路注明来自 GPU 0。
- **大模型加载不再误报失败（#70）**：冷加载超过 `/load` 请求超时（5 分钟）但引擎仍在加载时，继续等待模型就绪（最长 30 分钟，进程退出才判失败），总览显示「模型加载中（已 N 秒）」；启动失败记录在模型加载中或已就绪后自动隐藏，且不再把原始 JSON 显示给用户。

### English

- **Multiple GPUs (#69)**: the overview names identical cards as "2× model" with per-card VRAM, load and temperature; the environment strip no longer shows only the first card plus "+1". The PCIe link is labelled as GPU 0's.
- **Slow model loads are no longer reported as failures (#70)**: when a cold load outlasts the 5-minute `/load` request timeout while the engine is still loading, startup keeps waiting for readiness (up to 30 minutes; only a process exit fails it) and the overview shows "Loading the model (N s so far)". Stale startup failures are hidden while the model loads or once it is ready, and raw JSON is never shown.

## [0.2.3] - 2026-10-19

### 中文

- **本地 / ZIP 引擎安装报「系统找不到指定的路径」（#65）**：修复 v0.2.2 的回归——引擎解包目录已缩短为 `e`，但读取 `BUILD.json` 仍使用旧的 `engine` 目录，导致 HIP 等 ZIP 安装与更新在解包后立即报 os error 3。解包、读取与替换现统一使用同一目录。
- **虚拟显示器被识别为显卡（#66）**：Windows 未检测到 NVIDIA 显卡时，不再把 Meta Virtual Monitor、Parsec、远程桌面、Microsoft 基本显示适配器等软件/虚拟显示设备列为 GPU。

### English

- **Local / ZIP engine install fails with "path not found" (#65)**: fixes a v0.2.2 regression where the engine was extracted into the shortened `e` directory but `BUILD.json` was still read from the old `engine` directory, so HIP and other ZIP installs/updates failed with os error 3 right after extraction. Extraction, reading and replacement now share one directory.
- **Virtual displays detected as GPUs (#66)**: on Windows without an NVIDIA GPU, software/virtual display adapters such as Meta Virtual Monitor, Parsec, Remote Desktop and Microsoft Basic Display are no longer listed as GPUs.

## [0.2.2] - 2026-10-19

### 中文

- **本地 Strata 源码包识别（#63）**：从 GitHub Release 下载的 `Strata-<版本>.zip` / `Strata-v<版本>.zip`（顶层目录不再仅限 `Strata-<commit>/`）可直接作为本地安装包通过校验。
- **HIP / 深层引擎 ZIP 解包（#62）**：引擎解包改为直接写入并缩短工作目录，Windows 使用长路径前缀；避免 tempfile + MoveFileEx 在深层 `rocm/...` 路径上报「系统找不到指定的路径」。路径过长时给出中文提示。

### English

- **Local Strata source archives (#63)**: GitHub Release `Strata-<version>.zip` / `Strata-v<version>.zip` trees are accepted as local install archives (not only `Strata-<commit>/` folder names).
- **HIP / deep engine ZIP extract (#62)**: engine unpack writes files directly with a shorter work directory and Windows long-path prefixes, avoiding tempfile + MoveFileEx “path not found” on deep `rocm/...` trees; overlong paths get a clear Chinese hint.

## [0.2.1] - 2026-10-19

### 中文

- **Python 依赖误报修复**：扫描时优先使用 Strata 启动脚本（`run-*.bat` / `run-*.sh`）里的私有 Python，冷启动探测等待放宽到约 20 秒，超时也不再偷偷换到系统解释器，避免 bat 能跑而 Manager 误标「需要修复」。
- **内存需求文案**：模型「运行约需 X GB」改为峰值参考，并标明显存卸载后可更低；有 NVIDIA 显卡时，内存单独不够只警告为「偏紧」，**不阻挡「启用配置」**。
- **顶栏 CTA**：本机已扫到模型但尚未启用服务时，顶栏由「尚未配置服务」改为「已发现模型，点启用」，并可一键跳到「我的模型」。
- **显存容量**：服务未运行时，若 `nvidia-smi` 已给出容量，不再长期显示「未实测」，改为展示已知显存容量。
- **一键修复运行环境**：缺 regex / jinja2 时，向 Strata 启动脚本使用的同一私有 Python 执行 `pip install`（不另造解释器）。
- **一键复制诊断信息**：打包引擎版本、安装目录、Python 路径、缺失模块、近期日志摘要与本机 OS/GPU/RAM 到剪贴板，便于发给支持。

### English

- **Python dependency false “needs repair”**: discovery prefers the private Python named by Strata launchers (`run-*.bat` / `run-*.sh`), allows ~20s for cold Windows probes, and no longer silently switches interpreters on timeout — so a working bat install is not flagged for repair.
- **Memory need copy**: the “needs about X GB” line is now an official *peak* figure and notes GPU offload can lower host RAM; with an NVIDIA GPU, short system RAM alone warns as tight and **does not block Enable configuration**.
- **Title-bar CTA**: when models are discovered but no service profile is enabled, the pill says “Models found — tap to enable” and jumps to My models.
- **VRAM capacity**: when the service is stopped but `nvidia-smi` already reported capacity, the UI shows that capacity instead of lingering “Not measured”.
- **One-click repair runtime**: missing regex / jinja2 are installed into the same private Python the Strata launchers use — no second interpreter.
- **One-click copy diagnostics**: engine version, install dir, Python path, missing modules, a short recent-log snippet, and OS/GPU/RAM as plain text for support.

## [0.2.0] - 2026-10-19

### 中文

- **一键提速（参数调优第一期）**：调优页默认「一键提速」，按通用场景测速并扫描可提速参数，显示前后对比；结果另存为新配置，可回退。场景验收收进高级；短请求诊断入口已去掉；修复快速校准把 PCIe 专家比例写死从而关掉自动的问题。
- **排行榜**：修复切换排序后一直显示「暂时连不上排行榜」——请求参数白名单补上排序与搜索；真正断网才显示连不上，其它错误显示具体原因；重试时恢复默认筛选与排序。
- **移除模型配置页的「资源适配建议」**；首次安装向导与下载页的精简资源预估保留。
- **Qwen3.6-35B-A3B**：模型目录与安装流程支持引擎 0.1.45 的三档量化（UD-Q4_K_XL / UD-Q6_K_XL / Q8_0）；引擎过低时下载页禁用并提示。
- **OrcaRouter 去审查模型**：下载模型页可导入官方兼容的 IQ3_XXS（自动下载分片或选本地），后台兼容打包后出现在「我的模型」，标明社区兼容、仅文本。
- **Unsloth 更高量化**：在原有档位外增加 UD-Q5_K_XL、UD-Q6_K_XL、Q8_0（内存需求更高）。
- **首次安装**：支持选择已下载的本地 Strata / 引擎安装包并跳过下载。
- **复制为新配置**：已登记配置的副本会自动登记，可在配置列表中选用。
- **发布验签**：补上 `darwin-aarch64` 与 DMG 资产校验，使含 Mac 实验包的 Release 能通过门禁并公开。
- **macOS 第一期（实验）**：CI 在 `macos-15` / `aarch64-apple-darwin` 打出未公证 DMG 与 updater 用 `.app.tar.gz`（临时签名）。文档与官网标明实验包、Gatekeeper 限制，以及 **DMG alone 不含 Metal 引擎**（引擎仍待后续 `./setup.sh`）。不提供 Intel 包。关联 #53。

### English

- **One-click speed boost (Tuning phase 1)**: Tuning defaults to one-click speedup for a general workload, compares before/after, and saves a new configuration you can roll back. Scenario checks move under Advanced; the short-request diagnostics entry is removed; quick calibration no longer pins PCIe expert share and disables auto.
- **Leaderboard**: fixing sort switches that stuck on “leaderboard unavailable” — allowlist now includes sort and search; only real network failures show unavailable; other errors show a concrete reason; retry resets filters and sort.
- **Removed the Resource fit advice panel** from model configuration; the compact estimate on onboarding and download remains.
- **Qwen3.6-35B-A3B**: catalog and install flow support engine 0.1.45 quants (UD-Q4_K_XL / UD-Q6_K_XL / Q8_0); downloads disable with a hint when the engine is too old.
- **OrcaRouter uncensored**: Download models can import the official-compatible IQ3_XXS (fetch shards or pick local files), run compat packaging in the background, and list the result under My models as community-compatible, text-only.
- **Higher Unsloth quants**: adds UD-Q5_K_XL, UD-Q6_K_XL and Q8_0 (higher memory needs).
- **First-time install**: choose an already-downloaded local Strata / engine archive and skip the download.
- **Copy as new configuration**: copies of registered configurations are registered automatically and selectable in the list.
- **Release verification**: allow `darwin-aarch64` and DMG assets so a release that includes the experimental Mac packages can pass the gate and publish.
- **macOS phase 1 (experimental)**: CI on `macos-15` / `aarch64-apple-darwin` produces an un-notarized DMG and updater `.app.tar.gz` (ad-hoc signing). Docs and the website mark the package experimental, note Gatekeeper limits, and state that the **DMG alone does not include a Metal engine** (engine setup remains a later `./setup.sh` phase). No Intel package. See #53.

## [0.1.13] - 2026-10-18

### 中文

- **并发支持**：运行配置页新增“并发”卡片，按显存、内存和显卡数量给出建议：16 GB 单卡推荐会话缓存，32 GB 推荐同时处理 4 个请求，多卡按层切分；一键应用时会同时设置所需的配套参数。会检查 `parallel` 与 `--batch` 冲突（可一键修复）、`--batch-groups` 无法整除（拒绝保存），超过 262K 上下文时提示并发与长上下文冲突。新增 `--trim-stage-weights`；`STRATA_BATCH_ATTN_ROWS` 等实验性环境开关只在高级区域显示，并标明“实验性”。
- **并发阶梯测试**：场景测试页可按 1 → N 个同时请求逐级测试，实时显示每级的总吞吐和单请求速度，结束后给出推荐并发数。结果只保存在本机，不上传排行榜。
- **槽位监控**：始终显示全部列，新增生效槽数、总速度、排队数和每个槽位的速度趋势；监控页和状态栏会合计多路生成的速度。
- **调优页并发对比**（可选）：把候选并发设置另存为新的配置版本，依次切换并跑阶梯测试，结束后恢复原配置，用表格和图表对比结果。切换配置时不会中断测试；在快速校准时，如果并发大于 1 会给出提示。
- **1M 上下文**：上下文预设新增 384K 和 1M。超过 262,144 时，运行配置页自动写入 `--rope-scaling yarn` 和对应倍数（1M 为 4），改回 262K 以内时自动移除；手动设置的值不会被改动，倍数不对时给出提示并提供“改为官方设置”。页面会常显“实验性”说明，以及 KV 缓存和 RoPE 表的占用；资源预估改为计入 YaRN 倍数和 RoPE 表，不再显示“未知”。
- **参数调优改版**：可以实时看到步骤、轮次、正在测的参数、tok/s、进度和预计剩余时间，并可取消。新增“快速校准”（默认模式，对应官方 `tools/calibrate.py`）：依次测预填充分块、PCIe 专家比例和 MTP 草稿阈值，只临时覆盖请求参数，不改配置、不重启，只有提升超过 3% 才推荐。结果默认另存为新配置版本，覆盖当前配置需要确认，并保留 `.bak`；日志随报告保存。运行配置新增 `--prefill-pipe`。
- **场景测试页改版**：先选场景、开始测试，再看实时进度和分场景结果。运行时显示当前请求、首 token 时间、已用时间与预计剩余，以及逐请求散点图。结果包含 5 项关键指标（含 P50/P95/P99）、分场景柱状图和表格，请求样本带输出片段。去掉全部折叠区，原有选项和导出功能保留。
- **排行榜筛选与排序**：应用内与官网的排行榜可按显存、内存、上下文、KV、并发、显卡数和专家缓存筛选，并可按 8K 解码、128K 解码、预填充或机器数排序；官网的筛选结果写入链接，可以分享。
- Benchmark 页移除顶部的“当前服务能力”面板；服务能力核验仍在“API 与外部助手”页。
- 官网和 README 更新了产品介绍，新增开始使用引导、排行榜和旧版本配置清理的截图，并重截了日常体验截图。

### English

- **Concurrency**: Runtime configuration adds a Concurrency card that recommends settings from VRAM, memory and GPU count: conversation cache on a single 16 GB card, 4 requests at once on 32 GB, and a layer split across multiple GPUs. Applying a recommendation also sets the companion parameters it needs. The card flags a `parallel` / `--batch` conflict (with a one-click fix), refuses to save a `--batch-groups` value that does not divide evenly, and notes the conflict between concurrency and contexts past 262K. Adds `--trim-stage-weights`; experimental environment switches such as `STRATA_BATCH_ATTN_ROWS` appear only under Advanced and are labeled Experimental.
- **Concurrency ladder**: the scenario benchmark can step from 1 to N concurrent requests, showing total throughput and per-request speed live for each step, then recommend a concurrency. Results stay on this machine and are not uploaded to the leaderboard.
- **Slot monitor**: always shows every column, and adds active slots, total speed, waiting requests and a per-slot speed trend. Monitoring and the status bar add up speed across generating streams.
- **Concurrency comparison in Tuning** (optional): saves candidate concurrency settings as new configuration versions, switches through them running the ladder, restores the original configuration, and compares results in a table and chart. Switching configurations does not interrupt the run, and quick calibration shows a note when concurrency is above 1.
- **1M context**: context presets add 384K and 1M. Past 262,144, Runtime configuration writes `--rope-scaling yarn` and the matching factor (4 for 1M), and removes them when you go back to 262K or less. Manual values are left alone; a wrong factor shows a note with “Use official settings”. An Experimental note stays visible with the KV cache and RoPE table sizes, and resource estimates now include the YaRN factor and RoPE table instead of showing Unknown.
- **Tuning redesign**: live step, round, parameter under test, tok/s, progress and time remaining, with cancel. New quick calibration (the default, matching upstream `tools/calibrate.py`) measures prefill pipe, PCIe expert share and MTP draft threshold by overriding request parameters only. It changes no configuration and needs no restart, and recommends a value only when it is more than 3% faster. Results are saved as a new configuration version by default; overwriting the current configuration needs confirmation and keeps a `.bak`. The log is saved with the report. Runtime configuration adds `--prefill-pipe`.
- **Scenario benchmark redesign**: choosing scenarios, starting, live progress and per-scenario results now come first. A run shows the current request, time to first token, elapsed and remaining time, and a per-request scatter chart. Results show five key metrics (including P50/P95/P99), a per-scenario bar chart and table, and output excerpts in the request samples. No folded sections; every existing option and export is kept.
- **Leaderboard filters and sorting**: the in-app and website leaderboards filter by VRAM, memory, context, KV, concurrency, GPU count and expert cache, and sort by 8K decode, 128K decode, prefill or machine count. Website filters are kept in the link so you can share them.
- Removed the Current service capabilities panel from the top of Benchmark; capability checks remain on the API & assistants page.
- The website and README have an updated product introduction, new screenshots of the getting-started guide, leaderboard and old-version configuration cleanup, and recaptured daily-experience screenshots.

## [0.1.12] - 2026-10-17

### 中文

- **Benchmark 排行榜**：在应用内的排行榜页预览将要上传的内容并同意后，每次测试完成会匿名上传结果，可随时关闭、撤回并删除已上传数据。排行榜按“同模型 + 同量化”分组对比，组内展示硬件与启动参数，并为本机推荐参数和模型、标注可信度；公开排行榜位于 strata-manager.cosfoc.com/leaderboard。上传数据带每台机器的签名与运行证据，异常结果会被剔除；应用内的排行榜数据只经后台读取，界面本身不直接联网。
- **首次使用引导**：新增“开始使用”页，把检查环境、安装 Strata、选择模型、下载、启动并加载、第一次聊天串成 6 步；进度会保存，已完成的步骤按真实状态自动识别并跳过。选模型时按本机显存和内存推荐“模型 + 量化”，并参考排行榜的公开速度数据（只读）。也可以直接连接本机已运行的服务。总览页会显示未完成引导的续接入口，完成后可在设置中重新打开。
- **运行配置页改版**：去掉顶部的资源估算区块，页头只保留标题和常用操作，资源适配建议收成一行提示（可展开查看依据）；主编辑区为“启动参数”，文件名、复制和删除放在卡片标题行；有未保存改动时底部保存栏会提示。“返回我的模型”并入面包屑。
- **多版本 Strata 配置管理**：多个 Strata 版本共用同一份 `Strata-data` 权重时，各版本的配置不再混在一起。每份配置标注“Strata 0.1.xx”并按版本从新到旧排列；默认只显示当前版本，其他版本收进“其他版本 · N”，可用“显示全部版本”开关查看全部；内容相同的配置合并为一行并标注“另有 N 个版本相同”（只影响显示）。新增“清理旧版本配置”：按版本列出旧版本目录中的配置，勾选后移入回收区并记录原路径，可以恢复；正在使用的、当前版本的配置以及模型切片、mtp 等共享文件永远不会列出。
- **接入 API 弹窗精简**：说明文字更短，验证细节（token 上限、限时、不执行 MCP、图片测试用图、不保存结果）收进帮助提示；验证结果改为逐步清单，带状态图标和耗时，失败原因显示在对应步骤下，后续步骤标“已跳过”，整体结果为一行状态，能力信息显示为标签。
- **API 使用统计页改版**：顶部一行显示请求、成功率、失败、输入 Token、输出 Token、生成速度六项关键指标；原来的六张小图合成一张主趋势图，用标签切换；新增请求结果环形图，调用来源表增加成功率与占比。原本折叠的调用来源、实时资源、请求明细与导出、统计说明、高级诊断改为直接显示，统计说明改为标签页；时间范围改为分段切换。
- **官网迁到 Cloudflare**：官网与 Benchmark 排行榜现位于 strata-manager.cosfoc.com，`main` 更新后自动部署；旧的 github.io 地址与更新日志等旧链接会跳转到新域名。
- **修复**：Windows 上打开运行配置页时不再弹出“找不到 cublas64_13.dll”系统错误框。读取引擎参数列表时会套用与启动服务相同的运行库路径和环境变量；仍缺少运行库时只在页面内显示一行提示，参数照常可编辑；后台进程遇到缺失 DLL 时直接以错误码退出，不再弹出需要点击的系统对话框。
- **修复**：总览页显存条与内存条的色块和图例颜色保持一致；高占用改由大号数字颜色和 85% 阈值线提示。
- 移除运行环境页的“用官方脚本更新 Strata”；更新 Strata 继续使用版本检查与更新包（官方 GitHub、镜像或本地 ZIP）。

### English

- **Benchmark leaderboard**: after previewing what will be uploaded on the in-app Leaderboard page and agreeing, each finished test uploads its result anonymously; you can turn this off, withdraw, and delete uploaded data at any time. Results are compared within the same model and quantization, showing hardware and launch parameters per group, with parameter and model recommendations for this machine and a confidence label. The public leaderboard is at strata-manager.cosfoc.com/leaderboard. Uploads carry a per-machine signature and run evidence, and outliers are removed; the app reads leaderboard data only through its background process and the interface never connects to the network directly.
- **Getting started guide**: a new Getting started page links checking the environment, installing Strata, choosing a model, downloading, starting and loading, and the first chat into six steps. Progress is saved, and steps that are already done are detected from real state and skipped. Model choice recommends a model and quantization for this machine's VRAM and memory, using public leaderboard speed data (read-only). You can also connect to a service already running on this machine. Overview shows a resume entry while the guide is unfinished, and Settings can reopen it later.
- **Runtime configuration redesign**: the resource estimate block at the top is gone; the header keeps the title and common actions, and resource advice becomes a one-line hint that expands to show its basis. The main editor is “Launch parameters”, with file name, copy and delete on the card title row, and the bottom save bar flags unsaved changes. “Back to My models” moves into the breadcrumb.
- **Multi-version Strata configurations**: when several Strata versions share one `Strata-data` weight folder, their configurations no longer pile up together. Each configuration is labeled “Strata 0.1.xx” and sorted newest first; only the current version is shown by default, other versions fold into “Other versions · N”, and a “Show all versions” toggle shows everything. Identical configurations collapse into one row marked “Same in N other versions” (display only). New “Clean up old version configurations” lists configurations in older version folders by version; selected files move to a recovery folder with their original paths recorded so they can be restored. Configurations in use, the current version's configurations, and shared files such as model shards and mtp are never listed.
- **Simpler Connect API dialog**: shorter copy, with verification details (token cap, time limit, no MCP execution, test image, nothing saved) moved into a help tooltip; results are now a step checklist with status icons and timings, failure reasons under the step, later steps marked Skipped, a one-line overall result and capability chips.
- **API usage redesign**: a top row shows six key metrics: requests, success rate, failures, input tokens, output tokens and generation speed. The six small charts become one main trend chart with tabs; a request outcome ring chart is added, and the caller table adds success rate and share. Callers, live resources, request details and export, statistics notes and advanced diagnostics are shown directly instead of folded, with notes as tabs; the time range is a segmented switch.
- **Website on Cloudflare**: the website and the Benchmark leaderboard now live at strata-manager.cosfoc.com and deploy automatically from `main`; old github.io addresses and changelog links redirect to the new domain.
- **Fix**: opening Runtime configuration on Windows no longer shows a “cublas64_13.dll was not found” system error. Reading the engine's parameter list now uses the same library paths and environment as starting the service; if a library is still missing, the page shows a one-line note and parameters stay editable, and background processes exit with an error code instead of a system dialog that waits for a click.
- **Fix**: VRAM and memory bar segments on Overview now match their legend colors; high usage is shown by the large figure's color and the 85% threshold line.
- Removed “Update Strata with the official script” from the runtime page; updating Strata continues through the version check and release packages (official GitHub, mirrors or a local ZIP).

## [0.1.11] - 2026-10-17

### 中文

- **总览改版**：一屏查看服务状态与控制、显存和内存占用图、最近生成速度与趋势、今日 API 请求，异常（服务停止、显存吃紧、排队、失败）在顶部先提示。
- **模型与系统页面统一改版**：我的模型、下载模型、运行配置、Strata 运行环境、参数调优、任务与日志、Benchmark、公共设置、API 与外部助手、显存与会话、应用更新、关于共 12 页采用同一套克制的视觉语言；原有功能和操作全部保留。
- **下载模型实时更新**：下载进度、已下载、上次失败和“适合这台电脑”的判断在列表行内原地刷新，无需手动重载；量化表新增本机内存对照列；目录条目变化时标记“新 / 已更新”。
- **资源估算**：我的模型显示本机显存与内存容量，每份配置显示运行所需内存；运行配置页按目录量化参考值估算资源，无法计算时明确显示“未实测”。
- 任务与日志新增 24 小时时间线（点击定位到任务日志）；运行环境页新增设备与 PCIe 信息；Benchmark 新增档位轴；参数调优新增候选收益点图；API 页以接入地址为焦点并可一键复制；应用更新页突出当前版本与更新状态，并提供更新日志链接；关于页新增项目信息卡与许可摘要。

### English

- **Overview redesign**: one screen for service status and controls, a VRAM and memory map, recent generation speed and trend, and today's API requests; problems (stopped service, tight VRAM, queueing, failures) are surfaced first.
- **Consistent redesign of model and system pages**: My models, Download models, Runtime configuration, Strata runtime, Tuning, Tasks & logs, Benchmark, Settings, API & assistants, VRAM & sessions, App updates and About now share one restrained visual language; every existing feature and action is kept.
- **Live model catalog**: download progress, downloaded and last-failed states and the “fits this machine” verdict update in place without reloading; the quantization table compares against this machine's memory; changed catalog entries are marked New / Updated.
- **Resource estimates**: My models shows VRAM and memory capacity and the memory each configuration needs; Runtime configuration estimates resources from catalog guidance and says “Not measured” when it cannot.
- Tasks & logs adds a 24-hour timeline that jumps to a task's logs; the runtime page shows devices and PCIe link; Benchmark adds a tier axis; Tuning plots candidate gains; the API page centers the endpoint with one-click copy; App updates leads with the current version and status and links to the changelog; About adds a project card and license summary.

## [0.1.10] - 2026-10-15

### 中文

- **修复 #9**：添加官方模型数据目录（`Strata-data` / `--data-dir`）时不再静默跳过；会通过官方 `settings.json`、同级安装目录，以及目录内的 `strata-*.json` 解析到安装根并列出模型。若仍找不到可启动配置，空状态会提示改为添加安装目录或使用「导入配置」。
- **修复 #9（续）**：引擎有效性优先读 `strata-*.json` 的 `exe` 路径，不再只认 `engine/`；支持 `engine-cuda12/`、自行解压的 `engine_cuda12/` 等目录。配置仍写 `engine/` 但二进制只在 `engine_cuda12/` 时也会回退匹配；运行环境版本与更新检测、视觉引擎默认路径同样跟随配置中的引擎目录。

### English

- **Fix #9**: adding an official model data directory (`Strata-data` / `--data-dir`) is no longer silently skipped. Discovery resolves the install root via official `settings.json`, sibling installs, and `strata-*.json` under the folder. If nothing runnable is found, the empty state explains adding the install directory or using Import configuration.
- **Fix #9 (follow-up)**: engine validity prefers the run-config `exe` path instead of only `engine/`. Supports `engine-cuda12/`, self-extracted `engine_cuda12/`, and similar folders. If the config still says `engine/` but the binary only lives under `engine_cuda12/`, discovery falls back. Runtime version / update detection and the default vision-engine path follow the config engine directory as well.

## [0.1.9] - 2026-10-14

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
