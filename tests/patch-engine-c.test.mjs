import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(projectRoot, "tools", "patch-engine.c");
const pythonTool = path.join(projectRoot, "tools", "patch-engine.py");
const enginePinPath = path.join(projectRoot, "tools", "engine.json");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pixel-patch-engine-c-"));
const binary = path.join(temporaryRoot, "patch-engine");

const build = spawnSync(
  "cc",
  ["-std=c99", "-Wall", "-Wextra", "-Werror", "-O2", "-o", binary, source],
  { encoding: "utf8" },
);
assert.equal(build.status, 0, build.stderr);

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const publicPin = JSON.parse(fs.readFileSync(enginePinPath, "utf8"));
const rules = publicPin.rules;

function applyRules(buffer, selectedRules) {
  let text = buffer.toString("latin1");
  const counts = {};
  for (const rule of selectedRules) {
    counts[rule.from] = text.split(rule.from).length - 1;
    text = text.split(rule.from).join(rule.to);
  }
  return { patched: Buffer.from(text, "latin1"), counts };
}

// This is the same deterministic archive fixture used by the Python patcher
// test. Running both tools over these exact members proves byte-level parity.
const originals = {
  dockerd: Buffer.from(
    "A/run/containerd\0B/run/docker/plugins\0C/run/docker/metrics.sock\0" +
      "D/run/containerd/fifo\0E/var/run/docker.sock\0",
    "latin1",
  ),
  containerd: Buffer.from("/run/containerd/x\0/run/containerd/y\0", "latin1"),
  "containerd-shim-runc-v2": Buffer.from("shim /run/containerd\0", "latin1"),
  docker: Buffer.from("cli bytes untouched /run/containerd\0", "latin1"),
};

const sourceDirectory = path.join(temporaryRoot, "src", "docker");
fs.mkdirSync(sourceDirectory, { recursive: true });
for (const [name, bytes] of Object.entries(originals)) {
  fs.writeFileSync(path.join(sourceDirectory, name), bytes, { mode: 0o755 });
}
const tarball = path.join(temporaryRoot, "docker-test.tgz");
const archived = spawnSync(
  "tar",
  ["-czf", tarball, "-C", path.join(temporaryRoot, "src"), "docker"],
  { encoding: "utf8" },
);
assert.equal(archived.status, 0, archived.stderr);
const tarballBytes = fs.readFileSync(tarball);

const fixtureBinaries = {};
for (const [name, bytes] of Object.entries(originals)) {
  const selectedRules = name === "docker" ? [] : rules;
  const { patched, counts } = applyRules(bytes, selectedRules);
  fixtureBinaries[name] = {
    inputSha256: sha256(bytes),
    outputSha256: sha256(patched),
    replacements: selectedRules.length ? counts : {},
    patched,
    selectedRules,
  };
}

const fixturePin = {
  engine: {
    version: "test",
    tarball: {
      url: "https://example.invalid/docker-test.tgz",
      size: tarballBytes.length,
      sha256: sha256(tarballBytes),
    },
  },
  rules,
  binaries: Object.fromEntries(
    Object.entries(fixtureBinaries).map(([name, entry]) => [
      name,
      {
        size: originals[name].length,
        inputSha256: entry.inputSha256,
        replacements: entry.replacements,
        sha256: entry.outputSha256,
      },
    ]),
  ),
};
const fixturePinPath = path.join(temporaryRoot, "engine-test.json");
fs.writeFileSync(fixturePinPath, JSON.stringify(fixturePin, null, 2) + "\n");
const pythonOutput = path.join(temporaryRoot, "python-output");
const pythonResult = spawnSync(
  pythonTool,
  ["--engine", fixturePinPath, "--tarball", tarball, "--out", pythonOutput],
  { encoding: "utf8" },
);
assert.equal(pythonResult.status, 0, pythonResult.stderr);

function replacementArguments(selectedRules, replacements) {
  return selectedRules.flatMap((rule) => [
    "--replace",
    rule.from,
    rule.to,
    String(replacements[rule.from] ?? 0),
  ]);
}

function baseArguments(name, output, overrides = {}) {
  const entry = fixtureBinaries[name];
  const input = overrides.input ?? path.join(sourceDirectory, name);
  const inputSize = overrides.inputSize ?? originals[name].length;
  const inputSha256 = overrides.inputSha256 ?? entry.inputSha256;
  const outputSha256 = overrides.outputSha256 ?? entry.outputSha256;
  const selectedRules = overrides.selectedRules ?? entry.selectedRules;
  const replacements = overrides.replacements ?? entry.replacements;
  return [
    input,
    output,
    "--expect-input-size",
    String(inputSize),
    "--expect-input-sha256",
    inputSha256,
    "--expect-output-sha256",
    outputSha256,
    ...replacementArguments(selectedRules, replacements),
  ];
}

