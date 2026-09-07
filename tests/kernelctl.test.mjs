import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  expectedSwap,
  makeBootImage,
  patternBytes,
  sha256,
} from "./helpers/boot-image-fixture.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const kernelctlSource = fs.readFileSync(path.join(projectRoot, "module", "bin", "kernelctl"), "utf8");
const preflightSource = fs.readFileSync(path.join(projectRoot, "module", "bin", "install-preflight"), "utf8");
const buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kernelctl-build-"));
process.on("exit", () => fs.rmSync(buildRoot, { recursive: true, force: true }));
const hostSwap = path.join(buildRoot, "swap-boot-kernel");
const compile = spawnSync("cc", [
  "-std=c99", "-Wall", "-Wextra", "-Werror", "-O2", "-o", hostSwap,
  path.join(projectRoot, "tools", "swap-boot-kernel.c"),
], { encoding: "utf8", timeout: 30_000 });
assert.ifError(compile.error);
assert.equal(compile.signal, null);
assert.equal(compile.status, 0, compile.stderr);

const buildId = "TEST.1";
const fingerprint = "google/kodiak/kodiak:17/TEST.1/123:user/release-keys";
const kernelRelease = "6.12.69-test";
const stockKernel = patternBytes(8000, 0x1111);
const publicKernel = patternBytes(6000, 0x2222);
const tail = patternBytes(8192, 0x3333);
const stockBoot = makeBootImage({ kernel: stockKernel, tail });
const publicBoot = expectedSwap(stockBoot, publicKernel);
const runtimeNames = [
  "containerd", "containerd-shim-runc-v2", "ctr", "docker",
  "docker-init", "docker-proxy", "dockerd", "runc",
];

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function writeExecutable(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, { mode: 0o755 });
}

function replaceRequired(source, from, to) {
  assert.ok(source.includes(from), `missing fixture replacement: ${from}`);
  return source.replaceAll(from, to);
}

function inputs() {
  const rows = [
    "INSTALLER_INPUTS_VERSION=1",
    "MODULE\t0.1.0-dev\t1",
    `ENGINE\t29.8.0\tdocker-29.8.0.tgz\t77727467\t${"1".repeat(64)}\thttps://download.docker.com/linux/static/stable/aarch64/docker-29.8.0.tgz`,
    "RULE\t0\t/run/containerd\t/dev/containerd",
    "RULE\t1\t/run/docker/plugins\t/dev/docker/plugins",
    "RULE\t2\t/run/docker/metrics.sock\t/dev/docker/metrics.sock",
  ];
  for (const name of runtimeNames) {
    const counts = name === "dockerd" ? [3, 1, 1]
      : name === "containerd" ? [3, 0, 0]
        : name === "containerd-shim-runc-v2" ? [2, 0, 0]
          : [0, 0, 0];
    rows.push([
      "BINARY", name, 100, "2".repeat(64), "3".repeat(64),
      counts.some((value) => value > 0) ? 1 : 0, ...counts,
    ].join("\t"));
  }
  rows.push([
    "BUILD", buildId, "kodiak", fingerprint, 17, "2026-08-05", kernelRelease,
    stockBoot.length, 4096, 4, 1584, 0, `Image-${buildId}.lz4`,
  ].join("\t"));
  rows.push(`KSU\t${buildId}\tlkm\t3.3.0`);
  rows.push([
    "BOOT_STATE", buildId, "current-public", publicKernel.length,
    sha256(publicKernel), publicBoot.length, sha256(publicBoot),
  ].join("\t"));
  rows.push([
    "BOOT_STATE", buildId, "stock", stockKernel.length,
    sha256(stockKernel), stockBoot.length, sha256(stockBoot),
  ].join("\t"));
  return `${rows.join("\n")}\n`;
}

function makeFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kernelctl-")));
  const moduleDir = path.join(root, "module");
  const binDir = path.join(moduleDir, "bin");
  const dockerRoot = path.join(root, "docker");
  const runRoot = path.join(dockerRoot, "run");
  const kernelRoot = path.join(dockerRoot, "kernel", buildId);
  const devices = path.join(root, "devices");
  const systemBin = path.join(root, "system-bin");
  const state = path.join(root, "state");
  const battery = path.join(root, "battery-capacity");
  const calls = path.join(state, "calls");
  const boot = path.join(devices, "boot_b");
  const installerInputs = path.join(moduleDir, "installer-inputs.tsv");
  const staged = path.join(kernelRoot, "Image.lz4");
  for (const directory of [binDir, runRoot, kernelRoot, devices, systemBin, state]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(boot, stockBoot);
  fs.writeFileSync(staged, publicKernel);
  fs.writeFileSync(battery, "80\n");
  fs.writeFileSync(installerInputs, inputs());
  for (const [name, value] of Object.entries({
    device: "kodiak",
    fingerprint,
    android: "17",
    patch: "2026-08-05",
    kernel: kernelRelease,
    suffix: "_b",
    bootconfig: 'androidboot.hardware = "kodiak"\nandroidboot.slot_suffix = "_b"',
    available: "1000000",
  })) fs.writeFileSync(path.join(state, name), `${value}\n`);

  const busybox = path.join(root, "busybox");
  writeExecutable(busybox, `#!/bin/sh
STATE=${shellQuote(state)}
CALLS=${shellQuote(calls)}
BOOT=${shellQuote(boot)}
INSTALLER_INPUTS=${shellQuote(installerInputs)}
APPLET=\${1:-}
shift || exit 1
printf 'busybox:%s' "$APPLET" >> "$CALLS"
for ARG in "$@"; do printf ' %s' "$ARG" >> "$CALLS"; done
printf '\n' >> "$CALLS"
case "$APPLET" in
  id)
    [ "$#" -eq 1 ] && [ "$1" = -u ] || exit 2
    printf '%s\n' "\${FIXTURE_UID:-0}"
    ;;
  cat) exec /bin/cat "$@" ;;
  uname) [ "$#" -eq 1 ] && [ "$1" = -r ] && exec /bin/cat "$STATE/kernel" ;;
  awk) exec /usr/bin/awk "$@" ;;
  stat)
    [ "$#" -eq 3 ] && [ "$1" = -c ] && [ "$2" = %s ] || exit 2
    /usr/bin/wc -c < "$3" | /usr/bin/tr -d ' '
    ;;
  sha256sum)
    [ "$#" -eq 1 ] || exit 2
    if [ "$1" = - ]; then
      HASH=$(/usr/bin/shasum -a 256) || exit 1
      HASH=\${HASH%% *}
      printf '%s  -\n' "$HASH"
    else
      HASH=$(/usr/bin/shasum -a 256 "$1") || exit 1
      HASH=\${HASH%% *}
      printf '%s  %s\n' "$HASH" "$1"
    fi
    ;;
  df)
    [ "$#" -eq 2 ] && [ "$1" = -Pk ] || exit 2
    printf 'Filesystem 1024-blocks Used Available Capacity Mounted-on\n'
    printf 'fixture 2000000 1 %s 1%% /fixture\n' "$(/bin/cat "$STATE/available")"
    ;;
  dd)
    INPUT=
    OUTPUT=
    for ARG in "$@"; do
      case "$ARG" in if=*) INPUT=\${ARG#if=} ;; of=*) OUTPUT=\${ARG#of=} ;; esac
    done
    [ -n "$INPUT" ] || exit 2
    if [ -z "$OUTPUT" ]; then
      /bin/cat "$INPUT" || exit 1
      case "$INPUT" in
        */boot-backup/*.img)
          if [ -f "$STATE/change-boot-after-backup-read" ] && [ ! -f "$STATE/boot-changed" ]; then
            /bin/cp "$STATE/replacement-boot" "$BOOT" || exit 1
            : > "$STATE/boot-changed"
          fi
          if [ -f "$STATE/change-inputs-after-backup-read" ] && [ ! -f "$STATE/inputs-changed" ]; then
            /bin/cp "$STATE/replacement-inputs" "$INSTALLER_INPUTS" || exit 1
            : > "$STATE/inputs-changed"
          fi
          ;;
      esac
      exit 0
    fi
    if [ "$OUTPUT" = "$BOOT" ] && [ -f "$STATE/fail-restore-dd" ]; then
      /bin/dd if="$INPUT" of="$OUTPUT" bs=4096 count=1 conv=notrunc 2>/dev/null
      exit 5
    fi
    case "$OUTPUT" in
      */.backup.*)
        if [ -f "$STATE/truncate-backup-copy" ]; then
          SIZE=$(/usr/bin/wc -c < "$INPUT" | /usr/bin/tr -d ' ')
          /bin/dd if="$INPUT" of="$OUTPUT" bs=1 count=$((SIZE - 1)) 2>/dev/null
          exit 0
        fi
        ;;
    esac
    exec /bin/cp "$INPUT" "$OUTPUT"
    ;;
  mkdir) exec /bin/mkdir "$@" ;;
  chmod) exec /bin/chmod "$@" ;;
  chown) exit 0 ;;
  fsync) exit 0 ;;
  ln) exec /bin/ln "$@" ;;
  rm) exec /bin/rm "$@" ;;
  rmdir) exec /bin/rmdir "$@" ;;
  *) printf 'unsupported fake BusyBox applet: %s\n' "$APPLET" >&2; exit 90 ;;
esac
`);

  writeExecutable(path.join(systemBin, "getprop"), `#!/bin/sh
STATE=${shellQuote(state)}
case "\${1:-}" in
  ro.product.device) exec /bin/cat "$STATE/device" ;;
  ro.build.fingerprint) exec /bin/cat "$STATE/fingerprint" ;;
  ro.build.version.release) exec /bin/cat "$STATE/android" ;;
  ro.build.version.security_patch) exec /bin/cat "$STATE/patch" ;;
  ro.boot.slot_suffix) exec /bin/cat "$STATE/suffix" ;;
  *) exit 2 ;;
esac
`);
  writeExecutable(path.join(systemBin, "blockdev"), `#!/bin/sh
[ "$#" -eq 2 ] && [ "$1" = --getsize64 ] || exit 2
/usr/bin/wc -c < "$2" | /usr/bin/tr -d ' '
`);
  fs.copyFileSync(hostSwap, path.join(binDir, "swap-boot-kernel"));
  fs.chmodSync(path.join(binDir, "swap-boot-kernel"), 0o755);

  let preflight = preflightSource;
  for (const [from, to] of [
    ["#!/system/bin/sh", "#!/bin/sh"],
    ["BUSYBOX=/data/adb/ksu/bin/busybox", `BUSYBOX=${shellQuote(busybox)}`],
    ["SYSTEM_BIN=/system/bin", `SYSTEM_BIN=${shellQuote(systemBin)}`],
    ["BOOT_CONFIG=/proc/bootconfig", `BOOT_CONFIG=${shellQuote(path.join(state, "bootconfig"))}`],
    ["BOOT_DEVICE_ROOT=/dev/block/by-name", `BOOT_DEVICE_ROOT=${shellQuote(devices)}`],
    ['  [ -b "$1" ]', '  [ -f "$1" ]'],
  ]) preflight = replaceRequired(preflight, from, to);
  writeExecutable(path.join(binDir, "install-preflight"), preflight);

  let kernelctl = kernelctlSource;
  for (const [from, to] of [
    ["#!/system/bin/sh", "#!/bin/sh"],
    ["BUSYBOX=/data/adb/ksu/bin/busybox", `BUSYBOX=${shellQuote(busybox)}`],
    ["BOOT_DEVICE_ROOT=/dev/block/by-name", `BOOT_DEVICE_ROOT=${shellQuote(devices)}`],
    ["BATTERY_CAPACITY=/sys/class/power_supply/battery/capacity", `BATTERY_CAPACITY=${shellQuote(battery)}`],
    ["DOCKER_ROOT=/data/docker", `DOCKER_ROOT=${shellQuote(dockerRoot)}`],
    ['  [ -b "$1" ]', '  [ -f "$1" ]'],
  ]) kernelctl = replaceRequired(kernelctl, from, to);
  const executable = path.join(binDir, "kernelctl");
  writeExecutable(executable, kernelctl);
  return {
    root, moduleDir, dockerRoot, runRoot, state, calls, battery, boot, staged, executable,
    backup: path.join(dockerRoot, "boot-backup", buildId, `${sha256(stockBoot)}_b.img`),
  };
}

