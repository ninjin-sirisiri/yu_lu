import importlib.util
import json
from pathlib import Path
import tempfile
import shutil
import unittest

path = Path(__file__).parents[1] / "scripts/check_assets.py"
checker = None
if path.exists():
    spec = importlib.util.spec_from_file_location("checker", path)
    checker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(checker)


class AssetTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(checker, "Offline asset validation is not implemented")

    def test_changed_script_refuses_to_validate_a_stale_soundtrack(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "content").mkdir()
            (root / "content/script.json").write_text('{"new":"script"}')
            (root / "src/generated").mkdir(parents=True)
            (root / "src/generated/timeline.json").write_text(json.dumps({"scriptSha256": "old"}))
            with self.assertRaisesRegex(ValueError, "script.*changed"):
                checker.validate_project(root)

    def test_missing_asset_is_reported_with_its_name(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(ValueError, "missing.wav"):
                checker.verify_file(Path(temp) / "missing.wav", "hash")

    def test_tampered_asset_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "clip.wav"
            path.write_bytes(b"modified")
            with self.assertRaisesRegex(ValueError, "checksum"):
                checker.verify_file(path, "not-the-matching-hash")

    def test_growth_stage_media_cannot_be_missing_from_a_valid_video(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = Path(__file__).parents[1]
            for folder in ('content', 'public', 'src/generated'):
                shutil.copytree(source / folder, root / folder)
            (root / 'public/screens/growth-100.png').unlink(missing_ok=True)
            with self.assertRaisesRegex(ValueError, 'growth-100'):
                checker.validate_project(root)


if __name__ == "__main__":
    unittest.main()
