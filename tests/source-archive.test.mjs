import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checker = path.join(projectRoot, "tools", "check-source-archive.py");

function tar(root, archive, ...entries) {
  const result = spawnSync("tar", ["-czf", archive, "-C", root, ...entries], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

test("source archive validation accepts regular source and contained symlinks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "source-archive-good-"));
  try {
    fs.mkdirSync(path.join(root, "source", "include"), { recursive: true });
    fs.mkdirSync(path.join(root, "source", "scripts"));
    fs.writeFileSync(path.join(root, "source", "include", "item.h"), "value\n");
    fs.symlinkSync("../include/item.h", path.join(root, "source", "scripts", "item.h"));
    const archive = path.join(root, "source.tar.gz");
    tar(root, archive, "source");
    const result = spawnSync(checker, [archive], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("source archive validation rejects escaping symlinks and special files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "source-archive-bad-"));
  try {
    fs.mkdirSync(path.join(root, "source"));
    fs.writeFileSync(path.join(root, "source", "file"), "value\n");
    fs.symlinkSync("../../outside", path.join(root, "source", "escape"));
    const symlinkArchive = path.join(root, "symlink.tar.gz");
    tar(root, symlinkArchive, "source");
    const symlinkResult = spawnSync(checker, [symlinkArchive], { encoding: "utf8" });
    assert.notEqual(symlinkResult.status, 0);
    assert.match(symlinkResult.stderr, /path escapes root/);

    fs.unlinkSync(path.join(root, "source", "escape"));
    const fifo = path.join(root, "source", "fifo");
    const mkfifo = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
    assert.equal(mkfifo.status, 0, mkfifo.stderr);
    const fifoArchive = path.join(root, "fifo.tar.gz");
    tar(root, fifoArchive, "source");
    const fifoResult = spawnSync(checker, [fifoArchive], { encoding: "utf8" });
    assert.notEqual(fifoResult.status, 0);
    assert.match(fifoResult.stderr, /unsupported source member type/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
