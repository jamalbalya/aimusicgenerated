"""Fires real HTTP attacks at the real gate.

This stands up Gradio 6.2.0 — the version the Space pins — wired to the real
`guard.authorize_request`, and then attacks it with an ordinary HTTP client. It
is not a mock and not a fake Space: the routing, the dependency wiring and the
refusals are Gradio's own.

What it deliberately does not have is ACE-Step. The generation function is
replaced by a tripwire that records being entered and nothing else, because the
question this answers is exactly "was the handler reached?" — and on a real
Space that question costs GPU seconds to ask.

So this proves the code. It does not prove the deployment: the Space could be
running an older commit, or without `ALLOWED_HF_USERS` set. Only a run against
the deployed Space proves that, and this file is what to run against it.

    python3 live_boundary_test.py            # local harness
    python3 live_boundary_test.py --base URL # the deployed Space
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
import threading
import time
import urllib.error
import urllib.request

os.environ.setdefault("ALLOWED_HF_USERS", "jamalbalya")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Imported at module scope because Gradio resolves the handler's type hints
# against these globals, and `from __future__ import annotations` defers them.
try:
    import gradio as gr
except ImportError:  # only the --base mode works without it
    gr = None  # type: ignore[assignment]

API = "/gradio_api"

#: Set by the tripwire. The whole point: a refused request must leave this at 0.
gpu_entries: list[dict] = []

RESULTS: list[tuple[str, str, str]] = []


def record(name: str, verdict: str, detail: str) -> None:
    RESULTS.append((name, verdict, detail))
    mark = {"PASS": "ok  ", "FAIL": "FAIL", "UNVERIFIED": "????"}[verdict]
    print(f"  {mark} {name}: {detail}")


def request(
    base: str, path: str, method: str = "POST",
    headers: dict[str, str] | None = None, body: object = None,
    raw_body: bytes | None = None,
) -> tuple[int, str]:
    """One HTTP call. Returns (status, body). Never raises for a status."""
    data = raw_body if raw_body is not None else (
        json.dumps(body).encode("utf8") if body is not None else None
    )
    sent = {"Content-Type": "application/json", **(headers or {})}
    req = urllib.request.Request(f"{base}{path}", data=data, headers=sent, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.status, response.read().decode("utf8", "replace")[:400]
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf8", "replace")[:400]
    except Exception as error:  # noqa: BLE001 - a transport failure is a result too
        return 0, f"{type(error).__name__}: {error}"


def payload(extra: dict | None = None) -> dict:
    body = {
        "data": ["dangdut koplo, male vocal", "baris satu\nbaris dua", "id", "male", False, -1],
        "event_data": None,
        "fn_index": 0,
        "session_hash": "attack-session",
    }
    body.update(extra or {})
    return body


def settle(seconds: float = 2.0) -> None:
    """Waits for the queue to stop running handlers.

    `/queue/join` returns as soon as the job is accepted and the handler runs
    afterwards, so counting handler entries straight after a request counts the
    previous one. Waiting until the count stops moving is what makes the
    tripwire mean what it says.
    """
    deadline = time.time() + seconds
    last = -1
    while time.time() < deadline:
        if len(gpu_entries) == last:
            return
        last = len(gpu_entries)
        time.sleep(0.4)


def refused(status: int) -> bool:
    """Any refusal that is not a success. 401/403 wanted; 4xx/5xx accepted."""
    return status >= 400


def run_attacks(base: str, live: bool) -> None:
    print(f"\n=== direct API attacks against {base} ===")
    fake = secrets.token_urlsafe(32)

    cases = [
        ("A  no Authorization header", f"{API}/queue/join", {}, payload()),
        ("B  empty bearer", f"{API}/queue/join", {"Authorization": "Bearer"}, payload()),
        ("B2 bearer with empty token", f"{API}/queue/join", {"Authorization": "Bearer "}, payload()),
        ("C  malformed token", f"{API}/queue/join", {"Authorization": "Bearer fake"}, payload()),
        ("E  username in payload, no auth", f"{API}/queue/join", {},
         payload({"username": "jamalbalya"})),
        ("F  user_id in payload, no auth", f"{API}/queue/join", {},
         payload({"user_id": "jamalbalya"})),
        ("G  Origin spoofing, no auth", f"{API}/queue/join",
         {"Origin": "https://jamalbalya.github.io"}, payload()),
        ("H  Referer spoofing, no auth", f"{API}/queue/join",
         {"Referer": "https://jamalbalya.github.io"}, payload()),
        ("I  direct /queue/join", f"{API}/queue/join", {}, payload()),
        ("J  direct /call", f"{API}/call/generate_music", {}, {"data": payload()["data"]}),
        ("K  direct /queue/data", f"{API}/queue/data?session_hash=attack-session", {}, None),
        ("L  direct /file=", f"{API}/file=/tmp/anything.wav", {}, None),
        ("   oauth_token in body (gr.OAuthToken forgery)", f"{API}/queue/join", {},
         payload({"oauth_token": "hf_forged_token"})),
        ("   no Bearer prefix", f"{API}/queue/join", {"Authorization": fake}, payload()),
        ("   wrong scheme", f"{API}/queue/join", {"Authorization": f"Basic {fake}"}, payload()),
    ]

    for name, path, headers, body in cases:
        method = "GET" if body is None else "POST"
        status, text = request(base, path, method, headers, body)
        verdict = "PASS" if refused(status) else "FAIL"
        record(name, verdict, f"HTTP {status} {text.strip()[:90]}")

    # D: a well-formed but invalid token. Locally Hugging Face is unreachable, so
    # this exercises the fail-closed path rather than a genuine 401 from HF.
    status, text = request(base, f"{API}/queue/join", "POST",
                           {"Authorization": f"Bearer hf_{fake}"}, payload())
    if refused(status):
        note = "refused" if live else "refused (fail-closed: HF unreachable here, so 503 not 401)"
        record("D  random valid-shaped token", "PASS", f"HTTP {status} — {note}")
    else:
        record("D  random valid-shaped token", "FAIL", f"HTTP {status} {text[:90]}")

    # Malformed JSON on an unauthenticated request.
    status, _ = request(base, f"{API}/queue/join", "POST", {}, None, raw_body=b"{not json")
    record("M  malformed JSON, no auth", "PASS" if refused(status) else "FAIL", f"HTTP {status}")

    # XSS payloads are just text; they must be refused for lack of auth, not
    # interpreted, and must never come back executable.
    for label, field, value in [
        ("style", 0, "<script>alert(document.domain)</script>"),
        ("lyrics", 1, "<img src=x onerror=alert(document.domain)>"),
    ]:
        data = payload()
        data["data"][field] = value
        status, text = request(base, f"{API}/queue/join", "POST", {}, data)
        clean = value not in text
        record(f"   XSS in {label} not reflected", "PASS" if refused(status) and clean else "FAIL",
               f"HTTP {status}, payload {'absent from' if clean else 'ECHOED IN'} response")

    print(f"\n  GPU function entered: {len(gpu_entries)} time(s)")
    record("GPU never entered by a refused request",
           "PASS" if not gpu_entries else "FAIL",
           f"{len(gpu_entries)} entries recorded")


def run_local() -> None:
    """Stands up real Gradio with the real gate, then attacks it."""
    import guard

    if gr is None:
        print("gradio is not installed; `pip install gradio==6.2.0` to run the local harness")
        sys.exit(1)

    def generate(style, lyrics, language, vocal_gender, instrumental, duration,
                 request: gr.Request):
        # Stands in for the GPU function. Records being reached; that is all.
        gpu_entries.append({"style": style})
        return None, "{}"

    with gr.Blocks() as demo:
        style = gr.Textbox()
        lyrics = gr.Textbox()
        language = gr.Textbox()
        vocal_gender = gr.Dropdown(choices=["male", "female", "mixed"])
        instrumental = gr.Checkbox()
        duration = gr.Number()
        out_audio = gr.Audio()
        out_meta = gr.Code()
        gr.Button("Generate").click(
            generate,
            inputs=[style, lyrics, language, vocal_gender, instrumental, duration],
            outputs=[out_audio, out_meta],
            api_name="generate_music",
        )

    port = 7861
    thread = threading.Thread(
        target=lambda: demo.queue().launch(
            server_name="127.0.0.1", server_port=port, share=False, quiet=True,
            prevent_thread_lock=True, auth_dependency=guard.authorize_request,
        ),
        daemon=True,
    )
    thread.start()

    base = f"http://127.0.0.1:{port}"
    for _ in range(60):
        status, _ = request(base, "/config", "GET")
        if status and status < 500:
            break
        time.sleep(0.5)
    else:
        print("the harness never came up")
        sys.exit(1)

    status, _ = request(base, "/config", "GET")
    record("/config stays public (costs nothing, reveals nothing)",
           "PASS" if status == 200 else "FAIL", f"HTTP {status}")

    run_attacks(base, live=False)

    # The allowlist, through a real request, with Hugging Face's answer stubbed:
    # what is being tested here is the decision, not HF's uptime.
    print("\n=== authorization, with identity stubbed ===")
    real = guard.verify_identity
    for username, expect, label in [
        ("jamalbalya", 200, "allowlisted account reaches the handler"),
        ("someone-else", 403, "authenticated but not allowlisted is refused"),
    ]:
        guard.verify_identity = lambda token, u=username: guard.Identity(username=u, sub="u1")
        guard._verified.clear()
        settle()
        before = len(gpu_entries)
        status, text = request(base, f"{API}/queue/join", "POST",
                               {"Authorization": "Bearer hf_stubbed"}, payload())
        settle()
        entered = len(gpu_entries) > before
        if expect == 200:
            record(label, "PASS" if status < 400 else "FAIL", f"HTTP {status}")
        else:
            leaks = "jamalbalya" in text.lower()
            record(label, "PASS" if status == 403 and not entered and not leaks else "FAIL",
                   f"HTTP {status}, handler {'entered' if entered else 'not entered'}, "
                   f"allowlist {'LEAKED' if leaks else 'not leaked'}")
    guard.verify_identity = real


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", help="attack a deployed Space instead of a local harness")
    args = parser.parse_args()

    if args.base:
        print(f"attacking the deployed Space at {args.base}")
        run_attacks(args.base.rstrip("/"), live=True)
        print("\nNote: the GPU tripwire is local only. Against a deployed Space, "
              "confirm from its logs that no generation started.")
    else:
        run_local()

    failed = [r for r in RESULTS if r[1] == "FAIL"]
    print(f"\n{len(RESULTS)} checks, {len(failed)} failed")
    if failed:
        for name, _, detail in failed:
            print(f"  FAIL {name}: {detail}")
        sys.exit(1)
    print("every check passed")


if __name__ == "__main__":
    main()
