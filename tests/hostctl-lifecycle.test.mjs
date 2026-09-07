import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  addProcess,
  createHostctlFixture,
  hostctlSource,
  readCalls,
  removeFixture,
  runHostctl,
  runHostctlAs,
  setContainers,
  setLock,
  setManagedDaemon,
  writeExecutable,
} from "./helpers/module-fixture.mjs";

function fixtureTest(name, callback) {
  test(name, () => {
    const item = createHostctlFixture();
    try {
      prepareRoutePolicyFixture(item);
      callback(item);
    } finally {
      removeFixture(item);
    }
  });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function prepareRoutePolicyFixture(item) {
  const busybox = path.join(item.root, "ksu-busybox");
  const rtTables = path.join(item.state, "rt_tables");
  const sysClassNet = path.join(item.root, "sys-class-net");
  const kernelConfig = path.join(item.state, "config.gz");
  fs.mkdirSync(path.join(sysClassNet, "wlan0"), { recursive: true });
  fs.writeFileSync(rtTables, "1016 wlan0\n1050 rmnet_data0\n");
  fs.writeFileSync(path.join(sysClassNet, "wlan0", "ifindex"), "16\n");
  fs.writeFileSync(kernelConfig, [
    "CONFIG_PID_NS=y",
    "CONFIG_IPC_NS=y",
    "CONFIG_USER_NS=y",
    "CONFIG_SYSVIPC=y",
    "CONFIG_POSIX_MQUEUE=y",
    "",
  ].join("\n"));
  writeExecutable(busybox, `#!/bin/sh
printf 'busybox %s\\n' "$*" >> ${shellQuote(item.calls)}
applet=$1
shift
case "$applet" in
  cp) exec /bin/cp "$@" ;;
  chmod) exec /bin/chmod "$@" ;;
  tar) exec /usr/bin/tar "$@" ;;
  zcat) exec /bin/cat "$@" ;;
  timeout)
    [ "$1" = -k ] && [ "$2" = 5 ] && [ "$3" = 240 ] || exit 98
    shift 3
    if [ ! -f ${shellQuote(path.join(item.state, "force-hook-timeout"))} ]; then
      exec "$@"
    fi
    "$@" &
    child=$!
    ready_tries=0
    while [ ! -f ${shellQuote(path.join(item.state, "hook-timeout-ready"))} ]; do
      /bin/kill -0 "$child" 2>/dev/null || { wait "$child"; exit $?; }
      [ "$ready_tries" -lt 200 ] || {
        /bin/kill -KILL "$child" 2>/dev/null || true
        wait "$child" 2>/dev/null || true
        exit 99
      }
      /bin/sleep 0.05
      ready_tries=$((ready_tries + 1))
    done
    /bin/kill -TERM "$child" 2>/dev/null || exit 97
    /bin/sleep 0.05
    /bin/kill -0 "$child" 2>/dev/null || { wait "$child"; exit 96; }
    : > ${shellQuote(path.join(item.state, "hook-survived-term"))}
    /bin/kill -KILL "$child" 2>/dev/null || exit 95
    wait "$child"
    exit $?
    ;;
  *) exit 2 ;;
esac
`);
  writeExecutable(path.join(item.release, "route-policy"), "#!/bin/sh\nexit 0\n");

  const ipExecutable = path.join(item.root, "system-bin", "ip");
  let ipSource = fs.readFileSync(ipExecutable, "utf8");
  const namedTableBranch = "elif [ \"$*\" = '-4 route show table all' ]; then";
  assert.ok(ipSource.includes(namedTableBranch));
  ipSource = ipSource.replace(namedTableBranch, `elif [ "$*" = '-4 route show table 1016' ]; then
  [ "$wifi" = ready ] && printf 'default via 192.0.2.1 dev wlan0\\n'
${namedTableBranch}`);
  fs.writeFileSync(ipExecutable, ipSource, { mode: 0o755 });

  let runnable = fs.readFileSync(item.hostctl, "utf8");
  for (const [from, to] of [
    ["KSU_BUSYBOX=/data/adb/ksu/bin/busybox", `KSU_BUSYBOX=${shellQuote(busybox)}`],
    ["RT_TABLES=/data/misc/net/rt_tables", `RT_TABLES=${shellQuote(rtTables)}`],
    ["SYS_CLASS_NET=/sys/class/net", `SYS_CLASS_NET=${shellQuote(sysClassNet)}`],
    ["KERNEL_CONFIG=/proc/config.gz", `KERNEL_CONFIG=${shellQuote(kernelConfig)}`],
  ]) {
    assert.ok(runnable.includes(from), `missing route-policy fixture replacement: ${from}`);
    runnable = runnable.replace(from, to);
  }
  fs.writeFileSync(item.hostctl, runnable, { mode: 0o755 });
  Object.assign(item, { busybox, rtTables, sysClassNet, kernelConfig });
}

function installRouteDockerFixture(item) {
  const imageId = `sha256:${"a".repeat(64)}`;
  writeExecutable(path.join(item.release, "docker"), `#!/bin/sh
STATE=${shellQuote(item.state)}
CALLS=${shellQuote(item.calls)}
IMAGE_ID=${shellQuote(imageId)}
printf 'docker %s\\n' "$*" >> "$CALLS"
case "\${1:-}" in
  info) test -f "$STATE/docker-info" ;;
  ps)
    [ "\${2:-}" = -q ] || exit 2
    [ ! -f "$STATE/inventory-fail" ] || exit 1
    cat "$STATE/containers"
    ;;
  image)
    case "\${2:-}" in
      import)
        [ "$#" -eq 3 ] && [ "$3" = - ] || exit 2
        [ ! -f "$STATE/route-import-fail" ] || exit 71
        : > "$STATE/route-image-present"
        printf '%s\\n' "$IMAGE_ID"
        ;;
      rm)
        [ "$#" -eq 3 ] && [ "$3" = "$IMAGE_ID" ] || exit 2
        rm -f "$STATE/route-image-present"
        ;;
      *) exit 2 ;;
    esac
    ;;
  run)
    [ "$#" -ge 12 ] && [ "$2" = --pull=never ] && [ "$3" = --rm ] &&
      [ "$4" = --network ] && [ "$5" = host ] && [ "$6" = --privileged ] &&
      [ "$7" = "$IMAGE_ID" ] && [ "$8" = /route-policy ] && [ "$9" = add ] || exit 2
    [ -f "$STATE/route-image-present" ] || exit 72
    [ ! -f "$STATE/route-helper-fail" ] || exit 73
    case "\${10}:$#" in
      to-main:12)
        [ "\${11}" = 172.17.0.0/16 ] && [ "\${12}" = 9990 ] || exit 2
        grep -q '^9990:' "$STATE/rules" ||
          printf '9990: from all to 172.17.0.0/16 lookup main\\n' >> "$STATE/rules"
        ;;
      from-table:13)
        [ "\${11}" = 172.17.0.0/16 ] && [ "\${12}" = 1016 ] && [ "\${13}" = 9991 ] || exit 2
        grep -q '^9991:' "$STATE/rules" ||
          printf '9991: from 172.17.0.0/16 lookup wlan0\\n' >> "$STATE/rules"
        ;;
      *) exit 2 ;;
    esac
    [ ! -f "$STATE/route-helper-exists" ] || exit 3
    ;;
  *) exit 2 ;;
esac
`);
  return imageId;
}

function writeHostConfig(item, {
  autostart = 0,
  size = 268435456,
  cidr = "172.17.0.0/16",
  features = "^has_journal,^casefold",
  mountOptions = "noatime,nodev",
} = {}) {
  fs.writeFileSync(item.configFile, [
    "HOST_CONFIG_VERSION=2",
    `AUTOSTART=${autostart}`,
    `DISK_SIZE_BYTES=${size}`,
    `BRIDGE_POOL_CIDR=${cidr}`,
    `EXT4_FEATURES=${features}`,
    `MOUNT_OPTIONS=${mountOptions}`,
    "",
  ].join("\n"));
}

function clearPreparedStorage(item) {
  fs.rmSync(item.disk, { force: true });
  fs.writeFileSync(item.mounts, "");
  fs.writeFileSync(item.loopState, "none\n");
}

function installWorkloadProfile(item, {
  id = "fixture.profile",
  source = null,
} = {}) {
  const profileDir = path.join(item.workloadProfilesRoot, id);
  const hook = path.join(profileDir, "hook");
  fs.chmodSync(item.configDir, 0o700);
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(item.workloadProfilesRoot, 0o700);
  fs.chmodSync(profileDir, 0o700);
  writeExecutable(hook, source ?? `#!/bin/sh
LOCK=${shellQuote(path.join(item.runRoot, "host-lifecycle.lock", "pid"))}
[ "$#" -eq 1 ] || exit 91
case "$1" in post-start|pre-stop) ;; *) exit 92 ;; esac
[ -f "$LOCK" ] || exit 93
[ "$PATH" = ${shellQuote(`${path.join(item.root, "system-bin")}:/usr/bin:/bin`)} ] || exit 94
[ "$DOCKER_HOST" = ${shellQuote(`unix://${path.join(item.runRoot, "docker.sock")}`)} ] || exit 95
[ "$WORKLOAD_PROFILE_ID" = ${shellQuote(id)} ] || exit 96
[ "\${HOME+x}" != x ] || exit 97
printf 'workload-hook %s lock=held\n' "$1" >> ${shellQuote(item.calls)}
`);
  fs.chmodSync(hook, 0o700);
  const contents = fs.readFileSync(hook);
  const hash = crypto.createHash("sha256").update(contents).digest("hex");
  fs.writeFileSync(item.workloadProfileFile, [
    "WORKLOAD_PROFILE_VERSION=1",
    `PROFILE_ID=${id}`,
    `HOOK_SIZE=${contents.length}`,
    `HOOK_SHA256=${hash}`,
    "",
  ].join("\n"), { mode: 0o600 });
  fs.chmodSync(item.workloadProfileFile, 0o600);
  return { profileDir, hook, hash };
}

test("hostctl exposes only the bounded generic lifecycle contract", () => {
  assert.match(hostctlSource, /^LOCK_DIR=\$RUN_ROOT\/host-lifecycle\.lock$/m);
  assert.match(hostctlSource, /^LOCK_RECOVERY=\$LOCK_DIR\/\.recovery$/m);
  assert.equal((hostctlSource.match(/\/data\/docker\/run\/host-lifecycle\.lock/g) ?? []).length, 0);
  assert.match(hostctlSource, /^\s*"\$KILL" -TERM "\$STOP_PID"/m);
  assert.match(hostctlSource, /HOSTCTL_RUNTIME_ONLY_CONTRACT=1/);
  assert.match(hostctlSource, /"\$SETSID" "\$EXPECTED_DOCKERD_SCRIPT" --runtime-only[^\n]*&$/m);
  assert.match(hostctlSource, /^DEFAULT_BRIDGE_POOL_CIDR=172\.17\.0\.0\/16$/m);
  assert.doesNotMatch(hostctlSource, /"\$IP" -4 rule add/);
  assert.match(hostctlSource, /"\$EXPECTED_DOCKER" image import -/);
  assert.match(hostctlSource, /run --pull=never --rm --network host --privileged/);
  assert.match(hostctlSource, /"\$ROUTE_POLICY_IMAGE" \/route-policy add to-main/);
  assert.match(hostctlSource, /"\$ROUTE_POLICY_IMAGE" \/route-policy add from-table/);
  assert.match(hostctlSource, /^RT_TABLES=\/data\/misc\/net\/rt_tables$/m);
  assert.match(hostctlSource, /^PATH=\$SYSTEM_BIN$/m);
  assert.doesNotMatch(hostctlSource, /^PATH=.*DOCKER_ROOT/m);
  assert.doesNotMatch(hostctlSource, /(?:^|[;&|]\s*)(?:umount|curl|wget)\b/m);
  assert.doesNotMatch(hostctlSource, /(?:kill|\$KILL)\s+-(?:9|KILL)\b/);
  assert.match(hostctlSource, /^WORKLOAD_PROFILE_FILE=\$CONFIG_DIR\/workload-profile\.conf$/m);
  assert.match(hostctlSource, /^WORKLOAD_PROFILES_ROOT=\$DOCKER_ROOT\/workload-profiles$/m);
  assert.match(hostctlSource, /"\$ENV" -i PATH="\$PATH" DOCKER_HOST="\$DOCKER_HOST"/);
  assert.match(hostctlSource, /"\$KSU_BUSYBOX" timeout -k "\$WORKLOAD_HOOK_KILL_GRACE_SECONDS"/);
  assert.match(hostctlSource, /"\$WORKLOAD_PROFILE_HOOK" "\$WORKLOAD_PROFILE_PHASE" <\/dev\/null 1>&2/);
  assert.doesNotMatch(hostctlSource, /\beval\b|(?:sh|bash)\s+-c|companion|provider/i);
  assert.doesNotMatch(hostctlSource, /(?:curl|wget)|"\$EXPECTED_DOCKER" pull/);
});

fixtureTest("an absent workload profile preserves the inert host lifecycle", (item) => {
  fs.mkdirSync(path.join(item.workloadProfilesRoot, "inactive"), { recursive: true });
  fs.writeFileSync(path.join(item.workloadProfilesRoot, "inactive", "hook"), "not active\n");
  const result = runHostctl(item, "start");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "result=running\n");
  assert.doesNotMatch(readCalls(item), /workload-hook/);
});

fixtureTest("start runs the exact post-start hook under the lifecycle lock after host readiness", (item) => {
  installWorkloadProfile(item);
  let result = runHostctl(item, "start");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "result=running\n");
  let calls = readCalls(item);
  assert.equal((calls.match(/^workload-hook post-start lock=held$/gm) ?? []).length, 1);
  assert.ok(calls.indexOf("dockerd.sh --runtime-only") < calls.indexOf("workload-hook post-start"));

  result = runHostctl(item, "start");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "result=running\n");
  calls = readCalls(item);
  assert.equal((calls.match(/^workload-hook post-start lock=held$/gm) ?? []).length, 2);
  assert.equal((calls.match(/^setsid .*\/dockerd\.sh --runtime-only$/gm) ?? []).length, 1);
});

fixtureTest("a post-start hook failure is visible and leaves the ready daemon running", (item) => {
  installWorkloadProfile(item, { source: `#!/bin/sh
printf 'workload-hook %s failed\n' "$1" >> ${shellQuote(item.calls)}
exit 73
` });
  const result = runHostctl(item, "start");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /fixture\.profile post-start hook failed \(status=73\)/);
  assert.equal(fs.existsSync(path.join(item.procRoot, "4242")), true);
  assert.doesNotMatch(readCalls(item), /^kill /m);
});

fixtureTest("a successful post-start hook cannot conceal a changed host daemon", (item) => {
  installWorkloadProfile(item, { source: `#!/bin/sh
/bin/rm -rf ${shellQuote(path.join(item.procRoot, "4242"))}
/bin/rm -f ${shellQuote(path.join(item.state, "docker-info"))} ${shellQuote(path.join(item.runRoot, "docker.pid"))}
exit 0
` });
  const result = runHostctl(item, "start");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /daemon identity changed during the workload post-start hook/);
  assert.doesNotMatch(readCalls(item), /^kill /m);
});

fixtureTest("pre-stop can park managed containers before the zero-container gate", (item) => {
  setManagedDaemon(item);
  setContainers(item, ["a".repeat(12)]);
  installWorkloadProfile(item, { source: `#!/bin/sh
[ "$#" -eq 1 ] && [ "$1" = pre-stop ] || exit 74
[ -f ${shellQuote(path.join(item.runRoot, "host-lifecycle.lock", "pid"))} ] || exit 75
printf 'workload-hook pre-stop lock=held\n' >> ${shellQuote(item.calls)}
: > ${shellQuote(path.join(item.state, "containers"))}
` });
  const result = runHostctl(item, "stop");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "result=stopped\n");
  const calls = readCalls(item);
  assert.ok(calls.indexOf("workload-hook pre-stop") < calls.indexOf("docker ps -q"));
  assert.ok(calls.indexOf("docker ps -q") < calls.indexOf("kill -TERM"));
});

fixtureTest("a pre-stop hook failure sends no signal and skips container inventory", (item) => {
  setManagedDaemon(item);
  setContainers(item, ["a".repeat(12)]);
  installWorkloadProfile(item, { source: "#!/bin/sh\nexit 76\n" });
  const result = runHostctl(item, "stop");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /fixture\.profile pre-stop hook failed \(status=76\)/);
  assert.doesNotMatch(readCalls(item), /^docker ps -q$|^kill /m);
  assert.equal(fs.existsSync(path.join(item.procRoot, "4242")), true);
});

fixtureTest("a TERM-resistant timed-out pre-stop hook is KILL-bounded before inventory or daemon TERM", (item) => {
  setManagedDaemon(item);
  fs.writeFileSync(path.join(item.state, "force-hook-timeout"), "1\n");
  installWorkloadProfile(item, { source: `#!/bin/sh
trap '' TERM
: > ${shellQuote(path.join(item.state, "hook-timeout-ready"))}
while :; do :; done
` });
  const result = runHostctl(item, "stop");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /pre-stop hook failed \(status=137\)/);
  assert.equal(fs.existsSync(path.join(item.state, "hook-survived-term")), true);
  assert.doesNotMatch(readCalls(item), /^docker ps -q$|^kill /m);
  assert.equal(fs.existsSync(path.join(item.procRoot, "4242")), true);
});

for (const [label, hookBody] of [
  ["removes the lifecycle lock", (item) => `/bin/rm -f ${shellQuote(path.join(item.runRoot, "host-lifecycle.lock", "pid"))}
/bin/rmdir ${shellQuote(path.join(item.runRoot, "host-lifecycle.lock"))}
`],
  ["replaces the lifecycle owner", (item) => `/bin/rm -f ${shellQuote(path.join(item.runRoot, "host-lifecycle.lock", "pid"))}
printf '999999\\n' > ${shellQuote(path.join(item.runRoot, "host-lifecycle.lock", "pid"))}
/bin/chmod 0600 ${shellQuote(path.join(item.runRoot, "host-lifecycle.lock", "pid"))}
`],
]) {
  fixtureTest(`a successful pre-stop hook that ${label} cannot reach inventory or TERM`, (item) => {
    setManagedDaemon(item);
    installWorkloadProfile(item, { source: `#!/bin/sh
${hookBody(item)}exit 0
` });
    const result = runHostctl(item, "stop");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /lifecycle lock (?:ownership|identity) changed during the workload hook/);
    assert.doesNotMatch(readCalls(item), /^docker ps -q$|^kill /m);
    assert.equal(fs.existsSync(path.join(item.procRoot, "4242")), true);
  });
}

for (const [label, mutate] of [
  ["unsafe ID", (item) => fs.writeFileSync(
    item.workloadProfileFile,
    fs.readFileSync(item.workloadProfileFile, "utf8").replace("PROFILE_ID=fixture.profile", "PROFILE_ID=../outside"),
  )],
  ["descriptor extension", (item) => fs.appendFileSync(item.workloadProfileFile, "HOOK_PATH=/tmp/other\n")],
  ["missing final LF", (item) => fs.writeFileSync(
    item.workloadProfileFile,
    fs.readFileSync(item.workloadProfileFile, "utf8").replace(/\n$/, ""),
  )],
  ["hook hash mismatch", (_item, profile) => fs.appendFileSync(profile.hook, "# changed\n")],
  ["hook mode mismatch", (_item, profile) => fs.chmodSync(profile.hook, 0o755)],
  ["unexpected selected-profile member", (_item, profile) => fs.writeFileSync(path.join(profile.profileDir, "extra"), "x\n")],
]) {
  fixtureTest(`a workload profile ${label} fails closed before host mutation`, (item) => {
    const profile = installWorkloadProfile(item);
    mutate(item, profile);
    const result = runHostctl(item, "start");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /configured workload profile is malformed, tampered, or unsafe/);
    assert.doesNotMatch(readCalls(item), /^(?:mount|iptables .* -I|setsid|dockerd\.sh|workload-hook) /m);
    assert.equal(fs.existsSync(path.join(item.procRoot, "4242")), false);
  });
}

fixtureTest("hostctl is root-only", (item) => {
  const result = runHostctlAs(item, 2000, "status");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /root is required/);
});

fixtureTest("missing config defaults autostart off", (item) => {
  fs.rmSync(item.configFile);
  fs.rmSync(item.disk);
  fs.writeFileSync(item.mounts, "");
  fs.writeFileSync(item.loopState, "none\n");
  const result = runHostctl(item, "status");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, [
    "schema_version=2",
    "daemon=stopped",
    "containers=0",
    "autostart=off",
    "host_config=missing",
    "disk=absent",
    "mount=unmounted",
    "wifi_interface=ready",
    "bridge_routes=unconfigured",
    "wifi_policy=unconfigured",
    "ipv4_forwarding=on",
    "api_firewall=ready",
    "",
  ].join("\n"));
});

fixtureTest("a live lifecycle lock refuses the operation and remains intact", (item) => {
  fs.rmSync(item.configFile);
  const lock = setLock(item, 777, { live: true });
  const result = runHostctl(item, "autostart", "on");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /operation is in progress/);
  assert.equal(fs.readFileSync(path.join(lock, "pid"), "utf8"), "777\n");
  assert.equal(fs.existsSync(item.configFile), false);
});

fixtureTest("a malformed lifecycle lock fails closed", (item) => {
  fs.rmSync(item.configFile);
  const lock = setLock(item, "not-a-pid");
  const result = runHostctl(item, "autostart", "on");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /owner is malformed/);
  assert.equal(fs.existsSync(lock), true);
  assert.equal(fs.existsSync(item.configFile), false);
});

fixtureTest("a stale lifecycle lock is recovered only from its exact shape", (item) => {
  const lock = setLock(item, 777);
  const result = runHostctl(item, "autostart", "on");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.existsSync(path.join(item.runRoot, "host-lifecycle.lock", ".recovery")), false);
  assert.equal(fs.readFileSync(item.configFile, "utf8"), [
    "HOST_CONFIG_VERSION=2", "AUTOSTART=1", "DISK_SIZE_BYTES=268435456",
    "BRIDGE_POOL_CIDR=172.17.0.0/16", "EXT4_FEATURES=^has_journal,^casefold",
    "MOUNT_OPTIONS=noatime,nodev", "",
  ].join("\n"));
});

fixtureTest("a delayed stale recoverer refuses a changed owner without replacing the lock directory", (item) => {
  fs.rmSync(item.configFile);
  const lock = setLock(item, 777);
  const lockInode = fs.statSync(lock).ino;
  const changedPid = 888;
  const systemBin = path.join(item.root, "system-bin");
  writeExecutable(path.join(systemBin, "mkdir"), `#!/bin/sh
LOCK=${JSON.stringify(lock)}
PROC=${JSON.stringify(item.procRoot)}
if [ "$#" -eq 1 ] && [ "$1" = "$LOCK/.recovery" ]; then
  /bin/mkdir "$PROC/${changedPid}" || exit 1
  printf '${changedPid}\\n' > "$LOCK/pid" || exit 1
fi
exec /bin/mkdir "$@"
`);

  const result = runHostctl(item, "autostart", "on");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /owner changed during stale recovery/);
  assert.equal(fs.statSync(lock).ino, lockInode);
  assert.equal(fs.readFileSync(path.join(lock, "pid"), "utf8"), `${changedPid}\n`);
  assert.equal(fs.existsSync(path.join(lock, ".recovery")), false);
  assert.equal(fs.existsSync(item.configFile), false);
});

fixtureTest("a stale lock is preserved when the process directory is unavailable", (item) => {
  fs.rmSync(item.configFile);
  const lock = setLock(item, 777);
  const lockInode = fs.statSync(lock).ino;
  fs.rmSync(item.procRoot, { recursive: true });

  const result = runHostctl(item, "autostart", "on");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /process directory is unavailable; refusing lock recovery/);
  assert.equal(fs.statSync(lock).ino, lockInode);
  assert.equal(fs.readFileSync(path.join(lock, "pid"), "utf8"), "777\n");
  assert.equal(fs.existsSync(path.join(lock, ".recovery")), false);
  assert.equal(fs.existsSync(item.configFile), false);
});

fixtureTest("a stale lock with unexpected content is not recovered", (item) => {
  const lock = setLock(item, 777, { extra: true });
  const result = runHostctl(item, "autostart", "on");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unexpected state/);
  assert.equal(fs.existsSync(lock), true);
});

fixtureTest("start refuses an unmanaged daemon resolved to the active release", (item) => {
  addProcess(item, 5001);
  const result = runHostctl(item, "start");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unmanaged-daemon/);
  assert.doesNotMatch(readCalls(item), /setsid|dockerd\.sh/);
});

fixtureTest("start refuses the active daemon executable with a wrong argv0", (item) => {
  addProcess(item, 5001, path.join(item.release, "dockerd"), "/unexpected/dockerd");
  const result = runHostctl(item, "start");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /daemon-argv0-mismatch/);
  assert.doesNotMatch(readCalls(item), /setsid|dockerd\.sh/);
});

fixtureTest("start refuses a stable daemon argv0 with a foreign executable", (item) => {
  const oldDaemon = path.join(item.root, "old-release", "dockerd");
  writeExecutable(oldDaemon, "#!/bin/sh\nexit 0\n");
  addProcess(item, 5001, oldDaemon, path.join(item.dockerRoot, "bin", "dockerd"));
  const result = runHostctl(item, "start");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /daemon-exe-mismatch/);
  assert.doesNotMatch(readCalls(item), /setsid|dockerd\.sh/);
  assert.equal(fs.existsSync(path.join(item.procRoot, "5001")), true);
});

fixtureTest("start refuses a stable containerd argv0 from an old release", (item) => {
  const oldContainerd = path.join(item.root, "old-release", "containerd");
  writeExecutable(oldContainerd, "#!/bin/sh\nexit 0\n");
  addProcess(item, 5002, oldContainerd, path.join(item.dockerRoot, "bin", "containerd"));
  const result = runHostctl(item, "start");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /containerd-exe-mismatch/);
  assert.doesNotMatch(readCalls(item), /setsid|dockerd\.sh/);
  assert.equal(fs.existsSync(path.join(item.procRoot, "5002")), true);
});

fixtureTest("running state accepts dockerd-launched containerd with a basename argv0", (item) => {
  setManagedDaemon(item);
  addProcess(item, 5002, path.join(item.release, "containerd"), "containerd");
  const result = runHostctl(item, "status");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^daemon=running$/m);
});

for (const component of ["dockerd", "containerd"]) {
  fixtureTest(`start refuses a resolved ${component} argv0 from an old release`, (item) => {
    const oldExecutable = path.join(item.dockerRoot, "releases", "v0.0.9", component);
    writeExecutable(oldExecutable, "#!/bin/sh\nexit 0\n");
    addProcess(item, 5001, oldExecutable, oldExecutable);
    const result = runHostctl(item, "start");
    assert.notEqual(result.status, 0);
    const expectedState = component === "dockerd" ? "daemon-exe-mismatch" : "containerd-exe-mismatch";
    assert.match(result.stderr, new RegExp(expectedState));
    assert.doesNotMatch(readCalls(item), /setsid|dockerd\.sh/);
    assert.equal(fs.existsSync(path.join(item.procRoot, "5001")), true);
  });
}

fixtureTest("start refuses duplicate daemons", (item) => {
  addProcess(item, 5001);
  addProcess(item, 5002);
  fs.writeFileSync(path.join(item.runRoot, "docker.pid"), "5001\n");
  const result = runHostctl(item, "start");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /multiple-daemons/);
  assert.doesNotMatch(readCalls(item), /setsid|dockerd\.sh/);
});

fixtureTest("stop refuses a pidfile that resolves to a foreign process", (item) => {
  const foreign = path.join(item.root, "foreign-daemon");
  fs.writeFileSync(foreign, "foreign\n");
  addProcess(item, 4242, foreign, foreign);
  fs.writeFileSync(path.join(item.runRoot, "docker.pid"), "4242\n");
  fs.writeFileSync(path.join(item.state, "docker-info"), "ready\n");
  const result = runHostctl(item, "stop");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /foreign-pid/);
  assert.doesNotMatch(readCalls(item), /^kill /m);
});

fixtureTest("stop refuses while any running container is reported", (item) => {
  setManagedDaemon(item);
  setContainers(item, ["a".repeat(12)]);
  const result = runHostctl(item, "stop");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /1 running container/);
  assert.doesNotMatch(readCalls(item), /^kill /m);
  assert.equal(fs.existsSync(path.join(item.procRoot, "4242")), true);
});

fixtureTest("stop refuses when container inventory is unknown", (item) => {
  setManagedDaemon(item);
  fs.writeFileSync(path.join(item.state, "inventory-fail"), "fail\n");
  const result = runHostctl(item, "stop");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /inventory is unknown/);
  assert.doesNotMatch(readCalls(item), /^kill /m);
  assert.equal(fs.existsSync(path.join(item.procRoot, "4242")), true);
});

fixtureTest("stop sends exactly TERM to the re-proved managed daemon", (item) => {
  setManagedDaemon(item);
  const result = runHostctl(item, "stop");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "result=stopped\n");
  assert.equal((readCalls(item).match(/^kill -TERM 4242$/gm) ?? []).length, 1);
  assert.equal(fs.existsSync(path.join(item.procRoot, "4242")), false);
  assert.equal(fs.existsSync(path.join(item.runRoot, "docker.pid")), false);
});

fixtureTest("start is idempotent for the exact managed daemon", (item) => {
  setManagedDaemon(item);
  const result = runHostctl(item, "start");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "result=running\n");
  assert.doesNotMatch(readCalls(item), /setsid|dockerd\.sh/);
});

fixtureTest("start delegates only prepared-host runtime startup", (item) => {
  const result = runHostctl(item, "start");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "result=running\n");
  const calls = readCalls(item);
  assert.equal((calls.match(/^setsid .*\/dockerd\.sh --runtime-only$/gm) ?? []).length, 1);
  assert.equal((calls.match(/^dockerd\.sh --runtime-only$/gm) ?? []).length, 1);
  assert.equal(fs.realpathSync(path.join(item.procRoot, "4242", "exe")), path.join(item.release, "dockerd"));
});

fixtureTest("start refuses when the running kernel configuration is unavailable", (item) => {
  fs.rmSync(item.kernelConfig);
  const result = runHostctl(item, "start");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /running kernel configuration is unavailable/);
  assert.doesNotMatch(readCalls(item), /^(?:mount|iptables .* -I|docker image import|setsid) /m);
});

fixtureTest("start refuses a stock kernel missing a required namespace capability", (item) => {
  fs.writeFileSync(item.kernelConfig, [
    "CONFIG_PID_NS=y",
    "CONFIG_IPC_NS=y",
    "# CONFIG_USER_NS is not set",
    "CONFIG_SYSVIPC=y",
    "CONFIG_POSIX_MQUEUE=y",
    "",
  ].join("\n"));
  const result = runHostctl(item, "start");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /required Docker kernel capabilities are unavailable/);
  assert.doesNotMatch(readCalls(item), /^(?:mount|iptables .* -I|docker image import|setsid) /m);
});

for (const component of ["docker", "dockerd.sh"]) {
  fixtureTest(`start refuses a ${component} symlink escaping the active release`, (item) => {
    const outside = path.join(item.root, `outside-${component.replace(".", "-")}`);
    const executed = path.join(item.root, "outside-executed");
    writeExecutable(outside, `#!/bin/sh\nHOSTCTL_RUNTIME_ONLY_CONTRACT=1\n: > ${JSON.stringify(executed)}\nexit 0\n`);
    fs.rmSync(path.join(item.release, component));
    fs.symlinkSync(outside, path.join(item.release, component));
    const result = runHostctl(item, "start");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid-active-release/);
    assert.equal(fs.existsSync(executed), false);
    assert.doesNotMatch(readCalls(item), /setsid|dockerd\.sh/);
  });
}

