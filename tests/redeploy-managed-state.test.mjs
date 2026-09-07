import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helper = path.join(projectRoot, "eip", "redeploy-managed-state.sh");
const transactionId = "a".repeat(64);

function fixture() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pixel-managed-state-"));
  const fakeBin = path.join(temporary, "bin");
  const root = path.join(temporary, "root");
  const managed = path.join(root, "state", "managed-skills");
  fs.mkdirSync(fakeBin);
  const statProgram = path.join(temporary, "stat.mjs");
  fs.writeFileSync(statProgram, [
    'import fs from "node:fs";',
    'const [, format, file] = process.argv.slice(2);',
    'if (process.argv[2] !== "-c" || !format || !file) process.exit(2);',
    'const value = fs.statSync(file);',
    'const mode = (value.mode & 0o7777).toString(8);',
    'process.stdout.write(format',
    '  .replaceAll("%d", String(value.dev))',
    '  .replaceAll("%i", String(value.ino))',
    '  .replaceAll("%u", "0")',
    '  .replaceAll("%g", "0")',
    '  .replaceAll("%a", mode) + "\\n");',
    '',
  ].join("\n"));
  fs.writeFileSync(
    path.join(fakeBin, "stat"),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(statProgram)} "$@"\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(fakeBin, "chown"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(
    path.join(fakeBin, "install"),
    "#!/bin/sh\nfor target do :; done\nmkdir -p \"$target\"\nchmod 0700 \"$target\"\n",
    { mode: 0o755 },
  );
  fs.mkdirSync(path.join(managed, "active", "agent"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(managed, "current.json"), "{\"revision\":\"old\"}\n", { mode: 0o600 });
  fs.writeFileSync(path.join(managed, "active", "agent", "SKILL.md"), "old skill\n", { mode: 0o400 });
  fs.chmodSync(managed, 0o700);
  return { temporary, fakeBin, root, managed };
}

function run(root, fakeBin, action, id = transactionId) {
  return spawnSync("/bin/bash", [helper, action, id], {
    encoding: "utf8",
    env: { ...process.env, EIP_CVE_ROOT: root, PATH: `${fakeBin}:${process.env.PATH}` },
  });
}

function inode(file) {
  return fs.statSync(file).ino;
}

test("prepare preserves the original tree and restore puts that exact tree back", () => {
  const { temporary, fakeBin, root, managed } = fixture();
  const originalInode = inode(managed);
  const originalManifest = fs.readFileSync(path.join(managed, "current.json"), "utf8");
  const transaction = path.join(root, "redeploy-transactions", transactionId);
  const previous = path.join(transaction, "previous-managed-skills");
  const failed = path.join(transaction, "failed-candidate-managed-skills");

  try {
    const prepared = run(root, fakeBin, "prepare");
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(inode(previous), originalInode);
    assert.notEqual(inode(managed), originalInode);
    assert.equal(fs.readFileSync(path.join(managed, "current.json"), "utf8"), originalManifest);
    assert.equal(fs.statSync(path.join(managed, "current.json")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(managed, "active", "agent", "SKILL.md")).mode & 0o777, 0o400);
    assert.equal(run(root, fakeBin, "check-candidate").status, 0);

    fs.writeFileSync(path.join(managed, "current.json"), "{\"revision\":\"candidate\"}\n");
    const restored = run(root, fakeBin, "restore");
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(inode(managed), originalInode);
    assert.equal(fs.readFileSync(path.join(managed, "current.json"), "utf8"), originalManifest);
    assert.equal(fs.readFileSync(path.join(failed, "current.json"), "utf8"), "{\"revision\":\"candidate\"}\n");
    assert.equal(run(root, fakeBin, "check-restored").status, 0);
    assert.equal(run(root, fakeBin, "restore").status, 0, "restore is postcondition-idempotent");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("invalid or reused transaction IDs fail before changing managed state", () => {
  const { temporary, fakeBin, root, managed } = fixture();
  const originalInode = inode(managed);
  try {
    const invalid = run(root, fakeBin, "prepare", "not-an-id");
    assert.notEqual(invalid.status, 0);
    assert.equal(inode(managed), originalInode);

    const first = run(root, fakeBin, "prepare");
    assert.equal(first.status, 0, first.stderr);
    const candidateInode = inode(managed);
    const second = run(root, fakeBin, "prepare");
    assert.notEqual(second.status, 0);
    assert.equal(inode(managed), candidateInode);
    assert.equal(inode(path.join(root, "redeploy-transactions", transactionId, "previous-managed-skills")), originalInode);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
