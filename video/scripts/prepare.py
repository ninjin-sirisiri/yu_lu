#!/usr/bin/env python3
"""Generate VOICEVOX speech, then derive the video timeline from actual WAV samples."""
import argparse
import hashlib
import io
import json
import math
import os
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request
import wave

ROOT = Path(__file__).resolve().parents[1]


def wav_duration(data):
    try:
        with wave.open(io.BytesIO(data), "rb") as audio:
            duration = audio.getnframes() / audio.getframerate()
            if duration <= 0:
                raise ValueError("Empty WAV audio")
            return duration
    except (wave.Error, EOFError, ZeroDivisionError) as error:
        raise ValueError("Expected a nonempty PCM WAV response") from error


def cache_key(text, settings, version):
    value = json.dumps({"text": text, "settings": settings, "engine": version},
                       ensure_ascii=False, sort_keys=True).encode()
    return hashlib.sha256(value).hexdigest()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    temporary.replace(path)


def synthesize_line(line, settings, version, destination, engine):
    text = line.get("speech", line["text"])
    key = cache_key(text, settings, version)
    metadata_path = destination.with_suffix(".json")
    if destination.exists() and metadata_path.exists():
        try:
            metadata = json.loads(metadata_path.read_text())
            data = destination.read_bytes()
            if metadata["key"] == key and metadata["audioSha256"] == hashlib.sha256(data).hexdigest():
                if line.get("cues") and "query" not in metadata:
                    query = engine("/audio_query", params={"text": text, "speaker": settings["speaker"]})
                    query.update({k: v for k, v in settings.items() if k != "speaker"})
                    metadata["query"] = query
                    write_json(metadata_path, metadata)
                return wav_duration(data)
        except (ValueError, KeyError):
            pass  # A partial or corrupted cache must be regenerated, never accepted.
    query = engine("/audio_query", params={"text": text, "speaker": settings["speaker"]})
    for name, value in settings.items():
        if name != "speaker":
            query[name] = value
    data = engine("/synthesis", params={"speaker": settings["speaker"]}, body=query, binary=True)
    duration = wav_duration(data)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".wav.tmp")
    temporary.write_bytes(data)
    temporary.replace(destination)
    write_json(metadata_path, {"key": key, "engineVersion": version, "settings": settings,
                              "text": text, "seconds": duration, "query": query,
                              "audioSha256": hashlib.sha256(data).hexdigest()})
    return duration


def cue_seconds(query, phrase):
    """Locate a spoken kana span using the synthesis query's real phoneme lengths."""
    cursor = query.get("prePhonemeLength", 0.1)
    text = ""
    starts = []
    for accent in query["accent_phrases"]:
        for mora in accent["moras"]:
            starts.extend([cursor] * len(mora["text"]))
            text += mora["text"]
            cursor += (mora.get("consonant_length") or 0) + mora["vowel_length"]
        pause = accent.get("pause_mora")
        if pause:
            cursor += pause["vowel_length"]
    index = text.find(phrase)
    if index < 0 or text.find(phrase, index + 1) >= 0:
        raise ValueError(f"Cue phrase must match exactly once: {phrase} (query: {text})")
    return starts[index] / query.get("speedScale", 1)


def build_timeline(script, durations, queries=None):
    fps = script["fps"]
    lead = math.ceil(script["leadSeconds"] * fps)
    tail = math.ceil(script["tailSeconds"] * fps)
    cursor = 0
    scenes = []
    for scene in script["scenes"]:
        offset = 0
        lines = []
        cues = []
        for line in scene["lines"]:
            if line["id"] not in durations:
                raise ValueError(f"Missing audio for {line['id']}")
            seconds = durations[line["id"]]
            if not math.isfinite(seconds) or seconds <= 0:
                raise ValueError(f"Invalid duration for {line['id']}")
            audio_frames = math.ceil(seconds * fps)
            frames = lead + audio_frames + tail
            for cue in line.get("cues", []):
                seconds_at = cue_seconds((queries or {})[line["id"]], cue["phrase"])
                if seconds_at >= seconds:
                    raise ValueError(f"Cue outside actual audio: {cue['id']}")
                cues.append({"id": cue["id"], "frame": offset + lead + round(seconds_at * fps), "lineId": line["id"]})
            lines.append({**line, "from": offset, "audioFrom": lead,
                          "audioFrames": audio_frames, "durationInFrames": frames,
                          "audio": f"audio/{line['id']}.wav", "seconds": seconds,
                          "captions": [{"text": line["text"], "startMs": 0,
                                        "endMs": round(seconds * 1000),
                                        "timestampMs": None, "confidence": None}]})
            offset += frames
        scenes.append({**scene, "from": cursor, "durationInFrames": offset, "lines": lines, "cues": sorted(cues, key=lambda c: c["frame"])})
        cursor += offset
    if cursor > script["maxSeconds"] * fps:
        raise ValueError(f"Video exceeds {script['maxSeconds']}s limit: {cursor / fps:.2f}s. "
                         "Shorten the script; audio is never sped up automatically.")
    return {"fps": fps, "durationInFrames": cursor, "seconds": cursor / fps,
            "voiceCredit": script["voiceCredit"] if "voiceCredit" in script else "",
            "scenes": scenes}


