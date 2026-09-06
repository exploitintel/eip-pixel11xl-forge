#!/usr/bin/env python3
"""Verify the exact flat Phase C kernel-candidate artifact inventory."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path


ROW = re.compile(r"^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._+-]*)$")
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
PRIVATE = re.compile(
    rb"(?:EIP_HOSTCTL_RUNTIME_ONLY|/Users/[^/\x00\r\n]+/|pixel11-docker/\.private|"
    rb"eip-cve-public|boot_docker4\.img|forge-control-debug|AKIA[0-9A-Z]{16}|"
    rb"gh[pousr]_[A-Za-z0-9]{30,}|(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,})"
)


def fail(message: str) -> None:
    print(f"check-candidate.py: {message}", file=sys.stderr)
    raise SystemExit(1)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def identity(path: Path) -> dict[str, int | str]:
    return {"size": path.stat().st_size, "sha256": sha256(path)}


def require_identity(path: Path, expected: object, label: str) -> None:
    if not isinstance(expected, dict) or identity(path) != {
        "size": expected.get("size"),
        "sha256": expected.get("sha256"),
    }:
        fail(f"{label} identity disagrees with the supported-build record")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    parser.add_argument("--build-id", required=True)
    args = parser.parse_args()

    root = Path(__file__).resolve().parent.parent
    document = json.loads((root / "kernel" / "builds.json").read_text(encoding="utf-8"))
    matches = [item for item in document["builds"] if item["buildId"] == args.build_id]
    if len(matches) != 1:
        fail("unknown or duplicate build ID")
    record = matches[0]
    directory = args.directory.resolve()
    if not directory.is_dir():
        fail("candidate directory does not exist")

    patch_names = [f"patch-{args.build_id}-{Path(item['path']).name}" for item in record["patches"]]
    expected = {
        f"Image-{args.build_id}.lz4",
        f"build-record-{args.build_id}.json",
        f"config-{args.build_id}",
        record["source"]["normalizedArchive"]["name"],
        f"patched-source-tree-{args.build_id}.jsonl",
        f"source-tree-{args.build_id}.jsonl",
        f"toolchain-{args.build_id}.txt",
        f"version-{args.build_id}.txt",
        f"vmlinux-notes-{args.build_id}.txt",
        *patch_names,
    }
    actual_payloads: set[str] = set()
    for item in directory.iterdir():
        if item.name == "SHA256SUMS":
            continue
        if not item.is_file() or item.is_symlink():
            fail(f"candidate contains a non-regular entry: {item.name}")
        if "/" in item.name or item.name.startswith("."):
            fail(f"unsafe candidate asset name: {item.name}")
        actual_payloads.add(item.name)
    if actual_payloads != expected:
        fail(f"candidate inventory mismatch: missing={sorted(expected - actual_payloads)}, extra={sorted(actual_payloads - expected)}")

    manifest_path = directory / "SHA256SUMS"
    if not manifest_path.is_file() or manifest_path.is_symlink():
        fail("candidate lacks regular SHA256SUMS")
    raw = manifest_path.read_bytes()
    if not raw.endswith(b"\n") or b"\r" in raw:
        fail("SHA256SUMS must be LF terminated")
    rows = raw.decode("ascii").splitlines()
    names: list[str] = []
    for row in rows:
        match = ROW.fullmatch(row)
        if not match:
            fail(f"non-canonical SHA256SUMS row: {row!r}")
        expected_hash, name = match.groups()
        names.append(name)
        path = directory / name
        if not path.is_file() or path.is_symlink():
            fail(f"manifest names a missing or non-regular asset: {name}")
        actual_hash = sha256(path)
        if actual_hash != expected_hash:
            fail(f"asset sha256 mismatch: {name}")
    if names != sorted(names) or len(names) != len(set(names)) or set(names) != expected:
        fail("SHA256SUMS names must be sorted, unique, and exactly equal to the payload inventory")

    source_archive = directory / record["source"]["normalizedArchive"]["name"]
    require_identity(source_archive, record["source"]["normalizedArchive"], "source archive")
    require_identity(
        directory / f"source-tree-{args.build_id}.jsonl",
        record["source"]["sourceManifest"],
        "source manifest",
    )
    require_identity(
        directory / f"patched-source-tree-{args.build_id}.jsonl",
        record["source"]["patchedManifest"],
        "patched source manifest",
    )
    config = directory / f"config-{args.build_id}"
    if sha256(config) != record["configs"]["mergedSha256"]:
        fail("merged config identity disagrees with the supported-build record")
    for item in record["patches"]:
        candidate_patch = directory / f"patch-{args.build_id}-{Path(item['path']).name}"
        if sha256(candidate_patch) != item["sha256"]:
            fail(f"patch identity disagrees with the supported-build record: {candidate_patch.name}")

    build_record_path = directory / f"build-record-{args.build_id}.json"
    try:
        build_record = json.loads(build_record_path.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"invalid build record: {error}")
    expected_record_keys = {
        "schemaVersion", "buildId", "device", "kernel", "source", "configs",
        "upstreamLicenses", "patches", "reproducibilityKey", "builder", "kbuild",
        "outputs",
    }
    if not isinstance(build_record, dict) or set(build_record) != expected_record_keys:
        fail("build record has an unexpected schema")
    if build_record["schemaVersion"] != 1 or build_record["buildId"] != args.build_id:
        fail("build record schema version or build ID mismatch")
    for field in (
        "device", "kernel", "source", "upstreamLicenses", "configs", "patches",
        "reproducibilityKey", "kbuild",
    ):
        if build_record[field] != record[field]:
            fail(f"build record {field} disagrees with the supported-build record")

    expected_builder = record["builder"]
    actual_builder = build_record["builder"]
    if not isinstance(actual_builder, dict) or set(actual_builder) != set(expected_builder):
        fail("build record builder has an unexpected schema")
    for field, expected_value in expected_builder.items():
        actual_value = actual_builder[field]
        if field in {"ociManifestDigest", "configDigest"}:
            if not isinstance(actual_value, str) or not DIGEST.fullmatch(actual_value):
                fail(f"build record builder {field} is not a sha256 digest")
            if expected_value is not None and actual_value != expected_value:
                fail(f"build record builder {field} disagrees with the supported-build record")
        elif actual_value != expected_value:
            fail(f"build record builder {field} disagrees with the supported-build record")

    image = directory / f"Image-{args.build_id}.lz4"
    outputs = build_record["outputs"]
    if not isinstance(outputs, dict) or set(outputs) != {"Image", "Image.lz4"}:
        fail("build record outputs have an unexpected schema")
    raw_image = outputs["Image"]
    if (
        not isinstance(raw_image, dict)
        or set(raw_image) != {"size", "sha256"}
        or not isinstance(raw_image.get("size"), int)
        or isinstance(raw_image.get("size"), bool)
        or raw_image["size"] <= 0
        or not isinstance(raw_image.get("sha256"), str)
        or not re.fullmatch(r"[0-9a-f]{64}", raw_image["sha256"])
    ):
        fail("build record raw Image identity is invalid")
    if outputs["Image.lz4"] != identity(image):
        fail("build record and Image.lz4 identity disagree")
    baseline = record["candidateImage"]
    if baseline.get("size") is not None and identity(image) != {
        "size": baseline["size"],
        "sha256": baseline["sha256"],
    }:
        fail("Image.lz4 identity disagrees with the supported-build baseline")

    # The normalized upstream source archive is authenticated by its exact
    # archive/tree/manifest record and may legitimately contain upstream test
    # fixtures. Scan every other candidate payload for local/private patterns.
    source_name = record["source"]["normalizedArchive"]["name"]
    for name in sorted(expected - {source_name, f"Image-{args.build_id}.lz4"}):
        if PRIVATE.search((directory / name).read_bytes()):
            fail(f"private identifier or secret pattern in candidate asset: {name}")

    print(f"candidate inventory passed for {args.build_id}")


if __name__ == "__main__":
    main()
