import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).parents[1] / "scripts/capture.py"
capture = None
if path.exists():
    spec = importlib.util.spec_from_file_location("capture", path)
    capture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(capture)


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(capture, "Simulator recording plan is not implemented")

    def test_routes_and_holds_follow_audio_timeline_without_rescaling(self):
        timeline = {"fps": 30, "scenes": [{"id": "screens", "durationInFrames": 180,
                    "lines": [{"id": "first", "from": 0, "durationInFrames": 60, "screen": "chat"},
                              {"id": "second", "from": 60, "durationInFrames": 120, "screen": "conversation"}]}]}
        result = capture.recording_plan(timeline, "8209a340-3083-4289-afbb-29c4d83cd024")
        self.assertEqual(result, [
            {"id": "first", "route": "app://chat", "startSeconds": 0, "endSeconds": 2},
            {"id": "second", "route": "app://conversations/8209a340-3083-4289-afbb-29c4d83cd024?origin=chat",
             "startSeconds": 2, "endSeconds": 6}])

    def test_invalid_peer_refuses_to_navigate_to_an_unrelated_route(self):
        with self.assertRaisesRegex(ValueError, "UUID"):
            capture.recording_plan({"scenes": []}, "../login?token=bad")


if __name__ == "__main__":
    unittest.main()
