<div align="center">

<a href="https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/product-cover.webp"><img src="docs/screenshots/product-cover.webp" alt="Strata Manager：本地模型，一站管理" width="100%"></a>

<h1>Strata Manager</h1>

<p><strong>本地模型，一站管理。</strong><br>
集中管理本地模型、聊天、后台服务与本机 API。</p>

<p>
<a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/License-MIT-118577"></a>
<img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8DB">
<img alt="Windows and Linux x64" src="https://img.shields.io/badge/Windows%20%7C%20Linux-x64-51606F">
<img alt="中文 and English" src="https://img.shields.io/badge/Language-中文%20%7C%20English-118577">
<a href="https://github.com/hongfaqiu/strata-manager/actions/workflows/ci.yml"><img alt="Build and test" src="https://github.com/hongfaqiu/strata-manager/actions/workflows/ci.yml/badge.svg"></a>
</p>

<p>
<a href="https://hongfaqiu.github.io/strata-manager/?lang=zh">官网</a> ·
<a href="README.md">English</a> ·
<a href="#下载与体验">下载与体验</a> ·
<a href="#三步开始使用">快速上手</a> ·
<a href="#看看它的样子">界面展示</a> ·
<a href="https://hongfaqiu.github.io/strata-manager/docs/user-guide.html">使用指南</a> ·
<a href="https://hongfaqiu.github.io/strata-manager/docs/index.html">文档目录</a>
</p>

</div>

