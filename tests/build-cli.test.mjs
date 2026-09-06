import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const build = path.join(projectRoot, "kernel", "build.sh");
const buildId = "CD1A.260714.001.A9";
const sourceName = "kernel-common-5c5f2fea42dd4cc5ae1002945d86e305c09d3262.tar.gz";

test("kernel build CLI rejects usage and source mismatches before compilation", () => {
  assert.equal(spawnSync(build, [], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync(build, ["--build-id"], { encoding: "utf8" }).status, 2);
  const missing = spawnSync(build, ["--build-id", buildId, "--source-archive", "/does/not/exist", "--out", "/tmp/not-created"], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /source archive not found/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kernel-build-cli-"));
  try {
    const source = path.join(root, sourceName);
    fs.writeFileSync(source, "not the pinned source");
    const result = spawnSync(build, ["--build-id", buildId, "--source-archive", source, "--out", path.join(root, "out")], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /source archive size mismatch/);
    assert.equal(fs.existsSync(path.join(root, "out")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
