# 产品宣传图 / Product preview

默认宣传图使用完整总览页，并展开右上角服务状态弹层。中文介绍、英文介绍、官网首页与分享预览分别使用对应语言图片；图片保持原始比例，点击可查看完整原图。官网放大预览会在可视区域内等比缩放，按钮放在图片之外。

- 中文：[product-cover.zh.webp](../screenshots/product-cover.zh.webp)。英文：[product-cover.en.webp](../screenshots/product-cover.en.webp)。兼容文件 [product-cover.webp](../screenshots/product-cover.webp) 与英文图一致。
- 原始尺寸为 2880 × 1920，由 1440 × 960 CSS 像素视口以 DPR 2 捕获。完整保留应用窗口和服务状态弹层，不裁剪、拼接或重画界面。
- 来自0.1.5的真实 React 组件、样式、字体和图标，使用隔离示例数据；未执行真实模型推理、服务控制或原生窗口操作，显示数值不代表性能实测。
- PNG 转为无损 WebP，逐像素验证。版本、捕获源码、原图及导出哈希记录在[截图清单](../screenshots/manifest.json)的 `coverProvenance`。

The default product preview is the complete Overview with the top-right service-status popover open. The bilingual introductions, website hero and sharing metadata use the corresponding language image. Images retain their original proportions, and the website lightbox fits the entire image within the viewport with controls outside it.

The 2880 × 1920 images come from a 1440 × 960 CSS-pixel viewport at DPR 2. They preserve the application window and popover without cropping, composition or redrawing. Real development application components, styles, fonts and icons use isolated example data; no inference, service changes or native window operations are performed. Displayed values are not performance measurements. PNG and lossless WebP pixels are verified against each other; `coverProvenance` in the [screenshot manifest](../screenshots/manifest.json) records their origin and hashes.

## 历史素材 / Historical assets

此前 0.1.4 的宣传封面由[渲染脚本](../../scripts/render-product-hero.mjs)组合模型页、API 使用统计、文字和[抽象背景](hero-background.webp)。只有该历史背景来自 ImageGen，提示词见[生成记录](hero-prompts.md)。历史封面来源保留在截图清单的 `historicalCoverProvenance`；这些旧合成脚本不用于当前默认宣传图。

The previous 0.1.4 compositions used the [renderer](../../scripts/render-product-hero.mjs), Models/API usage screenshots, text and the [abstract background](hero-background.webp). Only that historical background was generated with ImageGen; its [prompt](hero-prompts.md) is retained. The screenshot manifest preserves the old provenance under `historicalCoverProvenance`. These composition scripts do not produce the current default preview.

应用图标沿用 [assets/icon.svg](../../assets/icon.svg)，Outfit 字体遵循 [OFL 许可](../../apps/desktop/src/fonts/OFL.txt)。截图和示例数据不能证明原生浮条、托盘或硬件行为已通过实机验收；相关边界见[系统说明](../SYSTEM.md)。
