# 界面截图 / Screenshots

## 未发布界面补图 / Unreleased interface additions

0.1.5 界面于 2026-10-12 采用独立发布批次：11 个视图各含中文和英文，共 22 张，保存在 `changelog/0.1.5/`。包含串行上下文 Benchmark、演示结果图表与图片导出、串行场景测试、紧凑监控浮条与托盘设置、总览接入 API，以及公共聊天、连接、下载、服务状态和应用更新页面。结果报告使用演示数据，非性能实测。更新日志的 0.1.5 部分引用这批图；公开 0.1.4 的日志使用下面原发布批次的图片。此批次不会替换或改写原 0.1.4 的截图与来源记录。

新图同样加载真实 React 入口与原有样式，仅替换隔离 RPC 数据；不启动真实模型、测速、安装或更新，不修改真实用户配置。18 张普通图为 2880 × 1920；中文与英文结果报告分别为 2880 × 2720、2880 × 2800，以完整呈现图表和表格；两张浮条图为 440 × 80，对应默认 220 × 40 逻辑像素。无损 WebP 与 PNG 逐像素一致；捕获前后核对 HEAD、源码及辅助文件摘要，并检查错误、外部请求、原生变更调用和页面溢出。原生右键菜单、系统窗口操作和实际推理性能不由这些浏览器截图证明。文件清单、尺寸、哈希及检查证据见[独立批次记录](changelog/0.1.5/manifest.json)。

The 0.1.5 interface captured on 2026-10-12 forms a separate release batch of 22 images: 11 views in Chinese and English, under `changelog/0.1.5/`. They cover serial context benchmarks, demonstration report charts/image export, serial scenario tests, the compact floating monitor and tray settings, Overview API integration, common chat settings, connections, downloads, service status and app updates. Report values are demonstration data rather than performance measurements. The 0.1.5 notes use this batch; public 0.1.4 notes use the original release images below. The original 0.1.4 images and provenance remain intact.

The new batch loads the real React entry and original styles with isolated RPC data. It never starts real models, speed tests, installations or updates, and never changes real user configuration. The 18 standard images are 2880 × 1920. Chinese and English reports are 2880 × 2720 and 2880 × 2800 to show the complete charts and table; the two monitor images are 440 × 80, representing the default 220 × 40 logical-pixel window. Lossless WebP conversion is checked pixel by pixel against PNG. The capture compares HEAD, source and helper digests before/after and checks errors, external requests, native mutations and overflow. These browser images do not establish native context-menu/window acceptance or measured inference performance. File details and checks are recorded in the [separate manifest](changelog/0.1.5/manifest.json).

此前开发批次保留在 `changelog/unreleased/` 供历史溯源，不再作为当前发布截图。
The earlier development batch remains under `changelog/unreleased/` for historical provenance, separate from current release images.

## 中文

0.1.4 的页面截图采用统一批次：18 个视图各含中文和英文浅色图，共 36 张。视图包括总览、Strata、模型、运行配置、聊天、API 使用统计、调优、监控、设置、关于、Benchmark、公共聊天默认值、API 与外部助手、显存与会话、应用更新、服务状态、下载设置与测试，以及独立桌面监控浮条。它们取代旧版 20 图和单独追加 Benchmark 的分批记录；本轮不再使用独立的 `benchmarkCapture` 来源说明。

截图由真实 `apps/desktop/src/main.tsx` 入口加载当前 App 或浮条组件，使用应用原有 CSS、字体、图标和路由；只将 RPC 响应替换为隔离合成数据。模型、配置、会话、硬件、版本、任务和统计数值均为文档示例。没有启动真实模型、执行安装或更新、改变系统自启动，也没有操作真实系统窗口；浮条图不证明原生拖动、缩放、置顶或窗口生命周期已通过实机验收。图中数值不能作为推理结果、GPU 性能或调优收益证据。

普通页面使用 1440 × 960 CSS 像素视口和 DPR 2，输出 2880 × 1920 图像；浮条使用 920 × 82 CSS 像素视口和 DPR 2，输出 1840 × 164 图像。PNG 转为无损 WebP 后逐像素比较，要求尺寸和像素一致。浮条保留自己的宽高比例，不按普通页面裁切。

统一捕获流程在批次开始和结束时核对捕获 HEAD、应用源码树摘要与 fixture/helper 摘要。浏览器页面错误、控制台错误、外部网络请求、被禁止的原生变更调用和文档横向溢出均须为零；浮条另检查其固定视口内没有垂直溢出。内层正常滚动区域不等于文档横向溢出。示例监控间隔使用界面支持的 30000 毫秒，使设置下拉框显示实际选项。

