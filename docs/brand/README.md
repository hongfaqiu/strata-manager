# Product hero

The README hero uses a light mint product layout with the real Strata Manager interface. It introduces the local desktop workspace: runtimes and models, chat, API insights, and workload tuning.

- Editable layout: [product-cover.html](product-cover.html).
- Export: [product-cover.webp](../screenshots/product-cover.webp), 3200 × 1800 pixels, rendered at 1600 × 900 CSS pixels with a device pixel ratio of 2.
- UI: [overview.en.webp](../screenshots/overview.en.webp), captured from published v0.1.2 source `2fac51edd7147526442ddbb109a6a28d7b276ef7`. It uses the actual App components with isolated documentation data. Values shown are examples, not benchmarks.
- Icon: the unchanged paths and colors from [assets/icon.svg](../../assets/icon.svg), embedded as vector markup. Typography uses the application's bundled Outfit font; its [OFL license](../../apps/desktop/src/fonts/OFL.txt) applies.
- Background: [hero-background.webp](hero-background.webp), generated on 2026-10-11 using the built-in ImageGen tool with [this exact prompt](hero-background.prompt.txt). Only the abstract background was generated. The logo, text and interface are composed deterministically in HTML/CSS.
- Final export: browser PNG → lossless WebP, with pixel equality verified. No JPEG intermediate is used. The [screenshot manifest](../screenshots/manifest.json) records the dimensions, size, source image and SHA-256.

To render again, serve the repository root over HTTP on `127.0.0.1:1439`, open the layout with Playwright CLI, and pass the function in [capture.js](capture.js) to its `run-code` command. The function waits for fonts and images, checks for missing assets and overflow, then writes `output/playwright/product-cover.png`. Convert that PNG to lossless WebP without resizing and refresh the manifest after any source changes.

The GitHub About description used with this visual refresh is:

> Local-first Strata desktop app: detect existing models, manage runtimes and background services, chat, monitor API usage and tune inference. Built with Tauri for Windows & Linux. Supports Qwen3.8 Flash Next.

这是 README 产品图的可编辑来源与导出记录。背景为生成素材，产品标识、文字与应用界面通过代码精确排版；界面数据仅用于文档展示。中英文页面截图保持亮色主题，使用无损 WebP。封面与实际界面截图分别记录来源。
