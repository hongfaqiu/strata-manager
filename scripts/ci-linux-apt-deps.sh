#!/usr/bin/env bash
# Install the Linux build and headless test dependencies for CI.
#
#   ci-linux-apt-deps.sh key            print the cache key for the downloaded .deb files
#   ci-linux-apt-deps.sh install DIR    install, reusing/collecting .deb files in DIR
#
# The workflow restores DIR with actions/cache/restore and only trusted main pushes save it.
# On a cache hit the cached archives are installed offline with the normal apt/dpkg
# maintainer scripts (keyring, dbus, xvfb, webkit triggers all run as usual), so only the
# mirror download is skipped. Any problem falls back to the ordinary online install.
set -euo pipefail

# Keep this list the single source of truth: the cache key hashes this file.
PACKAGES=(
  libwebkit2gtk-4.1-dev libappindicator3-dev libgtk-3-dev libssl-dev librsvg2-dev libxdo-dev
  libdbus-1-dev pkg-config patchelf xdg-utils xvfb dbus-x11 gnome-keyring libglib2.0-bin
  libsecret-tools python3-venv python3-dbus build-essential curl gettext libgcr-3-dev
  libgcrypt20-dev libtasn1-6-dev libp11-kit-dev libcap-ng-dev
)

script_hash() { sha256sum "${BASH_SOURCE[0]}" | cut -c1-16; }

case "${1:-}" in
  key)
    # The runner image version pins the preinstalled package set the archives were resolved against.
    . /etc/os-release
    printf 'linux-apt-v1-%s-%s-%s-%s-%s\n' "${ID}${VERSION_ID}" "${ImageOS:-unknown}" "${ImageVersion:-unknown}" \
      "$(dpkg --print-architecture)" "$(script_hash)"
    ;;
  install)
    dir=${2:?usage: ci-linux-apt-deps.sh install DIR}
    export DEBIAN_FRONTEND=noninteractive
    # Skip the man-db index rebuild trigger; CI never reads man pages.
    sudo rm -f /var/lib/man-db/auto-update
    apt_opts=(-y -o Dpkg::Use-Pty=0)
    missing() {
      local pkg
      for pkg in "${PACKAGES[@]}"; do
        [[ "$(dpkg-query -W -f='${db:Status-Status}' "$pkg" 2>/dev/null || true)" == installed ]] || echo "$pkg"
      done
    }
    shopt -s nullglob
    debs=("$dir"/*.deb)
    if ((${#debs[@]})); then
      echo "Installing ${#debs[@]} cached archives offline from $dir"
      if sudo apt-get install "${apt_opts[@]}" --no-download "${debs[@]}" && [[ -z "$(missing)" ]]; then
        echo 'Cached apt archives installed.'
        exit 0
      fi
      echo '::warning::Cached apt archives were incomplete; falling back to the online install.'
    fi
    mkdir -p "$dir/partial"
    sudo apt-get update
    # Download into DIR (not /var/cache/apt/archives) so exactly this install's archives are cached.
    sudo apt-get install "${apt_opts[@]}" -o Dir::Cache::Archives="$dir" "${PACKAGES[@]}"
    sudo rm -rf "$dir/partial" "$dir/lock"
    sudo chown -R "$(id -u):$(id -g)" "$dir"
    left=$(missing)
    [[ -z "$left" ]] || { echo "::error::Packages not installed: $left"; exit 1; }
    echo "Collected $(ls "$dir"/*.deb 2>/dev/null | wc -l) archives ($(du -sh "$dir" | cut -f1)) in $dir"
    ;;
  *) echo 'usage: ci-linux-apt-deps.sh key | install DIR' >&2; exit 2 ;;
esac
