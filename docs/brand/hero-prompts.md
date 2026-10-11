# Bilingual product hero

Updated on 2026-10-12 with the built-in ImageGen tool. Only the abstract background is generated. The logo, exact bilingual copy, and real App component screenshots are composed deterministically by [render-product-hero.mjs](../../scripts/render-product-hero.mjs).

The screenshots are documentation examples from the current 0.1.3 application; their models, hardware, status, and API values are demonstration data, not benchmarks. No model-specific capability or measured performance is claimed by the hero. See [the screenshot manifest](../screenshots/manifest.json) for the UI source.

Outputs:

- [Chinese hero](../screenshots/product-cover.zh.webp).
- [English hero](../screenshots/product-cover.en.webp).
- [Compatibility English alias](../screenshots/product-cover.webp).
- [Generated background](hero-background.webp).

The hero is rendered at 1800 × 1000 CSS pixels with a device pixel ratio of 2, producing 3600 × 2000 WebP images. Typography uses the application's bundled Outfit font and the installed Chinese system font. The unchanged brand icon comes from [assets/icon.svg](../../assets/icon.svg). The model-management image only crops unused lower canvas; the API insert is a complete request-trend card. No UI text, model names or example metrics are altered.

To render, provide `sharp` and `playwright` through normal module resolution or `CODEX_WORKSPACE_NODE_MODULES`, then run `node scripts/render-product-hero.mjs`. An optional `STRATA_HERO_GENERATED_BACKGROUND` path imports a new built-in ImageGen result. Validation proofs are saved under the ignored `output/playwright/product-hero/` directory.

## Exact background prompt

```text
Use case: ads-marketing
Asset type: background art for a wide bilingual open-source desktop software hero banner.
Primary request: create an elegant restrained visual backdrop for Strata Manager, a desktop workspace that makes the Strata local AI inference engine easier to set up, manage and monitor. This is BACKGROUND ONLY, no text and no UI.
Scene/backdrop: soft ivory white canvas, very pale mint atmospheric gradient, with elegant layered translucent sheets of frosted mint glass suggesting "strata", mainly in the upper-right edge and lower-right corner. The visual motif should feel quiet, tactile, premium and practical, with a trace of dark forest green at edges.
Style/medium: polished editorial 3D material study, clean modern open-source software marketing, soft studio light, subtle depth, smooth frosted glass.
Composition/framing: wide landscape 16:9. The left 48 percent is plain clean almost-white negative space for large typography, and the central-right area is also calm and empty to accept a real app screenshot later. Only a few cropped sculptural mint layers at top-right and bottom-right margins. No perspective floor.
Color palette: ivory white #fafcf9, pale mint #e0f6ed, light emerald #b3e6d4, dark forest green #143e35 sparingly.
Constraints: no words, no letters, no numbers, no logo, no charts, no icons, no screens, no computer, no invented product UI. Background art only. Avoid loud gradients, neon, futuristic networks, crowded folds, sharp contrast, dense shapes, shadows near the left typography area, watermark.
```

## Exact bilingual copy

| Element | Chinese | English |
| --- | --- | --- |
| Brand | Strata Manager | Strata Manager |
| Eyebrow | STRATA 的桌面管理工具 | A DESKTOP WORKSPACE FOR STRATA |
| Title | 让 Strata 更容易上手 | Make Strata easier to use |
| Subtitle | 本地模型的管理与监控，一个工作台完成。 | Manage and monitor local models in one workspace. |
| Focus 1 | 安装与配置 | Setup & configuration |
| Focus 2 | 模型与服务管理 | Models & services |
| Focus 3 | 资源与 API 用量监控 | Resources & API usage |
| Screenshot caption | 界面示例 · 展示数据 | Example interface · Demonstration data |
| Platforms | Windows / Linux | Windows / Linux |
| Footer | Open source | Open source |

The built-in tool does not expose a verifiable model name or reasoning level for this generation, so neither is asserted here.
