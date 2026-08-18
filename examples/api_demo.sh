#!/usr/bin/env bash
#
# Exercise every endpoint of the usbpower REST API.
#
#   ./examples/api_demo.sh [base-url]
#
# Default base URL is http://127.0.0.1:9090
#
# This physically switches the relays: each channel is turned on, off,
# toggled, pulsed with an auto-off timer, and power-cycled. Do not run it
# against a board driving a load you care about. Everything is returned to
# the OFF state at the end.
#
set -uo pipefail

BASE="${1:-http://127.0.0.1:9090}"
PASS=0
FAIL=0

if ! command -v curl >/dev/null; then
    echo "curl is required" >&2; exit 1
fi
JQ=cat
command -v jq >/dev/null && JQ="jq ."

hr() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

# call <METHOD> <PATH> [JSON-BODY]
call() {
    local method="$1" path="$2" body="${3:-}"
    local out code

    printf '\n\033[36m%s %s\033[0m' "$method" "$path"
    [[ -n "$body" ]] && printf '  \033[90m%s\033[0m' "$body"
    printf '\n'

    if [[ -n "$body" ]]; then
        out=$(curl -sS -X "$method" "$BASE$path" \
              -H 'Content-Type: application/json' \
              -d "$body" -w '\n%{http_code}' 2>&1)
    else
        out=$(curl -sS -X "$method" "$BASE$path" -w '\n%{http_code}' 2>&1)
    fi

    code=$(tail -n1 <<<"$out")
    sed '$d' <<<"$out" | $JQ

    if [[ "$code" =~ ^2 ]]; then
        PASS=$((PASS + 1))
    else
        FAIL=$((FAIL + 1))
        printf '\033[31m   -> HTTP %s\033[0m\n' "$code"
    fi
}

# expect_fail <METHOD> <PATH> [BODY] -- a 4xx here is the correct behaviour
expect_fail() {
    local method="$1" path="$2" body="${3:-}" out code
    printf '\n\033[36m%s %s\033[0m \033[90m(expecting rejection)\033[0m\n' \
           "$method" "$path"
    if [[ -n "$body" ]]; then
        out=$(curl -sS -X "$method" "$BASE$path" \
              -H 'Content-Type: application/json' -d "$body" \
              -w '\n%{http_code}' 2>&1)
    else
        out=$(curl -sS -X "$method" "$BASE$path" -w '\n%{http_code}' 2>&1)
    fi
    code=$(tail -n1 <<<"$out")
    sed '$d' <<<"$out" | $JQ
    if [[ "$code" =~ ^4 ]]; then
        PASS=$((PASS + 1))
    else
        FAIL=$((FAIL + 1))
        printf '\033[31m   -> expected 4xx, got HTTP %s\033[0m\n' "$code"
    fi
}

echo "usbpower REST API demo against $BASE"

hr "Service discovery and health"
call GET /api
call GET /api/health

hr "Device information"
call GET /api/config
call GET /api/help

hr "Reading state"
call GET /api/status
call GET /api/pins
call GET /api/pins/d4

hr "Pin aliases"
call GET    /api/aliases
call POST   /api/aliases/d7 '{"alias": "drone_203"}'
call GET    /api/aliases/d7
call GET    /api/pins/drone_203
call POST   /api/raw '{"command": "status drone_203"}'
call DELETE /api/aliases/drone_203

hr "Start from a known state"
call POST /api/reset
call DELETE /api/log

hr "Single pin on / off"
call POST /api/pins/d4/on
call GET  /api/pins/d4
call POST /api/pins/d4/off

hr "Idempotent commands report 'already', not silence"
call POST /api/pins/d4/off
call POST /api/pins/d4/on
call POST /api/pins/d4/on
call POST /api/pins/d4/off

hr "Toggle"
call POST /api/pins/d5/toggle
call POST /api/pins/d5/toggle

hr "Timed pulse: on with auto-off after 3s"
call POST /api/pins/d6/on '{"seconds": 3}'
call GET  /api/pins/d6
echo "   ... waiting 4s for the auto-off timer ..."
sleep 4
call GET /api/pins/d6
call GET /api/events

hr "Power cycle: off for 2s, then back on"
call POST /api/pins/d7/on
call POST /api/pins/d7/cycle '{"seconds": 2}'
call GET  /api/pins/d7
echo "   ... waiting 3s for the cycle to complete ..."
sleep 3
call GET /api/pins/d7
call POST /api/pins/d7/off

hr "All pins at once"
call POST /api/pins/on
call GET  /api/status
call POST /api/pins/off

hr "Event log"
call GET    "/api/log"
call GET    "/api/log?limit=5"
call GET    "/api/log?pin=d4"
call DELETE /api/log
call GET    /api/log

hr "Raw passthrough (any device command)"
call POST /api/raw '{"command": "status"}'
call POST /api/raw '{"command": "pins"}'

hr "Input validation (these should be rejected)"
expect_fail GET  /api/pins/notapin
expect_fail POST /api/pins/d4/on     '{"seconds": -5}'
expect_fail POST /api/pins/d4/toggle '{"seconds": 5}'
expect_fail POST /api/raw            '{"command": ""}'
expect_fail POST /api/raw            '{"command": "boguscommand"}'
expect_fail GET  /api/nosuchroute

hr "Leave the hardware in a safe state"
call POST /api/reset
call GET  /api/status

printf '\n\033[1m===== %d passed, %d failed =====\033[0m\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]] || exit 1
