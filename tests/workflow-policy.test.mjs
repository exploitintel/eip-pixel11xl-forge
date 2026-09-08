import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checker = path.join(projectRoot, "tools", "check-workflows.py");
const refChecker = path.join(projectRoot, "tools", "check-candidate-ref.py");
const workflowPath = path.join(projectRoot, ".github", "workflows", "kernel.yml");
const ciWorkflowPath = path.join(projectRoot, ".github", "workflows", "ci.yml");
const imagesWorkflowPath = path.join(projectRoot, ".github", "workflows", "images.yml");
const operatorDockerfile = fs.readFileSync(path.join(projectRoot, "eip", "Dockerfile.operator"), "utf8");

test("source CI runs the normal checks and Android host contracts", () => {
  const workflow = fs.readFileSync(ciWorkflowPath, "utf8");
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.match(workflow, /^\s+runs-on: macos-15$/m);
  assert.match(workflow, /^  push:\n    branches:\n      - main$/m);
  assert.match(workflow, /^  pull_request:\n    branches:\n      - main$/m);
  assert.match(workflow, /^  workflow_dispatch:$/m);
  assert.match(workflow, /^\s+run: npm run check$/m);
  assert.match(workflow, /^\s+run: android-app\/tools\/test-host\.sh$/m);
  assert.doesNotMatch(workflow, /kernel\/build\.sh|build-qualification-module|module\.yml/);
});

test("Phase C workflow is pinned, least-privilege, attested, and release-free", () => {
  const result = spawnSync(checker, [], { cwd: projectRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const workflow = fs.readFileSync(workflowPath, "utf8");
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.equal((workflow.match(/^\s+contents: read$/gm) ?? []).length, 3);
  assert.equal((workflow.match(/^\s+id-token: write$/gm) ?? []).length, 1);
  assert.equal((workflow.match(/^\s+attestations: write$/gm) ?? []).length, 1);
  assert.equal((workflow.match(/^\s+artifact-metadata: write$/gm) ?? []).length, 1);
  assert.match(workflow, /^\s+environment: candidate-attestation$/m);
  assert.match(workflow, /^\s+runs-on: ubuntu-24\.04-arm$/m);
  assert.match(workflow, /^\s+package-manager-cache: false$/m);
  assert.doesNotMatch(workflow, /^\s+cache:/m);
  assert.doesNotMatch(workflow, /contents: write|gh release|pull_request_target|self-hosted/i);
  for (const match of workflow.matchAll(/\buses:\s*([^#\s]+)/g)) {
    assert.match(match[1], /^[^@\s]+@[0-9a-f]{40}$/);
  }
});

test("container publication is manual, digest-bound, and limited to package writes", () => {
  const workflow = fs.readFileSync(imagesWorkflowPath, "utf8");
  assert.match(workflow, /^  workflow_dispatch:$/m);
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.equal((workflow.match(/^      packages: write$/gm) ?? []).length, 1);
  assert.doesNotMatch(workflow, /^\s+contents: write$|gh release|pull_request_target/i);
  assert.match(workflow, /ghcr\.io\/exploitintel\/eip-pixel11xl-forge-controller/);
  assert.match(workflow, /ghcr\.io\/exploitintel\/eip-pixel11xl-forge-operator/);
  assert.match(workflow, /CONTROLLER_IMAGE=.*@\$controller_digest/);
  assert.match(workflow, /OPERATOR_IMAGE=.*@\$operator_digest/);
  assert.match(workflow, /DOCKER_CONFIG="\$anonymous_config" docker pull/);
  assert.match(workflow, /docker buildx create --driver docker-container/);
  assert.match(operatorDockerfile, /^FROM docker:28\.5\.2-cli@sha256:[0-9a-f]{64}$/m);
});

function mutatedWorkflow(rewrite) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-policy-"));
  fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  fs.mkdirSync(path.join(root, "tools"));
  fs.copyFileSync(checker, path.join(root, "tools", "check-workflows.py"));
  fs.writeFileSync(path.join(root, ".github", "workflows", "kernel.yml"), rewrite(fs.readFileSync(workflowPath, "utf8")));
  const result = spawnSync("python3", [path.join(root, "tools", "check-workflows.py")], { encoding: "utf8" });
  fs.rmSync(root, { recursive: true, force: true });
  return result;
}

test("workflow policy rejects mutable actions and release privileges", () => {
  const mutable = mutatedWorkflow((text) => text.replace(/actions\/checkout@[0-9a-f]{40}/, "actions/checkout@v7"));
  assert.notEqual(mutable.status, 0);
  assert.match(mutable.stderr, /not pinned/);

  const write = mutatedWorkflow((text) => text.replace("contents: read", "contents: write"));
  assert.notEqual(write.status, 0);
  assert.match(write.stderr, /contents: write/);

  const release = mutatedWorkflow((text) => `${text}\n# gh release create v0.1.0\n`);
  assert.notEqual(release.status, 0);
  assert.match(release.stderr, /release API/);

  const broad = mutatedWorkflow((text) => text.replace("permissions: {}", "permissions: write-all"));
  assert.notEqual(broad.status, 0);
  assert.match(broad.stderr, /top-level permissions|broad permissions/);

  const packages = mutatedWorkflow((text) => text.replace("contents: read", "packages: write"));
  assert.notEqual(packages.status, 0);
  assert.match(packages.stderr, /packages: write/);

  const credentials = mutatedWorkflow((text) => text.replace("persist-credentials: false", "persist-credentials: true"));
  assert.notEqual(credentials.status, 0);
  assert.match(credentials.stderr, /persist-credentials/);
});

test("candidate source refs accept only main or strict three-part SemVer tags", () => {
  for (const ref of ["refs/heads/main", "refs/tags/v0.1.0", "refs/tags/v12.34.56"]) {
    const result = spawnSync(refChecker, [ref], { encoding: "utf8" });
    assert.equal(result.status, 0, `${ref}: ${result.stderr}`);
  }
  for (const ref of [
    "refs/heads/feature",
    "refs/tags/v01.2.3",
    "refs/tags/v1.02.3",
    "refs/tags/v1.2.03",
    "refs/tags/v1x.2y.3z",
    "refs/tags/v1.2.3-rc1",
    "refs/tags/v1.2",
  ]) {
    const result = spawnSync(refChecker, [ref], { encoding: "utf8" });
    assert.notEqual(result.status, 0, `${ref} should be rejected`);
  }
});
