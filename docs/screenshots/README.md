# 界面截图 / Screenshots

这 20 张页面图于 2026-10-11 从准备发布 0.1.3 的当前工作区实际 App 组件重新截取。中英文均为浅色，包含总览、Strata 管理、模型、运行配置、聊天、API 使用统计、调优、监控、设置和关于。设置、运行配置与调优页已目视检查，展示本轮去掉重复说明和分类选择后的界面。

页面通过隔离的内存 RPC 示例运行；模型、配置、聊天、硬件、版本状态与统计均为合成数据。截图没有启动真实推理、安装、更新、系统自启动或测量性能，不能用画面数值证明 GPU 表现。

浏览器视口为 1440 × 960，缩放因子为 2，PNG 输出 2880 × 1920 后无损转换为 WebP，并核对逐像素一致。20 页的浏览器错误、外部网络请求和页面横向溢出均为零。文件尺寸、SHA-256、捕获时源码基线及合并来源、源码内容摘要见 [manifest.json](manifest.json)。截图早于正式发布提交，因此不将捕获时 HEAD 误称为最终 Release revision。

`product-cover.zh.webp` 与 `product-cover.en.webp` 是中英文产品海报，使用 0.1.3 的模型管理页面和 API 请求趋势示例，突出降低 Strata 使用门槛、模型与服务管理、资源与 API 用量监控。`product-cover.webp` 是英文兼容别名。背景由 ImageGen 生成，文字和真实界面通过代码排版；来源见[品牌说明](../brand/README.md)。封面与 20 张原始页面截图分别记录。

These 20 page screenshots were captured on 2026-10-11 from the real App components in the current working tree prepared for the 0.1.3 release. Both languages use the light theme. They cover Overview, Strata management, Models, Runtime configuration, Chat, API usage, Tuning, Monitoring, Settings and About. Settings, configuration and tuning were visually reviewed after the simplified help and category controls were implemented.

The pages use isolated in-memory RPC documentation examples. Models, configurations, conversations, hardware, status and statistics are synthetic. No real inference, installation, runtime update, operating-system startup or performance measurement was performed; displayed numbers do not establish GPU performance.

A 1440 × 960 browser viewport with a device scale factor of 2 produces 2880 × 1920 PNGs. The WebP conversion is lossless and was checked for pixel equality. All 20 pages had zero browser errors, external requests and horizontal document overflow. [manifest.json](manifest.json) records dimensions, hashes, the capture-time source baseline and merged source, and a source-content digest. Capture preceded the release commit, so the capture-time HEAD is not presented as the final release revision.

`product-cover.zh.webp` and `product-cover.en.webp` are bilingual product heroes using the 0.1.3 model management page and an API request trend example. `product-cover.webp` is the English compatibility alias. The background is generated with ImageGen; text and real interface screenshots are composed with code. See the [brand source](../brand/README.md). Hero provenance is recorded separately from the 20 original page screenshots.
