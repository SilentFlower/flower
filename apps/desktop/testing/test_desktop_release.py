"""校验双平台发行契约及稳定频道变更失败后的恢复。"""
import hashlib
import importlib.util
import json
import plistlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from zipfile import ZipFile

spec = importlib.util.spec_from_file_location("desktop_release", Path(__file__).resolve().parents[1] / "scripts/publish-desktop.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    """用小型真实 ZIP 与模拟的 Release 资产验证发布顺序和恢复边界。"""

    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.version = "1.10.3"
        self.prefix = "Flower-Desktop-1.10.3-"
        self.win = self.prefix + "win32-x64.zip"
        marker = {"product": "Flower Desktop", "version": self.version, "platform": "win32-x64", "channel": "stable"}
        payload = {"Flower Desktop.exe": b"app", "resources/app.asar": b"workbench",
                   "flower-desktop-build.json": json.dumps(marker).encode()}
        with ZipFile(self.root / self.win, "w") as output:
            for name, data in payload.items():
                output.writestr(name, data)
        with ZipFile(self.root / (self.prefix + "win32-x64-portable.zip"), "w") as output:
            output.writestr("current.txt", self.version)
            output.writestr("Flower Desktop.exe", b"launcher")
            output.writestr(".flower-desktop-managed", "flower-desktop-portable-1")
            for name, data in payload.items():
                output.writestr(f"versions/{self.version}/{name}", data)
        data = (self.root / self.win).read_bytes()
        self.winfeed = {**marker, "size": len(data), "sha256": hashlib.sha256(data).hexdigest(), "download": self.win}
        (self.root / release.FEED).write_text(json.dumps(self.winfeed))
        for arch in ("x64", "arm64"):
            base = self.prefix + "darwin-" + arch
            (self.root / (base + ".dmg")).write_bytes(b"disk")
            with ZipFile(self.root / (base + ".zip"), "w") as output:
                output.writestr("Flower Desktop.app/Contents/Info.plist", plistlib.dumps(
                    {"CFBundleShortVersionString": self.version, "CFBundleIdentifier": "com.silentflower.flower-desktop"}))
            feed = {"currentRelease": self.version, "releases": [{"version": self.version, "updateTo": {"version": self.version,
                    "url": f"https://github.com/{release.REPO}/releases/download/{release.STABLE}/{base}.zip"}}]}
            (self.root / f"flower-desktop-mac-{arch}.json").write_text(json.dumps(feed))

    def test_validate_complete_cohort(self):
        binaries, updates, manifests = release.validate(self.root, self.version, stable=True)
        self.assertEqual((len(binaries), len(updates), len(manifests)), (6, 3, 3))

    def test_reject_corrupt_payload_and_wrong_arch(self):
        self.winfeed["sha256"] = "0" * 64
        (self.root / release.FEED).write_text(json.dumps(self.winfeed))
        with self.assertRaisesRegex(ValueError, "摘要"):
            release.validate(self.root, self.version)
        self.winfeed["sha256"] = release.digest(self.root / self.win)
        (self.root / release.FEED).write_text(json.dumps(self.winfeed))
        feed = self.root / "flower-desktop-mac-arm64.json"
        feed.write_text(feed.read_text().replace("darwin-arm64.zip", "darwin-x64.zip"))
        with self.assertRaisesRegex(ValueError, "架构|下载地址"):
            release.validate(self.root, self.version)

    def test_preview_cannot_be_published(self):
        with ZipFile(self.root / (self.prefix + "darwin-arm64.zip"), "w") as output:
            output.writestr("Flower Desktop.app/Contents/Info.plist", plistlib.dumps(
                {"CFBundleShortVersionString": self.version, "CFBundleIdentifier": "com.silentflower.flower-desktop.preview"}))
        release.validate(self.root, self.version)
        with self.assertRaisesRegex(ValueError, "应用身份"):
            release.validate(self.root, self.version, stable=True)

    def test_downgrade_blocked_before_upload_even_if_manifest_was_being_rotated(self):
        sha = "3" * 40
        prior = self.root / "previous"
        prior.write_text(json.dumps({"version": "1.11.0"}))
        with patch.object(release, "api", return_value={"sha": sha}), patch.object(release, "release", return_value={"id": 7}), \
                patch.object(release, "assets", return_value={release.FEED + ".previous": {"id": 11}}), \
                patch.object(release, "download", return_value=prior), patch.object(release, "gh") as gh:
            with self.assertRaisesRegex(ValueError, "拒绝降到"):
                release.publish(self.root, self.version, sha)
            gh.assert_not_called()

    def test_manifest_restored_on_failure_and_retry_can_promote(self):
        old = {"id": 10, "digest": "sha256:old"}
        new = {"id": 11, "digest": "sha256:new"}
        item = {"id": 7}
        staged = release.FEED + ".next-new"
        remote = {release.FEED: old, staged: new}

        def rename(asset, name):
            if asset == new and fail:
                raise RuntimeError("模拟网络错误")
            key = next(k for k, v in remote.items() if v == asset)
            self.assertNotIn(name, remote)
            remote[name] = remote.pop(key)

        def delete(path, *_args):
            del remote[next(k for k, v in remote.items() if path.endswith("/" + str(v['id'])))]

        with patch.object(release, "assets", side_effect=lambda _: dict(remote)), \
                patch.object(release, "rename_asset", side_effect=rename), patch.object(release, "api", side_effect=delete):
            fail = True
            with self.assertRaises(RuntimeError):
                release.advance_feed(item, release.FEED, new, "new")
            self.assertEqual(remote[release.FEED], old)
            fail = False
            release.advance_feed(item, release.FEED, new, "new")
            release.advance_feed(item, release.FEED, new, "new")
            self.assertEqual(remote, {release.FEED: new, release.FEED + ".previous": old})


if __name__ == "__main__":
    unittest.main()
