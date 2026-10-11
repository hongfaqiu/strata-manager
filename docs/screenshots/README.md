# 界面截图 / Screenshots

## 中文

0.1.4 的页面截图采用统一批次：18 个视图各含中文和英文浅色图，共 36 张。视图包括总览、Strata、模型、运行配置、聊天、API 使用统计、调优、监控、设置、关于、Benchmark、公共聊天默认值、API 与外部助手、显存与会话、应用更新、服务状态、下载设置与测试，以及独立桌面监控浮条。它们取代旧版 20 图和单独追加 Benchmark 的分批记录；本轮不再使用独立的 `benchmarkCapture` 来源说明。

截图由真实 `apps/desktop/src/main.tsx` 入口加载当前 App 或浮条组件，使用应用原有 CSS、字体、图标和路由；只将 RPC 响应替换为隔离合成数据。模型、配置、会话、硬件、版本、任务和统计数值均为文档示例。没有启动真实模型、执行安装或更新、改变系统自启动，也没有操作真实系统窗口；浮条图不证明原生拖动、缩放、置顶或窗口生命周期已通过实机验收。图中数值不能作为推理结果、GPU 性能或调优收益证据。

普通页面使用 1440 × 960 CSS 像素视口和 DPR 2，输出 2880 × 1920 图像；浮条使用 920 × 82 CSS 像素视口和 DPR 2，输出 1840 × 164 图像。PNG 转为无损 WebP 后逐像素比较，要求尺寸和像素一致。浮条保留自己的宽高比例，不按普通页面裁切。

统一捕获流程在批次开始和结束时核对捕获 HEAD、应用源码树摘要与 fixture/helper 摘要。浏览器页面错误、控制台错误、外部网络请求、被禁止的原生变更调用和文档横向溢出均须为零；浮条另检查其固定视口内没有垂直溢出。内层正常滚动区域不等于文档横向溢出。示例监控间隔使用界面支持的 30000 毫秒，使设置下拉框显示实际选项。

[manifest.json](manifest.json) 记录最终采用的统一批次、尺寸、文件大小、PNG/WebP SHA-256、逐像素检查、源码与 helper 摘要及捕获检查结果。捕获时 HEAD 是源码基线，不是最终 Release SHA；当时工作区内容由文件摘要标识，发布提交与同源码 CI 另行核验。重跑后的最终批次记录应替换此前批次，不能把旧批次哈希与新图混用。

`product-cover.zh.webp` 与 `product-cover.en.webp` 使用本版 `models` 和 `usage` 页面制作中英文产品封面；`product-cover.webp` 是英文兼容别名。封面不计入 36 张页面图。仅抽象背景来自 ImageGen，文字、标识和界面通过代码排版；来源见[品牌说明](../brand/README.md)。本轮已重渲染并目视检查两个封面，其尺寸、新哈希、页面来源和英文别名一致性单独登记于 manifest 的 `coverProvenance`。

此目录记录浏览器文档截图及其合成数据来源。真实模型推理、完整 GPU Benchmark、调优收益、安装器、跨版本更新，以及系统窗口和硬件行为均需各自的实机验收；已执行的检查与限制见[验证记录](../VERIFICATION.md)和[系统说明](../SYSTEM.md)。

## English

The 0.1.4 page screenshots use one unified batch: 18 views in Chinese and English, all in the light theme, for 36 images. They cover Overview, Strata, Models, Runtime configuration, Chat, API usage, Tuning, Monitoring, Settings, About, Benchmark, Common chat defaults, API and external assistants, VRAM and sessions, App updates, Service status, Download settings and test, and the floating desktop monitor. This replaces the old 20-image batch and separately appended Benchmark capture; this batch has no separate `benchmarkCapture` provenance record.

The real `apps/desktop/src/main.tsx` entry loads the current App or monitor components with the application's original CSS, fonts, icons and routing. Only RPC responses are replaced with isolated synthetic data. Models, configurations, conversations, hardware, versions, tasks and statistics are documentation examples. No real model, installation, update, operating-system startup setting or native system-window operation is exercised. The monitor image does not establish hardware acceptance of native dragging, resizing, pinning or window lifecycle behavior. Displayed values are not inference results, GPU measurements or evidence of tuning gains.

Standard pages use a 1440 × 960 CSS-pixel viewport and DPR 2, producing 2880 × 1920 images. The monitor uses a 920 × 82 CSS-pixel viewport and DPR 2, producing 1840 × 164 images. PNG-to-WebP conversion is lossless and checked for identical dimensions and pixels. The monitor retains its own aspect ratio rather than being cropped as a full-page screenshot.

The capture workflow compares the capture HEAD, application source-tree digest and fixture/helper digest before and after the batch. Page errors, console errors, external requests, forbidden native mutation calls and horizontal document overflow must all be zero; the monitor also checks for vertical overflow within its fixed viewport. Normal scrolling inside a component is not horizontal document overflow. The example polling interval is the supported 30000 ms option, so the settings dropdown displays a valid choice.

[manifest.json](manifest.json) records the final selected unified batch, dimensions, sizes, PNG/WebP SHA-256 values, pixel checks, source/helper digests and capture results. The capture-time HEAD is a source baseline, not the final release SHA. File digests identify working-tree content; the release commit and same-source CI are verified separately. The final rerun supersedes earlier batches, and earlier hashes must not be mixed with new images.

`product-cover.zh.webp` and `product-cover.en.webp` compose the product heroes from this version's `models` and `usage` pages. `product-cover.webp` is the English compatibility alias. These covers are separate from the 36 page images. Only the abstract background comes from ImageGen; text, branding and interfaces are composed with code. See the [brand source](../brand/README.md). Both covers were rerendered and visually inspected; their dimensions, new hashes, source images and alias equality are recorded separately under `coverProvenance` in the manifest.

This directory documents browser screenshots and their synthetic data sources. Real inference, complete GPU Benchmark runs, tuning gains, installers, cross-version updates, native-window behavior and hardware compatibility require their own acceptance checks. Performed checks and limits are described in the [verification record](../VERIFICATION.md) and [system explanation](../SYSTEM.en.md).
