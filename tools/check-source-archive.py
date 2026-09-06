#!/usr/bin/env python3
"""Reject unsafe or ambiguous paths and object types in a source tarball."""

from __future__ import annotations

import argparse
import sys
import tarfile
from pathlib import PurePosixPath


def fail(message: str) -> None:
    print(f"check-source-archive.py: {message}", file=sys.stderr)
    raise SystemExit(1)


def normalize(parts: tuple[str, ...]) -> tuple[str, ...]:
    result: list[str] = []
    for part in parts:
        if part in ("", "."):
            continue
        if part == "..":
            if not result:
                raise ValueError("path escapes root")
            result.pop()
        else:
            result.append(part)
    return tuple(result)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("archive")
    args = parser.parse_args()

    seen: set[tuple[str, ...]] = set()
    files = 0
    try:
        with tarfile.open(args.archive, "r:*") as archive:
            for member in archive:
                path = PurePosixPath(member.name)
                if path.is_absolute() or "\n" in member.name or "\r" in member.name:
                    fail(f"unsafe source member: {member.name!r}")
                clean = normalize(path.parts)
                if clean in seen and clean:
                    fail(f"duplicate source member: {member.name!r}")
                seen.add(clean)
                if not (member.isfile() or member.isdir() or member.issym()):
                    fail(f"unsupported source member type: {member.name!r}")
                if member.isfile():
                    files += 1
                if member.issym():
                    target = PurePosixPath(member.linkname)
                    if target.is_absolute():
                        fail(f"absolute symlink target: {member.name!r}")
                    normalize((*clean[:-1], *target.parts))
    except (OSError, tarfile.TarError, ValueError) as error:
        fail(str(error))
    if files == 0:
        fail("source archive contains no regular files")
    print(f"validated {files} regular source files")


if __name__ == "__main__":
    main()
