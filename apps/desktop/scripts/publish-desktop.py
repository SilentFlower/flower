"""验证桌面发行制品，并用 GitHub CLI 发布版本和推进公开更新频道。"""
import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import re
import subprocess
import tempfile
from zipfile import ZipFile

REPO = "SilentFlower/flower"
STABLE = "flower-desktop-stable"
TAG_PREFIX = "flower-desktop-v"
FEED = "flower-desktop-update.json"
VERSION = r"(?:0|[1-9][0-9]{0,7})\.(?:0|[1-9][0-9]{0,7})\.(?:0|[1-9][0-9]{0,7})"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def semver(version):
    require(isinstance(version, str) and re.fullmatch(VERSION, version), f"无效的桌面版本 {version}")
    return tuple(map(int, version.split(".")))


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def validate(directory, version, stable=False):
    """核对每个平台的首装布局、更新版本与固定下载地址，返回版本化文件和频道清单。"""
    semver(version)
    prefix = f"Flower-Desktop-{version}-"
    winzip = prefix + "win32-x64.zip"
    portable = prefix + "win32-x64-portable.zip"
    win = json.loads((directory / FEED).read_bytes())
    require(win.get("product") == "Flower Desktop" and win.get("platform") == "win32-x64"
            and win.get("version") == version and win.get("channel") == "stable"
            and win.get("download") == winzip, "Windows 稳定清单与发行版本不一致")
    require(win.get("size") == (directory / winzip).stat().st_size and win.get("sha256") == digest(directory / winzip),
            "Windows 更新 ZIP 大小或摘要有误")
    with ZipFile(directory / portable) as first, ZipFile(directory / winzip) as update:
        require(first.read("current.txt").decode().strip() == version and
                first.read(".flower-desktop-managed").decode().strip() == "flower-desktop-portable-1" and
                "Flower Desktop.exe" in first.namelist(), "Windows 首装包缺少固定入口")
        marker = json.loads(update.read("flower-desktop-build.json"))
        require(marker == {"product": "Flower Desktop", "platform": "win32-x64", "version": version, "channel": "stable"},
                "更新 ZIP 的包内标记不符")
        nested = f"versions/{version}/"
        for name in ("Flower Desktop.exe", "flower-desktop-build.json", "resources/app.asar"):
            require(first.getinfo(nested + name).CRC == update.getinfo(name).CRC and
                    first.getinfo(nested + name).file_size == update.getinfo(name).file_size, "首装和更新包的载荷不匹配")
    binaries = [portable, winzip]
    updates = [winzip]
    feeds = [FEED]
    for arch in ("arm64", "x64"):
        base = prefix + "darwin-" + arch
        dmg, archive, feed = base + ".dmg", base + ".zip", f"flower-desktop-mac-{arch}.json"
        require((directory / dmg).stat().st_size > 0, f"{arch} 磁盘映像为空")
        mac = json.loads((directory / feed).read_bytes())
        require(mac.get("currentRelease") == version, f"{arch} 的更新清单版本不符")
        entries = [r["updateTo"] for r in mac["releases"] if r["version"] == version]
        url = f"https://github.com/{REPO}/releases/download/{STABLE}/{archive}"
        require(len(entries) == 1 and entries[0].get("version") == version and entries[0].get("url") == url,
                f"{arch} 的更新包与版本或稳定下载地址不一致")
        with ZipFile(directory / archive) as bundle:
            info = plistlib.loads(bundle.read("Flower Desktop.app/Contents/Info.plist"))
            app_id = "com.silentflower.flower-desktop"
            allowed_ids = {app_id} if stable else {app_id, app_id + ".preview"}
            require(info.get("CFBundleIdentifier") in allowed_ids, f"{arch} 应用身份和发布渠道不匹配")
            require(info.get("CFBundleShortVersionString") == version, f"{arch} 的 .app 版本不一致")
        binaries.extend([dmg, archive])
        updates.append(archive)
        feeds.append(feed)
    return binaries, updates, feeds


def gh(*args, missing_ok=False):
    result = subprocess.run(["gh", *map(str, args)], capture_output=True, text=True)
    if result.returncode:
        if missing_ok and "HTTP 404" in result.stderr:
            return None
        raise RuntimeError(result.stderr.strip() or "GitHub CLI 调用失败")
    return result.stdout


def api(path, *options, missing_ok=False):
    data = gh("api", f"repos/{REPO}/{path}", *options, missing_ok=missing_ok)
    return json.loads(data) if data else None


def release(tag):
    found = api("releases/tags/" + tag, missing_ok=True)
    if found:
        return found
    # 按标签的 API 可能忽略草稿；重跑时查找原草稿，避免创建重名发行。
    pages = api("releases?per_page=100", "--paginate", "--slurp")
    return next((r for page in pages for r in page if r["tag_name"] == tag), None)


def assets(item):
    pages = api(f"releases/{item['id']}/assets?per_page=100", "--paginate", "--slurp")
    return {asset["name"]: asset for page in pages for asset in page}


def upload(tag, path):
    gh("release", "upload", tag, path, "--repo", REPO)


def download(tag, name, directory):
    gh("release", "download", tag, "--repo", REPO, "--pattern", name, "--dir", directory, "--clobber")
    return directory / name


