"""The Space's security boundary.

The browser is not trusted. Anything it sends — including a username, a user id
or a display name in the payload — is an assertion by whoever is holding the
keyboard, and this module never treats one as identity. Identity comes from one
place: a bearer token the caller presents, verified against Hugging Face over
the network, on this side of the wire.

Two decisions are kept apart, because they fail differently:

  * authentication — "is this a real Hugging Face user?"  A bad answer is 401.
  * authorization  — "is that user allowed to use this Space?"  A bad answer is
    403, and the answer comes from an allowlist held in the Space environment,
    never from anything the caller can reach.

Everything here fails closed. An unset allowlist authorises nobody, and a
Hugging Face that cannot be reached authorises nobody either: an outage must
not become an open door.

Why a bearer token rather than `gr.OAuthToken`: Gradio builds that object from
`body.oauth_token`, a field of the request body, with empty scope and no
expiry. It is whatever the caller typed. This module reads the `Authorization`
header off the real HTTP request instead, and then asks Hugging Face who it
belongs to, so the answer is one the caller cannot write.
"""

from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass

# --- configuration, all from the Space environment ---------------------------

#: Where identity is checked. Configurable so a deployment can correct it
#: without a code change; the default is the public Hugging Face.
PROVIDER_URL = os.environ.get("OPENID_PROVIDER_URL", "https://huggingface.co").rstrip("/")

#: Who may generate. Comma or whitespace separated, matched case-insensitively.
#: Unset means nobody: an empty allowlist is a closed door, not an open one.
ALLOWED_USERS_RAW = os.environ.get("ALLOWED_HF_USERS", "")

#: Seconds a verified token is trusted before Hugging Face is asked again.
#: Short, because this is also how long a revoked token keeps working.
VERIFY_CACHE_SECONDS = int(os.environ.get("AUTH_CACHE_SECONDS", "60"))

#: Abuse brake, per verified user. Not the authorization mechanism, and not
#: durable — see `RateLimiter`.
RATE_LIMIT_REQUESTS = int(os.environ.get("RATE_LIMIT_REQUESTS", "6"))
RATE_LIMIT_WINDOW_SECONDS = int(os.environ.get("RATE_LIMIT_WINDOW_SECONDS", "3600"))

#: How long to wait on Hugging Face before giving up and denying.
VERIFY_TIMEOUT_SECONDS = 10

#: Paths that carry no cost and no result, so they need no identity. Everything
#: else — the queue, the call endpoints, the generated files — is gated.
PUBLIC_PATH_SUFFIXES = (
    "/config",
    "/info",
    "/heartbeat",
    "/theme.css",
    "/robots.txt",
    "/manifest.json",
)

#: ACE-Step's own limits, from its `GenerationParams` docstring: a caption under
#: 512 characters and lyrics under 4096. Enforced here so an oversized payload
#: is refused before it reaches a GPU rather than after.
MAX_STYLE_CHARS = 512
MAX_LYRICS_CHARS = 4096

#: `acestep/constants.py: VALID_LANGUAGES`, verbatim.
VALID_LANGUAGES = frozenset({
    "ar", "az", "bg", "bn", "ca", "cs", "da", "de", "el", "en",
    "es", "fa", "fi", "fr", "he", "hi", "hr", "ht", "hu", "id",
    "is", "it", "ja", "ko", "la", "lt", "ms", "ne", "nl", "no",
    "pa", "pl", "pt", "ro", "ru", "sa", "sk", "sr", "sv", "sw",
    "ta", "te", "th", "tl", "tr", "uk", "ur", "vi", "yue", "zh",
    "unknown",
})

VALID_VOCAL_GENDERS = frozenset({"male", "female", "mixed"})

#: ACE-Step generates within 10-600 seconds, or picks a length itself when told
#: -1. Those are the only two shapes a duration may have.
DURATION_MIN = 10
DURATION_MAX = 600
AUTO_DURATION = -1


def allowed_users() -> frozenset[str]:
    """The allowlist, lowercased. Empty when none is configured."""
    parts = ALLOWED_USERS_RAW.replace(",", " ").split()
    return frozenset(p.strip().lower() for p in parts if p.strip())


# --- failures ----------------------------------------------------------------


class AuthError(Exception):
    """A refusal, with the status it should be reported as.

    The message is written for the person who will read it in the interface. It
    never contains the token, and never says whether some *other* account would
    have been allowed — an error is not a place to enumerate the allowlist.
    """

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


# --- identity ----------------------------------------------------------------


@dataclass(frozen=True)
class Identity:
    """Who Hugging Face says the caller is. Never built from request data."""

    username: str
    sub: str


