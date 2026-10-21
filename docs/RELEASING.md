# 构建与发布 / Build and release

公开仓库：[hongfaqiu/strata-manager](https://github.com/hongfaqiu/strata-manager)。正式更新源为该仓库 Release 中的 `latest.json`；签名私钥不得进入 Git、前端资源、构建工件或截图。

当前版本内容见 [更新日志](../CHANGELOG.md)。普通 main CI 只构建和测试；推送新的不可变 `v<version>` 标签后，Release 工作流才会等待并复用该源码的完整 CI 安装包，验签并公开发布。CI 通过本身不会创建 Release。

## 历史发布与流程准备记录

[v0.1.3](https://github.com/hongfaqiu/strata-manager/releases/tag/v0.1.3) 已公开。其安装包来自源码 `ec0797dc06fc833cb5ebf433ecfb71b4c113767c` 的[完整 CI](https://github.com/hongfaqiu/strata-manager/actions/runs/38159155279)，经[签名与发布验收](https://github.com/hongfaqiu/strata-manager/actions/runs/38163066611)公开八项资产。后续版本使用下文的通用产物复用流程；这些历史结果不替代新源码的完整验收。

2026-10-11：已公开 [v0.1.0-beta.1 预览版](https://github.com/hongfaqiu/strata-manager/releases/tag/v0.1.0-beta.1)，包含 Windows x64 NSIS、Linux x64 AppImage/DEB、三份更新签名、`latest.json` 和 `SHA256SUMS`。发布源码为 `ab3bacc68fd8c9a95cc92de05ae2439976c91e5f`。Windows 原始 tag 构建在创建草稿时因 GitHub 工作流写权限规则收到 403；保留原始已签名产物，经[恢复检查](https://github.com/hongfaqiu/strata-manager/actions/runs/38078576661)核对构建身份、artifact 摘要并实际完成安装、启动、IPC 和卸载。Linux 原始签名构建通过 AppImage/解包 DEB 启动检查。发布前独立下载全部实际更新包，使用内置公钥验证签名及签名中的版本，并比对三个安装包的 SHA256；本次预览通过验证后恢复发布，原失败记录仍保留。

[Windows/Linux 完整 CI](https://github.com/hongfaqiu/strata-manager/actions/runs/38077681492) 已通过，三种安装包均上传并通过启动检查。后续发布流程已加入实际 tag commit 绑定、默认分支创建提示、明确的手动 tag 门禁及临时目录下的 `GH_REPO` 绑定；新增发布门禁本地 36 项全部通过。GPU 实机、登录自启动和跨版本更新安装仍单独验收，不能由安装包启动或发布验签结果外推。

2026-10-10：公开仓库已创建，正式 HTTPS 更新地址、公钥与 `createUpdaterArtifacts` 已配置，Actions 的 `TAURI_SIGNING_PRIVATE_KEY` secret 已设置。当前密钥没有密码，因此密码 secret 可缺省为空。发布门禁测试 5 项通过，两个工作流 actionlint 检查通过，Windows debug sidecar 已实际构建并核对打包副本 hash。

2026-10-11：发布门禁新增真实更新包密码学验签和有界分页草稿查询，最新 Node 17 项、Rust 7 项通过，此前 release CLI 的 3 个密码学场景通过；最终五 crate workspace Clippy、fmt、版本检查通过。普通 CI 和 Release 构建阶段会构建验签 helper 并运行完整 Node 门禁；publish 阶段再次使用 release helper 检查实际草稿资产，全部成功后才公开。夹具公钥及签名不含用户私钥。

第三、四轮 CI 已实际生成 Linux AppImage/DEB。第四轮 Windows 在 desktop 后台包身份断言失败，未运行到此前的监听 fixture；后台锁同步修复已通过本地回归，完整 CI 待复验。这些证据不能当作 Windows/Linux tag 构建、公开签名产物或客户端更新安装完成。完整发布结果与当前产品验收缺项见 [VERIFICATION](VERIFICATION.md)。Windows Authenticode 发布者签名尚未配置，Tauri updater 签名不提供该能力。

## 发布内容

| 平台 | Rust target | 发布文件 |
| --- | --- | --- |
| Windows x64 | `x86_64-pc-windows-msvc` | NSIS `*-setup.exe` 及 `.sig` |
| Linux x64 | `x86_64-unknown-linux-gnu` | `.AppImage`、`.AppImage.sig` 和桌面 `.deb` |
| macOS Apple Silicon（实验） | `aarch64-apple-darwin` | `*_aarch64.dmg`（手工下载）与 `*_aarch64.app.tar.gz`（updater；`latest.json` 的 `darwin-aarch64`）。v0.2.12 起 Developer ID 签名 + Apple 公证（见下方「macOS 签名与公证」）；不提供 Intel。**DMG 仍不含引擎**；Manager 可装上游预制 Metal 包（真机验收待进行）。 |
| Linux x64 无头 Server（#6） | `x86_64-unknown-linux-gnu` | `Strata.Manager.Server_<ver>_amd64.tar.gz` 与 `Strata.Manager.Server_<ver>_amd64.deb`（**无** updater `.sig`；不进 `latest.json`） |

每个安装包包含桌面外壳及独立 `strata-supervisor` 后台。Python、Strata 运行时和模型权重使用应用内的独立安装/导入流程，模型不进入 GitHub 构建工件。平台安装包构建成功不等于对应 GPU 推理已验收；必须在发布说明中列出实际测试的平台、驱动和范围。

普通用户首次使用应进入自动检测/准备流程，不能以安装 Git、填写 Python 路径和手选安装目录作为默认操作步骤。旧版 Manager 有效档案和会话自动迁移，已有模型无需再准备；其它本机安装导入时保留原源码、配置与权重。新模型准备完成后自动核验登记，保留当前选择；用户选用后由后台启动/加载。首次模型请求按后台策略加载，或提前预载；登录自启动只启动后台。

## 固定运行环境下载来源

自动准备的下载清单位于 `crates/runtime-core/src/installation.rs`。当前来源和 SHA256 为：

| 文件 | 固定来源 | SHA256 |
| --- | --- | --- |
| Strata 源码 ZIP | [固定上游 revision](https://codeload.github.com/Niko1221/Strata/zip/fb58e0dbc8399662c0e47c76578c6e878b14f6cf) | `b6b559866cf7d422d7acace638d542049ea7e3543720f574cb97b2d0bd530d7b` |
| Python 3.13.16 Windows x64 | [Python.org 安装器](https://www.python.org/ftp/python/3.13.16/python-3.13.16-amd64.exe) | `fb4f9f5d438b2396da0086dc70b935c530cb578e37adc6d354f7ad2037fee83b` |

源码归档已实际下载、解包并完成私有 venv/pip 准备；Python 安装器已实际下载，hash 与 [Python.org 签名元数据](https://www.python.org/ftp/python/3.13.16/python-3.13.16-amd64.exe.sigstore) 一致，但尚未执行缺 Python 时的安装分支。Windows 安装到应用数据目录，不修改 PATH、安装全局 Git 或要求管理员权限；Linux 检测 Python/venv/ensurepip，缺少系统依赖时提供诊断，不执行 sudo。

更新固定 revision 时必须重新核验实际归档 hash，并验证 observer 的兼容 hash、上游 setup 参数、来源许可和真实准备测试。hash 不符时停止解包/执行，不使用跳过校验的回退。固定源码的变化不属于 Tauri 应用 updater 验签范围；模型权重仍由上游 setup 独立准备。

## 初次配置更新签名

1. 在仓库目录之外生成并安全备份 Tauri 更新密钥，使用**绝对路径**传给 `tauri signer generate -w`。`pnpm --filter` 会在子包目录执行，相对路径可能意外落入仓库。下面是 Windows PowerShell 示例；Linux 同样选择仓库外的绝对路径。按提示设置密码；私钥可以无密码，此时 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 留空。
2. 把生成的 `.pub` 内容写入 `apps/desktop/src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`。这是公开密钥内容，不能填写文件路径。启用 `bundle.createUpdaterArtifacts: true`，配置 HTTPS endpoint：`https://github.com/hongfaqiu/strata-manager/releases/latest/download/latest.json`。
3. 在仓库 Actions secrets 中设置 `TAURI_SIGNING_PRIVATE_KEY` 为私钥完整内容。密码保护的密钥还需设置 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。可用 `gh secret set TAURI_SIGNING_PRIVATE_KEY` 从标准输入写入，或在 GitHub 设置页粘贴；不要把密钥放进命令参数或日志。
4. 保护并备份私钥。已发布客户端内置对应公钥，丢失私钥后不能为这些客户端生成可信更新。密钥轮换必须另行设计迁移流程。

```powershell
$strataSigningDirectory = Join-Path $env:LOCALAPPDATA 'StrataManager/signing'
New-Item -ItemType Directory -Path $strataSigningDirectory -Force | Out-Null
$strataSigningKeyPath = Join-Path $strataSigningDirectory 'updater.key'
pnpm --filter @strata-manager/desktop tauri signer generate -w $strataSigningKeyPath
```

此命令仅用于首次生成新密钥；不要覆盖已有发行版使用的私钥。

签名环境变量仅在工作流的签名步骤显式注入；`.env` 文件不能替代它们。正式 Release 缺少私钥、公钥、HTTPS endpoint 或更新产物配置时会失败。更新签名与 Windows Authenticode/发行者代码签名是不同能力；本流程不声称拥有 Windows 发布者证书。

官方依据：[Tauri updater](https://v2.tauri.app/plugin/updater/)、[Tauri GitHub Action](https://github.com/tauri-apps/tauri-action)、[Tauri sidecar](https://v2.tauri.app/develop/sidecar/)。

## macOS 签名与公证

macOS 包在 CI 的 `desktop (macos-15, …)` job 中签名和公证，Release 只发布这些字节，并另外加 Tauri 更新签名（`.sig`）。两种签名互不影响：Developer ID 签名改的是 `.app`/DMG 本身，updater 签的是打包好的 `.app.tar.gz`。

需要的 Actions secrets（`gh secret set <名字> -R hongfaqiu/strata-manager`，从标准输入或文件写入，不要把内容放进命令参数）：

| Secret | 内容 |
| --- | --- |
| `APPLE_CERTIFICATE` | Developer ID Application 证书和私钥导出的 `.p12`，base64 |
| `APPLE_CERTIFICATE_PASSWORD` | 该 `.p12` 的密码 |
| `APPLE_API_KEY` | App Store Connect API key 的 Key ID |
| `APPLE_API_ISSUER` | App Store Connect API 的 Issuer ID |
| `APPLE_API_PRIVATE_KEY` | `AuthKey_<KeyID>.p8` 的完整内容；job 里写到 `$RUNNER_TEMP` 下的临时文件，结束时删除 |
| `APPLE_TEAM_ID` | 可选；设置后要求签名身份属于这个团队 |

CI 流程：「Prepare macOS signing and notarization」把证书导入临时钥匙串；tauri 以硬化运行时签名 `.app` 和 `strata-supervisor`（tauri 自己不公证）；「Verify the macOS code signature」检查签名并给 DMG 签 Developer ID；「Submit the macOS app for notarization」用 `ditto` 把 `.app` 打成 zip 提交一次（**只公证 app，DMG 不单独公证**），记下 submission id、app 的 CDHash、提交 zip 和 DMG 的 SHA-256，上传为工件 `ci-darwin-aarch64-notarization`；「Wait for notarization and staple the macOS app」按模式等待，通过后 staple app、`stapler validate`、`spctl --type execute`，再用 `hdiutil` 把 DMG 转成可写、把里面的 app 换成已 staple 的同一个 app（CDHash 必须一致，保留 DMG 布局）、压回 UDZO，并用 Developer ID 重新签名 DMG；「Confirm the macOS app is stapled and the DMG is signed」离线检查 app 带票据、DMG 是 Developer ID 签名且里面是同一个已 staple 的 app（DMG 用 `codesign` 校验，不再 `stapler validate`/`spctl` DMG），只在以上都成功时运行。脚本在 `scripts/macos-notary.sh`，CI 和补发共用：`notarytool` 查询/等待、`stapler staple/validate`、`spctl`、带时间戳的 `codesign` 遇到网络错误（如 `NSURLErrorDomain -1009`、CloudKit `-1005`）重试 3 次、间隔 30 秒，仍是网络错误只给 `::warning::`（这时 app 未 staple，Mac 按「稍后补发」处理，不会发布未 staple 的包）；这些步骤不用 `bash -e`，以免第一次出错就退出。签名身份不对、DMG 里的 app 不是公证的那个、Apple 返回 Invalid/Rejected 时一律失败。没有证书时（fork、外部 PR）回退为临时签名；本仓库的 main、tag 和手动构建缺少证书或公证凭据时直接失败。

应用不需要额外 entitlements：没有加载第三方动态库，WebView 的 JIT 在系统 WebKit 进程中；下载的 Python 和 Metal 引擎作为独立子进程运行，不受父进程硬化运行时的限制。

### Mac 稍后补发（默认开启）

Apple 公证有时要几十分钟。为了不拖住 Windows/Linux，默认是 `auto`：

- **什么时候提交公证**：「Decide whether this run notarizes macOS」先决定本次是否公证，结果写进 job summary。**PR 永远不公证**（包括 `release/*` 和 `full-ci` PR，仍会签名）；推到 main 时只有 `v<版本>` 还没有 tag（也就是改了版本号的发版提交），或者 tag 正好指向这个提交（发版提交重跑）时才公证，版本号没改就只签名（`skipped`）；手动运行（包括 resolver 在 tag 上补派的 CI）照常按 `MACOS_NOTARIZATION`。`skipped` 的 CI 不会被任何发版模式复用：resolver 跳过它，找不到别的同源 CI 就在 tag 上重新派一次 CI，绝不发布未公证的 Mac 包。

- **CI**（`MACOS_NOTARIZATION`，默认 `auto`）：等待公证最多 `MACOS_NOTARIZATION_TIMEOUT`（仓库变量，默认 `30m`）。期间通过就和以前一样 staple，Confirm 门禁通过；超时还在处理中就保留已签名、未 staple 的字节，Confirm 门禁跳过，job 照样成功。Apple 返回 Invalid/Rejected 一律失败。`wait` 最多等 60 分钟、不通过就失败；`defer` 只提交不等待。
- **Release**（`MACOS_RELEASE_MODE`，默认 `auto`）：resolver 先按完整发布校验同源 CI；macOS 已 staple 就五个安装包一起发（`include`）。只有 CI 唯一缺的是 staple 门禁时才转为 `defer`：只发 Windows/Linux 和 Server，`latest.json` 不含 `darwin-aarch64`，Release 说明里加一段「macOS 正在公证」的标记。其它任何问题都照常拒绝。**未 staple 的 Mac 包永远不会发布。**
- **补发**（`.github/workflows/macos-notarize-followup.yml`）：每 30 分钟（以及手动触发）找出带标记、还没有 DMG 的已发布 Release，在 macOS runner 上重新绑定同源 CI 的 macOS 工件和公证记录（字节必须与 CI 工件和记录的 SHA-256 一致），向 Apple 查询状态：仍在处理（或连不上 Apple）就结束等下次；Invalid/Rejected 打印 notary log 并失败；Accepted 时核对 notary log 的 SHA-256（提交的 app zip）和 app 的 CDHash，staple app 并检查，导入 Developer ID 证书，把 CI 的 DMG 换成装有已 staple app 的版本并重新签名，`codesign` 校验，用 Tauri 私钥签名并用源码里的 Rust 验签器验证，上传 DMG、`.app.tar.gz` 和两个 `.sig`，最后把 `darwin-aarch64` 加进 `latest.json`（这是提交点，之前中断可安全重跑；之后再跑只做校验），再完整验证整个 Release 并把说明改成「已补发」。它和发版共用 `release-publish-<repo>` 并发锁。

在补发完成前，Mac 上的旧版本检查更新会报「`darwin-aarch64` not found」并且不会安装任何东西，这是 Tauri updater 对缺失平台的行为；补发后自动恢复。

开关：

| 想要 | 怎么做 |
| --- | --- |
| 关闭稍后补发（公证不完就不发版） | `gh variable set MACOS_RELEASE_MODE --body include` 和 `gh variable set MACOS_NOTARIZATION --body wait` |
| 单次发版指定模式 | 手动运行 `Release desktop`，`macos_mode` 填 `include` / `defer` / `auto` |
| 单次 CI 指定模式 | 手动运行 `Build and test`，`macos_notarization` 填 `wait` / `defer` / `auto` |
| 调整 CI 等待时间 | `gh variable set MACOS_NOTARIZATION_TIMEOUT --body 20m` |
| 暂停定时补发 | `gh variable set MACOS_FOLLOWUP --body off`（手动触发仍可用） |

### macOS signing, notarization and deferred macOS (English)

CI signs the app and `strata-supervisor` with the Developer ID certificate and the hardened runtime. It submits only the app to Apple, once, as a `ditto` zip; the DMG is never notarized itself. It records the submission id, the app CDHash and the SHA-256 of the zip and the DMG as the `ci-darwin-aarch64-notarization` artifact. Once the app is stapled, `hdiutil` rebuilds the DMG around the same stapled app, keeping its layout and checking that the CDHash matches, and the DMG is signed with the Developer ID again. The DMG is verified with `codesign`, not `stapler validate` or `spctl`. The shared helper `scripts/macos-notary.sh` retries `notarytool` status and wait calls, `stapler`, `spctl` and timestamped `codesign` on network errors (such as `NSURLErrorDomain -1009`) 3 times, 30 seconds apart. If Apple is still unreachable, it only emits a `::warning::` and leaves macOS unstapled, which means deferred, never published unstapled. A wrong signing identity or an Invalid/Rejected result from Apple always fails. By default (`MACOS_NOTARIZATION=auto`, `MACOS_RELEASE_MODE=auto`) CI waits up to `MACOS_NOTARIZATION_TIMEOUT` (default `30m`). If Apple accepts in time, the DMG and app are stapled and the release ships all five installers as before. If Apple is still processing, the release resolver switches to `defer`: Windows, Linux and the server packages are published, `latest.json` has no `darwin-aarch64` entry and the release notes carry a marker. Unstapled macOS bytes are never published. `macos-notarize-followup.yml` runs every 30 minutes (or on demand). Once Apple accepts the submission, it checks the notary log against the recorded zip and the app CDHash, staples the CI-built app, rebuilds the CI DMG around it and signs it with the Developer ID, then signs both files for the updater, uploads them, and then adds `darwin-aarch64` to `latest.json`. That last step is the commit point, so an interrupted run can be retried safely. Until then, Mac clients checking for updates get a "platform not found" error and install nothing.

Notarization only runs for builds that can become a release. The "Decide whether this run notarizes macOS" step writes its decision to the job summary. Pull requests never submit to Apple, including `release/*` and `full-ci` PRs, which are still signed. A push to `main` submits only when `v<version>` is not tagged yet (the version-bump commit) or the tag already points at that commit (a re-run). Otherwise the run is signed only (`skipped`). Manual runs, including the resolver's tag dispatch, follow `MACOS_NOTARIZATION`. A `skipped` run is never reused by any release mode: the resolver ignores it and dispatches a fresh CI on the tag, so unnotarized macOS bytes are never published.

To turn this off, set the repository variables `MACOS_RELEASE_MODE=include` and `MACOS_NOTARIZATION=wait`. Per run, use the `macos_mode` input of `Release desktop` or the `macos_notarization` input of `Build and test`. Set `MACOS_FOLLOWUP=off` to pause the scheduled follow-up.

## 日常 CI

`.github/workflows/ci.yml` 在主分支 push、Pull Request 和手动触发时运行 Windows/Linux 矩阵。功能分支通过 PR 自动打包；尚未创建 PR 时，可选择该分支手动运行。PR 使用合并结果进行验收，避免同一功能分支 push 与 PR 重复构建；手动运行使用独立并发组，不取消自动验收。使用 Node 24、`package.json` 固定的 pnpm 和 Rust stable；pnpm 11.21.0 要求 Node >=22.13。

检查范围为版本一致性和发布门禁测试、TypeScript、核心与 HTTP 协议夹具测试、前端生产构建、Rust 格式、workspace 单元/集成测试、Clippy，以及两平台桌面安装包构建。Windows 和 Linux 原生测试各使用五个独立 runner（分片 0–4）；每个 runner 仍以 `--test-threads=1` 串行运行分配到的测试，保留原有测试超时。Windows 的进程、端口和凭据夹具由独立虚拟机隔离；Linux 使用固定私有 Secret Service、DBus 和 Xvfb。

`scripts/ci-linux-native-tests.mjs` 支持两个原生平台，从 Cargo 的全部 workspace 测试可执行文件枚举测试，再按模块的实测耗时（CI 39636091232 中逐个测试的完成时间差汇总）用最长优先法分到各分片；估计超过 60 秒的模块（目前主要是 `tuning::restart::tests`）按测试名交错拆成若干份，避免单个慢模块决定分片下限。耗时只影响调度，不改变任何测试的超时或断言；分片数上限为 6。实际执行的名字和计数必须与计划一致；当前 Linux 七项、Windows 十五项需要实机或外部准备的 ignored 测试逐项登记，新增或减少必须显式审核。0.1.8 仅增加了 Windows 指定真实服务的只读所有者验收项；它要求用户显式提供实际目标，CI 不默认执行，原有十四项和 Linux 七项保持不变。两平台各自的分片 0 额外执行完整 workspace 文档测试。每个平台的五个分片必须全部成功，并汇总绑定相同源码、锁文件、工具链、平台、profile 和当前 run attempt 的覆盖证明；遗漏、重复、跨平台、旧 attempt 或失败均阻断。三个 desktop job 与分片并行执行 Clippy、安装包构建和实际包安装或启动检查；它们和全部分片都成功后，「Native coverage verification」汇总完整原生覆盖证明。Windows 正向测试筛选还限制命令行长度，避免分片参数触及 Windows 进程参数上限。产物只在除「Detect app code changes」外的全部 16 个 job 和包验收成功后允许复用：三个 desktop job、十个原生分片（每平台五个）、Windows/Linux 两个 Strata 0.1.43.1 observer compatibility job，以及覆盖汇总 job。分片数在 `ci.yml` 的两个 matrix 和 `scripts/release-from-ci.mjs` 的 `NATIVE_SHARDS` 中必须一致。

两个 observer job 必须属于同一源码、run 与当前 attempt，并且完整成功。发布门禁逐项要求保留上游源码字节、检出已审核的 API fixture、安装 MockEngine 测试依赖、验证源码 canonical hash 与 observer 兼容性，以及执行全部 HTTP 合同测试且没有跳过。job 或任一关键步骤缺失、重复、失败、取消、跳过或尚未完成均阻断；旧八 job 证据不能替代新增兼容性验收。此检查不下载模型权重，也不代表真实 GPU 推理通过。

Rust dev/test 使用 `debug=0` 和 `incremental=0`，保留 debug assertions、溢出检查及原测试超时；release 的 thin LTO 和 codegen 配置保持原值。缓存仅保留依赖与当前 target；关闭 Cargo 工具二进制、workspace crate 和全 registry crate 缓存。只有本仓库 main 的 push/手动构建保存缓存；PR、tag 和功能分支只恢复。原生测试分片使用独立的 test-profile 缓存键，同一 target 的五个分片共用一个键，并发保存时只有第一个生效。首次切换 profile 会产生新缓存键，应分别记录冷缓存与后续命中时的耗时。

CI 产物以 `ci-<platform>-<arch>-<bundle>` 名称上传为 Actions artifacts。它们关闭 updater artifacts，不是正式签名发行版。拉取请求不接触更新私钥。

普通 CI 对最终安装包执行实际启动检查，Release 复用这些已验收的原始字节：Windows 在临时目录静默安装 NSIS，启动桌面并核对独立后台的版本、IPC、打包二进制 SHA256 和空白私有数据目录，再停止并卸载；Linux 在 Xvfb/DBus 环境分别解包并启动 AppImage 与 DEB，检查同样的后台通信。检查限于一次性 GitHub runner，不在开发电脑上自动安装或接管模型。包启动成功不代表 GPU 推理、登录自启动或跨版本更新安装完成。

校验与发布会切换到 runner 临时目录，因此发布 job 显式设置 `GH_REPO`，让 `gh release download/upload/edit` 始终定位当前仓库。手动发版填写已存在的 `release_tag`，或选择该 tag；控制器可从 main 运行，但应用源码始终独立检出并绑定真实 tag commit。

## 发布一个版本

每次变更维护根目录 [CHANGELOG.md](../CHANGELOG.md) 的 `Unreleased` 中英文条目。发布前将本次内容归入 `## [实际版本]`，保留 `### 中文` 与 `### English` 两个非空段落。流水线通过 `scripts/release-notes.mjs` 读取与版本严格对应的日志，并将其写入 Release 和 updater 元数据；缺少对应版本或语言时拒绝构建发布。桌面更新弹窗按当前界面语言展示该版本日志，用户选择“确认更新”后才下载、验签和安装。

官网的中英文更新日志直接从同一份 `CHANGELOG.md` 生成，入口位于首页导航、下载区与文档中心。修改此文件并推送到 `main` 会触发官网的 Cloudflare 部署；无需维护第二份官网日志。开发与待验收的改动保留在 `Unreleased`，有版本号但尚无公开安装包的候选必须注明 `Unreleased` 或 `Unpublished`，不要仅按源码版本宣称安装包已发布。

1. 等待同仓库的编辑会话完成，冻结同一候选快照。在同一变更中同步根 `package.json`、`apps/desktop/package.json`、`packages/core/package.json`、Tauri config、Cargo workspace 和任何显式 Cargo package version。运行 `node scripts/release-check.mjs --tag v<version>`，将 `<version>` 替换为候选的实际版本；tag 必须与应用版本严格一致。该版本的中英文日志须位于唯一的 `## [<version>]`；README 三个入口、中英文下载/用户文档和官网应同步相应发布入口，不复用上一版本的通过结论。
2. 完成 [VERIFICATION](VERIFICATION.md) 的最终检查和发布验收，更新中英文 README、用户指南、`docs/screenshots/` 的 WebP 封面及页面图与实际 revision；检查内容没有 API 密钥、个人会话、用户名或私有模型路径。截图使用示例数据时，在图片所在文档及官网的图外说明数据来源；图内使用正常模型名和界面内容，不能写成真实服务或性能证据。保留历史原型证据，同时单列本轮未通过/未运行项。
3. 推送已审核的代码，等待完整 CI 后，创建并推送 `v<version>` tag，例如 `v0.2.0-beta.1`。版本 tag 触发 `.github/workflows/release.yml`，它调用同一提交的 `release-from-ci.yml`。也可手动运行 `Release desktop` 并填写 `release_tag`；可选 `ci_run_id` 指定已验收 run。旧 tag 缺少 `strata-release-ci/v2` 协议时明确拒绝，不改写 tag；v2 要求 Windows 分片证明，不接受仅有旧串行 Windows 门禁的 v1 CI。
4. 控制器优先选择同仓库、同源码 SHA、同 CI workflow 的完整成功 run；已有运行则等待它完成，没有可用 run 才按不可变 tag 补跑一次 CI。复用要求三个 desktop job、五个 Windows 分片、五个 Linux 分片、两个 Strata 0.1.43.1 observer compatibility job、覆盖汇总 job，以及原版本/观察器/原生/格式/Clippy/安装启动门禁全部通过，并检查当前 run attempt。版本 0.1.2 仍额外要求原 beta.2 升级门禁。PR 合并 SHA、其他源码、失败、取消、过期或不完整产物均不可复用。
5. 下载桌面 CI artifact 与 Linux `ci-linux-amd64-server`，冻结 ID 和 GitHub ZIP digest，安全解包并核对版本、产品名、架构及原始字节 hash。签名前和上传前重验源码、tag、run 与原始字节；**仅为桌面安装包**生成带应用版本的 Tauri updater 签名。单个发布 job 生成 `latest.json`、每个桌面安装包的 `.sig`，以及无头 Server 的 `Strata.Manager.Server_<ver>_amd64.tar.gz` / `.deb`（不再生成 `SHA256SUMS`），创建或续写草稿，无需再次编译桌面应用或跨平台合并 manifest。`scripts/release-verify.mjs` 下载实际草稿资产，通过同源码的 `strata-update-verifier` 和内置公钥核验桌面载荷、可信注释、版本、完整 **13** 项资产（5 个桌面安装包、5 份 `.sig`、`latest.json`、2 个无头 Server 包）与 URL；全部成功才公开。
6. 发布阶段使用仓库级队列锁，并在锁内完整检查已公开稳定版本。只有 SemVer 严格更高的稳定版本成为 latest；旧版本或等价版本仍可公开下载，但不替换更新通道。带 SemVer prerelease 的版本始终不覆盖稳定自动更新通道。公开状态和 latest 选择在同一次 PATCH 中提交；发布前再次核对真实 tag commit。

发布队列采用 GitHub 的 `queue: max`，最多保留 100 个 pending 发布，避免默认队列只保留一个等待任务而取消其它版本。超出队列上限会被 GitHub 取消；超过版本列表分页上限则拒绝发布。人工发布或没有采用此锁的旧工作流仍可能竞争，不能视作已获得服务器级版本比较 CAS。[GitHub 并发队列文档](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)。

发布流程提供无写入演练：手动运行 `Release verified CI installers`，设置 `validate_only=true`、`release_tag=v<源码中的版本>`、`source_ref=<完整 SHA>`、`expected_source_sha=<同一 SHA>` 和 `ci_run_id=<完整成功 run>`。它检查并下载三种原始产物，上传不含密钥的字节证明，跳过签名和 Release 写入；无需创建新版本 tag。真实发布与演练都保留完整拒绝条件测试。

CI 失败后修改源码并运行新的完整 CI；如仅需重试外部环境故障，选择 **Re-run all jobs**。发布复用要求同一个 attempt 的全部 16 个 job 和产物，不能混用“只重跑失败 job”与上一 attempt 的通过证明。

GitHub 对相对默认分支修改工作流的 `target_commitish` 要求额外的 Workflows 写权限，内置 `GITHUB_TOKEN` 无法授予该权限。对于已经存在且核验了真实 commit 的 tag，工作流将默认分支用作 Release 创建提示，避免该权限要求；该提示不会重写现有 tag，也不用于判断产物来源。当前 tag 的真实提交始终由独立 ref 检查绑定。[GitHub Release 权限规则](https://docs.github.com/en/rest/releases/releases#create-a-release)。

发布侧的密码学验签与客户端更新器都使用 `minisign-verify` 和 Tauri 的编码格式；发布验签不替代真实安装验收。请从 Release 下载安装包，在干净环境验证安装、启动、导入和卸载，随后用上一版本验证下载、签名检查、安装及后台保持。更新失败后不得把客户端“检查成功”当作安装成功。

客户端更新验收必须覆盖维护排空、繁忙/身份不明时拒绝变更、后台包版本切换、失败恢复以及重新连接后的实际模型/API 状态。后台 staged PE 切换测试已通过，但尚不能代替公开 Release 的签名下载安装。跨版本 NSIS 安装器门禁只核验旧版覆盖安装及对应文件/IPC 合同，不能代替 Tauri 从正式端点检查、下载、验签、执行安装和恢复模型/API 的端到端验收，两者在 VERIFICATION 中单列。注销/重登后检查后台自启动，并区分默认轻量启动与提前加载模型；只验证注册项存在或有效不代表真实登录流程通过。

官网通过本仓库 GitHub Release 元数据优先选择最高稳定 SemVer；只有稳定版端点确认无发布时，才明确展示预览版手工安装入口。下载 URL 必须来自该版本实际返回的本仓库资产，缺少或无法核验的资产移除 `href` 并显示说明，不按文件名拼接备用下载地址。发布前运行 `node --test scripts/website-releases.test.mjs scripts/render-website-docs.test.mjs scripts/release-notes.test.mjs` 和 `node scripts/build-website.mjs`；这组网站/文档合同与实际安装包和 Tauri 更新验收分别记录。

历史上 v0.1.0-beta.2 的[签名发布流水线](https://github.com/hongfaqiu/strata-manager/actions/runs/38080808731)已全绿并公开八项资产，源码为 `0db2fea5128144fe2fe00cca992bd5139c831508`；后续 main `ac16c4ce537b7e42e976c04791c3bad907f2c7ea` 的[两平台 CI](https://github.com/hongfaqiu/strata-manager/actions/runs/38088221840)已通过。它们不替代新 0.1.2 候选的门禁结果。

发布说明应分别列出 Windows 与 Linux 实际验证范围。Linux 工作流通过可以证明编译/夹具/打包，但不能证明该平台的实机 Job/进程树、注销登录、GPU 推理或模型容量；目前这些 Linux 验收仍待完成。缺 Python 的自动安装分支、长时间后台统计、完整 Agent/视觉/长上下文调优也应保留各自的验收边界。

0.1.0 的 main CI（`ecb21a492fbe8acd285ec8ef33c58cbf4867607d`）通过，但签名 Release 的 Windows 原生测试在初次执行和一次定向重跑中分别未产生可靠调优推荐，publish 均跳过。`v0.1.0` 标签保持不变，草稿未公开。0.1.1 修复测试前置条件：保留真实 A/B/A 报告，在独立、显式标记的合成计时事务夹具中经原有评估器和公开应用门禁验证恢复逻辑；不放宽生产推荐阈值。首次 0.1.1 CI 随后发现成功完成报告被外层回调重复写入时间的竞态，修复成功终结逻辑并保留 exact 不变断言。

修复后的源码 `33190cf6294ae11787f40b0f5fd6dc29e072cee3` 在 [main CI 38100739579](https://github.com/hongfaqiu/strata-manager/actions/runs/38100739579)两平台通过；创建 `v0.1.1` 后，[签名 Release 38102509861](https://github.com/hongfaqiu/strata-manager/actions/runs/38102509861)的 Windows 构建、安装及 beta.2 升级门禁成功，Linux 三项隔离后台生命周期测试在首次 IPC 就绪检查约 5.2 秒后失败，publish 跳过。`v0.1.1` 标签保持不变，未公开该版本，不移动旧 tag 或以旧成功记录替代新候选验收。

现有失败日志未保留后台子进程退出状态或 stderr，实际启动失败原因未知。Linux 测试直接启动 Cargo 的 debug supervisor；该后台发布 IPC 前读取完整自身二进制计算 SHA256。多个后台并发冷启动的 CPU、内存或 I/O 竞争是待验证假设，不能据此断言 Secret Service 或共享缓存损坏。Release 已命中 main CI 的依赖缓存，且在测试前重新编译 debug supervisor；没有选择旧 release 二进制的证据。

0.1.2 在两份 workflow 中串行运行完整 Linux 原生测试，并补充隔离后台启动诊断。原有测试、就绪期限、Clippy、安装升级、签名和发布门禁保持；共享 Rust 依赖缓存与串行 Release 矩阵继续使用。候选仍须完成同源码两平台 CI 和签名发布；首次稳定版的 Windows 跨版本门禁使用不可变 beta.2 安装包，升级到 0.1.2，不能替代客户端 Tauri updater 端到端验收。

## 验证发布结果

```sh
gh run list --workflow release.yml
gh run view <run-id> --log-failed
gh release view v0.1.3 --json isDraft,isPrerelease,tagName,assets,url
gh release download v0.1.3 --pattern latest.json --dir <temporary-directory>
```

确认 Release 已公开，三种安装包均有非零大小，Windows/Linux 的签名与 `latest.json` 条目匹配，URL 指向属于当前 Release 的资产。官方 action 可使用 GitHub release-asset API URL；验证脚本同样接受该格式并校验资产 ID。检查 Actions artifacts 可以辅助定位构建差异；真正面向用户的安装入口是公开 Release。

发布回退应保留原 tag 和产物证据。不要覆盖已发布的同版本安装包或修改签名；修复使用新版本号。当前稳定更新源不能安全地通过降低版本号回退客户端；需要应用/后台自己的版本回退能力并完成验证。
