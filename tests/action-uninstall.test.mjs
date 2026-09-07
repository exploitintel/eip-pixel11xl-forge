import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const actionSource = fs.readFileSync(path.join(projectRoot, "module", "action.sh"), "utf8");
const uninstallSource = fs.readFileSync(path.join(projectRoot, "module", "uninstall.sh"), "utf8");
const buildId = "CD1A.260714.001.A9";

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

function kernelStatus(bootState = "stock", stagedImage = "ready") {
  return [
    "KERNELCTL_VERSION=1",
    `build_id=${buildId}`,
    "slot_suffix=_b",
    `boot_state=${bootState}`,
    `staged_image=${stagedImage}`,
    "",
  ].join("\n");
}

function makeActionFixture({ uid = 0 } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pixel-action-")));
  const moduleDir = path.join(root, "module");
  const binDir = path.join(moduleDir, "bin");
  const state = path.join(root, "state");
  const calls = path.join(state, "calls");
  const events = path.join(state, "events");
  const hostStatusCode = path.join(state, "host-status-code");
  const hostCommandCode = path.join(state, "host-command-code");
  const kernelStatusCode = path.join(state, "kernel-status-code");
  const kernelCommandCode = path.join(state, "kernel-command-code");
  const kernelStatusFile = path.join(state, "kernel-status");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(state);
  for (const [file, value] of [
    [events, ""],
    [hostStatusCode, "0\n"],
    [hostCommandCode, "0\n"],
    [kernelStatusCode, "0\n"],
    [kernelCommandCode, "0\n"],
    [kernelStatusFile, kernelStatus()],
  ]) fs.writeFileSync(file, value);

  const busybox = path.join(root, "busybox");
  writeExecutable(busybox, `#!/bin/sh
APPLET=\${1:-}
shift || exit 2
case "$APPLET" in
  id)
    [ "$#" -eq 1 ] && [ "$1" = -u ] || exit 2
    printf '%s\n' ${uid}
    ;;
  timeout)
    [ "$#" -ge 2 ] || exit 2
    shift
    exec "$@"
    ;;
  awk) exec /usr/bin/awk "$@" ;;
  *) printf 'unsupported fake BusyBox applet: %s\n' "$APPLET" >&2; exit 90 ;;
esac
`);

  const getevent = path.join(root, "getevent");
  writeExecutable(getevent, `#!/bin/sh
printf 'getevent %s\n' "$*" >> ${shellQuote(calls)}
[ "$*" = '-qlc 1' ] || exit 2
[ -s ${shellQuote(events)} ] || exit 0
IFS= read -r EVENT < ${shellQuote(events)} || exit 0
printf '%s\n' "$EVENT"
/usr/bin/sed '1d' ${shellQuote(events)} > ${shellQuote(`${events}.next`)} || exit 1
/bin/mv ${shellQuote(`${events}.next`)} ${shellQuote(events)}
`);

  writeExecutable(path.join(binDir, "hostctl"), `#!/bin/sh
printf 'host %s\n' "$*" >> ${shellQuote(calls)}
if [ "$#" -eq 1 ] && [ "$1" = status ]; then
  printf '%s\n' 'schema_version=2' 'daemon=stopped' 'autostart=off' 'disk=absent' 'wifi_interface=ready'
  exit "$(/bin/cat ${shellQuote(hostStatusCode)})"
fi
printf 'result=host-%s\n' "$1"
CODE=$(/bin/cat ${shellQuote(hostCommandCode)})
[ "$CODE" -ne 3 ] || printf '%s\n' 'host recovery attention' >&2
exit "$CODE"
`);

  writeExecutable(path.join(binDir, "kernelctl"), `#!/bin/sh
printf 'kernel %s\n' "$*" >> ${shellQuote(calls)}
if [ "$#" -eq 1 ] && [ "$1" = status ]; then
  /bin/cat ${shellQuote(kernelStatusFile)}
  exit "$(/bin/cat ${shellQuote(kernelStatusCode)})"
fi
printf 'result=kernel-%s\n' "$1"
CODE=$(/bin/cat ${shellQuote(kernelCommandCode)})
[ "$CODE" -ne 3 ] || printf '%s\n' 'kernel recovery attention' >&2
exit "$CODE"
`);

  let runnable = replaceRequired(actionSource, "#!/system/bin/sh", "#!/bin/sh");
  runnable = replaceRequired(runnable, "BUSYBOX=/data/adb/ksu/bin/busybox", `BUSYBOX=${shellQuote(busybox)}`);
  runnable = replaceRequired(runnable, "GETEVENT=/system/bin/getevent", `GETEVENT=${shellQuote(getevent)}`);
  runnable = replaceRequired(runnable, "MENU_WAIT_ATTEMPTS=15", "MENU_WAIT_ATTEMPTS=2");
  runnable = replaceRequired(runnable, "CONFIRM_WAIT_ATTEMPTS=10", "CONFIRM_WAIT_ATTEMPTS=2");
  const action = path.join(moduleDir, "action.sh");
  writeExecutable(action, runnable);
  return {
    root, action, calls, events, hostStatusCode, hostCommandCode,
    kernelStatusCode, kernelCommandCode, kernelStatusFile,
  };
}

