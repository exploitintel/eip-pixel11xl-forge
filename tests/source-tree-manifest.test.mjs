import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tool = path.join(projectRoot, "tools", "source-tree-manifest.py");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

test("source manifest binds path, type, executable mode, size, and bytes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "source-manifest-"));
  try {
    fs.mkdirSync(path.join(root, "z"));
    fs.writeFileSync(path.join(root, "z", "plain"), "hello\n", { mode: 0o644 });
    fs.writeFileSync(path.join(root, "run"), "#!/bin/sh\n", { mode: 0o755 });
    fs.symlinkSync("z/plain", path.join(root, "link"));
    fs.mkdirSync(path.join(root, ".git"));
    fs.writeFileSync(path.join(root, ".git", "ignored"), "not source");

    const result = spawnSync(tool, [root], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const rows = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(rows, [
      { path: "link", type: "symlink", mode: "120000", size: 7, sha256: sha256("z/plain") },
      { path: "run", type: "file", mode: "100755", size: 10, sha256: sha256("#!/bin/sh\n") },
      { path: "z/plain", type: "file", mode: "100644", size: 6, sha256: sha256("hello\n") },
    ]);

    fs.chmodSync(path.join(root, "z", "plain"), 0o755);
    const changed = spawnSync(tool, [root], { encoding: "utf8" });
    assert.notEqual(changed.stdout, result.stdout, "mode drift changes the manifest");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
