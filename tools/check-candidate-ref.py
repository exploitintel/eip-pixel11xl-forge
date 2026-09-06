#!/usr/bin/env python3
"""Allow candidate runs only from main or a strict three-part SemVer tag."""

from __future__ import annotations

import re
import sys


TAG = re.compile(
    r"^refs/tags/v(?:0|[1-9][0-9]*)\."
    r"(?:0|[1-9][0-9]*)\."
    r"(?:0|[1-9][0-9]*)$"
)


def main() -> None:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} REF", file=sys.stderr)
        raise SystemExit(2)
    ref = sys.argv[1]
    if ref != "refs/heads/main" and not TAG.fullmatch(ref):
        print(
            "candidate builds require refs/heads/main or a strict release tag",
            file=sys.stderr,
        )
        raise SystemExit(1)
    print(f"candidate source ref accepted: {ref}")


if __name__ == "__main__":
    main()
