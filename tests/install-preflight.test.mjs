import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  makeBootImage,
  patternBytes,
  sha256,
} from "./helpers/boot-image-fixture.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const preflightSource = fs.readFileSync(path.join(projectRoot, "module", "bin", "install-preflight"), "utf8");
const buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), "install-preflight-build-"));
process.on("exit", () => fs.rmSync(buildRoot, { recursive: true, force: true }));
const hostSwap = path.join(buildRoot, "swap-boot-kernel");
const compilation = spawnSync("cc", [
  "-std=c99", "-Wall", "-Wextra", "-Werror", "-O2", "-o", hostSwap,
  path.join(projectRoot, "tools", "swap-boot-kernel.c"),
], { encoding: "utf8", timeout: 30_000 });
assert.ifError(compilation.error);
assert.equal(compilation.signal, null);
assert.equal(compilation.status, 0, compilation.stderr);

const runtimeNames = [
  "containerd",
  "containerd-shim-runc-v2",
  "ctr",
  "docker",
  "docker-init",
  "docker-proxy",
  "dockerd",
  "runc",
];
const buildId = "TEST.1";
const fingerprint = "google/kodiak/kodiak:17/TEST.1/123:user/release-keys";
const kernelRelease = "6.12.69-test";
const rules = [
  ["/run/containerd", "/dev/containerd"],
  ["/run/docker/plugins", "/dev/docker/plugins"],
  ["/run/docker/metrics.sock", "/dev/docker/metrics.sock"],
];
const stockKernel = patternBytes(5000, 0x1010);
const currentKernel = patternBytes(6000, 0x2020);
const tail = patternBytes(4096, 0x3030);
const stockBoot = makeBootImage({ kernel: stockKernel, tail });
const currentBoot = makeBootImage({ kernel: currentKernel, tail });

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function writeExecutable(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, { mode: 0o755 });
}

function hashFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function installerInputs() {
  const rows = [
    "INSTALLER_INPUTS_VERSION=1",
    "MODULE\t0.1.0-dev\t1",
    `ENGINE\t29.8.0\tdocker-29.8.0.tgz\t77727467\t${"1".repeat(64)}\thttps://download.docker.com/linux/static/stable/aarch64/docker-29.8.0.tgz`,
    ...rules.map(([from, to], index) => `RULE\t${index}\t${from}\t${to}`),
  ];
  for (const name of runtimeNames) {
    const counts = name === "dockerd" ? [3, 1, 1]
      : name === "containerd" ? [3, 0, 0]
        : name === "containerd-shim-runc-v2" ? [2, 0, 0]
          : [0, 0, 0];
    rows.push([
      "BINARY", name, 100, "2".repeat(64), "3".repeat(64),
      counts.some((value) => value > 0) ? 1 : 0,
      ...counts,
    ].join("\t"));
  }
  rows.push([
    "BUILD", buildId, "kodiak", fingerprint, 17, "2026-08-05", kernelRelease,
    stockBoot.length, 4096, 4, 1584, 0, `Image-${buildId}.lz4`,
  ].join("\t"));
  rows.push(`KSU\t${buildId}\tlkm\t3.3.0`);
  rows.push([
    "BOOT_STATE", buildId, "current-public", currentKernel.length,
    sha256(currentKernel), currentBoot.length, sha256(currentBoot),
  ].join("\t"));
  rows.push([
    "BOOT_STATE", buildId, "stock", stockKernel.length,
    sha256(stockKernel), stockBoot.length, sha256(stockBoot),
  ].join("\t"));
  return `${rows.join("\n")}\n`;
}

