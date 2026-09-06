#!/usr/bin/env python3
"""Validate supported-build records and every tracked file identity."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit


HEX40 = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
BUILD_ID = re.compile(r"^[A-Z0-9]+(?:\.[A-Z0-9]+)+$")


def fail(message: str) -> None:
    print(f"validate-builds.py: {message}", file=sys.stderr)
    raise SystemExit(1)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def schema_type_matches(value: object, expected: str) -> bool:
    return {
        "array": isinstance(value, list),
        "boolean": isinstance(value, bool),
        "integer": isinstance(value, int) and not isinstance(value, bool),
        "null": value is None,
        "object": isinstance(value, dict),
        "string": isinstance(value, str),
    }.get(expected, False)


def validate_schema(value: object, schema: dict[str, object], root: dict[str, object], path: str = "$") -> None:
    """Validate the deliberately small JSON Schema subset used by this repository."""
    reference = schema.get("$ref")
    if reference is not None:
        if not isinstance(reference, str) or not reference.startswith("#/"):
            fail(f"{path}: unsupported schema reference: {reference}")
        target: object = root
        for part in reference[2:].split("/"):
            if not isinstance(target, dict) or part not in target:
                fail(f"{path}: unresolved schema reference: {reference}")
            target = target[part]
        if not isinstance(target, dict):
            fail(f"{path}: schema reference is not an object: {reference}")
        validate_schema(value, target, root, path)
        return

    expected = schema.get("type")
    if expected is not None:
        types = expected if isinstance(expected, list) else [expected]
        if not all(isinstance(item, str) for item in types) or not any(
            schema_type_matches(value, item) for item in types
        ):
            fail(f"{path}: expected schema type {expected!r}")
    if "const" in schema and value != schema["const"]:
        fail(f"{path}: value does not match schema const")
    if "enum" in schema and value not in schema["enum"]:
        fail(f"{path}: value is not in schema enum")

    if isinstance(value, str):
        pattern = schema.get("pattern")
        if isinstance(pattern, str) and re.search(pattern, value) is None:
            fail(f"{path}: string does not match schema pattern")
        minimum_length = schema.get("minLength")
        if isinstance(minimum_length, int) and len(value) < minimum_length:
            fail(f"{path}: string is shorter than schema minimum")
    if isinstance(value, int) and not isinstance(value, bool):
        minimum = schema.get("minimum")
        if isinstance(minimum, int) and value < minimum:
            fail(f"{path}: integer is below schema minimum")
    if isinstance(value, list):
        minimum_items = schema.get("minItems")
        maximum_items = schema.get("maxItems")
        if isinstance(minimum_items, int) and len(value) < minimum_items:
            fail(f"{path}: array is shorter than schema minimum")
        if isinstance(maximum_items, int) and len(value) > maximum_items:
            fail(f"{path}: array is longer than schema maximum")
        if schema.get("uniqueItems") is True:
            canonical = [json.dumps(item, sort_keys=True, separators=(",", ":")) for item in value]
            if len(canonical) != len(set(canonical)):
                fail(f"{path}: array items must be unique")
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for index, item in enumerate(value):
                validate_schema(item, item_schema, root, f"{path}[{index}]")
    if isinstance(value, dict):
        required = schema.get("required", [])
        if isinstance(required, list):
            missing = [item for item in required if item not in value]
            if missing:
                fail(f"{path}: missing schema properties: {', '.join(missing)}")
        properties = schema.get("properties", {})
        if isinstance(properties, dict):
            if schema.get("additionalProperties") is False:
                extra = sorted(set(value) - set(properties))
                if extra:
                    fail(f"{path}: unexpected schema properties: {', '.join(extra)}")
            for name, item_schema in properties.items():
                if name in value and isinstance(item_schema, dict):
                    validate_schema(value[name], item_schema, root, f"{path}.{name}")


def https_url(value: object, label: str) -> str:
    if not isinstance(value, str):
        fail(f"{label} must be an HTTPS URL")
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        fail(f"{label} must be an immutable HTTPS URL without credentials, query, or fragment")
    return value


def tracked(root: Path, record: dict[str, object], label: str, *, size: bool = False) -> Path:
    relative = record.get("path")
    expected = record.get("sha256")
    if not isinstance(relative, str) or relative.startswith("/") or ".." in Path(relative).parts:
        fail(f"{label} has unsafe path")
    if not isinstance(expected, str) or not SHA256.fullmatch(expected):
        fail(f"{label} has invalid sha256")
    path = root / relative
    if not path.is_file():
        fail(f"{label} is missing: {relative}")
    actual = sha256(path)
    if actual != expected:
        fail(f"{label} sha256 mismatch: got {actual}, expected {expected}")
    if size:
        expected_size = record.get("size")
        if path.stat().st_size != expected_size:
            fail(f"{label} size mismatch: got {path.stat().st_size}, expected {expected_size}")
    return path


def config_value(text: str, option: str) -> str | None:
    enabled = re.search(rf"^{re.escape(option)}=(.*)$", text, re.MULTILINE)
    if enabled:
        return enabled.group(1)
    if re.search(rf"^# {re.escape(option)} is not set$", text, re.MULTILINE):
        return "n"
    return None


def openssl(*args: str) -> str:
    try:
        result = subprocess.run(["openssl", *args], check=True, text=True, capture_output=True)
    except (OSError, subprocess.CalledProcessError) as error:
        fail(f"openssl validation failed: {error}")
    return result.stdout.strip()


def validate_record(root: Path, record: dict[str, object], release_ready: bool) -> None:
    build_id = record.get("buildId")
    if not isinstance(build_id, str) or not BUILD_ID.fullmatch(build_id):
        fail("buildId must use the exact Android build-ID form")
    status = record.get("status")
    if release_ready and status not in {"candidate", "released"}:
        fail(f"{build_id}: release-ready status must be candidate or released")

    kernel = record["kernel"]
    for key in ("upstreamCommit", "upstreamTree", "patchedTree"):
        if not HEX40.fullmatch(kernel.get(key, "")):
            fail(f"{build_id}: {key} must be a full lowercase Git object ID")
    expected_release = "6.12.69" + kernel["localVersion"]
    if kernel["release"] != expected_release:
        fail(f"{build_id}: kernel release and LOCALVERSION disagree")

    source = record["source"]
    https_url(source.get("upstreamArchiveUrl"), f"{build_id} upstreamArchiveUrl")
    if source.get("projectArchiveUrl") is not None:
        https_url(source["projectArchiveUrl"], f"{build_id} projectArchiveUrl")
    for label in ("normalizedArchive", "sourceManifest", "patchedManifest"):
        item = source[label]
        if not SHA256.fullmatch(item.get("sha256", "")) or not isinstance(item.get("size"), int) or item["size"] <= 0:
            fail(f"{build_id}: invalid source {label}")
    if release_ready and not source.get("projectArchiveUrl"):
        fail(f"{build_id}: release-ready record needs projectArchiveUrl")
    tracked(root, record["upstreamLicenses"], f"{build_id} upstream license manifest")

    configs = record["configs"]
    stock_path = tracked(root, configs["stock"], f"{build_id} stock config")
    fragment_path = tracked(root, configs["fragment"], f"{build_id} fragment")
    if not SHA256.fullmatch(configs.get("mergedSha256", "")):
        fail(f"{build_id}: invalid merged config sha256")
    stock_text = stock_path.read_text(encoding="utf-8")
    fragment_text = fragment_path.read_text(encoding="utf-8")
    if config_value(stock_text, "CONFIG_MODULE_SIG_FORCE") == "y":
        fail(f"{build_id}: stock config enforces module signatures")
    if config_value(fragment_text, "CONFIG_MODULE_SIG_FORCE") not in (None, "n"):
        fail(f"{build_id}: fragment enables module signature enforcement")
    if config_value(fragment_text, "CONFIG_MODULE_SIG_PROTECT") not in (None, "n"):
        fail(f"{build_id}: fragment enables module signature protection")
    if config_value(fragment_text, "CONFIG_MODULE_SIG_PROTECT_LIST") != '\"\"':
        fail(f"{build_id}: fragment must empty CONFIG_MODULE_SIG_PROTECT_LIST")

    patches = record["patches"]
    patch_names = [Path(item["path"]).name for item in patches]
    if patch_names != sorted(patch_names) or len(patch_names) != len(set(patch_names)):
        fail(f"{build_id}: patches must be uniquely ordered by filename")
    for index, item in enumerate(patches):
        tracked(root, item, f"{build_id} patch {index + 1}")
        if item.get("license") not in ("GPL-2.0-only", "GPL-2.0-or-later"):
            fail(f"{build_id}: invalid patch license")

    key = record["reproducibilityKey"]
    if key.get("purpose") != "public-non-secret-build-fixture":
        fail(f"{build_id}: D4 fixture must be explicitly public and non-secret")
    pem = tracked(root, key["pem"], f"{build_id} D4 PEM", size=True)
    certificate = tracked(root, key["certificate"], f"{build_id} D4 certificate", size=True)
    support_paths = [item["path"] for item in key["supportFiles"]]
    if len(support_paths) != len(set(support_paths)):
        fail(f"{build_id}: D4 support file paths must be unique")
    for item in key["supportFiles"]:
        tracked(root, item, f"{build_id} D4 support file")
    derived = subprocess.run(
        ["openssl", "x509", "-in", str(pem), "-outform", "DER"],
        check=True,
        capture_output=True,
    ).stdout
    if derived != certificate.read_bytes():
        fail(f"{build_id}: PEM certificate and committed DER certificate differ")
    fingerprint = ":".join(key["certificate"]["sha256"][index:index + 2].upper() for index in range(0, 64, 2))
    if key["certificate"].get("sha256Fingerprint") != fingerprint:
        fail(f"{build_id}: certificate fingerprint disagrees with DER sha256")
    serial = openssl("x509", "-in", str(pem), "-noout", "-serial").removeprefix("serial=")
    if serial != key["certificate"].get("serial"):
        fail(f"{build_id}: certificate serial mismatch")

    builder = record["builder"]
    if builder.get("platform") != "linux/arm64":
        fail(f"{build_id}: authoritative platform must be linux/arm64")
    for label in ("baseImageIndexDigest", "basePlatformManifestDigest"):
        if not DIGEST.fullmatch(builder.get(label, "")):
            fail(f"{build_id}: invalid {label}")
    tracked(root, builder["dockerfile"], f"{build_id} builder Dockerfile")
    packages_path = tracked(root, builder["requestedPackages"], f"{build_id} package lock")
    build_scripts = builder.get("buildScripts")
    if not isinstance(build_scripts, list) or not build_scripts:
        fail(f"{build_id}: builder buildScripts must be a nonempty array")
    build_script_paths = [item.get("path") for item in build_scripts]
    if len(build_script_paths) != len(set(build_script_paths)):
        fail(f"{build_id}: builder buildScripts paths must be unique")
    for index, item in enumerate(build_scripts):
        tracked(root, item, f"{build_id} builder script {index + 1}")
    packages = packages_path.read_text(encoding="utf-8").splitlines()
    if packages != sorted(packages) or len(packages) != len(set(packages)) or any("=" not in item for item in packages):
        fail(f"{build_id}: package lock must be sorted, unique, and exact-versioned")
    for label in ("ociManifestDigest", "configDigest"):
        value = builder.get(label)
        if value is not None and not DIGEST.fullmatch(value):
            fail(f"{build_id}: invalid builder {label}")
        if release_ready and value is None:
            fail(f"{build_id}: release-ready record needs builder {label}")
    if builder.get("compileNetwork") != "none":
        fail(f"{build_id}: compilation must run without network")

    boot = record["boot"]
    if boot.get("partitionSize") != 67108864:
        fail(f"{build_id}: unexpected boot partition size")
    roles: set[str] = set()
    for item in boot.get("acceptedInputs", []):
        role = item.get("role")
        if role in roles or not isinstance(role, str):
            fail(f"{build_id}: accepted boot roles must be unique")
        roles.add(role)
        for label in ("payload", "partition"):
            identity = item[label]
            if not SHA256.fullmatch(identity.get("sha256", "")) or not isinstance(identity.get("size"), int):
                fail(f"{build_id}: invalid paired boot {label} identity")
        if item["partition"]["size"] != boot["partitionSize"]:
            fail(f"{build_id}: accepted partition size mismatch")
    if "stock" not in roles:
        fail(f"{build_id}: stock boot identity is required")
    output_partition = boot.get("candidateOutputPartitionSha256")
    if output_partition is not None and not SHA256.fullmatch(output_partition):
        fail(f"{build_id}: invalid candidate output partition sha256")
    if release_ready and output_partition is None:
        fail(f"{build_id}: release-ready record needs candidate output partition sha256")

    candidate = record["candidateImage"]
    if candidate.get("name") != f"Image-{build_id}.lz4":
        fail(f"{build_id}: candidate image name must be build-ID-qualified")
    candidate_size = candidate.get("size")
    candidate_sha = candidate.get("sha256")
    if (candidate_size is None) != (candidate_sha is None):
        fail(f"{build_id}: candidate image size and sha256 must be populated together")
    if candidate_size is not None and (not isinstance(candidate_size, int) or isinstance(candidate_size, bool) or candidate_size <= 0):
        fail(f"{build_id}: invalid candidate image size")
    if release_ready and candidate_size is None:
        fail(f"{build_id}: release-ready record needs candidate image size and sha256")
    if candidate.get("sha256") is not None and not SHA256.fullmatch(candidate["sha256"]):
        fail(f"{build_id}: invalid candidate image sha256")
    release_url = record.get("immutableReleaseUrl")
    if release_url is not None:
        https_url(release_url, f"{build_id} immutableReleaseUrl")
    if release_ready and not release_url:
        fail(f"{build_id}: release-ready record needs immutableReleaseUrl")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--builds", type=Path, default=Path("kernel/builds.json"))
    parser.add_argument("--release-ready", action="store_true")
    args = parser.parse_args()

    builds_path = args.builds.resolve()
    root = builds_path.parent.parent
    try:
        document = json.loads(builds_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(str(error))
    schema_path = builds_path.with_name("builds.schema.json")
    try:
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot load builds schema: {error}")
    if not isinstance(schema, dict):
        fail("builds schema root must be an object")
    validate_schema(document, schema, schema)
    records = document.get("builds")
    if not isinstance(records, list) or not records:
        fail("at least one build record is required")
    ids = [item.get("buildId") for item in records]
    if len(ids) != len(set(ids)):
        fail("build IDs must be unique")
    for record in records:
        validate_record(root, record, args.release_ready)
    print(f"validated {len(records)} build record(s)")


if __name__ == "__main__":
    main()
