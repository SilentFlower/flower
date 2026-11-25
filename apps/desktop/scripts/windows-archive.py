"""打包指定的 Windows 发行目录，保留中文文件名和隐藏的启动器标记。"""
from pathlib import Path
import sys
from zipfile import ZIP_DEFLATED, ZipFile

root, target = map(Path, sys.argv[1:])
with ZipFile(target, "x", compression=ZIP_DEFLATED, compresslevel=3) as archive:
    for file in sorted(root.rglob("*")):
        if file.is_file():
            archive.write(file, file.relative_to(root).as_posix())