function press(name) {
  return `/dev/input/event3: EV_KEY KEY_VOLUME${name.toUpperCase()} DOWN`;
}

function choose(index, confirmation = null) {
  const result = Array.from({ length: index }, () => press("down"));
  result.push(press("up"));
  if (confirmation) result.push(press(confirmation));
  return result;
}

function runAction(item, selectedEvents = []) {
  fs.writeFileSync(item.events, selectedEvents.length === 0 ? "" : `${selectedEvents.join("\n")}\n`);
  const result = spawnSync("/bin/sh", [item.action], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(typeof result.status, "number");
  return result;
}

function removeFixture(item) {
  fs.rmSync(item.root, { recursive: true, force: true });
}

test("Action source has bounded volume-key controls and no reboot path", () => {
  assert.match(actionSource, /bb timeout "\$KEY_WAIT_SLICE_SECONDS" "\$GETEVENT" -qlc 1/);
  assert.match(actionSource, /^MENU_WAIT_ATTEMPTS=15$/m);
  assert.match(actionSource, /^CONFIRM_WAIT_ATTEMPTS=10$/m);
  assert.match(actionSource, /disk-init --size-bytes "\$DISK_BYTES"/);
  assert.match(actionSource, /INSTALL:\$KERNEL_BUILD_ID:\$KERNEL_SLOT_SUFFIX/);
  assert.match(actionSource, /RESTORE:\$KERNEL_BUILD_ID:\$KERNEL_SLOT_SUFFIX/);
  assert.doesNotMatch(actionSource, /^\s*(?:\$BUSYBOX\s+)?reboot\b|set_active|bootctl set/m);
});

test("Action is root-only before status or key input", () => {
  const item = makeActionFixture({ uid: 2000 });
  try {
    const result = runAction(item);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /root is required/);
    assert.equal(fs.existsSync(item.calls), false);
  } finally {
    removeFixture(item);
  }
});

test("Action prints host and kernel status before a bounded idle timeout", () => {
  const item = makeActionFixture();
  try {
    const result = runAction(item);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /=== Forge host status ===[\s\S]*daemon=stopped/);
    assert.match(result.stdout, /=== Kernel status ===[\s\S]*boot_state=stock/);
    assert.match(result.stdout, /Action menu timed out; nothing changed/);
    const calls = fs.readFileSync(item.calls, "utf8");
    assert.ok(calls.indexOf("host status") < calls.indexOf("kernel status"));
    assert.ok(calls.indexOf("kernel status") < calls.indexOf("getevent"));
    assert.doesNotMatch(calls, /host (?:start|stop|disk-init|autostart)/);
  } finally {
    removeFixture(item);
  }
});

test("Action starts only after Volume Up selects Start", () => {
  const item = makeActionFixture();
  try {
    const result = runAction(item, choose(0));
    assert.equal(result.status, 0, result.stderr);
    const calls = fs.readFileSync(item.calls, "utf8");
    assert.match(calls, /host status[\s\S]*kernel status[\s\S]*getevent -qlc 1[\s\S]*host start/);
    assert.equal((calls.match(/^kernel status$/gm) ?? []).length, 2);
    assert.equal((calls.match(/getevent/g) ?? []).length, 1);
  } finally {
    removeFixture(item);
  }
});

test("Action refuses Start when a fresh kernel status cannot prove the boot identity", () => {
  const item = makeActionFixture();
  try {
    fs.writeFileSync(item.kernelStatusCode, "1\n");
    const result = runAction(item, choose(0));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Kernel status failed; no kernel command was issued/);
    const calls = fs.readFileSync(item.calls, "utf8");
    assert.equal((calls.match(/^kernel status$/gm) ?? []).length, 2);
    assert.doesNotMatch(calls, /^host start$/m);
  } finally {
    removeFixture(item);
  }
});

