<div align="center">

<a href="https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/product-cover.webp"><img src="docs/screenshots/product-cover.webp" alt="Strata Manager — overview, chat and local model management" width="1200" /></a>

<h1>Strata Manager</h1>
<p><strong>Local models. One workspace.</strong></p>
<p>Manage local models, conversations, background services and your local API in one desktop app.</p>

<p>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license" /></a>
<a href="https://tauri.app/"><img src="https://img.shields.io/badge/desktop-Tauri%202-24c8d8" alt="Tauri 2 desktop" /></a>
<img src="https://img.shields.io/badge/targets-Windows%20%2F%20Linux%20x64-64748b" alt="Windows and Linux x64 targets" />
<a href="README.zh-CN.md"><img src="https://img.shields.io/badge/languages-中文%20%2F%20English-6366f1" alt="Chinese and English" /></a>
<a href="https://github.com/hongfaqiu/strata-manager/actions/workflows/ci.yml"><img src="https://github.com/hongfaqiu/strata-manager/actions/workflows/ci.yml/badge.svg" alt="Current build and test status" /></a>
</p>

<p><a href="https://hongfaqiu.github.io/strata-manager/?lang=en">Website</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="#download">Download</a> · <a href="#get-started">Get started</a> · <a href="#features">Features</a> · <a href="#screenshots">Screenshots</a> · <a href="https://hongfaqiu.github.io/strata-manager/docs/user-guide.en.html">User guide</a> · <a href="https://hongfaqiu.github.io/strata-manager/docs/index.en.html">Documentation</a></p>

</div>

