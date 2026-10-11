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
JSON navigation/reload decisions, history cancellation/replay, API key drafts,
exit modal cleanup, failed reloads, remote clean/dirty refreshes, partial stream
errors, unknown engine metadata, stale telemetry, external hash history entries,
configuration-copy identity changes and visible application failures. These are source regression
tests, not acceptance evidence for the installed application or a real GPU run.

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
