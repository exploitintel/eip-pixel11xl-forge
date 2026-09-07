import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(projectRoot, "module", "bin", "install-host"), "utf8");
const buildId = "TEST.1";
const moduleVersion = "0.1.0";
const kernel = Buffer.from("kernel-candidate\n");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function writeExecutable(file, contents) {
  fs.writeFileSync(file, contents, { mode: 0o755 });
}

function installerInputs() {
  const rows = [
    "INSTALLER_INPUTS_VERSION=1",
    `MODULE\t${moduleVersion}\t1`,
    `ENGINE\t29.8.0\tdocker-29.8.0.tgz\t1000\t${"a".repeat(64)}\thttps://download.docker.com/linux/static/stable/aarch64/docker-29.8.0.tgz`,
  ];
  for (const name of ["containerd", "containerd-shim-runc-v2", "ctr", "docker", "docker-init", "docker-proxy", "dockerd", "runc"]) {
    rows.push(`BINARY\t${name}\t100\t${"b".repeat(64)}\t${"c".repeat(64)}\t0\t0\t0\t0`);
  }
  rows.push(`BUILD\t${buildId}\tkodiak\tfingerprint\t17\t2026-08-05\tkernel\t4096\t4096\t4\t1584\t0\tImage-${buildId}.lz4`);
  rows.push(`BOOT_STATE\t${buildId}\tcurrent-public\t${kernel.length}\t${sha256(kernel)}\t4096\t${"d".repeat(64)}`);
  return Buffer.from(`${rows.join("\n")}\n`);
}

function busyboxSource(state, calls) {
  return `#!/bin/sh
STATE=${shellQuote(state)}
CALLS=${shellQuote(calls)}
APPLET=\${1:-}
shift || exit 1
printf 'busybox:%s' "$APPLET" >> "$CALLS"
for ARG in "$@"; do printf ' %s' "$ARG" >> "$CALLS"; done
printf '\n' >> "$CALLS"
case "$APPLET" in
  id) [ "$#" -eq 1 ] && [ "$1" = -u ] && printf '0\n' ;;
  readlink) [ "$#" -eq 2 ] && [ "$1" = -f ] && exec /bin/realpath "$2" ;;
  stat)
    [ "$#" -eq 3 ] && [ "$1" = -c ] && [ "$2" = %s ] || exit 2
    /usr/bin/stat -f '%z' "$3"
    ;;
  sha256sum)
    HASH=$(/usr/bin/openssl dgst -sha256 -r "$1") || exit 1
    HASH=\${HASH%% *}
    printf '%s  %s\n' "$HASH" "$1"
    ;;
  awk) exec /usr/bin/awk "$@" ;;
  df)
    printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
    TARGET=\${2:-}
    if [ -f "$STATE/low-tmp-space" ] && [ "$TARGET" = ${shellQuote("TMP_ROOT_PLACEHOLDER")} ]; then
      printf 'fixture 1000 999 1 99%% /\n'
    elif [ -f "$STATE/low-data-space" ] && [ "$TARGET" = ${shellQuote("DATA_ROOT_PLACEHOLDER")} ]; then
      printf 'fixture 1000 999 1 99%% /\n'
    else
      printf 'fixture 5000000 1 4999999 1%% /\n'
    fi
    ;;
  rm) exec /bin/rm "$@" ;;
  *) printf 'unsupported applet: %s\n' "$APPLET" >&2; exit 2 ;;
esac
`;
}

