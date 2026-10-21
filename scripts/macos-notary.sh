#!/usr/bin/env bash
# macOS notarization helpers shared by ci.yml and macos-notarize-followup.
#
# Only the .app is notarized and stapled; the DMG is rebuilt around the stapled
# app and Developer ID signed (never notarized itself).
#
# Exit codes: 0 ok; 75 = Apple could not be reached after 3 attempts 30 s apart
# (a ::warning:: was printed, the caller decides whether that means "try later");
# anything else = a real failure (wrong identity, Invalid/Rejected, bad bytes).
#
# Deliberately no `set -e`: every command's status is checked explicitly so a
# network blip is retried instead of aborting on the first error.
# Notary auth comes from STRATA_NOTARY_KEY_PATH / _KEY_ID / _ISSUER; the
# commands are never echoed, and the key file never is.
set -uo pipefail

NET_UNRESOLVED=75
NET_RE='NSURLErrorDomain|-1001|-1005|-1009|offline|timed out|network connection|CloudKit|Could not connect|could not be reached|Could not resolve|unable to reach'
RETRY_DELAY="${STRATA_NET_RETRY_DELAY:-30}"
NET_OUT=''

is_network() { printf '%s' "$1" | grep -Eqi -- "$NET_RE"; }

# net_retry NAME cmd...: output of the last attempt in NET_OUT (also printed).
net_retry() {
  local name=$1 i status; shift
  for i in 1 2 3; do
    NET_OUT=$("$@" 2>&1); status=$?
    [ -n "$NET_OUT" ] && printf '%s\n' "$NET_OUT" >&2
    [ "$status" -eq 0 ] && return 0
    if ! is_network "$NET_OUT"; then echo "::error title=$name::$name failed (exit $status)." >&2; return "$status"; fi
    if [ "$i" -lt 3 ]; then echo "$name: network error (attempt $i/3), retrying in ${RETRY_DELAY}s" >&2; sleep "$RETRY_DELAY"; fi
  done
  echo "::warning title=$name::$name could not reach Apple after 3 attempts (runner network)." >&2
  return "$NET_UNRESOLVED"
}

