import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const patchDir = path.join(projectRoot, "kernel", "patches");
const builds = JSON.parse(fs.readFileSync(path.join(projectRoot, "kernel", "builds.json"), "utf8"));
const record = builds.builds.find((item) => item.buildId === "CD1A.260714.001.A9");
const commit = "5c5f2fea42dd4cc5ae1002945d86e305c09d3262";

const expected = [
  ["0001-sched-sysvipc-kabi-reserve.patch", "include/linux/sched.h", "7\t2", "GPL-2.0-only"],
  ["0002-module-allow-symbol-crc-mismatch.patch", "kernel/module/version.c", "2\t2", "GPL-2.0-or-later"],
  ["0003-overlayfs-drop-dcache-op-check.patch", "fs/overlayfs/util.c", "1\t3", "GPL-2.0-only"],
];

test("the ordered kernel patches are fully identified and parse cleanly", () => {
  assert.deepEqual(fs.readdirSync(patchDir).sort(), expected.map(([name]) => name));
  assert.deepEqual(record.patches.map((item) => path.basename(item.path)), expected.map(([name]) => name));

  for (const [name, target, counts, license] of expected) {
    const patchPath = path.join(patchDir, name);
    const bytes = fs.readFileSync(patchPath);
    const text = bytes.toString("utf8");
    const pin = record.patches.find((item) => path.basename(item.path) === name);
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), pin.sha256);
    assert.equal(pin.license, license);
    assert.match(text, new RegExp(`^Upstream: android\\.googlesource\\.com/kernel/common commit ${commit}$`, "m"));
    assert.match(text, new RegExp(`^License: ${license.replaceAll(".", "\\.")}, matching `, "m"));
    assert.match(text, new RegExp(`^--- a/${target.replace(/[./]/g, "\\$&")}$`, "m"));
    assert.match(text, new RegExp(`^\\+\\+\\+ b/${target.replace(/[./]/g, "\\$&")}$`, "m"));
    assert.equal((text.match(/^--- a\//gm) ?? []).length, 1);
    assert.doesNotMatch(text, /[\u2013\u2014]/, "plain hyphens only");

    const parsed = spawnSync("git", ["apply", "--numstat", patchPath], { encoding: "utf8" });
    assert.equal(parsed.status, 0, parsed.stderr);
    assert.equal(parsed.stdout.trim(), `${counts}\t${target}`);
  }
});

test("the full source gate, not a tracked patched tree, owns patch application", () => {
  assert.equal(fs.existsSync(path.join(projectRoot, "kernel", "patched-sources")), false);
  const buildScript = fs.readFileSync(path.join(projectRoot, "kernel", "build-in-container.sh"), "utf8");
  assert.match(buildScript, /patch -p1 --fuzz=0 --no-backup-if-mismatch/);
  assert.match(buildScript, /actual_tree=.*git write-tree/);
  assert.match(buildScript, /actual_patched_tree=.*git write-tree/);
});