function runWithOverrides(item, overrides, ...args) {
  const result = spawnSync("/bin/sh", [item.executable, ...args], {
    encoding: "utf8",
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
  assert.equal(result.signal, null, "kernelctl must exit normally");
  assert.equal(typeof result.status, "number");
  return result;
}

function run(item, ...args) {
  return runWithOverrides(item, {}, ...args);
}

function removeFixture(item) {
  fs.rmSync(item.root, { recursive: true, force: true });
}

function confirm(action) {
  return `${action.toUpperCase()}:${buildId}:_b`;
}

function assertUnchanged(file, before) {
  assert.deepEqual(fs.readFileSync(file), before);
}

test("status reports the exact active boot state and staged image without writing", () => {
  const item = makeFixture();
  try {
    const before = fs.readFileSync(item.boot);
    const result = run(item, "status");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, [
      "KERNELCTL_VERSION=1",
      `build_id=${buildId}`,
      "slot_suffix=_b",
      "boot_state=stock",
      "staged_image=ready",
      "",
    ].join("\n"));
    assertUnchanged(item.boot, before);
    assert.equal(fs.existsSync(path.join(item.dockerRoot, "boot-backup")), false);
  } finally {
    removeFixture(item);
  }
});

test("runtime status does not depend on installer-only BOOTMODE or ARCH", () => {
  const item = makeFixture();
  try {
    const before = fs.readFileSync(item.boot);
    const result = runWithOverrides(item, { BOOTMODE: "", ARCH: "" }, "status");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /boot_state=stock/);
    assertUnchanged(item.boot, before);
  } finally {
    removeFixture(item);
  }
});