function makeFixture({ state = "stock" } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "install-preflight-")));
  const moduleDir = path.join(root, "module");
  const binDir = path.join(moduleDir, "bin");
  const systemBin = path.join(root, "system-bin");
  const deviceRoot = path.join(root, "devices");
  const stateDir = path.join(root, "state");
  const calls = path.join(stateDir, "calls");
  const boot = path.join(deviceRoot, "boot_b");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(systemBin);
  fs.mkdirSync(deviceRoot);
  fs.mkdirSync(stateDir);
  fs.writeFileSync(boot, state === "current-public" ? currentBoot : stockBoot);
  fs.writeFileSync(path.join(moduleDir, "installer-inputs.tsv"), installerInputs());
  for (const [name, value] of Object.entries({
    device: "kodiak",
    fingerprint,
    android: "17",
    patch: "2026-08-05",
    kernel: kernelRelease,
    suffix: "_b",
    slot: "1",
  })) fs.writeFileSync(path.join(stateDir, name), `${value}\n`);

  const fakeBusybox = path.join(root, "busybox");
  writeExecutable(fakeBusybox, `#!/bin/sh
STATE=${shellQuote(stateDir)}
CALLS=${shellQuote(calls)}
APPLET=\${1:-}
shift || exit 1
printf 'busybox:%s' "$APPLET" >> "$CALLS"
for ARG in "$@"; do printf ' %s' "$ARG" >> "$CALLS"; done
printf '\n' >> "$CALLS"
case "$APPLET" in
  id) [ "$#" -eq 1 ] && [ "$1" = -u ] && printf '0\n' ;;
  cat) exec /bin/cat "$@" ;;
  stat)
    [ "$#" -eq 3 ] && [ "$1" = -c ] && [ "$2" = %s ] || exit 2
    /usr/bin/wc -c < "$3" | /usr/bin/tr -d ' '
    ;;
  uname) [ "$#" -eq 1 ] && [ "$1" = -r ] && /bin/cat "$STATE/kernel" ;;
  awk)
    COUNT=0
    [ ! -f "$STATE/awk-count" ] || COUNT=$(/bin/cat "$STATE/awk-count")
    COUNT=$((COUNT + 1))
    printf '%s\n' "$COUNT" > "$STATE/awk-count"
    /usr/bin/awk "$@"
    STATUS=$?
    if [ "$COUNT" -eq 1 ] && [ -f "$STATE/replace-manifest-after-first-awk" ]; then
      /bin/cp "$STATE/replacement-manifest" ${shellQuote(path.join(moduleDir, "installer-inputs.tsv"))}
    fi
    exit "$STATUS"
    ;;
  sha256sum)
    [ "$#" -eq 1 ] || exit 2
    if [ -x /usr/bin/sha256sum ]; then
      HASH=$(/usr/bin/sha256sum "$1") || exit 1
      HASH=\${HASH%% *}
    else
      HASH=$(/usr/bin/openssl dgst -sha256 -r "$1") || exit 1
      HASH=\${HASH%% *}
    fi
    printf '%s  %s\n' "$HASH" "$1"
    case "$1" in
      */devices/boot_b)
        COUNT=0
        [ ! -f "$STATE/boot-hash-count" ] || COUNT=$(/bin/cat "$STATE/boot-hash-count")
        COUNT=$((COUNT + 1))
        printf '%s\n' "$COUNT" > "$STATE/boot-hash-count"
        if [ "$COUNT" -eq 1 ] && [ -f "$STATE/replace-boot-after-first-hash" ]; then
          /bin/cp "$STATE/replacement-boot" "$1"
        fi
        ;;
    esac
    ;;
  *) printf 'unsupported fake BusyBox applet: %s\n' "$APPLET" >&2; exit 2 ;;
esac
`);

  writeExecutable(path.join(systemBin, "getprop"), `#!/bin/sh
STATE=${shellQuote(stateDir)}
printf 'system:getprop %s\n' "$*" >> ${shellQuote(calls)}
case "\${1:-}" in
  ro.product.device) exec /bin/cat "$STATE/device" ;;
  ro.build.fingerprint) exec /bin/cat "$STATE/fingerprint" ;;
  ro.build.version.release) exec /bin/cat "$STATE/android" ;;
  ro.build.version.security_patch) exec /bin/cat "$STATE/patch" ;;
  ro.boot.slot_suffix) exec /bin/cat "$STATE/suffix" ;;
  *) exit 2 ;;
esac
`);
  writeExecutable(path.join(systemBin, "bootctl"), `#!/bin/sh
printf 'system:bootctl %s\n' "$*" >> ${shellQuote(calls)}
[ "$#" -eq 1 ] && [ "$1" = get-current-slot ] || exit 2
exec /bin/cat ${shellQuote(path.join(stateDir, "slot"))}
`);
  writeExecutable(path.join(systemBin, "blockdev"), `#!/bin/sh
printf 'system:blockdev %s\n' "$*" >> ${shellQuote(calls)}
[ "$#" -eq 2 ] && [ "$1" = --getsize64 ] || exit 2
/usr/bin/wc -c < "$2" | /usr/bin/tr -d ' '
`);
  const swapWrapper = path.join(binDir, "swap-boot-kernel");
  writeExecutable(swapWrapper, `#!/bin/sh
printf 'swap:%s\n' "$*" >> ${shellQuote(calls)}
[ "$#" -eq 2 ] && [ "$1" = --print-kernel-sha256 ] || exit 91
if [ -f ${shellQuote(path.join(stateDir, "payload-override"))} ]; then
  exec /bin/cat ${shellQuote(path.join(stateDir, "payload-override"))}
fi
exec ${shellQuote(hostSwap)} "$@"
`);

  let runnable = preflightSource;
  for (const [from, to] of [
    ["#!/system/bin/sh", "#!/bin/sh"],
    ["BUSYBOX=/data/adb/ksu/bin/busybox", `BUSYBOX=${shellQuote(fakeBusybox)}`],
    ["SYSTEM_BIN=/system/bin", `SYSTEM_BIN=${shellQuote(systemBin)}`],
    ["BOOT_DEVICE_ROOT=/dev/block/by-name", `BOOT_DEVICE_ROOT=${shellQuote(deviceRoot)}`],
    ['  [ -b "$1" ]', '  [ -f "$1" ]'],
  ]) {
    assert.ok(runnable.includes(from), `missing fixture rewrite: ${from}`);
    runnable = runnable.replace(from, to);
  }
  const preflight = path.join(binDir, "install-preflight");
  writeExecutable(preflight, runnable);
  return { root, moduleDir, stateDir, calls, boot, preflight };
}

