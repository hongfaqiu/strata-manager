# Strata Manager user guide

[Website](https://hongfaqiu.github.io/strata-manager/?lang=en) · [Product overview](../README.md) · [Documentation](README.en.md) · [简体中文](USER_GUIDE.md)

[Download and try](DOWNLOAD.en.md) · [Troubleshooting](TROUBLESHOOTING.en.md) · [Support scope](DOWNLOAD.en.md#support-scope)

Strata Manager is an open-source desktop app for local model management. Import or prepare supported local Strata installations, manage configurations, start and load services, chat, monitor activity, and connect other software to your local API in one workspace. Existing model weights stay in place. Available models, image input, reasoning, MCP tools and API protocols depend on the installed Strata runtime and chosen model.

Start with **Models → My models**, select **Use**, wait for **Model ready**, then open **Chat** or copy the displayed local API address. Manager manages installations prepared or imported on this computer; it does not manage remote nodes.

## Prepare or reuse a model

**Already used an earlier Manager version?** Valid model profiles and conversations are restored automatically. Review My models before starting a new preparation; existing weights do not need to be downloaded again.

**Already have Strata elsewhere on this computer?** Use detection and import. If it is not found, select the Strata folder. Import checks source, Python, model files and configuration. Model files stay where they are; the original configuration is retained and Manager uses a managed copy. Resolve any ambiguous configuration when prompted.

A running installation owned by another program must pass identity and activity checks before takeover. Unknown or busy processes are not forcibly stopped. Read the displayed reason if an installation needs repair or cannot be imported.

**Starting fresh?** Use automatic preparation. Manager downloads a fixed official Strata source revision, verifies its SHA256 and prepares a private environment in its own data directory. The normal path does not require Git or a manually entered Python path.

- Windows uses a suitable 64-bit Python 3.10+ when available. Otherwise, it can prepare a verified official Python installer for a private installation. Executing this fallback still needs acceptance on a clean machine without Python.
- Linux needs Python 3.10+, venv and ensurepip. Crash containment also needs a 64-bit Linux 5.9+ environment that permits pidfd, clone and close_range; managed child startup is refused when these are unavailable. Missing system dependencies produce instructions; Manager does not run sudo. Complete automatic preparation still needs real Linux acceptance.

Then choose from the preparation catalog, selecting the available quantization, context and image options for that model. Strata's setup prepares the engine and weights. The catalog follows the reviewed runtime; it is not an installer for every model or arbitrary GGUF file. Model downloads may be large: check free disk space, RAM, VRAM and driver requirements against the [Strata documentation](https://github.com/Niko1221/Strata).

Model cards show the actual data destination, free space on each destination disk and estimated additional bytes after counting reusable weights or resumable files. The background checks again before preparation and refuses to start downloads when space is insufficient or unknown. These are estimates from the reviewed installer, not proof of driver, memory or complete dependency readiness. Importing an existing model does not require downloading or reserving room for another full copy of its weights.

Tasks show actual log output and downloaded bytes when available. Cancel a task if necessary, then retry after correcting its error. A completed, verified preparation appears in My models without replacing your current selection. Select **Use** when you are ready to switch.

## Start chatting

Select Use and wait for **Model ready**. A healthy API process and a loaded model are different states; a service that has started may still be loading weights.

Chat includes multiple conversations, streaming replies, Markdown and text attachments. Image input, reasoning controls and MCP tool events require support from the imported or prepared Strata runtime and model; they are not guaranteed for every installation. Use the attachment control or drop a supported file into Chat. Text attachments are limited to 512 KiB per file; images require the service to report image support.

Use the sampling controls for supported request settings. MCP tools also require configured servers with available tools; enabling the option alone does not add a tool or make an unsupported model capable of using it.

Chat sampling settings apply to subsequent requests. **Settings → Runtime configuration** edits the managed configuration file; after saving, actively restart the service from model details to apply file-based changes. Saving alone does not establish that the running service uses the new settings.

Use the stop control to cancel your active reply. Partial content can remain in the conversation. A slow first reply may include loading or prompt processing, especially with a long document; it is not the same measurement as steady answer generation.

MCP servers can execute tools and may contact other systems according to their own configuration. Review the tools you enable and their permissions.

## Connect a local API client

Copy the address shown by Manager rather than assuming a fixed port. Select the API supported by your client and runtime:

| Client protocol | Typical API path |
| --- | --- |
| OpenAI Chat Completions | `/v1/chat/completions` |
| OpenAI Responses | `/v1/responses` |
| Anthropic Messages | `/v1/messages` |

For an OpenAI-compatible client, the base URL commonly includes `/v1`; follow that client's URL convention to avoid duplicating the path. Use the configured API key if the runtime requires one. Endpoint support depends on the installed Strata version.

Keep the client timeout long enough for model loading and lengthy prompts. Check readiness and the current address before changing client settings. Manager's local-only scope does not provide remote-node management.

## Window, background and startup

An independent background process manages imported or prepared services. Reopening the desktop app reconnects to the background for the same user.

Closing the window, quitting the interface and stopping services are separate actions. Closing the window keeps an already running API service available. To release the model and stop managed services, use the tray's **Stop services and quit** action.

Settings provides:

- **Launch on login:** start the background without first opening Chat.
- **Prepare at startup:** choose early preparation instead of the default lightweight, on-demand policy.
- **Service recovery:** enable up to three recovery attempts after the selected, managed service exits. Repeated failures surface a repair state rather than an endless restart loop. This does not promise automatic recovery from every API failure or stalled process.

See [support scope](DOWNLOAD.en.md#support-scope) for current platform and usage limits. Linux containment requires the environment described above and covers descendants that stay in the managed process group; it does not establish cleanup of every MCP tool that creates its own session.

## Read background health

Overview shows a **Background health check** for the current running service owned by Manager. A live process, a healthy API and a loaded model are separate states.

| Status | What to do |
| --- | --- |
| API healthy | Check the separate model-loading status before chatting. |
| Verifying an API failure | Wait for a fresh result and inspect diagnostics if it persists. |
| Repeated API failures | The current process is preserved. Inspect diagnostics and decide whether to retry or stop it. |
| Busy or under maintenance; check deferred | Let the active request, loading or maintenance finish. |
| Full state not yet verified / waiting for a fresh check | Treat the result as unknown rather than healthy or failed. |

Health checks defer while verified work or maintenance is active. Repeated failures while idle are reported; the check itself does not stop or restart a process. The service-recovery setting is a separate policy for a managed service that exits, with bounded attempts as described above.

## Read API usage

API usage shows today, the last 24 hours or the last 7 days. Today uses your local timezone. Metadata is retained for **90 days** and collection continues in the background when the usage page is closed.

| Measurement | Meaning |
| --- | --- |
| HTTP requests | Incoming API requests, including failures and token-count requests |
| Inference runs | Model work performed within a request; one tool-assisted request can include several runs |
| Tool calls | MCP/tool activity counted separately from HTTP requests and model runs |
| HTTP token usage | Usage reported for the API response |
| Inference workload | Token work across observed runs; do not add it to HTTP usage as a total |
| First-output latency | Waiting time to the first observed output |
| Total duration | Time observed for the complete request |
| Decode speed | Output-generation rate where enough timing information is available |
| Cache reuse | Reported reuse; a repeated prefix can behave differently from a fresh prompt |

Success rate uses completed requests; unfinished requests are excluded. Failures, cancellations and interruptions are distinct outcomes. Missing counters stay **unknown**, not zero. Source labels are unknown when the client supplies no identifiable label.

Check collection state and coverage before interpreting a quiet chart. Older or modified runtimes may not be supported, and collection gaps are labeled. Metadata from before observation began cannot be reconstructed as complete usage history. Large model loads, long prompts and tool calls can explain latency without indicating a service fault.

Request history supports custom times, client, actual model, outcome and time order, with pagination. Pages keep the same boundary for newly ingested records until refreshed; an active request can still acquire its final status. Older records without an observed model remain unknown rather than being assigned the current model.

CSV export opens the system save dialog and exports metadata matching the current range and filters. Each export allows at most 5,000 rows; narrow the range or filters for larger results. Cancelling the dialog writes no file. Prompts, responses, reasoning, tool arguments and keys are excluded.

## Local storage and privacy

Usage analytics records metadata without prompts, responses, reasoning, attachments, tool arguments or API keys. Chat history and attachments are stored separately on your computer; metadata-only collection does not mean the app stores no conversation content.

The official API Monitor's **request-body capture** is a separate diagnostic feature. An imported configuration may already have it enabled. Check that setting before sending sensitive content; API usage collection does not require it.

Runtime and model downloads, update checks, and configured MCP tools can make network requests. Local inference does not make every enabled integration offline. Keep API keys and diagnostic exports private, and review exports or logs before sharing them.

## Compare tuning results

Automatic comparison currently covers **PCIe budget** and **MTP speculation threshold** request parameters. Choose the implemented **Short chat**, **Code generation** or **Long Chinese response** scenarios, a repeat count and an output limit, then start measurement. Manager measures limited candidates in **baseline A → candidate B → restored A** order. Fresh prompts and immediately repeated prefixes are measured separately to reveal cache effects.

The comparison temporarily occupies the model; other requests may wait or report busy. Measurements preserve the current configuration. Stop the comparison with its cancel control when needed; cancellation affects the comparison's own request. Applying a recommendation is a separate action that restarts the managed service.

Review duration, first-output latency, decode speed, caching and output consistency together. A recommendation requires a benefit greater than the measured baseline drift; unstable results do not justify a change.

Consistency checks require complete, identical deterministic outputs. Code also checks `merge_sorted(a,b)` against empty lists, duplicates, negative numbers, unequal lengths and fixed randomized inputs, including preservation of the input lists. Only a limited Python syntax for this task is supported; generated Python is not executed and unsupported forms cannot qualify for a recommendation. Old Code reports remain readable and already applied settings can be restored when their configuration and identity checks pass; applying them again requires a new measurement. These probes do not replace a full Agent workload, general code-quality evaluation, vision, long-context quality, session recovery or cold-load testing. Context, KV and startup configuration are not included in this automatic comparison and need separate capacity and quality checks.

Applying a result saves a recovery record, restarts the owned service and checks model loading. If application fails, Manager attempts to restore the original configuration and service. Recovery can also fail; follow the displayed diagnostics, repair the cause and prepare the model again rather than assuming it is available. Applying or restoring parameters briefly affects the local API; avoid concurrent maintenance and active client work during these actions.

Controlled tests validate the comparison and recovery workflow. Real speed improvements need a report from the actual model, hardware and workload. Screenshot metrics and demonstration timing are not GPU benchmarks.

## Application updates

Settings can automatically check and download updates when the app opens and every 12 hours. Choose when to install the downloaded update, or disable automatic downloading and check/download manually. Failed downloads preserve the current app and can be retried. Downloading does not stop the local API; explicit installation checks that the background can update safely. Downloads show received bytes; a total is shown only when known. The updater uses the embedded public key to verify official Tauri signatures.

Preview v0.1.0-beta.2 is available for manual installation. Download the [Windows installer](https://github.com/hongfaqiu/strata-manager/releases/download/v0.1.0-beta.2/Strata.Manager_0.1.0-beta.2_x64-setup.exe), [AppImage](https://github.com/hongfaqiu/strata-manager/releases/download/v0.1.0-beta.2/Strata.Manager_0.1.0-beta.2_amd64.AppImage) or [DEB](https://github.com/hongfaqiu/strata-manager/releases/download/v0.1.0-beta.2/Strata.Manager_0.1.0-beta.2_amd64.deb) and compare [SHA256SUMS](https://github.com/hongfaqiu/strata-manager/releases/download/v0.1.0-beta.2/SHA256SUMS). Previews do not replace the stable `latest` update channel. Settings checks the stable update source; finding no beta update does not establish that the latest preview is installed.

Application, Strata runtime and model weights are separate. Updating Manager does not normally require another model-weight download. Read the version's release notes for restart and recovery behavior.

See [Download and try](DOWNLOAD.en.md) for versions, packages and the current support scope.

Tauri update signatures are separate from Windows Authenticode publisher signing. The project does not currently have a Windows publisher certificate; follow the download guide when your system displays an installation warning.

## Update the Strata runtime

Use **Models → Details and management → Check and update Strata** and follow the task progress after confirming. The background prepares a reviewed version, private Python environment and engine in a new directory, reusing the original model and tokenizer. The original installation and configuration are retained. Preparation does not intentionally stop the current API; switching waits for active work and briefly closes admission to new requests. If candidate checks fail or the update is cancelled after switching begins, Manager attempts to restore the previous registration and loaded state. Recovery can fail and will be reported in the task; follow its diagnostics before retrying or preparing the original model.

The current candidate is fixed to Strata 0.1.41, rather than automatically following upstream latest. Hash-checked engine archives target Windows x64; a missing Linux release archive is reported without replacing the existing install. External startup hooks or ambiguous configuration semantics are rejected before stopping the service. Complete candidate preparation and a real GPU update have not passed acceptance; source/archive checks and controlled recovery tests cover only their stated scope. Actual GPU, driver and model compatibility still require real acceptance evidence.

## Common questions

**My installation was not found.** Select its Strata folder and read the detection reason. Verify the source, Python environment, configuration and model files before attempting import.

**Do I have to download the model again?** No, valid existing installations can be imported and earlier Manager profiles restored. Only choose new model preparation when you need additional weights.

**The API is up, but Chat cannot answer.** Check Model ready, task logs and available memory. Loading on demand can delay the first request. Avoid starting another large GPU workload during loading.

**Another application cannot connect.** Check the copied loopback address, API path, model readiness, key and timeout. A client that cannot reach local services may have its own network restrictions.

**The app refuses to take over a running installation.** Read the identity or activity diagnostic. Wait for active work to finish; an unverified process is not stopped merely because it occupies the expected port.

**Usage is empty or has unknown values.** Check collection state, runtime compatibility and coverage. Missing observation is different from zero usage.

**Tuning did not find an improvement.** Keep the current settings if gains are not repeatable. Compare complete tasks with your own workload; cache state and background activity can affect results.

**The window closed, but GPU memory is still used.** An active background service can keep the model loaded. Use Stop services and quit when you want to release it.

**An update check or download fails.** Read the displayed error and retry when the network or release source is available. The current application remains installed. Check [Download and try](DOWNLOAD.en.md) for release availability and [Troubleshooting](TROUBLESHOOTING.en.md) for the next steps.

## Screenshots and project credits

The README images show the actual App rendered with isolated in-memory RPC example data. Model status, metrics and chat content are examples; their source is disclosed outside the images in the README and website. The cover combines those screens. Neither the screenshots nor the cover demonstrate inference speed or real API usage.

This independent community application builds on [Niko1221/Strata](https://github.com/Niko1221/Strata) and its official interface. See [MIT](../LICENSE) and [third-party notices](../THIRD_PARTY_NOTICES.md); Outfit uses SIL OFL 1.1, and separately downloaded models retain their own licenses.
