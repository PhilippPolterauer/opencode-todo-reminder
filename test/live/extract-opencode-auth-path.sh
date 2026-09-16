#!/bin/sh
# extract-opencode-auth-path.sh
#
# Finds the real, live opencode auth.json on this host and prints its
# absolute path - so `docker-up` doesn't need OPENCODE_AUTH_JSON_HOST_PATH
# hand-typed every time. Mirrors opencode-model-eval's own
# scripts/extract-opencode-key.sh in spirit (locate real host credentials,
# never fabricate or cache them), but simpler: this test needs the whole
# file mounted read-only (entrypoint.sh's own auth check, confirmed by
# reading it), not one extracted key.
#
# Never prints the file's CONTENT - only its path. The path itself is not
# a secret; the file it points at is, and this script never opens it.
set -eu

# opencode's own documented location (confirmed by reading
# opencode-model-eval's entrypoint.sh, which checks exactly this path
# inside its own container - same relative location under a real $HOME).
CANDIDATE="${HOME}/.local/share/opencode/auth.json"

if [ ! -f "$CANDIDATE" ]; then
    echo "FATAL: no opencode auth.json found at $CANDIDATE" >&2
    echo "Run 'opencode auth login' (or whatever this host's real setup" >&2
    echo "uses) first, or pass the correct path directly:" >&2
    echo "    OPENCODE_AUTH_JSON_HOST_PATH=/real/path make docker-up" >&2
    exit 1
fi

# Absolute, not relative - docker compose's volume mount needs an
# absolute host path to resolve correctly regardless of cwd.
case "$CANDIDATE" in
    /*) printf '%s\n' "$CANDIDATE" ;;
    *) printf '%s/%s\n' "$(pwd)" "$CANDIDATE" ;;
esac
