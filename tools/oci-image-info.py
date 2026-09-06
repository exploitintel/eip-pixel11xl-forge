#!/usr/bin/env python3
"""Verify and print the single image identity in an OCI archive."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import tarfile
from pathlib import PurePosixPath


DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
SAFE_REF = re.compile(r"^eip-pixel11xl-forge-buildenv:([a-z0-9][a-z0-9_.-]*)$")
SAFE_CONTAINERD_REF = re.compile(
    r"^(?:docker\.io/library/)?eip-pixel11xl-forge-buildenv:([a-z0-9][a-z0-9_.-]*)$"
)
ALLOWED_INDEX_ANNOTATIONS = {
    "io.containerd.image.name",
    "org.opencontainers.image.created",
    "org.opencontainers.image.ref.name",
}


def fail(message: str) -> None:
    print(f"oci-image-info.py: {message}", file=sys.stderr)
    raise SystemExit(1)


def blob_name(digest: object) -> str:
    if not isinstance(digest, str) or not DIGEST.fullmatch(digest):
        fail(f"invalid digest: {digest}")
    return "blobs/sha256/" + digest.removeprefix("sha256:")


def verify_blob(archive: tarfile.TarFile, digest: object, expected_size: object) -> None:
    name = blob_name(digest)
    member = archive.getmember(name)
    if not member.isfile():
        fail(f"OCI blob is not a regular file: {name}")
    if not isinstance(expected_size, int) or expected_size < 0 or member.size != expected_size:
        fail(f"OCI blob size mismatch: {name}")
    handle = archive.extractfile(member)
    if handle is None:
        fail(f"cannot read OCI blob: {name}")
    checksum = hashlib.sha256()
    while chunk := handle.read(1024 * 1024):
        checksum.update(chunk)
    actual = "sha256:" + checksum.hexdigest()
    if actual != digest:
        fail(f"OCI blob digest mismatch: got {actual}, expected {digest}")


def json_blob(archive: tarfile.TarFile, descriptor: dict[str, object]) -> dict[str, object]:
    digest = descriptor.get("digest", "")
    size = descriptor.get("size")
    verify_blob(archive, digest, size)
    handle = archive.extractfile(blob_name(digest))
    if handle is None:
        fail(f"cannot read OCI JSON blob: {digest}")
    payload = json.load(handle)
    if not isinstance(payload, dict):
        fail(f"OCI JSON blob is not an object: {digest}")
    return payload


def index_ref_name(descriptor: dict[str, object]) -> str | None:
    annotations = descriptor.get("annotations", {})
    if not isinstance(annotations, dict):
        fail("OCI manifest descriptor annotations are not an object")
    unknown = set(annotations) - ALLOWED_INDEX_ANNOTATIONS
    if unknown:
        fail(f"unsupported OCI index annotation(s): {', '.join(sorted(unknown))}")
    short_value = annotations.get("org.opencontainers.image.ref.name")
    full_value = annotations.get("io.containerd.image.name")
    if short_value is not None and not isinstance(short_value, str):
        fail("OCI image ref name is not a string")
    if full_value is not None and not isinstance(full_value, str):
        fail("containerd image name is not a string")
    if short_value is None and full_value is None:
        return None
    if short_value is None or full_value is None:
        fail("OCI load ref annotations must be present as a pair")
    full_match = SAFE_CONTAINERD_REF.fullmatch(full_value)
    if full_match is None or short_value != full_match.group(1):
        fail("OCI load ref annotations are unsafe or disagree")
    return f"eip-pixel11xl-forge-buildenv:{short_value}"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("archive")
    parser.add_argument("--expect-manifest")
    parser.add_argument("--expect-config")
    parser.add_argument("--expect-platform", default="linux/arm64")
    parser.add_argument("--require-safe-ref", action="store_true")
    args = parser.parse_args()

    try:
        with tarfile.open(args.archive, "r") as archive:
            members = archive.getmembers()
            names: set[str] = set()
            for member in members:
                path = PurePosixPath(member.name)
                if path.is_absolute() or ".." in path.parts:
                    fail(f"unsafe OCI member path: {member.name}")
                if member.name in names:
                    fail(f"duplicate OCI member path: {member.name}")
                names.add(member.name)
                if not (member.isfile() or member.isdir()):
                    fail(f"unsupported OCI member type: {member.name}")
            index_file = archive.extractfile("index.json")
            if index_file is None:
                fail("OCI archive lacks index.json")
            index = json.load(index_file)
            if not isinstance(index, dict) or index.get("schemaVersion") != 2 \
                    or index.get("mediaType") != "application/vnd.oci.image.index.v1+json":
                fail("invalid OCI image index identity")
            layout_file = archive.extractfile("oci-layout")
            if layout_file is None or json.load(layout_file) != {"imageLayoutVersion": "1.0.0"}:
                fail("invalid OCI layout marker")
            manifests = index.get("manifests", [])
            if not isinstance(manifests, list) or len(manifests) != 1:
                count = len(manifests) if isinstance(manifests, list) else "non-array"
                fail(f"expected one OCI image manifest, got {count}")
            descriptor = manifests[0]
            if not isinstance(descriptor, dict) or descriptor.get("mediaType") != "application/vnd.oci.image.manifest.v1+json":
                fail("invalid OCI manifest descriptor")
            ref_name = index_ref_name(descriptor)
            if args.require_safe_ref and (ref_name is None or not SAFE_REF.fullmatch(ref_name)):
                fail(f"unsafe or missing OCI image ref name: {ref_name or 'none'}")
            platform = descriptor.get("platform", {})
            if not isinstance(platform, dict):
                fail("OCI manifest platform is not an object")
            actual_platform = f"{platform.get('os')}/{platform.get('architecture')}"
            if actual_platform != args.expect_platform:
                fail(f"platform mismatch: got {actual_platform}, expected {args.expect_platform}")
            manifest_digest = descriptor.get("digest", "")
            manifest = json_blob(archive, descriptor)
            if manifest.get("schemaVersion") != 2 or manifest.get("mediaType") != "application/vnd.oci.image.manifest.v1+json":
                fail("invalid OCI image manifest")
            config_descriptor = manifest.get("config", {})
            if not isinstance(config_descriptor, dict) or config_descriptor.get("mediaType") != "application/vnd.oci.image.config.v1+json":
                fail("invalid OCI config descriptor")
            config_digest = config_descriptor.get("digest", "")
            config = json_blob(archive, config_descriptor)
            config_platform = f"{config.get('os')}/{config.get('architecture')}"
            if config_platform != actual_platform:
                fail(f"config platform mismatch: got {config_platform}, expected {actual_platform}")
            referenced = {"index.json", "oci-layout", blob_name(manifest_digest), blob_name(config_digest)}
            layers = manifest.get("layers", [])
            if not isinstance(layers, list):
                fail("OCI manifest layers are not an array")
            for layer in layers:
                if not isinstance(layer, dict) or layer.get("mediaType") not in {
                    "application/vnd.oci.image.layer.v1.tar+gzip",
                    "application/vnd.oci.image.layer.v1.tar+zstd",
                }:
                    fail("invalid OCI layer descriptor")
                layer_digest = layer.get("digest", "")
                verify_blob(archive, layer_digest, layer.get("size"))
                referenced.add(blob_name(layer_digest))
            actual_files = {member.name for member in members if member.isfile()}
            actual_dirs = {member.name.rstrip("/") for member in members if member.isdir()}
            if actual_files != referenced:
                extra = sorted(actual_files - referenced)
                missing = sorted(referenced - actual_files)
                fail(f"OCI archive inventory mismatch: extra={extra}, missing={missing}")
            if actual_dirs != {"blobs", "blobs/sha256"}:
                fail(f"OCI archive directory inventory mismatch: {sorted(actual_dirs)}")
    except (KeyError, OSError, tarfile.TarError, json.JSONDecodeError) as error:
        fail(str(error))

    if args.expect_manifest and manifest_digest != args.expect_manifest:
        fail(f"manifest mismatch: got {manifest_digest}, expected {args.expect_manifest}")
    if args.expect_config and config_digest != args.expect_config:
        fail(f"config mismatch: got {config_digest}, expected {args.expect_config}")

    print(json.dumps({
        "manifest_digest": manifest_digest,
        "config_digest": config_digest,
        "platform": actual_platform,
        "created": config.get("created"),
        "ref_name": ref_name,
    }, sort_keys=True))


if __name__ == "__main__":
    main()
