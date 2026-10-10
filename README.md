<div align="center">

<a href="https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/product-cover.webp"><img src="docs/screenshots/product-cover.webp" alt="Strata Manager：本地模型，一站管理" width="100%"></a>

<h1>Strata Manager</h1>

<p><strong>本地模型，一站管理。</strong><br>
让 Strata 本地模型的安装、聊天、监控与调优，更容易上手。</p>

<p>
<a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/License-MIT-118577"></a>
<img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8DB">
<img alt="Windows and Linux x64" src="https://img.shields.io/badge/Windows%20%7C%20Linux-x64-51606F">
<img alt="中文 and English" src="https://img.shields.io/badge/Language-中文%20%7C%20English-118577">
<a href="https://github.com/hongfaqiu/strata-manager/actions/workflows/ci.yml"><img alt="Build and test" src="https://github.com/hongfaqiu/strata-manager/actions/workflows/ci.yml/badge.svg"></a>
</p>

<p>
<a href="https://hongfaqiu.github.io/strata-manager/">官网</a> ·
<a href="README.en.md">English</a> ·
<a href="#下载与体验">下载与体验</a> ·
<a href="#三步开始使用">快速上手</a> ·
<a href="#看看它的样子">界面展示</a> ·
<a href="docs/USER_GUIDE.md">使用指南</a>
</p>

</div>

Strata Manager 是 [Strata](https://github.com/Niko1221/Strata) 的社区桌面工作台，面向在自己电脑上运行 Strata 支持模型的用户。已有模型直接导入；服务启动、模型加载和后台监控交给应用。你可以专心聊天，也可以把本机 API 接入自己的工具。可用模型与 API 能力以所安装的 Strata 运行时为准。

> **首版仍在验收中。** 正式安装包尚未发布，可从源码体验或查看 [CI 构建产物](https://github.com/hongfaqiu/strata-manager/actions/workflows/ci.yml)。各平台的实际支持范围见[验收记录](docs/VERIFICATION.md)。

## 为什么使用 Strata Manager

| | |
| --- | --- |
| **已有模型，继续使用**<br>自动检测本机安装，恢复旧版有效档案与会话；原有模型不用重新下载。 | **聊天和工具，在同一处**<br>多会话、流式回答、思考过程、图片和文本附件，以及 MCP 工具事件。 |
| **关闭窗口，API 继续运行**<br>独立后台管理已启动的服务；重新打开界面即可连接回来。 | **知道模型是怎么被使用的**<br>查看请求量、tokens、成功率、等待时间、缓存和最近请求。 |
| **调优，先比较再决定**<br>测量当前参数与候选参数，查看报告，再选择应用或恢复。 | **熟悉的 Strata 风格**<br>保留官方组件风格，中文/英文、浅色/深色主题、可折叠侧栏和自适应布局。 |

## 三步开始使用

1. **找到你的模型。** 打开“模型”。旧版 Manager 的有效档案会自动恢复；检测到已有 Strata 时选择导入。如果还没有安装，再使用准备向导。
2. **点击“使用”。** 等待“模型可用”，后台会检查运行环境、启动 Strata 并加载模型。新模型准备成功后自动加入列表，不会替换当前选择。
3. **开始聊天，或连接本机 API。** 在聊天页发送消息；需要接入其它软件时，使用总览或模型页显示的本机地址。API 协议能力取决于当前 Strata 运行时。

已有模型保持原位，应用使用受管配置副本。首次下载新模型可能需要较长时间，进度与失败原因会显示在任务中。遇到问题可查看[第一次使用指南](docs/USER_GUIDE.md#第一次使用)。

## 下载与体验

正式版本将通过 [GitHub Releases](https://github.com/hongfaqiu/strata-manager/releases) 提供。当前 CI 产物用于测试，不能当作正式签名发行版。

| 平台 | 安装形式 | 当前体验方式 |
| --- | --- | --- |
| Windows x64 | NSIS `*-setup.exe` | 从源码启动；安装包验收进度见[构建记录](https://github.com/hongfaqiu/strata-manager/actions/workflows/ci.yml)。 |
| Linux x64 | `*.AppImage` / `*.deb` | 已有 [CI 构建产物](https://github.com/hongfaqiu/strata-manager/actions/runs/38066271017)；实机安装与 GPU 验收仍待完成。 |

安装包包含桌面应用和后台，模型权重独立准备。硬件、显存、内存与驱动要求请按所选模型查看 [Strata 说明](https://github.com/Niko1221/Strata)；本项目目前面向 Windows/Linux x64。

<details>
<summary><strong>从源码体验</strong></summary>

需要 Node.js 22.13+、项目固定的 pnpm 11 和 Rust stable。Windows 还需要 MSVC、Windows SDK 与 WebView2；Linux 前置依赖见 [Tauri 文档](https://v2.tauri.app/start/prerequisites/)。

```sh
git clone https://github.com/hongfaqiu/strata-manager.git
cd strata-manager
pnpm install --frozen-lockfile
pnpm desktop
```

开发、测试和打包详见[开发说明](docs/DEVELOPMENT.md)。

</details>

## 看看它的样子

截图来自当前应用界面，使用明确标注的演示数据；模型、聊天、用量和调优数值均不代表真实运行结果或性能承诺。截图采用 2 倍像素密度与无损 WebP，点击图片可查看高清原图。

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

比较基线与候选结果，检查一致性和波动，再决定是否应用。没有稳定收益时保留当前设置。

[![调优：场景选择、测量和结果](docs/screenshots/tuning.zh.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/tuning.zh.webp)

<details>
<summary><strong>更多界面：性能监控与设置</strong></summary>

<br>

[![性能监控：硬件、吞吐和请求状态](docs/screenshots/monitor.zh.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/monitor.zh.webp)

[![设置：语言、主题、后台策略、自启动和更新](docs/screenshots/settings.zh.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/settings.zh.webp)

</details>

## 常见问题

**我已经有模型，为什么还要下载？** 不需要。先查看“我的模型”或导入已有 Strata；仅在准备新模型时下载权重。

**关掉窗口，API 会停止吗？** 已启动的服务由独立后台继续运行。需要释放模型并结束受管服务时，使用托盘中的“停止服务并退出”。

**聊天和统计会上传吗？** 聊天记录保存在本机，使用统计只保存元数据。模型下载和更新需要网络；MCP 工具按你的配置运行。请求正文诊断与用量统计是两个独立功能，详见[数据与隐私](docs/USER_GUIDE.md#数据与隐私)。

**调优一定会更快吗？** 收益取决于模型、硬件和请求场景。应用会提供比较结果；没有稳定收益时保留当前配置，界面演示数值不代表实测提速。

更多安装、API 接入、用量、调优和更新说明见[使用指南](docs/USER_GUIDE.md)。发现问题可在 [Issues](https://github.com/hongfaqiu/strata-manager/issues) 反馈，请移除密钥和个人聊天内容。

## 致谢与许可

感谢 [Niko1221/Strata](https://github.com/Niko1221/Strata) 的作者与贡献者。本项目复用 Strata 的官方前端设计和功能，是独立社区桌面应用；Strata 推理运行时与模型权重独立安装，模型许可由提供方规定。

本仓库采用 [MIT](LICENSE)。复用代码与界面保留上游版权声明，Outfit 字体使用 SIL OFL 1.1；详见[第三方声明](THIRD_PARTY_NOTICES.md)。

<p align="center"><sub><a href="https://hongfaqiu.github.io/strata-manager/">Strata Manager 官网</a> · 本地模型，一站管理。</sub></p>
