import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checker = path.join(projectRoot, "tools", "check-public-tree.sh");
const builds = JSON.parse(fs.readFileSync(path.join(projectRoot, "kernel", "builds.json"), "utf8"));
const key = builds.builds[0].reproducibilityKey;

function sha256(pathname) {
  return crypto.createHash("sha256").update(fs.readFileSync(pathname)).digest("hex");
}

function copyProjectFixture(prefix) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const root = path.join(parent, "repository");
  fs.cpSync(projectRoot, root, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(projectRoot, source);
      return relative !== ".git"
        && !relative.startsWith(`.git${path.sep}`)
        && relative !== ".cache"
        && !relative.startsWith(`.cache${path.sep}`);
    },
  });
  const initialized = spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  return { parent, root };
}

test("the public tree contains only the one hash-bound non-secret private key", () => {
  const result = spawnSync(checker, [], { cwd: projectRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const pem = path.join(projectRoot, key.pem.path);
  const certificate = path.join(projectRoot, key.certificate.path);
  assert.equal(sha256(pem), key.pem.sha256);
  assert.equal(sha256(certificate), key.certificate.sha256);
  assert.match(fs.readFileSync(pem, "utf8"), /BEGIN PRIVATE KEY/);

  const details = spawnSync("openssl", ["x509", "-in", pem, "-noout", "-subject", "-serial", "-dates", "-fingerprint", "-sha256"], { encoding: "utf8" });
  assert.equal(details.status, 0, details.stderr);
  assert.match(details.stdout, /CN\s*=\s*eip-pixel11xl-forge public reproducibility fixture v1/);
  assert.match(details.stdout, new RegExp(`serial=${key.certificate.serial}`));
  assert.match(details.stdout, /notBefore=Sep  6 00:00:00 2026 GMT/);
  assert.match(details.stdout, /notAfter=Sep  6 00:00:00 2126 GMT/);
  assert.match(details.stdout, new RegExp(key.certificate.sha256Fingerprint.replaceAll(":", "[:]?")));
});

test("the public-tree gate rejects firmware paths", () => {
  const { parent, root } = copyProjectFixture("public-tree-negative-");
  try {
    fs.mkdirSync(path.join(root, "stock"));
    fs.writeFileSync(path.join(root, "stock", "boot.img"), "synthetic refusal fixture");
    const result = spawnSync(path.join(root, "tools", "check-public-tree.sh"), [], { cwd: root, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /forbidden public path: stock/);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("the public-tree gate rejects a force-added cache secret", () => {
  const { parent, root } = copyProjectFixture("public-tree-cache-negative-");
  try {
    fs.mkdirSync(path.join(root, ".cache"));
    fs.writeFileSync(path.join(root, ".cache", "secret.txt"), "synthetic private material");
    const added = spawnSync("git", ["add", "-f", "--", ".cache/secret.txt"], { cwd: root, encoding: "utf8" });
    assert.equal(added.status, 0, added.stderr);

    const result = spawnSync(path.join(root, "tools", "check-public-tree.sh"), [], { cwd: root, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /tracked cache path: \.cache\/secret\.txt/);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
