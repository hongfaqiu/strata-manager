# Strata Manager documentation

[Website](https://hongfaqiu.github.io/strata-manager/?lang=en) · [Product overview](../README.md) · [简体中文](README.md)

Strata Manager is a desktop workspace for local inference with Strata. It brings runtime setup, model configurations and service lifecycle together with chat, monitoring, API usage, tuning and Benchmark performance tests. It is an independent community project. Inference capabilities and protocols depend on the installed Strata runtime and chosen model.

## Start here

| What you want to do | Read |
| --- | --- |
| Understand the desktop, background, inference engine and persistence | [System explanation](SYSTEM.en.md) |
| Manage shared chat parameters and connection tools | [Shared settings](USER_GUIDE.en.md#shared-settings-and-model-configuration) |
| Download packages or try source | [Download and try](DOWNLOAD.en.md) |
| Read feature changes and fixes | [Changelog](../CHANGELOG.md) |
| Inspect or install Strata, then choose or prepare a model | [First use](USER_GUIDE.en.md#prepare-or-reuse-a-model) |
| Read Strata versions and release notes, then install a matching Windows x64 ZIP update | [Strata management](USER_GUIDE.en.md#update-the-strata-runtime) |
| Switch configurations and edit graphical controls or JSON inside Models | [Runtime configuration](USER_GUIDE.en.md#runtime-configuration) |
| Connect a local API client | [API connections](USER_GUIDE.en.md#connect-a-local-api-client) |
| See recent status trends or open the independent desktop monitor | [Service status and monitoring](USER_GUIDE.en.md#read-background-health) |
| Read request history, statistics and CSV exports | [API usage](USER_GUIDE.en.md#read-api-usage) |
| Run context tiers or scenarios serially, compare conditions and export reports | [Benchmark](USER_GUIDE.en.md#benchmark) |
| Understand background services, health, tuning and updates | [Complete user guide](USER_GUIDE.en.md) |
| Resolve preparation, connection or update problems | [Troubleshooting and feedback](TROUBLESHOOTING.en.md) |

## Supported scope

- Manage Strata centrally on this computer and list discovered supported models and configurations directly. Existing weights stay in place; releasing memory does not delete them.
- New models can inherit shared chat defaults; existing models keep saved custom parameters. Configure connection targets, application access keys, API examples and MCP together in API and external assistants.
- Windows engine ZIPs default to official downloads, support saved mirrors and resume interrupted transfers, and match the current CUDA12, CUDA13 or HIP engine across sources. Complete files still undergo official size and SHA256 checks.
- The status panel shows recent generation and input-processing trends with gaps. The independent desktop monitor is closed by default and observes an existing background read-only, without starting the background or models.
- Updates are checked automatically by default, with release notes and confirmation before installation. Closing to the tray is enabled by default; disabling it stops managed services when exiting.
- Image input, reasoning, MCP tools and API protocols depend on the runtime, model and tool configuration.
- Tuning compares request parameters and supported restart candidates in complete use-case workloads, with quality and resource checks; it does not promise a fixed speedup.
- Benchmark supports seven scenarios, fixed concurrency and ramp-up stress tests. It records latency, generation rates, caching and resource trends, with JSON / CSV reports.
- Published installers currently target Windows/Linux x64. macOS (Apple Silicon) packages are in progress: CI produces an ad-hoc-signed DMG and an updater `.app.tar.gz` for a later version tag. Intel packages are not built, and upstream Strata Metal installs are not discovered yet. Release packages, GPU use, real Linux systems, Mac hardware and cross-version updates are verified separately. Screenshots and controlled fixtures do not establish real-model acceptance.

Public installers: [Latest stable release](https://github.com/hongfaqiu/strata-manager/releases/latest) · [Website downloads](https://hongfaqiu.github.io/strata-manager/en/#get-started). Download only listed assets and check the matching SHA256SUMS. [Download instructions](DOWNLOAD.en.md) explain installation and current support scope. Stable releases use `latest`; previews remain manual downloads and do not replace that channel.

## License and credits

- [MIT license](../LICENSE)
- [Third-party notices](../THIRD_PARTY_NOTICES.md)
- [Upstream Strata](https://github.com/Niko1221/Strata)

Source and maintenance material remain in the [GitHub repository](https://github.com/hongfaqiu/strata-manager).

## Feedback

Follow the [troubleshooting steps](TROUBLESHOOTING.en.md), then submit reproduction details through the guided [issue form](https://github.com/hongfaqiu/strata-manager/issues/new/choose).
