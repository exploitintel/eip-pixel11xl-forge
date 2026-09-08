import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "eip", "install-source-ops.sh"), "utf8");

test("the public source and ops helper depends only on public tracked inputs", () => {
  assert.doesNotMatch(source, /baseline\/install-map\.json|INSTALL_MAP/);
  for (const file of [
    "compose.android.yaml",
    "operator-entry.sh",
    "phone-eip.sh",
    "eip-hostctl.sh",
    "hostctl-state.mjs",
    "rebase-managed-skills.py",
    "redeploy-managed-state.sh",
    "preflight.sh",
    "fix-routing.sh",
    "merge-env.sh",
    "set-ollama.sh",
    "set-ollama-key.sh",
  ]) {
    assert.match(source, new RegExp(`eip/${file.replaceAll(".", "\\.")}`));
  }
  assert.match(source, /eip\/install-source-ops-phone\.sh/);
  assert.match(source, /eip\/restore-source-ops-phone\.sh/);
});
