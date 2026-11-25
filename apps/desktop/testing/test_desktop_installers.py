"""核对历史版本补发范围，以及部分上传后重试的公开字节。"""
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("installers", Path(__file__).resolve().parents[1] / "installer/publish.py")
installers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installers)


class InstallerTests(unittest.TestCase):
    """以小型附件验证版本页和既有稳定清单之间的写入边界。"""

    def test_partial_retry_and_public_checksums(self):
        version = "0.1.5"
        tag = "flower-desktop-v" + version
        prefix = "Flower-Desktop-" + version
        setup = prefix + "-win32-x64-setup.exe"
        names = [setup, prefix + "-darwin-arm64-manual.dmg", prefix + "-darwin-x64-manual.dmg"]
        remote = {"SHA256SUMS.txt": b"original sums", "flower-desktop-update.json": b"original feed", setup: b"first EXE"}
        item = {"id": 1, "tag_name": tag, "draft": False, "prerelease": False, "body": "original notes"}
        uploaded = []

        def assets(_id):
            self.assertEqual(_id, 1)
            return {name: {"state": "uploaded", "size": len(data), "digest": "sha256:" + hashlib.sha256(data).hexdigest()}
                    for name, data in remote.items()}

        def gh(command, action, release_tag, path, *args):
            self.assertEqual((command, action, release_tag), ("release", "upload", tag))
            self.assertNotIn(path.name, remote)
            uploaded.append(path.name)
            remote[path.name] = path.read_bytes()

        def api(path, *args):
            if args:
                self.assertEqual((path, *args[:3]), ("releases/1", "-X", "PATCH", "-f"))
                item["body"] = args[3].removeprefix("body=")
            else:
                self.assertEqual(path, "releases/tags/" + tag)
            return item

        with tempfile.TemporaryDirectory() as temp, patch.object(installers, "release_assets", side_effect=assets), \
                patch.object(installers, "gh", side_effect=gh), patch.object(installers, "api", side_effect=api):
            root = Path(temp)
            for name in names:
                (root / name).write_bytes(b"new " + name.encode())
            installers.publish(root, version, True)
            installers.publish(root, version, True)
            self.assertEqual(uploaded, names[1:] + [installers.SUMS])
            expected = "".join(f"{hashlib.sha256(remote[n]).hexdigest()}  {n}\n" for n in sorted(names))
            self.assertEqual(remote[installers.SUMS].decode(), expected)
            self.assertEqual(remote[setup], b"first EXE")
            self.assertEqual(remote["SHA256SUMS.txt"], b"original sums")
            self.assertEqual(remote["flower-desktop-update.json"], b"original feed")
            self.assertEqual(item["body"].count("### 首次安装"), 1)

    def test_draft_is_not_modified(self):
        with patch.object(installers, "api", return_value={"draft": True}), patch.object(installers, "gh") as gh:
            with self.assertRaisesRegex(ValueError, "正式版本"):
                installers.publish(Path("."), "0.1.5", True)
            gh.assert_not_called()


if __name__ == "__main__":
    unittest.main()