fixtureTest("hostctl lifecycle utilities cannot be shadowed by the active release", (item) => {
  const shadowed = path.join(item.root, "shadowed-command-ran");
  writeExecutable(path.join(item.release, "mkdir"), `#!/bin/sh\n: > ${JSON.stringify(shadowed)}\nexit 1\n`);
  const result = runHostctl(item, "autostart", "on");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(shadowed), false);
});

fixtureTest("autostart updates are exact, atomic, and owner-only", (item) => {
  let result = runHostctl(item, "autostart", "on");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(item.configFile, "utf8"), [
    "HOST_CONFIG_VERSION=2", "AUTOSTART=1", "DISK_SIZE_BYTES=268435456",
    "BRIDGE_POOL_CIDR=172.17.0.0/16", "EXT4_FEATURES=^has_journal,^casefold",
    "MOUNT_OPTIONS=noatime,nodev", "",
  ].join("\n"));
  assert.equal(fs.statSync(item.configFile).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(item.configDir), ["host.conf"]);

  result = runHostctl(item, "autostart", "off");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(item.configFile, "utf8"), [
    "HOST_CONFIG_VERSION=2", "AUTOSTART=0", "DISK_SIZE_BYTES=268435456",
    "BRIDGE_POOL_CIDR=172.17.0.0/16", "EXT4_FEATURES=^has_journal,^casefold",
    "MOUNT_OPTIONS=noatime,nodev", "",
  ].join("\n"));
  assert.equal(fs.statSync(item.configFile).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(item.configDir), ["host.conf"]);
});

