#!/usr/bin/env bash
# Run native fixtures with a real, isolated Secret Service collection.
set -euo pipefail

if [[ $# -eq 0 || -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]]; then
  echo 'Usage: dbus-run-session -- xvfb-run -a bash scripts/release-linux-tests.sh <test command>' >&2
  exit 2
fi

# Never read the desktop login keyring: the runner starts with an empty private
# data directory. This fixed password is only for disposable CI fixture data.
session_dir=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/strata-keyring.XXXXXX")
export XDG_DATA_HOME="$session_dir/data"
export XDG_RUNTIME_DIR="$session_dir/runtime"
mkdir -m 700 "$XDG_DATA_HOME" "$XDG_RUNTIME_DIR" "$session_dir/control"
printf '%s' 'strata-manager-ci-fixture' | gnome-keyring-daemon \
  --foreground --unlock --components=secrets --control-directory "$session_dir/control" \
  >"$session_dir/daemon.stdout" 2>"$session_dir/daemon.stderr" &
keyring_pid=$!
cleanup() {
  kill "$keyring_pid" 2>/dev/null || true
  wait "$keyring_pid" 2>/dev/null || true
}
trap cleanup EXIT

gdbus wait --session --timeout 10 org.freedesktop.secrets
service=(gdbus call --session --dest org.freedesktop.secrets --object-path /org/freedesktop/secrets)
"${service[@]}" --method org.freedesktop.Secret.Service.SetAlias \
  default /org/freedesktop/secrets/collection/login >/dev/null
default_alias=$("${service[@]}" --method org.freedesktop.Secret.Service.ReadAlias default)
if [[ "$default_alias" != *"/org/freedesktop/secrets/collection/login"* ]]; then
  echo 'Secret Service default alias does not point to the isolated login collection.' >&2
  exit 1
fi
locked=$(gdbus call --session --dest org.freedesktop.secrets \
  --object-path /org/freedesktop/secrets/collection/login \
  --method org.freedesktop.DBus.Properties.Get org.freedesktop.Secret.Collection Locked)
if [[ "$locked" != '(<false>,)' ]]; then
  echo 'The isolated Secret Service login collection is locked.' >&2
  exit 1
fi

# Prove the real backend can store/read/delete, then leave the collection empty.
printf '%s' 'fixture-value' | timeout 10s secret-tool store \
  --label='Strata Manager CI fixture' strata-manager-ci fixture
fixture_value=$(timeout 10s secret-tool lookup strata-manager-ci fixture)
if [[ "$fixture_value" != 'fixture-value' ]]; then
  echo 'Secret Service fixture read did not match the stored value.' >&2
  exit 1
fi
timeout 10s secret-tool clear strata-manager-ci fixture
if timeout 10s secret-tool lookup strata-manager-ci fixture >/dev/null; then
  echo 'Secret Service fixture was not deleted.' >&2
  exit 1
else
  status=$?
  if [[ $status -ne 1 ]]; then
    echo "Secret Service missing-entry check failed (exit $status)." >&2
    exit "$status"
  fi
fi
echo 'Isolated Secret Service: unlocked login/default collection; store/read/delete verified.'
"$@"