Strata Manager 是开源的本地模型管理桌面应用，将模型导入与准备、配置管理、服务启动与加载、聊天、监控和本机 API 集中在一个工作台中。已有模型权重保持原位，已启动的服务由独立后台管理。项目基于 [Strata](https://github.com/Niko1221/Strata) 运行时；可用模型、图像输入与 API 协议以所安装的运行时和具体模型为准。

## 什么是 Strata？

[Strata](https://github.com/Niko1221/Strata) 是开源的本地推理项目，协调 GPU 显存、RAM 和 CPU 资源运行它支持的模型，并提供浏览器界面与本机 API。

Strata Manager 是基于 Strata 的独立社区桌面管理应用，负责导入与准备模型、配置管理、后台服务和桌面工作台；具体推理能力由 Strata 运行时和模型提供。

> **预览版 v0.1.0-beta.1 已发布。** 可从下方直接下载，版本说明见[发布页](https://github.com/hongfaqiu/strata-manager/releases/tag/v0.1.0-beta.1)，安装步骤见[下载说明](https://hongfaqiu.github.io/strata-manager/docs/download.html)。

## 为什么使用 Strata Manager

| | |
| --- | --- |
| **已有模型，继续使用**<br>自动检测本机安装，恢复旧版有效档案与会话；原有模型不用重新下载。 | **聊天和工具，在同一处**<br>多会话、流式回答、文本附件；思考过程、图片输入与 MCP 工具事件取决于模型和运行时支持。 |
| **关闭窗口，API 继续运行**<br>独立后台管理已启动的服务；重新打开界面即可连接回来。 | **知道模型是怎么被使用的**<br>查看请求量、tokens、成功率、等待时间、缓存和最近请求。 |
| **调优，先比较再决定**<br>比较支持的 PCIe 预算与 MTP 推测参数，检查基线漂移和输出一致性，再选择应用；收益取决于实际模型与硬件。 | **熟悉的 Strata 风格**<br>保留官方组件风格，中文/英文、浅色/深色主题、可折叠侧栏和自适应布局。 |

## 三步开始使用

1. **找到你的模型。** 打开“模型”。旧版 Manager 的有效档案会自动恢复；检测到已有 Strata 时选择导入。如果还没有安装，再使用准备向导。
2. **点击“使用”。** 等待“模型可用”，后台会检查运行环境、启动 Strata 并加载模型。新模型准备成功后自动加入列表，不会替换当前选择。
3. **开始聊天，或连接本机 API。** 在聊天页发送消息；需要接入其它软件时，使用总览或模型页显示的本机地址。API 协议能力取决于当前 Strata 运行时。

已有模型保持原位，应用使用受管配置副本。首次下载新模型可能需要较长时间，进度与失败原因会显示在任务中。遇到问题可查看[第一次使用指南](docs/USER_GUIDE.md#第一次使用)。

## 下载与体验

选择对应系统的 **v0.1.0-beta.1** 安装包手工安装；完整步骤见[下载与体验说明](https://hongfaqiu.github.io/strata-manager/docs/download.html)。

| 平台 | 安装形式 | 当前体验方式 |
| --- | --- | --- |
| Windows x64 | [NSIS 安装包](https://github.com/hongfaqiu/strata-manager/releases/download/v0.1.0-beta.1/Strata.Manager_0.1.0-beta.1_x64-setup.exe) | 需要 WebView2；[安装说明](https://hongfaqiu.github.io/strata-manager/docs/download.html#windows-安装)。 |
| Linux x64 | [AppImage](https://github.com/hongfaqiu/strata-manager/releases/download/v0.1.0-beta.1/Strata.Manager_0.1.0-beta.1_amd64.AppImage) / [DEB](https://github.com/hongfaqiu/strata-manager/releases/download/v0.1.0-beta.1/Strata.Manager_0.1.0-beta.1_amd64.deb) | Ubuntu 22.04 CI 环境构建；[安装与支持范围](https://hongfaqiu.github.io/strata-manager/docs/download.html#linux-安装)。 |

[SHA256 校验文件](https://github.com/hongfaqiu/strata-manager/releases/download/v0.1.0-beta.1/SHA256SUMS) · [版本说明](https://github.com/hongfaqiu/strata-manager/releases/tag/v0.1.0-beta.1)

Windows 已验证静默安装、桌面启动、私有后台 IPC、关闭及卸载。Linux 已验证 Ubuntu 22.04 的 Xvfb 环境中 AppImage 与解包 DEB 启动、私有 IPC 和关闭；系统 DEB 安装、真实 GPU、登录自启动和跨版本更新仍未验证。

安装包包含桌面应用和后台，模型权重与 Strata 运行时独立准备或导入。预览版不替换稳定版 `latest` 更新通道；Tauri 更新签名与 Windows 发布者签名不同。硬件、显存、内存与驱动要求请按所选模型查看 [Strata 说明](https://github.com/Niko1221/Strata)。

<details>
<summary><strong>从源码体验</strong></summary>

需要 Node.js 22.13+、项目固定的 pnpm 11 和 Rust stable。Windows 还需要 MSVC、Windows SDK 与 WebView2；Linux 前置依赖见 [Tauri 文档](https://v2.tauri.app/start/prerequisites/)。

```sh
git clone https://github.com/hongfaqiu/strata-manager.git
cd strata-manager
pnpm install --frozen-lockfile
pnpm desktop
```

维护者的开发、测试和打包资料保留在 GitHub 的[开发说明源码](https://github.com/hongfaqiu/strata-manager/blob/main/docs/DEVELOPMENT.md)。

</details>

## 看看它的样子

截图来自应用界面，模型状态、聊天、用量和调优数值使用示例数据；在此图外说明数据来源，不代表真实运行结果或性能承诺。截图采用 2 倍像素密度与无损 WebP，点击图片可查看高清原图。

### 一个总览，知道下一步做什么

查看当前模型、服务状态、资源和使用情况，从这里进入聊天或管理模型。

[![总览：模型状态、后台服务与用量入口](docs/screenshots/overview.zh.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/overview.zh.webp)

### 聊天，保留熟悉的官方体验

会话历史直接放在聊天页，回答、思考与附件集中展示。

[![聊天：多会话历史、流式内容与附件](docs/screenshots/chat.zh.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/chat.zh.webp)

### 我的模型，从准备到使用

检测已有安装，准备新模型，查看任务进度；选中模型后由后台完成启动与加载。

[![模型：本机模型、准备与任务](docs/screenshots/models.zh.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/models.zh.webp)

### API 用量，看见日常使用

请求趋势、成功率、tokens、首个输出等待时间与缓存复用，让使用情况有据可查。

[![API 用量：请求趋势与使用数据](docs/screenshots/usage.zh.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/usage.zh.webp)

### 参数调优，让选择有依据

比较受支持的 PCIe 预算与 MTP 推测参数，检查基线漂移和输出一致性，再决定是否应用。没有稳定收益时保留当前设置。

[![调优：场景选择、测量和结果](docs/screenshots/tuning.zh.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/tuning.zh.webp)

<details>
<summary><strong>更多界面：性能监控与设置</strong></summary>

<br>

[![性能监控：硬件、吞吐和请求状态](docs/screenshots/monitor.zh.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/monitor.zh.webp)

[![设置：语言、主题、后台策略、自启动和更新](docs/screenshots/settings.zh.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/settings.zh.webp)

</details>

## 常见问题

**我已经有模型，为什么还要下载？** 可导入的已有 Strata 模型不需要再次下载权重。先查看“我的模型”或导入其安装；仅在准备新模型时下载权重。

**关掉窗口，API 会停止吗？** 已启动的服务由独立后台继续运行。需要释放模型并结束受管服务时，使用托盘中的“停止服务并退出”。

**聊天和统计会上传吗？** 聊天记录保存在本机，使用统计只保存元数据。模型下载和更新需要网络；MCP 工具按你的配置运行。请求正文诊断与用量统计是两个独立功能，详见[数据与隐私](docs/USER_GUIDE.md#数据与隐私)。

**调优一定会更快吗？** 收益取决于模型、硬件和请求场景。当前调优比较有限的 PCIe 预算与 MTP 推测参数，不是自动搜索所有配置。应用会提供比较结果；没有稳定收益时保留当前配置，截图中的示例数值不代表实测提速。

更多安装、API 接入、用量、调优和更新说明见[使用指南](docs/USER_GUIDE.md)。发现问题可在 [Issues](https://github.com/hongfaqiu/strata-manager/issues) 反馈，请移除密钥和个人聊天内容。

## 致谢与许可

感谢 [Niko1221/Strata](https://github.com/Niko1221/Strata) 的作者与贡献者。本项目复用 Strata 的官方前端设计和功能，是独立社区桌面应用；Strata 推理运行时与模型权重独立安装，模型许可由提供方规定。

本仓库采用 [MIT](LICENSE)。复用代码与界面保留上游版权声明，Outfit 字体使用 SIL OFL 1.1；详见[第三方声明](THIRD_PARTY_NOTICES.md)。

<p align="center"><sub><a href="https://hongfaqiu.github.io/strata-manager/?lang=zh">Strata Manager 官网</a> · 本地模型，一站管理。</sub></p>