test("Action requires a second Volume Up for Stop; Down or timeout cancels", () => {
  for (const [confirmation, expectedStop, cancellation] of [
    ["down", false, /Action canceled/],
    [null, false, /Confirmation timed out/],
    ["up", true, null],
  ]) {
    const item = makeActionFixture();
    try {
      const result = runAction(item, choose(1, confirmation));
      assert.equal(result.status, 0, result.stderr);
      const calls = fs.readFileSync(item.calls, "utf8");
      assert.equal(/^host stop$/m.test(calls), expectedStop);
      if (cancellation) assert.match(result.stdout, cancellation);
    } finally {
      removeFixture(item);
    }
  }
});

test("Action prints both statuses and exits 3 before its menu on recovery attention", () => {
  const item = makeActionFixture();
  try {
    fs.writeFileSync(item.hostStatusCode, "3\n");
    const result = runAction(item);
    assert.equal(result.status, 3);
    assert.match(result.stdout, /=== Forge host status ===[\s\S]*=== Kernel status ===/);
    assert.match(result.stderr, /ATTENTION: hostctl reported recovery-required status 3/);
    assert.doesNotMatch(fs.readFileSync(item.calls, "utf8"), /getevent/);
  } finally {
    removeFixture(item);
  }
});

for (const [index, gib, bytes] of [
  [2, 8, "8589934592"],
  [3, 16, "17179869184"],
  [4, 32, "34359738368"],
]) {
  test(`Action binds the confirmed ${gib} GiB preset to exact bytes`, () => {
    const item = makeActionFixture();
    try {
      const result = runAction(item, choose(index, "up"));
      assert.equal(result.status, 0, result.stderr);
      assert.match(fs.readFileSync(item.calls, "utf8"), new RegExp(`^host disk-init --size-bytes ${bytes}$`, "m"));
    } finally {
      removeFixture(item);
    }
  });
}

for (const [index, value] of [[5, "on"], [6, "off"]]) {
  test(`Action requires confirmation before setting autostart ${value}`, () => {
    const item = makeActionFixture();
    try {
      const result = runAction(item, choose(index, "up"));
      assert.equal(result.status, 0, result.stderr);
      assert.match(fs.readFileSync(item.calls, "utf8"), new RegExp(`^host autostart ${value}$`, "m"));
    } finally {
      removeFixture(item);
    }
  });
}

for (const [index, verb, token] of [
  [7, "install", `INSTALL:${buildId}:_b`],
  [8, "restore", `RESTORE:${buildId}:_b`],
]) {
  test(`Action derives the exact ${verb} token from a fresh strict status`, () => {
    const item = makeActionFixture();
    try {
      const result = runAction(item, choose(index, "up"));
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /fastboot flash boot_b <exact-known-good-boot\.img>/);
      const calls = fs.readFileSync(item.calls, "utf8");
      assert.equal((calls.match(/^kernel status$/gm) ?? []).length, 2);
      assert.match(calls, new RegExp(`^kernel ${verb} ${token.replaceAll(".", "\\.")}$`, "m"));
    } finally {
      removeFixture(item);
    }
  });
}

test("Action refuses a malformed fresh kernel status before confirmation or write", () => {
  const item = makeActionFixture();
  try {
    fs.writeFileSync(item.kernelStatusFile, kernelStatus().replace("slot_suffix=_b", "slot_suffix=other"));
    const result = runAction(item, choose(7, "up"));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /malformed; no kernel command/);
    const calls = fs.readFileSync(item.calls, "utf8");
    assert.doesNotMatch(calls, /^kernel install/m);
    assert.equal((calls.match(/getevent/g) ?? []).length, 8);
  } finally {
    removeFixture(item);
  }
});

test("Action surfaces kernel write status 3 as recovery attention", () => {
  const item = makeActionFixture();
  try {
    fs.writeFileSync(item.kernelCommandCode, "3\n");
    const result = runAction(item, choose(7, "up"));
    assert.equal(result.status, 3);
    assert.match(result.stderr, /RECOVERY ATTENTION: status 3/);
    assert.match(fs.readFileSync(item.calls, "utf8"), /^kernel install INSTALL:/m);
  } finally {
    removeFixture(item);
  }
});

