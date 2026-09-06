import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.join(projectRoot, ".github", "workflows", "module.yml");
const workflow = fs.readFileSync(workflowPath, "utf8");

test("the installable module workflow is pinned, least-privilege, and release-free", () => {
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.equal((workflow.match(/^\s+contents: read$/gm) ?? []).length, 1);
  assert.doesNotMatch(workflow, /contents: write|packages: write|id-token: write|attestations: write/i);
  assert.doesNotMatch(workflow, /gh\s+release|create-release|action-gh-release|pull_request_target|self-hosted/i);
  for (const match of workflow.matchAll(/\buses:\s*([^#\s]+)/g)) {
    assert.match(match[1], /^[^@\s]+@[0-9a-f]{40}$/);
  }
  assert.match(workflow, /name: module-installable-\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /retention-days: 14/);
});

test("the workflow verifies the SDK before two clean byte-identical builds", () => {
  assert.match(workflow, /tools\/aarch64-musl-toolchain\.json/);
  assert.match(workflow, /curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1\.2/);
  assert.match(workflow, /wc -c/);
  assert.match(workflow, /sha256sum --check --strict/);
  assert.equal((workflow.match(/tools\/build-module-tools\.sh --toolchain-archive/g) ?? []).length, 2);
  assert.match(workflow, /--out \.work\/module-tools-a/);
  assert.match(workflow, /--out \.work\/module-tools-b/);
  assert.match(workflow, /for name in patch-engine swap-boot-kernel privns route-policy; do\n\s+cmp/);
});

test("the workflow proves real C and Python engine parity before packaging", () => {
  const referenceIndex = workflow.indexOf("tools/patch-engine.py --engine tools/engine.json");
  const nativeIndex = workflow.indexOf("--expect-input-sha256");
  const assemblyIndex = workflow.indexOf("tools/assemble-module.py");
  assert.ok(referenceIndex >= 0);
  assert.ok(nativeIndex > referenceIndex);
  assert.ok(assemblyIndex > nativeIndex);
  assert.match(workflow, /--expect-input-size/);
  assert.match(workflow, /--expect-output-sha256/);
  assert.match(workflow, /"--replace"/);
  assert.match(workflow, /filecmp\.cmp\(.+shallow=False\)/);
});

test("the package binds all tools, provenance, and the exact musl notice", () => {
  for (const argument of [
    "--patch-engine .work/module-tools-a/patch-engine",
    "--swap-boot-kernel .work/module-tools-a/swap-boot-kernel",
    "--privns .work/module-tools-a/privns",
    "--route-policy .work/module-tools-a/route-policy",
    "--toolchain-provenance tools/aarch64-musl-toolchain.json",
    "--musl-license tools/licenses/musl-COPYRIGHT",
  ]) {
    assert.ok(workflow.includes(argument), `missing package argument: ${argument}`);
  }
  assert.equal((workflow.match(/python3 tools\/assemble-module\.py/g) ?? []).length, 2);
  assert.equal((workflow.match(/--installable/g) ?? []).length, 2);
  assert.match(workflow, /--output \.work\/module-a\.zip/);
  assert.match(workflow, /--output \.work\/module-b\.zip/);
  assert.match(workflow, /cmp \.work\/module-a\.zip \.work\/module-b\.zip/);
  assert.match(workflow, /module_zip="eip-pixel11xl-forge-\$\{module_version\}\.zip"/);
  assert.match(workflow, /mv \.work\/module-a\.zip "dist\/\$module_zip"/);
  assert.match(workflow, /cp docs\/INSTALL\.md dist\/INSTALL\.md/);
  assert.match(workflow, /sha256sum INSTALL\.md "\$module_zip" toolchain-provenance\.json > SHA256SUMS/);
});
