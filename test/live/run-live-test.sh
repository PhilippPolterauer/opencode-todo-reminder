#!/bin/sh
# run-live-test.sh
#
# Single-command version of the two-shell-window workflow documented in
# README.md: start the server detached, run the live test against it,
# capture everything, tear down - regardless of whether the test itself
# succeeds. A `trap ... EXIT` guarantees the teardown+log-capture runs
# even if the client errors or this script is interrupted, which a plain
# sequence of Makefile recipe lines cannot guarantee (each recipe line is
# its own shell invocation, and a mid-sequence failure would leave the
# server running with nothing captured).
#
# Requires OPENCODE_MODEL and OPENCODE_AUTH_JSON_HOST_PATH, same as
# docker-up - see extract-opencode-auth-path.sh / `make auth-path` for
# the latter.
set -eu

log() {
    printf '[run-live-test] %s\n' "$1" >&2
}

: "${OPENCODE_MODEL:?set OPENCODE_MODEL, e.g. OPENCODE_MODEL=opencode/big-pickle}"
: "${OPENCODE_AUTH_JSON_HOST_PATH:?set OPENCODE_AUTH_JSON_HOST_PATH, or run: export OPENCODE_AUTH_JSON_HOST_PATH=\$(./extract-opencode-auth-path.sh)}"
export OPENCODE_MODEL OPENCODE_AUTH_JSON_HOST_PATH

COMPOSE="${COMPOSE:-docker compose}"
RESULTS_DIR="results"

# Rotates any existing results/ to a UTC-timestamped SIBLING before this run
# starts - same approach opencode-model-eval's own eval client uses ("results
# dirs rotate to a UTC-timestamped sibling before a rerun instead of
# overwriting in place"). Each run therefore gets a complete, isolated,
# dated snapshot (workspace content, logs, .opencode/, the report) - nothing
# is ever deleted, and nothing accumulates across runs inside one directory.
# This replaces two earlier, narrower approaches: selectively deleting
# workspace content at teardown (worked, but discarded history), and
# inserting a divider into the plugin log for multi-run accumulation (no
# longer needed - each run's log is its own fresh file now).
if [ -d "$RESULTS_DIR" ] && [ -n "$(ls -A "$RESULTS_DIR" 2>/dev/null)" ]; then
    ARCHIVE_TS="$(date -u +%Y%m%dT%H%M%SZ)"
    log "rotating existing ${RESULTS_DIR}/ to ${RESULTS_DIR}-${ARCHIVE_TS}/ before this run"
    mv "$RESULTS_DIR" "${RESULTS_DIR}-${ARCHIVE_TS}"
fi

LOG_DIR="${RESULTS_DIR}/logs"
SERVER_LOG="${LOG_DIR}/server.log"
REPORT_FILE="${RESULTS_DIR}/livetest-report.json"
CLIENT_EXIT=0
SERVER_UP=0

mkdir -p "$LOG_DIR"

teardown() {
    # Always capture the server's logs before it's gone, and always bring
    # it down - runs on any exit path (normal, error, or signal), not just
    # the success path. A server left running after a failed run is a
    # stale, silently-occupied port the next attempt trips over.
    if [ "$SERVER_UP" = "1" ]; then
        log "capturing server logs to ${SERVER_LOG}"
        $COMPOSE logs --no-color server > "$SERVER_LOG" 2>&1 || log "log capture itself failed (non-fatal)"
        log "tearing down"
        $COMPOSE down >/dev/null 2>&1 || log "docker compose down itself failed (non-fatal)"
    fi

    log "=== SUMMARY ==="
    log "client exit code: ${CLIENT_EXIT}"
    log "artifacts written:"
    for f in "$SERVER_LOG" "${RESULTS_DIR}/.opencode/todo-reminder.log" "$REPORT_FILE"; do
        if [ -f "$f" ]; then
            log "  $f ($(wc -c < "$f") bytes)"
        else
            log "  $f (not written - see above for why)"
        fi
    done
    if [ -f "${RESULTS_DIR}/.opencode/todo-reminder.log" ]; then
        log "--- plugin debug log tail ---"
        tail -40 "${RESULTS_DIR}/.opencode/todo-reminder.log" >&2
    fi
}
trap teardown EXIT

log "building and starting server detached"
$COMPOSE up -d --build
SERVER_UP=1

log "running live test client (it waits for the server itself, no separate readiness loop needed here)"
set +e
python3 run_livetest.py --out "$REPORT_FILE"
CLIENT_EXIT=$?
set -e

exit "$CLIENT_EXIT"