**Preview v0.1.0-beta.1 is available.** Download below or read the [release notes](https://github.com/hongfaqiu/strata-manager/releases/tag/v0.1.0-beta.1) and [installation guide](https://hongfaqiu.github.io/strata-manager/docs/download.en.html).

Strata Manager is an open-source desktop app for local model management. Import and prepare models, manage configurations, start and load services, chat, monitor activity, and connect to your local API in one workspace. Existing weights stay in place, and an independent background process manages running services. The app uses the [Strata](https://github.com/Niko1221/Strata) runtime; available models, image input and API protocols depend on your installed runtime and chosen model.

## What is Strata?

[Strata](https://github.com/Niko1221/Strata) is an open-source local inference project. It coordinates GPU memory, RAM and CPU resources to run the models it supports, and provides a browser interface and a local API.

Strata Manager is an independent community desktop management app built on Strata. It handles model import and preparation, configurations, background services and the desktop workspace. Inference capabilities come from the Strata runtime and chosen model.

## Features

- **Keep existing models.** Detect and import supported local Strata installations without downloading their weights again.
- **Skip the setup chores.** Prepare the official runtime and a private Python environment through the app, without finding Git or entering Python paths.
- **Keep your API available.** An independent background process manages startup and reconnects when you reopen the desktop window.
- **Chat in one place.** Keep conversation history, streaming replies and text attachments together. Reasoning, image input and MCP tool events require model and runtime support.
- **Understand your usage.** Follow request volume, tokens, latency, cache reuse, errors and activity over time, with unknown values clearly identified.
- **Tune with measurements.** Compare supported PCIe budget and MTP speculation parameters against the baseline, review drift and output consistency, then apply a candidate or restore the original settings. This is a bounded comparison, not a search of every configuration or a speed guarantee.

Chinese and English, light and dark themes, a collapsible sidebar, tray actions, startup settings and update controls make the workspace fit daily use. The interface follows Strata's visual style.

## Download

Download preview **v0.1.0-beta.1** for your system and install it manually. The [download guide](https://hongfaqiu.github.io/strata-manager/docs/download.en.html) provides installation steps and support scope.

| Platform | Package | Installation |
| --- | --- | --- |
| Windows x64 | [NSIS installer](https://github.com/hongfaqiu/strata-manager/releases/download/v0.1.0-beta.1/Strata.Manager_0.1.0-beta.1_x64-setup.exe) | Requires WebView2; [installation guide](https://hongfaqiu.github.io/strata-manager/docs/download.en.html#install-on-windows). |
| Linux x64 | [AppImage](https://github.com/hongfaqiu/strata-manager/releases/download/v0.1.0-beta.1/Strata.Manager_0.1.0-beta.1_amd64.AppImage) / [DEB](https://github.com/hongfaqiu/strata-manager/releases/download/v0.1.0-beta.1/Strata.Manager_0.1.0-beta.1_amd64.deb) | Built in Ubuntu 22.04 CI; [installation and support scope](https://hongfaqiu.github.io/strata-manager/docs/download.en.html#install-on-linux). |

[SHA256 checksums](https://github.com/hongfaqiu/strata-manager/releases/download/v0.1.0-beta.1/SHA256SUMS) · [Release notes](https://github.com/hongfaqiu/strata-manager/releases/tag/v0.1.0-beta.1)

Windows package checks cover silent installation, desktop startup, private background IPC, shutdown and uninstall. Linux checks cover AppImage and extracted DEB startup, private IPC and shutdown in Ubuntu 22.04 with Xvfb. System-level DEB installation, real GPU use, login startup and cross-version updates remain unverified.

Previews use manual installation and do not replace the stable `latest` update channel. Tauri update signatures are separate from Windows Authenticode publisher signing. macOS and ARM are currently outside the release targets.

The desktop package contains the app and background process. Model weights and the Strata runtime are prepared or imported separately. Hardware, drivers and free disk space depend on the model; check [Strata's documentation](https://github.com/Niko1221/Strata) before preparing one.

## Get started

1. **Have a model already? Open My models.** Valid models and conversations from earlier Manager versions are restored automatically. Import a supported local Strata installation, selecting its folder only if detection misses it. Weights from that installation stay in place and do not need another download.
2. **Need a new model? Follow preparation.** Let the app prepare the runtime, then choose the model, size, context and image support. Follow the task log; cancel or retry when needed. Only download new weights when you choose to add them. Verified results appear in My models without replacing your current selection.
3. **Choose Use, wait for Model ready, then chat.** Service startup is handled by the app. To connect another application, copy the local API address and use its matching API path. Closing the window keeps an already running service available; use the tray's Stop services and quit action to stop it.

Only installations prepared or imported on **this computer** are managed. See the [user guide](docs/USER_GUIDE.en.md) for preparation requirements, background behavior, API connections and troubleshooting.

## Screenshots

These are actual App screens rendered with isolated in-memory RPC example data. Model status, chat content and metrics are examples disclosed here outside the images, not live inference results or benchmarks. The cover combines these screens and is not performance evidence. Screenshots use 2× pixel density and lossless WebP; click any image to open its full-resolution version.

**Your workspace at a glance**

[![Overview — model readiness, next steps and local activity](docs/screenshots/overview.zh.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/overview.zh.webp)

**Conversations, attachments and tools**

[![Chat — conversations and streaming replies](docs/screenshots/chat.zh.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/chat.zh.webp)

<details>
<summary>Explore models, API usage, tuning, monitoring and settings</summary>

**Models — reuse what you have, prepare what you need**

[![Models — local installations and preparation](docs/screenshots/models.zh.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/models.zh.webp)

**API usage — see how your local service is used**

[![API usage — request trends, tokens and latency](docs/screenshots/usage.zh.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/usage.zh.webp)

**Tuning — compare before choosing**

[![Tuning — baseline and candidate comparison](docs/screenshots/tuning.zh.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/tuning.zh.webp)

**Monitor — inspect service and hardware activity**

[![Monitor — service state and performance](docs/screenshots/monitor.zh.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/monitor.zh.webp)

**Settings — make the workspace yours**

[![Settings — language, theme, background and updates](docs/screenshots/settings.zh.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/settings.zh.webp)

</details>

## Learn more

The [user guide](docs/USER_GUIDE.en.md) explains API counters, local storage and privacy, tuning limits, startup and updates, and common problems. See the [download guide](https://hongfaqiu.github.io/strata-manager/docs/download.en.html) for versions and current support scope.

<details>
<summary>Build from source</summary>

### Build from source

Use Node.js **22.13+** (CI uses 24), pnpm **11.21.0** and Rust stable. Windows needs MSVC C++ Build Tools, Windows SDK and WebView2; Linux dependencies are listed in [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
git clone https://github.com/hongfaqiu/strata-manager.git
cd strata-manager
pnpm install --frozen-lockfile
pnpm desktop
```

Local builds are separate from published signed packages. Maintainers can refer to the [release source document](https://github.com/hongfaqiu/strata-manager/blob/main/docs/RELEASING.md).

Source layout and checks remain in the [development source document](https://github.com/hongfaqiu/strata-manager/blob/main/docs/DEVELOPMENT.md) on GitHub.

</details>

## Credits and license

Built on [Niko1221/Strata](https://github.com/Niko1221/Strata), with its official interface style and capabilities. Thank you to the upstream author and contributors. Strata Manager is an independent community desktop application.

Strata Manager uses [MIT](LICENSE); reused Strata resources retain their MIT attribution. The bundled Outfit font uses SIL OFL 1.1. See [third-party notices](THIRD_PARTY_NOTICES.md). Model weights are installed separately and retain their providers' licenses.
