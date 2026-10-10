# 构建与发布 / Build and release

公开仓库：[hongfaqiu/strata-manager](https://github.com/hongfaqiu/strata-manager)。正式更新源为该仓库 Release 中的 `latest.json`；签名私钥不得进入 Git、前端资源、构建工件或截图。

## 当前发布准备状态

2026-10-10：公开仓库已创建，正式 HTTPS 更新地址、公钥与 `createUpdaterArtifacts` 已配置，Actions 的 `TAURI_SIGNING_PRIVATE_KEY` secret 已设置。当前密钥没有密码，因此密码 secret 可缺省为空。发布门禁测试 5 项通过，两个工作流 actionlint 检查通过，Windows debug sidecar 已实际构建并核对打包副本 hash。

2026-10-11：发布门禁新增真实更新包密码学验签，Node 12 项、Rust 7 项、release CLI 集成 3 项通过；最终五 crate workspace Clippy、fmt、版本检查通过。普通 CI 和 Release 构建阶段会构建验签 helper 并运行完整 Node 门禁；publish 阶段再次使用 release helper 检查实际草稿资产，全部成功后才公开。夹具公钥及签名不含用户私钥。

随后第三轮 CI 已实际生成 Linux AppImage/DEB；Windows 的一个监听探测夹具仍未通过，修复后的完整 CI 待复验。这些证据不能当作 Windows/Linux tag 构建、公开签名产物或客户端更新安装完成。完整发布结果与当前产品验收缺项见 [VERIFICATION](VERIFICATION.md)。Windows Authenticode 发布者签名尚未配置，Tauri updater 签名不提供该能力。

## 发布内容

| 平台 | Rust target | 发布文件 |
| --- | --- | --- |
| Windows x64 | `x86_64-pc-windows-msvc` | NSIS `*-setup.exe` 及 `.sig` |
| Linux x64 | `x86_64-unknown-linux-gnu` | `.AppImage`、`.AppImage.sig` 和 `.deb` |

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

签名环境变量由工作流在 Tauri 构建步骤显式注入；`.env` 文件不能替代它们。正式 Release 缺少私钥、公钥、HTTPS endpoint 或更新产物配置时会失败。更新签名与 Windows Authenticode/发行者代码签名是不同能力；本流程不声称拥有 Windows 发布者证书。

官方依据：[Tauri updater](https://v2.tauri.app/plugin/updater/)、[Tauri GitHub Action](https://github.com/tauri-apps/tauri-action)、[Tauri sidecar](https://v2.tauri.app/develop/sidecar/)。

## 日常 CI

`.github/workflows/ci.yml` 在主分支、`codex/**` 分支、Pull Request 和手动触发时运行 Windows/Linux 矩阵。使用 Node 24、`package.json` 固定的 pnpm 和 Rust stable；pnpm 11.21.0 要求 Node >=22.13。

检查范围为版本一致性和发布门禁测试、TypeScript、核心与 HTTP 协议夹具测试、前端生产构建、Rust 格式、workspace 单元/集成测试、Clippy，以及两平台桌面安装包构建。Linux 安装 GTK/WebKitGTK、托盘、AppImage 依赖，在 Xvfb 下运行 native 测试。

CI 产物以 `ci-<platform>-<arch>-<bundle>` 名称上传为 Actions artifacts。它们关闭 updater artifacts，不是正式签名发行版。拉取请求不接触更新私钥。

## 发布一个版本

1. 在同一变更中同步根 `package.json`、`apps/desktop/package.json`、`packages/core/package.json`、Tauri config、Cargo workspace 和任何显式 Cargo package version。`node scripts/release-check.mjs --tag v0.1.0` 检查版本；tag 必须与应用版本严格一致。
2. 完成 [VERIFICATION](VERIFICATION.md) 的最终检查和发布验收，更新中英文 README、WebP 截图与实际 revision。截图放在 `docs/screenshots/overview.zh.webp`、`chat.zh.webp`、`monitor.zh.webp`；检查内容没有 API 密钥、个人会话、用户名或私有模型路径。演示数据在图内及文档中明确标注，不能写成真实服务或性能证据。保留历史原型证据，同时单列本轮未通过/未运行项。
3. 推送已审核的代码，再创建并推送 `v<version>` tag，例如 `v0.1.0` 或 `v0.2.0-beta.1`。版本 tag 触发 `.github/workflows/release.yml`；手动重跑必须选中同一个 tag，选择分支不会发布。
4. 流水线先校验 tag、版本和签名配置，再通过 Windows/Linux 全部检查。官方 Tauri action 构建签名安装包、上传签名和 workflow artifacts，并合并生成 `latest.json` 到**草稿 Release**。正式矩阵顺序执行，避免两个 action 同时读写 updater manifest 时丢失平台条目。
5. 两个平台均成功后，`scripts/release-verify.mjs` 核对完整的 NSIS/AppImage/DEB、支持的平台及官方别名、每个 updater URL、签名文件与 `latest.json` 的一致性、tag 和构建 SHA。下载实际更新包，再通过 `strata-update-verifier` 使用应用内置公钥验证载荷、可信注释和签名中的版本；错误公钥、篡改或缺失签名均拒绝发布。通过后才自动公开；任何失败都保留草稿。
6. 稳定版本成为 latest；带 SemVer prerelease 的版本标记为 prerelease，且不覆盖稳定自动更新通道。

发布侧的密码学验签与客户端更新器都使用 `minisign-verify` 和 Tauri 的编码格式；发布验签不替代真实安装验收。请从 Release 下载安装包，在干净环境验证安装、启动、导入和卸载，随后用上一版本验证下载、签名检查、安装及后台保持。更新失败后不得把客户端“检查成功”当作安装成功。

客户端更新验收必须覆盖维护排空、繁忙/身份不明时拒绝变更、后台包版本切换、失败恢复以及重新连接后的实际模型/API 状态。后台 staged PE 切换测试已通过，但尚不能代替公开 Release 的签名下载安装。注销/重登后检查后台自启动，并区分默认轻量启动与提前加载模型；只验证注册表写入不代表登录流程通过。

发布说明应分别列出 Windows 与 Linux 实际验证范围。Linux 工作流通过可以证明编译/夹具/打包，但不能证明该平台的实机 Job/进程树、注销登录、GPU 推理或模型容量；目前这些 Linux 验收仍待完成。缺 Python 的自动安装分支、长时间后台统计、完整 Agent/视觉/长上下文调优也应保留各自的验收边界。

## 验证发布结果

```sh
gh run list --workflow release.yml
gh run view <run-id> --log-failed
gh release view v0.1.0 --json isDraft,isPrerelease,tagName,assets,url
gh release download v0.1.0 --pattern latest.json --dir <temporary-directory>
```

确认 Release 已公开，三种安装包均有非零大小，Windows/Linux 的签名与 `latest.json` 条目匹配，URL 指向属于当前 Release 的资产。官方 action 可使用 GitHub release-asset API URL；验证脚本同样接受该格式并校验资产 ID。检查 Actions artifacts 可以辅助定位构建差异；真正面向用户的安装入口是公开 Release。

发布回退应保留原 tag 和产物证据。不要覆盖已发布的同版本安装包或修改签名；修复使用新版本号。当前稳定更新源不能安全地通过降低版本号回退客户端；需要应用/后台自己的版本回退能力并完成验证。
