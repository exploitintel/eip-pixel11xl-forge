import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import zlib from "node:zlib";

import {
  bootCompletedSource,
  moduleRoot,
  writeExecutable,
} from "./helpers/module-fixture.mjs";

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

const executablePackagePaths = [
  "bin/hostctl",
  "bin/install-host",
  "bin/install-preflight",
  "bin/kernelctl",
  "bin/prepare-engine",
  "bin/prepare-kernel",
  "bin/release-transaction",
  "bin/patch-engine",
  "bin/swap-boot-kernel",
  "bin/privns",
  "bin/route-policy",
  "bin/dockerd.sh",
  "bin/buildkit-runc.sh",
  "action.sh",
  "service.sh",
  "boot-completed.sh",
  "uninstall.sh",
];
const dataPackagePaths = [
  "module.prop",
  "host.conf.default",
  "installer-inputs.tsv",
  "release-manifest.tsv",
];

function copyModuleFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pixel-module-"));
  const staging = path.join(root, "staging");
  const temporary = path.join(root, "installer-tmp");
  const busybox = path.join(root, "busybox");
  fs.cpSync(moduleRoot, staging, { recursive: true });
  fs.mkdirSync(temporary);
  writeExecutable(busybox, `#!/bin/sh
applet=$1
shift
case "$applet" in
  stat)
    [ "$1" = -c ] && [ "$2" = '%u:%g:%a' ] && [ "$#" -eq 3 ] || exit 2
    mode=$(/usr/bin/stat -f '%Lp' "$3") || exit 1
    printf '0:0:%s\\n' "$mode"
    ;;
  *) exit 2 ;;
esac
`);
  const customize = path.join(staging, "customize.sh");
  fs.writeFileSync(
    customize,
    fs.readFileSync(customize, "utf8").replace(
      "BUSYBOX=/data/adb/ksu/bin/busybox",
      `BUSYBOX=${shellQuote(busybox)}`,
    ),
  );
  for (const relative of [...executablePackagePaths, ...dataPackagePaths]) {
    const target = path.join(staging, relative);
    if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${relative}\n`);
    }
  }
  writeExecutable(path.join(staging, "bin", "install-host"), `#!/bin/sh
printf 'install-host\n' >> "$TRACE"
case "\${INSTALL_HOST_RESULT:-0}" in
  0) printf '%s\n' INSTALL_HOST_VERSION=1 result=activated module_version=0.1.0 ;;
  3) printf '%s\n' 'transaction requires attention' >&2; exit 3 ;;
  *) printf '%s\n' 'synthetic install failure' >&2; exit 1 ;;
esac
`);
  for (const relative of [...executablePackagePaths, ...dataPackagePaths]) {
    fs.chmodSync(path.join(staging, relative), 0o644);
  }
  return { root, staging, temporary, trace: path.join(root, "installer.trace") };
}

function waitForFile(file, timeout = 500) {
  const deadline = Date.now() + timeout;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(file) && Date.now() < deadline) Atomics.wait(pause, 0, 0, 10);
  return fs.existsSync(file);
}

function runCustomize(item, overrides = {}) {
  const values = {
    KSU: "true",
    BOOTMODE: "true",
    ARCH: "arm64",
    KSU_VER: "v3.3.0",
    KSU_VER_CODE: "33214",
    KSU_RUNTIME_MODE: "lkm",
    MODPATH: item.staging,
    TMPDIR: item.temporary,
    ...overrides,
  };
  const environment = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)]));
  const runner = `