function fixture({ active = "none" } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "install-host-")));
  const moduleDir = path.join(root, "module");
  const binDir = path.join(moduleDir, "bin");
  const tmpDir = path.join(root, "tmp");
  const dataRoot = path.join(root, "data");
  const state = path.join(root, "state");
  const calls = path.join(root, "calls.log");
  for (const directory of [binDir, tmpDir, dataRoot, state]) fs.mkdirSync(directory, { recursive: true });
  const inputs = installerInputs();
  const inputsHash = sha256(inputs);
  fs.writeFileSync(path.join(moduleDir, "installer-inputs.tsv"), inputs);
  const manifest = Buffer.from(`RELEASE_MANIFEST_VERSION=1\nhostctl\t1\t${"e".repeat(64)}\t0755\n`);
  fs.writeFileSync(path.join(moduleDir, "release-manifest.tsv"), manifest);
  const config = Buffer.from("HOST_CONFIG_VERSION=2\nAUTOSTART=0\nDISK_SIZE_BYTES=0\nBRIDGE_POOL_CIDR=172.17.0.0/16\nEXT4_FEATURES=^has_journal,^casefold\nMOUNT_OPTIONS=noatime,nodev\n");
  fs.writeFileSync(path.join(moduleDir, "host.conf.default"), config, { mode: 0o644 });

  writeExecutable(path.join(binDir, "install-preflight"), `#!/bin/sh
printf 'preflight\n' >> ${shellQuote(calls)}
[ ! -f ${shellQuote(path.join(state, "preflight-fail"))} ] || exit 1
printf '%s\n' INSTALL_PREFLIGHT_VERSION=1 module_version=${moduleVersion} build_id=${buildId} slot_suffix=_b boot_state=stock installer_inputs_sha256=${inputsHash}
`);
  writeExecutable(path.join(binDir, "prepare-engine"), `#!/bin/sh
printf 'prepare-engine\n' >> ${shellQuote(calls)}
[ ! -f ${shellQuote(path.join(state, "engine-fail"))} ] || exit 1
/bin/mkdir ${shellQuote(path.join(tmpDir, "eip-engine-prepared"))}
INPUT_HASH=${inputsHash}
[ ! -f ${shellQuote(path.join(state, "wrong-engine-handoff"))} ] || INPUT_HASH=${"0".repeat(64)}
printf '%s\n' ENGINE_PREPARE_VERSION=1 engine_version=29.8.0 acquisition_source=sideload prepared_path=${shellQuote(path.join(tmpDir, "eip-engine-prepared"))} manifest_path=${shellQuote(path.join(moduleDir, "release-manifest.tsv"))} installer_inputs_sha256="$INPUT_HASH" release_manifest_sha256=${sha256(manifest)}
`);
  writeExecutable(path.join(binDir, "prepare-kernel"), `#!/bin/sh
printf 'prepare-kernel %s\n' "$*" >> ${shellQuote(calls)}
[ ! -f ${shellQuote(path.join(state, "kernel-fail"))} ] || exit 1
printf kernel-candidate\\n > ${shellQuote(path.join(tmpDir, "eip-kernel-prepared"))}
/bin/chmod 0600 ${shellQuote(path.join(tmpDir, "eip-kernel-prepared"))}
printf '%s\n' KERNEL_PREPARE_VERSION=1 build_id=${buildId} acquisition_source=sideload prepared_path=${shellQuote(path.join(tmpDir, "eip-kernel-prepared"))} image_size=${kernel.length} image_sha256=${sha256(kernel)} installer_inputs_sha256=${inputsHash}
`);
  writeExecutable(path.join(binDir, "release-transaction"), `#!/bin/sh
printf 'transaction %s\n' "$*" >> ${shellQuote(calls)}
if [ "$1" = probe ]; then
  [ ! -f ${shellQuote(path.join(state, "probe-fail"))} ] || exit 1
  printf '%s\n' TRANSACTION_PROBE_VERSION=1 active=${active}
  exit 0
fi
[ "$1" = stage-install ] && [ "$#" -eq 12 ] || exit 2
if [ -f ${shellQuote(path.join(state, "interrupt-bootstrap-once"))} ]; then
  /bin/mv ${shellQuote(path.join(state, "interrupt-bootstrap-once"))} ${shellQuote(path.join(state, "stale-intent-bootstrap"))}
  exit 1
fi
if [ -f ${shellQuote(path.join(state, "stale-intent-bootstrap"))} ]; then
  printf 'transaction recovered stale intent bootstrap\n' >> ${shellQuote(calls)}
  /bin/rm -f ${shellQuote(path.join(state, "stale-intent-bootstrap"))}
fi
if [ -f ${shellQuote(path.join(state, "transaction-status"))} ]; then
  exit "$(/bin/cat ${shellQuote(path.join(state, "transaction-status"))})"
fi
printf '%s\n' result=activated active=${moduleVersion} previous=${active}
`);
  const busybox = path.join(root, "busybox");
  writeExecutable(
    busybox,
    busyboxSource(state, calls)
      .replaceAll("TMP_ROOT_PLACEHOLDER", tmpDir)
      .replaceAll("DATA_ROOT_PLACEHOLDER", dataRoot),
  );
  let runnable = source;
  for (const [from, to] of [
    ["#!/system/bin/sh", "#!/bin/sh"],
    ["BUSYBOX=/data/adb/ksu/bin/busybox", `BUSYBOX=${shellQuote(busybox)}`],
    ["DATA_ROOT=/data", `DATA_ROOT=${shellQuote(dataRoot)}`],
  ]) {
    assert.equal(runnable.split(from).length, 2, from);
    runnable = runnable.replace(from, to);
  }
  const command = path.join(binDir, "install-host");
  writeExecutable(command, runnable);
  return { root, moduleDir, tmpDir, dataRoot, state, calls, command, inputsHash };
}