function makeUninstallFixture({ uid = 0, bootState = "stock" } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pixel-uninstall-")));
  const moduleDir = path.join(root, "module");
  const binDir = path.join(moduleDir, "bin");
  const dockerRoot = path.join(root, "docker");
  const releases = path.join(dockerRoot, "releases");
  const release = path.join(releases, "v1");
  const release2 = path.join(releases, "v2");
  const state = path.join(root, "state");
  const calls = path.join(state, "calls");
  const stopStatus = path.join(state, "stop-status");
  const stopOutput = path.join(state, "stop-output");
  const transactionStatus = path.join(state, "transaction-status");
  const transactionFailAfterUnlink = path.join(state, "transaction-fail-after-unlink");
  const transactionFailWithJournal = path.join(state, "transaction-fail-with-journal");
  const deactivationRecord = path.join(releases, ".deactivation");
  const kernelStatusCode = path.join(state, "kernel-status-code");
  const kernelStatusFile = path.join(state, "kernel-status");
  for (const directory of [binDir, release, release2, state]) fs.mkdirSync(directory, { recursive: true });
  fs.chmodSync(release, 0o700);
  fs.chmodSync(release2, 0o700);
  fs.writeFileSync(path.join(dockerRoot, "disk.img"), "preserve-disk\n");
  fs.mkdirSync(path.join(dockerRoot, "boot-backup"));
  fs.writeFileSync(path.join(dockerRoot, "boot-backup", "keep"), "backup\n");
  fs.writeFileSync(stopStatus, "0\n");
  fs.writeFileSync(stopOutput, "result=stopped\n");
  fs.writeFileSync(transactionStatus, "0\n");
  fs.writeFileSync(kernelStatusCode, "0\n");
  fs.writeFileSync(kernelStatusFile, kernelStatus(bootState));
  fs.writeFileSync(path.join(moduleDir, "module.prop"), [
    "id=eip-pixel11xl-forge",
    "name=EIP Pixel 11 Pro XL Forge",
    "version=0.1.0-rc.2",
    "versionCode=3",
    "author=Exploit Intel",
    "description=Pixel 11 Pro XL Docker host installer (Wi-Fi only)",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(moduleDir, "installer-inputs.tsv"), "INSTALLER_INPUTS_VERSION=1\n");
  writeExecutable(path.join(binDir, "install-preflight"), "#!/bin/sh\nprintf 'preflight fixture\\n'\n");
  writeExecutable(path.join(binDir, "swap-boot-kernel"), "#!/bin/sh\nprintf 'swap fixture\\n'\n");
  writeExecutable(path.join(binDir, "release-transaction"), `#!/bin/sh
printf 'transaction %s\n' "$*" >> ${shellQuote(calls)}
[ "$#" -eq 2 ] && [ "$1" = deactivate ] && [ "$2" = v1 ] || exit 2
TRANSACTION_STATUS=$(/bin/cat ${shellQuote(transactionStatus)})
[ "$TRANSACTION_STATUS" -eq 0 ] || { printf '%s\n' 'transaction refused' >&2; exit "$TRANSACTION_STATUS"; }
if [ -f ${shellQuote(transactionFailWithJournal)} ]; then
  /bin/rm -f ${shellQuote(transactionFailWithJournal)}
  printf '%s\n' 'DEACTIVATION_RECORD_VERSION=1' 'EXPECTED=v1' > ${shellQuote(deactivationRecord)}
  /bin/chmod 0600 ${shellQuote(deactivationRecord)}
  printf '%s\n' 'injected journal fsync failure' >&2
  exit 1
fi
/bin/rm -f ${shellQuote(path.join(dockerRoot, "bin"))} || exit 1
if [ -f ${shellQuote(transactionFailAfterUnlink)} ]; then
  /bin/rm -f ${shellQuote(transactionFailAfterUnlink)}
  printf '%s\n' 'injected post-unlink durability failure' >&2
  exit 1
fi
/bin/rm -f ${shellQuote(deactivationRecord)}
printf 'result=deactivated\nactive=none\nprevious=%s\n' "$2"
`);

  const hostctlScript = `#!/bin/sh
printf 'host %s\n' "$*" >> ${shellQuote(calls)}
[ "$#" -eq 1 ] && [ "$1" = stop ] || exit 2
if [ -f ${shellQuote(path.join(state, "swap-link"))} ]; then
  /bin/rm -f ${shellQuote(path.join(dockerRoot, "bin"))}
  /bin/ln -s releases/v2 ${shellQuote(path.join(dockerRoot, "bin"))}
fi
/bin/cat ${shellQuote(stopOutput)}
exit "$(/bin/cat ${shellQuote(stopStatus)})"
`;
  writeExecutable(path.join(release, "hostctl"), hostctlScript);
  writeExecutable(path.join(release2, "hostctl"), hostctlScript);
  fs.symlinkSync("releases/v1", path.join(dockerRoot, "bin"));

  writeExecutable(path.join(binDir, "kernelctl"), `#!/bin/sh
printf 'kernel %s\n' "$*" >> ${shellQuote(calls)}
[ "$#" -eq 1 ] && [ "$1" = status ] || exit 2
/bin/cat ${shellQuote(kernelStatusFile)}
exit "$(/bin/cat ${shellQuote(kernelStatusCode)})"
`);

  const busybox = path.join(root, "busybox");
  writeExecutable(busybox, `#!/bin/sh
APPLET=\${1:-}
shift || exit 2
case "$APPLET" in
  id)
    [ "$#" -eq 1 ] && [ "$1" = -u ] || exit 2
    printf '%s\n' ${uid}
    ;;
  awk) exec /usr/bin/awk "$@" ;;
  readlink)
    if [ "$#" -eq 2 ] && [ "$1" = -f ]; then exec /bin/realpath "$2"; fi
    [ "$#" -eq 1 ] || exit 2
    exec /usr/bin/readlink "$1"
    ;;
  stat)
    [ "$#" -eq 3 ] && [ "$1" = -c ] || exit 2
    if [ "$2" = %s ]; then /usr/bin/wc -c < "$3" | /usr/bin/tr -d ' '; exit 0; fi
    [ "$2" = '%u:%g:%a' ] || exit 2
    if [ -f ${shellQuote(path.join(state, "unsafe-owner"))} ] && [ "\${3##*/}" = hostctl ]; then
      printf '%s\n' '2000:2000:755'; exit 0
    fi
    if [ -d "$3" ]; then printf '%s\n' '0:0:700'; exit 0; fi
    case "$3" in */installer-inputs.tsv|*/recovery-manifest.tsv|*/.deactivation) printf '%s\n' '0:0:600' ;; *) printf '%s\n' '0:0:755' ;; esac
    ;;
  sha256sum)
    [ "$#" -eq 1 ] || exit 2
    HASH=$(/usr/bin/shasum -a 256 "$1") || exit 1
    HASH=\${HASH%% *}
    printf '%s  %s\n' "$HASH" "$1"
    ;;
  mkdir) exec /bin/mkdir "$@" ;;
  chmod) exec /bin/chmod "$@" ;;
  chown) exit 0 ;;
  cp) exec /bin/cp "$@" ;;
  cat) exec /bin/cat "$@" ;;
  ls) exec /bin/ls "$@" ;;
  fsync)
    printf 'fsync %s\n' "$*" >> ${shellQuote(calls)}
    exit 0
    ;;
  mv)
    printf 'mv %s\n' "$*" >> ${shellQuote(calls)}
    if [ "$#" -eq 3 ] && [ "$1" = -T ]; then exec /bin/mv "$2" "$3"; fi
    exit 2
    ;;
  rmdir) exec /bin/rmdir "$@" ;;
  rm)
    printf 'rm' >> ${shellQuote(calls)}
    for ARG in "$@"; do printf ' %s' "$ARG" >> ${shellQuote(calls)}; done
    printf '\n' >> ${shellQuote(calls)}
    exec /bin/rm "$@"
    ;;
  *) printf 'unsupported fake BusyBox applet: %s\n' "$APPLET" >&2; exit 90 ;;
esac
`);

  let runnable = replaceRequired(uninstallSource, "#!/system/bin/sh", "#!/bin/sh");
  runnable = replaceRequired(runnable, "BUSYBOX=/data/adb/ksu/bin/busybox", `BUSYBOX=${shellQuote(busybox)}`);
  runnable = replaceRequired(runnable, "DOCKER_ROOT=/data/docker", `DOCKER_ROOT=${shellQuote(dockerRoot)}`);
  const uninstall = path.join(moduleDir, "uninstall.sh");
  writeExecutable(uninstall, runnable);
  return {
    root, moduleDir, dockerRoot, releases, release, release2, state, calls,
    stopStatus, stopOutput, transactionStatus, transactionFailAfterUnlink,
    transactionFailWithJournal, deactivationRecord, kernelStatusCode, kernelStatusFile, uninstall,
    activeLink: path.join(dockerRoot, "bin"),
    recoveryDir: path.join(dockerRoot, "recovery", "0.1.0-rc.2"),
  };
}

function runUninstall(item) {
  const result = spawnSync("/bin/sh", [item.uninstall], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      KSU: "true",
      KSU_VER: "v3.3.0",
      KSU_VER_CODE: "33214",
      KSU_RUNTIME_MODE: "lkm",
    },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(typeof result.status, "number");
  return result;
}

function assertRecoverySurvivesModuleDeletion(item) {
  assert.deepEqual(fs.readdirSync(item.recoveryDir).sort(), ["bin", "installer-inputs.tsv", "recovery-manifest.tsv"]);
  assert.deepEqual(fs.readdirSync(path.join(item.recoveryDir, "bin")).sort(), [
    "install-preflight", "kernelctl", "swap-boot-kernel",
  ]);
  assert.equal(fs.statSync(item.recoveryDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(item.recoveryDir, "bin", "kernelctl")).mode & 0o777, 0o755);
  assert.equal(fs.statSync(path.join(item.recoveryDir, "installer-inputs.tsv")).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(path.join(item.recoveryDir, "recovery-manifest.tsv"), "utf8"), /^RECOVERY_KIT_VERSION=1$/m);
  assert.match(fs.readFileSync(path.join(item.recoveryDir, "recovery-manifest.tsv"), "utf8"), /^KSU\t3\.3\.0\t33214\tlkm$/m);
  fs.rmSync(item.moduleDir, { recursive: true, force: true });
  const recoveryStatus = spawnSync("/bin/sh", [path.join(item.recoveryDir, "bin", "kernelctl"), "status"], {
    encoding: "utf8",
    timeout: 5_000,
    env: {
      ...process.env,
      KSU: "true",
      KSU_VER: "3.3.0",
      KSU_VER_CODE: "33214",
      KSU_RUNTIME_MODE: "lkm",
    },
  });
  assert.equal(recoveryStatus.status, Number(fs.readFileSync(item.kernelStatusCode, "utf8").trim()), recoveryStatus.stderr);
  assert.match(recoveryStatus.stdout, /KERNELCTL_VERSION=1/);
}

function assertPreserved(item, { recovery = true } = {}) {
  assert.equal(fs.readFileSync(path.join(item.dockerRoot, "disk.img"), "utf8"), "preserve-disk\n");
  assert.equal(fs.readFileSync(path.join(item.dockerRoot, "boot-backup", "keep"), "utf8"), "backup\n");
  assert.equal(fs.existsSync(path.join(item.release, "hostctl")), true);
  assert.equal(fs.existsSync(path.join(item.release2, "hostctl")), true);
  if (recovery) assertRecoverySurvivesModuleDeletion(item);
}

test("Uninstall source delegates exact active-link removal and never reboots", () => {
  assert.match(uninstallSource, /"\$RELEASE_TRANSACTION" deactivate "\$RELEASE_NAME"/);
  assert.doesNotMatch(uninstallSource, /bb rm -f "\$ACTIVE_LINK"/);
  assert.equal((uninstallSource.match(/\bbb rm\b/g) ?? []).length, 2);
  assert.match(uninstallSource, /bb fsync "\$RECOVERY_STAGING\/recovery-manifest\.tsv"/);
  assert.match(uninstallSource, /bb mv -T "\$RECOVERY_STAGING" "\$RECOVERY_DIR"/);
  assert.doesNotMatch(uninstallSource, /rm\s+-[A-Za-z]*r|^\s*(?:\$BUSYBOX\s+)?reboot\b|set_active|bootctl set/m);
  assert.doesNotMatch(uninstallSource, /disk\.img|boot-backup\/\*|releases\/\*/);
});

test("Uninstall is root-only and preserves the active link", () => {
  const item = makeUninstallFixture({ uid: 2000 });
  try {
    const result = runUninstall(item);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /root is required/);
    assert.match(result.stderr, /KernelSU will still delete this module directory/);
    assert.equal(fs.readlinkSync(item.activeLink), "releases/v1");
    assertPreserved(item, { recovery: false });
  } finally {
    removeFixture(item);
  }
});

