import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const kernelDir = path.join(projectRoot, "kernel");
const fragmentPath = path.join(kernelDir, "fragments", "docker.config");
const stockPath = path.join(kernelDir, "configs", "CD1A.260714.001.A9.stock.config");
const validator = path.join(projectRoot, "tools", "validate-builds.py");

function parseConfig(text) {
  const values = new Map();
  for (const line of text.split("\n")) {
    const set = line.match(/^(CONFIG_[A-Z0-9_]+)=(.*)$/);
    if (set) values.set(set[1], set[2]);
    const unset = line.match(/^# (CONFIG_[A-Z0-9_]+) is not set$/);
    if (unset) values.set(unset[1], "n");
  }
  return values;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

test("the fragment is the narrow, exact Docker kernel delta", () => {
  const fragment = parseConfig(fs.readFileSync(fragmentPath, "utf8"));
  const stock = parseConfig(fs.readFileSync(stockPath, "utf8"));
  assert.deepEqual([...fragment.keys()].sort(), [
    "CONFIG_IPC_NS",
    "CONFIG_LOCALVERSION",
    "CONFIG_LOCALVERSION_AUTO",
    "CONFIG_MODULE_SIG_PROTECT_LIST",
    "CONFIG_NETFILTER_XT_MATCH_ADDRTYPE",
    "CONFIG_NETFILTER_XT_TARGET_CHECKSUM",
    "CONFIG_PID_NS",
    "CONFIG_POSIX_MQUEUE",
    "CONFIG_RUST_INLINE_HELPERS",
    "CONFIG_SYSVIPC",
    "CONFIG_TRIM_UNUSED_KSYMS",
    "CONFIG_USER_NS",
    "CONFIG_WERROR",
  ]);
  assert.equal(fragment.get("CONFIG_LOCALVERSION"), '"-android16-6-g5c5f2fea42dd-ab15835541-4k"');
  assert.equal(fragment.get("CONFIG_MODULE_SIG_PROTECT_LIST"), '""');
  for (const option of ["CONFIG_SYSVIPC", "CONFIG_POSIX_MQUEUE", "CONFIG_PID_NS", "CONFIG_USER_NS"]) {
    assert.equal(stock.get(option), "n", `${option} is disabled in stock`);
    assert.equal(fragment.get(option), "y", `${option} is enabled by the fragment`);
  }
  for (const option of ["CONFIG_BRIDGE_NETFILTER", "CONFIG_IP6_NF_NAT", "CONFIG_CGROUP_PIDS", "CONFIG_CGROUP_DEVICE"]) {
    assert.equal(fragment.has(option), false, `${option} is deliberately not enabled`);
  }
  assert.notEqual(stock.get("CONFIG_MODULE_SIG_FORCE"), "y");
});

test("the build path is clean, arm64, offline at compile time, and time-normalized", () => {
  const hostBuild = fs.readFileSync(path.join(kernelDir, "build.sh"), "utf8");
  const containerBuild = fs.readFileSync(path.join(kernelDir, "build-in-container.sh"), "utf8");
  const builder = fs.readFileSync(path.join(kernelDir, "build-builder.sh"), "utf8");
  const dockerfile = fs.readFileSync(path.join(kernelDir, "Dockerfile.buildenv"), "utf8");
  assert.match(hostBuild, /--network none --platform linux\/arm64/);
  assert.match(hostBuild, /docker volume create/);
  assert.doesNotMatch(hostBuild, /pixel11-ksrc-|--allow-config-drift/);
  assert.match(builder, /--no-cache/);
  assert.match(builder, /SOURCE_DATE_EPOCH=1788609530/);
  assert.match(dockerfile, /^FROM debian@sha256:[0-9a-f]{64}$/m);
  assert.match(dockerfile, /snapshot\.debian\.org\/archive\/debian\/\$\{DEBIAN_SNAPSHOT\}/);
  assert.doesNotMatch(containerBuild, /KBUILD_BUILD_VERSION=|KBUILD_BUILD_TIMESTAMP=/);
  assert.match(containerBuild, /echo \$\(\(build_version - 1\)\) > \/ksrc\/out\/\.version/);
  assert.match(containerBuild, /strcmp\(base, "gen_init_cpio"\) == 0/);
  assert.match(containerBuild, /Kbuild changed the D4 PEM/);
  assert.match(containerBuild, /CONFIG_MODULE_SIG_FORCE is not disabled/);
  assert.match(containerBuild, /CONFIG_MODULE_SIG_PROTECT is enabled/);
});

function mutatedFixture(change) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "build-record-mutation-"));
  fs.cpSync(kernelDir, path.join(root, "kernel"), { recursive: true });
  fs.mkdirSync(path.join(root, "tools"));
  fs.copyFileSync(validator, path.join(root, "tools", "validate-builds.py"));
  const buildsPath = path.join(root, "kernel", "builds.json");
  const document = JSON.parse(fs.readFileSync(buildsPath, "utf8"));
  for (const item of document.builds[0].builder.buildScripts) {
    const destination = path.join(root, item.path);
    if (!fs.existsSync(destination)) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(projectRoot, item.path), destination);
    }
  }
  change(root, document);
  fs.writeFileSync(buildsPath, JSON.stringify(document, null, 2) + "\n");
  return { root, buildsPath };
}

