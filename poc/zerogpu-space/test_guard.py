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


class FakeRequest:
    """The parts of a Starlette request the boundary actually reads.

    Headers are asked for in lower case, which is what Starlette's
    case-insensitive mapping hands back, so a plain dict is a faithful stand-in.
    """

    def __init__(self, headers=None, host=None, path="/gradio_api/queue/join", method="POST"):
        self.headers = headers or {}
        self.client = type("Client", (), {"host": host})() if host else None
        self.url = type("Url", (), {"path": path})()
        self.method = method


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


# --- exactly one account may generate ----------------------------------------

print("\nonly the configured account")

THE_ACCOUNT = "jamalbalya"
guard.ALLOWED_USERS_RAW = THE_ACCOUNT

# The account itself, however Hugging Face happens to capitalise it.
for spelling in (THE_ACCOUNT, "JamalBalya", "JAMALBALYA", "jamalBalya"):
    guard.verify_identity = stub_identity(spelling)
    allows(f"the studio's own account is admitted as {spelling!r}",
           lambda: guard.authorize("good"))

# Everything that merely looks like it. A substring match here would be a
# catastrophe rather than a bug — this project has already been bitten once by
# "male" matching inside "female" — so near misses are tested explicitly.
for imposter in ("jamalbalya2", "jamalbaly", "amalbalya", "jamal.balya", "jamal-balya",
                 "jamalbalya-admin", "xjamalbalyax", "jamalbalya.hf", "jamal balya"):
    guard.verify_identity = stub_identity(imposter)
    refuses(f"{imposter!r} is not that account", 403, lambda: guard.authorize("good"))

# The claim in the request loses to the answer from the network. This is the
# whole of requirement "verify server-side": a caller who says they are the
# owner, while holding a token that belongs to somebody else, is refused as
# whoever the token says they are.
guard.verify_identity = stub_identity("someone-else")
impersonator = FakeRequest(headers={"authorization": "Bearer somebody-elses-token"})
impersonator.username = THE_ACCOUNT       # type: ignore[attr-defined]
impersonator.json = {"username": THE_ACCOUNT}  # type: ignore[attr-defined]
refuses("claiming to be the owner while holding another account's token is 403", 403,
        lambda: guard.caller_for(impersonator))

# And an unverifiable token is refused before the allowlist is consulted at
# all, so a fake bearer can never be answered with 403 instead of 401.
guard.verify_identity = stub_identity(THE_ACCOUNT)
refuses("a forged token is 401, not 403", 401,
        lambda: guard.caller_for(FakeRequest(headers={"authorization": "Bearer forged"})))
refuses("an expired token is 401, not 403", 401,
        lambda: guard.caller_for(FakeRequest(headers={"authorization": "Bearer expired"})))
guard.verify_identity = real_verify
guard.ALLOWED_USERS_RAW = original_raw


# --- a sign-in is mandatory, and no configuration lifts it --------------------

print("\nmandatory sign-in")


def under(require: str, allow: str, call):
    """Runs `call` with the Space configured that way, then puts it back."""
    was = (guard.REQUIRE_SIGN_IN_RAW, guard.ALLOWED_USERS_RAW)
    guard.REQUIRE_SIGN_IN_RAW, guard.ALLOWED_USERS_RAW = require, allow
    try:
        return call()
    finally:
        guard.REQUIRE_SIGN_IN_RAW, guard.ALLOWED_USERS_RAW = was


# The product requirement, stated as a test: signing in is not a setting. Every
# value a deployment might plausibly set is tried, including the ones that used
# to open the door, and the answer is the same each time.
for require in ("", "0", "false", "FALSE", "no", "off", "1", "true", "yes", "on", "maybe"):
    for allow in ("", "jamalbalya"):
        check(f"a sign-in is required with REQUIRE_HF_SIGN_IN={require!r}, allowlist {allow!r}",
              under(require, allow, guard.sign_in_required) is True)

# Switching it off is noticed rather than obeyed, so app.py can say so at
# startup instead of a deployer believing the door is open.
for word in ("0", "false", "No", "OFF"):
    check(f"{word!r} is recognised as an attempt to allow anonymous callers",
          under(word, "", guard.disabling_sign_in_was_attempted) is True)
