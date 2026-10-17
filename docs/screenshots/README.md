# 界面截图 / Screenshots

## 当前图库 / Current gallery

本目录根部是 README 与官网使用的界面图库：23 个视图各含中文和英文页面图，另有中英文封面与英文兼容封面，全部为 WebP；具体文件与尺寸以 manifest 为准。

This directory's root holds the interface gallery used by the README and website: 23 views, each with Chinese and English page images, plus Chinese and English covers and an English compatibility cover, all in WebP. The manifest lists every file and its dimensions.

| 批次 / Batch | 内容 / Contents | 来源记录 / Capture record |
| --- | --- | --- |
| 根目录 / Root | 总览、运行环境、模型与配置、聊天、用量、调优、监控、设置、关于、Benchmark、公共聊天、连接、会话工具、更新、服务状态、下载设置、浮条，以及运行中服务、语言选择、浮条设置、场景测试和结果报告 / Overview, runtime, models and configuration, chat, usage, tuning, monitoring, settings, About, Benchmark, common chat, connections, session tools, updates, service status, download settings, floating monitor, running services, language selection, monitor settings, scenario tests and reports | [manifest.json](manifest.json) |
| `daily-experience/` | 16 张日常工作流程图：模型下载列表与详情、API 验证、服务能力、启动诊断、聊天计时、历史条件比较、API 用量 / 16 workflow images covering model downloads, API verification, capabilities, startup diagnostics, chat timing, history comparison and API usage | [独立 manifest / Separate manifest](daily-experience/manifest.json) |

封面 `product-cover.zh.webp` 与 `product-cover.en.webp` 直接使用对应语言的 `overview` 完整截图：正常总览，右上角服务状态保持收起，保留原始比例，不裁剪、拼接或重画。以后重拍首页封面沿用这一状态；`service-status` 独立功能图可展开弹层。`product-cover.webp` 是英文兼容别名；封面与页面图分别记入 manifest。

The bilingual covers, `product-cover.zh.webp` and `product-cover.en.webp`, directly use the complete corresponding `overview` screenshots: normal Overview with the top-right service status closed, preserving the original proportions without cropping, composition or redrawing. Future homepage-cover captures keep this state; the separate `service-status` feature images may show the popover open. `product-cover.webp` is the English compatibility alias. The manifest records covers separately from page images.

## 采集与重跑 / Capture and reproduction

截图加载实际 `apps/desktop/src/main.tsx`、App／浮条组件及原有样式，只替换隔离的示例 IO 数据。模型、会话、版本、硬件、任务和统计值是文档示例；这些浏览器截图不证明真实推理性能或原生窗口操作。

Captures load the actual `apps/desktop/src/main.tsx`, App/monitor components and original styles with isolated example IO data. Models, conversations, versions, hardware, tasks and statistics are documentation examples. These browser screenshots do not establish measured inference performance or native-window behavior.

普通页面使用 1440 × 960 CSS 像素视口和 DPR 2；结果报告使用更高视口呈现图表，浮条按实际组件计算尺寸保留自身比例。各图的最终尺寸以 manifest 为准。无损 WebP 解码后与原始 PNG 尺寸、像素一致；记录包含源码前后摘要核对、采集辅助文件摘要、PNG/WebP SHA-256，以及逐图检查。页面／控制台错误和外网请求均为零。

Standard pages use a 1440 × 960 CSS-pixel viewport and DPR 2. Reports use a taller viewport, and floating-monitor images retain the size computed by the actual component. The manifest records final dimensions, source digests compared before/after capture, helper digests, PNG/WebP SHA-256 values and per-image checks. Lossless WebP decoding matches the original PNG's dimensions and pixels; page/console errors and external requests are zero.

根目录图库可用下列脚本重跑；数据与场景定义位于 [scripts/screenshot-fixtures/](../../scripts/screenshot-fixtures/)，中间 PNG、WebP 和检查结果写入 `output/playwright/docs-refresh-20261014/`。脚本使用本机 Chrome；可通过 `STRATA_BROWSER_EXECUTABLE`、`STRATA_PYTHON_EXECUTABLE` 指定浏览器与含 Pillow 的 Python，通过 `CODEX_WORKSPACE_NODE_MODULES` 指定补充依赖目录。

Reproduce the root gallery with the following script. Data and scene definitions live in [scripts/screenshot-fixtures/](../../scripts/screenshot-fixtures/); intermediate PNG/WebP files and checks are written to `output/playwright/docs-refresh-20261014/`. The script uses local Chrome. `STRATA_BROWSER_EXECUTABLE`, `STRATA_PYTHON_EXECUTABLE` and `CODEX_WORKSPACE_NODE_MODULES` can override the browser, a Python runtime with Pillow, and supplementary dependencies.

```sh
node scripts/capture-current-screenshots.mjs
```

开始使用引导（`onboarding`）、Benchmark 排行榜（`arena`）和旧版本配置清理（`config-cleanup`）三组图由下列脚本生成。它在隔离测试夹具中运行真实界面，排行榜数据来自 [arena-preview.js](../../scripts/screenshot-fixtures/arena-preview.js) 的合成值；规格与上述根目录图库相同（1440 × 960、DPR 2、无损 WebP），记录写入 manifest 的 `featureScreens`。

The getting-started guide (`onboarding`), Benchmark leaderboard (`arena`) and old-version configuration cleanup (`config-cleanup`) images come from the following script. It runs the real interface inside the isolated test fixtures, with synthetic leaderboard data from [arena-preview.js](../../scripts/screenshot-fixtures/arena-preview.js). The format matches the root gallery (1440 × 960, DPR 2, lossless WebP); records go to `featureScreens` in the manifest.

```sh
node scripts/capture-feature-screenshots.mjs
```

## 历史批次 / Historical batches

0.1.4 时期的根目录曾使用 18 个双语视图、共 36 张页面图，已被上述当前批次替换；替换前的根目录图片与 manifest 备份在本机 `output/playwright/docs-refresh-20261014/backup/`。版本日志中的历史配图保持各自来源：`changelog/0.1.4/` 保存该版本日志引用的 16 张原图，`changelog/0.1.7/` 保存 6 张原图，均与迁移前 Git HEAD 的文件字节一致。两版日志的图片引用已指向历史目录，正文未改，当前图库重拍不会改变其来源说明。`changelog/0.1.5/` 保留 2026-10-12 的 22 张独立发布图，`changelog/unreleased/` 保留更早的开发批次。

The former root gallery contained 36 page images covering 18 bilingual views from the 0.1.4 period; the current batch replaces it. The previous root images and manifest are backed up locally under `output/playwright/docs-refresh-20261014/backup/`. Historical changelog images retain their own provenance: `changelog/0.1.4/` holds the 16 original images referenced by those release notes, and `changelog/0.1.7/` holds six originals. Both archives match the files from Git HEAD before migration byte for byte. Their changelog image references now point to these archives without changing the prose, so refreshing the current gallery preserves the historical source descriptions. `changelog/0.1.5/` keeps the 22-image release batch captured on 2026-10-12; `changelog/unreleased/` keeps an earlier development batch.

历史截图记录：[0.1.4](changelog/0.1.4/manifest.json)、[0.1.5](changelog/0.1.5/manifest.json)、[0.1.7](changelog/0.1.7/manifest.json)、[更早开发批次 / Earlier development batch](changelog/unreleased/manifest.json)、[控件调整 / Control refinements](ui-refinements/README.md)、[监控自定义 / Monitor customization](monitor-customization/README.md)、[监控密度 / Monitor density](monitor-density/README.md)。已执行的验收范围见[验证记录 / Verification](../VERIFICATION.md)。