test("install requires an exact build-and-active-slot confirmation", () => {
  const item = makeFixture();
  try {
    const before = fs.readFileSync(item.boot);
    for (const token of ["yes", `INSTALL:${buildId}:_a`, "INSTALL:OTHER:_b"]) {
      const result = run(item, "install", token);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /confirmation must bind/);
      assertUnchanged(item.boot, before);
    }
  } finally {
    removeFixture(item);
  }
});

for (const [label, mutate, pattern] of [
  ["wrong bootconfig slot", (item) => fs.writeFileSync(path.join(item.state, "bootconfig"), 'androidboot.slot_suffix = "_a"\n'), /slot suffix and bootconfig disagree/],
  ["wrong partition size", (item) => fs.truncateSync(item.boot, stockBoot.length - 1), /partition size does not match/],
  ["wrong partition identity", (item) => {
    const changed = Buffer.from(stockBoot);
    changed[changed.length - 1] ^= 0xff;
    fs.writeFileSync(item.boot, changed);
  }, /not one authorized pair/],
]) {
  test(`kernel controls refuse ${label} before mutation`, () => {
    const item = makeFixture();
    try {
      mutate(item);
      const before = fs.readFileSync(item.boot);
      const result = run(item, "install", confirm("install"));
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, pattern);
      assertUnchanged(item.boot, before);
      assert.equal(fs.existsSync(path.join(item.dockerRoot, "boot-backup")), false);
    } finally {
      removeFixture(item);
    }
  });
}

test("install rejects an incorrect staged image, low battery, and low free space", () => {
  for (const [mutate, pattern] of [
    [(item) => fs.writeFileSync(item.staged, Buffer.alloc(publicKernel.length, 0x5a)), /staged kernel image is invalid/],
    [(item) => fs.writeFileSync(item.battery, "49\n"), /at least 50 percent/],
    [(item) => fs.writeFileSync(path.join(item.state, "available"), "1\n"), /insufficient free space/],
  ]) {
    const item = makeFixture();
    try {
      mutate(item);
      const before = fs.readFileSync(item.boot);
      const result = run(item, "install", confirm("install"));
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, pattern);
      assertUnchanged(item.boot, before);
    } finally {
      removeFixture(item);
    }
  }
});

