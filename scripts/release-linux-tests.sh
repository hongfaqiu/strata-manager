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
export GNOME_KEYRING_CONTROL="$session_dir/control"
mkdir -m 700 "$XDG_DATA_HOME" "$XDG_RUNTIME_DIR" "$GNOME_KEYRING_CONTROL"
# dbus-run-session was started by the caller before these private paths existed.
# Its activation environment must never fall back to the runner's login keyring.
dbus-update-activation-environment XDG_DATA_HOME XDG_RUNTIME_DIR GNOME_KEYRING_CONTROL

bus=(gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus)
owner_pattern="^\\('(:[0-9]+\\.[0-9]+)',\\)$"
pid_pattern='^\(uint32 ([0-9]+),\)$'
expected_owner=''
monitor_pid=''
keyring_pid=''
owner_reason=''

read_owner() {
  local result
  if ! result=$(timeout 2s "${bus[@]}" --method org.freedesktop.DBus.GetNameOwner org.freedesktop.secrets 2>&1); then
    owner_reason="Secret Service owner unavailable: $result"
    return 1
  fi
  if [[ ! "$result" =~ $owner_pattern ]]; then
    owner_reason="Unexpected Secret Service owner reply: $result"
    return 1
  fi
  current_owner=${BASH_REMATCH[1]}
}
verify_owner() {
  local result
  if ! kill -0 "$keyring_pid" 2>/dev/null; then
    owner_reason="Owned Secret Service daemon $keyring_pid exited."
    return 1
  fi
  read_owner || return 1
  if [[ -n "$expected_owner" && "$current_owner" != "$expected_owner" ]]; then
    owner_reason="Secret Service owner changed: expected $expected_owner, got $current_owner."
    return 1
  fi
  if ! result=$(timeout 2s "${bus[@]}" --method org.freedesktop.DBus.GetConnectionUnixProcessID "$current_owner" 2>&1); then
    owner_reason="Secret Service owner PID unavailable: $result"
    return 1
  fi
  if [[ ! "$result" =~ $pid_pattern ]]; then
    owner_reason="Unexpected Secret Service owner PID reply: $result"
    return 1
  fi
  if [[ "${BASH_REMATCH[1]}" != "$keyring_pid" ]]; then
    owner_reason="Secret Service owner PID mismatch: expected $keyring_pid, got ${BASH_REMATCH[1]}."
    return 1
  fi
}
diagnostics() {
  local actual_owner
  echo "Secret Service diagnostic: owned PID=${keyring_pid:-not-started}; expected owner=${expected_owner:-not-bound}; control=$GNOME_KEYRING_CONTROL" >&2
  if read_owner; then
    actual_owner=$current_owner
    echo "Secret Service diagnostic: current owner=$actual_owner" >&2
    timeout 2s "${bus[@]}" --method org.freedesktop.DBus.GetConnectionUnixProcessID "$actual_owner" >&2 || true
    # Address the existing unique connection; diagnostics must not activate a replacement.
    timeout 2s gdbus call --session --dest "$actual_owner" --object-path /org/freedesktop/secrets \
      --method org.freedesktop.Secret.Service.ReadAlias default >&2 || true
    timeout 2s gdbus call --session --dest "$actual_owner" --object-path /org/freedesktop/secrets/collection/login \
      --method org.freedesktop.DBus.Properties.Get org.freedesktop.Secret.Collection Locked >&2 || true
  else
    echo "Secret Service diagnostic: $owner_reason" >&2
  fi
}
record_owner_failure() {
  printf '%s\n' "$owner_reason" >"$session_dir/monitor.failure"
  echo "Secret Service isolation failed: $owner_reason" >&2
  diagnostics
}
owned_daemon_active() {
  local candidate
  # Include stopped jobs, which also need to be released during cleanup.
  for candidate in $(jobs -pr) $(jobs -ps); do
    if [[ "$candidate" == "$keyring_pid" ]]; then
      return 0
    fi
  done
  return 1
}
cleanup() {
  local status=$? daemon_status='not-started' attempt
  trap - EXIT
  trap '' INT TERM
  set +e
  touch "$session_dir/monitor.stop"
  if [[ -n "$monitor_pid" ]]; then
    wait "$monitor_pid"
  fi
  diagnostics
  if [[ -n "$keyring_pid" ]]; then
    # Only the daemon launched by this shell is stopped; the test command and
    # desktop/system services are never signalled by this wrapper.
    if owned_daemon_active; then
      kill "$keyring_pid" 2>/dev/null
      for attempt in {1..20}; do
        if ! owned_daemon_active; then
          break
        fi
        sleep 0.1
      done
      if owned_daemon_active; then
        echo "Secret Service cleanup: owned daemon $keyring_pid did not stop after TERM; sending KILL to this shell job." >&2
        kill -KILL "$keyring_pid" 2>/dev/null
      fi
    fi
    wait "$keyring_pid"
    daemon_status=$?
  fi
  echo "Secret Service daemon exit status: $daemon_status; command/wrapper exit status: $status" >&2
  echo 'Secret Service daemon stdout:' >&2
  cat "$session_dir/daemon.stdout" >&2 2>/dev/null
  echo 'Secret Service daemon stderr:' >&2
  cat "$session_dir/daemon.stderr" >&2 2>/dev/null
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

gnome-keyring-daemon \
  --foreground --unlock --components=secrets --control-directory "$session_dir/control" \
  < <(printf '%s' 'strata-manager-ci-fixture') \
  >"$session_dir/daemon.stdout" 2>"$session_dir/daemon.stderr" &
keyring_pid=$!

gdbus wait --session --timeout 10 org.freedesktop.secrets
if ! verify_owner; then
  record_owner_failure
  exit 70
fi
expected_owner=$current_owner
service=(gdbus call --session --dest "$expected_owner" --object-path /org/freedesktop/secrets)
"${service[@]}" --method org.freedesktop.Secret.Service.SetAlias \
  default /org/freedesktop/secrets/collection/login >/dev/null
default_alias=$("${service[@]}" --method org.freedesktop.Secret.Service.ReadAlias default)
if [[ "$default_alias" != *"/org/freedesktop/secrets/collection/login"* ]]; then
  echo 'Secret Service default alias does not point to the isolated login collection.' >&2
  exit 1
fi
locked=$(gdbus call --session --dest "$expected_owner" \
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
if ! verify_owner; then
  record_owner_failure
  exit 70
fi
echo "Isolated Secret Service: unlocked login/default collection; store/read/delete verified; owner $expected_owner PID $keyring_pid."
(
  trap - EXIT INT TERM
  while [[ ! -e "$session_dir/monitor.stop" ]]; do
    if ! verify_owner; then
      record_owner_failure
      exit 1
    fi
    sleep 0.5
  done
) &
monitor_pid=$!
"$@" <&0 &
command_pid=$!
if wait "$command_pid"; then
  command_status=0
else
  command_status=$?
fi
touch "$session_dir/monitor.stop"
wait "$monitor_pid" || true
monitor_pid=''
if ! verify_owner; then
  record_owner_failure
fi
# A failing cargo/smoke command keeps its original exit code even if the private
# daemon also failed. A successful command cannot conceal broken isolation.
if [[ $command_status -ne 0 ]]; then
  exit "$command_status"
fi
if [[ -s "$session_dir/monitor.failure" ]]; then
  exit 70
fi
