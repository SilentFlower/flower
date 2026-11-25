"""向已发布的版本附加通过原生验收的首装包，保留更新频道与原制品。"""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

REPO = "SilentFlower/flower"
SUMS = "INSTALLER-SHA256SUMS.txt"


def gh(*arguments):
    """执行 GitHub CLI 并返回标准输出，非零退出时中止发布。"""
    return subprocess.check_output(["gh", *map(str, arguments)], text=True)


def api(path, *args):
    """读取或更新当前公开仓库的 GitHub REST 资源。"""
    return json.loads(gh("api", f"repos/{REPO}/{path}", *args))


def sha(path):
    """以流方式计算安装文件的 SHA-256。"""
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def release_assets(release_id):
    """按文件名索引版本页上的所有附件。"""
    pages = api(f"releases/{release_id}/assets?per_page=100", "--paginate", "--slurp")
    return {item["name"]: item for page in pages for item in page}


def upload(tag, release_id, path, existing):
    """清理中断的上传占位符，复用完整附件或上传并核对本地字节。"""
    if existing and existing["state"] == "starter" and not existing["size"]:
        gh("api", f"repos/{REPO}/releases/assets/{existing['id']}", "-X", "DELETE")
        existing = None
    if not existing:
        gh("release", "upload", tag, path, "--repo", REPO)
        # 列表读取偶尔落后于刚完成的上传，先等附件可见再核对摘要。
        for delay in (0, 1, 2, 4, 8):
            if delay:
                time.sleep(delay)
            existing = release_assets(release_id).get(path.name)
            if existing and existing["state"] == "uploaded":
                break
        if not existing or existing.get("digest") != "sha256:" + sha(path) or existing["size"] != path.stat().st_size:
            raise ValueError(f"远端摘要与本次上传不符：{path.name}")
    if existing["state"] != "uploaded" or not existing["size"] or not re.fullmatch(r"sha256:[a-f0-9]{64}", existing.get("digest") or ""):
        raise ValueError(f"版本页附件不完整：{path.name}")
    return existing["digest"].removeprefix("sha256:")


def publish(directory, version, manual_mac):
    """上传选定平台的安装包，按版本页已有附件恢复中断的补发。"""
    if not re.fullmatch(r"(?:0|[1-9][0-9]{0,7})(?:\.(?:0|[1-9][0-9]{0,7})){2}", version):
        raise ValueError("无效的桌面版本")
    tag = "flower-desktop-v" + version
    item = api("releases/tags/" + tag)
    if item["draft"] or item["prerelease"] or item["tag_name"] != tag:
        raise ValueError("仅支持已公开的正式版本")
    known = release_assets(item["id"])
    prefix = f"Flower-Desktop-{version}-"
    names = [prefix + "win32-x64-setup.exe"]
    if manual_mac:
        names.extend(prefix + f"darwin-{arch}-manual.dmg" for arch in ("arm64", "x64"))
    if {p.name for p in directory.iterdir()} != set(names):
        raise ValueError("验收通过的文件与平台范围不一致")
    if known.get(SUMS, {}).get("state") == "uploaded" and not set(names).issubset(known):
        raise ValueError("已有安装包校验清单，补发范围与已发布版本不一致")
    checks = {}
    for name in names:
        path = directory / name
        if path.stat().st_size == 0:
            raise ValueError(f"安装包为空：{name}")
        # 重建 DMG 和安装 EXE 的字节可能变化。已公开的版本化附件是重试时的依据。
        checks[name] = upload(tag, item["id"], path, known.get(name))
    with tempfile.TemporaryDirectory() as temp:
        sums = Path(temp) / SUMS
        sums.write_text("".join(f"{checks[n]}  {n}\n" for n in sorted(names)))
        if upload(tag, item["id"], sums, known.get(SUMS)) != sha(sums):
            raise ValueError("安装包校验清单不一致")
    heading = "### 首次安装"
    base = f"https://github.com/{REPO}/releases/download/{tag}/"
    section = [heading, "", f"- Windows x64：[下载安装程序]({base}{names[0]})，安装后从开始菜单打开 Flower Desktop。"]
    if manual_mac:
        section += [f"- macOS：[Apple Silicon]({base}{names[1]}) 或 [Intel]({base}{names[2]})。打开 DMG，把应用拖入“应用程序”。",
                    "- Mac 版采用临时签名，未经 Apple 公证。首次打开时系统可能提示无法验证开发者。确认来源后可查阅 [Apple 打开说明](https://support.apple.com/zh-cn/102445)。后续更新请下载新版 DMG 并替换应用。"]
    section.append(f"- 三种安装包的校验值见 [{SUMS}]({base}{SUMS})。" if manual_mac else f"- 安装程序的校验值见 [{SUMS}]({base}{SUMS})。")
    body = item.get("body") or ""
    block = "\n".join(section)
    if block not in body:
        api("releases/" + str(item["id"]), "-X", "PATCH", "-f", "body=" + block + "\n\n" + body)
    print(f"已核对 {len(names)} 个安装包，并更新 {tag} 的安装说明。")


if __name__ == "__main__":
    folder, number, mac = sys.argv[1:]
    if mac not in ("true", "false"):
        raise ValueError("未知的 Mac 发行方式")
    publish(Path(folder), number, mac == "true")