test("kernel controls re-run exact device and tested-KernelSU selection", () => {
  for (const [mutate, overrides, pattern] of [
    [(item) => fs.writeFileSync(path.join(item.state, "device"), "other\n"), {}, /do not authorize this device/],
    [() => {}, { KSU_VER: "v3.3.1" }, /do not authorize this device/],
    [() => {}, { KSU_RUNTIME_MODE: "built-in" }, /runtime mode must be lkm/],
  ]) {
    const item = makeFixture();
    try {
      mutate(item);
      const before = fs.readFileSync(item.boot);
      const result = runWithOverrides(item, overrides, "status");
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, pattern);
      assertUnchanged(item.boot, before);
    } finally {
      removeFixture(item);
    }
  }
});

test("install makes one immutable full backup, is idempotent, and restores exactly", () => {
  const item = makeFixture();
  try {
    const installed = run(item, "install", confirm("install"));
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(installed.stdout, /kernel installed/);
    assert.deepEqual(fs.readFileSync(item.boot), publicBoot);
    assert.deepEqual(fs.readFileSync(item.backup), stockBoot);
    const metadata = `${item.backup}.meta`;
    assert.match(fs.readFileSync(metadata, "utf8"), /^KERNEL_BACKUP_VERSION=1\n/);
    assert.match(fs.readFileSync(metadata, "utf8"), new RegExp(`target_public_partition_sha256=${sha256(publicBoot)}\\n$`));
    const backupStat = fs.statSync(item.backup, { bigint: true });
    const metadataStat = fs.statSync(metadata, { bigint: true });

    const again = run(item, "install", confirm("install"));
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /already installed/);
    assert.deepEqual(fs.readFileSync(item.boot), publicBoot);
    assert.equal(fs.statSync(item.backup, { bigint: true }).mtimeNs, backupStat.mtimeNs);
    assert.equal(fs.statSync(metadata, { bigint: true }).mtimeNs, metadataStat.mtimeNs);

    const restored = run(item, "restore", confirm("restore"));
    assert.equal(restored.status, 0, restored.stderr);
    assert.match(restored.stdout, /restored to stock/);
    assert.deepEqual(fs.readFileSync(item.boot), stockBoot);
    assert.deepEqual(fs.readFileSync(item.backup), stockBoot, "restore never consumes the backup");
    assert.equal(fs.existsSync(metadata), true);
  } finally {
    removeFixture(item);
  }
});

test("install recovers an interrupted image-only backup publication before writing", () => {
  const item = makeFixture();
  try {
    fs.mkdirSync(path.dirname(item.backup), { recursive: true });
    fs.writeFileSync(item.backup, stockBoot, { mode: 0o600 });
    assert.equal(fs.existsSync(`${item.backup}.meta`), false);

    const result = run(item, "install", confirm("install"));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readFileSync(item.backup), stockBoot);
    assert.match(fs.readFileSync(`${item.backup}.meta`, "utf8"), /^KERNEL_BACKUP_VERSION=1\n/);
    assert.deepEqual(fs.readFileSync(item.boot), publicBoot);
  } finally {
    removeFixture(item);
  }
});

test("install refuses an unproved image-only backup publication before writing", () => {
  const item = makeFixture();
  try {
    fs.mkdirSync(path.dirname(item.backup), { recursive: true });
    fs.writeFileSync(item.backup, Buffer.alloc(stockBoot.length, 0x5a), { mode: 0o600 });
    const before = fs.readFileSync(item.boot);

    const result = run(item, "install", confirm("install"));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /boot backup identity is wrong/);
    assert.equal(fs.existsSync(`${item.backup}.meta`), false);
    assertUnchanged(item.boot, before);
  } finally {
    removeFixture(item);
  }
});

test("install detects a truncated backup copy before the active partition write", () => {
  const item = makeFixture();
  try {
    fs.writeFileSync(path.join(item.state, "truncate-backup-copy"), "yes\n");
    const before = fs.readFileSync(item.boot);
    const result = run(item, "install", confirm("install"));
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /backup copy is truncated/);
    assertUnchanged(item.boot, before);
  } finally {
    removeFixture(item);
  }
});

