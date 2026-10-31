"""Speech duration, caching, and deadline contracts (no external engine needed)."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import subprocess
import unittest
import wave


SPEC = importlib.util.spec_from_file_location(
    "prepare", Path(__file__).parents[1] / "scripts" / "prepare.py"
)
pipeline = None
if SPEC and SPEC.origin and Path(SPEC.origin).exists():
    pipeline = importlib.util.module_from_spec(SPEC)
    SPEC.loader.exec_module(pipeline)


def wav_bytes(seconds=1):
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(24000)
        audio.writeframes(b"\0\0" * round(seconds * 24000))
    return output.getvalue()


class PrepareTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(pipeline, "Audio-first preparation pipeline is not implemented")

    def test_wav_duration_uses_samples_not_estimated_text_length(self):
        self.assertAlmostEqual(pipeline.wav_duration(wav_bytes(1.25)), 1.25)

    def test_configured_gap_between_spoken_lines_is_about_half_a_second_shorter(self):
        configured = json.loads((Path(__file__).parents[1] / "content/script.json").read_text())
        script = {"fps": 30, "maxSeconds": 300,
                  "leadSeconds": configured["leadSeconds"], "tailSeconds": configured["tailSeconds"],
                  "scenes": [{"id": "a", "lines": [
                      {"id": "first", "text": "前の説明"},
                      {"id": "second", "text": "次の説明"}]}]}
        timeline = pipeline.build_timeline(script, {"first": 1.0, "second": 1.0})
        lines = timeline["scenes"][0]["lines"]
        first_audio_end = lines[0]["from"] + lines[0]["audioFrom"] + lines[0]["audioFrames"]
        second_audio_start = lines[1]["from"] + lines[1]["audioFrom"]
        gap = (second_audio_start - first_audio_end) / script["fps"]
        self.assertAlmostEqual(gap, 0.25, delta=0.04)

    def test_cue_uses_mora_durations_pauses_pre_padding_and_synthesis_speed(self):
        query = {"speedScale": 2, "prePhonemeLength": 0.2, "postPhonemeLength": 0.15,
                 "accent_phrases": [
                     {"moras": [{"text": "マエ", "consonant_length": 0.2, "vowel_length": 0.4}],
                      "pause_mora": {"vowel_length": 0.2}},
                     {"moras": [{"text": "ナ", "consonant_length": 0.1, "vowel_length": 0.3},
                                {"text": "ノ", "consonant_length": 0.1, "vowel_length": 0.3},
                                {"text": "カ", "consonant_length": 0.1, "vowel_length": 0.3}], "pause_mora": None}]}
        self.assertAlmostEqual(pipeline.cue_seconds(query, "ナノカ"), 0.5)
        with self.assertRaisesRegex(ValueError, "ミツカラナイ"):
            pipeline.cue_seconds(query, "ミツカラナイ")

    def test_cue_frame_is_chapter_relative_not_reset_by_a_subtitle(self):
        script = {"fps": 30, "maxSeconds": 300, "leadSeconds": 0.3, "tailSeconds": 0.5,
                  "scenes": [{"id": "growth", "lines": [
                      {"id": "a", "text": "前の字幕"},
                      {"id": "b", "text": "7日", "cues": [{"id": "day-7", "phrase": "ナノカ"}]}]}]}
        query = {"speedScale": 1, "prePhonemeLength": 0.1,
                 "accent_phrases": [{"moras": [{"text": "ナノカ", "vowel_length": 0.5}], "pause_mora": None}]}
        result = pipeline.build_timeline(script, {"a": 1.0, "b": 1.0}, {"b": query})
        self.assertEqual(result["scenes"][0]["cues"], [{"id": "day-7", "frame": 66, "lineId": "b"}])

    def test_alphabetic_subtitle_does_not_change_katakana_synthesis(self):
        def engine(path, **kwargs):
            if path == '/audio_query':
                self.assertEqual(kwargs['params']['text'], 'ユール')
                return {"accent_phrases": []}
            return wav_bytes(1)
        with tempfile.TemporaryDirectory() as directory:
            pipeline.synthesize_line({'id': 'a', 'text': 'Yu_Lu', 'speech': 'ユール'},
                                     {'speaker': 2}, '0.26.0', Path(directory) / 'a.wav', engine)

    def test_invalid_audio_is_rejected_instead_of_becoming_silence(self):
        with self.assertRaisesRegex(ValueError, "WAV"):
            pipeline.wav_duration(b'{"error":"synthesis failed"}')

    def test_timeline_preserves_full_audio_with_frame_rounding_and_handles(self):
        script = {"fps": 30, "maxSeconds": 300, "leadSeconds": 0.3,
                  "tailSeconds": 0.5, "scenes": [
                      {"id": "intro", "lines": [{"id": "a", "text": "こんにちは"}]},
                      {"id": "demo", "lines": [{"id": "b", "text": "送信します"}]},
                  ]}
        timeline = pipeline.build_timeline(script, {"a": 1.01, "b": 2.0})
        self.assertEqual(timeline["scenes"][0]["durationInFrames"], 55)
        self.assertEqual(timeline["scenes"][1]["from"], 55)
        self.assertEqual(timeline["scenes"][1]["durationInFrames"], 84)
        self.assertEqual(timeline["durationInFrames"], 139)
        self.assertEqual(timeline["scenes"][0]["lines"][0]["audioFrom"], 9)

    def test_over_limit_is_an_error_and_never_automatically_speeds_up_voice(self):
        script = {"fps": 30, "maxSeconds": 5, "leadSeconds": 0.3,
                  "tailSeconds": 0.5, "scenes": [
                      {"id": "intro", "lines": [{"id": "a", "text": "説明"}]},
                  ]}
        with self.assertRaisesRegex(ValueError, "limit"):
            pipeline.build_timeline(script, {"a": 5})

    def test_missing_audio_is_an_error(self):
        script = {"fps": 30, "maxSeconds": 300, "leadSeconds": 0.3,
                  "tailSeconds": 0.5, "scenes": [
                      {"id": "intro", "lines": [{"id": "a", "text": "説明"}]},
                  ]}
        with self.assertRaisesRegex(ValueError, "a"):
            pipeline.build_timeline(script, {})

    def test_cache_key_changes_with_text_voice_settings_and_engine_version(self):
        settings = {"speaker": 2, "speedScale": 1.0}
        original = pipeline.cache_key("こんにちは", settings, "0.26.0")
        self.assertNotEqual(original, pipeline.cache_key("こんばんは", settings, "0.26.0"))
        self.assertNotEqual(original, pipeline.cache_key("こんにちは", {**settings, "speaker": 3}, "0.26.0"))
        self.assertNotEqual(original, pipeline.cache_key("こんにちは", {**settings, "speedScale": 0.9}, "0.26.0"))
        self.assertNotEqual(original, pipeline.cache_key("こんにちは", settings, "0.27.0"))

    def test_verified_cache_avoids_engine_requests_but_changed_text_regenerates(self):
        calls = []

        def engine(path, **kwargs):
            calls.append((path, kwargs))
            if path == "/audio_query":
                return {"speedScale": 1, "accent_phrases": []}
            if path == "/synthesis":
                self.assertEqual(kwargs["body"]["speedScale"], 0.95)
                return wav_bytes(1.25)
            self.fail(f"Unexpected request {path}")

        with tempfile.TemporaryDirectory() as directory:
            dest = Path(directory) / "line.wav"
            settings = {"speaker": 2, "speedScale": 0.95}
            line = {"id": "line", "text": "こんにちは"}
            self.assertEqual(pipeline.synthesize_line(line, settings, "0.26.0", dest, engine), 1.25)
            self.assertEqual(pipeline.synthesize_line(line, settings, "0.26.0", dest, engine), 1.25)
            self.assertEqual(len(calls), 2)
            pipeline.synthesize_line({**line, "text": "こんばんは"}, settings, "0.26.0", dest, engine)
            self.assertEqual(len(calls), 4)
            self.assertEqual(hashlib.sha256(dest.read_bytes()).hexdigest(),
                             json.loads(dest.with_suffix(".json").read_text())["audioSha256"])

    def test_captions_share_the_actual_audio_start_and_end(self):
        script = {"fps": 30, "maxSeconds": 300, "leadSeconds": 0.3,
                  "tailSeconds": 0.5, "scenes": [
                      {"id": "intro", "lines": [{"id": "a", "text": "短い説明"}]},
                  ]}
        line = pipeline.build_timeline(script, {"a": 1.25})["scenes"][0]["lines"][0]
        self.assertEqual(line["captions"], [{"text": "短い説明", "startMs": 0,
                         "endMs": 1250, "timestampMs": None, "confidence": None}])

    def test_generated_caption_component_parses_as_valid_tsx(self):
        source_path = Path(__file__).parents[1] / "src/generated/Captions.tsx"
        result = subprocess.run(["node", "--input-type=module", "-e", """
import ts from 'typescript';
import {readFileSync} from 'node:fs';
const result = ts.transpileModule(readFileSync(process.argv[1], 'utf8'), {
  fileName: 'Captions.tsx', reportDiagnostics: true,
  compilerOptions: {jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022}
});
console.log(JSON.stringify((result.diagnostics ?? []).map(d => ts.flattenDiagnosticMessageText(d.messageText, ' '))));
""", str(source_path)], cwd=source_path.parents[2], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [], "Generated caption JSX must compile")


if __name__ == "__main__":
    unittest.main()
