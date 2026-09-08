#!/usr/bin/env python3
"""Enforce Phase C GitHub workflow privilege and pinning boundaries."""

from __future__ import annotations

import re
import sys
from pathlib import Path


root = Path(__file__).resolve().parent.parent
workflow_dir = root / ".github" / "workflows"
failures: list[str] = []
for path in sorted(workflow_dir.glob("*.y*ml")):
    text = path.read_text(encoding="utf-8")
    relative = path.relative_to(root)
    lines = text.splitlines()
    top_permissions = [line for line in lines if line.startswith("permissions:")]
    if top_permissions != ["permissions: {}"]:
        failures.append(f"{relative}: top-level permissions must be exactly permissions: {{}}")

    checkout_count = 0
    persisted_disabled_count = 0
    current_job: str | None = None
    privileged_writes: list[tuple[str, str, int]] = []
    package_writes: list[tuple[str, int]] = []
    for line_number, line in enumerate(lines, 1):
        job_match = re.fullmatch(r"  ([A-Za-z0-9_-]+):", line)
        if job_match:
            current_job = job_match.group(1)
        match = re.search(r"\buses:\s*([^#\s]+)", line)
        if match:
            action = match.group(1)
            if action.startswith("actions/checkout@"):
                checkout_count += 1
            if not action.startswith("./") and not re.fullmatch(r"[^@\s]+@[0-9a-f]{40}", action):
                failures.append(f"{relative}:{line_number}: action is not pinned by full commit SHA")
        if re.fullmatch(r"\s+persist-credentials:\s*false", line):
            persisted_disabled_count += 1
        permission = re.fullmatch(r"\s+([A-Za-z-]+):\s*write", line)
        if permission:
            scope = permission.group(1)
            if scope == "packages" and relative == Path(".github/workflows/images.yml") and current_job == "publish":
                package_writes.append((current_job, line_number))
            elif scope not in {"id-token", "attestations", "artifact-metadata"}:
                failures.append(f"{relative}:{line_number}: forbidden write permission: {scope}: write")
            else:
                privileged_writes.append((current_job or "<unknown>", scope, line_number))

    if checkout_count != persisted_disabled_count:
        failures.append(f"{relative}: every checkout must set persist-credentials: false")
    if privileged_writes:
        jobs = {job for job, _, _ in privileged_writes}
        scopes = [scope for _, scope, _ in privileged_writes]
        expected = {"id-token", "attestations", "artifact-metadata"}
        if len(jobs) != 1 or set(scopes) != expected or len(scopes) != len(expected):
            failures.append(
                f"{relative}: attestation write permissions must occur exactly once in one job"
            )
    if relative == Path(".github/workflows/images.yml"):
        if len(package_writes) != 1 or package_writes[0][0] != "publish":
            failures.append(f"{relative}: packages: write must occur exactly once in the publish job")
    for pattern, message in (
        (r"(?m)^\s*pull_request_target\s*:", "pull_request_target is forbidden"),
        (r"(?m)^\s*permissions\s*:\s*(?:read-all|write-all)\s*$", "broad permissions are forbidden"),
        (r"\bgh\s+release\b", "release API use is forbidden in Phase C"),
        (r"actions/(?:create|upload)-release", "release action is forbidden in Phase C"),
        (r"softprops/action-gh-release", "release action is forbidden in Phase C"),
        (r"(?m)^\s*runs-on\s*:.*self-hosted", "self-hosted runners are forbidden for attested candidates"),
    ):
        if re.search(pattern, text, re.IGNORECASE):
            failures.append(f"{relative}: {message}")

if failures:
    print("\n".join(failures), file=sys.stderr)
    raise SystemExit(1)
print(f"validated {len(list(workflow_dir.glob('*.y*ml')))} workflow(s)")
