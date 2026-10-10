# Troubleshooting and feedback

[Documentation](README.en.md) · [User guide](USER_GUIDE.en.md) · [Download and try](DOWNLOAD.en.md) · [简体中文](TROUBLESHOOTING.md)

Identify the stage first: preparation, API startup, model loading, chat, usage collection, tuning or updates. A running API is not proof that the model has loaded, and an empty chart is not proof that no requests occurred.

## Check these first

1. **Overview:** check the selected model, readiness and background health.
2. **Tasks, Tuning and Settings:** use Tasks for preparation and runtime-update status/errors, Tuning for measurement reports/errors, and Settings for application updates. Let the operation finish before retrying, and avoid concurrent maintenance.
3. **Model details and runtime configuration:** confirm the service address, installation directory and managed configuration. Use identity diagnostics for import problems; an occupied port alone does not establish ownership.

## Preparation and import

| Symptom | Next step |
| --- | --- |
| Installation not detected | Select its Strata folder and follow diagnostics for source, Python, configuration, weights and tokenizer files. |
| Weights exist, but preparation is suggested | Check My models and import the existing installation first. Bare weights may lack a runnable Strata configuration. |
| Disk preflight is insufficient, unknown or failed | Check the actual destination disk/path, free space and refresh. A new preparation cannot proceed before preflight is ready. |
| Downloads or dependencies fail | Read the failed download/dependency log, check network, proxy and directory access, then retry after correcting the cause. |
| Multiple configurations found | Select a configuration matching the real weights. An unverified file is not a completed model. |
| Running installation cannot be taken over | Let active work finish and read identity diagnostics. Unknown or busy processes are not forcibly stopped. |
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
| GPU memory remains used after closing | A background service may keep its model loaded. Use Stop services and quit to end managed services. |

## Usage, tuning and updates

| Symptom | Next step |
| --- | --- |
| No usage data | Check service ownership, observer collection and the chosen time range. |
| Unknown values or coverage gaps | Check compatibility and coverage. Missing observations and time before collection cannot become complete history. |
| CSV exceeds 5,000 rows | Narrow the time range or filters. Cancelling the save dialog writes no file. |
| Tuning is busy or finds no benefit | Finish Chat and external requests. Keep existing settings when gains are not repeatable. |
| Applying tuning or update recovery fails | Preserve task diagnostics, correct configuration, environment or loading errors, then retry. Do not assume the original service recovered. |
| App update check/download fails | Check network and published releases, keep the current app and retry. A downloaded update still needs explicit installation. |
| Strata update is unavailable | Check the fixed candidate, platform engine package and configuration diagnostics. Complete candidate downloads and GPU updates still need actual acceptance. |

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
