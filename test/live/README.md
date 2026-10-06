# Live test: opencode-todo-reminder plugin against a real model

Real, long, multi-step coding task run against an actual `opencode serve`
instance with this repo's patched plugin baked in - not unit tests, not a
mock. Verifies the fix series' actual behavior under genuine working
conditions.

## What it does

- Builds an `opencode serve` image from **this checkout** (build context is
  the repo root - whatever's actually in your working tree, pushed or not).
- Runs one real task: build a working Electron app with a UI that queries
  the server's own `/session` endpoint, explicitly told to track it via
  `todowrite`.
- The plugin runs with `debug: true`, so `results/.opencode/todo-reminder.log`
  captures exactly what it did.

## Requirements

- Docker with compose v2.
- A real `auth.json` for whatever `opencode` resolves to as a provider -
  `entrypoint.sh` hard-fails `serve` mode without one for any non-local-
  Ollama provider. `OPENCODE_MODEL` and `OPENCODE_AUTH_JSON_HOST_PATH` both
  have Makefile defaults (`opencode/big-pickle`, and auto-discovery via
  `extract-opencode-auth-path.sh` - never reads the file's contents, only
  its path) - override either the normal way if you need something else:
  `OPENCODE_MODEL=other/model make docker-up`.

## Running it

The simple case, if auth.json is at the standard location and
`opencode/big-pickle` is the right model - no export needed:

```bash
make e2e            # from the repo root, or:
make live-test-full # from here directly - single command, full run, logs captured
```

The manual, two-shell-window version, if you want to watch the server's
own output live while the client runs:

```bash
make docker-up
# in another shell, once the server log shows "starting opencode serve":
make live-test
```

`make auth-path` prints what the default discovery would resolve to,
without starting anything - useful to sanity-check before a run.

## After a run

```bash
cat results/.opencode/todo-reminder.log
cat results/livetest-report.json
```

Check the log for `guardTodoWrite: backfilling dropped unfinished todos`,
`getOrphanedTodoTable: scanned`, and `PROMPT RESULT ERRORED` - the exact
lines the Copilot-review-fix commit's behavior would produce if exercised.

## Why build context is the repo root

The Dockerfile `COPY`s `package.json`/`src/`/etc. directly from the local
checkout rather than cloning from GitHub - this always reflects the real
working tree, including anything not yet pushed. `.dockerignore` at the
repo root excludes `node_modules`/`dist`/`.git`/`test/live/results`.