function run(arguments_, extraEnvironment = {}) {
  return spawnSync(binary, arguments_, {
    cwd: temporaryRoot,
    encoding: "utf8",
    env: { ...process.env, ...extraEnvironment },
  });
}

for (const [name, entry] of Object.entries(fixtureBinaries)) {
  const output = path.join(temporaryRoot, `c-${name}`);
  const result = run(baseArguments(name, output));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(output), entry.patched, `${name} expected bytes`);
  assert.deepEqual(
    fs.readFileSync(output),
    fs.readFileSync(path.join(pythonOutput, name)),
    `${name} Python parity`,
  );
  assert.equal(fs.statSync(output).mode & 0o777, 0o755, `${name} mode`);
  assert.equal(result.stdout, `${entry.outputSha256}  ${output}\n`);
}

// Publication is the status boundary. Once the verified temporary inode is
// linked at OUTPUT, a temporary-link cleanup failure is a warning, not a false
// refusal that leaves a valid output behind with nonzero status.
const unlinkFaultCode = process.platform === "darwin" ? `
#include <errno.h>
#include <unistd.h>
static int fail_unlink(const char *path) {
    (void)path;
    errno = EIO;
    return -1;
}
__attribute__((used)) static struct {
    const void *replacement;
    const void *replacee;
} unlink_interpose __attribute__((section("__DATA,__interpose"))) = {
    (const void *)(unsigned long)&fail_unlink,
    (const void *)(unsigned long)&unlink
};
` : `
#include <errno.h>
#include <unistd.h>
int unlink(const char *path) {
    (void)path;
    errno = EIO;
    return -1;
}
`;
const unlinkFaultSource = path.join(temporaryRoot, "fail-unlink.c");
fs.writeFileSync(unlinkFaultSource, unlinkFaultCode);
const unlinkFaultLibrary = path.join(
  temporaryRoot,
  process.platform === "darwin" ? "libfail-unlink.dylib" : "libfail-unlink.so",
);
const unlinkFaultBuildArguments = process.platform === "darwin"
  ? ["-dynamiclib", "-Wall", "-Wextra", "-Werror", "-o", unlinkFaultLibrary, unlinkFaultSource]
  : ["-shared", "-fPIC", "-Wall", "-Wextra", "-Werror", "-o", unlinkFaultLibrary, unlinkFaultSource];
const unlinkFaultBuild = spawnSync("cc", unlinkFaultBuildArguments, { encoding: "utf8" });
assert.equal(unlinkFaultBuild.status, 0, unlinkFaultBuild.stderr);
const unlinkFaultEnvironment = process.platform === "darwin"
  ? { DYLD_FORCE_FLAT_NAMESPACE: "1", DYLD_INSERT_LIBRARIES: unlinkFaultLibrary }
  : { LD_PRELOAD: unlinkFaultLibrary };
const cleanupWarningOutput = path.join(temporaryRoot, "cleanup-warning-output");
const cleanupWarning = run(
  baseArguments("docker", cleanupWarningOutput),
  unlinkFaultEnvironment,
);
assert.equal(cleanupWarning.status, 0, cleanupWarning.stderr);
assert.match(cleanupWarning.stderr, /warning: output is valid but temporary link remains/);
assert.deepEqual(fs.readFileSync(cleanupWarningOutput), fixtureBinaries.docker.patched);
const retainedTemporaryLinks = fs.readdirSync(temporaryRoot).filter((name) =>
  name.startsWith(`${path.basename(cleanupWarningOutput)}.tmp.`),
);
assert.equal(retainedTemporaryLinks.length, 1);
fs.unlinkSync(path.join(temporaryRoot, retainedTemporaryLinks[0]));

function refused(label, arguments_, pattern) {
  const output = path.join(temporaryRoot, `refused-${label}`);
  const result = run(arguments_(output));
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, pattern);
  assert.equal(fs.existsSync(output), false, `${label} must not create output`);
  assert.deepEqual(
    fs.readdirSync(temporaryRoot).filter((name) => name.startsWith(`refused-${label}.tmp.`)),
    [],
    `${label} must clean temporary output`,
  );
}

