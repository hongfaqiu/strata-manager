#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-"$ROOT/output/server"}"
VERSION="$(node -p "require('$ROOT/package.json').version")"
STAGE="$OUT/strata-manager-server-${VERSION}-linux-amd64"
rm -rf "$STAGE"
mkdir -p "$STAGE/bin" "$STAGE/web" "$STAGE/systemd" "$STAGE/docs"
(cd "$ROOT" && pnpm -w build)
cp -a "$ROOT/apps/desktop/dist/." "$STAGE/web/"
cargo build --release -p strata-manager-server --manifest-path "$ROOT/Cargo.toml"
BIN="$ROOT/target/release/strata-manager-server"
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
mkdir -p "$OUT"
tar -C "$OUT" -czf "$OUT/strata-manager-server-${VERSION}-linux-amd64.tar.gz" "$(basename "$STAGE")"
echo "tarball: $OUT/strata-manager-server-${VERSION}-linux-amd64.tar.gz"
DEB_ROOT="$OUT/deb-root"
rm -rf "$DEB_ROOT"
mkdir -p "$DEB_ROOT/usr/bin" "$DEB_ROOT/usr/share/strata-manager-server/web" "$DEB_ROOT/lib/systemd/system" "$DEB_ROOT/usr/share/doc/strata-manager-server" "$DEB_ROOT/var/lib/strata-manager"
cp "$STAGE/bin/strata-manager-server" "$DEB_ROOT/usr/bin/"
cp -a "$STAGE/web/." "$DEB_ROOT/usr/share/strata-manager-server/web/"
cp "$STAGE/systemd/strata-manager-server.service" "$DEB_ROOT/lib/systemd/system/"
cp "$STAGE/docs/"* "$DEB_ROOT/usr/share/doc/strata-manager-server/" 2>/dev/null || true
echo "deb layout: $DEB_ROOT"
