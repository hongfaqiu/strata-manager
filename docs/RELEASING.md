# 构建与发布 / Build and release

公开仓库：[hongfaqiu/strata-manager](https://github.com/hongfaqiu/strata-manager)。正式更新源为该仓库 Release 中的 `latest.json`；签名私钥不得进入 Git、前端资源、构建工件或截图。

## 当前发布准备状态

0.1.3 候选已同步版本、双语日志、下载入口和使用文档，并整合远程 0.1.2 修复。本地前端类型检查、190 项测试及构建通过；发布/网站脚本 105 项与隔离浏览器交互 35 项全部通过。以下早期版本记录保留为历史证据。正式安装包仍由同一 tag 的 Windows/Linux 签名构建、安装启动检查及实际资产验签门禁决定；不把历史通过结果当作当前发布完成。

2026-10-11：已公开 [v0.1.0-beta.1 预览版](https://github.com/hongfaqiu/strata-manager/releases/tag/v0.1.0-beta.1)，包含 Windows x64 NSIS、Linux x64 AppImage/DEB、三份更新签名、`latest.json` 和 `SHA256SUMS`。发布源码为 `ab3bacc68fd8c9a95cc92de05ae2439976c91e5f`。Windows 原始 tag 构建在创建草稿时因 GitHub 工作流写权限规则收到 403；保留原始已签名产物，经[恢复检查](https://github.com/hongfaqiu/strata-manager/actions/runs/38078576661)核对构建身份、artifact 摘要并实际完成安装、启动、IPC 和卸载。Linux 原始签名构建通过 AppImage/解包 DEB 启动检查。发布前独立下载全部实际更新包，使用内置公钥验证签名及签名中的版本，并比对三个安装包的 SHA256；本次预览通过验证后恢复发布，原失败记录仍保留。

[Windows/Linux 完整 CI](https://github.com/hongfaqiu/strata-manager/actions/runs/38077681492) 已通过，三种安装包均上传并通过启动检查。后续发布流程已加入实际 tag commit 绑定、默认分支创建提示、明确的手动 tag 门禁及临时目录下的 `GH_REPO` 绑定；新增发布门禁本地 36 项全部通过。GPU 实机、登录自启动和跨版本更新安装仍单独验收，不能由安装包启动或发布验签结果外推。

2026-10-10：公开仓库已创建，正式 HTTPS 更新地址、公钥与 `createUpdaterArtifacts` 已配置，Actions 的 `TAURI_SIGNING_PRIVATE_KEY` secret 已设置。当前密钥没有密码，因此密码 secret 可缺省为空。发布门禁测试 5 项通过，两个工作流 actionlint 检查通过，Windows debug sidecar 已实际构建并核对打包副本 hash。

2026-10-11：发布门禁新增真实更新包密码学验签和有界分页草稿查询，最新 Node 17 项、Rust 7 项通过，此前 release CLI 的 3 个密码学场景通过；最终五 crate workspace Clippy、fmt、版本检查通过。普通 CI 和 Release 构建阶段会构建验签 helper 并运行完整 Node 门禁；publish 阶段再次使用 release helper 检查实际草稿资产，全部成功后才公开。夹具公钥及签名不含用户私钥。

第三、四轮 CI 已实际生成 Linux AppImage/DEB。第四轮 Windows 在 desktop 后台包身份断言失败，未运行到此前的监听 fixture；后台锁同步修复已通过本地回归，完整 CI 待复验。这些证据不能当作 Windows/Linux tag 构建、公开签名产物或客户端更新安装完成。完整发布结果与当前产品验收缺项见 [VERIFICATION](VERIFICATION.md)。Windows Authenticode 发布者签名尚未配置，Tauri updater 签名不提供该能力。

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

`.github/workflows/ci.yml` 在主分支 push、Pull Request 和手动触发时运行 Windows/Linux 矩阵。功能分支通过 PR 自动打包；尚未创建 PR 时，可选择该分支手动运行。PR 使用合并结果进行验收，避免同一功能分支 push 与 PR 重复构建；手动运行使用独立并发组，不取消自动验收。使用 Node 24、`package.json` 固定的 pnpm 和 Rust stable；pnpm 11.21.0 要求 Node >=22.13。

检查范围为版本一致性和发布门禁测试、TypeScript、核心与 HTTP 协议夹具测试、前端生产构建、Rust 格式、workspace 单元/集成测试、Clippy，以及两平台桌面安装包构建。Linux 安装 GTK/WebKitGTK、托盘、AppImage 依赖，在 Xvfb 下运行 native 测试。

CI 产物以 `ci-<platform>-<arch>-<bundle>` 名称上传为 Actions artifacts。它们关闭 updater artifacts，不是正式签名发行版。拉取请求不接触更新私钥。

普通 CI 与签名 Release 使用同一套实际安装包启动检查：Windows 在临时目录静默安装 NSIS，启动桌面并核对独立后台的版本、IPC、打包二进制 SHA256 和空白私有数据目录，再停止并卸载；Linux 在 Xvfb/DBus 环境分别解包并启动 AppImage 与 DEB，检查同样的后台通信。检查限于一次性 GitHub runner，不在开发电脑上自动安装或接管模型。包启动成功不代表 GPU 推理、登录自启动或跨版本更新安装完成。

校验和发布会切换到 runner 临时目录，因此 publish job 显式设置 `GH_REPO`，让 `gh release download/upload/edit` 始终定位当前仓库。手动发版必须选择已存在的 `v<version>` tag；从分支运行会给出明确错误，避免显示全部跳过却没有发布产物。

## 发布一个版本

每次变更维护根目录 [CHANGELOG.md](../CHANGELOG.md) 的 `Unreleased` 中英文条目。发布前将本次内容归入 `## [实际版本]`，保留 `### 中文` 与 `### English` 两个非空段落。流水线通过 `scripts/release-notes.mjs` 读取与版本严格对应的日志，并将其写入 Release 和 updater 元数据；缺少对应版本或语言时拒绝构建发布。桌面更新弹窗按当前界面语言展示该版本日志，用户选择“确认更新”后才下载、验签和安装。

1. 等待同仓库的编辑会话完成，冻结同一候选快照。在同一变更中同步根 `package.json`、`apps/desktop/package.json`、`packages/core/package.json`、Tauri config、Cargo workspace 和任何显式 Cargo package version。`node scripts/release-check.mjs --tag v0.1.3` 检查版本；tag 必须与应用版本严格一致。0.1.3 的中英文日志须位于唯一的 `## [0.1.3]`；README 三个入口、中英文下载/用户文档和官网应同步正式版入口，不复用 beta 的通过结论。
2. 完成 [VERIFICATION](VERIFICATION.md) 的最终检查和发布验收，更新中英文 README、用户指南、`docs/screenshots/` 的 WebP 封面及页面图与实际 revision；检查内容没有 API 密钥、个人会话、用户名或私有模型路径。截图使用示例数据时，在图片所在文档及官网的图外说明数据来源；图内使用正常模型名和界面内容，不能写成真实服务或性能证据。保留历史原型证据，同时单列本轮未通过/未运行项。
3. 推送已审核的代码，再创建并推送 `v<version>` tag，例如 `v0.1.3` 或 `v0.2.0-beta.1`。版本 tag 触发 `.github/workflows/release.yml`；手动重跑必须选中同一个 tag，选择分支不会发布。
4. 流水线先校验 tag、版本和签名配置，再通过 Windows/Linux 全部检查。`release-tag.mjs` 从 GitHub 精确 tag ref 解析真实 commit，包括有界解析 annotated tag，并与 workflow SHA 比较；上传前和公开前再次检查。官方 Tauri action 构建签名安装包、上传签名和 workflow artifacts，并合并生成 `latest.json` 到**草稿 Release**。正式矩阵顺序执行，避免两个 action 同时读写 updater manifest 时丢失平台条目。
5. 两个平台均成功后，`scripts/release-verify.mjs` 核对完整的 NSIS/AppImage/DEB、支持的平台及官方别名、每个 updater URL、签名文件与 `latest.json` 的一致性、实际 tag commit 和构建 SHA。下载实际更新包，再通过 `strata-update-verifier` 使用应用内置公钥验证载荷、可信注释和签名中的版本；错误公钥、篡改或缺失签名均拒绝发布。通过后才自动公开；任何失败都保留草稿。
6. 发布阶段使用仓库级队列锁，并在锁内完整检查已公开稳定版本。只有 SemVer 严格更高的稳定版本成为 latest；旧版本或等价版本仍可公开下载，但不替换更新通道。带 SemVer prerelease 的版本始终不覆盖稳定自动更新通道。公开状态和 latest 选择在同一次 PATCH 中提交；发布前再次核对真实 tag commit。

发布队列采用 GitHub 的 `queue: max`，最多保留 100 个 pending 发布，避免默认队列只保留一个等待任务而取消其它版本。超出队列上限会被 GitHub 取消；超过版本列表分页上限则拒绝发布。人工发布或没有采用此锁的旧工作流仍可能竞争，不能视作已获得服务器级版本比较 CAS。[GitHub 并发队列文档](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)。

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
