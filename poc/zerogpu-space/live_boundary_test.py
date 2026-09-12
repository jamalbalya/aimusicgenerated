"""Fires real HTTP attacks at the real gate.

This stands up Gradio 6.2.0 — the version the Space pins — wired to the real
`guard.authorize_request`, and then attacks it with an ordinary HTTP client. It
is not a mock and not a fake Space: the routing, the dependency wiring and the
refusals are Gradio's own.

What it deliberately does not have is ACE-Step. The generation function is
replaced by a tripwire that records being entered and nothing else, because the
question this answers is exactly "was the handler reached?" — and on a real
Space that question costs GPU seconds to ask.

A Space runs in one of two modes, and the two are attacked differently:

  * **private** — a sign-in is required, so every unauthenticated request to a
    gated path must be refused by the door.
  * **public** — no sign-in is required, so the door must refuse nothing. What
    still has to hold is that the *validator* refuses: every probe sent in this
    mode carries a length ACE-Step cannot make, so a public Space answers 400
    and no GPU ever starts. A valid payload here would spend the day's whole
    allowance to prove something a rejected one proves just as well.

So this proves the code. It does not prove the deployment: the Space could be
running an older commit, or in the other mode. Only a run against the deployed
Space proves that, and this file is what to run against it.

    python3 live_boundary_test.py             # local harness, both modes
    python3 live_boundary_test.py --base URL  # a deployed private Space
    python3 live_boundary_test.py --base URL --public  # a deployed public Space
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

import guard  # noqa: E402  - after the path is set, and needed at module scope

# Imported at module scope because Gradio resolves the handler's type hints
# against these globals, and `from __future__ import annotations` defers them.
try:
    import gradio as gr
except ImportError:  # only the --base mode works without it
    gr = None  # type: ignore[assignment]

API = "/gradio_api"

#: Set by the tripwire. The whole point: a refused request must leave this at 0.
gpu_entries: list[dict] = []

#: The brake the local handler counts against. Effectively off for the attack
#: sweep, which fires far more requests than any real caller and is not about
#: the brake; `run_rate_limit_check` swaps in a small one to test it directly.
LIMITER = guard.RateLimiter(limit=10_000, window=3600)

RESULTS: list[tuple[str, str, str]] = []


def record(name: str, verdict: str, detail: str) -> None:
    RESULTS.append((name, verdict, detail))
    mark = {"PASS": "ok  ", "FAIL": "FAIL", "UNVERIFIED": "????", "N/A": "n/a "}[verdict]
    print(f"  {mark} {name}: {detail}")


#: The statuses each gated path returned, for the launch-path gate below.
GATED: dict[str, int] = {}


def credential_verdict(status: int) -> tuple[str, str]:
    """How to read the answer to an invalid credential.

    A 401 or 403 means Hugging Face was asked and said no: the check did what
    it claims to. A 503 means Hugging Face could not be asked at all, so the
    request was refused by the fail-closed path instead. Refusing either way is
    correct behaviour, but only the first proves token verification works — so
    a 503 is reported UNVERIFIED and never as a pass. Anything below 400 is a
    credential that was accepted, which is a failure.
    """
    if status in (401, 403):
        return "PASS", f"HTTP {status} — Hugging Face was asked and rejected it"
    if status == 503:
        return "UNVERIFIED", (
            f"HTTP {status} — refused, but by the fail-closed path: Hugging Face "
            "was unreachable, so token verification itself is NOT proven"
        )
    if status >= 400:
        return "UNVERIFIED", f"HTTP {status} — refused, but not by the expected path"
    return "FAIL", f"HTTP {status} — an invalid credential was ACCEPTED"


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
        # Auto length when the door is what is being tested; a length ACE-Step
        # refuses when the door is open, so a served request still starts no
        # generation and costs no quota.
        "data": ["dangdut koplo, male vocal", "baris satu\nbaris dua", "id", "male", False,
                 (guard.DURATION_MIN - 1) if PUBLIC else -1],
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


#: Set for a Space that requires no sign-in. Changes what the probes send and
#: what their answers are judged against; see the module docstring.
PUBLIC = False

#: Every sentence the door itself refuses with. Finding one of these in an
#: answer is how a refusal by the door is told from a refusal by anything else
#: — Gradio declining a file path, or the validator declining a length — which
#: matters because in public mode the first is a failure and the others are not.
SIGN_IN_REFUSALS = (
    "sign in with hugging face",
    "sign-in is no longer valid",
    "not open for use yet",
    "not approved for this studio",
)


def door_refused(status: int, text: str) -> bool:
    """Whether the boundary refused this for want of a sign-in."""
    if status not in (401, 403):
        return False
    lowered = text.lower()
    return any(sentence in lowered for sentence in SIGN_IN_REFUSALS)


def run_attacks(base: str, live: bool) -> None:
    print(f"\n=== direct API attacks against {base} ===")
    fake = secrets.token_urlsafe(32)

    cases = [
        ("A  no Authorization header", f"{API}/queue/join", {}, payload()),
        ("B  empty bearer", f"{API}/queue/join", {"Authorization": "Bearer"}, payload()),
        ("B2 bearer with empty token", f"{API}/queue/join", {"Authorization": "Bearer "}, payload()),
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
        if PUBLIC:
            # The door must refuse nothing. Whatever else happens to the
            # request — the validator declining the length, Gradio declining a
            # file path — is not this check's business.
            verdict = "FAIL" if door_refused(status, text) else "PASS"
        elif status in (401, 403):
            # Unauthenticated access to a gated path must be 401 or 403. Any
            # other refusal is still a refusal, but not the one being claimed.
            verdict = "PASS"
        elif refused(status):
            verdict = "UNVERIFIED"
        else:
            verdict = "FAIL"
        record(name, verdict, f"HTTP {status} {text.strip()[:90]}")
        for key in ("/queue/join", "/queue/data", "/call/generate_music", "/file="):
            if key in path and name.strip()[0] in "IJKL":
                GATED[key] = status

    # C and D present credentials that are well formed but not real, so they are
    # the only two checks that reach Hugging Face. They are judged on whether
    # verification actually happened, not merely on being refused.
    for label, token in [("C  malformed token", "fake"), ("D  random valid-shaped token", f"hf_{fake}")]:
        status, text = request(base, f"{API}/queue/join", "POST",
                               {"Authorization": f"Bearer {token}"}, payload())
        if PUBLIC:
            # A public Space reads no credential, so a bad one is neither
            # trusted nor refused — it is simply not looked at. Being served is
            # the correct answer here; being refused *for the credential* is
            # the failure, because that is the door acting when it should not.
            verdict = "FAIL" if door_refused(status, text) else "PASS"
            detail = f"HTTP {status} — no credential is read, so this one was never consulted"
            record(label, verdict, detail)
            continue
        verdict, detail = credential_verdict(status)
        record(label, verdict, detail)

    # Malformed JSON on an unauthenticated request.
    status, _ = request(base, f"{API}/queue/join", "POST", {}, None, raw_body=b"{not json")
    record("M  malformed JSON, no auth", "PASS" if refused(status) else "FAIL", f"HTTP {status}")

    # XSS payloads are just text. In a private Space they must be refused for
    # lack of auth; in a public one they are accepted as input, which is fine.
    # The claim that holds in both is the one that matters: whatever comes back
    # must never contain them, so nothing the caller wrote can be executed by a
    # browser reading the answer.
    for label, field, value in [
        ("style", 0, "<script>alert(document.domain)</script>"),
        ("lyrics", 1, "<img src=x onerror=alert(document.domain)>"),
    ]:
        data = payload()
        data["data"][field] = value
        status, text = request(base, f"{API}/queue/join", "POST", {}, data)
        clean = value not in text
        wanted = clean if PUBLIC else (refused(status) and clean)
        record(f"   XSS in {label} not reflected", "PASS" if wanted else "FAIL",
               f"HTTP {status}, payload {'absent from' if clean else 'ECHOED IN'} response")

    # The launch-path question, answered from behaviour rather than from
    # convention. `auth_dependency` is passed inside `if __name__ == "__main__"`,
    # so if Hugging Face imports app.py and launches it itself, the dependency is
    # never installed and these four paths stop being gated. Nothing about the
    # source can settle that; four HTTP statuses can.
    print()
    expected = ("/queue/join", "/queue/data", "/call/generate_music", "/file=")
    if PUBLIC:
        # A door that refuses nothing cannot be seen from outside it. Whether
        # the dependency is installed is answerable only in private mode, and
        # claiming otherwise here would be inventing a pass.
        #
        # The local harness runs both modes against one server, so if the
        # private phase already answered this, asking again proves nothing and
        # is not a gap either. Against a deployed public Space there is no such
        # phase, and then it is a real gap and says so.
        answered = any(name.startswith("LAUNCH PATH") and verdict == "PASS"
                       for name, verdict, _ in RESULTS)
        record("LAUNCH PATH  auth_dependency is active",
               "N/A" if answered else "UNVERIFIED",
               "a public Space refuses nothing, so its gate leaves no trace in a status code"
               + (" — already proven against this same server in private mode" if answered
                  else "; run this against a private one to verify the dependency"))
        settle()
        print(f"\n  GPU function entered: {len(gpu_entries)} time(s)")
        record("GPU never entered by a refused request",
               "PASS" if not gpu_entries else "FAIL",
               f"{len(gpu_entries)} entries recorded; every probe carried a length "
               "ACE-Step refuses, so none should have reached the handler")
        return
    missing = [k for k in expected if k not in GATED]
    ungated = {k: v for k, v in GATED.items() if v not in (401, 403)}
    if missing:
        record("LAUNCH PATH  auth_dependency is active", "UNVERIFIED",
               f"no status recorded for {', '.join(missing)}")
    elif ungated:
        record("LAUNCH PATH  auth_dependency is active", "FAIL",
               "NOT installed — "
               + ", ".join(f"{k} returned {v}" for k, v in ungated.items())
               + ". The Space is serving these paths without the gate. STOP.")
    else:
        record("LAUNCH PATH  auth_dependency is active", "PASS",
               "all four gated paths answered 401/403, so the dependency is installed")

    print(f"\n  GPU function entered: {len(gpu_entries)} time(s)")
    if live:
        # There is no tripwire inside a deployed Space. Whether a rejected
        # request started a generation is a question for its logs.
        record("GPU never entered by a refused request", "UNVERIFIED",
               "no tripwire exists in a deployed Space; confirm from its logs that "
               "no generation started during this run")
    else:
        record("GPU never entered by a refused request",
               "PASS" if not gpu_entries else "FAIL",
               f"{len(gpu_entries)} entries recorded")


def run_rate_limit_check(base: str) -> None:
    """Proves the brake still counts a caller nobody signed in as.

    Local only, and the one place a payload the validator *accepts* is sent:
    the brake is checked after validation, so a request refused for its length
    never reaches it. That is safe here and nowhere else — the handler is a
    tripwire, so an accepted request costs nothing. The same probe against a
    deployed Space would spend real GPU time.

    The answer is read from the tripwire rather than from a status code, because
    a queued handler's refusal does not reach `/queue/join`: Gradio has already
    answered 200 with an event id by the time the handler runs, and the error
    travels on the event stream instead.
    """
    global LIMITER
    print("\n=== the brake, with nobody signed in ===")
    was, LIMITER = LIMITER, guard.RateLimiter(limit=2, window=3600)
    gpu_entries.clear()
    try:
        for _ in range(3):
            request(base, f"{API}/queue/join", "POST", {},
                    payload({"data": ["dangdut koplo", "baris satu", "id", "male", False, -1]}))
            settle()
        record("a public caller is counted by address, and the third is refused",
               "PASS" if len(gpu_entries) == 2 else "FAIL",
               f"3 accepted requests from one address reached the handler "
               f"{len(gpu_entries)} time(s); the brake allows 2")
        callers = {entry["caller"] for entry in gpu_entries}
        record("the caller is an address, not anything the caller sent",
               "PASS" if all(c.startswith("ip:") for c in callers) else "FAIL",
               f"counted as {', '.join(sorted(callers)) or 'nothing'}")
    finally:
        LIMITER = was
        gpu_entries.clear()


def run_local() -> None:
    """Stands up real Gradio with the real gate, then attacks it in both modes."""
    if gr is None:
        print("gradio is not installed; `pip install gradio==6.2.0` to run the local harness")
        sys.exit(1)

    def generate(style, lyrics, language, vocal_gender, instrumental, duration,
                 request: gr.Request):
        # The same three guard calls as `app.py`'s handler, in the same order,
        # and then the tripwire in place of the GPU function — so the tripwire
        # means what it does there: the generation was actually going to start.
        #
        # These are not decoration. In public mode the door refuses nothing, so
        # the validator and the brake are the entire distance between a request
        # and the GPU, and a stand-in without them would report a handler
        # reached that the real Space would have turned away.
        try:
            caller = guard.caller_for(request)
            checked = guard.validate_request(
                style, lyrics, language, vocal_gender, instrumental, duration
            )
            LIMITER.check(caller)
        except guard.AuthError as error:
            raise gr.Error(error.message) from None
        gpu_entries.append({"style": checked["style"], "caller": caller})
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

    # The same gate, the same server, with the sign-in requirement lifted. The
    # gate asks `sign_in_required()` per request, so this needs no restart.
    global PUBLIC
    was = (guard.REQUIRE_SIGN_IN_RAW, guard.ALLOWED_USERS_RAW, PUBLIC)
    guard.REQUIRE_SIGN_IN_RAW, guard.ALLOWED_USERS_RAW, PUBLIC = "0", "", True
    gpu_entries.clear()
    print("\n=== the same attacks against a public Space ===")
    try:
        run_attacks(base, live=False)
        run_rate_limit_check(base)
    finally:
        guard.REQUIRE_SIGN_IN_RAW, guard.ALLOWED_USERS_RAW, PUBLIC = was
        gpu_entries.clear()

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
    parser.add_argument("--public", action="store_true",
                        help="the Space requires no sign-in: the door must refuse nothing, "
                             "and every probe is built so the validator refuses it instead")
    args = parser.parse_args()

    if args.base:
        global PUBLIC
        PUBLIC = args.public
        print(f"attacking the deployed Space at {args.base}"
              f"{' (public: no sign-in expected)' if PUBLIC else ''}")
        run_attacks(args.base.rstrip("/"), live=True)
        print("\nNote: the GPU tripwire is local only. Against a deployed Space, "
              "confirm from its logs that no generation started.")
    else:
        run_local()

    failed = [r for r in RESULTS if r[1] == "FAIL"]
    unverified = [r for r in RESULTS if r[1] == "UNVERIFIED"]
    passed = [r for r in RESULTS if r[1] == "PASS"]
    skipped = [r for r in RESULTS if r[1] == "N/A"]

    print(f"\n{len(RESULTS)} checks: {len(passed)} PASS, {len(failed)} FAIL, "
          f"{len(unverified)} UNVERIFIED, {len(skipped)} not applicable")
    for label, rows in (("FAIL", failed), ("UNVERIFIED", unverified)):
        for name, _, detail in rows:
            print(f"  {label} {name}: {detail}")

    # The verdict, stated so it cannot be read as better than it is.
    if failed:
        print("\nVERDICT: FAIL — do not proceed.")
        sys.exit(1)
    if unverified:
        print("\nVERDICT: UNVERIFIED — nothing failed, but at least one check did "
              "not prove what it is meant to prove. Not a pass.")
        sys.exit(2)
    print("\nVERDICT: PASS")


if __name__ == "__main__":
    main()
