import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compose = fs.readFileSync(path.join(root, "eip", "compose.android.yaml"), "utf8");
const operatorEntry = fs.readFileSync(path.join(root, "eip", "operator-entry.sh"), "utf8");

function serviceBlock(name, nextName) {
  const start = compose.indexOf(`  ${name}:\n`);
  const end = compose.indexOf(`  ${nextName}:\n`, start + 1);
  assert.notEqual(start, -1, `${name} service is missing`);
  assert.notEqual(end, -1, `${nextName} service boundary is missing`);
  return compose.slice(start, end);
}

test("Android host-network services declare the matching execution context", () => {
  for (const [name, nextName] of [["ui", "chat"], ["chat", "ollama"]]) {
    const block = serviceBlock(name, nextName);
    assert.match(block, /^ {4}network_mode: host$/m);
    assert.match(block, /^ {6}EIP_CVE_EXECUTION_CONTEXT: host-network-controller$/m);
  }
  assert.equal(
    (compose.match(/EIP_CVE_EXECUTION_CONTEXT: host-network-controller/g) ?? []).length,
    2,
  );
});

test("Android services share Forge maintenance admission read-only", () => {
  for (const [name, nextName] of [["ui", "chat"], ["chat", "ollama"]]) {
    const block = serviceBlock(name, nextName);
    assert.match(block, /^ {6}EIP_CVE_MAINTENANCE_FILE: \/run\/eip-cve-control\/maintenance-v1$/m);
    assert.match(block, /^ {8}source: \/data\/docker\/eip-cve-control$/m);
    assert.match(block, /^ {8}target: \/run\/eip-cve-control$/m);
    assert.match(block, /^ {8}read_only: true$/m);
  }
});

test("the phone verifier uses the Android compose override without local Ollama", () => {
  assert.match(
    operatorEntry,
    /exec "\$SRC\/deploy\/container\/verify\.sh" \\\n+      --external-ollama --compose-file "\$OPS\/compose\.android\.yaml" "\$@"/,
  );
});

test("the phone operator exposes the existing v4 managed-skills release step", () => {
  assert.match(
    operatorEntry,
    /skills-release\)\n    shift\n    exec python3 "\$OPS\/rebase-managed-skills\.py" "\$@"/,
  );
  assert.match(
    operatorEntry,
    /managed-state\)\n    shift\n    exec "\$OPS\/redeploy-managed-state\.sh" "\$@"/,
  );
});