test("Uninstall refuses cleanup while the public kernel is active", () => {
  const item = makeUninstallFixture({ bootState: "current-public" });
  try {
    const result = runUninstall(item);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /restore RESTORE:CD1A\.260714\.001\.A9:_b/);
    assert.match(result.stderr, /KSU=true KSU_VER=3\.3\.0 KSU_VER_CODE=33214 KSU_RUNTIME_MODE=lkm/);
    assert.match(result.stderr, /fastboot flash boot_b/);
    assert.match(result.stderr, /KernelSU will still delete this module directory/);
    assert.doesNotMatch(fs.readFileSync(item.calls, "utf8"), /^host stop$/m);
    assert.equal(fs.readlinkSync(item.activeLink), "releases/v1");
    assertPreserved(item);
  } finally {
    removeFixture(item);
  }
});

test("Uninstall propagates kernel recovery status 3 and preserves everything", () => {
  const item = makeUninstallFixture();
  try {
    fs.writeFileSync(item.kernelStatusCode, "3\n");
    const result = runUninstall(item);
    assert.equal(result.status, 3);
    assert.match(result.stderr, /RECOVERY ATTENTION/);
    assert.match(result.stderr, /recovery\/0\.1\.0-rc\.2\/bin\/kernelctl status/);
    assert.equal(fs.readlinkSync(item.activeLink), "releases/v1");
    assertPreserved(item);
  } finally {
    removeFixture(item);
  }
});

