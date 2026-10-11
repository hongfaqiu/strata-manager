# Strata Manager 文档

[官网](https://hongfaqiu.github.io/strata-manager/?lang=zh) · [产品介绍](../README.zh-CN.md) · [English](README.en.md)

Strata Manager 是 Strata 运行环境与本地模型服务管理桌面工作台，核心是 Strata 安装与匹配的 Windows x64 ZIP 引擎更新、运行配置和服务生命周期；聊天、监控、API 使用统计和调优是配套工具。它是独立社区项目，推理能力与协议以已安装的 Strata 运行时和具体模型为准。

本目录描述 0.1.1 源码；安装包是否已发布及内容以[发布页](https://github.com/hongfaqiu/strata-manager/releases/tag/v0.1.1)为准，未冻结候选不作为已通过 CI 的版本。

## 从这里开始

| 你想做什么 | 阅读内容 |
| --- | --- |
| 下载安装包或从源码体验 | [下载与体验](DOWNLOAD.md) |
| 检查或安装 Strata，再选择已有模型或准备新模型 | [第一次使用](USER_GUIDE.md#第一次使用) |
| 查看 Strata 版本、更新日志并安装匹配的 Windows x64 ZIP 更新 | [Strata 管理](USER_GUIDE.md#更新-strata-运行环境) |
| 在模型内切换配置，编辑图形化参数或 JSON | [运行配置](USER_GUIDE.md#运行配置) |
| 接入本机 API | [API 接入](USER_GUIDE.md#接入本机-api) |
| 查看请求历史、统计和 CSV 导出 | [API 用量](USER_GUIDE.md#阅读-api-用量) |
| 理解后台、健康状态、调优和更新 | [完整使用指南](USER_GUIDE.md) |
| 处理准备失败、连接异常或更新问题 | [故障排查与反馈](TROUBLESHOOTING.md) |

## 支持范围

- 全局管理本机 Strata，直接展示发现的受支持模型与运行配置；已有权重保持原位，释放内存不删除文件。
- 默认自动检查更新，展示更新日志并由用户确认安装；关闭窗口后台运行默认开启，关闭该选项后退出会停止受管服务。
- 图像、思考、MCP 工具和 API 协议依赖所选运行时、模型与工具配置。
- 调优比较完整用途场景下的请求参数与受支持重启候选，保留质量和资源检查；没有固定提速保证。
- 当前面向 Windows/Linux x64。正式发行、GPU、Linux 实机和跨版本更新的证据分别记录，不把界面截图或夹具当作实际模型验收。

v0.1.1 发布入口：[Windows 安装包](https://github.com/hongfaqiu/strata-manager/releases/download/v0.1.1/Strata.Manager_0.1.1_x64-setup.exe) · [AppImage](https://github.com/hongfaqiu/strata-manager/releases/download/v0.1.1/Strata.Manager_0.1.1_amd64.AppImage) · [DEB](https://github.com/hongfaqiu/strata-manager/releases/download/v0.1.1/Strata.Manager_0.1.1_amd64.deb) · [SHA256 校验](https://github.com/hongfaqiu/strata-manager/releases/download/v0.1.1/SHA256SUMS)。[下载说明](DOWNLOAD.md)列出安装步骤和当前支持范围。稳定版使用 `latest` 通道，预览版采用手工安装且不替换该通道。

## 许可与来源

- [MIT 许可](../LICENSE)
- [第三方来源与许可](../THIRD_PARTY_NOTICES.md)
- [上游 Strata](https://github.com/Niko1221/Strata)

源码和维护资料保留在 [GitHub 仓库](https://github.com/hongfaqiu/strata-manager)。

## 反馈

先按[故障排查](TROUBLESHOOTING.md)检查当前模型与任务状态，再通过有填写指引的[问题反馈表](https://github.com/hongfaqiu/strata-manager/issues/new/choose)提交复现信息。
