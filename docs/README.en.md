# Strata Manager documentation

[Website](https://hongfaqiu.github.io/strata-manager/?lang=en) · [Product overview](../README.md) · [简体中文](README.md)

Strata Manager is a desktop workspace for the Strata runtime and local model services. Runtime installation and matching Windows x64 ZIP engine updates, model configurations and service lifecycle are its core; chat, monitoring, API usage statistics and tuning support that workflow. It is an independent community project. Inference capabilities and protocols depend on the installed Strata runtime and chosen model.

This documentation describes the 0.1.2 source. The [release page](https://github.com/hongfaqiu/strata-manager/releases/tag/v0.1.2) establishes package availability and contents; an unfrozen candidate is not a passing CI result.

## Start here

| What you want to do | Read |
| --- | --- |
| Download packages or try source | [Download and try](DOWNLOAD.en.md) |
| Inspect or install Strata, then choose or prepare a model | [First use](USER_GUIDE.en.md#prepare-or-reuse-a-model) |
| Read Strata versions and release notes, then install a matching Windows x64 ZIP update | [Strata management](USER_GUIDE.en.md#update-the-strata-runtime) |
| Switch configurations and edit graphical controls or JSON inside Models | [Runtime configuration](USER_GUIDE.en.md#runtime-configuration) |
| Connect a local API client | [API connections](USER_GUIDE.en.md#connect-a-local-api-client) |
| Read request history, statistics and CSV exports | [API usage](USER_GUIDE.en.md#read-api-usage) |
| Understand background services, health, tuning and updates | [Complete user guide](USER_GUIDE.en.md) |
| Resolve preparation, connection or update problems | [Troubleshooting and feedback](TROUBLESHOOTING.en.md) |

## Supported scope

- Manage Strata centrally on this computer and list discovered supported models and configurations directly. Existing weights stay in place; releasing memory does not delete them.
- Updates are checked automatically by default, with release notes and confirmation before installation. Closing to the tray is enabled by default; disabling it stops managed services when exiting.
- Image input, reasoning, MCP tools and API protocols depend on the runtime, model and tool configuration.
- Tuning compares request parameters and supported restart candidates in complete use-case workloads, with quality and resource checks; it does not promise a fixed speedup.
- Current targets are Windows/Linux x64. Release packages, GPU use, real Linux systems and cross-version updates are verified separately. Screenshots and controlled fixtures do not establish real-model acceptance.

v0.1.2 release entry: [Windows installer](https://github.com/hongfaqiu/strata-manager/releases/download/v0.1.2/Strata.Manager_0.1.2_x64-setup.exe) · [AppImage](https://github.com/hongfaqiu/strata-manager/releases/download/v0.1.2/Strata.Manager_0.1.2_amd64.AppImage) · [DEB](https://github.com/hongfaqiu/strata-manager/releases/download/v0.1.2/Strata.Manager_0.1.2_amd64.deb) · [SHA256 checksums](https://github.com/hongfaqiu/strata-manager/releases/download/v0.1.2/SHA256SUMS). [Download instructions](DOWNLOAD.en.md) explain installation and current support scope. Stable releases use `latest`; previews remain manual downloads and do not replace that channel.

## License and credits

- [MIT license](../LICENSE)
- [Third-party notices](../THIRD_PARTY_NOTICES.md)
- [Upstream Strata](https://github.com/Niko1221/Strata)

Source and maintenance material remain in the [GitHub repository](https://github.com/hongfaqiu/strata-manager).

## Feedback

Follow the [troubleshooting steps](TROUBLESHOOTING.en.md), then submit reproduction details through the guided [issue form](https://github.com/hongfaqiu/strata-manager/issues/new/choose).