def request_engine(base, path, *, params=None, body=None, binary=False, method="POST"):
    url = base.rstrip("/") + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method,
                                     headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            result = response.read()
    except (urllib.error.URLError, TimeoutError) as error:
        raise RuntimeError(f"VOICEVOX {path} failed. Start the engine at {base}. {error}") from error
    return result if binary else json.loads(result)


def validate_script(script):
    ids = [line["id"] for scene in script["scenes"] for line in scene["lines"]]
    if len(ids) != len(set(ids)):
        raise ValueError("Narration line IDs must be unique")
    for value in ids + [s["id"] for s in script["scenes"]]:
        if not value or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in value):
            raise ValueError(f"Unsafe asset identifier: {value}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", default=os.environ.get("VOICEVOX_URL", "http://127.0.0.1:50021"))
    args = parser.parse_args()
    script = json.loads((ROOT / "content/script.json").read_text())
    validate_script(script)
    engine = lambda path, **kwargs: request_engine(args.engine, path, **kwargs)
    version = engine("/version", method="GET")
    speakers = engine("/speakers", method="GET")
    selected = [(s["name"], style["name"]) for s in speakers for style in s["styles"]
                if style["id"] == script["voice"]["speaker"]]
    if not selected:
        raise ValueError("Configured speaker is unavailable; choose an ID from /speakers")
    expected_credit = "VOICEVOX:" + selected[0][0]
    if script["voiceCredit"] != expected_credit:
        raise ValueError(f"Voice credit must match selected speaker: {expected_credit}")
    print(f"VOICEVOX {version} / {selected[0][0]} ({selected[0][1]})", flush=True)
    durations = {}
    queries = {}
    for scene in script["scenes"]:
        for line in scene["lines"]:
            destination = ROOT / "public/audio" / (line["id"] + ".wav")
            durations[line["id"]] = synthesize_line(line, script["voice"], version, destination, engine)
            if line.get("cues"):
                queries[line["id"]] = json.loads(destination.with_suffix('.json').read_text())["query"]
            print(f"  {line['id']}: {durations[line['id']]:.2f}s", flush=True)
    timeline = build_timeline(script, durations, queries)
    timeline["scriptSha256"] = hashlib.sha256((ROOT / "content/script.json").read_bytes()).hexdigest()
    write_json(ROOT / "src/generated/timeline.json", timeline)
    demo_meta_path = ROOT / "public/demo/navigation.json"
    demo = json.loads(demo_meta_path.read_text()) if demo_meta_path.exists() else {"available": False}
    screen_scene = next((s for s in timeline["scenes"] if s["id"] == "screens"), None)
    signature = [{"id": line["id"], "from": line["from"], "durationInFrames": line["durationInFrames"],
                  "screen": line.get("screen")} for line in screen_scene["lines"]] if screen_scene else []
    demo["available"] = demo.get("segments") == signature and (ROOT / "public/demo/navigation.mp4").exists()
    write_json(ROOT / "src/generated/demo.json", demo)
    # Authored JSX is generated intentionally: editing script/audio is the source of truth.
    caption_lines = ["// Generated by scripts/prepare.py. Edit content/script.json, then npm run voice.",
                     "import {BasicCaptions} from '../BasicCaptions';",
                     "import {Sequence} from 'remotion';", "export const Captions = ({id}: {id: string}) => <>"]
    for scene in timeline["scenes"]:
        for line in scene["lines"]:
            caption_lines.append(f"{{id === {json.dumps(line['id'])} && <Sequence from={{{line['audioFrom']}}} "
                                 f"durationInFrames={{{line['audioFrames']}}} name=\"字幕\">"
                                 f"<BasicCaptions name=\"ナレーション字幕\" width={{1660}} "
                                 "style={{position: 'absolute', bottom: 42, left: 130}} "
                                 f"captions={{{json.dumps(line['captions'], ensure_ascii=False)}}} />"
                                 "</Sequence>}")
    caption_lines.append("</>;\n")
    (ROOT / "src/generated/Captions.tsx").write_text("\n".join(caption_lines))
    narration = f"# {script['title']} ナレーション台本\n\n"
    for scene in script["scenes"]:
        narration += f"## {scene['title']}\n\n" + "\n\n".join(line["text"] for line in scene["lines"]) + "\n\n"
    (ROOT / "content/narration.md").write_text(narration)
    print(f"Timeline: {timeline['seconds']:.2f}s / {timeline['durationInFrames']} frames", flush=True)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError) as error:
        print(error, file=sys.stderr)
        raise SystemExit(1)