fixtureTest("autostart refuses and preserves an existing malformed config", (item) => {
  const malformed = "HOST_CONFIG_VERSION=1\nAUTOSTART=1\nEXTRA=1\n";
  fs.writeFileSync(item.configFile, malformed);
  const result = runHostctl(item, "autostart", "off");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /existing host config is malformed or unsafe/);
  assert.equal(fs.readFileSync(item.configFile, "utf8"), malformed);
  assert.deepEqual(fs.readdirSync(item.configDir), ["host.conf"]);
  assert.equal(fs.existsSync(path.join(item.runRoot, "host-lifecycle.lock")), false);
});

for (const dangling of [false, true]) {
  fixtureTest(`autostart refuses and preserves an existing ${dangling ? "dangling " : ""}config symlink`, (item) => {
    fs.rmSync(item.configFile);
    const target = path.join(item.root, dangling ? "missing-config" : "symlink-target");
    if (!dangling) fs.writeFileSync(target, "HOST_CONFIG_VERSION=1\nAUTOSTART=1\n");
    fs.symlinkSync(target, item.configFile);
    const result = runHostctl(item, "autostart", "off");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /existing host config is malformed or unsafe/);
    assert.equal(fs.lstatSync(item.configFile).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(item.configFile), target);
    if (!dangling) assert.equal(fs.readFileSync(target, "utf8"), "HOST_CONFIG_VERSION=1\nAUTOSTART=1\n");
    assert.deepEqual(fs.readdirSync(item.configDir), ["host.conf"]);
    assert.equal(fs.existsSync(path.join(item.runRoot, "host-lifecycle.lock")), false);
  });
}

