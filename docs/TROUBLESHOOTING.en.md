# Troubleshooting and feedback

[Documentation](README.en.md) · [User guide](USER_GUIDE.en.md) · [Download and try](DOWNLOAD.en.md) · [简体中文](TROUBLESHOOTING.md)

This page describes the current source; published betas have their own release notes. Identify the stage first: Strata installation/update, model preparation, API startup, model loading, chat, usage collection or tuning. A running API is not proof that the model has loaded, and an empty chart is not proof that no requests occurred.

## Check these first

1. **Overview:** check the selected model, readiness and background health.
2. **Strata, Tasks, Tuning and Settings:** use Strata for runtime versions, update packages and logs, Tasks for preparation/update errors, Tuning for measurement reports, and Settings for application updates. Let the operation finish before retrying, and avoid concurrent maintenance.
3. **My models and Runtime configuration:** confirm the current model/configuration marker, service address and installation directory, then open graphical/JSON configuration inside Models. Use identity diagnostics for takeover problems; an occupied port alone does not establish ownership.

## Preparation and import

| Symptom | Next step |
| --- | --- |
| Installation not detected | Add its search directory in My models, inspect the runtime in Strata, and follow source, Python, config, weight and tokenizer diagnostics. |
| Weights exist, but preparation is suggested | My models directly lists discovered models. Add a missing directory and check configurations; bare weights may lack a runnable config. Runtime and weight failures are separate. |
| Disk preflight is insufficient, unknown or failed | Check the actual destination disk/path, free space and refresh. A new preparation cannot proceed before preflight is ready. |
| Downloads or dependencies fail | Read the failed download/dependency log, check network, proxy and directory access, then retry after correcting the cause. |
| Multiple configurations found | Switch configurations within the model card and check paths, modification dates and current/last-used markers. Viewing a configuration does not switch the running service. |
| Running installation cannot be taken over | Let active work finish and read identity diagnostics. Unknown or busy processes are not forcibly stopped. |
| Mac / Linux says "Python 3.10+ is required" | macOS ships Python 3.9. Choose **Install Python** where the message appears, then **Check again** or **Retry installation**. If GitHub is slow, switch the download source to a GitHub proxy; partial downloads are kept. |
| Linux dependencies or containment are unavailable | Follow diagnostics for Python, venv, kernel and system restrictions. Manager does not run sudo or bypass these restrictions. |

Importing an existing model does not require another full weights download. Disk estimates do not establish RAM, VRAM, driver or dependency readiness.

## Chat and API

| Symptom | Next step |
| --- | --- |
| API online, Chat unavailable | Wait for Model ready and inspect loading tasks, logs and memory. Initial loading can take time. |
| External client cannot connect | Check the displayed local address, protocol path, key, readiness and timeout. Some clients cannot reach local services. |
| Images cannot be attached or understood | Confirm the service reports image support. Model and vision-environment capabilities require separate verification. |
| MCP has no tools or fails | Check server connectivity, available tools and runtime support. Inspect the tool's own error and network configuration. |
| Repeated background-health failures | Read diagnostics, await a fresh check or decide whether to retry/stop. Health checks do not promise to forcibly repair a stalled process. |
| GPU memory remains used after closing | Closing to the tray is enabled by default. Release model memory preserves files; Stop services and quit ends managed services. Disable closing to the tray to confirm exit on close. |
| Request viewer is unavailable | Choose 5/15/30-minute temporary capture in advanced diagnostics on a supported, verified and idle managed service. Manage an existing `api_monitor` configuration separately. Usage statistics do not require bodies. |

## Usage, tuning and updates

| Symptom | Next step |
| --- | --- |
| No usage data | Check service ownership, observer collection and the chosen time range. |
| Unknown values or coverage gaps | Check compatibility and coverage. Missing observations and time before collection cannot become complete history. |
| CSV exceeds 5,000 rows | Narrow the time range or filters. Cancelling the save dialog writes no file. |
| Tuning is busy or finds no benefit | Finish Chat and external requests, then review full-use-case quality, resources and baseline drift. Keep existing settings when gains are not repeatable. |
| A restart candidate is rejected | Review support, resource and startup-state diagnostics. VRAM reserve can only increase a known value; unknown effective support is not accepted. |
| Applying tuning or update recovery fails | Preserve task diagnostics, correct configuration, environment or loading errors, then retry. Do not assume the original service recovered. |
| App update check/download fails | Check network and published releases, keep the current app and retry. Release notes require confirmation before automatic installation. |
| Strata update is unavailable | Inspect official releases, matching Windows x64 ZIPs, dependencies and config diagnostics in Strata. Linux provides release information only. Missing platform packages preserve the current installation. |
| ZIP download, extraction or replacement fails | Retain logs and resolve checksum, path, permission or process-identity errors. If recovery fails, repair using diagnostics before retrying; do not assume the service recovered. |

Recovery is bounded and applies after the selected managed service exits. It does not guarantee repair of every API failure, failed update or hardware fault. See the [user guide](USER_GUIDE.en.md) for scope.

## Report a problem

Search [existing Issues](https://github.com/hongfaqiu/strata-manager/issues) first. If no matching report exists, use the guided [bug report form](https://github.com/hongfaqiu/strata-manager/issues/new?template=bug_report.yml) and include:

- OS, app version or source commit, and package/source origin.
- Strata runtime/model identifiers and relevant GPU, RAM/VRAM information.
- Starting step, expected behavior, actual result and a minimal reproduction.
- Task or health errors and the necessary redacted log excerpt or screenshot.

Select a model, then choose **Monitor → Tasks → Export diagnostics**; the log action in model details also opens Tasks. Review files before sharing and remove keys, private paths, personal chats, attachments and tool arguments. Usage metadata and request-body diagnostics are separate.

## Suggest a feature

Use the [feature request form](https://github.com/hongfaqiu/strata-manager/issues/new?template=feature_request.yml) to describe your workflow, the step to improve and the expected result. A suggestion is not an implemented feature; code, documentation and verification establish the available behavior.