function run(item, overrides = {}, ...args) {
  const result = spawnSync("/bin/sh", [item.preflight, ...args], {
    encoding: "utf8",
    // The full suite runs several shell-heavy fake-root files concurrently.
    // Keep the timeout above that expected scheduler contention while every
    // focused preflight assertion still completes in a few seconds.
    timeout: 30_000,
    env: {
      ...process.env,
      KSU: "true",
      BOOTMODE: "true",
      ARCH: "arm64",
      KSU_VER: "v3.3.0",
      KSU_VER_CODE: "33214",
      KSU_RUNTIME_MODE: "lkm",
      ...overrides,
    },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, "preflight must exit normally rather than by signal");
  assert.equal(typeof result.status, "number", "preflight must produce an exit status");
  return result;
}

function removeFixture(item) {
  fs.rmSync(item.root, { recursive: true, force: true });
}

function writeState(item, name, value) {
  fs.writeFileSync(path.join(item.stateDir, name), `${value}\n`);
}

function snapshot(item) {
  // The fake platform tools record calls and two read counters. Everything
  // else in the fixture is protected so an arbitrary write, removal, link, or
  // mode change fails the read-only assertion.
  const ignored = new Set([
    "state/calls",
    "state/awk-count",
    "state/boot-hash-count",
  ]);
  const entries = [];

  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const relative = path.relative(item.root, file);
      if (ignored.has(relative)) continue;
      const status = fs.lstatSync(file);
      const record = {
        file: relative,
        inode: status.ino,
        mode: status.mode & 0o777,
        type: status.isDirectory() ? "directory"
          : status.isFile() ? "file"
            : status.isSymbolicLink() ? "symlink"
              : "other",
      };
      if (!status.isDirectory()) record.size = status.size;
      if (status.isFile()) record.hash = hashFile(file);
      if (status.isSymbolicLink()) record.target = fs.readlinkSync(file);
      entries.push(record);
      if (status.isDirectory()) visit(file);
    }
  }

  visit(item.root);
  return entries;
}