fixtureTest("start refuses a zero-size config without allocating a disk", (item) => {
  clearPreparedStorage(item);
  writeHostConfig(item, { size: 0 });

  const result = runHostctl(item, "start");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /disk size is unconfigured.*hostctl disk-init --size-bytes BYTES/);
  assert.equal(fs.existsSync(item.disk), false);
  assert.doesNotMatch(readCalls(item), /^(?:truncate|mke2fs|mount|setsid|dockerd\.sh) /m);
});

fixtureTest("disk-init explicitly configures, creates, checks, and mounts one sparse image", (item) => {
  clearPreparedStorage(item);
  writeHostConfig(item, { size: 0 });

  const result = runHostctl(item, "disk-init", "--size-bytes", "268435456");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "result=disk-ready\n");
  assert.equal(fs.existsSync(item.disk), true);
  assert.match(fs.readFileSync(item.configFile, "utf8"), /^DISK_SIZE_BYTES=268435456$/m);
  assert.match(fs.readFileSync(item.mounts, "utf8"), new RegExp(`^${item.loopDevice} .* ext4 rw,noatime,nodev 0 0$`, "m"));
  const calls = readCalls(item);
  assert.match(calls, /^truncate -s 268435456 .*\.disk\.img\.hostctl\.[0-9]+$/m);
  assert.match(calls, /^mke2fs -q -t ext4 -O \^has_journal,\^casefold /m);
  assert.match(calls, /^e2fsck -fn /m);
  assert.match(calls, /^mount -t ext4 -o noatime,nodev /m);
  assert.doesNotMatch(calls, /setsid|dockerd\.sh/);
});

