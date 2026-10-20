<div align="center">

<img src="assets/icon.svg" width="88" height="88" alt="Strata Manager logo" />

<h1>Strata Manager</h1>
<p><strong>A desktop workspace for local inference with Strata.</strong><br />Prepare the runtime, manage models and services, and understand how your local API is running.</p>

<p>
<a href="https://strata-manager.cosfoc.com/en/"><strong>Website</strong></a> ·
<a href="https://strata-manager.cosfoc.com/docs/index.en"><strong>Documentation</strong></a> ·
<a href="docs/SYSTEM.en.md">System explanation</a> ·
<a href="https://github.com/hongfaqiu/strata-manager/releases/latest"><strong>Download</strong></a> ·
<a href="https://strata-manager.cosfoc.com/leaderboard.en">Leaderboard</a> ·
<a href="https://strata-manager.cosfoc.com/docs/changelog.en">Changelog</a> ·
<a href="README.zh-CN.md">简体中文</a>
</p>

<p>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-287e71" alt="MIT license" /></a>
<img src="https://img.shields.io/badge/desktop-Tauri%202-24c8d8" alt="Tauri 2 desktop" />
<img src="https://img.shields.io/badge/platforms-Windows%20%2F%20Linux%20x64%20%C2%B7%20macOS%20ARM%20experimental-51606f" alt="Windows and Linux x64; macOS Apple Silicon experimental" />
<a href="https://github.com/hongfaqiu/strata-manager/actions/workflows/ci.yml"><img src="https://github.com/hongfaqiu/strata-manager/actions/workflows/ci.yml/badge.svg" alt="Build and test status" /></a>
</p>

</div>