abort() { printf 'abort=%s\\n' "$1" >> "$TRACE"; exit 73; }
ui_print() { printf 'ui=%s\\n' "$1" >> "$TRACE"; }
  set_perm() {
  printf 'perm=%s:%s:%s:%s\\n' "$1" "$2" "$3" "$4" >> "$TRACE"
  case "\${SET_PERM_BEHAVIOR:-apply}" in
    fail) return 1 ;;
    noop) return 0 ;;
  esac
  chmod "$4" "$1"
}
. ${shellQuote(path.join(item.staging, "customize.sh"))}
printf 'returned\\n' >> "$TRACE"
exit 0
`;
  return spawnSync("/bin/sh", ["-c", runner], {
    encoding: "utf8",
    env: { ...process.env, ...environment, TRACE: item.trace },
    timeout: 10_000,
  });
}

test("module metadata is stable and has no remote update hook", () => {
  const metadata = fs.readFileSync(path.join(moduleRoot, "module.prop"), "utf8");
  const entries = new Map(metadata.trimEnd().split("\n").map((line) => line.split("=", 2)));
  assert.equal(entries.get("id"), "eip-pixel11xl-forge");
  assert.equal(entries.has("updateJson"), false);
  assert.deepEqual([...entries.keys()], ["id", "name", "version", "versionCode", "author", "description"]);
});

test("customize validates the complete package, fixes every mode, and invokes install-host", () => {
  const item = copyModuleFixture();
  try {
    const result = runCustomize(item);
    assert.equal(result.status, 0, result.stderr);
    const trace = fs.readFileSync(item.trace, "utf8");
    assert.equal(
      (trace.match(/^perm=/gm) ?? []).length,
      executablePackagePaths.length + dataPackagePaths.length,
    );
    assert.match(trace, /^install-host$/m);
    assert.match(trace, /ui=- Clean hosts default to autostart off with no Docker disk allocated; existing valid host state is preserved/);
    assert.match(trace, /^returned$/m);
    assert.doesNotMatch(trace, /^abort=/m);
    for (const relative of executablePackagePaths) {
      assert.equal(fs.statSync(path.join(item.staging, relative)).mode & 0o777, 0o755);
    }
    for (const relative of dataPackagePaths) {
      assert.equal(fs.statSync(path.join(item.staging, relative)).mode & 0o777, 0o644);
    }
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test("customize explicitly hands sourced KernelSU variables to install-host", () => {
  const source = fs.readFileSync(path.join(moduleRoot, "customize.sh"), "utf8");
  for (const variable of [
    "KSU", "BOOTMODE", "ARCH", "KSU_VER", "KSU_VER_CODE", "KSU_RUNTIME_MODE", "TMPDIR",
  ]) {
    assert.match(source, new RegExp(`${variable}=\\"\\$${variable}\\"`), variable);
  }
});

for (const [label, overrides, expected] of [
  ["KernelSU", { KSU: "false" }, /KernelSU-Next is required/],
  ["boot mode", { BOOTMODE: "false" }, /manager is required/],
  ["architecture", { ARCH: "x86_64" }, /unsupported architecture/],
  ["runtime mode", { KSU_RUNTIME_MODE: "built-in" }, /runtime mode must be lkm/],
  ["version", { KSU_VER: "" }, /version is unavailable/],
  ["version code", { KSU_VER_CODE: "3.3" }, /version code is unavailable or invalid/],
]) {
  test(`customize rejects invalid ${label} input before changing runtime modes`, () => {
    const item = copyModuleFixture();
    try {
      const result = runCustomize(item, overrides);
      assert.equal(result.status, 73, result.stderr);
      const trace = fs.readFileSync(item.trace, "utf8");
      assert.match(trace, expected);
      assert.doesNotMatch(trace, /^perm=/m);
      assert.equal(fs.statSync(path.join(item.staging, "bin", "hostctl")).mode & 0o777, 0o644);
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });
}

test("customize rejects a missing package file before applying any modes", () => {
  const item = copyModuleFixture();
  try {
    fs.rmSync(path.join(item.staging, "bin", "hostctl"));
    const result = runCustomize(item);
    assert.equal(result.status, 73, result.stderr);
    const trace = fs.readFileSync(item.trace, "utf8");
    assert.match(trace, /missing regular package file/);
    assert.doesNotMatch(trace, /^perm=/m);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

for (const behavior of ["fail", "noop"]) {
  test(`customize aborts when package permissions ${behavior === "fail" ? "fail" : "do not converge"}`, () => {
    const item = copyModuleFixture();
    try {
      const result = runCustomize(item, { SET_PERM_BEHAVIOR: behavior });
      assert.equal(result.status, 73, result.stderr);
      const trace = fs.readFileSync(item.trace, "utf8");
      assert.match(trace, /cannot apply executable package permissions|permissions did not converge/);
      assert.doesNotMatch(trace, /^install-host$/m);
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });
}

for (const [status, expected] of [
  ["1", /host installation failed before a usable module was committed/],
  ["3", /installation needs operator attention/],
]) {
  test(`customize turns installer status ${status} into an explicit abort`, () => {
    const item = copyModuleFixture();
    try {
      const result = runCustomize(item, { INSTALL_HOST_RESULT: status });
      assert.equal(result.status, 73, result.stderr);
      const trace = fs.readFileSync(item.trace, "utf8");
      assert.match(trace, /^install-host$/m);
      assert.match(trace, expected);
      assert.doesNotMatch(trace, /^returned$/m);
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });
}

test("customize remains a sourced wrapper with no direct host mutation", () => {
  const source = fs.readFileSync(path.join(moduleRoot, "customize.sh"), "utf8");
  assert.doesNotMatch(source, /^SKIPUNZIP=/m);
  assert.doesNotMatch(source, /\bexit\b/);
  assert.doesNotMatch(source, /\/data\/docker/);
  assert.doesNotMatch(source, /^set\s+-|^\s*trap\b|"\$MODPATH\/bin\/hostctl"\s+(?:start|stop|status|autostart|disk-init)/m);
  assert.match(source, /\babort\b/);
  assert.match(source, /"\$MODPATH\/bin\/install-host"/);
});

test("service is an immediate no-op", () => {
  const source = fs.readFileSync(path.join(moduleRoot, "service.sh"), "utf8");
  assert.match(source, /^exit 0$/m);
  assert.doesNotMatch(source, /\/data\/|\bsleep\b|&/);
  const runnable = source.replace("#!/system/bin/sh", "#!/bin/sh");
  const result = spawnSync("/bin/sh", ["-c", runnable], { encoding: "utf8", timeout: 1_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("boot completion requires autostart, kernel capabilities, and exact boot identity", () => {
  assert.match(bootCompletedSource, /"\$HOSTCTL" start[^\n]*&\nexit 0\s*$/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pixel-boot-completed-"));
  const moduleDir = path.join(root, "module");
  const dockerRoot = path.join(root, "docker");
  const binDir = path.join(dockerRoot, "bin");
  const moduleBin = path.join(moduleDir, "bin");
  const calls = path.join(root, "boot.calls");
  const hostStatus = path.join(root, "host.status");
  const kernelConfig = path.join(root, "config.gz");
  const state = path.join(root, "state");
  const busybox = path.join(root, "busybox");
  fs.mkdirSync(moduleBin, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(moduleDir, "module.prop"), "id=eip-pixel11xl-forge\n");
  writeExecutable(busybox, `#!/bin/sh