def parse_bearer(header_value: str | None) -> str:
    """The token out of an `Authorization` header, or a 401.

    Deliberately strict. A malformed header is a refusal rather than something
    to interpret generously, because every generous reading is a way in.
    """
    if not header_value or not isinstance(header_value, str):
        raise AuthError(401, "Sign in with Hugging Face to generate.")
    parts = header_value.split(" ", 1)
    if len(parts) != 2 or parts[0].strip().lower() != "bearer":
        raise AuthError(401, "Sign in with Hugging Face to generate.")
    token = parts[1].strip()
    # A token is opaque, but it is never empty, never whitespace, and never so
    # long that it is worth sending to Hugging Face to find out.
    if not token or len(token) > 4096 or any(c.isspace() for c in token):
        raise AuthError(401, "Sign in with Hugging Face to generate.")
    return token


_discovery_lock = threading.Lock()
_discovery: dict[str, object] = {}


def _userinfo_endpoint() -> str:
    """Where to ask who a token belongs to.

    Discovered from the provider rather than written down here: the endpoint is
    the provider's to name, and a deployment should not need a code change when
    it moves. The well-known `whoami-v2` is the fallback when discovery is
    unavailable, and the result is cached for the process's life.
    """
    with _discovery_lock:
        cached = _discovery.get("userinfo")
        if isinstance(cached, str):
            return cached
        endpoint = f"{PROVIDER_URL}/api/whoami-v2"
        try:
            request = urllib.request.Request(
                f"{PROVIDER_URL}/.well-known/openid-configuration",
                headers={"Accept": "application/json"},
            )
            with urllib.request.urlopen(request, timeout=VERIFY_TIMEOUT_SECONDS) as response:
                document = json.loads(response.read().decode("utf8"))
            found = document.get("userinfo_endpoint")
            if isinstance(found, str) and found.startswith("https://"):
                endpoint = found
        except Exception:
            # Discovery is a convenience, not the boundary. Falling back to the
            # documented endpoint is fine; failing to verify is not, and that is
            # handled by the caller.
            pass
        _discovery["userinfo"] = endpoint
        return endpoint


_verify_lock = threading.Lock()
_verified: dict[str, tuple[float, Identity]] = {}


def _cached_identity(token: str) -> Identity | None:
    with _verify_lock:
        entry = _verified.get(token)
        if entry is None:
            return None
        expires_at, identity = entry
        if expires_at < time.time():
            _verified.pop(token, None)
            return None
        return identity


def _remember(token: str, identity: Identity) -> None:
    with _verify_lock:
        # Bounded, so a flood of junk tokens cannot grow this without limit.
        if len(_verified) > 512:
            _verified.clear()
        _verified[token] = (time.time() + VERIFY_CACHE_SECONDS, identity)


def verify_identity(token: str) -> Identity:
    """Ask Hugging Face who this token belongs to.

    A 401 from the provider is a 401 here: expired, revoked, forged and
    malformed tokens all arrive at the same place. Anything else that goes
    wrong — the provider is down, the network is broken, the body is not what
    was expected — is also a refusal, because the alternative is letting an
    outage authorise people.
    """
    cached = _cached_identity(token)
    if cached is not None:
        return cached

    request = urllib.request.Request(
        _userinfo_endpoint(),
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=VERIFY_TIMEOUT_SECONDS) as response:
            document = json.loads(response.read().decode("utf8"))
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            raise AuthError(401, "That Hugging Face sign-in is no longer valid. Sign in again.")
        raise AuthError(503, "Hugging Face could not confirm the sign-in. Try again shortly.")
    except Exception:
        raise AuthError(503, "Hugging Face could not confirm the sign-in. Try again shortly.")

    if not isinstance(document, dict):
        raise AuthError(503, "Hugging Face could not confirm the sign-in. Try again shortly.")

    # `whoami-v2` calls it `name`; OIDC userinfo calls it `preferred_username`.
    username = document.get("preferred_username") or document.get("name")
    sub = document.get("sub") or document.get("id") or ""
    if not isinstance(username, str) or not username.strip():
        raise AuthError(401, "That Hugging Face sign-in is no longer valid. Sign in again.")

    identity = Identity(username=username.strip(), sub=str(sub))
    _remember(token, identity)
    return identity


def authorize(token: str) -> Identity:
    """Authenticate, then check the allowlist. Fails closed on both."""
    identity = verify_identity(token)
    permitted = allowed_users()
    if not permitted:
        # Nothing configured. Refusing everyone is the safe reading, and the
        # log line is for whoever deployed it, not for the caller.
        print("[guard] ALLOWED_HF_USERS is not set; refusing every request", flush=True)
        raise AuthError(403, "This studio is not open for use yet.")
    if identity.username.lower() not in permitted:
        # The same sentence whoever is refused: it must not reveal who is on
        # the list, or that a list has any particular contents.
        raise AuthError(403, "This Hugging Face account is not approved for this studio.")
    return identity


# --- abuse brake --------------------------------------------------------------


