#!/usr/bin/env python3
"""Drive one real, long, multi-step task against a live opencode server
to observe the opencode-todo-reminder plugin's fix series under actual
working conditions - not a synthetic/toy scenario.

stdlib urllib only, matching opencode-model-eval's own client
conventions (see its scripts/run_eval_client.py). Mirrors three
behaviours proven necessary the hard way there:
  - extract_reply() raises on info.finish == "error" (a silent empty
    transcript scoring as a false pass, confirmed against a real
    ContextOverflowError there)
  - abort_session() runs on EVERY exception path via a broad except,
    not just the success path - an unaborted session keeps retrying
    server-side forever otherwise
  - results directory does not get silently overwritten

Usage:
    OPENCODE_MODEL=opencode/big-pickle python3 run_livetest.py \
        --server-url http://127.0.0.1:49610

The task itself is deliberately real and substantial: a desktop
Electron app with a web UI that queries this same opencode server's
own HTTP API and displays the result. That's genuinely multi-step
(scaffold, main process, preload, renderer, a real HTTP call, wiring
it together, a basic run/verify step) - the real-world shape this
plugin's reminder logic is meant to help with, not a fabricated one.
"""

import argparse
import json
import sys
import time
import urllib.error
import urllib.request

TASK_PROMPT = """Build a minimal desktop Electron application in this \
directory. Requirements:

1. A working Electron app (package.json with an Electron dependency \
and a start script, a main process file, a preload script using \
contextBridge, and an index.html renderer).
2. The renderer must query THIS opencode server's own HTTP API - GET \
{server_url}/session - and display the raw JSON response in the page \
(e.g. in a <pre> block), with a button to re-fetch it.
3. Use a proper todo list (via the todowrite tool) to track this as a \
multi-step task - scaffolding, main process, preload script, renderer \
UI, the HTTP call, and a final check that the app's files are all \
present and consistent with each other. Keep the todo list updated as \
you actually finish each step, not just at the end.
4. When you believe you're done, list the files you created and \
summarize what each one does.

This is a real, complete implementation, not a stub or placeholder."""


def wait_for_server(server_url: str, timeout_s: int = 60) -> None:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            urllib.request.urlopen(f"{server_url}/session", timeout=3)
            return
        except urllib.error.HTTPError:
            return  # any HTTP response means the server is up and answering
        except Exception:
            time.sleep(2)
    raise SystemExit(f"server at {server_url} never became reachable")


def create_session(server_url: str) -> str:
    req = urllib.request.Request(
        f"{server_url}/session",
        data=b"{}",
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        info = json.loads(resp.read())
    return info["id"]


def send_message(server_url: str, session_id: str, provider_id: str, model_id: str, text: str) -> dict:
    body = json.dumps(
        {
            "model": {"providerID": provider_id, "modelID": model_id},
            "parts": [{"type": "text", "text": text}],
        }
    ).encode()
    req = urllib.request.Request(
        f"{server_url}/session/{session_id}/message",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    # No client-side timeout here on purpose - this is a genuinely long,
    # multi-step real task, not a short probe. The server itself is the
    # thing with a meaningful timeout, if any.
    with urllib.request.urlopen(req, timeout=None) as resp:
        return json.loads(resp.read())


def extract_reply(response: dict) -> str:
    info = response.get("info", {})
    if info.get("finish") == "error":
        raise RuntimeError(f"session errored: {info.get('error')}")
    parts = response.get("parts", [])
    return "\n".join(p.get("text", "") for p in parts if p.get("type") == "text")


def abort_session(server_url: str, session_id: str) -> None:
    try:
        req = urllib.request.Request(
            f"{server_url}/session/{session_id}/abort", data=b"{}", method="POST"
        )
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        print(f"[client] abort_session itself failed (non-fatal): {e}", file=sys.stderr)


def get_todos(server_url: str, session_id: str) -> list:
    with urllib.request.urlopen(f"{server_url}/session/{session_id}/todo", timeout=10) as resp:
        return json.loads(resp.read())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--server-url", default="http://127.0.0.1:49610")
    ap.add_argument("--model", default=None, help="provider/model, e.g. opencode/big-pickle; defaults to $OPENCODE_MODEL")
    ap.add_argument("--out", default="results/livetest-report.json")
    args = ap.parse_args()

    import os

    model = args.model or os.environ.get("OPENCODE_MODEL")
    if not model or "/" not in model:
        print("--model or $OPENCODE_MODEL must be set as provider/model, e.g. opencode/big-pickle", file=sys.stderr)
        return 2
    provider_id, model_id = model.split("/", 1)

    print(f"[client] waiting for {args.server_url} ...")
    wait_for_server(args.server_url)

    print("[client] creating session")
    session_id = create_session(args.server_url)
    print(f"[client] session {session_id}")

    report = {"session_id": session_id, "model": model, "server_url": args.server_url}

    try:
        t0 = time.time()
        response = send_message(args.server_url, session_id, provider_id, model_id, TASK_PROMPT)
        report["elapsed_s"] = time.time() - t0
        report["reply"] = extract_reply(response)
        report["todos_final"] = get_todos(args.server_url, session_id)
    except BaseException:
        abort_session(args.server_url, session_id)
        raise
    else:
        abort_session(args.server_url, session_id)

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(report, f, indent=2)
    print(f"[client] wrote {args.out}")
    print(f"[client] final todos: {json.dumps(report['todos_final'], indent=2)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