// Complete input identity is independent of size and replacement counts.
const changedInput = Buffer.from(originals.dockerd);
changedInput[0] ^= 0xff;
const changedInputPath = path.join(temporaryRoot, "changed-dockerd");
fs.writeFileSync(changedInputPath, changedInput);
refused(
  "input-hash",
  (output) => baseArguments("dockerd", output, { input: changedInputPath }),
  /input sha256 mismatch/,
);
refused(
  "input-size",
  (output) => baseArguments("dockerd", output, { inputSize: originals.dockerd.length + 1 }),
  /input size mismatch/,
);

// Every ordered, same-length rule has an exact non-overlapping count.
refused(
  "count",
  (output) =>
    baseArguments("dockerd", output, {
      replacements: { ...fixtureBinaries.dockerd.replacements, "/run/containerd": 99 },
    }),
  /replacement count mismatch for \/run\/containerd/,
);
refused(
  "output-hash",
  (output) => baseArguments("dockerd", output, { outputSha256: "00".repeat(32) }),
  /output sha256 mismatch/,
);
refused(
  "length-changing-rule",
  (output) => [
    ...baseArguments("docker", output),
    "--replace",
    "/run/containerd",
    "/dev/containerd-longer",
    "1",
  ],
  /same-length strings/,
);
refused(
  "empty-rule",
  (output) => [...baseArguments("docker", output), "--replace", "", "", "0"],
  /nonempty ASCII/,
);
refused(
  "duplicate-rule",
  (output) => [
    ...baseArguments("containerd", output),
    "--replace",
    rules[0].from,
    rules[0].to,
    "2",
  ],
  /duplicate replacement source/,
);

// Existing files and dangling links are never overwritten.
const existingOutput = path.join(temporaryRoot, "existing-output");
const sentinel = Buffer.from("keep this output");
fs.writeFileSync(existingOutput, sentinel);
const existing = run(baseArguments("docker", existingOutput));
assert.equal(existing.status, 1, existing.stderr);
assert.match(existing.stderr, /output exists; refusing to overwrite/);
assert.deepEqual(fs.readFileSync(existingOutput), sentinel);

const danglingOutput = path.join(temporaryRoot, "dangling-output");
fs.symlinkSync(path.join(temporaryRoot, "absent-target"), danglingOutput);
const dangling = run(baseArguments("docker", danglingOutput));
assert.equal(dangling.status, 1, dangling.stderr);
assert.match(dangling.stderr, /output exists; refusing to overwrite/);
assert.equal(fs.readlinkSync(danglingOutput), path.join(temporaryRoot, "absent-target"));

const inputLink = path.join(temporaryRoot, "input-link");
fs.symlinkSync(path.join(sourceDirectory, "docker"), inputLink);
refused(
  "input-link",
  (output) => baseArguments("docker", output, { input: inputLink }),
  /input is not a regular file/,
);

// The built-in digest covers SHA-256 padding boundaries and a streamed file.
for (const length of [1, 55, 56, 63, 64, 65, 1024 * 1024 + 1]) {
  const bytes = crypto.randomBytes(length);
  const input = path.join(temporaryRoot, `hash-input-${length}`);
  const output = path.join(temporaryRoot, `hash-output-${length}`);
  const digest = sha256(bytes);
  fs.writeFileSync(input, bytes);
  const result = run([
    input,
    output,
    "--expect-input-size",
    String(length),
    "--expect-input-sha256",
    digest,
    "--expect-output-sha256",
    digest,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(output), bytes, `SHA-256 boundary ${length}`);
}

// Mandatory identities and malformed values are usage errors.
assert.equal(run([]).status, 2);
assert.equal(run([path.join(sourceDirectory, "docker"), "unused-output"]).status, 2);
const complete = baseArguments("docker", path.join(temporaryRoot, "usage-output"));
for (const option of [
  "--expect-input-size",
  "--expect-input-sha256",
  "--expect-output-sha256",
]) {
  const missing = [...complete];
  const optionIndex = missing.indexOf(option);
  missing.splice(optionIndex, 2);
  assert.equal(run(missing).status, 2, `${option} must be mandatory`);
}
const badDigest = [...complete];
badDigest[badDigest.indexOf("--expect-input-sha256") + 1] = "not-a-sha256";
assert.equal(run(badDigest).status, 2);
const zeroSize = [...complete];
zeroSize[zeroSize.indexOf("--expect-input-size") + 1] = "0";
assert.equal(run(zeroSize).status, 2);

fs.rmSync(temporaryRoot, { recursive: true, force: true });
