#!/usr/bin/env python3
"""
Run the real full-song test against the deployed Space and record what happened.

Speaks the Gradio HTTP contract directly rather than through gradio_client, for
two reasons: it is the same two calls the browser will make, so a failure here
is a failure there; and it needs no dependency beyond the standard library.

    POST {space}/gradio_api/call/generate_music   {"data": [...]}  -> {"event_id"}
    GET  {space}/gradio_api/call/generate_music/{event_id}          -> SSE

Usage:
    python3 run_test.py https://<user>-<space>.hf.space
    python3 run_test.py https://<user>-<space>.hf.space --duration 271

Writes zerogpu-run-<timestamp>.json, and the WAV if one came back. Records
failures in the same shape as successes: a ZeroGPU quota refusal is a result.
"""

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
API_NAME = "generate_music"


def read_fixture():
    style = (HERE / "fixtures" / "bos-toxic-style.txt").read_text(encoding="utf8").strip()
    lyrics = (HERE / "fixtures" / "bos-toxic-lyrics.txt").read_text(encoding="utf8")
    lines = [l.strip() for l in lyrics.replace("\r\n", "\n").split("\n") if l.strip()]
    lyric_lines = [l for l in lines if not (l.startswith("[") and l.endswith("]"))]
    return style, lyrics, len(lyric_lines)


def post(url, payload, timeout=120):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, json.loads(resp.read().decode())


def stream(url, timeout):
    """Consume the SSE stream, returning (events, raw_tail)."""
    req = urllib.request.Request(url, headers={"Accept": "text/event-stream"})
    events, event, tail = [], {}, []
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        for raw in resp:
            line = raw.decode("utf8", "replace").rstrip("\n")
            tail.append(line)
            if line.startswith("event:"):
                event["event"] = line[6:].strip()
            elif line.startswith("data:"):
                event["data"] = line[5:].strip()
            elif line == "":
                if event:
                    events.append(event)
                    event = {}
    if event:
        events.append(event)
    return events, tail[-40:]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("space_url")
    ap.add_argument("--duration", type=float, default=271)
    ap.add_argument("--language", default="id")
    ap.add_argument("--vocal-gender", default="male")
    ap.add_argument("--instrumental", action="store_true")
    ap.add_argument("--timeout", type=int, default=1800)
    args = ap.parse_args()

    base = args.space_url.rstrip("/")
    style, lyrics, lyric_lines_sent = read_fixture()

    record = {
        "space_url": base,
        "api_name": API_NAME,
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "request": {
            "style": style,
            "lyric_lines_sent": lyric_lines_sent,
            "lyrics_sha256": __import__("hashlib").sha256(
                (HERE / "fixtures" / "bos-toxic-lyrics.txt").read_bytes()).hexdigest(),
            "language": args.language,
            "vocal_gender": args.vocal_gender,
            "instrumental": args.instrumental,
            "duration": args.duration,
        },
    }
    if lyric_lines_sent != 68:
        record["fixture_warning"] = f"expected 68 lyric lines, fixture has {lyric_lines_sent}"

    payload = {"data": [style, lyrics, args.language, args.vocal_gender,
                        args.instrumental, args.duration]}

    wall = time.perf_counter()
    try:
        status, body = post(f"{base}/gradio_api/call/{API_NAME}", payload)
        record["post_status"] = status
        event_id = body.get("event_id")
        record["event_id"] = event_id
        if not event_id:
            raise RuntimeError(f"no event_id in POST response: {body}")

        events, tail = stream(f"{base}/gradio_api/call/{API_NAME}/{event_id}", args.timeout)
        record["wall_clock_s"] = round(time.perf_counter() - wall, 3)
        record["sse_events"] = [e.get("event") for e in events]
        record["sse_tail"] = tail

        completed = [e for e in events if e.get("event") == "complete"]
        errored = [e for e in events if e.get("event") == "error"]
        if errored:
            record["result"] = "ERROR"
            record["error"] = [e.get("data") for e in errored]
        elif completed:
            data = json.loads(completed[-1]["data"])
            record["result"] = "COMPLETE"
            audio, metadata = data[0], data[1]
            record["metadata"] = json.loads(metadata) if isinstance(metadata, str) else metadata
            url = audio.get("url") if isinstance(audio, dict) else audio
            record["audio_url"] = url
            if url:
                out = HERE / f"bos-toxic-zerogpu-{int(time.time())}.wav"
                with urllib.request.urlopen(url, timeout=600) as r, open(out, "wb") as f:
                    f.write(r.read())
                record["wav_path"] = str(out)
                record["wav_bytes_downloaded"] = out.stat().st_size
                record["wav_check"] = check_wav(out)
        else:
            record["result"] = "NO_RESULT"
    except urllib.error.HTTPError as exc:
        record["result"] = "HTTP_ERROR"
        record["http_status"] = exc.code
        record["http_body"] = exc.read().decode("utf8", "replace")[:4000]
        record["wall_clock_s"] = round(time.perf_counter() - wall, 3)
    except Exception as exc:  # noqa: BLE001 — a failure is a result here
        record["result"] = "EXCEPTION"
        record["exception"] = f"{type(exc).__name__}: {exc}"
        record["wall_clock_s"] = round(time.perf_counter() - wall, 3)

    out = HERE / f"zerogpu-run-{int(time.time())}.json"
    out.write_text(json.dumps(record, indent=2, ensure_ascii=False), encoding="utf8")
    print(json.dumps(record, indent=2, ensure_ascii=False)[:6000])
    print(f"\nwritten: {out}")
    return 0 if record.get("result") == "COMPLETE" else 1


def check_wav(path):
    """Minimal RIFF validation, independent of anything the Space claimed."""
    import struct
    raw = path.read_bytes()
    if len(raw) < 44 or raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
        return {"valid": False, "reason": "not a RIFF/WAVE file"}
    pos, fmt, data_bytes = 12, None, 0
    while pos + 8 <= len(raw):
        cid = raw[pos:pos + 4]
        size = struct.unpack("<I", raw[pos + 4:pos + 8])[0]
        if cid == b"fmt ":
            channels, rate = struct.unpack("<HI", raw[pos + 10:pos + 16])
            bits = struct.unpack("<H", raw[pos + 22:pos + 24])[0]
            fmt = {"channels": channels, "sample_rate": rate, "bits": bits}
        elif cid == b"data":
            data_bytes = size
        pos += 8 + size + (size & 1)
    if not fmt or not data_bytes:
        return {"valid": False, "reason": "missing fmt or data chunk"}
    seconds = data_bytes / (fmt["sample_rate"] * fmt["channels"] * fmt["bits"] // 8)
    return {"valid": True, **fmt, "data_bytes": data_bytes, "duration_s": round(seconds, 3)}


if __name__ == "__main__":
    sys.exit(main())