applet=$1
shift
case "$applet" in
  awk) exec /usr/bin/awk "$@" ;;
  zcat) exec /usr/bin/gzip -dc "$@" ;;
  *) exit 2 ;;
esac
`);
  writeExecutable(path.join(binDir, "hostctl"), `#!/bin/sh
printf 'hostctl %s\n' "$*" >> ${shellQuote(calls)}
case "$1" in
  status) cat ${shellQuote(hostStatus)} ;;
  start) printf 'started\n' ;;
  *) exit 2 ;;
esac
`);
  writeExecutable(path.join(moduleBin, "kernelctl"), `#!/bin/sh
printf 'kernelctl %s\n' "$*" >> ${shellQuote(calls)}
[ "$1" = status ] || exit 2
[ ! -f ${shellQuote(path.join(state, "kernel-fail"))} ] || exit 1
printf '%s\n' KERNELCTL_VERSION=1 build_id=TEST.1 slot_suffix=_b boot_state=current-public staged_image=ready
`);
  const statusText = (autostart) => [
    "schema_version=2",
    "daemon=stopped",
    "containers=0",
    `autostart=${autostart}`,
    "host_config=ready",
    "disk=missing",
    "mount=absent",
    "wifi_interface=ready",
    "bridge_routes=ready",
    "wifi_policy=missing",
    "ipv4_forwarding=off",
    "api_firewall=missing",
    "",
  ].join("\n");
  const capabilities = [
    "CONFIG_PID_NS=y",
    "CONFIG_IPC_NS=y",
    "CONFIG_USER_NS=y",
    "CONFIG_SYSVIPC=y",
    "CONFIG_POSIX_MQUEUE=y",
    "",
  ].join("\n");
  fs.writeFileSync(hostStatus, statusText("off"));
  fs.writeFileSync(kernelConfig, zlib.gzipSync(capabilities));
  let runnable = bootCompletedSource.replace("#!/system/bin/sh", "#!/bin/sh");
  for (const [from, to] of [
    ["BUSYBOX=/data/adb/ksu/bin/busybox", `BUSYBOX=${shellQuote(busybox)}`],
    ["DOCKER_ROOT=/data/docker", `DOCKER_ROOT=${shellQuote(dockerRoot)}`],
    ["KERNEL_CONFIG=/proc/config.gz", `KERNEL_CONFIG=${shellQuote(kernelConfig)}`],
  ]) {
    assert.equal(runnable.split(from).length, 2, from);
    runnable = runnable.replace(from, to);
  }
  runnable = runnable.replace(
    '"$HOSTCTL" start </dev/null >>"$LOG_FILE" 2>&1 &',
    '"$HOSTCTL" start </dev/null >>"$LOG_FILE" 2>&1',
  );
  const boot = path.join(moduleDir, "boot-completed.sh");
  writeExecutable(boot, runnable);
  const processTimeout = 10_000;

  try {
    let result = spawnSync("/bin/sh", [boot], { encoding: "utf8", timeout: processTimeout });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(calls, "utf8"), "hostctl status\n");

    fs.writeFileSync(calls, "");
    fs.writeFileSync(hostStatus, statusText("on"));
    fs.writeFileSync(kernelConfig, zlib.gzipSync(capabilities.replace("CONFIG_USER_NS=y\n", "")));
    result = spawnSync("/bin/sh", [boot], { encoding: "utf8", timeout: processTimeout });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(calls, "utf8"), "hostctl status\n");
    assert.match(fs.readFileSync(path.join(dockerRoot, "hostctl.log"), "utf8"), /kernel capabilities are unavailable/);

    fs.writeFileSync(calls, "");
    fs.writeFileSync(kernelConfig, zlib.gzipSync(capabilities));
    fs.writeFileSync(path.join(state, "kernel-fail"), "yes\n");
    result = spawnSync("/bin/sh", [boot], { encoding: "utf8", timeout: processTimeout });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(calls, "utf8"), "hostctl status\nkernelctl status\n");

    fs.writeFileSync(calls, "");
    fs.rmSync(path.join(state, "kernel-fail"));
    result = spawnSync("/bin/sh", [boot], { encoding: "utf8", timeout: processTimeout });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(calls, "utf8"), "hostctl status\nkernelctl status\nhostctl start\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("boot completion performs no download, transport fallback, or privileged registration", () => {
  assert.doesNotMatch(bootCompletedSource, /\bcurl\b|\bwget\b|\bpull\b|\bcell|rmnet|ccmni|binfmt|--privileged/i);
});

test("module lifecycle sources contain no private deployment coupling", () => {
  const sources = fs.readdirSync(moduleRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8"))
    .join("\n");
  const privateProject = ["eip", "cve", "public"].join("-");
  const privateWorkspace = ["pixel11", "docker"].join("-");
  const privateMaterial = new RegExp(
    `${privateProject}|${privateWorkspace}|/Users/|\\.env|api[_-]?key`,
    "i",
  );
  assert.doesNotMatch(sources, privateMaterial);
  assert.doesNotMatch(sources, /ollama|deepseek|anthropic|openai|gemini|companion/i);
});