function run(item, ...args) {
  const result = spawnSync("/bin/sh", [item.command, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, TMPDIR: item.tmpDir },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(typeof result.status, "number");
  return result;
}

function callLog(item) {
  return fs.existsSync(item.calls) ? fs.readFileSync(item.calls, "utf8") : "";
}

function remove(item) {
  fs.rmSync(item.root, { recursive: true, force: true });
}

test("install-host orders all gates and activates one cross-bound staged install", () => {
  const item = fixture();
  try {
    const result = run(item);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^INSTALL_HOST_VERSION=1\nresult=activated\nmodule_version=0\.1\.0\n/m);
    assert.match(result.stdout, /build_id=TEST\.1\nslot_suffix=_b\nboot_state=stock/);
    assert.match(result.stdout, /engine_version=29\.8\.0\nengine_source=sideload\nkernel_source=sideload/);
    const calls = callLog(item);
    const order = ["preflight\n", "transaction probe\n", "busybox:df ", "prepare-engine\n", "prepare-kernel ", "transaction stage-install "];
    let position = -1;
    for (const marker of order) {
      const next = calls.indexOf(marker, position + 1);
      assert.ok(next > position, `${marker}\n${calls}`);
      position = next;
    }
    assert.match(calls, new RegExp(`prepare-kernel ${buildId} ${item.inputsHash}`));
    assert.equal(fs.existsSync(path.join(item.tmpDir, "eip-engine-prepared")), false);
    assert.equal(fs.existsSync(path.join(item.tmpDir, "eip-kernel-prepared")), false);
  } finally {
    remove(item);
  }
});

test("free-space gates avoid Android mksh byte-multiplication overflow", () => {
  assert.doesNotMatch(source, /AVAILABLE_BYTES=\$\(\([^\n]*AVAILABLE_KIB[^\n]*\* 1024\)\)/);
  assert.match(source, /bb awk -v available="\$TMP_AVAILABLE_KIB" -v required="\$TMP_REQUIRED_BYTES"/);
  assert.match(source, /bb awk -v available="\$DATA_AVAILABLE_KIB" -v required="\$DATA_REQUIRED_BYTES"/);

  const item = fixture();
  try {
    const result = run(item);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^result=activated$/m);
  } finally {
    remove(item);
  }
});

