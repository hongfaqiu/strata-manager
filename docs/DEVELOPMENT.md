# 开发与构建 / Development

[中文产品介绍](../README.zh-CN.md) · [English README](../README.md) · [验收记录](VERIFICATION.md) · [发布指南](RELEASING.md)

## 环境 / Requirements

Node.js 22.13+（CI 使用 24）、项目固定的 pnpm 11、Rust stable。Windows 需要 MSVC C++ Build Tools、Windows SDK 和 WebView2；Linux 系统依赖见 [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)。

## 启动与检查 / Run and check

```sh
pnpm install --frozen-lockfile
pnpm desktop       # 准备独立后台并启动 Tauri / Prepare the background and start Tauri
pnpm check         # Types, core/HTTP tests, frontend build
pnpm native:test   # Rust workspace tests
pnpm bundle        # Build a local installer; updater artifacts require signing
```

`pnpm dev` 仅运行前端；安装、进程管理和系统功能在桌面应用中执行。独立后台可用 `node scripts/prepare-sidecar.mjs --profile release` 构建。

`pnpm dev` runs the frontend only. Installation, process management and OS features require the desktop application. Build the independent background with `node scripts/prepare-sidecar.mjs --profile release`.

## 代码位置 / Source layout

| 路径 / Path | 职责 / Role |
| --- | --- |
| `apps/desktop` | React interface and Tauri shell |
| `apps/supervisor` | Independent background process |
| `crates/runtime-core` | Local runtime, preparation, analytics and tuning |
| `crates/local-ipc` | User-scoped local communication |
| `crates/update-verifier` | Verify release installer bytes against the built-in public key |
| `packages/core` | Shared types, API protocols and metrics |
| `website` | Static Chinese/English product website and documentation styles |
| `scripts/render-website-docs.mjs` | Render documentation from Markdown and check local links |

`node scripts/contract-server.mjs` 启动 `http://127.0.0.1:18091` 协议夹具；没有模型推理，不是 GPU 性能证据。

`node scripts/contract-server.mjs` starts a protocol fixture at `http://127.0.0.1:18091`. It performs no model inference and is not a GPU benchmark.

## 官网 / Website

[静态官网 / Product website](https://hongfaqiu.github.io/strata-manager/) 使用原生 HTML/CSS/JavaScript，中英文可切换。使用指南、下载、故障排查及许可等页面由仓库原文预渲染；发布后无需客户端请求 Markdown 或加载应用运行时。

```sh
pnpm install --frozen-lockfile --ignore-scripts
node --test scripts/render-website-docs.test.mjs
node scripts/build-website.mjs
```

输出为 `dist/website`，可用任意静态 HTTP 服务预览。构建阶段复用已锁定的 Markdown 渲染依赖，检查本地页面、资源和锚点，并生成文档 sitemap。打包脚本从 `assets/icon.svg` 和 `docs/screenshots` 复制品牌与截图，不需要重复维护图片。截图使用示例数据，来源在 README 和官网的图外说明，不代表真实推理或性能结果。

GitHub Pages 的发布源使用 **GitHub Actions**；推送 `main` 上的官网、Markdown 文档、许可、截图、图标或渲染脚本等改动时，`Publish website` 工作流自动发布，也可手动运行。官网部署与桌面应用的发行版本独立。

The website uses plain HTML/CSS/JavaScript with a Chinese/English switch. Documentation is rendered at build time using locked dependencies; published pages contain their full content without fetching Markdown in the browser. The build checks local pages, assets and anchors and generates the documentation sitemap. Run the commands above and serve `dist/website` with any static HTTP server. The dedicated `Publish website` workflow deploys relevant website, documentation and license changes on `main` to GitHub Pages; it can also be dispatched manually. Screenshots use example data disclosed outside the images, not inference or performance results.

## 发布 / Release

正式发布需要版本一致、实际签名密钥、两平台检查和安装包、草稿资产的真实密码学验签。不要提交私钥、用户配置、个人聊天或未经脱敏的诊断。流程与验收边界见 [RELEASING](RELEASING.md)。

Official releases require matching versions, signing configuration, both platform checks and installers, and cryptographic verification of draft assets. Keep private keys, user configuration, personal chats and unredacted diagnostics out of Git.
