# System overview: Strata Manager 0.1.5

This document explains the components, persistence and operating boundaries of 0.1.5. See [verification records](VERIFICATION.md); release results must be tied to same-source CI and the [published release](https://github.com/hongfaqiu/strata-manager/releases/tag/v0.1.5). Screenshots use isolated demonstration data, and values in report images are not hardware measurements. See the [changelog](../CHANGELOG.md) for the full illustrated overview.

## Three components

| Component | Responsibility | Runtime relationship |
| --- | --- | --- |
| Desktop | React/Tauri workspaces, chat, monitoring, connections, Benchmark and update confirmation | Uses local IPC for the independent backend and native HTTP for verified Strata services |
| Supervisor | Local model registration, process ownership, tasks, persistence, observers, tuning and management MCP | Runs separately from the desktop; closing or restarting the interface can preserve services |
| Strata | Model loading, inference, model APIs and engine capabilities | Uses each model's configuration, runtime directory and port; capabilities depend on the installed runtime and model |

Closing the interface is different from stopping a service. Stopping releases its managed process; unloading releases model resources while keeping the API. Login startup, model preparation and recovery are separate background settings. A service explicitly stopped by the user remains not started when the interface opens or polls status.

## Local models, ports and external assistants

The Supervisor's registration is authoritative. Discovery is read-only; import rechecks candidates and creates an application configuration snapshot while preserving source configurations and weights. Removing registration and deleting model files are separate operations; file deletion requires its own verified plan and confirmation.

The desktop bridge accepts loopback HTTP addresses. A listening port alone does not establish ownership: checks also cover PID, creation time, configuration, listener and managed ownership. External instances can be inspected without taking ownership; an explicit takeover rechecks identity before transferring control. Unknown ownership or busy state blocks relevant changes. Managed Windows trees use Job Objects; Linux uses process supervision. This does not establish coverage of every third-party descendant that creates a separate process group.

Shared settings provides an API and external assistants workspace for connection targets, the application's access key, API examples and MCP. Selecting a target neither starts nor switches the current model. Backend management MCP and official standalone MCP use different ownership modes; backend management can continue after the interface closes. Generated Codex backend configurations use a 600-second tool timeout; official standalone Codex configurations use 180 seconds. Other client configurations do not automatically receive this field.

## Common chat defaults

Common defaults share reasoning effort, temperature, Top-p, Top-k, output limits, seed, system prompt and MCP. They exclude model names and advanced settings tied to capabilities. New models inherit by default. Existing saved per-model settings remain independent until inheritance is explicitly enabled.

Changes affect an inheriting model's next chat request; an in-flight request keeps its original parameters. Applying changes to shared fields in the sampling drawer creates dedicated settings for that model. Disabling inheritance restores its previous dedicated settings, or saves the currently effective settings if none exist. Structured-output restrictions on MCP remain effective.

Common values, per-model values and inheritance flags are persisted separately. Drawer sessions are bound to a model, and a late save callback cannot write to another model. Switching models currently recreates the drawer and discards its unsaved draft; this must not be described as draft preservation. Navigation from credential and startup-configuration editors has separate save, discard and cancel guards.

Saving only advanced settings while inheritance is enabled preserves the model's existing dedicated shared values. Disabling inheritance can still restore those values; editing advanced settings does not copy the common defaults over them.

## Credentials, SQLite and backups

API keys are stored by service ID in the system credential vault. The frontend can query whether a key exists but cannot retrieve the secret. Saving a connection key changes the application's access credential, not server authentication. Browser development previews hold keys only in session memory and do not validate native credential storage.

The user application data directory contains `strata-manager.sqlite3` for settings, conversations, registrations, tasks and statistics. Conversation attachments use separate tables with transactional reference maintenance. Observers record usage events in `analytics/journal.sqlite3`; daily statistics do not require request-body capture. Advanced request diagnostics has a separate explicit capture switch and time limit.

SQLite conversations and attachments are not an encrypted vault. Configuration writes use revision checks, atomic replacement and original-file backups. Before an application update is installed, `VACUUM INTO` creates a consistent database backup under `backups/`. This backup excludes system credentials, model weights and runtime directories.

## Benchmark and tuning

The sidebar has a dedicated Benchmark entry with “Context tiers” and “Scenario suite” tabs. Context tests send requests serially from the smallest selected tier to the largest. Presets run from 8K to 1M, with the model's actual context limit added as a tier. By default, all tiers within the verified limit that leave room for output and template overhead are selected; presets above the limit are unavailable. A running service uses the loaded model's `/health` value. When stopped, the local configuration is read only for planning; reading the limit does not start the service.

To run a test, first ensure the model is ready and no inference or management task is active. Select tiers, rounds per tier, output allowance and timeout, then start the finite plan. Each tier's total budget includes output and template headroom, so a target tier is not the actual input token count. When token counting is unavailable, the input size used during preparation is marked estimated. Actual input, output and cache counts come from service `usage`; prefill and decode speeds come from `timings`. Reports also record first-token latency and full request duration. GPU memory and RAM are sampled once per second across the GPUs and host, and missing values remain unknown.

Results show line charts for prefill speed, decode speed and request duration, averaging successful requests within each tier while keeping individual measurements in the table. Copy a result image, export PNG, or export JSON/CSV with test conditions. Copying an image requires image clipboard support in the current environment; PNG export is available when copying fails. Warmup, caching and other programs still affect results; a chart alone does not establish cold-start or cache-free performance.

“Scenario suite” retains seven scenarios and sends one request at a time. Legacy concurrent stress reports remain available for viewing and export; they do not provide a new stress-run mode. The two tabs cannot be switched during a run. Stopping a test or switching models cancels further work.

The desktop treats chat and Benchmark as inference activity and coordinates tuning, service switches, runtime tasks and updates. Switching models or cancelling a Benchmark ends further work. The independent backend runs tuning and verifies configuration application and restoration. Desktop coordination does not exclude concurrent requests from other API clients. Reproducible measurements still require model and service identity, cache state, concurrency, resource headroom and external load.

Interface examples: [context tiers](screenshots/benchmark.en.webp), [result report (demonstration data)](screenshots/benchmark-report.en.webp), and [scenario tests](screenshots/scenario-benchmark.en.webp).

## Application updates and engine downloads

Application updates use the project's stable `latest.json` channel. Automatic checking and installation confirmation are separate. Approval is bound to the displayed version, and a successful download requires Tauri updater verification with the embedded public key. Installation rechecks tasks, tuning, service idleness and database backup. Backend package handoff verifies package identity and waits for the original process to exit; a failed candidate attempts to restore the previous version. This is not a universal rollback guarantee for arbitrary installer failures or database migrations. Public `SHA256SUMS` supports independent initial-installer checks; Tauri signatures are separate from Windows Authenticode publisher signing.

Engine ZIPs can come from the official source, a local file or a saved HTTPS mirror/template. Changing the source only changes transport; official version, filename, length and SHA256 still determine acceptance. A network source test reads at most 64 KiB to check reachability, length metadata and Range behavior. A local source test reads and hashes the complete file. Installation independently verifies the complete ZIP's length and official SHA256, corresponding source archive, extraction paths and replacement scope.

The update journal records replacement plans, original-program backups and original/replacement hashes, protecting models, configurations, sessions and unknown files. Failure restores files and registration from that record. An incomplete rollback must remain visible with diagnostic evidence. Service restoration follows its original running/stopped state; a successful update does not imply that every model starts automatically.

## Status trends and validation boundaries

The separate desktop monitor is closed by default and uses a compact, metrics-only layout. Drag anywhere and use the native context menu (or Shift+F10) for actions. The menu provides actions for returning to the main window, changing workspaces, copying the API address, refreshing or pausing sampling, pinning the monitor and opening its settings. Shared settings includes a “Floating monitor” panel for the default pin state, sample-time display and system tray monitoring; changes save automatically. When enabled, the tray updates status and speed independently, and clicking its icon restores the monitor. The monitor can also move to the tray through its context menu. Closing it preserves the main app. See the [monitor settings example](screenshots/floating-monitor-settings.en.webp).

“Quick speed test” from the monitor or tray runs in the main window. It sends the short-request and decode scenarios serially only when the model is ready and inference and management tasks are idle. This action sends actual inference requests. Routine monitoring still reads only an existing backend and does not start or restore stopped services. Native context menus, tray behavior, pinning and the system clipboard require separate desktop validation; screenshots do not replace those checks.

Historical boundary: the monitor's native application command entry in 0.1.4 permits only monitoring and showing the main window. Menu, tray and quick-test actions added in 0.1.5 are not included in the 0.1.4 installers.

Failed status queries stop old process data from authorizing operations. After reconnection, only metrics successfully sampled after the failure are displayed. Normal background polling retains the last successful sample.

The panel uses polled metric responses, retaining at most 60 points from the 180 seconds preceding the latest appended sample. Charts preserve actual sample spacing and missing-data gaps. Generation and input processing are separate series. Idle throughput is labelled as the last generation and is not plotted as fresh throughput. Stopped or disconnected services hide live values; metrics failures retain history with collection marked paused. PID or start-identity changes isolate health/metrics caches and history.



Existing records cover Windows MCP start/stop, continued operation after disconnect, preservation of stopped services, model restoration and short inference, with configuration hashes unchanged. Isolated browser checks cover Benchmark, tuning, update and download interfaces; some installed-desktop interactions are recorded separately. Interface and fixture checks are not real GPU performance measurements.

Release builds, website screenshots/links and public installer signatures/checksums are verified separately against the final commit. Real GPU Benchmark measurements, full tuning, sustained GPU stress, system-level Linux DEB installation and client cross-version automatic updates require separate validation. Older and single-machine results do not establish compatibility with all hardware.

## Source evidence

- Architecture, registration and persistence: `apps/desktop/src-tauri/src/lib.rs`, `apps/supervisor/src/main.rs`, `crates/runtime-core/src/{lib,store,http,storage,analytics}.rs`.
- Shared settings and coordination: `App.tsx`, `CommonChatSettingsPanel.tsx`, `ChatSettings.tsx`, `ServiceConnectionPanel.tsx`, `packages/core/src/shared-chat-settings.ts`.
- Updates and complete-file verification: `appUpdateController.ts`, `supervisor_client.rs`, `runtime_upgrade/release_zip.rs` and `release_zip/{download_check,download_source}.rs`.
- Sampling and validation scope: `ServiceStatusPopover.tsx`, `serviceStatusTelemetry.ts`, `CHANGELOG.md`, `docs/VERIFICATION.md`. Historical test counts are not reported as final-source pass counts.
- Features in 0.1.5: `BenchmarkPage.tsx`, `ContextBenchmarkPage.tsx`, `ContextBenchmarkCharts.tsx`, `ScenarioBenchmarkPage.tsx`, `useBenchmarkContext.ts`, `packages/core/src/context-benchmark.ts`, `FloatingMonitorSettings.tsx`, `floatingMonitor.ts`, `apps/desktop/src-tauri/src/monitor_tray.rs`.
