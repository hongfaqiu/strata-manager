# 开发与构建 / Development

[中文产品介绍](../README.zh-CN.md) · [English README](../README.md) · [验收记录](VERIFICATION.md) · [发布指南](RELEASING.md)

## 环境 / Requirements

Node.js 22.13+（CI 使用 24）、项目固定的 pnpm 11、Rust stable。Windows 需要 MSVC C++ Build Tools、Windows SDK 和 WebView2；Linux 系统依赖见 [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)。

## 启动与检查 / Run and check

```sh
pnpm install --frozen-lockfile
pnpm desktop       # 准备独立后台并启动 Tauri / Prepare the background and start Tauri
pnpm desktop:debug # 生成可直接打开的开发版，自带前端 / Standalone dev app with embedded frontend
pnpm check         # Types, core/HTTP tests, frontend build
pnpm native:test   # Rust workspace tests
pnpm bundle        # Build a local installer; updater artifacts require signing
```

`pnpm dev` 仅运行前端；安装、进程管理和系统功能在桌面应用中执行。独立后台可用 `node scripts/prepare-sidecar.mjs --profile release` 构建。

直接打开开发版请使用 `pnpm desktop:debug` 生成的 `output/dev-desktop/StrataManager-dev.exe`（Windows），保留同目录 `strata-supervisor.exe`。该版本嵌入前端，不需要 Vite，并以独立 `io.strata.manager.dev` 标识保存数据，与稳定版并存。热更新开发继续使用 `pnpm desktop`；直接 `cargo build` 未开启 `custom-protocol` 时仍依赖 `http://127.0.0.1:1427`，不是可独立打开的构建。

For a directly launched dev build use `pnpm desktop:debug`, keeping the supervisor beside the app. It embeds frontend assets and uses a separate dev identity/data directory. Hot reload still uses `pnpm desktop`; a raw Cargo build without `custom-protocol` expects the local Vite server.

开发脚本统一主应用与后台的 Rust target；设置 `CARGO_BUILD_TARGET` 时从 `target/<triple>/debug` 复制，未设置时复用本机 `target/debug`。`CARGO_TARGET_DIR` 支持绝对目录，相对目录按 `apps/desktop/src-tauri` 解析。启动时显式设置 `STRATA_MANAGER_DATA_DIR` 会覆盖默认数据隔离。配置的产品名为 `Strata Manager Dev`，应用内标题／托盘仍共用 `Strata Manager`。该命令不生成安装包或 updater 签名；嵌入构建成功与离线实窗验收分别记录。

The script uses the same Rust target for app and supervisor. Explicit `CARGO_BUILD_TARGET` artifacts come from `target/<triple>/debug`; the default host reuses `target/debug`. Relative `CARGO_TARGET_DIR` paths resolve from `apps/desktop/src-tauri`. Setting `STRATA_MANAGER_DATA_DIR` at launch overrides default data isolation. The configured product name is `Strata Manager Dev`, while in-app/tray text still shares `Strata Manager`. This command requests no installer or updater signature; embedded build evidence is separate from offline window acceptance.

`pnpm dev` runs the frontend only. Installation, process management and OS features require the desktop application. Build the independent background with `node scripts/prepare-sidecar.mjs --profile release`.

## 代码位置 / Source layout

| 路径 / Path | 职责 / Role |
| --- | --- |
| `docs/SYSTEM.md` / `SYSTEM.en.md` | Component relationships, persistence and operating boundaries |
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

[静态官网 / Product website](https://strata-manager.cosfoc.com/) 使用原生 HTML/CSS/JavaScript，中英文可切换。使用指南、下载、故障排查及许可等页面由仓库原文预渲染；发布后无需客户端请求 Markdown 或加载应用运行时。

```sh
pnpm install --frozen-lockfile --ignore-scripts
node --test scripts/render-website-docs.test.mjs
node scripts/build-website.mjs
```

输出为 `dist/website`，可用任意静态 HTTP 服务预览。构建阶段复用已锁定的 Markdown 渲染依赖，检查本地页面、资源和锚点，并生成文档 sitemap。打包脚本从 `assets/icon.svg` 和 `docs/screenshots` 复制品牌与截图，不需要重复维护图片。截图使用示例数据，来源在 README 和官网的图外说明，不代表真实推理或性能结果。

官网和 Benchmark 排行榜接口由同一个 Cloudflare Worker（`services/arena`）托管在 `strata-manager.cosfoc.com`：静态页面来自 `dist/website`（Workers 静态资源），`/v1/*` 是排行榜 API；`arena.cosfoc.com` 仍指向同一 Worker，供已发布的应用调用。推送 `main` 上的官网、Markdown 文档、许可、截图、图标、渲染脚本或 `services/arena` 改动时，`Website and Arena on Cloudflare` 工作流先检查和构建，再应用待执行的 D1 迁移并用 wrangler 部署，也可在 `main` 上手动运行；PR 只构建、检查并试运行部署。官网部署与桌面应用的发行版本独立。

The website uses plain HTML/CSS/JavaScript with a Chinese/English switch. Documentation is rendered at build time using locked dependencies; published pages contain their full content without fetching Markdown in the browser. The build checks local pages, assets and anchors and generates the documentation sitemap. Run the commands above and serve `dist/website` with any static HTTP server. The `Website and Arena on Cloudflare` workflow deploys relevant website, documentation, license and `services/arena` changes on `main` to one Cloudflare Worker that serves the site and the leaderboard API at `strata-manager.cosfoc.com` (and the API at `arena.cosfoc.com`); it can also be dispatched manually on `main`. Pull requests only build, check and dry-run the deploy. Screenshots use example data disclosed outside the images, not inference or performance results.

## 发布 / Release

正式发布需要版本一致、实际签名密钥、两平台检查和安装包、草稿资产的真实密码学验签。不要提交私钥、用户配置、个人聊天或未经脱敏的诊断。流程与验收边界见 [RELEASING](RELEASING.md)。

Official releases require matching versions, signing configuration, both platform checks and installers, and cryptographic verification of draft assets. Keep private keys, user configuration, personal chats and unredacted diagnostics out of Git.
