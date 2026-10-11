# Strata Manager user guide

[Website](https://hongfaqiu.github.io/strata-manager/?lang=en) · [Product overview](../README.md) · [Documentation](README.en.md) · [简体中文](USER_GUIDE.md)

[Download and try](DOWNLOAD.en.md) · [Troubleshooting](TROUBLESHOOTING.en.md) · [Support scope](DOWNLOAD.en.md#support-scope)

Strata Manager is an open-source desktop workspace for the Strata runtime and local model services. Runtime installation and matching Windows x64 ZIP engine updates, model configurations, and service startup, shutdown and recovery are its core; chat, monitoring, API usage statistics and tuning support that workflow. It is an independent community project. Inference capabilities, models, image input, reasoning, MCP tools and API protocols come from the installed Strata runtime and chosen model.

This guide describes the 0.1.3 source. The [release page](https://github.com/hongfaqiu/strata-manager/releases/tag/v0.1.3) establishes package availability and contents; an unfrozen candidate still needs final CI and release acceptance. Inspect the runtime in Strata first, then choose a configuration in **Models → My models**, select **Use**, wait for **Model ready**, and open Chat or copy the local API address. Manager manages supported installations on this computer; it does not manage remote nodes.

## Prepare or reuse a model

**Already used an earlier Manager version?** Valid model profiles and conversations are restored automatically, without automatically starting model services. Review My models before starting a new preparation; existing weights do not need to be downloaded again.

**Already have Strata elsewhere on this computer?** Inspect its detected runtime and version in Strata; an existing runtime does not need reinstalling. Missing-model diagnostics are separate from whether Strata exists. My models automatically lists discovered models without requiring import or use first. Add a search directory if detection misses yours.

Configurations using the same model are grouped, with modification dates and current/last-used markers. The active model and configuration remain visible while you browse alternatives. Choose a configuration and select Use: Manager registers a managed configuration and shows environment checks, startup and model loading. Weights stay in place, the original configuration is retained, and the managed service uses a copy.

A running installation owned by another program must pass identity and activity checks before takeover. Unknown or busy processes are not forcibly stopped. Read the displayed reason if an installation needs repair or cannot be imported.

**Starting fresh?** Complete the installation guide in Strata before choosing or downloading a model. Manager downloads and verifies official source and prepares a private environment in its own data directory. The normal path does not require Git or a manually entered Python path. When Strata has already been detected, the repeated installation guide is hidden.

- Windows uses a suitable 64-bit Python 3.10+ when available. Otherwise, it can prepare a verified official Python installer for a private installation. Executing this fallback still needs acceptance on a clean machine without Python.
- Linux needs Python 3.10+, venv and ensurepip. Crash containment also needs a 64-bit Linux 5.9+ environment that permits pidfd, clone and close_range; managed child startup is refused when these are unavailable. Missing system dependencies produce instructions; Manager does not run sudo. Complete automatic preparation still needs real Linux acceptance.

Then open **Models → Download models**, selecting the available quantization, context and image options. Strata's setup prepares the engine and weights. The catalog follows the reviewed runtime; it is not an installer for every model or arbitrary GGUF file. Model downloads may be large: check free disk space, RAM, VRAM and driver requirements against the [Strata documentation](https://github.com/Niko1221/Strata).

Model cards show the actual data destination, free space on each destination disk and estimated additional bytes after counting reusable weights or resumable files. The background checks again before preparation and refuses to start downloads when space is insufficient or unknown. These are estimates from the reviewed installer, not proof of driver, memory or complete dependency readiness. Importing an existing model does not require downloading or reserving room for another full copy of its weights.

Open the separate **Tasks & logs** sidebar menu for preparation, download and update tasks, actual log output and downloaded bytes when available. Use the task's supported cancel or retry action after correcting an error. A completed, verified preparation appears in My models without replacing your current selection. Select **Use** when you are ready to switch.

## Start chatting

Select Use and wait for **Model ready**. A healthy API process and a loaded model are different states; a service that has started may still be loading weights.

Chat includes multiple conversations, streaming replies, Markdown and text attachments. Image input, reasoning controls and MCP tool events require support from the imported or prepared Strata runtime and model; they are not guaranteed for every installation. Use the attachment control or drop a supported file into Chat. Text attachments are limited to 512 KiB per file; images require the service to report image support.

Use the sampling controls for supported request settings. MCP tools also require configured servers with available tools; enabling the option alone does not add a tool or make an unsupported model capable of using it.

Chat sampling settings apply to subsequent requests. File-based startup settings are edited inside Models, as described below.

Use the stop control to cancel your active reply. Partial content can remain in the conversation. A slow first reply may include loading or prompt processing, especially with a long document; it is not the same measurement as steady answer generation.

MCP servers can execute tools and may contact other systems according to their own configuration. Review the tools you enable and their permissions.

## Runtime configuration

Choose a configuration in **Models → My models** and select **Runtime settings** to open the **Runtime configuration** secondary page inside Models. Graphical controls cover context, KV, memory, caching, CPU, prefill, speculation, server, vision, sampling and network settings. Suggested choices also accept custom values. The full argument list and other JSON fields remain editable; use the JSON view to inspect or edit the original structure.

Saves validate JSON and write atomically with a backup. Discovered configurations can be inspected and edited before using a model, without starting it. File-based changes generally require a service restart; saving does not prove the running service uses the new values. A saved service configuration records its name, address, environment and config path; it does not create or copy model weights.

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

An independent background process manages imported or prepared services. Reopening the desktop app reconnects to the background for the same user. Opening the app or signing in starts only the lightweight background, without enabling model services from a saved selection. Enable a model manually from Overview's **Recently enabled** entry or select a configuration and **Use** in My models. A stopped service shows **Not started**, which is not a service failure. Parameter comparisons live in Tuning; task diagnostics have their own **Tasks & logs** menu.

**Minimize to tray when closing the window** is enabled by default and keeps a running API available. Disable it to show an exit confirmation and stop managed services on close. The dialog offers Don't ask again; Settings can re-enable the prompt. Left-click the tray to open the interface, or right-click for service status and shortcuts. **Stop services and quit** ends managed services.

**Release model memory** frees RAM and VRAM while keeping model files and the API process; load it again when needed. **Remove saved configuration** removes Manager's registration while preserving the original configuration and weights. A model that is already loaded does not show a redundant Load button.

Settings provides:

- **Start the background service at sign-in:** start only the local background; enable model services manually.
- **Keep the running model ready:** keep the model loaded after manually enabling its service. When off, configure idle memory release while retaining the API and loading the model on the next use. This does not enable a model when opening the app or signing in.
- **Recover the service automatically:** retry an enabled managed service up to three times after a crash. Deliberately stopped services remain stopped; repeated failures surface diagnostics. This does not promise recovery from every API failure or stalled process.

Cold background startup, legacy registration handoff and app upgrades preserve stopped services. An app or background upgrade attempts to restore a service and its previous model-loading state only when it verified that the managed service was actually running before the switch. A saved selection or registration is not a request to start it. Follow diagnostics if recovery fails; restoring a UI selection does not establish model or API recovery. Strata updating, existing-model load recovery and a short API inference have been tested on one Windows machine. Complete app updates across versions and other environments still require separate acceptance; see the [verification record](VERIFICATION.md#特定-windows-机器的-strata-0142-实机更新) for scope.

Appearance follows the system by default. Language and theme are in Settings, beside the sidebar collapse control at the lower left. Strata management is its own navigation page.

See [support scope](DOWNLOAD.en.md#support-scope) for current platform and usage limits. Linux containment requires the environment described above and covers descendants that stay in the managed process group; it does not establish cleanup of every MCP tool that creates its own session.

Login-startup status validates the registration, background file and full hash, data directory and enabled flag. Damaged or foreign entries show diagnostics rather than being claimed. Follow the reason to restore the app background files or resolve conflicts, then configure startup again. A valid status does not establish a real sign-out/sign-in test; operating-system policies may still prevent login startup.

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

Open **Monitor → API usage** for today, the last 24 hours or the last 7 days. Monitoring appears before usage and shows current service and hardware activity; usage charts show historical requests, tokens, cache reuse, latency, prefill and decode speeds. Today uses your local timezone. Metadata is retained in local SQLite for **90 days**, collection continues when the usage page is closed, and records remain after exiting and reopening the app.

| Measurement | Meaning |
| --- | --- |
| HTTP requests | Incoming API requests, including failures and token-count requests |
| Inference runs | Model work performed within a request; one tool-assisted request can include several runs |
| Tool calls | MCP/tool activity counted separately from HTTP requests and model runs |
| HTTP token usage | Usage reported for the API response |
| Inference workload | Token work across observed runs; do not add it to HTTP usage as a total |
| First-output latency | Waiting time to the first observed output |
| Total duration | Time observed for the complete request |
| Prefill speed | Prompt-processing rate where timing information is available |
| Decode speed | Output-generation rate where enough timing information is available |
| Cache reuse | Reported reuse; a repeated prefix can behave differently from a fresh prompt |

Success rate uses completed requests; unfinished requests are excluded. Failures, cancellations and interruptions are distinct outcomes. Missing counters stay **unknown**, not zero. Source labels are unknown when the client supplies no identifiable label.

Check collection state and coverage before interpreting a quiet chart. Older or modified runtimes may not be supported, and collection gaps are labeled. Metadata from before observation began cannot be reconstructed as complete usage history. Large model loads, long prompts and tool calls can explain latency without indicating a service fault.

Request history supports custom times, client, actual model, outcome and time order, with pagination. Pages keep the same boundary for newly ingested records until refreshed; an active request can still acquire its final status. Older records without an observed model remain unknown rather than being assigned the current model.

CSV export opens the system save dialog and exports metadata matching the current range and filters. Each export allows at most 5,000 rows; narrow the range or filters for larger results. Cancelling the dialog writes no file. Prompts, responses, reasoning, tool arguments and keys are excluded.

## Local storage and privacy

Usage analytics records metadata without prompts, responses, reasoning, attachments, tool arguments or API keys. Chat history and attachments are stored separately on your computer; metadata-only collection does not mean the app stores no conversation content.

**Request-body capture** is separate from metadata collection. Open advanced diagnostics, choose 5, 15 or 30 minutes, and enable temporary capture on an idle managed runtime that supports it and passes identity checks. It keeps up to 100 requests' inputs, reasoning and responses in RAM. Disabling capture or expiry erases captured bodies while the service keeps running; it does not alter `api_monitor`. Unsupported runtimes, unknown identity or active requests prevent automatic enablement.

**Manage an existing `api_monitor` setting separately.** An imported configuration may already enable the upstream viewer. The app marks it as user-configured and does not claim or disable it. For persistent configuration, set `api_monitor: true` in runtime configuration and restart as prompted; set it to `false` and restart to disable it. This route has no app-managed temporary expiry; lease cleanup applies only to temporary capture enabled by the app.

Runtime and model downloads, update checks, and configured MCP tools can make network requests. Local inference does not make every enabled integration offline. Keep API keys and diagnostic exports private, and review exports or logs before sharing them.

## Compare tuning results

Choose Everyday chat, Coding and Agent, or Long document analysis to measure complete tasks. The report separates fresh inputs, repeated prefixes, session switches, sustained generation, tool loops or document retrieval. Optional vision checks require image support already configured for the current model; unchecked vision remains untested.

Request candidates compare PCIe budget (`pcie_frac`) and MTP threshold (`spec_min_p`). Advanced settings also offer up to four independent restart candidates: CPU worker count, asynchronous swapping, prefill chunk size and VRAM reserve. Each restart candidate changes one setting. Manager checks support, sampled resource headroom and recovery records, then measures **current A → candidate B → restored A**. VRAM-reserve candidates may only increase the current reserve; unknown original values or effective support cause rejection.

The comparison temporarily occupies the model; other requests may wait or report busy. Measurements preserve the current configuration. Stop the comparison with its cancel control when needed; cancellation affects the comparison's own request. Applying a recommendation is a separate action that restarts the managed service.

Review task duration, first-output latency, speeds, caching, task quality, observed configuration state and resource samples together. A recommendation requires repeatable gain beyond baseline drift, passing task-quality and resource checks. Resource samples are not a capacity guarantee, and a startup ceiling does not prove the effective prefill chunk size.

**Run short request diagnostics only** retains the short-chat, Code and Chinese probes. These reports do not establish full-scenario acceptance and cannot apply new recommendations. The Code probe checks `merge_sorted(a,b)` on empty lists, duplicates, negative numbers, unequal lengths and fixed randomized inputs, including input preservation. Only supported syntax is parsed; generated Python is not executed. Historical reports remain readable and previously applied parameters can be restored, but a new application requires a fresh measurement. Results cover the selected workloads, not general model quality, every Agent workflow or unchecked vision and capacity scenarios.

Applying a result saves a recovery record, restarts the owned service and checks model loading. If application fails, Manager attempts to restore the original configuration and service. Recovery can also fail; follow the displayed diagnostics, repair the cause and prepare the model again rather than assuming it is available. Applying or restoring parameters briefly affects the local API; avoid concurrent maintenance and active client work during these actions.

Controlled tests validate the comparison and recovery workflow. Real speed improvements need a report from the actual model, hardware and workload. Screenshot metrics and demonstration timing are not GPU benchmarks.

## New in 0.1.3

Chat supports text, JSON and JSON Schema output, sampling controls and reusable long-document prefixes. Common actions are visible directly; the question mark beside a heading opens help. Runtime configuration is organized by category, with advanced editors retaining access to the full configuration.

Model preparation exposes supported download sources and GPU selection, local GGUF inspection, and runtime-supported Swift/IQ3_S quantization. Availability depends on the installed runtime and selected model; unavailable actions show the reason.

Service tools expose slots, session save/restore, prefill progress and supported VRAM adjustment. MCP shows servers, tools and model-supported tool calls. Existing-runtime management handoff and expert tuning candidates have dedicated controls. Session files remain local and should be handled as data containing user input.

Windows test builds were exercised with JSON/Schema, long-document caching, session save/restore, concurrent slots and management handoff. The tested low-RAM resident mode rejects dynamic VRAM adjustment; the app explains that upstream rejection. Full long-running tuning, new model downloads and restoration across Windows sign-in still need separate acceptance. Those test-build GPU results do not establish repeated acceptance of the final release package.

## Application updates

Automatic checks in Settings are enabled by default, on launch and every 12 hours. An available update displays that Release's original notes and requires confirmation before downloading and installing. Disable automatic checks to check manually. Failures preserve the current app and can be retried; installation checks that the background is idle. Downloads show progress, and the updater verifies official Tauri signatures with the embedded public key.

Use the v0.1.3 release entry for the [Windows installer](https://github.com/hongfaqiu/strata-manager/releases/download/v0.1.3/Strata.Manager_0.1.3_x64-setup.exe), [AppImage](https://github.com/hongfaqiu/strata-manager/releases/download/v0.1.3/Strata.Manager_0.1.3_amd64.AppImage) or [DEB](https://github.com/hongfaqiu/strata-manager/releases/download/v0.1.3/Strata.Manager_0.1.3_amd64.deb) and compare [SHA256SUMS](https://github.com/hongfaqiu/strata-manager/releases/download/v0.1.3/SHA256SUMS). Install only assets actually listed on the release page. Stable releases use `latest`; previews remain manual downloads and do not replace the stable channel. Finding no beta update does not establish that the latest preview is installed.

Application, Strata runtime and model weights are separate. Updating Manager does not normally require another model-weight download. Read the version's release notes for restart and recovery behavior.

See [Download and try](DOWNLOAD.en.md) for versions, packages and the current support scope.

Tauri update signatures are separate from Windows Authenticode publisher signing. The project does not currently have a Windows publisher certificate; follow the download guide when your system displays an installation warning.

## Update the Strata runtime

Strata is a global runtime managed on its own **Strata** page. View installed and upstream versions, official release links and notes. The update package matches the current engine type by default; you can also select an available package. After confirmation, the task downloads the official engine ZIP and same-version source, verifies and extracts them into a preparation directory, then backs up and replaces program files while retaining weights, configurations and conversations.

Automatic checks share the app's default-enabled setting and still require confirmation. Preparation preserves the current service; switching follows idle and process-identity checks and briefly interrupts the local API. The updated service is checked, and failure or cancellation after switching attempts to restore backups and previous registrations. Recovery failures retain diagnostics for repair before retrying.

This workflow uses upstream release information and matching ZIP assets. ZIP engine updates currently target matching official Windows x64 packages; missing platform assets preserve the existing installation. Linux retains release information and notes without offering Windows ZIP updates; Linux source-build upgrades are not implemented. External startup hooks, unknown processes or incompatible dependencies are rejected before stopping services.

An existing Strata installation was updated to 0.1.42 on one Windows machine: all 24 original configuration files were unchanged, the existing model was loaded again with its 131072 context setting preserved, and a short API request returned `OK`. This was not a full 128K-context test and does not establish compatibility for every GPU/model, Linux or the complete UI flow. Updating the Tauri app itself across versions requires separate acceptance. See the [verification record](VERIFICATION.md#特定-windows-机器的-strata-0142-实机更新) for details.

## Common questions

**My installation was not found.** Select its Strata folder and read the detection reason. Verify the source, Python environment, configuration and model files before attempting import.

**Do I have to download the model again?** No. My models lists discovered configurations directly, and earlier valid Manager configurations are restored. Add a search directory if needed; prepare a new model only when you need additional weights.

**The API is up, but Chat cannot answer.** Check Model ready, task logs and available memory. Loading on demand can delay the first request. Avoid starting another large GPU workload during loading.

**Another application cannot connect.** Check the copied loopback address, API path, model readiness, key and timeout. A client that cannot reach local services may have its own network restrictions.

**The app refuses to take over a running installation.** Read the identity or activity diagnostic. Wait for active work to finish; an unverified process is not stopped merely because it occupies the expected port.

**Usage is empty or has unknown values.** Check collection state, runtime compatibility and coverage. Missing observation is different from zero usage.

**Tuning did not find an improvement.** Keep the current settings if gains are not repeatable. Compare complete tasks with your own workload; cache state and background activity can affect results.

**The window closed, but GPU memory is still used.** Closing to the tray is enabled by default and keeps the model available. Use Release model memory to retain the API without loaded weights, or Stop services and quit to end managed services. Disabling closing to the tray makes window close stop services and exit.

**An update check or download fails.** Read the displayed error and retry when the network or release source is available. The current application remains installed. Check [Download and try](DOWNLOAD.en.md) for release availability and [Troubleshooting](TROUBLESHOOTING.en.md) for the next steps.

## Screenshots and project credits

The README images show the actual App rendered with isolated in-memory RPC example data. Model status, metrics and chat content are examples; their source is disclosed outside the images in the README and website. The cover combines those screens. Neither the screenshots nor the cover demonstrate inference speed or real API usage.

This independent community application builds on [Niko1221/Strata](https://github.com/Niko1221/Strata) and its official interface. See [MIT](../LICENSE) and [third-party notices](../THIRD_PARTY_NOTICES.md); Outfit uses SIL OFL 1.1, and separately downloaded models retain their own licenses.