for word in ("", "1", "true", "maybe"):
    check(f"{word!r} is not such an attempt",
          under(word, "", guard.disabling_sign_in_was_attempted) is False)

# The anonymous request, in each shape it arrives in. All of them are 401, and
# none of them is turned into an identity.
refuses("a request with no credential at all is refused", 401,
        lambda: guard.caller_for(FakeRequest()))
refuses("a forwarded address is not an identity", 401,
        lambda: guard.caller_for(FakeRequest(headers={"x-forwarded-for": "203.0.113.9"})))
refuses("nor is the header behind it", 401,
        lambda: guard.caller_for(FakeRequest(headers={"x-real-ip": "198.51.100.7"})))
refuses("nor is the socket address", 401,
        lambda: guard.caller_for(FakeRequest(host="192.0.2.5")))
# Anything else hanging off the request is not identity either. `caller_for`
# reads one header; a body, a query string or an attribute Gradio happens to
# expose are all things the caller wrote.
claimed = FakeRequest(headers={"x-forwarded-for": "203.0.113.9"})
claimed.username = "jamalbalya"          # type: ignore[attr-defined]
claimed.user_id = "jamalbalya"           # type: ignore[attr-defined]
claimed.oauth_token = "hf_forged"        # type: ignore[attr-defined]
claimed.json = {"username": "jamalbalya", "oauth_token": "hf_forged"}  # type: ignore[attr-defined]
refuses("a username asserted on the request is not a credential", 401,
        lambda: guard.caller_for(claimed))
for header in ("Bearer ", "Bearer", "Basic nonsense", "Token abc", "hf_looks_real"):
    refuses(f"{header!r} is refused rather than read generously", 401,
            lambda h=header: guard.caller_for(FakeRequest(headers={"authorization": h})))

# The configuration that used to serve this request does not serve it now.
refuses("an anonymous request is refused even when the environment asks otherwise", 401,
        lambda: under("0", "jamalbalya", lambda: guard.caller_for(
            FakeRequest(headers={"x-forwarded-for": "203.0.113.9"}))))
refuses("and with no allowlist configured it is still 401, never served", 401,
        lambda: under("0", "", lambda: guard.caller_for(
            FakeRequest(headers={"x-forwarded-for": "203.0.113.9"}))))

# The address-keyed caller is gone from the module, not merely unused. A helper
# that exists is a helper something can start calling again.
check("nothing in the boundary can key a caller by address",
      not hasattr(guard, "client_key"))
check("guard.py never mentions x-forwarded-for",
      "x-forwarded-for" not in open(guard.__file__, encoding="utf8").read().lower())

# What a signed-in, allowlisted caller gets: through, and named by the network.
guard.verify_identity = stub_identity("jamalbalya")
check("an allowlisted account is admitted, and named by the verified username",
      under("1", "jamalbalya", lambda: guard.caller_for(
          FakeRequest(headers={"authorization": "Bearer good",
                               "x-forwarded-for": "203.0.113.9"}))) == "jamalbalya")
refuses("an authenticated account that is not on the allowlist is refused", 403,
        lambda: under("1", "someone-else", lambda: guard.caller_for(
            FakeRequest(headers={"authorization": "Bearer good"}))))
refuses("an expired sign-in is refused, and says so differently", 401,
        lambda: under("1", "jamalbalya", lambda: guard.caller_for(
            FakeRequest(headers={"authorization": "Bearer expired"}))))
refuses("an empty allowlist admits nobody, however well they signed in", 403,
        lambda: under("1", "", lambda: guard.caller_for(
            FakeRequest(headers={"authorization": "Bearer good"}))))
guard.verify_identity = real_verify

# And the checks that protect the GPU behind the door are still there.
refuses("an oversized lyric sheet is refused", 400,
        lambda: guard.validate_request(
            "dangdut koplo", "x" * (guard.MAX_LYRICS_CHARS + 1), "id", "male", False, 271))
refuses("a length ACE-Step cannot make is refused", 400,
        lambda: guard.validate_request("dangdut koplo", "baris satu", "id", "male", False, 9))


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