test("restore rejects a truncated retained backup before writing", () => {
  const item = makeFixture();
  try {
    assert.equal(run(item, "install", confirm("install")).status, 0);
    fs.truncateSync(item.backup, stockBoot.length - 1);
    const before = fs.readFileSync(item.boot);
    const result = run(item, "restore", confirm("restore"));
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /backup has the wrong size/);
    assertUnchanged(item.boot, before);
  } finally {
    removeFixture(item);
  }
});

test("restore revalidates target and generated inputs after reading the backup", () => {
  for (const mode of ["boot", "inputs"]) {
    const item = makeFixture();
    try {
      assert.equal(run(item, "install", confirm("install")).status, 0);
      if (mode === "boot") {
        const changed = Buffer.from(publicBoot);
        changed[changed.length - 1] ^= 0xff;
        fs.writeFileSync(path.join(item.state, "replacement-boot"), changed);
        fs.writeFileSync(path.join(item.state, "change-boot-after-backup-read"), "yes\n");
      } else {
        fs.writeFileSync(
          path.join(item.state, "replacement-inputs"),
          inputs().replace("MODULE\t0.1.0-dev\t1", "MODULE\t0.1.1-dev\t1"),
        );
        fs.writeFileSync(path.join(item.state, "change-inputs-after-backup-read"), "yes\n");
      }
      const callsBefore = fs.readFileSync(item.calls, "utf8");
      const result = run(item, "restore", confirm("restore"));
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, mode === "boot" ? /active boot preflight refused/ : /kernel context changed/);
      const newCalls = fs.readFileSync(item.calls, "utf8").slice(callsBefore.length);
      assert.equal(newCalls.includes(` of=${item.boot}`), false, "restore dd must not begin");
      assert.deepEqual(fs.readFileSync(item.backup), stockBoot);
    } finally {
      removeFixture(item);
    }
  }
});

test("a restore write failure returns attention status and active-slot fastboot guidance", () => {
  const item = makeFixture();
  try {
    assert.equal(run(item, "install", confirm("install")).status, 0);
    fs.writeFileSync(path.join(item.state, "fail-restore-dd"), "yes\n");
    const result = run(item, "restore", confirm("restore"));
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stderr, /RECOVERY REQUIRED/);
    assert.match(result.stderr, /fastboot flash boot_b <exact-known-good-boot\.img>/);
    assert.notDeepEqual(fs.readFileSync(item.boot), publicBoot, "fault occurs after a partial write");
    assert.deepEqual(fs.readFileSync(item.backup), stockBoot, "recovery failure preserves the backup");
  } finally {
    removeFixture(item);
  }
});

test("root and lifecycle-lock gates refuse before any partition mutation", () => {
  const item = makeFixture();
  try {
    const before = fs.readFileSync(item.boot);
    let result = spawnSync("/bin/sh", [item.executable, "status"], {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        FIXTURE_UID: "2000",
        KSU: "true", BOOTMODE: "true", ARCH: "arm64", KSU_VER: "v3.3.0",
        KSU_VER_CODE: "33214", KSU_RUNTIME_MODE: "lkm",
      },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /root is required/);

    const lock = path.join(item.runRoot, "host-lifecycle.lock");
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "pid"), "99999\n");
    result = run(item, "install", confirm("install"));
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /another lifecycle operation/);
    assertUnchanged(item.boot, before);
  } finally {
    removeFixture(item);
  }
});

test("kernelctl source is active-slot-only and invokes the five-gate swap contract", () => {
  assert.doesNotMatch(kernelctlSource, /init_boot|vbmeta|boot_a|boot_b/);
  for (const gate of [
    "--expect-target-size",
    "--expect-current-sha256",
    "--expect-current-kernel-sha256",
    "--expect-image-sha256",
    "--expect-output-sha256",
  ]) assert.match(kernelctlSource, new RegExp(gate));
  assert.match(kernelctlSource, /iflag=direct/);
  assert.match(kernelctlSource, /conv=fsync/);
  assert.doesNotMatch(kernelctlSource, /rm[^\n]*BACKUP_IMAGE|rm[^\n]*SELECTED_RESTORE_IMAGE/);
});