test("large disk gates avoid Android mksh integer arithmetic", () => {
  assert.doesNotMatch(hostctlSource, /\[ "\$VALIDATE_SIZE" -(?:ge|le)/);
  assert.doesNotMatch(hostctlSource, /\$\(\(VALIDATE_SIZE % 4096\)\)/);
  assert.doesNotMatch(hostctlSource, /AVAILABLE_BYTES=\$\(\(AVAILABLE_KIB \* 1024\)\)/);
  assert.doesNotMatch(hostctlSource, /REQUIRED_BYTES=\$\(\(DISK_SIZE_BYTES \+ DISK_FREE_MARGIN_BYTES\)\)/);
  assert.match(hostctlSource, /exit !\(size >= minimum && size <= maximum && \(size % 4096\) == 0\)/);
  assert.match(hostctlSource, /exit !\(\(available_kib \* 1024\) >= required\)/);
});

fixtureTest("disk-init binds an existing 64 GiB image without recreating it", (item) => {
  writeHostConfig(item, { size: 0 });
  fs.writeFileSync(item.diskSize, "68719476736\n");

  const result = runHostctl(item, "disk-init", "--size-bytes", "68719476736");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "result=disk-ready\n");
  assert.match(fs.readFileSync(item.configFile, "utf8"), /^DISK_SIZE_BYTES=68719476736$/m);
  assert.doesNotMatch(readCalls(item), /^(?:truncate|mke2fs) /m);
});

