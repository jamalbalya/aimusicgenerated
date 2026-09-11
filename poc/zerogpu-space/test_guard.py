"""Tests for the Space's security boundary.

Run with `python3 test_guard.py`. No pytest, no network: identity verification
is replaced with a stub, because what these check is the decision the boundary
makes, not Hugging Face's uptime.

Every test here is written from the attacker's side. A test that only proves the
happy path works would not have caught any of the things this module exists to
stop.
"""

from __future__ import annotations

import os
import sys

os.environ.setdefault("ALLOWED_HF_USERS", "jamalbalya")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import guard  # noqa: E402

FAILURES: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  ok   {name}")
    else:
        FAILURES.append(f"{name} {detail}".strip())
        print(f"  FAIL {name} {detail}".rstrip())


def refuses(name: str, status: int, call) -> None:
    """Asserts the call is refused, and refused with the right status."""
    try:
        call()
    except guard.AuthError as error:
        check(name, error.status == status, f"(expected {status}, got {error.status})")
        return
    check(name, False, f"(expected {status}, but it was allowed)")


def allows(name: str, call) -> None:
    try:
        call()
        check(name, True)
    except guard.AuthError as error:
        check(name, False, f"(refused {error.status}: {error.message})")


# --- identity is never taken from the caller ---------------------------------

print("\nbearer parsing")
for bad, label in [
    (None, "no Authorization header"),
    ("", "empty header"),
    ("Bearer", "scheme with no token"),
    ("Bearer ", "scheme with empty token"),
    ("hf_realtoken", "token with no scheme"),
    ("Basic aGk6dGhlcmU=", "wrong scheme"),
    ("Bearer tok en", "token containing a space"),
    ("bearer\ttok", "malformed separator"),
    ("Bearer " + "x" * 5000, "absurdly long token"),
]:
    refuses(f"rejects {label}", 401, lambda b=bad: guard.parse_bearer(b))

check("accepts a well-formed header", guard.parse_bearer("Bearer hf_abc123") == "hf_abc123")
check("accepts lowercase scheme", guard.parse_bearer("bearer hf_abc123") == "hf_abc123")


# --- authorization is separate from authentication ---------------------------

print("\nallowlist")


def stub_identity(username: str):
    """Replaces the network call with a known answer."""
    def verify(token: str) -> guard.Identity:
        if token == "expired" or token == "forged":
            raise guard.AuthError(401, "That Hugging Face sign-in is no longer valid. Sign in again.")
        if token == "provider-down":
            raise guard.AuthError(503, "Hugging Face could not confirm the sign-in. Try again shortly.")
        return guard.Identity(username=username, sub="u-1")
    return verify


real_verify = guard.verify_identity

guard.verify_identity = stub_identity("jamalbalya")
allows("an allowlisted account is authorised", lambda: guard.authorize("good"))
check("authorised identity is the verified one, not a claim",
      guard.authorize("good").username == "jamalbalya")

guard.verify_identity = stub_identity("someone-else")
refuses("a real account that is not allowlisted gets 403", 403, lambda: guard.authorize("good"))

guard.verify_identity = stub_identity("JamalBalya")
allows("the allowlist is case-insensitive", lambda: guard.authorize("good"))

guard.verify_identity = stub_identity("jamalbalya")
refuses("an expired token gets 401", 401, lambda: guard.authorize("expired"))
refuses("a forged token gets 401", 401, lambda: guard.authorize("forged"))
refuses("a provider outage refuses rather than admits", 503, lambda: guard.authorize("provider-down"))

# Fail closed: no allowlist configured means nobody, not everybody.
original_raw = guard.ALLOWED_USERS_RAW
guard.ALLOWED_USERS_RAW = ""
refuses("an unset allowlist authorises nobody", 403, lambda: guard.authorize("good"))
guard.ALLOWED_USERS_RAW = "  "
refuses("a blank allowlist authorises nobody", 403, lambda: guard.authorize("good"))
guard.ALLOWED_USERS_RAW = "alice, bob  jamalbalya"
allows("several usernames can be listed", lambda: guard.authorize("good"))
guard.ALLOWED_USERS_RAW = original_raw

# The refusal must not describe the allowlist.
guard.verify_identity = stub_identity("someone-else")
try:
    guard.authorize("good")
except guard.AuthError as error:
    check("the 403 does not name another account",
          "jamalbalya" not in error.message.lower() and "alice" not in error.message.lower())
guard.verify_identity = real_verify


# --- paths that cost GPU time are gated --------------------------------------

