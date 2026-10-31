#!/usr/bin/env python3
"""Offline preflight: reject stale narration, missing media, and truncated audio."""
import hashlib
import json
from pathlib import Path
import sys
import wave

ROOT = Path(__file__).resolve().parents[1]


def verify_file(path, expected):
    if not path.is_file():
        raise ValueError(f"Missing asset: {path.name}")
    if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise ValueError(f"Asset checksum differs: {path.name}")


def validate_project(root):
    script_path = root / "content/script.json"
    script = json.loads(script_path.read_text())
    timeline = json.loads((root / "src/generated/timeline.json").read_text())
    if hashlib.sha256(script_path.read_bytes()).hexdigest() != timeline.get("scriptSha256"):
        raise ValueError("Narration script has changed: run npm run voice before previewing or exporting")
    if not 0 < timeline["durationInFrames"] <= script["maxSeconds"] * timeline["fps"]:
        raise ValueError("Video does not fit the submission limit")
    count = 0
    cursor = 0
    for scene in timeline["scenes"]:
        if scene["from"] != cursor:
            raise ValueError("Scene timeline has a gap or overlap")
        for line in scene["lines"]:
            asset = root / "public" / line["audio"]
            metadata = json.loads(asset.with_suffix(".json").read_text())
            verify_file(asset, metadata["audioSha256"])
            with wave.open(str(asset), "rb") as audio:
                seconds = audio.getnframes() / audio.getframerate()
            if abs(seconds - line["seconds"]) > 0.001:
                raise ValueError(f"Audio duration mismatch: {line['id']}")
            if line["audioFrom"] + seconds * timeline["fps"] > line["durationInFrames"]:
                raise ValueError(f"Audio would be cut off: {line['id']}")
            count += 1
        cursor += scene["durationInFrames"]
    if cursor != timeline["durationInFrames"]:
        raise ValueError("Composition duration does not match its scenes")
    screenshots = ('chat', 'conversation', 'home', 'friends',
                   'growth-1', 'growth-7', 'growth-30', 'growth-60', 'growth-100',
                   'streak-1', 'streak-100', 'streak-reset')
    for name in screenshots:
        path = root / "public/screens" / f"{name}.png"
        if not path.is_file():
            raise ValueError(f"Missing screenshot: {name}")
        metadata = json.loads(path.with_suffix(".json").read_text())
        verify_file(path, metadata["sha256"])
        if path.read_bytes()[:8] != b"\x89PNG\r\n\x1a\n":
            raise ValueError(f"Expected a PNG screenshot: {name}")
    demo = json.loads((root / "src/generated/demo.json").read_text())
    if demo["available"]:
        scene = next(s for s in timeline["scenes"] if s["id"] == "screens")
        signature = [{"id": line["id"], "from": line["from"], "durationInFrames": line["durationInFrames"],
                      "screen": line.get("screen")} for line in scene["lines"]]
        if demo["segments"] != signature:
            raise ValueError("Navigation recording is stale; record it again for the current audio")
        verify_file(root / "public" / demo["source"], demo["sha256"])
        if demo["seconds"] < scene["durationInFrames"] / timeline["fps"]:
            raise ValueError("Navigation source is shorter than its audio")
    return {"seconds": timeline["seconds"], "audioFiles": count,
            "screenshots": len(screenshots), "realNavigation": demo["available"]}


if __name__ == "__main__":
    try:
        print(json.dumps(validate_project(ROOT), ensure_ascii=False, indent=2))
    except (ValueError, OSError, KeyError) as error:
        print(f"Preflight failed: {error}", file=sys.stderr)
        raise SystemExit(1)
