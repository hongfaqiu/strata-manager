# Isolated optimization regressions

Run `test:browser` in the desktop package with existing Playwright and Chromium.
When those tools are outside the package, set `STRATA_PLAYWRIGHT_MODULE` to the
existing Playwright `index.mjs` and `STRATA_BROWSER_EXECUTABLE` to an existing
Chromium executable. The runner does not install either tool.

The fixture mounts the real React app and configuration components. Native IO
uses synthetic in-memory profiles, configuration, telemetry and conversations.
Lifecycle mutations throw; HTTP requests outside the random fixture origin are
blocked. It never connects to a real supervisor, model, database or credential
vault, and runs in a separate headless browser context. Results are saved to
`output/optimization-verification/browser-results.json`.

Coverage includes noncurrent service logs, full-tuning capability rejection,
JSON navigation/reload decisions, history cancellation/replay, model configuration drafts,
exit modal cleanup, failed reloads, remote clean/dirty refreshes, partial stream
errors, unknown engine metadata, stale telemetry, external hash history entries,
configuration-copy identity changes and visible application failures. These are source regression
tests, not acceptance evidence for the installed application or a real GPU run.

Shared settings regressions run with `node apps/desktop/tests/optimization/verify-common-settings.mjs`.
They mount the complete App with synthetic native IO, block real service lifecycle
and configuration writes, and cover common chat inheritance, legacy overrides,
advanced-only model edits that preserve dedicated defaults during inheritance,
request parameters, persistence after reload, credential draft protection, MCP
target selection and nested-dialog cleanup. Results and screenshots are saved to
`output/playwright/common-settings`.

App version, installed release notes and candidate update review can be verified
with Playwright CLI and a separate native fixture:

```powershell
node apps/desktop/tests/optimization/serve-app-updates.mjs
# Use the printed origin in a second terminal (the server stays open):
npx --yes --package @playwright/cli playwright-cli -s=strata-app-version open http://127.0.0.1:5173/app-update-app.html --browser chrome
npx --yes --package @playwright/cli playwright-cli -s=strata-app-version --raw run-code --filename=apps/desktop/tests/optimization/verify-app-updates.cli.js
```

The CLI replay exercises the real App, blocks requests beyond the fixture origin
and rejects updater downloads, installation and service lifecycle operations.
It covers direct update-page navigation, an automatic-check badge without an
automatic dialog, manual review, collapsed navigation, both languages/themes,
and a native app version that differs from the package version. The returned
JSON reports each case; screenshots go to `output/playwright/app-updates/`.

The same isolated origin also supports API-integration verification:

```powershell
npx --yes --package @playwright/cli playwright-cli -s=strata-app-version --raw run-code --filename=apps/desktop/tests/optimization/verify-api-integration.cli.js
npx --yes --package @playwright/cli playwright-cli -s=strata-app-version close
```

This replay checks Cherry Studio, four code-example languages, OpenCode and
Claude Code, copying the displayed values/configuration, stopped-service
instructions without starting or querying that service, and English/dark-theme
layout in a 900px desktop window. Clipboard writes are recorded in memory and
do not change the host clipboard. It checks both page errors and console errors.

The same server can verify the complete App's service-status telemetry and update
layout. Use the printed origin if port 5173 is already occupied:

```powershell
npx --yes --package @playwright/cli playwright-cli -s=strata-status-trends open http://127.0.0.1:5173/service-status-trends-app.html --browser chrome
npx --yes --package @playwright/cli playwright-cli -s=strata-status-trends --raw run-code --filename=apps/desktop/tests/optimization/verify-service-status-trends.cli.js
npx --yes --package @playwright/cli playwright-cli -s=strata-status-trends close
```

This replay covers full-width update cards at 1440/900px, generation and input
trends, idle/unloaded/stopped/missing telemetry, retained history on refresh or
collection failure, independent service/process histories, delayed and failed
first samples after a PID change, and grouped English/Chinese navigation in
regular and narrow windows. Telemetry and service identities are controlled
in memory; requests beyond the fixture origin and lifecycle/update mutations
are rejected. It returns a per-case JSON result and saves four overview/layout
screenshots to `output/playwright/service-status-trends/`.

`verify-service-stop.cli.js` uses that origin to check verified stop, a native
stop error and a native response that still reports a running process. Only one
explicit in-memory `stop_service` per case is permitted; no real lifecycle
command runs. It checks that the overview and popup replace stopped-service
actions with start, and that failed/unverified stops retain truthful running
state with an error. Run it with the same CLI `run-code --filename` command.

`verify-floating-monitor.cli.js` mounts the exact production `main.tsx` entry
with `?window=monitor` through `floating-monitor-app.html`. It verifies the
main status-bar entry, generation/idle/unloaded/stopped states, metrics failure
with retained API health, failed/stale snapshots, a narrow English/dark window,
and dedicated pin/close/show-main commands. It permits only in-memory native
snapshots and window controls, and rejects service lifecycle calls. Results are
returned as JSON; two screenshots go to `output/playwright/service-status-trends/`.
The browser replay verifies UI and command wiring; native topmost behavior
requires a separate Tauri window run.

The existing quick-action regression runner is
`node apps/desktop/tests/optimization/verify-service-status.mjs`, with the same
external Playwright/browser environment variables. Its load/benchmark actions
are synthetic fixture operations. Results go to `output/playwright/service-status/`;
they do not verify the installed Tauri application or real GPU sampling.

The continuation includes config CAS conflicts, the accepted revision after a
successful write followed by reload failure, per-key preference writes, and
waiting for an in-flight store write before exit. `src/storeWriteQueue.test.mjs`
covers unchanged snapshots, concurrent checkpoints, final snapshots, failures,
and preserving the one-second checkpoint cadence while deltas are staged.

Run `node tests/optimization/measure.mjs` from the desktop package with the same
existing browser environment variables for synthetic 20/100/200-message React
Profiler comparisons and 20 MB attachment serialization. It writes
`output/optimization-verification/performance-results.json`. Development
Profiler durations are comparative measurements, not production FPS. It does
not read real chats or connect to services.

Run `node tests/optimization/verify-official-features.mjs` from the desktop
package with the same browser environment variables for official-feature UI
checks. It reserves `127.0.0.1:18741`, mounts the production setup, GGUF inspect,
chat request, MCP, slots/resource and tuning components, and mocks native IO in
memory. It checks download source validation and GPU options, cancellable
inspection tasks and output, JSON Schema and pinned document requests, read-only
MCP checks and ownership handoff/configuration, slot/VRAM/session operations,
and the three expert-adaptation tuning candidates. Requests outside the fixture
origin are blocked and service lifecycle commands throw. No model, default
database, external client configuration or real service is changed. Results and
screenshots are saved to `output/playwright/official-features/`. These checks
verify source UI flows with synthetic responses, not actual hardware behavior.
The same runner also mounts the complete App for catalog preparation options,
GGUF inspection, SamplingDrawer-to-send requests, and configuration resource/MCP
panels. Pinned prefixes require separate live-process startup evidence; a saved
cache depth of 4 with a running depth of 2 rejects sending. Canceling while
metadata reads are pending completes immediately and cannot send a late stream.