print("\npath policy")
for path in ["/gradio_api/queue/join", "/gradio_api/queue/data", "/gradio_api/call/generate_music",
             "/gradio_api/call/v2/generate_music", "/gradio_api/file=/tmp/song.wav",
             "/gradio_api/run/generate_music", "/gradio_api/api/generate_music"]:
    check(f"gated: {path}", not guard.is_public_path(path))
for path in ["/", "/config", "/gradio_api/config", "/gradio_api/info", "/heartbeat"]:
    check(f"public: {path}", guard.is_public_path(path))


# --- inputs are checked before a GPU is asked for -----------------------------

print("\ninput validation")
OK = dict(style="dangdut koplo", lyrics="baris satu\nbaris dua", language="id",
          vocal_gender="male", instrumental=False, duration=-1)


def validate(**overrides):
    merged = {**OK, **overrides}
    return guard.validate_request(**merged)


allows("a good request passes", lambda: validate())
check("auto duration survives untouched", validate()["duration"] == -1.0)
check("an explicit duration survives", validate(duration=238)["duration"] == 238.0)
check("lyrics are passed through byte for byte",
      validate(lyrics="a\n\nb  c\t")["lyrics"] == "a\n\nb  c\t")
check("style is passed through byte for byte",
      validate(style="  spaced  ")["style"] == "  spaced  ")

refuses("oversized style", 400, lambda: validate(style="x" * 513))
refuses("oversized lyrics", 400, lambda: validate(lyrics="x" * 4097))
allows("style at the limit", lambda: validate(style="x" * 512))
allows("lyrics at the limit", lambda: validate(lyrics="x" * 4096))
refuses("nothing to go on", 400, lambda: validate(style="  ", lyrics=""))

refuses("unknown language", 400, lambda: validate(language="klingon"))
refuses("language of the wrong type", 400, lambda: validate(language=7))
allows("a valid language is accepted", lambda: validate(language="ja"))

refuses("unknown vocal gender", 400, lambda: validate(vocal_gender="robot"))
refuses("vocal gender of the wrong type", 400, lambda: validate(vocal_gender=None))

refuses("instrumental as a string", 400, lambda: validate(instrumental="true"))
refuses("instrumental as a number", 400, lambda: validate(instrumental=1))

print("\nduration")
for bad, label in [
    (float("nan"), "NaN"), (float("inf"), "infinity"), (float("-inf"), "negative infinity"),
    (-2, "a negative that is not -1"), (-0.5, "a fractional negative"),
    (0, "zero"), (9, "below the minimum"), (601, "above the maximum"),
    ("271", "a string"), (None, "nothing"), (True, "a boolean"),
]:
    refuses(f"rejects {label}", 400, lambda b=bad: guard.validate_duration(b))
check("-1 means auto", guard.validate_duration(-1) == -1.0)
check("-1.0 means auto", guard.validate_duration(-1.0) == -1.0)
check("a float is rounded to whole seconds", guard.validate_duration(238.4) == 238.0)
check("the minimum is allowed", guard.validate_duration(10) == 10.0)
check("the maximum is allowed", guard.validate_duration(600) == 600.0)


# --- abuse brake --------------------------------------------------------------

print("\nrate limiting")
limiter = guard.RateLimiter(limit=3, window=3600)
for i in range(3):
    allows(f"request {i + 1} of 3 is allowed", lambda: limiter.check("jamalbalya"))
refuses("the fourth is refused", 429, lambda: limiter.check("jamalbalya"))
allows("a different user has their own budget", lambda: limiter.check("someone-else"))
refuses("the brake is case-insensitive too", 429, lambda: limiter.check("JamalBalya"))


# --- no secret leaks into a message -------------------------------------------

print("\nleakage")
guard.verify_identity = stub_identity("someone-else")
messages = []
for token in ["hf_verysecrettokenvalue", "expired"]:
    try:
        guard.authorize(token)
    except guard.AuthError as error:
        messages.append(error.message)
guard.verify_identity = real_verify
check("no token text appears in any refusal",
      all("hf_verysecret" not in m for m in messages))
check("no allowlist appears in any refusal",
      all("jamalbalya" not in m.lower() for m in messages))

print("\nno cookies anywhere in the boundary")
source = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "guard.py")).read()
for banned in ["cookie", "Cookie", "set_cookie", "session_id"]:
    check(f"guard.py never mentions {banned}", banned not in source)


print()
if FAILURES:
    print(f"{len(FAILURES)} FAILED:")
    for f in FAILURES:
        print(f"  - {f}")
    sys.exit(1)
print("all guard tests passed")