def ensure_asset(tag, item, known, path, sha):
    old = known.get(path.name)
    if old and old["state"] == "starter" and not old["size"]:
        # GitHub 在上传中断时可能留下一个空占位符。
        api(f"releases/assets/{old['id']}", "-X", "DELETE")
        old = None
    if not old:
        upload(tag, path)
        old = assets(item)[path.name]
    require(old.get("state") == "uploaded" and old.get("size") == path.stat().st_size
            and old.get("digest") == "sha256:" + sha, f"远端附件内容不符，请保留已发布版本：{path.name}")
    known[path.name] = old
    return old


def rename_asset(asset, name):
    api(f"releases/assets/{asset['id']}", "-X", "PATCH", "-f", f"name={name}")


def advance_feed(item, name, staged, sha):
    known = assets(item)
    current, backup = known.get(name), known.get(name + ".previous")
    if current and current.get("digest") == "sha256:" + sha:
        return
    # 先上传校验新清单，切换名称时留存上一份。重试可从两次命名之间继续。
    if current:
        if backup:
            api(f"releases/assets/{backup['id']}", "-X", "DELETE")
        rename_asset(current, name + ".previous")
        backup = current
    try:
        rename_asset(staged, name)
    except RuntimeError:
        if backup and name not in assets(item):
            rename_asset(backup, name)
        raise


def publish(directory, version, commit):
    """在全部平台制品就绪后发布源码标签对应 Release，再推进兼容旧客户端的稳定频道。"""
    binaries, updates, feeds = validate(directory, version, stable=True)
    tag = TAG_PREFIX + version
    require(re.fullmatch(r"[a-f0-9]{40}", commit) and api(f"commits/{tag}")["sha"] == commit,
            "远程版本标签与本次构建提交不一致")
    stable = release(STABLE)
    with tempfile.TemporaryDirectory(prefix="flower-release-") as tmp:
        scratch = Path(tmp)
        stable_assets = assets(stable) if stable else {}
        for name in feeds:
            for existing in (name, name + ".previous"):
                if existing not in stable_assets:
                    continue
                prior = json.loads(download(STABLE, existing, scratch).read_bytes())
                prior_version = prior["version" if name == FEED else "currentRelease"]
                require(semver(version) >= semver(prior_version), f"稳定频道已在 {prior_version}，拒绝降到 {version}")
        tagged = release(tag)
        if not tagged:
            gh("release", "create", tag, "--verify-tag", "--target", commit, "--draft", "--title", f"Flower Desktop {version}",
               "--notes", "Windows 首装请选择 portable.zip；macOS 请选择对应处理器的 DMG。已安装的工作台从稳定频道自动检查更新。", "--repo", REPO)
            tagged = release(tag)
        canonical = scratch / "version"
        canonical.mkdir()
        if tagged["draft"]:
            sums = {name: digest(directory / name) for name in binaries + feeds}
            (directory / "SHA256SUMS.txt").write_text("".join(f"{sha}  {name}\n" for name, sha in sorted(sums.items())))
            gh("release", "upload", tag, *(directory / name for name in [*binaries, *feeds, "SHA256SUMS.txt"]),
               "--clobber", "--repo", REPO)
            originals = assets(tagged)
            for name, sha in sums.items():
                require(originals[name].get("digest") == "sha256:" + sha, f"草稿附件摘要不符：{name}")
            gh("release", "edit", tag, "--draft=false", "--latest", "--repo", REPO)
            canonical = directory
        else:
            # 签名及公证会使重建包的字节不同。已公开的版本是后续渠道重试的唯一来源。
            gh("release", "download", tag, "--repo", REPO, "--dir", canonical)
            validate(canonical, version, stable=True)
            originals = assets(tagged)
            for name in binaries + feeds:
                require(originals[name].get("digest") == "sha256:" + digest(canonical / name), f"版本附件摘要不符：{name}")
        if not stable:
            gh("release", "create", STABLE, "--target", commit, "--draft", "--title", "Flower Desktop 稳定更新频道",
               "--notes", "此频道为已安装的 Flower Desktop 提供更新。首次安装请从对应版本的 Release 下载。", "--repo", REPO)
            stable = release(STABLE)
        known = assets(stable)
        for name in updates:
            ensure_asset(STABLE, stable, known, canonical / name, digest(canonical / name))
        staged = {}
        for name in feeds:
            sha = digest(canonical / name)
            if known.get(name, {}).get("digest") == "sha256:" + sha:
                continue
            path = scratch / f"{name}.next-{sha[:16]}"
            path.write_bytes((canonical / name).read_bytes())
            staged[name] = (ensure_asset(STABLE, stable, known, path, sha), sha)
        for name, (asset, sha) in staged.items():
            advance_feed(stable, name, asset, sha)
        if stable["draft"]:
            gh("release", "edit", STABLE, "--draft=false", "--latest=false", "--repo", REPO)
        final = assets(stable)
        for name in feeds + updates:
            require(final[name].get("digest") == "sha256:" + digest(canonical / name), f"稳定频道复核失败：{name}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("version")
    parser.add_argument("--publish-commit", help="将已验证制品发布到此标签提交")
    args = parser.parse_args()
    if args.publish_commit:
        publish(args.directory, args.version, args.publish_commit)
    else:
        validate(args.directory, args.version)
    print(f"Flower Desktop {args.version} 双平台发行制品已核对。")