test("preflight recognizes exact stock and current-public boot pairs without mutation", () => {
  for (const state of ["stock", "current-public"]) {
    const item = makeFixture({ state });
    try {
      const before = snapshot(item);
      const result = run(item);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        result.stdout,
        `INSTALL_PREFLIGHT_VERSION=1\nmodule_version=0.1.0-dev\nbuild_id=${buildId}\nslot_suffix=_b\nboot_state=${state}\ninstaller_inputs_sha256=${hashFile(path.join(item.moduleDir, "installer-inputs.tsv"))}\n`,
      );
      assert.deepEqual(snapshot(item), before);
      const calls = fs.readFileSync(item.calls, "utf8");
      assert.match(calls, /swap:--print-kernel-sha256 /);
      assert.doesNotMatch(calls, /curl|wget|mount|fsync|\bdd\b|busybox:(mkdir|chmod|chown|cp|mv|rm|ln)/);
      assert.equal((calls.match(/^system:blockdev /gm) ?? []).length, 2);
      assert.equal((calls.match(/^busybox:sha256sum .*\/boot_b$/gm) ?? []).length, 2);
    } finally {
      removeFixture(item);
    }
  }
});

test("explicit runtime preflight omits only installer-only BOOTMODE and ARCH gates", () => {
  const item = makeFixture();
  try {
    const before = snapshot(item);
    const result = run(item, { BOOTMODE: "", ARCH: "" }, "--runtime");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^INSTALL_PREFLIGHT_VERSION=1\n/);
    assert.ok(result.stdout.includes(`build_id=${buildId}\n`));
    assert.match(result.stdout, /boot_state=stock\n/);
    assert.deepEqual(snapshot(item), before);
  } finally {
    removeFixture(item);
  }
});

test("default installer preflight still requires BOOTMODE and arm64 ARCH", () => {
  for (const [overrides, expected] of [
    [{ BOOTMODE: "" }, /installation from a contract-compatible manager is required/],
    [{ ARCH: "" }, /unsupported architecture/],
  ]) {
    const item = makeFixture();
    try {
      const before = snapshot(item);
      const result = run(item, overrides);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expected);
      assert.deepEqual(snapshot(item), before);
    } finally {
      removeFixture(item);
    }
  }
});

for (const [label, environment, stateName, stateValue, expected] of [
  ["missing runtime mode", { KSU_RUNTIME_MODE: "" }, null, null, /runtime mode must be lkm/],
  ["wrong runtime mode", { KSU_RUNTIME_MODE: "built-in" }, null, null, /runtime mode must be lkm/],
  ["untested KernelSU version", { KSU_VER: "v3.3.1" }, null, null, /do not authorize this device/],
  ["wrong architecture", { ARCH: "x86_64" }, null, null, /unsupported architecture/],
  ["wrong device", {}, "device", "other", /do not authorize this device/],
  ["wrong fingerprint", {}, "fingerprint", `${fingerprint}-changed`, /do not authorize this device/],
  ["leading-zero Android version", {}, "android", "017", /Android version has an invalid form/],
  ["wrong security patch", {}, "patch", "2026-09-05", /do not authorize this device/],
  ["wrong kernel", {}, "kernel", "6.12.69-other", /do not authorize this device/],
  ["slot disagreement", {}, "slot", "0", /slot suffix and bootctl index disagree/],
]) {
  test(`preflight refuses ${label}`, () => {
    const item = makeFixture();
    try {
      if (stateName) writeState(item, stateName, stateValue);
      const before = snapshot(item);
      const result = run(item, environment);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expected);
      assert.deepEqual(snapshot(item), before);
    } finally {
      removeFixture(item);
    }
  });
}

test("preflight requires one paired full-partition and payload identity", () => {
  for (const [fullState, payload] of [
    ["stock", currentKernel],
    ["current-public", stockKernel],
  ]) {
    const item = makeFixture({ state: fullState });
    try {
      fs.writeFileSync(
        path.join(item.stateDir, "payload-override"),
        `${payload.length} ${sha256(payload)}\n`,
      );
      const before = snapshot(item);
      const result = run(item);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /not one authorized pair/);
      assert.deepEqual(snapshot(item), before);
    } finally {
      removeFixture(item);
    }
  }
});