function populateReleaseReady(record) {
  record.status = "candidate";
  record.source.projectArchiveUrl = "https://downloads.example.invalid/kernel-source.tar.gz";
  record.builder.ociManifestDigest = `sha256:${"1".repeat(64)}`;
  record.builder.configDigest = `sha256:${"2".repeat(64)}`;
  record.boot.candidateOutputPartitionSha256 = "3".repeat(64);
  record.candidateImage.size = 123;
  record.candidateImage.sha256 = "4".repeat(64);
  record.immutableReleaseUrl = "https://releases.example.invalid/eip-pixel11xl-forge/v0.1.0";
}

function validateFixture(fixture, ...args) {
  return spawnSync("python3", [path.join(fixture.root, "tools", "validate-builds.py"), "--builds", fixture.buildsPath, ...args], { encoding: "utf8" });
}

test("build validation accepts the candidate record and rejects release claims", () => {
  const valid = spawnSync(validator, [], { cwd: projectRoot, encoding: "utf8" });
  assert.equal(valid.status, 0, valid.stderr);
  const release = spawnSync(validator, ["--release-ready"], { cwd: projectRoot, encoding: "utf8" });
  assert.notEqual(release.status, 0);
  assert.match(release.stderr, /projectArchiveUrl|builder|candidate|immutableReleaseUrl/);
});

test("signature enforcement mutations are rejected even with a matching file hash", () => {
  const fixture = mutatedFixture((root, document) => {
    const fragment = path.join(root, "kernel", "fragments", "docker.config");
    fs.appendFileSync(fragment, "CONFIG_MODULE_SIG_FORCE=y\n");
    document.builds[0].configs.fragment.sha256 = sha256(fs.readFileSync(fragment));
  });
  try {
    const result = spawnSync("python3", [path.join(fixture.root, "tools", "validate-builds.py"), "--builds", fixture.buildsPath], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /module signature enforcement/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("release readiness requires the status, URLs, image identity, and output partition identity", () => {
  const valid = mutatedFixture((_root, document) => populateReleaseReady(document.builds[0]));
  try {
    const result = validateFixture(valid, "--release-ready");
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(valid.root, { recursive: true, force: true });
  }

  for (const [mutate, message] of [
    [(record) => { record.status = "candidate-bootstrap"; }, /release-ready status/],
    [(record) => { record.source.projectArchiveUrl = "http://example.invalid/source.tar.gz"; }, /schema pattern|HTTPS URL/],
    [(record) => { record.candidateImage.size = "123"; }, /schema type|image size/],
    [(record) => { record.boot.candidateOutputPartitionSha256 = null; }, /output partition/],
    [(record) => { record.immutableReleaseUrl = "not-a-url"; }, /schema pattern|HTTPS URL/],
  ]) {
    const fixture = mutatedFixture((_root, document) => {
      populateReleaseReady(document.builds[0]);
      mutate(document.builds[0]);
    });
    try {
      const result = validateFixture(fixture, "--release-ready");
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, message);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("builder build-script locks are nonempty, unique by path, and hash-bound", () => {
  const fixture = mutatedFixture((_root, document) => {
    document.builds[0].builder.buildScripts[1].path = document.builds[0].builder.buildScripts[0].path;
  });
  try {
    const result = validateFixture(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /buildScripts paths must be unique/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
