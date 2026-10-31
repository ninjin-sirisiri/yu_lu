#!/usr/bin/env python3
"""Capture real simulator screens and an audio-timed navigation demo. Never sends messages."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import signal
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]


def recording_plan(timeline, peer):
    try:
        uuid.UUID(peer)
    except ValueError as error:
        raise ValueError("Conversation peer must be a UUID") from error
    scene = next(scene for scene in timeline["scenes"] if scene["id"] == "screens")
    routes = {"chat": "app://chat", "friends": "app://friends",
              "conversation": f"app://conversations/{peer}?origin=chat"}
    return [{"id": line["id"], "route": routes[line["screen"]],
             "startSeconds": line["from"] / timeline["fps"],
             "endSeconds": (line["from"] + line["durationInFrames"]) / timeline["fps"]}
            for line in scene["lines"]]


def simctl(*args):
    return subprocess.run(["xcrun", "simctl", *args], check=True,
                          capture_output=True, text=True).stdout.strip()


def snapshot(device, name, note):
    if not name or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in name):
        raise ValueError("Screenshot name must contain only lowercase letters, digits, and hyphens")
    destination = ROOT / "public/screens" / f"{name}.png"
    destination.parent.mkdir(parents=True, exist_ok=True)
    simctl("io", device, "screenshot", str(destination))
    metadata = {"capturedAt": datetime.now(timezone.utc).isoformat(), "device": device,
                "source": "xcrun simctl io screenshot", "note": note,
                "sha256": hashlib.sha256(destination.read_bytes()).hexdigest()}
    destination.with_suffix(".json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
    return destination


def record(device, peer):
    timeline = json.loads((ROOT / "src/generated/timeline.json").read_text())
    plan = recording_plan(timeline, peer)
    destination = ROOT / "public/demo/navigation.mp4"
    destination.parent.mkdir(parents=True, exist_ok=True)
    simctl("openurl", device, plan[0]["route"])
    # A recording hold is intentional: these real-time holds match synthesized narration.
    # No sped-up UI, fabricated taps, auth changes, or database writes are used.
    process = subprocess.Popen(["xcrun", "simctl", "io", device, "recordVideo", "--codec=h264",
                                "--force", str(destination)], stderr=subprocess.PIPE, text=True)
    try:
        while True:
            message = process.stderr.readline()
            if "Recording started" in message:
                break
            if not message and process.poll() is not None:
                raise RuntimeError("Simulator recording failed before its first frame")
        start = time.monotonic()
        for segment in plan:
            wait = start + segment["startSeconds"] - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            simctl("openurl", device, segment["route"])
            print(f"Recording {segment['id']}: {segment['startSeconds']:.2f}–{segment['endSeconds']:.2f}s", flush=True)
            remaining = start + segment["endSeconds"] - time.monotonic()
            if remaining > 0:
                time.sleep(remaining)
        # Extra source tail prevents the final shot from running out after frame rounding.
        time.sleep(0.5)
    finally:
        process.send_signal(signal.SIGINT)
        try:
            process.communicate(timeout=30)
        except subprocess.TimeoutExpired:
            process.terminate()
            process.communicate(timeout=10)
    if process.returncode != 0:
        raise RuntimeError(f"Simulator recording exited with {process.returncode}")
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                            "-of", "default=noprint_wrappers=1:nokey=1", str(destination)],
                           check=True, capture_output=True, text=True)
    duration = float(probe.stdout)
    if duration + 0.1 < plan[-1]["endSeconds"]:
        raise RuntimeError("Recording is shorter than its narration; refusing to use it")
    scene = next(scene for scene in timeline["scenes"] if scene["id"] == "screens")
    signature = [{"id": line["id"], "from": line["from"], "durationInFrames": line["durationInFrames"],
                  "screen": line["screen"]} for line in scene["lines"]]
    metadata = {"available": True, "source": "demo/navigation.mp4", "seconds": duration,
                "segments": signature, "capturedAt": datetime.now(timezone.utc).isoformat(),
                "method": "simctl recordVideo + app deep links; playback speed 1x",
                "includesMessageSend": False, "includesGrowthChange": False,
                "sha256": hashlib.sha256(destination.read_bytes()).hexdigest()}
    (destination.with_suffix(".json")).write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
    (ROOT / "src/generated/demo.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
    print(f"Recorded real navigation: {duration:.2f}s", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", default="booted", help="Explicit simulator UDID is recommended")
    sub = parser.add_subparsers(dest="command", required=True)
    shot = sub.add_parser("snapshot", help="Capture the currently displayed screen; visually review it before use")
    shot.add_argument("name")
    shot.add_argument("--note", required=True)
    demo = sub.add_parser("record-navigation")
    demo.add_argument("--peer", required=True, help="An existing consenting test friend's UUID")
    args = parser.parse_args()
    if args.command == "snapshot":
        print(snapshot(args.device, args.name, args.note))
    else:
        record(args.device, args.peer)


if __name__ == "__main__":
    main()