[manifest.json](manifest.json) 记录最终采用的统一批次、尺寸、文件大小、PNG/WebP SHA-256、逐像素检查、源码与 helper 摘要及捕获检查结果。捕获时 HEAD 是源码基线，不是最终 Release SHA；当时工作区内容由文件摘要标识，发布提交与同源码 CI 另行核验。重跑后的最终批次记录应替换此前批次，不能把旧批次哈希与新图混用。

`product-cover.zh.webp` 与 `product-cover.en.webp` 现采用完整总览及展开的服务状态弹层；`product-cover.webp` 是英文兼容别名。两图为0.1.5 真实界面的隔离示例，均为 2880 × 1920，保持完整窗口与原始比例，未进行裁剪、拼接或重画。封面不计入 36 张原发布页面图，来源、像素核验和哈希单独登记于 manifest 的 `coverProvenance`。此前使用模型页、API 统计及抽象背景的合成封面记录保留在 `historicalCoverProvenance`；见[品牌说明](../brand/README.md)。

此目录记录浏览器文档截图及其合成数据来源。真实模型推理、完整 GPU Benchmark、调优收益、安装器、跨版本更新，以及系统窗口和硬件行为均需各自的实机验收；已执行的检查与限制见[验证记录](../VERIFICATION.md)和[系统说明](../SYSTEM.md)。

## English

The 0.1.4 page screenshots use one unified batch: 18 views in Chinese and English, all in the light theme, for 36 images. They cover Overview, Strata, Models, Runtime configuration, Chat, API usage, Tuning, Monitoring, Settings, About, Benchmark, Common chat defaults, API and external assistants, VRAM and sessions, App updates, Service status, Download settings and test, and the floating desktop monitor. This replaces the old 20-image batch and separately appended Benchmark capture; this batch has no separate `benchmarkCapture` provenance record.

The real `apps/desktop/src/main.tsx` entry loads the current App or monitor components with the application's original CSS, fonts, icons and routing. Only RPC responses are replaced with isolated synthetic data. Models, configurations, conversations, hardware, versions, tasks and statistics are documentation examples. No real model, installation, update, operating-system startup setting or native system-window operation is exercised. The monitor image does not establish hardware acceptance of native dragging, resizing, pinning or window lifecycle behavior. Displayed values are not inference results, GPU measurements or evidence of tuning gains.

Standard pages use a 1440 × 960 CSS-pixel viewport and DPR 2, producing 2880 × 1920 images. The monitor uses a 920 × 82 CSS-pixel viewport and DPR 2, producing 1840 × 164 images. PNG-to-WebP conversion is lossless and checked for identical dimensions and pixels. The monitor retains its own aspect ratio rather than being cropped as a full-page screenshot.

The capture workflow compares the capture HEAD, application source-tree digest and fixture/helper digest before and after the batch. Page errors, console errors, external requests, forbidden native mutation calls and horizontal document overflow must all be zero; the monitor also checks for vertical overflow within its fixed viewport. Normal scrolling inside a component is not horizontal document overflow. The example polling interval is the supported 30000 ms option, so the settings dropdown displays a valid choice.

[manifest.json](manifest.json) records the final selected unified batch, dimensions, sizes, PNG/WebP SHA-256 values, pixel checks, source/helper digests and capture results. The capture-time HEAD is a source baseline, not the final release SHA. File digests identify working-tree content; the release commit and same-source CI are verified separately. The final rerun supersedes earlier batches, and earlier hashes must not be mixed with new images.

`product-cover.zh.webp` and `product-cover.en.webp` now show the complete Overview with its service-status popover open. `product-cover.webp` is the English compatibility alias. These 2880 × 1920 isolated 0.1.5 interface examples preserve the complete window and original proportions without cropping, composition or redrawing. They are separate from the 36 original release page images; `coverProvenance` records their origin, pixel checks and hashes. The former compositions using Models, API usage and an abstract background remain documented under `historicalCoverProvenance`. See the [brand source](../brand/README.md).

This directory documents browser screenshots and their synthetic data sources. Real inference, complete GPU Benchmark runs, tuning gains, installers, cross-version updates, native-window behavior and hardware compatibility require their own acceptance checks. Performed checks and limits are described in the [verification record](../VERIFICATION.md) and [system explanation](../SYSTEM.en.md).
