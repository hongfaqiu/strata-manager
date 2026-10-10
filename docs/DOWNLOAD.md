# 下载与体验

[文档目录](README.md) · [使用指南](USER_GUIDE.md) · [English](DOWNLOAD.en.md)

Strata Manager 是本地模型管理桌面应用。桌面安装包包含应用和独立后台，模型权重与 Strata 运行环境另行准备或导入。

## 选择体验方式

截至 2026-10-11，仓库尚无正式 Release。Releases 页没有版本时，不表示使用指南或源码不可用，也不是一个可下载的正式安装包。

| 平台 | 可用入口 | 说明 |
| --- | --- | --- |
| Windows x64 | [从源码体验](#从源码体验)；[查看构建进度](https://github.com/hongfaqiu/strata-manager/actions/workflows/ci.yml) | 目标安装形式为 NSIS；只把已经上传的产物当作可下载内容 |
| Linux x64 | [历史 CI 预览包](#linux-预览包)或源码 | AppImage / DEB 测试包；不等于正式签名发行版或实机 GPU 验收 |

模型、图像和 API 协议以所选 Strata 运行时为准。检查硬件、驱动、RAM、VRAM 和磁盘要求后再准备模型；已有受支持安装可直接导入。

## Linux 预览包

已核查的[历史构建 38066271017](https://github.com/hongfaqiu/strata-manager/actions/runs/38066271017)来自提交 d1e2155。该次 Linux job 成功并上传两个产物，Windows job 失败，因此整次流水线不是全部通过：

- **ci-linux-amd64-appimage**
- **ci-linux-amd64-deb**

这是旧提交的测试包，不包含后续全部功能修订。使用最新源码需要从源码构建；更多构建可在[CI 工作流](https://github.com/hongfaqiu/strata-manager/actions/workflows/ci.yml)查看，确认对应平台的 job 成功且确实有 Artifacts 后再下载。

### 下载步骤

1. 登录 GitHub，打开上述构建的运行摘要页。
2. 找到 **Artifacts** 区域，点击需要的产物名称。
3. 解压下载的 ZIP；选择其中的 AppImage 或 DEB 安装文件。
4. AppImage 需授予可执行权限后运行；DEB 可通过系统软件安装器打开，缺少的系统依赖按发行版提示处理。
5. 打开应用后，按[第一次使用](USER_GUIDE.md#第一次使用)导入已有模型或准备新模型。

GitHub 的 Artifacts 下载需要已登录且有仓库读取权限，产物也有保留期限；详见 [GitHub 官方下载说明](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)。看不到 Artifacts 时，先检查登录状态、构建是否结束、目标平台是否成功及产物是否过期；不要把没有产物的运行当作下载入口。

## 从源码体验

需要 Node.js 22.13+、项目固定的 pnpm 11 和 Rust stable。Windows 需要 MSVC C++ Build Tools、Windows SDK 与 WebView2；Linux 需要 [Tauri 系统依赖](https://v2.tauri.app/start/prerequisites/)。

~~~sh
git clone https://github.com/hongfaqiu/strata-manager.git
cd strata-manager
pnpm install --frozen-lockfile
pnpm desktop
~~~

pnpm desktop 启动完整桌面应用和后台。pnpm dev 只运行前端，不能代替安装、进程管理和系统集成。构建与检查见[开发说明](DEVELOPMENT.md)。

## 正式版本与更新

正式版本发布后会在 [GitHub Releases](https://github.com/hongfaqiu/strata-manager/releases)列出版本、安装包和发布说明。正式包、CI 测试包和自行构建的安装包是不同来源，请先核对版本及实际验收范围。

应用更新、Strata 运行环境和模型权重分开管理。自动检查/下载不等于已经安装；运行时更新使用应用核验过的固定候选，不自动追随上游最新版本。详细行为见[使用指南](USER_GUIDE.md)，发布与真实系统证据见[验收记录](VERIFICATION.md)。
