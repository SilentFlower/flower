"""在隔离 Windows 测试桌面操作真实安装向导，保存中文页面并验证目录输入。"""
import argparse
import ctypes as C
from ctypes import wintypes as W
from pathlib import Path
import struct
import subprocess
import time
import zlib

user = C.WinDLL("user32", use_last_error=True)
gdi = C.WinDLL("gdi32", use_last_error=True)
callback = C.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM)


def native(dll, name, result, *parameters):
    """绑定指定 Windows 函数的参数和返回类型，保留 64 位窗口句柄。"""
    func = getattr(dll, name)
    func.argtypes = parameters
    func.restype = result
    return func


enum = native(user, "EnumWindows", W.BOOL, callback, W.LPARAM)
children = native(user, "EnumChildWindows", W.BOOL, W.HWND, callback, W.LPARAM)
visible = native(user, "IsWindowVisible", W.BOOL, W.HWND)
enabled = native(user, "IsWindowEnabled", W.BOOL, W.HWND)
class_name = native(user, "GetClassNameW", C.c_int, W.HWND, W.LPWSTR, C.c_int)
send = native(user, "SendMessageW", C.c_ssize_t, W.HWND, W.UINT, W.WPARAM, W.LPARAM)
post = native(user, "PostMessageW", W.BOOL, W.HWND, W.UINT, W.WPARAM, W.LPARAM)
get_rect = native(user, "GetWindowRect", W.BOOL, W.HWND, C.POINTER(W.RECT))
native(user, "SetProcessDPIAware", W.BOOL)()


def controls(parent=None):
    """列出当前桌面或向导里可见控件的句柄、类名与标题。"""
    rows = []

    @callback
    def collect(hwnd, _):
        if visible(hwnd):
            kind = C.create_unicode_buffer(96)
            class_name(hwnd, kind, len(kind))
            label = C.create_unicode_buffer(512)
            send(hwnd, 0x000D, len(label), C.addressof(label))
            rows.append((hwnd, kind.value, label.value))
        return True

    if parent:
        children(parent, collect, 0)
    else:
        enum(collect, 0)
    return rows


def wait(find, description, timeout=60):
    """等待界面状态出现，超时报告对应的验收步骤。"""
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        result = find()
        if result:
            return result
        time.sleep(0.15)
    raise RuntimeError(description)


def screenshot(hwnd, path):
    """用 PrintWindow 仅绘制目标窗口，编码成无外部依赖的 PNG 文件。"""
    time.sleep(0.22)
    bounds = W.RECT()
    assert get_rect(hwnd, C.byref(bounds))
    width, height = bounds.right - bounds.left, bounds.bottom - bounds.top
    dc = native(user, "GetWindowDC", W.HDC, W.HWND)(hwnd)
    mem = native(gdi, "CreateCompatibleDC", W.HDC, W.HDC)(dc)
    bmp = native(gdi, "CreateCompatibleBitmap", W.HANDLE, W.HDC, C.c_int, C.c_int)(dc, width, height)
    select = native(gdi, "SelectObject", W.HANDLE, W.HDC, W.HANDLE)
    old = select(mem, bmp)
    data = C.create_string_buffer(width * height * 4)
    header = C.create_string_buffer(struct.pack("<IiiHHIIiiII", 40, width, -height, 1, 32, 0, len(data), 0, 0, 0, 0))
    try:
        assert native(user, "PrintWindow", W.BOOL, W.HWND, W.HDC, W.UINT)(hwnd, mem, 2)
        select(mem, old)
        assert native(gdi, "GetDIBits", C.c_int, W.HDC, W.HANDLE, W.UINT, W.UINT, C.c_void_p, C.c_void_p, W.UINT)(
            mem, bmp, 0, height, data, header, 0) == height
    finally:
        native(gdi, "DeleteObject", W.BOOL, W.HANDLE)(bmp)
        native(gdi, "DeleteDC", W.BOOL, W.HDC)(mem)
        native(user, "ReleaseDC", C.c_int, W.HWND, W.HDC)(hwnd, dc)
    raw = data.raw
    rgb = bytearray(width * height * 3)
    rgb[0::3], rgb[1::3], rgb[2::3] = raw[2::4], raw[1::4], raw[0::4]
    scanlines = b"".join(b"\0" + rgb[y*width*3:(y+1)*width*3] for y in range(height))

    def chunk(kind, payload):
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload))
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(scanlines)) + chunk(b"IEND", b""))


def check(setup, output, directory, install):
    """读取并操作中文向导；完整模式在提供的全新目录安装，预览模式只走到快捷方式页。"""
    # Inno 把 ICO 中的各尺寸图像嵌入 EXE 的 RT_ICON 资源。核对真实品牌字节。
    icon_path = Path(__file__).resolve().parents[1] / "installer/artwork/flower.ico"
    if install:
        icon = icon_path.read_bytes()
        with setup.open("rb") as binary:
            resources = binary.read(8 * 1024 * 1024)
        for index in range(struct.unpack_from("<H", icon, 4)[0]):
            length, offset = struct.unpack_from("<II", icon, 6 + 16 * index + 8)
            assert icon[offset:offset + length] in resources, "安装 EXE 缺少品牌图像资源"
    output.mkdir(parents=True, exist_ok=True)
    proc = subprocess.Popen([str(setup), "/LANG=chinesesimplified", "/NORESTART", "/SP-"])
    try:
        hwnd = wait(lambda: next((h for h, k, t in controls() if k == "TWizardForm" and "Flower" in t), None), "未找到安装窗口")
        def button(title):
            return next((h for h, k, t in controls(hwnd) if "Button" in k and enabled(h) and title in t.replace("&", "")), None)
        def click(title):
            target = wait(lambda: button(title), "缺少按钮 " + title, 15)
            assert post(target, 0x00F5, 0, 0)

        wait(lambda: button("继续"), "欢迎页未就绪")
        screenshot(hwnd, output / "01-welcome.png")
        click("继续")
        edit = wait(lambda: next((h for h, k, _ in controls(hwnd) if k == "TNewPathEdit"), None), "未出现安装位置输入框")
        assert button("浏览")
        value = C.create_unicode_buffer(str(directory))
        assert send(edit, 0x000C, 0, C.addressof(value))
        screenshot(hwnd, output / "02-folder.png")
        click("继续")
        wait(lambda: button("安装"), "未出现快捷方式选项及安装按钮")
        screenshot(hwnd, output / "03-shortcuts.png")
        if install:
            click("安装")
            wait(lambda: any("ProgressBar" in k for _, k, _ in controls(hwnd)), "未出现安装进度")
            screenshot(hwnd, output / "04-installing.png")
            wait(lambda: button("完成"), "未出现完成页", 240)
            screenshot(hwnd, output / "05-finished.png")
            assert (directory / "Flower Desktop.exe").is_file()
            # 关闭完成页的启动选项，验收时保持当前桌面安静。
            run_list = next(h for h, k, _ in controls(hwnd) if k == "TNewCheckListBox")
            point = (8 << 16) | 8
            send(run_list, 0x0201, 1, point)
            send(run_list, 0x0202, 0, point)
            click("完成")
            assert proc.wait(timeout=30) == 0
    finally:
        if proc.poll() is None:
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("setup", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--install", action="store_true")
    args = parser.parse_args()
    check(args.setup, args.output, args.directory, args.install)
