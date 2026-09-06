import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkerSource = path.join(projectRoot, "tools", "check-candidate.py");
const buildId = "TEST.1";

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function fileIdentity(filename) {
  const content = fs.readFileSync(filename);
  return { size: content.length, sha256: sha256(content) };
}

function writeManifest(candidate) {
  const names = fs.readdirSync(candidate).filter((name) => name !== "SHA256SUMS").sort();
  const rows = names.map((name) => `${sha256(fs.readFileSync(path.join(candidate, name)))}  ${name}\n`);
  fs.writeFileSync(path.join(candidate, "SHA256SUMS"), rows.join(""));
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-policy-"));
  const tools = path.join(root, "tools");
  const kernel = path.join(root, "kernel");
  const candidate = path.join(root, "candidate");
  fs.mkdirSync(tools);
  fs.mkdirSync(kernel);
  fs.mkdirSync(candidate);
  const checker = path.join(tools, "check-candidate.py");
  fs.copyFileSync(checkerSource, checker);

  const names = {
    image: `Image-${buildId}.lz4`,
    record: `build-record-${buildId}.json`,
    config: `config-${buildId}`,
    source: "kernel-source.tar.gz",
    sourceManifest: `source-tree-${buildId}.jsonl`,
    patchedManifest: `patched-source-tree-${buildId}.jsonl`,
    patch: `patch-${buildId}-0001-fixture.patch`,
    toolchain: `toolchain-${buildId}.txt`,
    version: `version-${buildId}.txt`,
    notes: `vmlinux-notes-${buildId}.txt`,
  };
  const contents = {
    [names.image]: Buffer.from("lz4 kernel fixture"),
    [names.config]: Buffer.from("CONFIG_FIXTURE=y\n"),
    [names.source]: Buffer.from("normalized source fixture"),
    [names.sourceManifest]: Buffer.from('{"path":"Makefile"}\n'),
    [names.patchedManifest]: Buffer.from('{"path":"Makefile","patched":true}\n'),
    [names.patch]: Buffer.from("synthetic patch fixture\n"),
    [names.toolchain]: Buffer.from("platform: linux/arm64\n"),
    [names.version]: Buffer.from("Linux version fixture\n"),
    [names.notes]: Buffer.from("Build ID fixture\n"),
  };
  for (const [name, content] of Object.entries(contents)) fs.writeFileSync(path.join(candidate, name), content);

  const record = {
    buildId,
    device: { codename: "fixture" },
    kernel: { upstreamCommit: "1".repeat(40) },
    source: {
      normalizedArchive: { name: names.source, ...fileIdentity(path.join(candidate, names.source)) },
      sourceManifest: { name: "source-tree.jsonl", ...fileIdentity(path.join(candidate, names.sourceManifest)) },
      patchedManifest: { name: "patched-source-tree.jsonl", ...fileIdentity(path.join(candidate, names.patchedManifest)) },
    },
    upstreamLicenses: { path: "kernel/UPSTREAM-LICENSES.sha256", sha256: "2".repeat(64) },
    configs: { mergedSha256: sha256(contents[names.config]) },
    patches: [{ path: "kernel/patches/0001-fixture.patch", sha256: sha256(contents[names.patch]) }],
    reproducibilityKey: { purpose: "fixture" },
    builder: {
      platform: "linux/arm64",
      ociManifestDigest: null,
      configDigest: null,
    },
    kbuild: { host: "fixture" },
    candidateImage: { name: names.image, ...fileIdentity(path.join(candidate, names.image)) },
  };
  const buildRecord = {
    schemaVersion: 1,
    buildId,
    device: record.device,
    kernel: record.kernel,
    source: record.source,
    upstreamLicenses: record.upstreamLicenses,
    configs: record.configs,
    patches: record.patches,
    reproducibilityKey: record.reproducibilityKey,
    builder: {
      ...record.builder,
      ociManifestDigest: `sha256:${"3".repeat(64)}`,
      configDigest: `sha256:${"4".repeat(64)}`,
    },
    kbuild: record.kbuild,
    outputs: {
      Image: { size: 123, sha256: "5".repeat(64) },
      "Image.lz4": fileIdentity(path.join(candidate, names.image)),
    },
  };
  fs.writeFileSync(path.join(candidate, names.record), `${JSON.stringify(buildRecord, null, 2)}\n`);
  fs.writeFileSync(path.join(kernel, "builds.json"), `${JSON.stringify({ schemaVersion: 1, repository: "eip-pixel11xl-forge", builds: [record] }, null, 2)}\n`);
  writeManifest(candidate);
  return { root, candidate, checker, names };
}

function run(fixture) {
  return spawnSync("python3", [fixture.checker, fixture.candidate, "--build-id", buildId], { encoding: "utf8" });
}

test("candidate gate binds every reproducibility payload to supported-build provenance", () => {
  const fixture = makeFixture();
  try {
    const valid = run(fixture);
    assert.equal(valid.status, 0, valid.stderr);

    fs.writeFileSync(path.join(fixture.candidate, fixture.names.source), "different source bytes");
    writeManifest(fixture.candidate);
    const changedSource = run(fixture);
    assert.notEqual(changedSource.status, 0);
    assert.match(changedSource.stderr, /source archive identity/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("candidate gate rejects self-consistent manifests with false build provenance", () => {
  const fixture = makeFixture();
  try {
    const recordPath = path.join(fixture.candidate, fixture.names.record);
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    record.kernel.upstreamCommit = "f".repeat(40);
    fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    writeManifest(fixture.candidate);
    const result = run(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /build record kernel disagrees/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("candidate secret scan distinguishes upstream sk filenames from API keys", () => {
  const fixture = makeFixture();
  try {
    fs.writeFileSync(
      path.join(fixture.candidate, fixture.names.toolchain),
      "source: arch/arm/boot/dts/nxp/imx/imx53-sk-imx53-atm0700d4-lvds.dts\n",
    );
    writeManifest(fixture.candidate);
    const upstreamPath = run(fixture);
    assert.equal(upstreamPath.status, 0, upstreamPath.stderr);

    fs.writeFileSync(
      path.join(fixture.candidate, fixture.names.toolchain),
      `OPENAI_API_KEY=sk-${"A".repeat(32)}\n`,
    );
    writeManifest(fixture.candidate);
    const apiKey = run(fixture);
    assert.notEqual(apiKey.status, 0);
    assert.match(apiKey.stderr, /private identifier or secret pattern/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
