import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dockerdSource = fs.readFileSync(path.join(projectRoot, "android", "dockerd.sh"), "utf8");

function writeExecutable(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, { mode: 0o755 });
}

function fixture({
  installedRules = ["root", "shell", "reject"],
  mounted = true,
  bridgePool = "172.17.0.0/16",
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pixel-dockerd-runtime-"));
  const dockerRoot = path.join(root, "docker");
  const bin = path.join(dockerRoot, "bin");
  const config = path.join(dockerRoot, "config", "host.conf");
  const mounts = path.join(root, "mounts");
  const ipForward = path.join(root, "ip_forward");
  const cgroupRoot = path.join(root, "cgroup");
  const networkLog = path.join(root, "network.log");
  const daemonArgs = path.join(root, "dockerd-args.log");
  const ruleRoot = path.join(root, "rules");
  const runnablePath = path.join(root, "dockerd.sh");

  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.dirname(config));
  fs.mkdirSync(path.join(dockerRoot, "lib"));
  fs.mkdirSync(cgroupRoot);
  fs.mkdirSync(ruleRoot);
  fs.writeFileSync(mounts, mounted ? `/dev/loop-test ${dockerRoot}/lib ext4 rw 0 0\n` : "");
  fs.writeFileSync(ipForward, "0\n");
  fs.writeFileSync(path.join(cgroupRoot, "cgroup.subtree_control"), "");
  fs.writeFileSync(config, [
    "HOST_CONFIG_VERSION=2",
    "AUTOSTART=0",
    "DISK_SIZE_BYTES=268435456",
    `BRIDGE_POOL_CIDR=${bridgePool}`,
    "EXT4_FEATURES=^has_journal,^casefold",
    "MOUNT_OPTIONS=noatime,nodev",
    "",
  ].join("\n"));
  for (const rule of installedRules) fs.writeFileSync(path.join(ruleRoot, rule), "present\n");

  writeExecutable(path.join(bin, "buildkit-runc.sh"), "#!/bin/sh\nexit 0\n");
  writeExecutable(path.join(bin, "dockerd"), `#!/bin/sh\nprintf '%s\\n' "$*" > ${JSON.stringify(daemonArgs)}\n`);
  writeExecutable(path.join(bin, "privns"), "#!/bin/sh\nshift 2\nexec \"$@\"\n");
  writeExecutable(path.join(bin, "ip"), `#!/bin/sh\nprintf 'ip %s\\n' "$*" >> ${JSON.stringify(networkLog)}\n`);
  writeExecutable(path.join(bin, "iptables"), `#!/bin/sh
printf 'iptables %s\\n' "$*" >> ${JSON.stringify(networkLog)}
if [ "$1" = -C ]; then
  case "$*" in
    *'--uid-owner 0 -j ACCEPT'*) test -f ${JSON.stringify(path.join(ruleRoot, "root"))} ;;
    *'--uid-owner 2000 -j ACCEPT'*) test -f ${JSON.stringify(path.join(ruleRoot, "shell"))} ;;
    *'-j REJECT'*) test -f ${JSON.stringify(path.join(ruleRoot, "reject"))} ;;
    *) exit 1 ;;
  esac
fi
`);

  const replacements = new Map([
    ["#!/system/bin/sh", "#!/bin/sh"],
    ["D=/data/docker", `D=${dockerRoot}`],
    ['export PATH="$D/bin:/system/bin:/system/xbin:$PATH"', 'export PATH="$D/bin:/usr/bin:/bin:$PATH"'],
    ["/proc/mounts", mounts],
    ["/sys/fs/cgroup/docker", path.join(cgroupRoot, "docker")],
    ["/sys/fs/cgroup/cgroup.subtree_control", path.join(cgroupRoot, "cgroup.subtree_control")],
  ]);
  let runnable = dockerdSource;
  for (const [from, to] of replacements) {
    assert.ok(runnable.includes(from), `missing replacement: ${from}`);
    runnable = runnable.replaceAll(from, to);
  }
  fs.writeFileSync(runnablePath, runnable, { mode: 0o755 });

  return { root, dockerRoot, runnablePath, ipForward, networkLog, daemonArgs, config };
}

