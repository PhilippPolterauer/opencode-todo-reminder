#!/bin/sh
# Single-purpose entrypoint: start `opencode serve` and nothing else.
# Same privilege-drop pattern as opencode-model-eval's entrypoint.sh
# (WORKER_UID/WORKER_GID -> setpriv, no --reset-env so OPENCODE_CONFIG
# and friends survive the drop) - see that file for the full rationale.
# POSIX sh, not bash: same reason as there - no bash in this image.
set -eu

log() {
  printf '[entrypoint] %s\n' "$1" >&2
}

fail() {
  log "FATAL: $1"
  exit 1
}

drop_uid="${WORKER_UID:-${TARGET_UID:-}}"
drop_gid="${WORKER_GID:-${TARGET_GID:-}}"

if [ -n "${drop_uid}" ] && [ -n "${drop_gid}" ] && [ "$(id -u)" = "0" ]; then
  if setpriv --help 2>&1 | grep -q -- '--reuid'; then
    drop_cmd="setpriv --reuid=${drop_uid} --regid=${drop_gid} --clear-groups"
  elif command -v su-exec >/dev/null 2>&1; then
    drop_cmd="su-exec ${drop_uid}:${drop_gid}"
  else
    fail "WORKER_UID/WORKER_GID set but no usable privilege-drop binary"
  fi

  if ! getent passwd "${drop_uid}" >/dev/null 2>&1; then
    getent group "${drop_gid}" >/dev/null 2>&1 || addgroup -g "${drop_gid}" harness
    adduser -u "${drop_uid}" -G harness -h "${HOME}" -s /bin/sh -D harness >/dev/null 2>&1
  fi

  opencode_log_dir="${HOME}/.local/share/opencode/log"
  if [ -d "${opencode_log_dir}" ]; then
    chown -R "${drop_uid}:${drop_gid}" "${opencode_log_dir}" 2>/dev/null \
      || log "could not chown ${opencode_log_dir}"
  fi

  log "dropping to ${drop_uid}:${drop_gid}"
  # shellcheck disable=SC2086
  exec ${drop_cmd} "$0" "$@"
fi

readonly PORT="${OPENCODE_SERVE_PORT:-49610}"
readonly HOSTNAME_BIND="${OPENCODE_SERVE_HOSTNAME:-0.0.0.0}"
readonly AUTH_PATH="${HOME}/.local/share/opencode/auth.json"

if ! command -v opencode >/dev/null 2>&1; then
  fail "opencode binary not found on PATH - base image contract changed"
fi

if [ ! -f "${AUTH_PATH}" ]; then
  fail "credentials not found at ${AUTH_PATH} - mount a real auth.json read-only to this path (docker-compose.yml's server service volumes: entry, or run 'make auth-path'). There is no credential-free path for a non-local-Ollama provider."
fi

log "starting opencode serve on ${HOSTNAME_BIND}:${PORT}"
log "OPENCODE_CONFIG resolved to: ${OPENCODE_CONFIG}"
exec opencode serve --port "${PORT}" --hostname "${HOSTNAME_BIND}" --print-logs