fixtureTest("disk-init creates a 64 GiB image when free space is sufficient", (item) => {
  clearPreparedStorage(item);
  writeHostConfig(item, { size: 0 });
  fs.writeFileSync(item.freeKib, "100000000\n");

  const result = runHostctl(item, "disk-init", "--size-bytes", "68719476736");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "result=disk-ready\n");
  assert.match(readCalls(item), /^truncate -s 68719476736 /m);
});

fixtureTest("disk-init refuses a 64 GiB image when free space is insufficient", (item) => {
  clearPreparedStorage(item);
  writeHostConfig(item, { size: 0 });
  fs.writeFileSync(item.freeKib, "1048576\n");

  const result = runHostctl(item, "disk-init", "--size-bytes", "68719476736");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /insufficient free space/);
  assert.doesNotMatch(readCalls(item), /^(?:truncate|mke2fs) /m);
});

for (const invalidSize of ["64G", "268435455", "268435457", "01073741824", "1099511631872"]) {
  fixtureTest(`disk-init rejects invalid explicit size ${invalidSize}`, (item) => {
    clearPreparedStorage(item);
    writeHostConfig(item, { size: 0 });
    const before = fs.readFileSync(item.configFile, "utf8");
    const result = runHostctl(item, "disk-init", "--size-bytes", invalidSize);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /disk size must be decimal, 4096-byte aligned/);
    assert.equal(fs.readFileSync(item.configFile, "utf8"), before);
    assert.equal(fs.existsSync(item.disk), false);
  });
}

