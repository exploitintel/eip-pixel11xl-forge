import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const moduleRoot = path.join(projectRoot, "module");
export const hostctlSource = fs.readFileSync(path.join(moduleRoot, "bin", "hostctl"), "utf8");
export const bootCompletedSource = fs.readFileSync(path.join(moduleRoot, "boot-completed.sh"), "utf8");

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function writeExecutable(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, { mode: 0o755 });
}

function replaceRequired(source, from, to) {
  assert.ok(source.includes(from), `missing fixture replacement: ${from}`);
  return source.replaceAll(from, to);
}

export function createHostctlFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pixel-hostctl-")));
  const dockerRoot = path.join(root, "docker");
  const release = path.join(dockerRoot, "releases", "v0.1.0");
  const runRoot = path.join(dockerRoot, "run");
  const configDir = path.join(dockerRoot, "config");
  const workloadProfilesRoot = path.join(dockerRoot, "workload-profiles");
  const procRoot = path.join(root, "proc");
  const systemBin = path.join(root, "system-bin");
  const state = path.join(root, "state");
  const calls = path.join(state, "calls.log");
  const mounts = path.join(state, "mounts");
  const ipForward = path.join(state, "ip-forward");
  const routes = path.join(state, "routes");
  const rules = path.join(state, "rules");
  const wifiState = path.join(state, "wifi-state");
  const firewallState = path.join(state, "firewall-state");
  const loopState = path.join(state, "loop-state");
  const fsckState = path.join(state, "fsck-state");
  const freeKib = path.join(state, "free-kib");
  const disk = path.join(dockerRoot, "disk.img");
  const data = path.join(dockerRoot, "lib");
  const loopDevice = "/dev/block/loop7";

  for (const directory of [release, runRoot, configDir, procRoot, systemBin, state, data]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.symlinkSync(release, path.join(dockerRoot, "bin"), "dir");
  fs.writeFileSync(path.join(state, "containers"), "");
  fs.writeFileSync(path.join(configDir, "host.conf"), [
    "HOST_CONFIG_VERSION=2",
    "AUTOSTART=0",
    "DISK_SIZE_BYTES=268435456",
    "BRIDGE_POOL_CIDR=172.17.0.0/16",
    "EXT4_FEATURES=^has_journal,^casefold",
    "MOUNT_OPTIONS=noatime,nodev",
    "",
  ].join("\n"), { mode: 0o600 });
  fs.writeFileSync(disk, "", { mode: 0o600 });
  fs.writeFileSync(mounts, `${loopDevice} ${data} ext4 rw,noatime,nodev 0 0\n`);
  fs.writeFileSync(ipForward, "1\n");
  fs.writeFileSync(routes, [
    "default via 192.0.2.1 dev wlan0 table wlan0",
    "192.0.2.0/24 dev wlan0 proto kernel scope link",
    "172.17.0.0/16 dev docker0 proto kernel scope link",
    "",
  ].join("\n"));
  fs.writeFileSync(rules, [
    "9990: from all to 172.17.0.0/16 lookup main",
    "9991: from 172.17.0.0/16 lookup wlan0",
    "",
  ].join("\n"));
  fs.writeFileSync(wifiState, "ready\n");
  fs.writeFileSync(firewallState, "root\nshell\nreject\n");
  fs.writeFileSync(loopState, "ready\n");
  fs.writeFileSync(fsckState, "clean\n");
  fs.writeFileSync(freeKib, "2097152\n");

  writeExecutable(path.join(release, "docker"), `#!/bin/sh
STATE=${shellQuote(state)}
printf 'docker %s\\n' "$*" >> ${shellQuote(calls)}
case "\${1:-}" in
  info) test -f "$STATE/docker-info" ;;
  ps)
    [ "\${2:-}" = -q ] || exit 2
    [ ! -f "$STATE/inventory-fail" ] || exit 1
    cat "$STATE/containers"
    ;;
  *) exit 2 ;;
esac
`);
  writeExecutable(path.join(release, "dockerd"), "#!/bin/sh\nexit 0\n");
  writeExecutable(path.join(release, "containerd"), "#!/bin/sh\nexit 0\n");
  writeExecutable(path.join(release, "dockerd.sh"), `#!/bin/sh
HOSTCTL_RUNTIME_ONLY_CONTRACT=1
[ "$#" -eq 1 ] && [ "$1" = --runtime-only ] || exit 2
printf 'dockerd.sh %s\\n' "$*" >> ${shellQuote(calls)}
mkdir -p ${shellQuote(path.join(procRoot, "4242"))}
ln -sf ${shellQuote(path.join(release, "dockerd"))} ${shellQuote(path.join(procRoot, "4242", "exe"))}
printf '%s\\000--fixture\\000' ${shellQuote(path.join(dockerRoot, "bin", "dockerd"))} > ${shellQuote(path.join(procRoot, "4242", "cmdline"))}
printf '4242\\n' > ${shellQuote(path.join(runRoot, "docker.pid"))}
: > ${shellQuote(path.join(state, "docker-info"))}
`);

  writeExecutable(path.join(systemBin, "id"), `#!/bin/sh
[ "\${1:-}" = -u ] || exit 2
printf '%s\\n' "\${FIXTURE_UID:-0}"
`);
  writeExecutable(path.join(systemBin, "env"), "#!/bin/sh\nexec /usr/bin/env \"$@\"\n");
  writeExecutable(path.join(systemBin, "readlink"), `#!/bin/sh
[ "$#" -eq 2 ] && [ "$1" = -f ] || exit 2
exec /bin/realpath "$2"
`);
  writeExecutable(path.join(systemBin, "setsid"), `#!/bin/sh
printf 'setsid %s\\n' "$*" >> ${shellQuote(calls)}
exec "$@"
`);
  writeExecutable(path.join(systemBin, "sleep"), "#!/bin/sh\nexec /bin/sleep 0.05\n");
  writeExecutable(path.join(systemBin, "kill"), `#!/bin/sh
[ "$#" -eq 2 ] && [ "$1" = -TERM ] || exit 2
printf 'kill %s %s\\n' "$1" "$2" >> ${shellQuote(calls)}
rm -rf ${shellQuote(procRoot)}/"$2"
rm -f ${shellQuote(path.join(state, "docker-info"))} ${shellQuote(path.join(runRoot, "docker.sock"))}
`);
  writeExecutable(path.join(systemBin, "awk"), "#!/bin/sh\nexec /usr/bin/awk \"$@\"\n");
  writeExecutable(path.join(systemBin, "stat"), `#!/bin/sh
[ "$#" -eq 3 ] && [ "$1" = -c ] || exit 2
case "$2:$3" in
  %s:${shellQuote(dockerRoot)}/*disk.img*) printf '268435456\n'; exit 0 ;;
esac
case "$2" in
  %s) exec /usr/bin/stat -f %z "$3" ;;
  %u:%g) exec /usr/bin/stat -f %u:%g "$3" ;;
  %a) exec /usr/bin/stat -f %Lp "$3" ;;
  %d:%i:%u:%g:%a) exec /usr/bin/stat -f '%d:%i:%u:%g:%Lp' "$3" ;;
  %d:%i:%u:%g:%a:%h:%s) exec /usr/bin/stat -f '%d:%i:%u:%g:%Lp:%l:%z' "$3" ;;
  *) exit 2 ;;
esac
`);
  const fixtureSha256 = [
    "const fs = require('node:fs');",
    "const crypto = require('node:crypto');",
    "const file = process.argv[1];",
    "process.stdout.write(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') + '  ' + file + '\\n');",
  ].join("");
  writeExecutable(path.join(systemBin, "sha256sum"), `#!/bin/sh
[ "$#" -eq 1 ] || exit 2
exec ${shellQuote(process.execPath)} -e ${shellQuote(fixtureSha256)} "$1"
`);
  writeExecutable(path.join(systemBin, "truncate"), `#!/bin/sh
printf 'truncate %s\n' "$*" >> ${shellQuote(calls)}
[ "$#" -eq 3 ] && [ "$1" = -s ] && [ "$2" = 268435456 ] || exit 2
: > "$3"
`);
  writeExecutable(path.join(systemBin, "ln"), "#!/bin/sh\nexec /bin/ln \"$@\"\n");
  writeExecutable(path.join(systemBin, "sync"), `#!/bin/sh
printf 'sync\n' >> ${shellQuote(calls)}
exit 0
`);
  writeExecutable(path.join(systemBin, "df"), `#!/bin/sh
[ "$#" -eq 2 ] && [ "$1" = -k ] || exit 2
printf 'Filesystem 1K-blocks Used Available Use%% Mounted on\n'
printf 'fixture 999999999 0 %s 0%% /\n' "$(cat ${shellQuote(freeKib)})"
`);
  writeExecutable(path.join(systemBin, "e2fsck"), `#!/bin/sh
printf 'e2fsck %s\n' "$*" >> ${shellQuote(calls)}
[ "$#" -eq 2 ] && [ "$1" = -fn ] || exit 2
[ "$(cat ${shellQuote(fsckState)})" = clean ]
`);
  writeExecutable(path.join(systemBin, "mke2fs"), `#!/bin/sh
printf 'mke2fs %s\n' "$*" >> ${shellQuote(calls)}
[ "$#" -eq 6 ] && [ "$1" = -q ] && [ "$2" = -t ] && [ "$3" = ext4 ] &&
  [ "$4" = -O ] && [ "$5" = '^has_journal,^casefold' ] || exit 2
exit 0
`);
  writeExecutable(path.join(systemBin, "losetup"), `#!/bin/sh
printf 'losetup %s\n' "$*" >> ${shellQuote(calls)}
mode=$(cat ${shellQuote(loopState)})
if [ "$#" -eq 2 ] && [ "$1" = -j ] && [ "$2" = ${shellQuote(disk)} ]; then
  case "$mode" in
    none) exit 0 ;;
    ready) printf '%s: [0000]:0 (%s)\n' ${shellQuote(loopDevice)} ${shellQuote(disk)} ;;
    multiple)
      printf '%s: [0000]:0 (%s)\n' ${shellQuote(loopDevice)} ${shellQuote(disk)}
      printf '/dev/block/loop8: [0000]:0 (%s)\n' ${shellQuote(disk)}
      ;;
    malformed) printf 'not-a-loop (%s)\n' ${shellQuote(disk)} ;;
    fail) exit 1 ;;
    *) exit 2 ;;
  esac
elif [ "$#" -eq 3 ] && [ "$1" = -f ] && [ "$2" = --show ] && [ "$3" = ${shellQuote(disk)} ]; then
  [ "$mode" = none ] || exit 1
  printf 'ready\n' > ${shellQuote(loopState)}
  printf '%s\n' ${shellQuote(loopDevice)}
elif [ "$#" -eq 2 ] && [ "$1" = -d ] && [ "$2" = ${shellQuote(loopDevice)} ]; then
  printf 'none\n' > ${shellQuote(loopState)}
else
  exit 2
fi
`);
  writeExecutable(path.join(systemBin, "mount"), `#!/bin/sh
printf 'mount %s\n' "$*" >> ${shellQuote(calls)}
[ "$#" -eq 6 ] && [ "$1" = -t ] && [ "$2" = ext4 ] && [ "$3" = -o ] &&
  [ "$4" = noatime,nodev ] && [ "$5" = ${shellQuote(loopDevice)} ] &&
  [ "$6" = ${shellQuote(data)} ] || exit 2
[ ! -f ${shellQuote(path.join(state, "mount-fail"))} ] || exit 1
printf '%s %s ext4 rw,noatime,nodev 0 0\n' ${shellQuote(loopDevice)} ${shellQuote(data)} >> ${shellQuote(mounts)}
`);
  writeExecutable(path.join(systemBin, "ip"), `#!/bin/sh
printf 'ip %s\n' "$*" >> ${shellQuote(calls)}
wifi=$(cat ${shellQuote(wifiState)})
if [ "$*" = 'link show dev wlan0' ]; then
  [ "$wifi" != absent ] || exit 1
  printf '7: wlan0: <UP>\n'
elif [ "$*" = '-4 addr show dev wlan0' ]; then
  [ "$wifi" = ready ] && printf '    inet 192.0.2.2/24 scope global wlan0\n'
elif [ "$*" = '-4 route show table wlan0' ]; then
  [ "$wifi" = ready ] && printf 'default via 192.0.2.1 dev wlan0\n'
elif [ "$*" = '-4 route show table all' ]; then
  [ ! -f ${shellQuote(path.join(state, "route-fail"))} ] || exit 1
  cat ${shellQuote(routes)}
elif [ "$*" = '-4 rule show' ]; then
  cat ${shellQuote(rules)}
elif [ "$*" = '-4 rule add to 172.17.0.0/16 lookup main pref 9990' ]; then
  printf '9990: from all to 172.17.0.0/16 lookup main\n' >> ${shellQuote(rules)}
elif [ "$*" = '-4 rule add from 172.17.0.0/16 lookup wlan0 pref 9991' ]; then
  printf '9991: from 172.17.0.0/16 lookup wlan0\n' >> ${shellQuote(rules)}
else
  exit 2
fi
`);
  writeExecutable(path.join(systemBin, "iptables"), `#!/bin/sh
printf 'iptables %s\n' "$*" >> ${shellQuote(calls)}
case "$*" in
  '-C OUTPUT -o lo -p tcp --dport 2375 -m owner --uid-owner 0 -j ACCEPT') key=root ;;
  '-C OUTPUT -o lo -p tcp --dport 2375 -m owner --uid-owner 2000 -j ACCEPT') key=shell ;;
  '-C OUTPUT -o lo -p tcp --dport 2375 -j REJECT') key=reject ;;
  '-I OUTPUT 1 -o lo -p tcp --dport 2375 -m owner --uid-owner 0 -j ACCEPT') key=root; add=1 ;;
  '-I OUTPUT 1 -o lo -p tcp --dport 2375 -m owner --uid-owner 2000 -j ACCEPT') key=shell; add=1 ;;
  '-I OUTPUT 1 -o lo -p tcp --dport 2375 -j REJECT') key=reject; add=1 ;;
  *) exit 2 ;;
esac
if [ "\${add:-0}" = 1 ]; then
  grep -qx "$key" ${shellQuote(firewallState)} || printf '%s\n' "$key" >> ${shellQuote(firewallState)}
else
  grep -qx "$key" ${shellQuote(firewallState)}
fi
`);

  let runnable = hostctlSource;
  const replacements = new Map([
    ["#!/system/bin/sh", "#!/bin/sh"],
    ["DOCKER_ROOT=/data/docker", `DOCKER_ROOT=${shellQuote(dockerRoot)}`],
    ["PROC_ROOT=/proc", `PROC_ROOT=${shellQuote(procRoot)}`],
    ["SYSTEM_BIN=/system/bin", `SYSTEM_BIN=${shellQuote(systemBin)}`],
    ["MOUNTS=/proc/mounts", `MOUNTS=${shellQuote(mounts)}`],
    ["IP_FORWARD=/proc/sys/net/ipv4/ip_forward", `IP_FORWARD=${shellQuote(ipForward)}`],
    ["PATH=$SYSTEM_BIN", `PATH=${systemBin}:/usr/bin:/bin`],
    ["EXPECTED_ROOT_OWNER=0:0", `EXPECTED_ROOT_OWNER=${process.getuid()}:${process.getgid()}`],
    ["READY_TRIES=30", "READY_TRIES=20"],
    ["STOP_TRIES=30", "STOP_TRIES=5"],
    ["SLEEP_SECONDS=2", "SLEEP_SECONDS=0"],
    [
      '"$SETSID" "$EXPECTED_DOCKERD_SCRIPT" --runtime-only </dev/null >/dev/null 2>&1 &',
      '"$SETSID" "$EXPECTED_DOCKERD_SCRIPT" --runtime-only </dev/null >/dev/null 2>&1',
    ],
  ]);
  for (const [from, to] of replacements) runnable = replaceRequired(runnable, from, to);
  const hostctl = path.join(release, "hostctl");
  writeExecutable(hostctl, runnable);

  return {
    root,
    dockerRoot,
    release,
    runRoot,
    configDir,
    configFile: path.join(configDir, "host.conf"),
    workloadProfileFile: path.join(configDir, "workload-profile.conf"),
    workloadProfilesRoot,
    disk,
    data,
    mounts,
    ipForward,
    routes,
    rules,
    wifiState,
    firewallState,
    loopState,
    fsckState,
    freeKib,
    loopDevice,
    procRoot,
    state,
    calls,
    hostctl,
  };
}

