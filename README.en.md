# Strata Manager

[简体中文](README.md) · [Downloads](https://github.com/hongfaqiu/strata-manager/releases) · [Original Strata project](https://github.com/Niko1221/Strata)

A desktop workspace for local Strata models: detect and import installations, prepare runtimes and models, keep the local API available, chat, inspect usage, and compare measured tuning results. Built with Tauri 2, with Simplified Chinese and English interfaces. It retains the official Strata component style within a shared header, collapsible sidebar, and nested management layout.

**The first release is still being verified.** Scoped Windows checks cover background lifecycle, metadata analytics, preparation without Git, and the tuning workflow. Linux, executing the Python installer on a machine without Python, a real logout/login, and installation through a signed version update still require acceptance. See [release notes](https://github.com/hongfaqiu/strata-manager/releases) and the [verification record](docs/VERIFICATION.md).

## Download and requirements

Download the matching file from [Releases](https://github.com/hongfaqiu/strata-manager/releases):

| System | Package | Current scope |
| --- | --- | --- |
| Windows x64 | `*-setup.exe` | Requires WebView2. Scoped local checks are complete; installer and update acceptance are tracked separately. |
| Linux x64 | `*.AppImage` or `*.deb` | The pipeline targets Ubuntu 22.04. Linux installation, background lifecycle, and GPU inference have not been accepted on a real system. |

Installers include the desktop application and independent background process, but no large model weights. CPU/GPU, RAM, VRAM, and driver requirements depend on your model and the [upstream documentation](https://github.com/Niko1221/Strata). Release targets are Windows/Linux x64; macOS and ARM are currently unsupported.

## First use

1. **Open the app and wait for automatic detection.** It checks local installations and the environment. Import an existing Strata installation if one is found; select its folder only if detection misses it. Model files stay in place, the original configuration is retained, and the application uses a managed copy.
2. **Prepare the environment automatically if you have no installation.** The app downloads a fixed official source revision into its own data directory, verifies it, detects usable Python, and creates a private environment. The normal workflow needs no Git, manually entered Python path, or chosen installation directory.
3. **Choose and prepare a model.** Follow the setup steps for model, quantization, context, and image support. Existing models can be imported with a local installation; Strata's official setup prepares new ones. Actual logs explain progress and errors. Tasks can be cancelled or retried; first-time weight downloads can take a while.
4. **Wait for “Model ready,” then chat.** The application handles service startup and loading after import and preparation. You do not need to run a startup script or enable a process-management switch. Chat contains conversation history, attachments, reasoning, MCP tools, and sampling settings.
5. **Copy the local API address when connecting another application.** Use the displayed address and API path in your client. Chat Completions, Responses, and Anthropic Messages support depends on the installed Strata runtime.

Windows detects 64-bit Python 3.10+. If none is usable, it provides an SHA256-verified official Python installer for a private installation; execution of that fallback still requires clean-machine acceptance. Linux needs Python 3.10+, venv, and ensurepip. Missing system dependencies produce actionable instructions; the app does not run sudo. The completed Windows no-Git test used existing Python and created a real private venv.

The application manages only **local Strata installations it installed or imported**, without remote nodes or arbitrary service addresses. A running instance owned by another program must pass identity and activity checks; unidentified or busy processes are not forcibly stopped.

## Daily use

| Screen | Purpose |
| --- | --- |
| Overview | Model readiness, next actions, background state, and key usage information |
| Models | Automatic preparation, detection/import, download tasks, and local model switching |
| Chat | Multiple conversations, streaming, text/image attachments, reasoning, MCP, and sampling |
| Tuning | Measure candidates, compare results, apply a choice, or restore the original settings |
| Monitor | API usage, official performance monitoring, optional request-body inspection, and task logs |
| Settings | Chinese/English, theme, background policy, login startup, app updates, and runtime configuration |

**Closing the window keeps an already running API service available through the independent background process.** Closing the window, quitting the interface, and stopping services are separate actions. Use the tray's “Stop services and quit” action to release the model and stop managed services. Reopening the app reconnects to the existing background process for the same user.

The background defaults to lightweight operation, with model loading on first request; select preloading in Settings when you need it ready sooner. Login startup launches the background without first opening Chat. Startup configuration is implemented; a real logout and login still need acceptance.

## API usage and privacy

“Monitor → API usage” shows today, the last 24 hours, or the last 7 days: request trends, success rate, failures/cancellations/interruptions, input/output tokens, cache reuse, first-output latency, total duration, decode speed, MCP calls, and recent requests. Today follows your local timezone; request metadata is retained for 90 days. Collection continues in the background when the monitoring page is closed.

HTTP requests, inference runs, and tool calls are separate counters. One MCP request may include multiple inference runs; token-count requests count only as HTTP requests. HTTP usage and inference work are shown separately and must not be added as total token usage. Success rate excludes unfinished requests. Missing counters remain unknown; gaps, unsupported runtimes, and collection state are labeled. Clients without identifiable labels appear as unknown sources.

Usage analytics stores metadata only, without prompts, responses, reasoning, attachments, tool arguments, or API keys. Chat history is stored separately on your computer. The official API Monitor's body capture is a separate diagnostic feature; an imported configuration may already enable it. Check that setting as needed; metadata collection does not require body capture.

## Measured tuning

Choose a use case and start a comparison. The application measures limited candidates in **baseline A → candidate B → restored A** order, separating distinct prompts from immediately repeated prefixes. Reports include duration, first-output latency, speed, caching, and output consistency. A benefit must exceed the measured baseline drift; unstable results do not produce a recommendation.

Current checks accept only complete, identical deterministic test outputs. They verify consistency and workflow, not a full Agent workload, semantic quality, vision, long-context quality, or cold loading. Automatic tuning currently tests limited request-level settings. Context, KV, and startup settings still require capacity and quality checks.

Applying a result saves a recovery record, restarts the owned service, and checks loading; a failure restores the original configuration. Applying briefly affects the local API, so avoid concurrent maintenance. Controlled fixtures cover comparison, cancellation, application, and rollback. GPU benefits require a report for the actual model and hardware.

## Updates

Check for application updates in Settings. Official updates use the embedded public key to verify Tauri update signatures. Signing configuration and release workflows are prepared; downloading and installing a signed version upgrade still requires real acceptance. Tauri update signatures differ from Windows Authenticode publisher signing; this project does not currently claim a Windows publisher certificate.

The application, Strata runtime, and model weights are managed separately. Application updates do not use model re-downloads as their normal workflow. Release notes describe each version's update and recovery scope.

## Screenshots

These locations will receive verified desktop screenshots for the first release, compressed as WebP.

| Overview | Chat | Monitor |
| --- | --- | --- |
| ![Overview](docs/screenshots/overview.zh.webp) | ![Chat](docs/screenshots/chat.zh.webp) | ![Monitor](docs/screenshots/monitor.zh.webp) |

## FAQ

**My installation was not found.** Select the Strata folder from detection. The app needs verifiable source, Python, configuration, and model files; diagnostics explain missing items.

**The service started but the model cannot be used.** API startup and model loading are separate stages. Wait for model readiness and inspect tasks/logs. With loading on demand, the first request can take longer.

**An external client cannot connect.** Copy the current loopback address and API path, check model state and client timeouts, and use the matching API key if configured.

**Analytics has no data or unknown values.** Check collection state and compatibility. Unknown does not mean zero; older or modified runtimes may lack complete observation support.

**Tuning did not improve speed.** Hardware, model, caching, and workload affect results. Keep the current settings when gains are not repeatable, and test complete tasks with your actual workload.

## Build from source

Requirements: Node.js **22.13+** (CI uses 24), the pinned pnpm 11 version, and Rust stable. Windows also needs MSVC C++ Build Tools, Windows SDK, and WebView2. See [Tauri's official prerequisites](https://v2.tauri.app/start/prerequisites/) for Linux packages.

```sh
pnpm install --frozen-lockfile
pnpm desktop       # Prepare the background process and start Tauri development
pnpm check         # Types, core/HTTP protocol tests, and frontend build
pnpm native:test   # Rust workspace tests
pnpm bundle        # Build a local installer; official updater artifacts need signing
```

Build the background directly with `node scripts/prepare-sidecar.mjs --profile release`. Use `pnpm dev` for frontend-only development. Browser mode can verify UI and loopback protocols; native installation, process management, and operating-system features require the desktop app.

`apps/desktop` contains the interface and Tauri shell, `apps/supervisor` the background process, `crates/runtime-core` and `crates/local-ipc` runtime management and user-scoped local communication, and `packages/core` shared types/protocols. See the [verification record](docs/VERIFICATION.md) and [release guide](docs/RELEASING.md). Design documents record architectural evolution and do not replace release acceptance.

`node scripts/contract-server.mjs` starts a protocol fixture at `http://127.0.0.1:18091`. It performs no model inference; fixture data is not GPU performance evidence.

## Upstream and licensing

This project integrates [Niko1221/Strata](https://github.com/Niko1221/Strata) and reuses its official frontend design and functionality. Thanks to the original author and contributors. Strata Manager is an independent community desktop application, not an official upstream distribution. Runtimes and model weights are installed separately; model providers determine their model licenses.

This repository uses [MIT](LICENSE). Reused Strata code/interface resources retain MIT attribution and copyright notices. The Outfit font uses SIL OFL 1.1. See [third-party notices](THIRD_PARTY_NOTICES.md).