fixtureTest("a dirty unmounted image refuses with an explicit offline repair command", (item) => {
  fs.writeFileSync(item.mounts, "");
  fs.writeFileSync(item.fsckState, "dirty\n");
  const result = runHostctl(item, "start");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /e2fsck -f \/data\/docker\/disk\.img/);
  assert.doesNotMatch(readCalls(item), /^mount |setsid|dockerd\.sh/m);
  assert.equal(fs.existsSync(item.disk), true);
});

fixtureTest("an existing non-ext4 mount refuses without unmounting or launching", (item) => {
  fs.writeFileSync(item.mounts, `${item.loopDevice} ${item.data} xfs rw,noatime,nodev 0 0\n`);
  const result = runHostctl(item, "start");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /state=wrong-filesystem.*refusing unmount or replacement/);
  assert.equal(fs.readFileSync(item.mounts, "utf8").includes(" xfs "), true);
  assert.doesNotMatch(readCalls(item), /setsid|dockerd\.sh/);
});

fixtureTest("bridge-pool overlap with a non-Docker route refuses before policy or daemon mutation", (item) => {
  fs.writeFileSync(item.routes, [
    "default via 192.0.2.1 dev wlan0 table wlan0",
    "172.17.128.0/17 dev wlan0 proto kernel scope link",
    "",
  ].join("\n"));
  const result = runHostctl(item, "start");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /bridge pool 172\.17\.0\.0\/16 overlaps.*172\.17\.128\.0\/17/);
  assert.doesNotMatch(readCalls(item), /rule add|setsid|dockerd\.sh/);
});

fixtureTest("Docker bridge subnets inside the configured pool remain valid on repeated start", (item) => {
  setManagedDaemon(item);
  fs.writeFileSync(item.routes, [
    "default via 192.0.2.1 dev wlan0 table wlan0",
    "192.0.2.0/24 dev wlan0 proto kernel scope link",
    "172.17.0.0/24 dev docker0 proto kernel scope link",
    "172.17.1.0/24 dev br-0123456789ab proto kernel scope link",
    "",
  ].join("\n"));
  const result = runHostctl(item, "start");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "result=running\n");
  assert.doesNotMatch(readCalls(item), /setsid|dockerd\.sh/);
});

fixtureTest("wlan0 absence refuses without inventing another transport", (item) => {
  fs.writeFileSync(item.wifiState, "absent\n");
  const result = runHostctl(item, "start");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /wlan0 is unavailable.*state=unavailable/);
  assert.doesNotMatch(readCalls(item), /rmnet|ccmni|wwan|setsid|dockerd\.sh/);
});

fixtureTest("repeated start repairs Wi-Fi policy, forwarding, and API prerequisites without a second daemon", (item) => {
  setManagedDaemon(item);
  const imageId = installRouteDockerFixture(item);
  fs.writeFileSync(item.rules, "");
  fs.writeFileSync(item.ipForward, "0\n");
  fs.writeFileSync(item.firewallState, "");

  const result = runHostctl(item, "start");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "result=running\n");
  assert.equal(fs.readFileSync(item.ipForward, "utf8"), "1\n");
  assert.equal(fs.readFileSync(item.rules, "utf8"), [
    "9990: from all to 172.17.0.0/16 lookup main",
    "9991: from 172.17.0.0/16 lookup wlan0",
    "",
  ].join("\n"));
  assert.deepEqual(fs.readFileSync(item.firewallState, "utf8").trim().split("\n").sort(), ["reject", "root", "shell"]);
  const calls = readCalls(item);
  assert.match(calls, /^docker image import -$/m);
  assert.match(calls, new RegExp(`^docker run --pull=never --rm --network host --privileged ${imageId} /route-policy add to-main 172\\.17\\.0\\.0/16 9990$`, "m"));
  assert.match(calls, new RegExp(`^docker run --pull=never --rm --network host --privileged ${imageId} /route-policy add from-table 172\\.17\\.0\\.0/16 1016 9991$`, "m"));
  assert.match(calls, new RegExp(`^docker image rm ${imageId}$`, "m"));
  assert.doesNotMatch(calls, /^docker pull|https?:\/\//m);
  assert.doesNotMatch(calls, /setsid|dockerd\.sh/);
  assert.equal(fs.existsSync(path.join(item.state, "route-image-present")), false);
  assert.equal(fs.readdirSync(item.runRoot).some((name) => name.startsWith(".route-policy.")), false);
});

