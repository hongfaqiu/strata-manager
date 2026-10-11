<div align="center">

<a href="https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/product-cover.webp"><img src="docs/screenshots/product-cover.webp" alt="Strata Manager — Strata runtime, model configurations and local services" width="1200" /></a>

<h1>Strata Manager</h1>
<p><strong>Your desktop workspace for Strata and local model services.</strong></p>
<p>Install and update Strata, choose model configurations, and manage your local API.</p>

<p>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license" /></a>
<a href="https://tauri.app/"><img src="https://img.shields.io/badge/desktop-Tauri%202-24c8d8" alt="Tauri 2 desktop" /></a>
<img src="https://img.shields.io/badge/targets-Windows%20%2F%20Linux%20x64-64748b" alt="Windows and Linux x64 targets" />
<a href="README.zh-CN.md"><img src="https://img.shields.io/badge/languages-中文%20%2F%20English-6366f1" alt="Chinese and English" /></a>
<a href="https://github.com/hongfaqiu/strata-manager/actions/workflows/ci.yml"><img src="https://github.com/hongfaqiu/strata-manager/actions/workflows/ci.yml/badge.svg" alt="Current build and test status" /></a>
</p>

<p><a href="https://hongfaqiu.github.io/strata-manager/?lang=en">Website</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="#download">Download</a> · <a href="#get-started">Get started</a> · <a href="#features">Features</a> · <a href="#screenshots">Screenshots</a> · <a href="https://hongfaqiu.github.io/strata-manager/docs/user-guide.en.html">User guide</a> · <a href="https://hongfaqiu.github.io/strata-manager/docs/index.en.html">Documentation</a></p>

</div>