test("Uninstall refuses an existing mismatched recovery kit without overwriting it", () => {
  const item = makeUninstallFixture();
  try {
    fs.mkdirSync(item.recoveryDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(item.recoveryDir, "foreign"), "do-not-overwrite\n");
    const result = runUninstall(item);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /existing recovery kit does not exactly match/);
    assert.match(result.stderr, /KernelSU will still delete this module directory/);
    assert.equal(fs.readFileSync(path.join(item.recoveryDir, "foreign"), "utf8"), "do-not-overwrite\n");
    assert.equal(fs.readlinkSync(item.activeLink), "releases/v1");
    assertPreserved(item, { recovery: false });
  } finally {
    removeFixture(item);
  }
});

test("Uninstall validates and reuses an exact immutable recovery kit", () => {
  const item = makeUninstallFixture({ bootState: "current-public" });
  try {
    let result = runUninstall(item);
    assert.equal(result.status, 1);
    result = runUninstall(item);
    assert.equal(result.status, 1);
    const calls = fs.readFileSync(item.calls, "utf8");
    assert.equal((calls.match(/^mv -T /gm) ?? []).length, 1);
    assert.equal(fs.readdirSync(path.join(item.dockerRoot, "recovery")).some((name) => name.includes(".staging.")), false);
    assert.equal(fs.readlinkSync(item.activeLink), "releases/v1");
    assertPreserved(item);
  } finally {
    removeFixture(item);
  }
});

