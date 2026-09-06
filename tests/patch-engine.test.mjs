import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tool = path.join(projectRoot, "tools", "patch-engine.py");
const enginePinPath = path.join(projectRoot, "tools", "engine.json");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pixel-patch-engine-"));

assert.equal(fs.statSync(tool).mode & 0o111, 0o111, "tool must be executable");
assert.match(fs.readFileSync(tool, "utf8"), /^#!\/usr\/bin\/env python3\n/);

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

// ---- The public engine record is complete and internally consistent.
const pin = JSON.parse(fs.readFileSync(enginePinPath, "utf8"));
assert.equal(pin.engine.version, "29.8.0");
assert.equal(pin.engine.tarball.url, "https://download.docker.com/linux/static/stable/aarch64/docker-29.8.0.tgz");
assert.equal(pin.engine.tarball.size, 77727467);
assert.equal(pin.engine.tarball.sha256, "1462a696be6029bd478d7d60d7f3c31cdd15affd1178a4a278aaf4a1d1b7f8b5");
assert.deepEqual(pin.rules, [
  { from: "/run/containerd", to: "/dev/containerd" },
  { from: "/run/docker/plugins", to: "/dev/docker/plugins" },
  { from: "/run/docker/metrics.sock", to: "/dev/docker/metrics.sock" },
]);
for (const rule of pin.rules) {
  assert.equal(rule.from.length, rule.to.length, "rules must preserve length");
}
assert.equal(pin.binaries.dockerd.sha256, "250bbfc1c5e6d21a6b0759e01de4cbd675531278c0ed649353717f752c291ea3");
assert.equal(pin.binaries.dockerd.inputSha256, "d2997001cfb25b60b05834f8faf248e5c18924b58117ddad9bb8574d5fdc89ad");
assert.equal(pin.binaries.containerd.sha256, "4b9fbf9754d24362e6e91787e5436c055a64ad3a23e62615845a4018615bb479");
assert.equal(pin.binaries.containerd.inputSha256, "4c14bb60b04edc67d298bac605d7012ce91dd940e46270559a49b32a28e82699");
assert.equal(pin.binaries["containerd-shim-runc-v2"].sha256, "ab3c0811bfed1e11f04ea2ee3bac417358c45622f876e78886ec4dc95cde6aaa");
assert.equal(pin.binaries["containerd-shim-runc-v2"].inputSha256, "d144d1270e60e580bff38510f3a38b3cc94d10a7efe7fb1f9839b4faba383a51");
assert.deepEqual(pin.binaries.dockerd.replacements, { "/run/containerd": 3, "/run/docker/plugins": 1, "/run/docker/metrics.sock": 1 });
assert.deepEqual(pin.binaries.containerd.replacements, { "/run/containerd": 3 });
assert.deepEqual(pin.binaries["containerd-shim-runc-v2"].replacements, { "/run/containerd": 2 });
for (const name of ["docker", "runc", "docker-init", "docker-proxy", "ctr"]) {
  assert.deepEqual(pin.binaries[name].replacements, {}, `${name} is installed unmodified`);
  assert.equal(pin.binaries[name].inputSha256, pin.binaries[name].sha256, `${name} input equals output`);
  assert.match(pin.binaries[name].sha256, /^[0-9a-f]{64}$/);
}
for (const entry of Object.values(pin.binaries)) {
  assert.match(entry.inputSha256, /^[0-9a-f]{64}$/);
  assert.match(entry.sha256, /^[0-9a-f]{64}$/);
  assert.equal(typeof entry.size, "number");
}
assert.deepEqual(Object.fromEntries(Object.entries(pin.components).map(([name, entry]) => [name, entry.version])), {
  moby: "29.8.0",
  "docker-cli": "29.8.0",
  containerd: "2.3.4",
  runc: "1.5.1",
  tini: "0.19.0",
});

// ---- Synthetic tarball exercising the patcher end to end.
function applyRules(buffer, rules) {
  let text = buffer.toString("latin1");
  const counts = {};
  for (const rule of rules) {
    counts[rule.from] = text.split(rule.from).length - 1;
    text = text.split(rule.from).join(rule.to);
  }
  return { patched: Buffer.from(text, "latin1"), counts };
}

const originals = {
  dockerd: Buffer.from("A/run/containerd\0B/run/docker/plugins\0C/run/docker/metrics.sock\0D/run/containerd/fifo\0E/var/run/docker.sock\0", "latin1"),
  containerd: Buffer.from("/run/containerd/x\0/run/containerd/y\0", "latin1"),
  "containerd-shim-runc-v2": Buffer.from("shim /run/containerd\0", "latin1"),
  docker: Buffer.from("cli bytes untouched /run/containerd\0", "latin1"),
};
const sourceDir = path.join(temporaryRoot, "src", "docker");
fs.mkdirSync(sourceDir, { recursive: true });
for (const [name, bytes] of Object.entries(originals)) {
  fs.writeFileSync(path.join(sourceDir, name), bytes, { mode: 0o755 });
}
const tarball = path.join(temporaryRoot, "docker-test.tgz");
const tar = spawnSync("tar", ["-czf", tarball, "-C", path.join(temporaryRoot, "src"), "docker"], { encoding: "utf8" });
assert.equal(tar.status, 0, tar.stderr);
const tarballBytes = fs.readFileSync(tarball);

const binaries = {};
for (const [name, bytes] of Object.entries(originals)) {
  const rules = name === "docker" ? [] : pin.rules;
  const { patched, counts } = applyRules(bytes, rules);
  binaries[name] = {
    size: bytes.length,
    inputSha256: sha256(bytes),
    replacements: rules.length ? counts : {},
    sha256: sha256(patched),
    expectedBytes: patched,
  };
}
assert.deepEqual(binaries.dockerd.replacements, { "/run/containerd": 2, "/run/docker/plugins": 1, "/run/docker/metrics.sock": 1 });

function writePin(name, overrides = {}) {
  const document = {
    engine: { version: "test", tarball: { url: "https://example.invalid/docker-test.tgz", size: tarballBytes.length, sha256: sha256(tarballBytes) } },
    rules: pin.rules,
    binaries: Object.fromEntries(Object.entries(binaries).map(([key, value]) => [key, {
      size: value.size,
      inputSha256: value.inputSha256,
      replacements: value.replacements,
      sha256: value.sha256,
    }])),
    ...overrides,
  };
  const file = path.join(temporaryRoot, name);
  fs.writeFileSync(file, JSON.stringify(document, null, 2) + "\n");
  return file;
}

function run(args) {
  return spawnSync(tool, args, { cwd: temporaryRoot, encoding: "utf8" });
}

const outDir = path.join(temporaryRoot, "out");
const ok = run(["--engine", writePin("pin.json"), "--tarball", tarball, "--out", outDir]);
assert.equal(ok.status, 0, ok.stderr);
for (const [name, entry] of Object.entries(binaries)) {
  const file = path.join(outDir, name);
  assert.deepEqual(fs.readFileSync(file), entry.expectedBytes, `${name} bytes`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o755, `${name} mode`);
  assert.match(ok.stdout, new RegExp(`^${entry.sha256}  ${name}$`, "m"));
}
assert.deepEqual(fs.readdirSync(outDir).sort(), Object.keys(binaries).sort(), "no extra files");
assert.equal(run(["--engine", writePin("pin.json"), "--tarball", tarball, "--out", outDir]).status, 1, "refuse to overwrite an existing output directory");

// Refusals write nothing.
function refused(pinFile, pattern, tarballPath = tarball) {
  const dir = path.join(temporaryRoot, "refused-" + path.basename(pinFile, ".json"));
  const result = run(["--engine", pinFile, "--tarball", tarballPath, "--out", dir]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, pattern);
  assert.equal(fs.existsSync(dir) && fs.readdirSync(dir).length > 0, false, "refusal must leave no output");
}
const badTarball = { engine: { version: "test", tarball: { url: "x", size: tarballBytes.length, sha256: "00".repeat(32) } } };
refused(writePin("bad-tarball.json", badTarball), /tarball sha256 mismatch/);
const badSize = { engine: { version: "test", tarball: { url: "x", size: tarballBytes.length + 1, sha256: sha256(tarballBytes) } } };
refused(writePin("bad-size.json", badSize), /tarball size mismatch/);
refused(writePin("bad-rule.json", { rules: [{ from: "/run/containerd", to: "/dev/containerd-longer" }] }), /rule changes length/);
const badCount = writePin("bad-count.json", {
  binaries: { ...Object.fromEntries(Object.entries(binaries).map(([k, v]) => [k, { size: v.size, inputSha256: v.inputSha256, replacements: v.replacements, sha256: v.sha256 }])), dockerd: { ...binaries.dockerd, replacements: { ...binaries.dockerd.replacements, "/run/containerd": 9 } } },
});
refused(badCount, /replacement count mismatch for dockerd/);
const badInputHash = writePin("bad-input-hash.json", {
  binaries: { ...Object.fromEntries(Object.entries(binaries).map(([k, v]) => [k, { size: v.size, inputSha256: v.inputSha256, replacements: v.replacements, sha256: v.sha256 }])), containerd: { ...binaries.containerd, inputSha256: "33".repeat(32) } },
});
refused(badInputHash, /input sha256 mismatch for containerd/);
const badHash = writePin("bad-hash.json", {
  binaries: { ...Object.fromEntries(Object.entries(binaries).map(([k, v]) => [k, { size: v.size, inputSha256: v.inputSha256, replacements: v.replacements, sha256: v.sha256 }])), containerd: { size: binaries.containerd.size, inputSha256: binaries.containerd.inputSha256, replacements: binaries.containerd.replacements, sha256: "11".repeat(32) } },
});
refused(badHash, /output sha256 mismatch for containerd/);
const missing = writePin("missing.json", {
  binaries: { ...Object.fromEntries(Object.entries(binaries).map(([k, v]) => [k, { size: v.size, inputSha256: v.inputSha256, replacements: v.replacements, sha256: v.sha256 }])), "docker-proxy": { size: 1, inputSha256: "22".repeat(32), replacements: {}, sha256: "22".repeat(32) } },
});
refused(missing, /docker\/docker-proxy not in tarball/);

// A replacements map naming a string that is not a rule is refused.
const bogusKey = writePin("bogus-key.json", {
  binaries: { ...Object.fromEntries(Object.entries(binaries).map(([k, v]) => [k, { size: v.size, inputSha256: v.inputSha256, replacements: v.replacements, sha256: v.sha256 }])), dockerd: { ...binaries.dockerd, replacements: { ...binaries.dockerd.replacements, "/bogus": 7 } } },
});
refused(bogusKey, /name strings that are not rules/);

// A pin and tarball cannot use member names to escape the new output
// directory, and names that collide by case are ambiguous on common hosts.
const escapedBytes = Buffer.from("verified escaped member fixture\n");
const escapedTarball = path.join(temporaryRoot, "escaped-name.tgz");
const escapedArchive = spawnSync("python3", ["-c", `
import io, sys, tarfile
data = sys.stdin.buffer.read()
with tarfile.open(sys.argv[1], "w:gz") as archive:
    member = tarfile.TarInfo("docker/../escaped")
    member.size = len(data)
    member.mode = 0o755
    archive.addfile(member, io.BytesIO(data))
`, escapedTarball], { input: escapedBytes });
assert.equal(escapedArchive.status, 0, escapedArchive.stderr?.toString());
const escapedTarballBytes = fs.readFileSync(escapedTarball);
const escapedPin = writePin("escaped-name.json", {
  engine: { version: "test", tarball: { url: "x", size: escapedTarballBytes.length, sha256: sha256(escapedTarballBytes) } },
  rules: [],
  binaries: {
    "../escaped": {
      size: escapedBytes.length,
      inputSha256: sha256(escapedBytes),
      replacements: {},
      sha256: sha256(escapedBytes),
    },
  },
});
const escapedSentinel = path.join(temporaryRoot, "escaped");
fs.writeFileSync(escapedSentinel, "sentinel must remain\n");
const escapedOutput = path.join(temporaryRoot, "escaped-output");
const escapedResult = run(["--engine", escapedPin, "--tarball", escapedTarball, "--out", escapedOutput]);
assert.equal(escapedResult.status, 1, escapedResult.stdout + escapedResult.stderr);
assert.match(escapedResult.stderr, /unsafe binary name/);
assert.equal(fs.readFileSync(escapedSentinel, "utf8"), "sentinel must remain\n");
assert.equal(fs.existsSync(escapedOutput), false);

const caseCollision = writePin("case-collision.json", {
  binaries: {
    ...Object.fromEntries(Object.entries(binaries).map(([k, v]) => [k, { size: v.size, inputSha256: v.inputSha256, replacements: v.replacements, sha256: v.sha256 }])),
    Docker: { size: binaries.docker.size, inputSha256: binaries.docker.inputSha256, replacements: {}, sha256: binaries.docker.sha256 },
  },
});
refused(caseCollision, /case-insensitive binary name collision/);

// The download path, through a file:// URL: the cache is created 0700, the
// tarball lands under its URL basename with no .part left, and a second run
// reuses it without touching the URL.
const cacheDir = path.join(temporaryRoot, "cache");
const fileUrl = "file://" + tarball;
const downloadPin = writePin("download.json", {
  engine: { version: "test", tarball: { url: fileUrl, size: tarballBytes.length, sha256: sha256(tarballBytes) } },
});

// An existing owner-controlled cache can remain conventionally readable and
// searchable. Only group or other write permission makes it unsafe.
const readableCache = path.join(temporaryRoot, "readable-cache");
fs.mkdirSync(readableCache, { mode: 0o755 });
fs.chmodSync(readableCache, 0o755);
const readableCacheOutput = path.join(temporaryRoot, "readable-cache-output");
const readableCacheResult = run(["--engine", downloadPin, "--download", "--cache", readableCache, "--out", readableCacheOutput]);
assert.equal(readableCacheResult.status, 0, readableCacheResult.stderr);
assert.equal(fs.statSync(readableCache).mode & 0o777, 0o755);

const readOnlyCache = path.join(temporaryRoot, "read-only-cache");
fs.mkdirSync(readOnlyCache, { mode: 0o555 });
fs.chmodSync(readOnlyCache, 0o555);
const readOnlyOutput = path.join(temporaryRoot, "read-only-output");
const readOnlyResult = run(["--engine", downloadPin, "--download", "--cache", readOnlyCache, "--out", readOnlyOutput]);
assert.equal(readOnlyResult.status, 1, readOnlyResult.stdout + readOnlyResult.stderr);
assert.match(readOnlyResult.stderr, /cannot create temporary download in cache/);
assert.doesNotMatch(readOnlyResult.stderr, /Traceback/);
assert.equal(fs.existsSync(readOnlyOutput), false);

const groupWritableCache = path.join(temporaryRoot, "group-writable-cache");
fs.mkdirSync(groupWritableCache, { mode: 0o775 });
fs.chmodSync(groupWritableCache, 0o775);
const groupWritableOutput = path.join(temporaryRoot, "group-writable-output");
const groupWritableResult = run(["--engine", downloadPin, "--download", "--cache", groupWritableCache, "--out", groupWritableOutput]);
assert.equal(groupWritableResult.status, 1, groupWritableResult.stdout + groupWritableResult.stderr);
assert.match(groupWritableResult.stderr, /not writable by group or other/);
assert.equal(fs.existsSync(groupWritableOutput), false);

const sidecarCache = path.join(temporaryRoot, "sidecar-cache");
fs.mkdirSync(sidecarCache, { mode: 0o700 });
const sidecarSentinel = path.join(temporaryRoot, "sidecar-sentinel");
fs.writeFileSync(sidecarSentinel, "sentinel must remain\n");
const predictableSidecar = path.join(sidecarCache, path.basename(tarball) + ".part");
fs.symlinkSync(sidecarSentinel, predictableSidecar);
const sidecarOutput = path.join(temporaryRoot, "sidecar-output");
const ignoredSidecar = run(["--engine", downloadPin, "--download", "--cache", sidecarCache, "--out", sidecarOutput]);
assert.equal(ignoredSidecar.status, 0, ignoredSidecar.stderr);
assert.equal(fs.readFileSync(sidecarSentinel, "utf8"), "sentinel must remain\n");
assert.equal(fs.lstatSync(predictableSidecar).isSymbolicLink(), true);
assert.equal(fs.readlinkSync(predictableSidecar), sidecarSentinel);
assert.equal(fs.lstatSync(path.join(sidecarCache, path.basename(tarball))).isFile(), true);

const finalLinkCache = path.join(temporaryRoot, "final-link-cache");
fs.mkdirSync(finalLinkCache, { mode: 0o700 });
const finalCacheEntry = path.join(finalLinkCache, path.basename(tarball));
fs.symlinkSync(tarball, finalCacheEntry);
const finalLinkOutput = path.join(temporaryRoot, "final-link-output");
const finalLinkResult = run(["--engine", downloadPin, "--download", "--cache", finalLinkCache, "--out", finalLinkOutput]);
assert.equal(finalLinkResult.status, 1, finalLinkResult.stdout + finalLinkResult.stderr);
assert.match(finalLinkResult.stderr, /cached tarball is not a regular file/);
assert.equal(fs.lstatSync(finalCacheEntry).isSymbolicLink(), true);
assert.equal(fs.existsSync(finalLinkOutput), false);

const badDownloadPin = writePin("bad-download.json", {
  engine: { version: "test", tarball: { url: fileUrl, size: tarballBytes.length, sha256: "00".repeat(32) } },
});
const badDownloadCache = path.join(temporaryRoot, "bad-download-cache");
const badDownloadOutput = path.join(temporaryRoot, "bad-download-output");
const badDownload = run(["--engine", badDownloadPin, "--download", "--cache", badDownloadCache, "--out", badDownloadOutput]);
assert.equal(badDownload.status, 1, badDownload.stdout + badDownload.stderr);
assert.match(badDownload.stderr, /tarball sha256 mismatch/);
assert.deepEqual(fs.readdirSync(badDownloadCache), [], "unverified downloads must not be published");
assert.equal(fs.existsSync(badDownloadOutput), false);

const downloaded = run(["--engine", downloadPin, "--download", "--cache", cacheDir, "--out", path.join(temporaryRoot, "dl-out")]);
assert.equal(downloaded.status, 0, downloaded.stderr);
assert.equal(fs.statSync(cacheDir).mode & 0o777, 0o700);
assert.deepEqual(fs.readdirSync(cacheDir), [path.basename(tarball)]);
assert.deepEqual(fs.readFileSync(path.join(cacheDir, path.basename(tarball))), tarballBytes);
fs.unlinkSync(tarball);
const reused = run(["--engine", downloadPin, "--download", "--cache", cacheDir, "--out", path.join(temporaryRoot, "dl-out-2")]);
assert.equal(reused.status, 0, reused.stderr);
fs.writeFileSync(tarball, tarballBytes);
assert.equal(run(["--engine", downloadPin, "--download", "--tarball", tarball, "--cache", cacheDir, "--out", path.join(temporaryRoot, "x")]).status, 2, "--tarball and --download are exclusive");
assert.equal(run(["--engine", downloadPin, "--download", "--out", path.join(temporaryRoot, "y")]).status, 2, "--download needs --cache");

// Usage: a tarball or a download cache is required; exit 2.
assert.equal(run(["--engine", writePin("pin.json"), "--out", path.join(temporaryRoot, "u")]).status, 2);
assert.equal(run([]).status, 2);

fs.rmSync(temporaryRoot, { recursive: true, force: true });
