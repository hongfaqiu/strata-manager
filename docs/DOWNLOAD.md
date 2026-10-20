# 下载与体验

[文档目录](README.md) · [使用指南](USER_GUIDE.md) · [更新日志](../CHANGELOG.md) · [官网更新日志](https://strata-manager.cosfoc.com/docs/changelog) · [English](DOWNLOAD.en.md)

Strata Manager 是 Strata 运行环境与本地模型服务管理桌面工作台。桌面安装包包含应用和独立后台，Strata 运行环境与模型权重另行准备。

## 公开稳定版下载

通过[最新稳定发布页](https://github.com/hongfaqiu/strata-manager/releases/latest)或[官网下载区](https://strata-manager.cosfoc.com/#get-started)选择对应系统的安装包。公开稳定版的具体版本以发布页和官网下载区为准。仅安装所选发布页实际提供的文件，包含的功能以该版本说明为准；也可以[从源码体验](#从源码体验)。

README、官网截图与使用指南描述当前源码功能；安装包包含的功能以所选版本的更新日志为准。[更新日志](../CHANGELOG.md)区分已发布版本与未发布开发更新。本文描述 CI 门禁覆盖范围，实际发布结果以对应版本的工作流和资产核验为准。

| 平台 | 安装形式 | 说明 |
| --- | --- | --- |
| Windows x64 | [NSIS 安装包（.exe）](https://github.com/hongfaqiu/strata-manager/releases/latest) | 需要 WebView2；安装步骤见下方 |
| Linux x64 | [AppImage / DEB](https://strata-manager.cosfoc.com/#get-started) | Ubuntu 22.04 CI 环境构建；系统安装与 GPU 支持范围见下方 |
| Linux x64 无头 Server（实验） | [`Strata.Manager.Server_<版本>_amd64.tar.gz` / `.deb`](https://strata-manager.cosfoc.com/#get-started) | 无桌面的服务器，浏览器访问；见 [Server 说明](SERVER.md) |
| macOS Apple Silicon | [DMG](https://strata-manager.cosfoc.com/#get-started) | **实验包**。当前已发布稳定版可能尚无该文件；发布页列出 `*_aarch64.dmg` 后再下载。说明见下方 |

发布页的更新签名文件供更新器验签，初次安装使用 `.exe`、`.AppImage`、`.deb`，或发布页实际列出的 `.dmg`。

模型、图像和 API 协议以所选 Strata 运行时为准。检查硬件、驱动、RAM、VRAM 和磁盘要求后再准备模型；已有受支持权重无需重新下载。

## Windows 安装

1. 从[最新稳定发布页](https://github.com/hongfaqiu/strata-manager/releases/latest)或[官网下载区](https://strata-manager.cosfoc.com/#get-started)下载 Windows x64 NSIS 安装包，文件名以 `_x64-setup.exe` 结尾。
2. 核对版本与来源后运行安装器，按向导完成安装。Windows 需要 WebView2；缺少时按安装器或系统提示补齐。
3. 从开始菜单或安装完成后的入口打开 Strata Manager。
4. 按对应版本说明使用；先在 Strata 页面检查或准备运行环境，再按[第一次使用](USER_GUIDE.md#第一次使用)选择已有模型或准备新模型。安装桌面应用不会自动下载权重。
5. 需要卸载时，先从托盘选择“停止服务并退出”，再通过 Windows“已安装的应用”卸载。

本项目目前没有 Windows Authenticode 发布者证书，Windows 可能显示未知发布者或 SmartScreen 提示。先确认文件来自本项目的版本发布页；不能将 Tauri 更新签名理解为 Windows 已信任发布者。

## Linux 安装

### AppImage

1. 从[最新稳定发布页](https://github.com/hongfaqiu/strata-manager/releases/latest)或[官网下载区](https://strata-manager.cosfoc.com/#get-started)下载 Linux x64 的 `.AppImage` 文件。
2. 在文件属性中允许执行，或在下载目录使用 `chmod +x` 并指定实际下载的文件名。
3. 运行 AppImage；遇到 FUSE 或系统依赖提示时，按发行版说明处理。
4. 按对应版本说明使用；完整流程见[使用指南](USER_GUIDE.md#第一次使用)，先检查 Strata 再选择本机模型。

### DEB

从[最新稳定发布页](https://github.com/hongfaqiu/strata-manager/releases/latest)或[官网下载区](https://strata-manager.cosfoc.com/#get-started)下载 Linux x64 的 `.deb` 文件，在 Ubuntu/Debian 的系统软件安装器中打开，按系统提示安装和处理依赖，再从应用菜单启动。Ubuntu 22.04 是 CI 构建环境；DEB 目前验证的是解包后启动，系统中的安装、卸载、登录自启动和真实 GPU 流程仍未验证。


### 无头 Server（实验）

没有桌面环境的 Ubuntu 服务器可使用发布页的 `Strata.Manager.Server_<版本>_amd64.tar.gz` 或 `.deb`。它运行 `strata-manager-server`，默认只监听 `127.0.0.1:8787`，首次运行生成访问令牌，通过浏览器使用同一套界面；附 systemd 服务。Server 包不提供更新签名，也不走桌面自动更新，升级时替换包即可。安装与远程访问见 [Server 说明](SERVER.md)。

## macOS（Apple Silicon，实验）

当前阶段只证明 **CI 能打出未公证的 Apple Silicon DMG**，**不**声称 Manager 已在 Mac 上完成引擎发现或模型推理验收。

- 手工安装文件为 `Strata.Manager_<version>_aarch64.dmg`。官网下载按钮只在该发布**实际包含**这个文件时启用。
- 应用内更新（若启用）使用 `Strata.Manager_<version>_aarch64.app.tar.gz`；`latest.json` 的 `darwin-aarch64` 指向该归档，不指向 DMG。
- CI 在 `macos-15` 上设置 `APPLE_SIGNING_IDENTITY=-` 做**临时（ad-hoc）签名**。没有 Apple 开发者证书，因此**没有公证、没有硬化运行时**。Gatekeeper 可能拦截；确认文件来自本项目发布页后，系统仍可能要求移除隔离或以右键打开。这不是已经在真机验收过的安装步骤。
- **不提供** Intel（`x86_64-apple-darwin`）安装包。上游 Strata Metal 面向 Apple Silicon。
- **DMG 仍不含引擎。** 第二期起，Manager 在 Apple Silicon 上可下载并校验上游 [v0.2.0-beta](https://github.com/Niko1221/Strata/releases/tag/v0.2.0-beta) 预制包 `strata-engine-*-macos-arm64-metal.tar.gz`（应用内 SHA256，不附带 SHA256SUMS），也可选用已有本地 Strata/`engine` 或 `build-metal` 目录。`./setup.sh` 源码构建仍可手动按 [docs/MAC.md](https://github.com/Niko1221/Strata/blob/main/docs/MAC.md) 操作，Manager 暂不自动调用。真机推理验收仍待进行。
- `Info.plist` 最低系统版本为 15.0。CI 只证明 runner 能编译并打包；不证明在 Mac 硬件上能启动、发现引擎或完成推理。
- 窗口使用 macOS 原生的红黄绿按钮（左上角）和原生菜单栏（编辑菜单支持 Cmd+C / Cmd+V；Cmd+Q 退出界面，后台服务保持运行；Cmd+W 关闭窗口；Cmd+M 最小化）。Windows / Linux 仍是自绘标题栏。

## 从源码体验

需要 Node.js 22.13+、项目固定的 pnpm 11 和 Rust stable。Windows 需要 MSVC C++ Build Tools、Windows SDK 与 WebView2；Linux 需要 [Tauri 系统依赖](https://v2.tauri.app/start/prerequisites/)。

~~~sh
git clone https://github.com/hongfaqiu/strata-manager.git
cd strata-manager
pnpm install --frozen-lockfile
pnpm desktop
~~~

pnpm desktop 启动完整桌面应用和后台。pnpm dev 只运行前端，不能代替安装、进程管理和系统集成。

## 支持范围

- 已发布稳定安装包仍以 Windows/Linux x64 为主。macOS（Apple Silicon）DMG 为**实验包**（未公证），随含该资产的版本标签发布；不提供 Intel 包。**不要**假定 DMG 已含可用 Metal 引擎。模型、硬件、图像和 API 能力以 Strata 运行时与具体模型为准。
- 当前源码实现全局 Strata 管理与匹配的 Windows x64 ZIP 引擎更新、已有模型自动展示、图形化/JSON 运行配置、服务控制、聊天、持久化元数据统计和完整用途场景调优。已发布包以对应版本说明为准；截图使用示例数据，不代表实机模型性能。
- 稳定版通过 `latest` 更新通道提供更新；预览版仅手工下载和安装，不替换稳定通道。
- Windows CI 门禁包含静默安装、桌面启动、私有后台 IPC、正常关闭和卸载；已通过的历史 revision 见 [VERIFICATION](VERIFICATION.md)。
- Linux CI 门禁包含 Ubuntu 22.04 Xvfb 下 AppImage 与解包 DEB 启动、私有后台 IPC 和正常关闭；不承诺所有 Linux 发行版均兼容。
- 真实 GPU 完整流程、Strata ZIP 实机更新、Linux 系统 DEB 安装/卸载、登录自启动、缺少 Python 的 Windows 自动安装、Tauri 自动更新的真实跨版本下载、验签、安装和服务恢复仍需独立验收。跨版本 NSIS 安装器检查不等同自动更新端到端验收。ZIP 引擎更新仅使用匹配的官方 Windows x64 发布包；Linux 保留发布信息查看，但不提供不可执行的 Windows ZIP 更新。
- Windows 安装包目前没有 Authenticode 发布者证书。Tauri 更新包签名用于验证更新文件，不能替代 Windows 发布者签名。macOS 实验包同样只有临时签名与（若发布）Tauri 更新签名，**没有 Apple 公证**。

## 版本与更新

[GitHub Releases](https://github.com/hongfaqiu/strata-manager/releases)列出各版本的安装包和发布说明。预览版、稳定版、CI 测试包和自行构建的安装包是不同来源，请先核对版本及支持范围。

公开且通过发布门禁的稳定版本才进入 `latest` 通道，下载入口始终指向[最新稳定发布页](https://github.com/hongfaqiu/strata-manager/releases/latest)。发布记录和功能变化见[更新日志](../CHANGELOG.md)或[官网更新日志](https://strata-manager.cosfoc.com/docs/changelog)。预览版不覆盖稳定通道，未检测到 beta 也不代表当前预览版已经最新。

当前源码分别管理应用更新、Strata 运行环境和模型权重。默认自动检查，展示日志并确认后安装；Windows x64 的 Strata 页面从上游发布信息选择匹配 ZIP，下载、解包、备份并替换程序文件，保留已有模型。详细行为见[使用指南](USER_GUIDE.md)。