test("Uninstall propagates host stop status 3 without unlinking", () => {
  const item = makeUninstallFixture();
  try {
    fs.writeFileSync(item.stopStatus, "3\n");
    const result = runUninstall(item);
    assert.equal(result.status, 3);
    assert.match(result.stderr, /RECOVERY ATTENTION: hostctl reported status 3/);
    assert.equal(fs.readlinkSync(item.activeLink), "releases/v1");
    assertPreserved(item);
  } finally {
    removeFixture(item);
  }
});

test("Uninstall refuses an unsafe active release helper", () => {
  const item = makeUninstallFixture();
  try {
    fs.writeFileSync(path.join(item.state, "unsafe-owner"), "1\n");
    const result = runUninstall(item);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unavailable or unsafe/);
    assert.doesNotMatch(fs.readFileSync(item.calls, "utf8"), /^host stop$/m);
    assert.equal(fs.readlinkSync(item.activeLink), "releases/v1");
    assertPreserved(item);
  } finally {
    removeFixture(item);
  }
});

for (const [label, mutate, expected] of [
  ["stop refusal", (item) => fs.writeFileSync(item.stopStatus, "1\n"), /hostctl refused to stop/],
  ["malformed stop acknowledgement", (item) => fs.writeFileSync(item.stopOutput, "result=other\n"), /not the exact stopped acknowledgement/],
]) {
  test(`Uninstall preserves the active link on ${label}`, () => {
    const item = makeUninstallFixture();
    try {
      mutate(item);
      const result = runUninstall(item);
      assert.equal(result.status, 1);
      assert.match(result.stderr, expected);
      assert.match(result.stderr, new RegExp(`${item.release.replaceAll("/", "\\/")}\\/hostctl stop`));
      assert.equal(fs.readlinkSync(item.activeLink), "releases/v1");
      assertPreserved(item);
    } finally {
      removeFixture(item);
    }
  });
}