for (const [label, marker, expected, forbidden] of [
  ["device preflight", "preflight-fail", /device and boot preflight failed/, /transaction probe|prepare-engine|prepare-kernel|stage-install/],
  ["host probe", "probe-fail", /host release preflight failed/, /prepare-engine|prepare-kernel|stage-install/],
  ["temporary space gate", "low-tmp-space", /insufficient temporary free space/, /prepare-engine|prepare-kernel|stage-install/],
  ["persistent data space gate", "low-data-space", /insufficient persistent data free space/, /prepare-engine|prepare-kernel|stage-install/],
  ["engine preparation", "engine-fail", /Docker Engine preparation failed/, /prepare-kernel|stage-install/],
  ["kernel preparation", "kernel-fail", /kernel candidate preparation failed/, /stage-install/],
]) {
  test(`${label} refusal stops before later phases and cleans owned temporary output`, () => {
    const item = fixture();
    try {
      fs.writeFileSync(path.join(item.state, marker), "yes\n");
      const result = run(item);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expected);
      assert.doesNotMatch(callLog(item), forbidden);
      assert.equal(fs.existsSync(path.join(item.tmpDir, "eip-engine-prepared")), false);
      assert.equal(fs.existsSync(path.join(item.tmpDir, "eip-kernel-prepared")), false);
    } finally {
      remove(item);
    }
  });
}

test("install-host rejects a cross-phase hash mismatch before kernel preparation", () => {
  const item = fixture();
  try {
    fs.writeFileSync(path.join(item.state, "wrong-engine-handoff"), "yes\n");
    const result = run(item);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /engine preparation handoff does not match this package/);
    assert.doesNotMatch(callLog(item), /prepare-kernel|stage-install/);
    assert.equal(fs.existsSync(path.join(item.tmpDir, "eip-engine-prepared")), false);
  } finally {
    remove(item);
  }
});

test("install-host preserves the transaction attention status and cleans temporary payloads", () => {
  const item = fixture({ active: "v0" });
  try {
    fs.writeFileSync(path.join(item.state, "transaction-status"), "3\n");
    const result = run(item);
    assert.equal(result.status, 3, result.stderr);
    assert.equal(fs.existsSync(path.join(item.tmpDir, "eip-engine-prepared")), false);
    assert.equal(fs.existsSync(path.join(item.tmpDir, "eip-kernel-prepared")), false);
  } finally {
    remove(item);
  }
});

test("a normal install-host retry reaches stage-install after an interrupted intent-backed bootstrap", () => {
  const item = fixture();
  try {
    fs.writeFileSync(path.join(item.state, "interrupt-bootstrap-once"), "yes\n");
    let result = run(item);
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(path.join(item.state, "stale-intent-bootstrap")), true);
    assert.equal(fs.existsSync(path.join(item.tmpDir, "eip-engine-prepared")), false);
    assert.equal(fs.existsSync(path.join(item.tmpDir, "eip-kernel-prepared")), false);

    result = run(item);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^INSTALL_HOST_VERSION=1\nresult=activated\n/);
    assert.equal(fs.existsSync(path.join(item.state, "stale-intent-bootstrap")), false);
    const calls = callLog(item);
    assert.equal((calls.match(/^transaction probe$/gm) ?? []).length, 2);
    assert.equal((calls.match(/^transaction stage-install /gm) ?? []).length, 2);
    assert.match(calls, /^transaction recovered stale intent bootstrap$/m);
  } finally {
    remove(item);
  }
});

test("install-host is a no-argument non-service installer orchestrator", () => {
  assert.doesNotMatch(source, /hostctl|swap-boot-kernel|dockerd\.sh|\bdd\b|\bmount\b|iptables|ip rule/);
  const item = fixture();
  try {
    const result = run(item, "unexpected");
    assert.equal(result.status, 2);
    assert.match(result.stderr, /accepts no arguments/);
    assert.equal(callLog(item).includes("preflight"), false);
  } finally {
    remove(item);
  }
});