export function runHostctl(item, ...args) {
  const result = spawnSync("/bin/sh", [item.hostctl, ...args], {
    encoding: "utf8",
    env: { ...process.env },
    timeout: 60_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, "hostctl must exit normally rather than by signal");
  assert.equal(typeof result.status, "number", "hostctl must produce an exit status");
  return result;
}

export function runHostctlAs(item, uid, ...args) {
  const result = spawnSync("/bin/sh", [item.hostctl, ...args], {
    encoding: "utf8",
    env: { ...process.env, FIXTURE_UID: String(uid) },
    timeout: 60_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, "hostctl must exit normally rather than by signal");
  assert.equal(typeof result.status, "number", "hostctl must produce an exit status");
  return result;
}

export function addProcess(
  item,
  pid,
  executable = path.join(item.release, "dockerd"),
  argv0 = path.join(item.dockerRoot, "bin", "dockerd"),
) {
  const processRoot = path.join(item.procRoot, String(pid));
  fs.mkdirSync(processRoot, { recursive: true });
  fs.symlinkSync(executable, path.join(processRoot, "exe"));
  fs.writeFileSync(path.join(processRoot, "cmdline"), Buffer.concat([
    Buffer.from(argv0),
    Buffer.from([0]),
    Buffer.from("--fixture"),
    Buffer.from([0]),
  ]));
}

export function setManagedDaemon(item, pid = 4242) {
  addProcess(item, pid);
  fs.writeFileSync(path.join(item.runRoot, "docker.pid"), `${pid}\n`);
  fs.writeFileSync(path.join(item.state, "docker-info"), "ready\n");
}

export function setContainers(item, ids) {
  fs.writeFileSync(path.join(item.state, "containers"), ids.length === 0 ? "" : `${ids.join("\n")}\n`);
}

export function setLock(item, value, { live = false, extra = false } = {}) {
  const lock = path.join(item.runRoot, "host-lifecycle.lock");
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "pid"), `${value}\n`);
  if (live && /^\d+$/.test(String(value))) fs.mkdirSync(path.join(item.procRoot, String(value)));
  if (extra) fs.writeFileSync(path.join(lock, "unexpected"), "state\n");
  return lock;
}

export function readCalls(item) {
  return fs.existsSync(item.calls) ? fs.readFileSync(item.calls, "utf8") : "";
}

export function removeFixture(item) {
  fs.rmSync(item.root, { recursive: true, force: true });
}