auth() {
  [ -n "${STRATA_NOTARY_KEY_PATH:-}" ] && [ -n "${STRATA_NOTARY_KEY_ID:-}" ] && [ -n "${STRATA_NOTARY_ISSUER:-}" ] \
    || { echo '::error::Notary API credentials are missing.' >&2; return 1; }
  AUTH=(--key "$STRATA_NOTARY_KEY_PATH" --key-id "$STRATA_NOTARY_KEY_ID" --issuer "$STRATA_NOTARY_ISSUER")
}
json_field() { python3 -c 'import json,sys
try: v = json.loads(sys.stdin.read()).get(sys.argv[1], "")
except Exception: v = ""
print(v if isinstance(v, str) else "")' "$1"; }
cdhash() { codesign -dv --verbose=4 "$1" 2>&1 | sed -n 's/^CDHash=//p' | head -n1 | tr 'A-F' 'a-f'; }

# status ID -> prints Accepted / In Progress / Invalid / Rejected
cmd_status() {
  auth || return 1
  net_retry 'notarytool info' xcrun notarytool info "$1" "${AUTH[@]}" --output-format json; local rc=$?
  [ "$rc" -eq 0 ] || return "$rc"
  local status; status=$(printf '%s' "$NET_OUT" | json_field status)
  [ -n "$status" ] || { echo '::error::notarytool info returned no status.' >&2; return 1; }
  printf '%s\n' "$status"
}

# wait ID SECONDS -> waits (re-waiting after network drops) and prints the final status.
cmd_wait() {
  auth || return 1
  local id=$1 deadline=$((SECONDS + $2)) left out status rc drops=0
  while :; do
    left=$((deadline - SECONDS)); [ "$left" -gt 0 ] || left=1
    out=$(xcrun notarytool wait "$id" "${AUTH[@]}" --timeout "${left}s" 2>&1)
    status=$(cmd_status "$id"); rc=$?
    [ "$rc" -eq 0 ] || return "$rc"
    if [ "$status" = 'In Progress' ] && [ "$SECONDS" -lt "$deadline" ] && is_network "$out" && [ "$drops" -lt 3 ]; then
      drops=$((drops + 1)); echo "notarytool wait: network error ($drops/3), waiting again in ${RETRY_DELAY}s" >&2; sleep "$RETRY_DELAY"; continue
    fi
    printf '%s\n' "$status"; return 0
  done
}

# log ID [FILE]: print (or save) Apple's notary log.
cmd_log() { auth || return 1; xcrun notarytool log "$1" "${AUTH[@]}" ${2:+"$2"}; }

# staple-app APP: staple the ticket; offline-check it; online checks only warn on network errors.
cmd_staple_app() {
  local app=$1 rc
  net_retry 'stapler staple' xcrun stapler staple "$app"; rc=$?
  [ "$rc" -eq 0 ] || return "$rc"
  test -s "$app/Contents/CodeResources" || { echo '::error::The app has no stapled ticket.' >&2; return 1; }
  codesign --verify --deep --strict --verbose=2 "$app" || return 1
  net_retry 'stapler validate' xcrun stapler validate "$app"; rc=$?
  [ "$rc" -eq 0 ] || [ "$rc" -eq "$NET_UNRESOLVED" ] || return "$rc"
  net_retry spctl spctl --assess --type execute --verbose=4 "$app"; rc=$?
  [ "$rc" -eq 0 ] || [ "$rc" -eq "$NET_UNRESOLVED" ] || return "$rc"
  return 0
}

developer_id() { # PATH TEAM
  local info; info=$(codesign -dv --verbose=4 "$1" 2>&1) || { echo "::error::$1 is not signed." >&2; return 1; }
  printf '%s\n' "$info" | grep -q '^Authority=Developer ID Application:' || { echo "::error::$1 is not Developer ID signed." >&2; return 1; }
  printf '%s\n' "$info" | grep -qx "TeamIdentifier=$2" || { echo "::error::$1 is not signed by team $2." >&2; return 1; }
}

# verify-dmg DMG CDHASH TEAM: Developer ID signed DMG whose app is the notarized app with its ticket.
cmd_verify_dmg() {
  local dmg=$1 want=$2 team=$3 mnt ok=1 app
  codesign --verify --strict --verbose=2 "$dmg" || return 1
  developer_id "$dmg" "$team" || return 1
  mnt=$(mktemp -d)
  hdiutil attach "$dmg" -readonly -nobrowse -noautoopen -mountpoint "$mnt" -quiet || { rmdir "$mnt"; return 1; }
  app="$mnt/Strata Manager.app"
  if [ -d "$app" ] && [ "$(cdhash "$app")" = "$want" ] && test -s "$app/Contents/CodeResources" \
     && codesign --verify --deep --strict "$app" && developer_id "$app" "$team"; then ok=0
  else echo '::error::The DMG does not hold the notarized, stapled app.' >&2; fi
  hdiutil detach "$mnt" -quiet || hdiutil detach "$mnt" -force -quiet
  rmdir "$mnt" 2>/dev/null
  return "$ok"
}

# restage-dmg DMG APP IDENTITY TEAM: put the stapled APP into DMG (keeping its
# layout), then Developer ID sign the DMG. The DMG's app must have APP's CDHash.
cmd_restage_dmg() {
  local dmg=$1 app=$2 identity=$3 team=$4 work mnt want sectors ok=1 rc
  want=$(cdhash "$app"); [ -n "$want" ] || return 1
  test -s "$app/Contents/CodeResources" || { echo '::error::The app is not stapled.' >&2; return 1; }
  work=$(mktemp -d); mnt="$work/mnt"; mkdir "$mnt"
  hdiutil convert "$dmg" -format UDRW -o "$work/rw.dmg" -quiet || return 1
  sectors=$(hdiutil resize -limits "$work/rw.dmg" | tail -n1 | awk '{print $2}')
  [[ "$sectors" =~ ^[0-9]+$ ]] && hdiutil resize -sectors $((sectors + 40960)) "$work/rw.dmg" || return 1
  hdiutil attach "$work/rw.dmg" -nobrowse -noautoopen -mountpoint "$mnt" -quiet || return 1
  if [ -d "$mnt/Strata Manager.app" ] && [ "$(cdhash "$mnt/Strata Manager.app")" = "$want" ]; then
    rm -rf "$mnt/Strata Manager.app" && ditto "$app" "$mnt/Strata Manager.app" && ok=0
  else echo '::error::The DMG does not contain the notarized app.' >&2; fi
  hdiutil detach "$mnt" -quiet || hdiutil detach "$mnt" -force -quiet || return 1
  [ "$ok" -eq 0 ] || return 1
  hdiutil convert "$work/rw.dmg" -format UDZO -imagekey zlib-level=9 -o "$work/out.dmg" -quiet || return 1
  net_retry 'codesign DMG' codesign --force --sign "$identity" --timestamp "$work/out.dmg"; rc=$?
  [ "$rc" -eq 0 ] || return "$rc"
  cmd_verify_dmg "$work/out.dmg" "$want" "$team" || return 1
  mv -f "$work/out.dmg" "$dmg" && rm -rf "$work"
}

case "${1:-}" in
  retry) shift; net_retry "$@" ;;
  status) cmd_status "$2" ;;
  wait) cmd_wait "$2" "$3" ;;
  log) cmd_log "$2" "${3:-}" ;;
  staple-app) cmd_staple_app "$2" ;;
  verify-dmg) cmd_verify_dmg "$2" "$3" "$4" ;;
  restage-dmg) cmd_restage_dmg "$2" "$3" "$4" "$5" ;;
  *) echo 'usage: macos-notary.sh retry|status|wait|log|staple-app|verify-dmg|restage-dmg ...' >&2; exit 2 ;;
esac