**v0.1.1 release entry.** Use the links below or read the [release notes](https://github.com/hongfaqiu/strata-manager/releases/tag/v0.1.1) and [installation guide](https://hongfaqiu.github.io/strata-manager/docs/download.en.html).

Strata Manager is an open-source desktop workspace for the [Strata](https://github.com/Niko1221/Strata) runtime and local model services. Its core is runtime installation and updates, model configurations, and service startup, shutdown and recovery. Chat, monitoring, API usage statistics and parameter tuning support that workflow. Existing model weights stay in place, and an independent background process manages running services.

The features and screenshots describe the 0.1.1 source. Package availability and the exact published version are shown on the [release page](https://github.com/hongfaqiu/strata-manager/releases/tag/v0.1.1). Release checks run for each revision; this documentation does not establish that an unpublished candidate has passed them.

## What is Strata?

[Strata](https://github.com/Niko1221/Strata) is an open-source local inference project. It coordinates GPU memory, RAM and CPU resources to run the models it supports, and provides a browser interface and a local API.

Strata Manager is an independent community project built on Strata. It manages Strata on this computer; inference capabilities, supported models, image input and API protocols come from the installed Strata runtime and chosen model.

## Features

- **Manage Strata centrally.** Detect an existing runtime or prepare one from the Strata page. View installed and upstream versions and official release notes. Matching official Windows x64 engine ZIPs support download, extraction and update progress; Linux ZIP engine updates are unavailable. Runtime management is separate from individual models.
- **Review updates before installing.** Automatic checks are enabled by default, on launch and every 12 hours. Available updates show release notes and require confirmation before installation. App updates, Strata updates and model weights are managed separately.
- **See the models you already have.** My models automatically lists discovered local models. Configurations that use the same model are grouped; switch configurations, inspect modification dates, and identify the current and last-used configuration without downloading weights again.
- **Edit the full runtime configuration.** Open a model's configuration inside Models. Use graphical controls with suggestions and custom values, or edit JSON; saves validate the configuration and retain a backup.
- **Control the local API.** Start, stop, restart or release model memory, with startup stages and logs. The active model and configuration remain visible while you browse other configurations. Releasing memory preserves model files.
- **Observe and test.** Monitor service and hardware activity; retain API usage after reopening the app and chart requests, tokens, latency, cache reuse, prefill and decode speeds. Missing measurements remain unknown.
- **Chat in the same workspace.** Keep conversations, streaming replies and attachments together. Reasoning, image input and MCP tool events require model and runtime support.
- **Tune with complete tasks.** Compare everyday chat, coding and Agent, or long-document workloads. Test PCIe/MTP request parameters and supported CPU, swapping, prefill and VRAM-reserve restart candidates, review quality and resource checks, then apply or restore. This is a bounded comparison, not a search of every configuration or a speed guarantee.

The merged window header follows the app's theme. Appearance follows the system by default; language and theme live in Settings beside the sidebar collapse control. Closing to the tray is enabled by default. Disable it to stop managed services and exit when closing, with a confirmation that can be suppressed. Tray actions show service state and provide shortcuts.

## Download

Use the **v0.1.1** release entry for your system. Install only packages actually listed on that page. The [download guide](https://hongfaqiu.github.io/strata-manager/docs/download.en.html) provides installation steps and support scope.

| Platform | Package | Installation |
| --- | --- | --- |
| Windows x64 | [NSIS installer](https://github.com/hongfaqiu/strata-manager/releases/download/v0.1.1/Strata.Manager_0.1.1_x64-setup.exe) | Requires WebView2; [installation guide](https://hongfaqiu.github.io/strata-manager/docs/download.en.html#install-on-windows). |
| Linux x64 | [AppImage](https://github.com/hongfaqiu/strata-manager/releases/download/v0.1.1/Strata.Manager_0.1.1_amd64.AppImage) / [DEB](https://github.com/hongfaqiu/strata-manager/releases/download/v0.1.1/Strata.Manager_0.1.1_amd64.deb) | Built in Ubuntu 22.04 CI; [installation and support scope](https://hongfaqiu.github.io/strata-manager/docs/download.en.html#install-on-linux). |

[SHA256 checksums](https://github.com/hongfaqiu/strata-manager/releases/download/v0.1.1/SHA256SUMS) · [Release notes](https://github.com/hongfaqiu/strata-manager/releases/tag/v0.1.1)

CI gates cover Windows silent installation, desktop startup, private background IPC, shutdown and uninstall, and Linux AppImage/extracted DEB startup, private IPC and shutdown in Ubuntu 22.04 with Xvfb. The [verification record](https://github.com/hongfaqiu/strata-manager/blob/main/docs/VERIFICATION.md) ties completed runs to specific revisions. System-level DEB installation, real GPU use and login startup still require separate acceptance. A cross-version NSIS installer check does not establish end-to-end Tauri updater installation.

Stable releases use the `latest` update channel; previews remain manual downloads and do not replace it. Tauri update signatures are separate from Windows Authenticode publisher signing. macOS and ARM are currently outside the release targets.

The desktop package contains the app and background process. The Strata runtime and model weights are prepared separately. Hardware, drivers and free disk space depend on the model; check [Strata's documentation](https://github.com/Niko1221/Strata) before preparing one.

## Get started

1. **Prepare Strata first.** Open Strata to inspect the detected runtime and version. An existing runtime does not need reinstalling. If none is found, use the installation guide before choosing or downloading a model.
2. **Choose a model and configuration.** My models shows discovered models directly. Select a configuration or add a search directory if yours is missing. Use Download models to prepare new weights, or select Runtime settings to open the configuration page with graphical controls and JSON.
3. **Choose Use and follow startup.** The model joins the managed list and shows environment checks, startup and loading progress. Wait for Model ready, then chat or copy the local API address into another application. The current model and configuration are marked in My models.

Only supported installations on **this computer** are managed. See the [user guide](docs/USER_GUIDE.en.md) for preparation requirements, background behavior, API connections and troubleshooting.

## Screenshots

These screenshots render the current app components with isolated example data. Model status, chat content, usage and tuning values are examples, not live inference results or benchmarks. The cover shows the Strata management screen. Click an image to view its full-resolution version.

**Strata — runtime versions, Windows x64 ZIP updates and official release notes**

[![Strata — installed runtime and update management](docs/screenshots/runtime.en.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/runtime.en.webp)

**My models — all discovered models, grouped configurations and active service**

[![My models — discovered models and runtime configurations](docs/screenshots/models.en.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/models.en.webp)

**Runtime configuration — graphical controls and JSON inside Models**

[![Runtime configuration — graphical and JSON editing](docs/screenshots/config.en.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/config.en.webp)

<details>
<summary>Explore overview, monitoring, usage, tuning, chat, settings and About</summary>

**Overview — current service and quick controls**

[![Overview — current service and local activity](docs/screenshots/overview.en.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/overview.en.webp)

**Monitor — service and hardware activity**

[![Monitor — service state and performance](docs/screenshots/monitor.en.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/monitor.en.webp)

**API usage — see how your local service is used**

[![API usage — request, cache and throughput charts](docs/screenshots/usage.en.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/usage.en.webp)

**Tuning — compare before choosing**

[![Tuning — baseline and candidate comparison](docs/screenshots/tuning.en.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/tuning.en.webp)

**Chat — conversations, attachments and tools**

[![Chat — conversations and streaming replies](docs/screenshots/chat.en.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/chat.en.webp)

**Settings — make the workspace yours**

[![Settings — language, theme, background and updates](docs/screenshots/settings.en.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/settings.en.webp)

**About — app identity, versions and project links**

[![About — project information and credits](docs/screenshots/about.en.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/about.en.webp)

</details>

## Learn more

The [user guide](docs/USER_GUIDE.en.md) explains API counters, local storage and privacy, tuning limits, startup and updates, and common problems. See the [download guide](https://hongfaqiu.github.io/strata-manager/docs/download.en.html) for versions and current support scope.

**Will closing the window stop the API?** Closing to the tray is enabled by default and keeps a running service available. Turn it off to stop managed services and exit on close; the confirmation offers a Don't ask again option. The tray also provides Stop services and quit.

**Does releasing model memory delete the model?** No. It releases RAM and VRAM while retaining model files and the API process. Removing a saved configuration also preserves the original model files.

**Are API usage and the request viewer the same?** No. Usage stores local metadata and charts. On a supported, verified managed runtime, open advanced diagnostics and enable temporary request-body capture for 5, 15 or 30 minutes. It keeps up to 100 requests in RAM and erases captured bodies when disabled or expired; it does not change `api_monitor`. A viewer already enabled by your own `api_monitor` configuration stays under your control. Usage statistics require neither form of body capture.

**Does local inference mean every integration is offline?** Chats and usage records are stored locally. Downloads and updates use the network; configured MCP tools may contact external services. Review the tools you enable and remove private content before sharing diagnostics.

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
