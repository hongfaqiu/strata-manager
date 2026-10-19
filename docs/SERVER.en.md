# Strata Manager Server (headless Web panel)

For **Ubuntu Server** and other headless hosts: a resident process plus a browser panel to start/stop the local Strata inference service, view status/logs, and edit inference parameters. No desktop AppImage or Xvfb required.

## Quick try

```bash
pnpm -w build
export STRATA_MANAGER_DATA_DIR=/tmp/strata-manager-server-data
export STRATA_MANAGER_WEB_ROOT="$(pwd)/apps/desktop/dist"
export STRATA_MANAGER_BIND=127.0.0.1:8787
cargo run -p strata-manager-server
```

On first start the process prints a **Bearer token** and writes `$STRATA_MANAGER_DATA_DIR/server-token` (mode 0600). Open `http://127.0.0.1:8787/`, paste the token, or use a one-shot `?token=` query.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `STRATA_MANAGER_BIND` | `127.0.0.1:8787` | Listen address (loopback by default) |
| `STRATA_MANAGER_DATA_DIR` | `~/.local/share/strata-manager-server` | State + token file |
| `STRATA_MANAGER_WEB_ROOT` | (placeholder page) | Point at `apps/desktop/dist` |
| `STRATA_MANAGER_TOKEN` | (from file) | Override the token file |

## API

- `GET /api/v1/health` — public
- `POST /api/v1/rpc` — Bearer auth; methods mirror desktop invoke / `RuntimeState::dispatch`
- `WS /api/v1/events` — status push

Desktop-only commands (tray, floating monitor, updater, native dialogs) are rejected with a clear error.

## Packaging

- systemd unit: `packaging/systemd/strata-manager-server.service`
- tarball / `.deb` helper: `scripts/package-server.sh`

## Immediate vs restart parameters

Model launch / service config fields saved from the config page apply after a **service restart** (badge: “takes effect after save + restart”). Engine `/settings` live knobs go through `strata_request` and apply immediately when the service is up.
