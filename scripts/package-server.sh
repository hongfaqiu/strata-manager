#!/usr/bin/env bash
# Build Linux amd64 headless server packages (tar.gz + .deb).
# Output names match the updater-independent release assets:
#   Strata.Manager.Server_<ver>_amd64.tar.gz
#   Strata.Manager.Server_<ver>_amd64.deb
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-"$ROOT/output/server"}"
VERSION="${STRATA_MANAGER_VERSION:-$(node -p "require('$ROOT/package.json').version")}"
PRODUCT_SLUG="Strata.Manager.Server"
TARBALL_NAME="${PRODUCT_SLUG}_${VERSION}_amd64.tar.gz"
DEB_NAME="${PRODUCT_SLUG}_${VERSION}_amd64.deb"
STAGE_NAME="strata-manager-server-${VERSION}-linux-amd64"
STAGE="$OUT/$STAGE_NAME"
WEB_SRC="${STRATA_MANAGER_WEB_ROOT:-$ROOT/apps/desktop/dist}"

rm -rf "$STAGE" "$OUT/deb-root"
mkdir -p "$STAGE/bin" "$STAGE/web" "$STAGE/systemd" "$STAGE/docs" "$OUT"

if [[ "${STRATA_MANAGER_SKIP_FRONTEND_BUILD:-}" != "1" ]]; then
  (cd "$ROOT" && pnpm -w build)
fi
if [[ ! -f "$WEB_SRC/index.html" ]]; then
  echo "missing frontend build at $WEB_SRC (run pnpm -w build or set STRATA_MANAGER_WEB_ROOT)" >&2
  exit 1
fi
cp -a "$WEB_SRC/." "$STAGE/web/"

CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
if [[ "${STRATA_MANAGER_SKIP_SERVER_BUILD:-}" != "1" ]]; then
  cargo build --release -p strata-manager-server --locked --manifest-path "$ROOT/Cargo.toml"
fi
BIN="$CARGO_TARGET_DIR/release/strata-manager-server"
if [[ ! -x "$BIN" ]]; then
  echo "missing server binary: $BIN" >&2
  exit 1
fi
cp "$BIN" "$STAGE/bin/strata-manager-server"
cp "$ROOT/packaging/systemd/strata-manager-server.service" "$STAGE/systemd/"
cp "$ROOT/docs/SERVER.md" "$ROOT/docs/SERVER.en.md" "$STAGE/docs/" 2>/dev/null || true
cat > "$STAGE/run.sh" << 'RUN'
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export STRATA_MANAGER_WEB_ROOT="${STRATA_MANAGER_WEB_ROOT:-$HERE/web}"
export STRATA_MANAGER_BIND="${STRATA_MANAGER_BIND:-127.0.0.1:8787}"
export STRATA_MANAGER_DATA_DIR="${STRATA_MANAGER_DATA_DIR:-$HERE/data}"
mkdir -p "$STRATA_MANAGER_DATA_DIR"
exec "$HERE/bin/strata-manager-server"
RUN
chmod +x "$STAGE/run.sh" "$STAGE/bin/strata-manager-server"

tar -C "$OUT" -czf "$OUT/$TARBALL_NAME" "$STAGE_NAME"
echo "tarball: $OUT/$TARBALL_NAME"

DEB_ROOT="$OUT/deb-root"
mkdir -p \
  "$DEB_ROOT/DEBIAN" \
  "$DEB_ROOT/usr/bin" \
  "$DEB_ROOT/usr/share/strata-manager-server/web" \
  "$DEB_ROOT/lib/systemd/system" \
  "$DEB_ROOT/usr/share/doc/strata-manager-server" \
  "$DEB_ROOT/var/lib/strata-manager"
cp "$STAGE/bin/strata-manager-server" "$DEB_ROOT/usr/bin/"
cp -a "$STAGE/web/." "$DEB_ROOT/usr/share/strata-manager-server/web/"
cp "$STAGE/systemd/strata-manager-server.service" "$DEB_ROOT/lib/systemd/system/"
cp "$STAGE/docs/"* "$DEB_ROOT/usr/share/doc/strata-manager-server/" 2>/dev/null || true
cat > "$DEB_ROOT/DEBIAN/control" << CTRL
Package: strata-manager-server
Version: ${VERSION}
Section: utils
Priority: optional
Architecture: amd64
Maintainer: Strata Manager <noreply@users.noreply.github.com>
Description: Headless Strata Manager Server (Web panel)
 Provides strata-manager-server with embedded Web UI for Ubuntu Server / headless hosts.
Depends: libc6
CTRL
# Installed-Size in KiB
INSTALLED_SIZE="$(du -sk "$DEB_ROOT" | awk '{print $1}')"
printf 'Installed-Size: %s\n' "$INSTALLED_SIZE" >> "$DEB_ROOT/DEBIAN/control"
chmod 755 "$DEB_ROOT/DEBIAN"
chmod 644 "$DEB_ROOT/DEBIAN/control"
chmod 755 "$DEB_ROOT/usr/bin/strata-manager-server"
dpkg-deb --root-owner-group --build "$DEB_ROOT" "$OUT/$DEB_NAME"
echo "deb: $OUT/$DEB_NAME"
ls -la "$OUT/$TARBALL_NAME" "$OUT/$DEB_NAME"