test("Uninstall refuses a changed active release after a successful stop", () => {
  const item = makeUninstallFixture();
  try {
    fs.writeFileSync(path.join(item.state, "swap-link"), "1\n");
    const result = runUninstall(item);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /active release changed after host stop/);
    assert.equal(fs.readlinkSync(item.activeLink), "releases/v2");
    assertPreserved(item);
  } finally {
    removeFixture(item);
  }
});

test("Uninstall propagates transactional deactivation refusal without unlinking", () => {
  const item = makeUninstallFixture();
  try {
    fs.writeFileSync(item.transactionStatus, "3\n");
    const result = runUninstall(item);
    assert.equal(result.status, 3);
    assert.match(result.stderr, /release transaction reported status 3/);
    assert.match(result.stderr, /transactional active-release deactivation did not complete/);
    assert.equal(fs.readlinkSync(item.activeLink), "releases/v1");
    assert.match(fs.readFileSync(item.calls, "utf8"), /^transaction deactivate v1$/m);
    assertPreserved(item);
  } finally {
    removeFixture(item);
  }
});

test("Uninstall retries an exact post-unlink deactivation interruption", () => {
  const item = makeUninstallFixture();
  try {
    fs.writeFileSync(item.transactionFailAfterUnlink, "1\n");
    const result = runUninstall(item);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /injected post-unlink durability failure/);
    assert.match(result.stdout, /result=deactivated[\s\S]*previous=v1/);
    assert.equal(fs.existsSync(item.activeLink), false);
    const calls = fs.readFileSync(item.calls, "utf8");
    assert.equal((calls.match(/^transaction deactivate v1$/gm) ?? []).length, 2);
    assertPreserved(item);
  } finally {
    removeFixture(item);
  }
});

test("Uninstall retries once when an exact active deactivation journal is present", () => {
  const item = makeUninstallFixture();
  try {
    fs.writeFileSync(item.transactionFailWithJournal, "1\n");
    const result = runUninstall(item);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /injected journal fsync failure/);
    assert.equal(fs.existsSync(item.activeLink), false);
    assert.equal(fs.existsSync(item.deactivationRecord), false);
    const calls = fs.readFileSync(item.calls, "utf8");
    assert.equal((calls.match(/^transaction deactivate v1$/gm) ?? []).length, 2);
    assertPreserved(item);
  } finally {
    removeFixture(item);
  }
});

test("Uninstall does not retry an active deactivation journal for another release", () => {
  const item = makeUninstallFixture();
  try {
    fs.writeFileSync(item.transactionStatus, "1\n");
    fs.writeFileSync(
      item.deactivationRecord,
      "DEACTIVATION_RECORD_VERSION=1\nEXPECTED=v2\n",
      { mode: 0o600 },
    );
    const result = runUninstall(item);
    assert.equal(result.status, 1);
    assert.equal(fs.readlinkSync(item.activeLink), "releases/v1");
    assert.equal((fs.readFileSync(item.calls, "utf8").match(/^transaction deactivate v1$/gm) ?? []).length, 1);
    assert.equal(fs.readFileSync(item.deactivationRecord, "utf8"), "DEACTIVATION_RECORD_VERSION=1\nEXPECTED=v2\n");
    assertPreserved(item);
  } finally {
    removeFixture(item);
  }
});

test("Uninstall removes only the active link after exact stopped acknowledgement", () => {
  const item = makeUninstallFixture();
  try {
    const result = runUninstall(item);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /host stopped and active release link removed/);
    assert.equal(fs.existsSync(item.activeLink), false);
    assertPreserved(item);
    const calls = fs.readFileSync(item.calls, "utf8");
    assert.match(calls, /^kernel status$/m);
    assert.match(calls, /^host stop$/m);
    assert.match(calls, /^transaction deactivate v1$/m);
    assert.match(calls, new RegExp(`^mv -T .+ ${item.recoveryDir.replaceAll("/", "\\/")}$`, "m"));
    assert.match(calls, new RegExp(`^fsync ${path.join(item.dockerRoot, "recovery").replaceAll("/", "\\/")}$`, "m"));
  } finally {
    removeFixture(item);
  }
});
