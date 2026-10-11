# 下载与体验

[文档目录](README.md) · [使用指南](USER_GUIDE.md) · [English](DOWNLOAD.en.md)

Strata Manager 是 Strata 运行环境与本地模型服务管理桌面工作台。桌面安装包包含应用和独立后台，Strata 运行环境与模型权重另行准备。

## 预览版 v0.1.0-beta.1

**v0.1.0-beta.1** 预览版已发布。选择下方对应系统的安装包手工安装，版本说明见 [GitHub 发布页](https://github.com/hongfaqiu/strata-manager/releases/tag/v0.1.0-beta.1)；也可以[从源码体验](#从源码体验)。

README、官网截图与使用指南描述当前源码；新版模型列表、独立 Strata 管理与 ZIP 更新等源码改动不因此包含在现有 beta 安装包中。体验当前源码功能请按下方源码步骤运行。

| 平台 | 安装形式 | 说明 |
| --- | --- | --- |
| Windows x64 | [NSIS 安装包](https://github.com/hongfaqiu/strata-manager/releases/download/v0.1.0-beta.1/Strata.Manager_0.1.0-beta.1_x64-setup.exe) | 需要 WebView2；安装步骤见下方 |
| Linux x64 | [AppImage](https://github.com/hongfaqiu/strata-manager/releases/download/v0.1.0-beta.1/Strata.Manager_0.1.0-beta.1_amd64.AppImage) / [DEB](https://github.com/hongfaqiu/strata-manager/releases/download/v0.1.0-beta.1/Strata.Manager_0.1.0-beta.1_amd64.deb) | Ubuntu 22.04 CI 环境构建；系统安装与 GPU 支持范围见下方 |

[下载 SHA256SUMS](https://github.com/hongfaqiu/strata-manager/releases/download/v0.1.0-beta.1/SHA256SUMS)，将下载文件的 SHA256 与其中同名文件的值核对后再安装。发布页的更新签名文件供更新器验签，初次安装使用表中的 `.exe`、`.AppImage` 或 `.deb`。

模型、图像和 API 协议以所选 Strata 运行时为准。检查硬件、驱动、RAM、VRAM 和磁盘要求后再准备模型；已有受支持权重无需重新下载。

## Windows 安装

1. 下载上方的 Windows x64 NSIS 安装包 `Strata.Manager_0.1.0-beta.1_x64-setup.exe`。
2. 核对版本与来源后运行安装器，按向导完成安装。Windows 需要 WebView2；缺少时按安装器或系统提示补齐。
3. 从开始菜单或安装完成后的入口打开 Strata Manager。
4. 预览包按其版本说明使用；当前源码先在 Strata 页面检查或准备运行环境，再按[第一次使用](USER_GUIDE.md#第一次使用)选择已有模型或准备新模型。安装桌面应用不会自动下载权重。
5. 需要卸载时，先从托盘选择“停止服务并退出”，再通过 Windows“已安装的应用”卸载。

本项目目前没有 Windows Authenticode 发布者证书，Windows 可能显示未知发布者或 SmartScreen 提示。先确认文件来自本项目的版本发布页；不能将 Tauri 更新签名理解为 Windows 已信任发布者。

## Linux 安装

### AppImage

1. 下载上方的 `Strata.Manager_0.1.0-beta.1_amd64.AppImage`。
2. 在文件属性中允许执行，或在下载目录运行 `chmod +x ./Strata.Manager_0.1.0-beta.1_amd64.AppImage`。
3. 运行 AppImage；遇到 FUSE 或系统依赖提示时，按发行版说明处理。
4. 按预览包版本说明使用；当前源码流程见[使用指南](USER_GUIDE.md#第一次使用)，先检查 Strata 再选择本机模型。

### DEB

下载上方的 `Strata.Manager_0.1.0-beta.1_amd64.deb`，在 Ubuntu/Debian 的系统软件安装器中打开，按系统提示安装和处理依赖，再从应用菜单启动。Ubuntu 22.04 是 CI 构建环境；DEB 目前验证的是解包后启动，系统中的安装、卸载、登录自启动和真实 GPU 流程仍未验证。

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

- 当前面向 Windows/Linux x64；模型、硬件、图像和 API 能力以 Strata 运行时与具体模型为准。
- 当前源码实现全局 Strata 管理与 ZIP 更新、已有模型自动展示、图形化/JSON 运行配置、服务控制、聊天、持久化元数据统计和完整用途场景调优。已发布包以对应版本说明为准；截图使用示例数据，不代表实机模型性能。
- 预览版通过手工下载和安装体验，不替换稳定版的 `latest` 自动更新通道。
- Windows 包已验证静默安装、桌面启动、私有后台 IPC、正常关闭和卸载。
- Linux 包已验证 Ubuntu 22.04 的 Xvfb 环境中 AppImage 与解包 DEB 启动、私有后台 IPC 和正常关闭。
- 真实 GPU 完整流程、Strata ZIP 实机更新、Linux 系统 DEB 安装/卸载、登录自启动、缺少 Python 的 Windows 自动安装、跨版本安装更新仍未验证。ZIP 引擎更新需要匹配的官方 Windows x64 发布包。
- Windows 安装包目前没有 Authenticode 发布者证书。Tauri 更新包签名用于验证更新文件，不能替代 Windows 发布者签名。

## 版本与更新

[GitHub Releases](https://github.com/hongfaqiu/strata-manager/releases)列出各版本的安装包和发布说明。预览版、稳定版、CI 测试包和自行构建的安装包是不同来源，请先核对版本及支持范围。

v0.1.0-beta.1 是预览版，使用上述发布页手工下载安装，不通过稳定版 `latest` 通道推送。设置中的更新检查面向稳定更新来源；不要把未检测到 beta 当作已安装最新版的证明。

当前源码分别管理应用更新、Strata 运行环境和模型权重。默认自动检查，展示日志并确认后安装；Strata 页面从上游发布信息选择匹配 ZIP，下载、解包、备份并替换程序文件，保留已有模型。详细行为见[使用指南](USER_GUIDE.md)。