test("preflight refuses an altered tail even when the kernel payload is authorized", () => {
  const item = makeFixture();
  try {
    const altered = Buffer.from(fs.readFileSync(item.boot));
    altered[altered.length - 1] ^= 0xff;
    fs.writeFileSync(item.boot, altered);
    const before = snapshot(item);
    const result = run(item);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not one authorized pair/);
    assert.deepEqual(snapshot(item), before);
  } finally {
    removeFixture(item);
  }
});

test("preflight detects boot state changing between its independent reads", () => {
  const item = makeFixture();
  try {
    fs.writeFileSync(path.join(item.stateDir, "replace-boot-after-first-hash"), "yes\n");
    fs.writeFileSync(path.join(item.stateDir, "replacement-boot"), currentBoot);
    const result = run(item);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /changed during inspection/);
  } finally {
    removeFixture(item);
  }
});

test("preflight binds installer inputs across both parsing passes", () => {
  const item = makeFixture();
  try {
    const changed = installerInputs().replace(`BOOT_STATE\t${buildId}\tstock`, `BOOT_STATE\t${buildId}\ttampered`);
    fs.writeFileSync(path.join(item.stateDir, "replacement-manifest"), changed);
    fs.writeFileSync(path.join(item.stateDir, "replace-manifest-after-first-awk"), "yes\n");
    const result = run(item);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /inputs changed during build selection/);
  } finally {
    removeFixture(item);
  }
});

for (const [label, mutate] of [
  ["missing final LF", (text) => text.slice(0, -1)],
  ["CRLF", (text) => text.replaceAll("\n", "\r\n")],
  ["a doubled tab", (text) => text.replace("MODULE\t0.1.0-dev\t1", "MODULE\t\t0.1.0-dev\t1")],
  ["an extra field", (text) => text.replace("MODULE\t0.1.0-dev\t1", "MODULE\t0.1.0-dev\t1\textra")],
  ["a non-ASCII field", (text) => text.replace("MODULE\t0.1.0-dev", "MODULE\t0.1.0-dévelop")],
  ["a noncanonical rule index", (text) => text.replace("RULE\t0\t", "RULE\t00\t")],
  ["a different engine origin", (text) => text.replace("https://download.docker.com/", "https://example.invalid/")],
  ["unsorted KSU rows", (text) => text.replace(
    `KSU\t${buildId}\tlkm\t3.3.0`,
    `KSU\t${buildId}\tlkm\t3.4.0\nKSU\t${buildId}\tlkm\t3.3.0`,
  )],
  ["unsorted boot rows", (text) => {
    const lines = text.trimEnd().split("\n");
    const first = lines.findIndex((line) => line.startsWith("BOOT_STATE\t"));
    [lines[first], lines[first + 1]] = [lines[first + 1], lines[first]];
    return `${lines.join("\n")}\n`;
  }],
]) {
  test(`preflight refuses installer inputs with ${label}`, () => {
    const item = makeFixture();
    try {
      const input = path.join(item.moduleDir, "installer-inputs.tsv");
      fs.writeFileSync(input, mutate(fs.readFileSync(input, "utf8")));
      const before = snapshot(item);
      const result = run(item);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /installer inputs/);
      assert.deepEqual(snapshot(item), before);
    } finally {
      removeFixture(item);
    }
  });
}

test("preflight source exposes only installer and explicit read-only runtime inspection", () => {
  assert.doesNotMatch(preflightSource, /\bcurl\b|\bwget\b|\bmount\b|\bchown\b|\bchmod\b|\bmkdir\b|\bmv\b|\brm\b|\bln\b|\bfsync\b/);
  assert.match(preflightSource, /\$SWAP_BOOT_KERNEL --print-kernel-sha256/);
  const item = makeFixture();
  try {
    const result = run(item, {}, "unexpected");
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage: install-preflight \[--runtime\]/);
  } finally {
    removeFixture(item);
  }
});