fixtureTest("existing exact Wi-Fi rules never import or run a policy image", (item) => {
  setManagedDaemon(item);
  installRouteDockerFixture(item);
  const result = runHostctl(item, "start");
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(readCalls(item), /^docker (?:image import|run --pull=never)/m);
});

fixtureTest("route-policy exit 3 is accepted only when exact post-verification converges", (item) => {
  setManagedDaemon(item);
  installRouteDockerFixture(item);
  fs.writeFileSync(item.rules, "");
  fs.writeFileSync(path.join(item.state, "route-helper-exists"), "race\n");
  const result = runHostctl(item, "start");
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(item.rules, "utf8"), /^9990:.*\n9991:/);
  assert.equal(fs.existsSync(path.join(item.state, "route-image-present")), false);
});

fixtureTest("a transient image import failure is visible and leaves a newly started daemon running", (item) => {
  installRouteDockerFixture(item);
  fs.writeFileSync(item.rules, "");
  fs.writeFileSync(path.join(item.state, "route-import-fail"), "fail\n");
  const result = runHostctl(item, "start");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot import the transient route-policy image/);
  assert.equal(fs.existsSync(path.join(item.procRoot, "4242")), true);
  assert.doesNotMatch(readCalls(item), /^kill /m);
  assert.equal(fs.existsSync(path.join(item.state, "route-image-present")), false);
  assert.equal(fs.readdirSync(item.runRoot).some((name) => name.startsWith(".route-policy.")), false);
});

fixtureTest("a route-policy helper failure is visible and removes the exact transient image", (item) => {
  setManagedDaemon(item);
  const imageId = installRouteDockerFixture(item);
  fs.writeFileSync(item.rules, "");
  fs.writeFileSync(path.join(item.state, "route-helper-fail"), "fail\n");
  const result = runHostctl(item, "start");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /route-policy helper failed for to-main \(status=73\)/);
  assert.match(readCalls(item), new RegExp(`^docker image rm ${imageId}$`, "m"));
  assert.equal(fs.existsSync(path.join(item.state, "route-image-present")), false);
  assert.equal(fs.readdirSync(item.runRoot).some((name) => name.startsWith(".route-policy.")), false);
});

fixtureTest("missing policy fails closed on an unauthoritative wlan0 table mapping", (item) => {
  installRouteDockerFixture(item);
  fs.writeFileSync(item.rules, "");
  fs.writeFileSync(item.rtTables, "1017 wlan0\n");
  const result = runHostctl(item, "start");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot resolve the authoritative numeric wlan0 routing table/);
  assert.doesNotMatch(readCalls(item), /^docker (?:image import|run --pull=never)|setsid /m);
});

fixtureTest("a foreign policy rule at an owned preference refuses without replacement", (item) => {
  fs.writeFileSync(item.rules, [
    "9990: from all lookup main",
    "9991: from 172.17.0.0/16 lookup wlan0",
    "",
  ].join("\n"));
  const before = fs.readFileSync(item.rules, "utf8");
  const result = runHostctl(item, "start");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /preference 9990 or 9991 is occupied/);
  assert.equal(fs.readFileSync(item.rules, "utf8"), before);
  assert.doesNotMatch(readCalls(item), /rule add|image import|--privileged|setsid|dockerd\.sh/);
});

fixtureTest("an unmounted clean existing image reuses its sole loop and mounts before launch", (item) => {
  fs.writeFileSync(item.mounts, "");
  const result = runHostctl(item, "start");
  assert.equal(result.status, 0, result.stderr);
  const calls = readCalls(item);
  assert.match(calls, /^e2fsck -fn .*disk\.img$/m);
  assert.match(calls, /^mount -t ext4 -o noatime,nodev /m);
  assert.equal((calls.match(/^losetup -f --show /gm) ?? []).length, 0);
  assert.ok(calls.indexOf("mount -t ext4") < calls.indexOf("dockerd.sh --runtime-only"));
});

fixtureTest("multiple loop associations refuse without mounting or launching", (item) => {
  fs.writeFileSync(item.mounts, "");
  fs.writeFileSync(item.loopState, "multiple\n");
  const result = runHostctl(item, "start");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /disk loop association is unknown|multiple loop associations/);
  assert.doesNotMatch(readCalls(item), /^mount |setsid|dockerd\.sh/m);
});

fixtureTest("a failed mount detaches only the loop allocated by this invocation", (item) => {
  fs.writeFileSync(item.mounts, "");
  fs.writeFileSync(item.loopState, "none\n");
  fs.writeFileSync(path.join(item.state, "mount-fail"), "fail\n");
  const result = runHostctl(item, "start");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot mount the Docker ext4 data image/);
  assert.equal(fs.readFileSync(item.loopState, "utf8"), "none\n");
  assert.match(readCalls(item), /^losetup -d \/dev\/block\/loop7$/m);
  assert.doesNotMatch(readCalls(item), /setsid|dockerd\.sh/);
});

fixtureTest("status reports degraded storage and Wi-Fi truth without mutating them", (item) => {
  fs.writeFileSync(item.mounts, `${item.loopDevice} ${item.data} xfs rw 0 0\n`);
  fs.writeFileSync(item.wifiState, "absent\n");
  fs.writeFileSync(item.rules, "");
  fs.writeFileSync(item.ipForward, "0\n");
  fs.writeFileSync(item.firewallState, "");
  const beforeMounts = fs.readFileSync(item.mounts, "utf8");
  const result = runHostctl(item, "status");
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /^disk=mount-conflict$/m);
  assert.match(result.stdout, /^mount=wrong-filesystem$/m);
  assert.match(result.stdout, /^wifi_interface=unavailable$/m);
  assert.match(result.stdout, /^wifi_policy=missing$/m);
  assert.match(result.stdout, /^ipv4_forwarding=off$/m);
  assert.match(result.stdout, /^api_firewall=missing$/m);
  assert.equal(fs.readFileSync(item.mounts, "utf8"), beforeMounts);
  assert.doesNotMatch(readCalls(item), /rule add|iptables -I|mount -t|setsid|dockerd\.sh/);
});
