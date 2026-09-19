"""The last hop: request fields -> the kwargs ACE-Step's `GenerationParams` takes.

This is a separate module with no gradio, no spaces and no torch, for one
reason: it is the step that decides whether a stated tempo reaches the model,
and that step has to be testable without a GPU. `app.py` imports it and does

    params = GenerationParams(**build_generation_params(...))

so what the test checks and what the Space sends are the same dictionary.

The field names here are ACE-Step 1.5's own, read from the vendored
`acestep/inference.py` rather than assumed. The one that matters most:

    if (not params.bpm or params.bpm <= 0) and bpm and int(bpm) > 0:
        params.cot_bpm = bpm

A caller-supplied `bpm` is therefore never overwritten by the model's own
estimate — but only if it actually arrives as an int in `params.bpm`. Sending
the tempo in the caption instead reaches the text encoder and not that field,
and the model's LM then fills `cot_bpm` with whatever it thinks the song is.
A real generation measured 99.4 BPM against a request for 72, which is what
this module exists to make impossible to do by accident.

**Supplying the parameter is not a guarantee.** ACE-Step is a generative model
and `bpm` is a conditioning input, not a clock. What the parameter guarantees is
that the model was *told*; whether the audio came out at that tempo is a
question only measurement answers, and `tempo.py` answers it afterwards.
"""

from __future__ import annotations

from typing import Any, Optional

#: ACE-Step's own documented range for the `bpm` field.
BPM_MIN, BPM_MAX = 30, 300


def normalise_bpm(value: object) -> Optional[int]:
    """The tempo as `GenerationParams.bpm` wants it: an int in range, or None.

    None means "you choose", which is the honest thing to send when the caller
    stated no tempo — an invented one would be worse than the model's estimate.
    Zero, negative and non-numeric all mean the same thing and all become None,
    because `params.bpm = 0` reads as "unset" to the precedence rule above and
    would silently hand the decision back to the LM while looking like a value.
    """
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    rounded = int(round(number))
    if rounded <= 0:
        return None
    return max(BPM_MIN, min(BPM_MAX, rounded))


def build_generation_params(
    *,
    caption: str,
    lyrics: str,
    instrumental: bool,
    language: str,
    duration: float,
    bpm: object = None,
    keyscale: str = "",
    timesignature: str = "",
) -> dict[str, Any]:
    """Every field `GenerationParams` is constructed with, as a plain dict."""
    return {
        "task_type": "text2music",
        "caption": caption,
        "lyrics": "[inst]" if instrumental else lyrics,
        "instrumental": instrumental,
        "vocal_language": language,
        "duration": duration,
        # The real metadata fields. A stated value lands here and is never
        # overwritten; None and "" are the documented "you choose".
        "bpm": normalise_bpm(bpm),
        "keyscale": keyscale or "",
        "timesignature": timesignature or "",
        # The 5 Hz LM is what turns a backing track into singing.
        "thinking": not instrumental,
        # Off, both: these let the LM rewrite the caption and the lyric sheet,
        # and the caption and the lyric sheet are the user's.
        "use_cot_caption": False,
        "use_cot_lyrics": False,
        # The language was stated explicitly; nothing should re-detect it.
        "use_cot_language": False,
    }
