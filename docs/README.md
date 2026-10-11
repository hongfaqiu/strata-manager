# Strata Manager 文档

[官网](https://hongfaqiu.github.io/strata-manager/?lang=zh) · [产品介绍](../README.zh-CN.md) · [English](README.en.md)

Strata Manager 是面向 Strata 本地推理的桌面工作台，集中管理运行环境、模型配置和服务生命周期，提供聊天、监控、API 使用统计、参数调优与 Benchmark 基准测试。它是独立社区项目，推理能力与协议以已安装的 Strata 运行时和具体模型为准。

## 从这里开始

| 你想做什么 | 阅读内容 |
| --- | --- |
| 理解桌面、独立后台、推理引擎和数据保存 | [系统说明](SYSTEM.md) |
| 管理公共聊天参数与连接工具 | [公共设置](USER_GUIDE.md#公共设置与模型配置) |
| 下载安装包或从源码体验 | [下载与体验](DOWNLOAD.md) |
| 了解功能变化与修复 | [更新日志](../CHANGELOG.md) |
| 检查或安装 Strata，再选择已有模型或准备新模型 | [第一次使用](USER_GUIDE.md#第一次使用) |
| 查看 Strata 版本、更新日志并安装匹配的 Windows x64 ZIP 更新 | [Strata 管理](USER_GUIDE.md#更新-strata-运行环境) |
| 在模型内切换配置，编辑图形化参数或 JSON | [运行配置](USER_GUIDE.md#运行配置) |
| 接入本机 API | [API 接入](USER_GUIDE.md#接入本机-api) |
| 查看近期状态趋势，按需打开独立监控浮条 | [服务状态与监控](USER_GUIDE.md#阅读后台健康状态) |
| 查看请求历史、统计和 CSV 导出 | [API 用量](USER_GUIDE.md#阅读-api-用量) |
| 运行场景套件或并发压力测试，对比性能并导出报告 | [Benchmark 基准测试](USER_GUIDE.md#benchmark-基准测试) |
| 理解后台、健康状态、调优和更新 | [完整使用指南](USER_GUIDE.md) |
| 处理准备失败、连接异常或更新问题 | [故障排查与反馈](TROUBLESHOOTING.md) |

## 支持范围

- 全局管理本机 Strata，直接展示发现的受支持模型与运行配置；已有权重保持原位，释放内存不删除文件。
- 新模型可继承公共聊天默认值，旧模型保留已保存的专用参数；在“API 与外部助手”集中配置连接目标、应用访问密钥、API 示例与 MCP。
- Windows 引擎 ZIP 默认使用官方来源，支持已保存镜像和中断后续传；各来源按当前 CUDA12、CUDA13 或 HIP 引擎匹配，完整文件仍按官方大小与 SHA256 校验。
- 状态面板显示近期生成与输入处理趋势，保留缺失点；独立桌面监控浮条默认关闭，只读观察已运行的后台，不会启动后台或模型。
- 默认自动检查更新，展示更新日志并由用户确认安装；关闭窗口后台运行默认开启，关闭该选项后退出会停止受管服务。
- 图像、思考、MCP 工具和 API 协议依赖所选运行时、模型与工具配置。
- 调优比较完整用途场景下的请求参数与受支持重启候选，保留质量和资源检查；没有固定提速保证。
- Benchmark 支持七类场景、固定并发和逐级升压，分别记录延迟、生成速度、缓存与资源趋势，并提供 JSON / CSV 报告。
- 当前面向 Windows/Linux x64。正式发行、GPU、Linux 实机和跨版本更新的证据分别记录，不把界面截图或夹具当作实际模型验收。

公开安装包：[最新稳定版发布页](https://github.com/hongfaqiu/strata-manager/releases/latest) · [官网平台下载](https://hongfaqiu.github.io/strata-manager/#get-started)。仅下载发布页实际列出的文件，并核对同版本的 SHA256SUMS。[下载说明](DOWNLOAD.md)列出安装步骤和当前支持范围。稳定版使用 `latest` 通道，预览版采用手工安装且不替换该通道。

## 许可与来源

- [MIT 许可](../LICENSE)
- [第三方来源与许可](../THIRD_PARTY_NOTICES.md)
- [上游 Strata](https://github.com/Niko1221/Strata)

源码和维护资料保留在 [GitHub 仓库](https://github.com/hongfaqiu/strata-manager)。

## 反馈

先按[故障排查](TROUBLESHOOTING.md)检查当前模型与任务状态，再通过有填写指引的[问题反馈表](https://github.com/hongfaqiu/strata-manager/issues/new/choose)提交复现信息。
