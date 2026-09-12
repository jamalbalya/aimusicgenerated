"""
ACE-Step 1.5 full-song proof of concept on Hugging Face ZeroGPU.

This Space exists to answer one question and nothing else: can free ZeroGPU
produce the whole Bos Toxic song — 271 seconds, Indonesian, male vocal, vocal
and instrumental together — in a single generation request?

It is deliberately not an application. There is one function, one API name, no
options beyond the ones the test needs, and every number the test has to report
is measured inside the function rather than inferred afterwards.

Two things it refuses to do:

  * substitute a model. ACE-Step's own `DEFAULT_LM_MODEL` is the 1.7B, and the
    1.7B ships inside the main checkpoint repo, so it is already sitting on disk
    next to the 0.6B we asked for. Anything that silently falls back lands on it.
    `verify_models()` reads back what was actually loaded and raises if it is not
    what was requested.
  * shorten the song. `duration` is passed through untouched. If the GPU budget
    cannot cover 271 seconds of audio, the correct outcome is a failure that
    says so, not a shorter song that looks like a success.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from pathlib import Path

SPACE_ROOT = Path(__file__).parent.resolve()

# ACE-Step is vendored as source rather than pip-installed. Installing it as a
# package would drag in its dependency list, and that list contains a bare
# `flash-attn` sdist, which cannot build on ZeroGPU because the build phase has
# no nvcc. Putting the source on the path gets the library without the resolver.
VENDOR = SPACE_ROOT / "vendor" / "ACE-Step-1.5"
if not VENDOR.is_dir():
    raise RuntimeError(
        f"ACE-Step source missing at {VENDOR}. Run deploy.sh, which vendors it "
        "at a pinned commit."
    )
sys.path.insert(0, str(VENDOR))

import gradio as gr
import spaces
import torch

import guard

# --- configuration -----------------------------------------------------------

DIT_MODEL = os.environ.get("ACE_STEP_MODEL", "acestep-v15-turbo")
LM_MODEL = os.environ.get("ACE_STEP_LM_MODEL", "acestep-5Hz-lm-0.6B")

# The LM backend. ACE-Step's default is vLLM, which arrives through nano-vllm
# and wants flash-attn; "pt" is ACE-Step's own universal fallback and is what
# its README recommends alongside the 0.6B LM.
LM_BACKEND = os.environ.get("ACE_STEP_LM_BACKEND", "pt")

CHECKPOINTS = Path(os.environ.get("ACE_STEP_CHECKPOINTS", SPACE_ROOT / "checkpoints"))

GPU_SIZE = os.environ.get("ZEROGPU_SIZE", "large")

# Declared GPU seconds. On `large` the spaces client multiplies this by the
# backing GPU's duration_factor (1.5 on the RTX Pro 6000 Blackwell) before the
# scheduler sees it, so 80 is what a 120-second free-tier ceiling actually
# allows. On `xlarge` no factor is applied but the server charges double.
# Override with ZEROGPU_DURATION once a real measurement exists.
DECLARED_DURATION = int(os.environ.get("ZEROGPU_DURATION", "80"))

POC_VERSION = "1"


# --- startup: download, load, verify ------------------------------------------

_startup: dict[str, object] = {"ok": False}


def _load() -> None:
    """Download the checkpoints and initialise both handlers at module scope.

    ZeroGPU wants models placed on cuda during startup so its packing step can
    offload them to disk and stream them back when a GPU attaches. Loading
    lazily inside the decorated function would both be slower and charge the
    load against the visitor's GPU quota.
    """
    from acestep.handler import AceStepHandler
    from acestep.llm_inference import LLMHandler
    from acestep.model_downloader import ensure_lm_model

    CHECKPOINTS.mkdir(parents=True, exist_ok=True)

    # The 0.6B LM is a separate repo; only the 1.7B ships with the main model.
    # Fetch it explicitly, or initialisation has nothing to find but the 1.7B.
    t0 = time.perf_counter()
    ok, message = ensure_lm_model(LM_MODEL, CHECKPOINTS, prefer_source="huggingface")
    if not ok:
        raise RuntimeError(f"could not fetch LM '{LM_MODEL}': {message}")
    lm_download_time = time.perf_counter() - t0

    dit = AceStepHandler()
    llm = LLMHandler()

    t0 = time.perf_counter()
    status, ok = dit.initialize_service(
        project_root=str(SPACE_ROOT),
        config_path=DIT_MODEL,
        device="cuda",
        # ACE-Step's own default; stated here so nobody has to check whether the
        # flash-attn we deliberately did not install was needed after all.
        use_flash_attention=False,
        # torch.compile is unsupported on ZeroGPU.
        compile_model=False,
        use_mlx_dit=False,
        prefer_source="huggingface",
    )
    dit_load_time = time.perf_counter() - t0
    if not ok:
        raise RuntimeError(f"DiT init failed: {status}")

    t0 = time.perf_counter()
    status, ok = llm.initialize(
        checkpoint_dir=str(CHECKPOINTS),
        lm_model_path=LM_MODEL,
        backend=LM_BACKEND,
        device="cuda",
    )
    lm_load_time = time.perf_counter() - t0
    if not ok:
        raise RuntimeError(f"LM init failed: {status}")

    verify_models(dit, llm)

    _startup.update(
        ok=True,
        dit=dit,
        llm=llm,
        lm_download_time=round(lm_download_time, 3),
        model_load_time=round(dit_load_time, 3),
        LM_load_time=round(lm_load_time, 3),
    )


def verify_models(dit, llm) -> dict[str, str]:
    """Prove the loaded models are the requested ones, or raise.

    Both read-backs are recorded by ACE-Step itself at initialisation time:
    `last_init_params["config_path"]` for the DiT, and `_lm_full_model_path` —
    the resolved on-disk path — for the LM. The resolved path is the one that
    matters: a request for the 0.6B that quietly resolved to the 1.7B sitting in
    the main checkpoint directory would still echo back the name we asked for.
    """
    loaded_dit = str((getattr(dit, "last_init_params", None) or {}).get("config_path", ""))
    lm_config = getattr(llm, "_last_initialize_config", None) or {}
    loaded_lm = str(lm_config.get("lm_model_path", ""))
    lm_path = str(getattr(llm, "_lm_full_model_path", "") or "")

    if loaded_dit != DIT_MODEL:
        raise RuntimeError(f"DiT substitution: asked {DIT_MODEL!r}, loaded {loaded_dit!r}")
    if loaded_lm != LM_MODEL:
        raise RuntimeError(f"LM substitution: asked {LM_MODEL!r}, loaded {loaded_lm!r}")
    if LM_MODEL not in lm_path:
        raise RuntimeError(f"LM resolved to an unexpected path: {lm_path!r}")
    # Belt and braces: the 1.7B is the one thing that must never appear here.
    if "1.7B" in lm_path and "1.7B" not in LM_MODEL:
        raise RuntimeError(f"LM fell back to the 1.7B: {lm_path!r}")

    return {"dit": loaded_dit, "lm": loaded_lm, "lm_path": lm_path}


def gpu_facts() -> dict[str, object]:
    if not torch.cuda.is_available():
        return {"gpu_name": None, "gpu_memory_bytes": None, "cuda_version": None}
    props = torch.cuda.get_device_properties(0)
    return {
        "gpu_name": torch.cuda.get_device_name(0),
        "gpu_memory_bytes": props.total_memory,
        "gpu_memory_gb": round(props.total_memory / 1024**3, 2),
        "cuda_version": torch.version.cuda,
        "torch_version": torch.__version__,
        "capability": f"{props.major}.{props.minor}",
    }


_load()


# --- the one GPU function -----------------------------------------------------

RATE_LIMITER = guard.RateLimiter()

# Said once, at startup, where a deployer will see it in the build log. A Space
# configured to allow anonymous callers does not get them, and silently winning
# that argument would leave someone believing the door is open.
if guard.disabling_sign_in_was_attempted():
    print(
        "[guard] REQUIRE_HF_SIGN_IN asks for anonymous access; ignoring it. "
        "A Hugging Face sign-in is required to generate.",
        file=sys.stderr, flush=True,
    )

# The gate itself lives in `guard`, so it can be exercised by a real HTTP client
# without importing this file — which would mean importing torch, ACE-Step and
# eleven gigabytes of checkpoints. A security check that cannot be tested is a
# security check nobody has tested.
authorize_request = guard.authorize_request


def _deny(error: guard.AuthError):
    """An `AuthError` as the failure Gradio reports, status first.

    The status leads the message because the queue protocol carries a message
    and not a status code: a caller reading the error text can still tell a
    refusal to sign in from a refusal to admit them.
    """
    return gr.Error(f"{error.status}: {error.message}")


@spaces.GPU(duration=DECLARED_DURATION, size=GPU_SIZE)
def _generate_on_gpu(style, lyrics, language, vocal_gender, instrumental, duration):
    """One request in, one complete song out.

    Only reached once the caller has been authenticated, authorised and their
    inputs validated: nothing in here decides who may run it.

    Returns (wav_path, metadata_json). Every timing in the metadata is measured
    here, inside the GPU call, so nothing has to be extrapolated later.
    """
    from acestep.inference import GenerationConfig, GenerationParams, generate_music

    request_started = time.perf_counter()

    dit, llm = _startup["dit"], _startup["llm"]
    models = verify_models(dit, llm)  # again, per request: nothing reloads silently

    instrumental = bool(instrumental)
    duration = float(duration)

    # The caption carries the vocal gender. ACE-Step has no gender parameter —
    # the voice is described in the caption — and this mirrors exactly what the
    # application's own request builder does, so the POC tests the real prompt.
    caption = style.strip()
    if not instrumental and vocal_gender in ("male", "female"):
        if vocal_gender not in caption.lower():
            caption = f"{caption.rstrip(',; ')}, {vocal_gender} lead vocal"

    sheet = lyrics.replace("\r\n", "\n").replace("\r", "\n").rstrip()
    lyric_lines_sent = sum(
        1 for line in sheet.split("\n")
        if line.strip() and not (line.strip().startswith("[") and line.strip().endswith("]"))
    )

    params = GenerationParams(
        task_type="text2music",
        caption=caption,
        lyrics="[inst]" if instrumental else sheet,
        instrumental=instrumental,
        vocal_language=language,
        duration=duration,
        # The 5 Hz LM is what turns a backing track into singing.
        thinking=not instrumental,
        # Off, both of them: these let the LM rewrite the caption and the lyric
        # sheet, and the caption and the lyric sheet are the user's.
        use_cot_caption=False,
        use_cot_lyrics=False,
        # The language was stated explicitly; nothing should re-detect it.
        use_cot_language=False,
    )
    config = GenerationConfig(
        batch_size=1,          # ACE-Step defaults to 2, which doubles the GPU bill
        audio_format="wav",
        use_random_seed=True,
    )

    generation_started = time.perf_counter()
    result = generate_music(dit, llm, params, config, save_dir=tempfile.mkdtemp())
    generation_time = time.perf_counter() - generation_started

    if not result.success or not result.audios:
        raise gr.Error(f"ACE-Step generation failed: {result.error or result.status_message}")

    audio = result.audios[0]
    tensor = audio["tensor"]
    sample_rate = int(audio["sample_rate"])
    channels, samples = (tensor.shape[0], tensor.shape[-1]) if tensor.dim() > 1 else (1, tensor.shape[-1])

    # Unique path per request: handlers run concurrently on ZeroGPU.
    out = Path(tempfile.mkdtemp()) / "bos-toxic.wav"
    import soundfile as sf
    sf.write(str(out), tensor.T.cpu().numpy() if tensor.dim() > 1 else tensor.cpu().numpy(), sample_rate)

    metadata = {
        "poc_version": POC_VERSION,
        "declared_gpu_duration_s": DECLARED_DURATION,
        "zerogpu_size": GPU_SIZE,
        **gpu_facts(),
        "requested_model": DIT_MODEL,
        "requested_lm_model": LM_MODEL,
        "loaded_model": models["dit"],
        "loaded_lm_model": models["lm"],
        "loaded_lm_path": models["lm_path"],
        "lm_backend": LM_BACKEND,
        "model_load_time_s": _startup["model_load_time"],
        "LM_load_time_s": _startup["LM_load_time"],
        "lm_download_time_s": _startup["lm_download_time"],
        # ACE-Step's own per-stage breakdown: lm_* and dit_* keys, verbatim,
        # so nothing here depends on guessing what it calls each stage.
        "time_costs": result.extra_outputs.get("time_costs", {}),
        "total_generation_time_s": round(generation_time, 3),
        "total_request_time_s": round(time.perf_counter() - request_started, 3),
        "requested_audio_duration_s": duration,
        "audio_duration_s": round(samples / sample_rate, 3),
        "wav_sample_rate": sample_rate,
        "wav_channels": int(channels),
        "wav_bytes": out.stat().st_size,
        "peak_level": float(tensor.abs().max().item()),
        "lyric_lines_sent": lyric_lines_sent,
        "instrumental": instrumental,
        "vocal_language": language,
        "seed": audio.get("params", {}).get("seed"),
        "status_message": result.status_message,
    }
    return str(out), json.dumps(metadata, indent=2, ensure_ascii=False)


# --- the minimal interface ----------------------------------------------------

STYLE = (SPACE_ROOT / "fixtures" / "bos-toxic-style.txt").read_text(encoding="utf8").strip()
LYRICS = (SPACE_ROOT / "fixtures" / "bos-toxic-lyrics.txt").read_text(encoding="utf8")

def generate(style, lyrics, language, vocal_gender, instrumental, duration, request: gr.Request):
    """The generation endpoint, and the second half of the boundary.

    `authorize_request` has already refused unauthenticated callers at the HTTP
    layer. This checks again anyway, from the same server-derived header, so
    that the handler is safe even if it is ever reached by a path that was not
    gated — a security check that only exists in one place is one deployment
    change away from not existing.

    `request` is built by Gradio from the actual HTTP request. It is not part of
    the six inputs and cannot be supplied by the caller, which is what makes it
    usable as the source of identity. The body is never consulted for who the
    caller is.
    """
    try:
        caller = guard.caller_for(request)
        checked = guard.validate_request(
            style, lyrics, language, vocal_gender, instrumental, duration
        )
        RATE_LIMITER.check(caller)
    except guard.AuthError as error:
        # Raised before the GPU function is called, so a refusal costs nothing.
        raise _deny(error) from None

    return _generate_on_gpu(
        checked["style"], checked["lyrics"], checked["language"],
        checked["vocal_gender"], checked["instrumental"], checked["duration"],
    )


with gr.Blocks(title="ACE-Step 1.5 full-song POC") as demo:
    gr.Markdown(
        "### ACE-Step 1.5 — full-song ZeroGPU proof of concept\n"
        f"DiT `{DIT_MODEL}` · LM `{LM_MODEL}` · backend `{LM_BACKEND}` · "
        f"declared GPU duration `{DECLARED_DURATION}s` on `{GPU_SIZE}`.\n\n"
        "Defaults are the Bos Toxic fixture at its full 271 seconds. "
        "This Space exists to measure, not to be used."
    )
    with gr.Row():
        with gr.Column():
            style = gr.Textbox(label="style", value=STYLE, lines=3)
            lyrics = gr.Textbox(label="lyrics", value=LYRICS, lines=16)
            with gr.Row():
                language = gr.Textbox(label="language", value="id")
                vocal_gender = gr.Dropdown(
                    label="vocal_gender", choices=["male", "female", "mixed"], value="male"
                )
            with gr.Row():
                instrumental = gr.Checkbox(label="instrumental", value=False)
                duration = gr.Number(label="duration (s)", value=271, precision=0)
            run = gr.Button("Generate", variant="primary")
        with gr.Column():
            audio_out = gr.Audio(label="generated audio", type="filepath")
            meta_out = gr.Code(label="metadata", language="json")

    run.click(
        generate,
        inputs=[style, lyrics, language, vocal_gender, instrumental, duration],
        outputs=[audio_out, meta_out],
        api_name="generate_music",
    )

if __name__ == "__main__":
    # `auth_dependency` is what makes this a boundary rather than a suggestion:
    # FastAPI runs it before the queue, the call endpoints and the file route,
    # so an unauthenticated request is refused before a GPU is ever asked for.
    demo.queue().launch(auth_dependency=authorize_request)