**Strata Manager is an open-source desktop management app for [Niko1221/Strata](https://github.com/Niko1221/Strata), a local large language model inference engine.** It brings guided first setup, model downloads and configurations across Strata versions, service controls, chat, API and agent connections with online verification, usage statistics, monitoring, tuning and benchmarking with an opt-in public leaderboard into one workspace. Existing supported model weights stay in place.

**Supports Strata 0.2.0**: installs and updates its signed `.tar.gz` engine packages on Windows and, from v0.2.9, Linux x86_64 in one click; a new engine is test-started first and rolled back automatically if it fails. Earlier ZIP releases keep working.

[![Strata Manager overview: service controls, GPU and system memory map, generation speed and recent requests](docs/screenshots/product-cover.en.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/product-cover.en.webp)

<p align="center"><a href="https://strata-manager.cosfoc.com/assets/video/intro.en.mp4"><img src="docs/media/intro-video.en.webp" width="640" alt="Play the 2-minute Strata Manager intro video" /></a><br /><sub>2-minute intro video · <a href="https://strata-manager.cosfoc.com/en/#intro-video">watch on the website</a> · <a href="https://strata-manager.cosfoc.com/#intro-video">中文版</a></sub></p>

## What is Strata, and what does Manager do?

[Strata](https://github.com/Niko1221/Strata) is an open-source local LLM inference engine. It coordinates GPU memory, RAM and CPU resources to run supported models, and provides a browser interface and a local API.

| Component | Responsibility |
| --- | --- |
| **Strata runtime** | Load models, execute inference and provide the API. Supported models, image input and protocols depend on the installed engine and chosen model. |
| **Strata Manager** | Prepare and inspect the runtime, manage local models and configurations across Strata versions, control services, connect and verify the API, and present chat, usage, monitoring, tuning and benchmarking tools. |
| **Your applications** | Connect to the running local API to use the model. |

Manager is an independent community project. It manages supported Strata installations on **this computer**; the runtime and model weights are installed separately.

## A workflow from setup to daily use

Engine-dependent tools appear according to the installed runtime's capabilities.

| Workflow | What you can do |
| --- | --- |
| **1 · Prepare Strata** | Detect installations and inspect local/upstream versions and release notes. Windows x64 engine ZIPs default to official GitHub, offer GH Proxy/GHProxy, custom HTTPS or local ZIP sources, and match the current CUDA12, CUDA13 or HIP engine across sources. Interrupted downloads retain partial data and attempt HTTP Range resume; complete packages are checked against official size and SHA256. Linux supports environment scans, versions and release notes. On first use, Getting started walks through six steps: checking the environment, installing Strata, choosing and downloading a model, starting and loading it, and the first chat; finished steps are detected and skipped. |
| **2 · Organize models** | Discover local weights, group configurations by model, choose download sources and GPUs, and inspect model files, GGUF metadata and disk usage. Supported formats include Swift IQ3_S. The download catalog updates in place with live download progress, models already on disk and whether each quantization fits this machine's memory; My models shows VRAM and memory capacity next to the memory each configuration needs. When several Strata versions share one `Strata-data` folder, each configuration is labeled with its Strata version, the current version is shown first, identical copies collapse into one row, and old-version configurations can be cleaned up into a recovery folder and restored. GGUF files you already downloaded can be used directly with “Use existing models” in the guide or on the Download models page: Manager checks that the shards are complete and readable, then starts with `--gguf-dir` instead of downloading again. |
| **3 · Configure and run** | Edit graphical controls or JSON with validation and backups. A concurrency card suggests how many requests to serve at once from VRAM, memory and GPU count; context goes up to 1M, with YaRN set automatically past 262K (experimental). Start, stop, restart or release model memory; follow startup stages, tasks on a 24-hour timeline and logs. On Windows, inspect detected running services, their loaded state, API address and configuration; reconnect to their existing Manager backend or take ownership. Opening Manager or signing in starts only the lightweight background, preserving stopped services. |
| **4 · Chat and integrate** | Use streaming conversations, attachments and structured output. New models inherit shared generation parameters and MCP defaults; existing custom values remain separate until inheritance is enabled. Changes apply to the next chat request. Configure connection targets, the application's access key, API examples and MCP in API and external assistants; selecting a target does not start or switch a model. Online verification checks the API step by step, with a status and timing for each step and the reason when one fails. |
| **5 · Inspect sessions and load** | Save and restore engine sessions; inspect per-slot speed trends, load, hardware and supported VRAM adjustments. The status panel separates recent generation and input-processing trends, preserving sample gaps, and shows automatic model reload progress after idle memory release. The desktop monitor is closed by default, with three layouts, ordered metrics and text/color controls; its context menu provides navigation, pinning and sampling, with optional system-tray monitoring. On Windows you can also turn on the taskbar monitor: a ring plus generation/prefill speed and other metrics next to the notification area, with a right-click menu to choose items, the ring metric and per-metric colors (off by default). Read-only observation never starts or restores services; quick speed tests send inference requests. |
| **6 · Understand usage and tune** | Retain local API metadata, support Strata 0.1.44 API usage statistics, and lead with requests, success rate, failures, tokens and generation speed before charting trends, callers, request outcomes, latency and cache reuse. One-click speed-up (the default) checks GPU memory headroom and long context, measures short and long answers without restarting, shows before/after and saves the result as a new configuration version you can roll back. The advanced mode also verifies complete chat, coding/Agent or document tasks, or save several concurrency settings as configuration versions and compare them, before applying or restoring supported tuning candidates; no fixed performance gain is promised. |
| **7 · Benchmark** | Run verified context tiers or seven scenario tests serially, or step up concurrent requests with the concurrency ladder. Record token counts, prefill/decode rates, TTFT, duration and resource samples; review history, export JSON/CSV, copy report images or export PNG. Coordinate tests with other inference operations. After you preview and agree, results can be shared anonymously on the [Benchmark leaderboard](https://strata-manager.cosfoc.com/leaderboard.en), which compares the same model and quantization across hardware and launch parameters and suggests settings for this machine; sharing can be turned off or withdrawn at any time. |
| **8 · Review updates and preferences** | Manage app and Strata updates separately from model weights. The dedicated app update page provides bundled bilingual notes offline, stable update checks and installation confirmation with Tauri signature verification. Follow the system language or choose one of ten bundled interface languages; use system/light/dark appearance and tray controls. Some advanced tools and original service logs use English. |
| **9 · Run headless (Linux, experimental)** | Run `strata-manager-server` on an Ubuntu server and use the same interface in a browser. It listens on `127.0.0.1:8787` by default, creates an access token on first run and ships a systemd unit. Packages are the release assets `Strata.Manager.Server_<version>_amd64.tar.gz` / `.deb`; see [docs/SERVER.en.md](docs/SERVER.en.md). |

API usage statistics work without capturing request bodies. Optional temporary body diagnostics are separate; see the [user guide](docs/USER_GUIDE.en.md) for behavior and privacy.

See the [system explanation](docs/SYSTEM.en.md) for component relationships and persistence.

## Download and get started

### Daily workflows

Strata Manager provides a model download list and details, unified multi-GPU and run options, resource assessment for the current selection, startup diagnostics, four capability states, chat request timing, a step-by-step API verification checklist, a usage dashboard and historical benchmark condition comparisons. Saved settings do not prove live engine support; missing evidence remains unverified, and settings that require a restart are identified separately. Verification never starts an unready model automatically.

See the [daily experience notes](docs/DAILY_EXPERIENCE.md) and [verification record](docs/VERIFICATION.md).

| Model downloads and resource selection | API verification and capabilities |
| --- | --- |
| [![Model catalog with live download progress, fit for this machine and resource assessment](docs/screenshots/daily-experience/model-download-detail.en.webp)](docs/screenshots/daily-experience/model-download-detail.en.webp) | [![API verification in the current interface](docs/screenshots/daily-experience/api-verification.en.webp)](docs/screenshots/daily-experience/api-verification.en.webp) |

### Installers

Choose a package from the [latest release](https://github.com/hongfaqiu/strata-manager/releases/latest) or the [website download section](https://strata-manager.cosfoc.com/en/#get-started). Install only files listed for the selected release.

| Platform | Package | Setup |
| --- | --- | --- |
| **Windows x64** | NSIS installer (`.exe`) | Requires WebView2. [Windows installation](docs/DOWNLOAD.en.md#install-on-windows). |
| **Linux x64** | AppImage or DEB | Built in Ubuntu 22.04 CI. [Linux installation and support scope](docs/DOWNLOAD.en.md#install-on-linux). |
| **Linux x64 headless server (experimental)** | `Strata.Manager.Server_<version>_amd64.tar.gz` or `.deb` | For servers without a desktop; use it in a browser. Not covered by the desktop auto-updater. [Server guide](docs/SERVER.en.md). |
| **macOS Apple Silicon** | DMG (experimental) | Un-notarized CI package when a release lists it. The DMG has no engine; the app can download and verify the upstream prebuilt Metal engine package (preview: startup and inference not yet validated on real Mac hardware). Intel not packaged. [macOS notes](docs/DOWNLOAD.en.md#macos-apple-silicon-experimental). |

1. **Prepare the runtime.** Open Strata to inspect an existing installation, or follow Getting started. An existing supported runtime does not need reinstalling.
2. **Choose a model and configuration.** My models lists discovered weights. Add a search directory when needed, select a configuration, or download new weights.
3. **Choose Use.** Follow environment checks and loading until Model ready, then chat or copy the local API address into another application.

The desktop installer contains Manager and its background process. Hardware and driver requirements depend on Strata and the model. Published stable installers target Windows x64 and Linux x64. macOS Apple Silicon DMGs are **experimental** (ad-hoc signed, not notarized); the DMG alone does not provide Metal inference. The app can install the upstream prebuilt Metal engine package (preview; not yet validated on real Mac hardware), or you can build it with upstream `./setup.sh`. Intel Macs are not packaged. Detailed steps and package limitations are in the [download guide](docs/DOWNLOAD.en.md); everyday use is covered in the [user guide](docs/USER_GUIDE.en.md).

## Explore the workspace

| Models and configurations | Hardware and inference monitoring |
| --- | --- |
| [![Models — machine capacity, local weights and the memory each configuration needs](docs/screenshots/models.en.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/models.en.webp) | [![Monitor — service, hardware and request activity](docs/screenshots/monitor.en.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/monitor.en.webp) |

| Getting started guide | Old-version configuration cleanup | Benchmark leaderboard |
| --- | --- | --- |
| [![Getting started guide: environment, Strata, model choice filtered by this computer's memory, download and first chat](docs/screenshots/onboarding.en.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/onboarding.en.webp) | [![Old-version configuration cleanup: run configurations grouped by Strata version, archived restorably](docs/screenshots/config-cleanup.en.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/config-cleanup.en.webp) | [![Benchmark leaderboard: the same model and quantization compared across hardware, with filters, sorting, parameters and recommendations](docs/screenshots/arena.en.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/arena.en.webp) |

<details>
<summary><strong>More interfaces: runtime, chat, shared settings, connections, updates, benchmarking and monitoring</strong></summary>

**Strata — runtime versions and updates**

[![Strata runtime, this computer's devices and updates](docs/screenshots/runtime.en.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/runtime.en.webp)

**Configuration — graphical controls and JSON**

[![Runtime configuration: launch parameters and editor](docs/screenshots/config.en.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/config.en.webp)

**API usage — requests, tokens and cache trends**

[![API usage charts](docs/screenshots/usage.en.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/usage.en.webp)

**Chat — conversations, streaming and attachments**

[![Chat workspace](docs/screenshots/chat.en.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/chat.en.webp)

**Tuning — compare tasks and candidates**

[![Tuning workspace](docs/screenshots/tuning.en.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/tuning.en.webp)

**Benchmark — context tiers and historical conditions**

[![Context benchmark workspace](docs/screenshots/benchmark.en.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/benchmark.en.webp)

[![Historical benchmark condition comparison](docs/screenshots/daily-experience/history-comparison.en.webp)](docs/screenshots/daily-experience/history-comparison.en.webp)

**Settings and About**

[![Language, appearance and background settings](docs/screenshots/settings.en.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/settings.en.webp)

[![Project information and credits](docs/screenshots/about.en.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/about.en.webp)

**Shared chat defaults — per-model inheritance**

[![Shared generation parameters and per-model inheritance](docs/screenshots/common-chat-settings.en.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/common-chat-settings.en.webp)

**Connections — API and external assistants**

[![Connection targets, application access keys, API examples and MCP](docs/screenshots/connections.en.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/connections.en.webp)

**Application updates — bilingual notes and installation confirmation**

[![Dedicated application update page](docs/screenshots/app-updates.en.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/app-updates.en.webp)

**Service status — recent generation and input-processing trends**

[![Service status panel and recent trends](docs/screenshots/service-status.en.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/service-status.en.webp)

**Independent desktop monitor — closed by default**

[![Floating monitor with the current two-row telemetry layout](docs/screenshots/floating-monitor.en.webp)](https://raw.githubusercontent.com/hongfaqiu/strata-manager/main/docs/screenshots/floating-monitor.en.webp)

[![Floating monitor visibility, layouts, metrics and appearance settings](docs/screenshots/floating-monitor-settings.en.webp)](docs/screenshots/floating-monitor-settings.en.webp)

</details>

## Common questions

**Will closing the window stop the API?** Closing to the tray is enabled by default, so a running service remains available. Disable it to stop managed services and exit on close, or use Stop services and quit from the tray.

**Does releasing model memory delete the model?** No. It releases RAM/VRAM while retaining model files and the API process. Removing a saved configuration also preserves the original weights.

**Is everything offline?** Chats and usage records are stored locally. Downloads and updates use the network; configured MCP tools may contact external services. Review tools before enabling them and remove private content before sharing diagnostics.

For API connections, diagnostics and tuning limits, see the [user guide](docs/USER_GUIDE.en.md). Report problems in [Issues](https://github.com/hongfaqiu/strata-manager/issues).

<details>
<summary><strong>Build from source</strong></summary>

Use Node.js **22.13+**, pnpm **11.21.0** and Rust stable. Windows requires MSVC C++ Build Tools, Windows SDK and WebView2; Linux dependencies are listed in [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
git clone https://github.com/hongfaqiu/strata-manager.git
cd strata-manager
pnpm install --frozen-lockfile
pnpm desktop
```

Maintainers can refer to [development](docs/DEVELOPMENT.md), [release](docs/RELEASING.md) and [verification](docs/VERIFICATION.md) records.

</details>

## Credits and license

Built on [Niko1221/Strata](https://github.com/Niko1221/Strata). Thank you to the upstream author and contributors. Strata Manager is an independent community desktop application.

Strata Manager uses [MIT](LICENSE); reused resources retain upstream attribution. The bundled Outfit font uses SIL OFL 1.1. See [third-party notices](THIRD_PARTY_NOTICES.md). Model weights retain their providers' licenses.

## Friends

- [LINUX DO](https://linux.do)