class RateLimiter:
    """A per-user brake on how often generation may be asked for.

    In process memory, so it resets whenever the Space restarts or sleeps, and
    it is not shared between replicas. That makes it an abuse brake and nothing
    more: it is not the authorization mechanism, and it is not the ZeroGPU
    quota, which Hugging Face accounts for on its own side and which this
    cannot see or extend.
    """

    def __init__(self, limit: int = RATE_LIMIT_REQUESTS, window: int = RATE_LIMIT_WINDOW_SECONDS) -> None:
        self.limit = limit
        self.window = window
        self._seen: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def check(self, username: str) -> None:
        now = time.time()
        key = username.lower()
        with self._lock:
            recent = [t for t in self._seen.get(key, []) if now - t < self.window]
            if len(recent) >= self.limit:
                wait = int(self.window - (now - recent[0])) // 60 + 1
                recent_count = len(recent)
                self._seen[key] = recent
                raise AuthError(
                    429,
                    f"That is {recent_count} songs in the last hour. "
                    f"Try again in about {wait} minute{'s' if wait != 1 else ''}.",
                )
            recent.append(now)
            self._seen[key] = recent


# --- request validation --------------------------------------------------------


def _text(value: object, field: str, limit: int) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise AuthError(400, f"The {field} must be text.")
    # Measured in characters, before any normalisation, so the limit means what
    # it says regardless of what the text is made of.
    if len(value) > limit:
        raise AuthError(400, f"The {field} is {len(value)} characters; the limit is {limit}.")
    return value


def validate_duration(value: object) -> float:
    """A length ACE-Step can be asked for: -1 for Auto, or 10-600 seconds.

    `-1` is the only negative that means anything — it is ACE-Step's own "you
    choose", and the studio depends on it — so every other negative, and every
    value that is not a number at all, is refused here rather than turned into
    a number by accident.
    """
    # A number, and nothing that merely looks like one. `float("271")` would
    # happily accept a string, and a string here means a payload built by hand
    # rather than by the studio.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise AuthError(400, "The song length is not a length.")
    number = float(value)
    # NaN is not equal to itself; infinities are not finite. Neither survives.
    if number != number or number in (float("inf"), float("-inf")):
        raise AuthError(400, "The song length is not a length.")
    if number == AUTO_DURATION:
        return float(AUTO_DURATION)
    rounded = int(round(number))
    if rounded < DURATION_MIN or rounded > DURATION_MAX:
        raise AuthError(
            400,
            f"ACE-Step makes songs from {DURATION_MIN} to {DURATION_MAX} seconds long, "
            f"or chooses a length itself.",
        )
    return float(rounded)


def validate_request(
    style: object, lyrics: object, language: object,
    vocal_gender: object, instrumental: object, duration: object,
) -> dict[str, object]:
    """Everything the generation needs, checked before a GPU is asked for.

    Returns the values to use. Text is returned exactly as it arrived — the
    lyric sheet is the user's, and this refuses payloads rather than editing
    them — so nothing here can change what gets sung.
    """
    checked_style = _text(style, "style", MAX_STYLE_CHARS)
    checked_lyrics = _text(lyrics, "lyrics", MAX_LYRICS_CHARS)
    if not checked_style.strip() and not checked_lyrics.strip():
        raise AuthError(400, "A song needs a style or some lyrics.")

    if not isinstance(language, str) or language.strip().lower() not in VALID_LANGUAGES:
        raise AuthError(400, "That is not a language ACE-Step sings in.")

    if not isinstance(vocal_gender, str) or vocal_gender.strip().lower() not in VALID_VOCAL_GENDERS:
        raise AuthError(400, "The voice must be male, female or mixed.")

    if not isinstance(instrumental, bool):
        # Gradio sends a real boolean for a checkbox; anything else is a client
        # that built the payload by hand.
        raise AuthError(400, "The instrumental setting must be true or false.")

    return {
        "style": checked_style,
        "lyrics": checked_lyrics,
        "language": language.strip().lower(),
        "vocal_gender": vocal_gender.strip().lower(),
        "instrumental": instrumental,
        "duration": validate_duration(duration),
    }


# --- the gate itself ------------------------------------------------------------


def is_public_path(path: str) -> bool:
    """Whether a path costs nothing and reveals nothing, so needs no identity."""
    if path in ("/", ""):
        return True
    return any(path == suffix or path.endswith(suffix) for suffix in PUBLIC_PATH_SUFFIXES)


def authorize_request(request):
    """The gate, run by FastAPI before any handler and before any GPU.

    Gradio calls this for `/queue/join`, `/queue/data`, `/call/*`, `/run/*`,
    `/api/*` and `/file=*` — every path that costs GPU time or hands back a
    result. Returning `None` is a 401; raising is whatever was raised. Either
    way the generation function is never entered, so a refused request cannot
    consume the quota.

    The token is read from the real `Authorization` header of the real
    request. It is not read from the body, which is why a caller cannot supply
    their own identity.
    """
    from fastapi import HTTPException

    path = request.url.path
    if request.method == "OPTIONS" or is_public_path(path):
        # A CORS preflight carries no credentials by definition, and the public
        # paths cost nothing and reveal nothing.
        return "anonymous"
    try:
        token = parse_bearer(request.headers.get("authorization"))
        identity = authorize(token)
    except AuthError as error:
        raise HTTPException(status_code=error.status, detail=error.message)
    return identity.username
