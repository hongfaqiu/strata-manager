#!/usr/bin/env bash
# Build the real GNOME Secret Service used only by isolated Linux test fixtures.
#   build-linux-test-keyring.sh                    build (or reuse a verified cache) and print the daemon path
#   build-linux-test-keyring.sh --cache-key        print the cache key bound to every build input
#   build-linux-test-keyring.sh --verify-cache DIR verify a cached build without using it
# STRATA_TEST_KEYRING_CACHE (absolute directory) enables reuse and is filled after a fresh build.
set -euo pipefail
umask 077

mode=build
if [[ "$(uname -s)" != Linux ]]; then mode=usage
elif [[ $# -eq 1 && "$1" == --cache-key ]]; then mode=key
elif [[ $# -eq 2 && "$1" == --verify-cache ]]; then mode=verify; verify_dir=$2
elif [[ $# -ne 0 ]]; then mode=usage
fi
if [[ "$mode" == usage ]]; then
  echo 'Usage (Linux): bash scripts/build-linux-test-keyring.sh [--cache-key | --verify-cache DIR]' >&2
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

# Everything that can change the produced daemon: this script, the pinned source
# and patch, the distribution, compiler and the linked development packages.
build_fingerprint() {
  local script_sha os_id os_version
  script_sha=$(sha256sum -- "$script_dir/build-linux-test-keyring.sh"); script_sha=${script_sha%% *}
  os_id=$(. /etc/os-release && printf '%s' "${ID:-unknown}")
  os_version=$(. /etc/os-release && printf '%s' "${VERSION_ID:-unknown}")
  {
    printf 'script=%s\nsource=%s\npatch=%s\nos=%s-%s\narch=%s\ncc=%s\n' "$script_sha" "$source_sha256" \
      "$patch_sha256" "$os_id" "$os_version" "$(uname -m)" "$(cc -dumpfullversion -dumpversion 2>/dev/null | head -n 1)"
    dpkg-query -W -f='${Package}=${Version}\n' libc6-dev libglib2.0-dev libgcr-3-dev libgcrypt20-dev \
      libtasn1-6-dev libp11-kit-dev libcap-ng-dev libsystemd-dev libselinux1-dev 2>/dev/null | LC_ALL=C sort || true
  } | sha256sum | cut -d' ' -f1
}
fingerprint=$(build_fingerprint)
if [[ ! "$fingerprint" =~ ^[0-9a-f]{64}$ ]]; then
  echo 'Unable to fingerprint the test-keyring build inputs.' >&2
  exit 2
fi
if [[ "$mode" == key ]]; then
  printf 'strata-test-keyring-%s-%s\n' "$source_version" "$fingerprint"
  exit 0
fi

evidence_text() {
  printf 'version=%s\nsource_sha256=%s\npatch_commit=%s\npatch_sha256=%s\nfingerprint=%s\nbinary_sha256=%s\n' \
    "$source_version" "$source_sha256" "$upstream_patch_commit" "$patch_sha256" "$fingerprint" "$1"
}
# A cache is only a copy of an earlier build of exactly these inputs, written by a
# trusted main-branch job; it must still be a canonical, private, complete ELF build.
verify_cache() {
  local dir=$1 binary actual
  [[ "$dir" == /* && -d "$dir" && ! -L "$dir" && -O "$dir" ]] || return 1
  [[ "$(cd -- "$dir" && pwd -P)" == "$dir" ]] || return 1
  [[ "$(find "$dir" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort | tr '\n' ' ')" == 'build-evidence.txt gnome-keyring-daemon ' ]] || return 1
  binary="$dir/gnome-keyring-daemon"
  for file in "$binary" "$dir/build-evidence.txt"; do
    [[ -f "$file" && ! -L "$file" && -O "$file" ]] || return 1
  done
  [[ "$(head -c 4 -- "$binary" | od -An -tx1 | tr -d ' \n')" == 7f454c46 ]] || return 1
  actual=$(sha256sum -- "$binary"); actual=${actual%% *}
  [[ "$(cat -- "$dir/build-evidence.txt")" == "$(evidence_text "$actual")" ]] || return 1
  if command -v ldd >/dev/null && ldd -- "$binary" 2>&1 | grep -q 'not found'; then return 1; fi
  return 0
}
if [[ "$mode" == verify ]]; then
  if verify_cache "$verify_dir"; then echo 'Verified cached GNOME test keyring build.' >&2; exit 0; fi
  echo 'The cached GNOME test keyring build is absent, incomplete or bound to different inputs.' >&2
  exit 1
fi
cache_dir=${STRATA_TEST_KEYRING_CACHE:-}
if [[ -n "$cache_dir" && "$cache_dir" != /* ]]; then
  echo 'STRATA_TEST_KEYRING_CACHE must be an absolute directory.' >&2
  exit 2
fi


# Every build owns a fresh private directory. There is no sudo/install step or
# fallback to an unpatched daemon after a build failure; an invalid cache is ignored.
build_root=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/strata-test-keyring-build.XXXXXX")
archive="$build_root/gnome-keyring-$source_version.tar.xz"
prefix="$build_root/prefix"
daemon="$prefix/bin/gnome-keyring-daemon"
if [[ -n "$cache_dir" && -e "$cache_dir" ]]; then
  if verify_cache "$cache_dir"; then
    mkdir -m 700 -p "$prefix/bin"
    cp -- "$cache_dir/gnome-keyring-daemon" "$daemon"
    chmod 700 "$daemon"
    binary_sha256=$(sha256sum -- "$daemon"); binary_sha256=${binary_sha256%% *}
    if [[ "$(evidence_text "$binary_sha256")" == "$(cat -- "$cache_dir/build-evidence.txt")" ]]; then
      evidence_text "$binary_sha256" >"$prefix/build-evidence.txt"
      echo "Reusing the verified cached GNOME Keyring $source_version build (inputs $fingerprint); daemon SHA256: $binary_sha256" >&2
      printf '%s\n' "$daemon"
      exit 0
    fi
    rm -f -- "$daemon"
  fi
  echo 'Ignoring an unverifiable GNOME test keyring cache; building from the pinned source.' >&2
fi
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
evidence_text "$binary_sha256" >"$prefix/build-evidence.txt"
echo "Isolated GNOME test daemon SHA256: $binary_sha256" >&2
# Fill only an absent or empty private cache directory (never delete or overwrite
# anything); only a trusted main-branch job saves it with actions/cache.
if [[ -n "$cache_dir" && ( ! -e "$cache_dir" || -d "$cache_dir" && ! -L "$cache_dir" && -z "$(ls -A -- "$cache_dir")" ) ]]; then
  mkdir -m 700 -p -- "$cache_dir"
  cp -- "$daemon" "$cache_dir/gnome-keyring-daemon"
  cp -- "$prefix/build-evidence.txt" "$cache_dir/build-evidence.txt"
  verify_cache "$cache_dir" || { echo 'The fresh GNOME test keyring cache copy failed verification.' >&2; exit 1; }
fi
# The only stdout is the absolute binary path, suitable for GITHUB_ENV.
printf '%s\n' "$daemon"