function run(item, ...args) {
  return spawnSync("/bin/sh", [item.runnablePath, ...args], {
    encoding: "utf8",
    timeout: 20_000,
  });
}

function expectedDaemonArgs(
  dockerRoot,
  bridgePool = "172.17.0.0/16",
  bridgeBip = "172.17.0.1/24",
  bridgeSubnetPrefix = "24",
) {
  return [
    "--data-root", `${dockerRoot}/lib`,
    "--exec-root", `${dockerRoot}/exec`,
    "--pidfile", `${dockerRoot}/run/docker.pid`,
    "--host", `unix://${dockerRoot}/run/docker.sock`,
    "--storage-driver", "overlay2",
    "--bip", bridgeBip,
    "--default-address-pool", `base=${bridgePool},size=${bridgeSubnetPrefix}`,
    "--cgroup-parent", "docker",
    "--default-ulimit", "nofile=65536:65536",
    "--dns", "8.8.8.8", "--dns", "1.1.1.1",
    "--group", "2000",
    "--log-level", "info",
  ].join(" ");
}

test("the public launcher exposes only the prepared-host runtime contract", () => {
  assert.match(dockerdSource, /^HOSTCTL_RUNTIME_ONLY_CONTRACT=1$/m);
  assert.doesNotMatch(dockerdSource, /EIP|Forge|companion/i);
  assert.doesNotMatch(dockerdSource, /truncate|mke2fs|losetup|mount -t|iptables -I|ip rule/);
  assert.doesNotMatch(dockerdSource, /tcp:\/\/|2375/);
  assert.match(dockerdSource, /usage: \$0 --runtime-only/);
});

test("runtime-only start derives the default and user-defined bridge pool from host.conf", () => {
  const item = fixture({ bridgePool: "10.64.0.0/20" });
  try {
    const result = run(item, "--runtime-only");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      fs.readFileSync(item.daemonArgs, "utf8").trim(),
      expectedDaemonArgs(item.dockerRoot, "10.64.0.0/20", "10.64.0.1/28", "28"),
    );
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test("runtime-only start refuses a missing or malformed host network configuration", () => {
  for (const mutate of [
    (item) => fs.rmSync(item.config),
    (item) => fs.writeFileSync(item.config, "HOST_CONFIG_VERSION=2\nAUTOSTART=0\n"),
    (item) => fs.writeFileSync(item.config, [
      "HOST_CONFIG_VERSION=2",
      "AUTOSTART=0",
      "DISK_SIZE_BYTES=268435456",
      "BRIDGE_POOL_CIDR=8.8.0.0/16",
      "EXT4_FEATURES=^has_journal,^casefold",
      "MOUNT_OPTIONS=noatime,nodev",
      "",
    ].join("\n")),
  ]) {
    const item = fixture();
    try {
      mutate(item);
      const result = run(item, "--runtime-only");
      assert.notEqual(result.status, 0);
      assert.equal(fs.existsSync(item.daemonArgs), false);
      assert.match(fs.readFileSync(path.join(item.dockerRoot, "dockerd.log"), "utf8"), /exact v2 host network configuration/);
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  }
});

test("runtime-only start does not gate daemon startup on API firewall state", () => {
  const item = fixture({ installedRules: [] });
  try {
    const result = run(item, "--runtime-only");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(item.daemonArgs, "utf8").trim(), expectedDaemonArgs(item.dockerRoot));
    assert.equal(fs.existsSync(item.networkLog), false);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test("no-argument invocation refuses without preparing storage or networking", () => {
  const item = fixture({ installedRules: [] });
  try {
    const result = run(item);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(fs.existsSync(item.daemonArgs), false);
    assert.equal(fs.existsSync(item.networkLog), false);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test("runtime-only invocation refuses when the ext4 data mount is absent", () => {
  const item = fixture({ mounted: false });
  try {
    const result = run(item, "--runtime-only");
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(item.daemonArgs), false);
    assert.match(fs.readFileSync(path.join(item.dockerRoot, "dockerd.log"), "utf8"), /requires the existing ext4 data mount/);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});
