#!/usr/bin/env python3
"""Emit a canonical content manifest for a source tree.

Directories and a top-level .git directory are omitted. Regular files and
symbolic links are ordered by raw UTF-8 path bytes. Each JSON line records the
Git-compatible mode, type, byte size, and SHA-256 of the file bytes or symlink
target bytes. Refuse sockets, devices, FIFOs, non-UTF-8 paths, and paths with
newlines so one manifest has one unambiguous interpretation.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import sys
from pathlib import Path


class ManifestError(Exception):
    pass


def fail(message: str) -> None:
    print(f"source-tree-manifest.py: {message}", file=sys.stderr)
    raise SystemExit(1)


def digest_file(path: Path) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            size += len(chunk)
            digest.update(chunk)
    return size, digest.hexdigest()


def entries(root: Path) -> list[dict[str, object]]:
    if not root.is_dir():
        raise ManifestError(f"not a directory: {root}")

    result: list[dict[str, object]] = []
    for directory, names, files in os.walk(root, topdown=True, followlinks=False):
        relative_directory = Path(directory).relative_to(root)
        if relative_directory == Path("."):
            names[:] = [name for name in names if name != ".git"]

        # os.walk places symlinked directories in names. Record them as links
        # and remove them from traversal.
        for name in list(names):
            item = Path(directory, name)
            if item.is_symlink():
                files.append(name)
                names.remove(name)

        for name in files:
            item = Path(directory, name)
            relative = item.relative_to(root).as_posix()
            if "\n" in relative or "\r" in relative:
                raise ManifestError(f"path contains a newline: {relative!r}")
            try:
                relative.encode("utf-8", "strict")
            except UnicodeEncodeError as error:
                raise ManifestError(f"path is not UTF-8: {relative!r}") from error

            metadata = item.lstat()
            if stat.S_ISLNK(metadata.st_mode):
                payload = os.readlink(item).encode("utf-8", "surrogateescape")
                kind = "symlink"
                mode = "120000"
                size = len(payload)
                digest = hashlib.sha256(payload).hexdigest()
            elif stat.S_ISREG(metadata.st_mode):
                kind = "file"
                mode = "100755" if metadata.st_mode & 0o111 else "100644"
                size, digest = digest_file(item)
            else:
                raise ManifestError(f"unsupported filesystem object: {relative}")

            result.append(
                {
                    "path": relative,
                    "type": kind,
                    "mode": mode,
                    "size": size,
                    "sha256": digest,
                }
            )

    result.sort(key=lambda entry: str(entry["path"]).encode("utf-8"))
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    try:
        rows = entries(args.root.resolve())
    except (ManifestError, OSError) as error:
        fail(str(error))

    output = args.output.open("w", encoding="utf-8", newline="\n") if args.output else sys.stdout
    try:
        for row in rows:
            output.write(json.dumps(row, ensure_ascii=True, separators=(",", ":")) + "\n")
    finally:
        if args.output:
            output.close()


if __name__ == "__main__":
    main()
