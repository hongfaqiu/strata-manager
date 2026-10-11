#!/usr/bin/env bash
# Build the real GNOME Secret Service used only by isolated Linux test fixtures.
set -euo pipefail
umask 077

if [[ $# -ne 0 || "$(uname -s)" != Linux ]]; then
  echo 'Usage (Linux): bash scripts/build-linux-test-keyring.sh' >&2
  exit 2
fi
for tool in curl sha256sum tar patch make pkg-config cc python3; do
  if ! command -v "$tool" >/dev/null; then
    echo "Missing Linux test-keyring build tool: $tool" >&2
    exit 2
  fi
done

source_version=40.0
source_series=40
source_sha256=a3d24db08ee2fdf240fbbf0971a98c8ee295aa0e1a774537f4ea938038a3b931
patch_sha256=e0e33127048532ed6b6a39a319a1fcd7ee51f6765ec018157dd0efde964e54bd
upstream_patch_commit=8fcdeffe67ae8c1600eae9637816acbf73f66b81
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
patch_file="$script_dir/patches/gnome-keyring-40.0-client-registration.patch"
if [[ ! -f "$patch_file" || -L "$patch_file" ]]; then
  echo 'The pinned GNOME Keyring test patch must be a regular file.' >&2
  exit 2
fi
printf '%s  %s\n' "$patch_sha256" "$patch_file" | sha256sum --check --status

# Every build owns a fresh private directory. There is no sudo/install step,
# mutable cache or fallback to an unpatched daemon after a build failure.
build_root=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/strata-test-keyring-build.XXXXXX")
archive="$build_root/gnome-keyring-$source_version.tar.xz"
prefix="$build_root/prefix"
echo "Building isolated GNOME Keyring $source_version with MR !112 $upstream_patch_commit in $build_root" >&2
curl --proto '=https' --tlsv1.2 --location --fail --show-error \
  --connect-timeout 15 --max-time 120 \
  --output "$archive" \
  "https://download.gnome.org/sources/gnome-keyring/$source_series/gnome-keyring-$source_version.tar.xz"
printf '%s  %s\n' "$source_sha256" "$archive" | sha256sum --check --status
tar -xJf "$archive" -C "$build_root"
source_dir="$build_root/gnome-keyring-$source_version"
(
  cd -- "$source_dir"
  patch --dry-run --fuzz=0 -p1 <"$patch_file"
  patch --fuzz=0 -p1 <"$patch_file"
  # Keep GNOME's default assertions enabled; --enable-debug=no disables them.
  ./configure --prefix="$prefix" --enable-debug=default \
    --disable-doc --disable-pam --disable-ssh-agent --disable-selinux \
    --with-pkcs11-config="$prefix/etc/pkcs11" \
    --with-pkcs11-modules="$prefix/lib/pkcs11"
  make -j2 gnome-keyring-daemon
) >&2

daemon="$prefix/bin/gnome-keyring-daemon"
mkdir -m 700 -p "$prefix/bin"
# Refuse a libtool launcher or unexpected build output: the wrapper must own
# the exact ELF process whose PID it binds to the Secret Service connection.
python3 - "$source_dir/gnome-keyring-daemon" <<'PY'
from pathlib import Path
import sys
binary = Path(sys.argv[1])
if binary.is_symlink() or not binary.is_file():
    raise SystemExit('The test-keyring build did not produce a regular binary.')
with binary.open('rb') as stream:
    if stream.read(4) != b'\x7fELF':
        raise SystemExit('The test-keyring build did not produce an ELF daemon.')
PY
cp -- "$source_dir/gnome-keyring-daemon" "$daemon"
chmod 700 "$daemon"
binary_sha256=$(sha256sum -- "$daemon")
binary_sha256=${binary_sha256%% *}
printf 'version=%s\nsource_sha256=%s\npatch_commit=%s\npatch_sha256=%s\nbinary_sha256=%s\n' \
  "$source_version" "$source_sha256" "$upstream_patch_commit" "$patch_sha256" "$binary_sha256" \
  >"$prefix/build-evidence.txt"
echo "Isolated GNOME test daemon SHA256: $binary_sha256" >&2
# The only stdout is the absolute binary path, suitable for GITHUB_ENV.
printf '%s\n' "$daemon"
