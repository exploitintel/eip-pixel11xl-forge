import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceFile = path.join(projectRoot, "module", "bin", "release-transaction");
const source = fs.readFileSync(sourceFile, "utf8");
const runtimeMembers = [
  "buildkit-runc.sh",
  "containerd",
  "containerd-shim-runc-v2",
  "ctr",
  "docker",
  "docker-init",
  "docker-proxy",
  "dockerd",
  "dockerd.sh",
  "hostctl",
  "privns",
  "route-policy",
  "runc",
];

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function writeExecutable(file, contents) {
  fs.writeFileSync(file, contents, { mode: 0o755 });
}

function fakeBusyboxSource(stateDir, callsFile) {
  return `#!/bin/sh
STATE=${shellQuote(stateDir)}
CALLS=${shellQuote(callsFile)}
APPLET=\${1:-}
shift || exit 1
printf '%s' "$APPLET" >> "$CALLS"
for ARG in "$@"; do printf ' %s' "$ARG" >> "$CALLS"; done
printf '\\n' >> "$CALLS"
get_state() { [ -f "$STATE/$1" ] && /bin/cat "$STATE/$1" || printf '%s' "\${2:-}"; }
set_state() { printf '%s' "$2" > "$STATE/$1"; }
case "$APPLET" in
  id)
    [ "$#" -eq 1 ] && [ "$1" = -u ] || exit 1
    get_state uid 0; printf '\\n'
    ;;
  mkdir)
    TARGET=\${1:-}
    if [ "$(get_state daemonAppearsOnLock '')" = true ]; then
      case "$TARGET" in
        */host-lifecycle.lock)
          /bin/mkdir -p "$STATE/../proc/903"
          printf '%s\n' dockerd > "$STATE/../proc/903/comm"
          /bin/rm -f "$STATE/daemonAppearsOnLock"
          ;;
      esac
    fi
    if [ "$(get_state activeChangesOnLock '')" = true ]; then
      case "$TARGET" in
        */host-lifecycle.lock)
          LOCK_DOCKER_ROOT=\${TARGET%/run/host-lifecycle.lock}
          /bin/rm -f "$LOCK_DOCKER_ROOT/bin"
          /bin/ln -s releases/v1 "$LOCK_DOCKER_ROOT/bin"
          /bin/rm -f "$STATE/activeChangesOnLock"
          ;;
      esac
    fi
    if [ "$(get_state raceBootstrapTakeover '')" = true ]; then
      case "$TARGET" in
        *.bootstrap.lock/.recovery)
          printf '999\\n' > "\${TARGET%/.recovery}/pid"
          /bin/chmod 0600 "\${TARGET%/.recovery}/pid"
          /bin/rm -f "$STATE/raceBootstrapTakeover"
          ;;
      esac
    fi
    if [ "$(get_state raceLifecycleTakeover '')" = true ]; then
      case "$TARGET" in
        */host-lifecycle.lock/.recovery)
          printf '999\\n' > "\${TARGET%/.recovery}/pid"
          /bin/chmod 0600 "\${TARGET%/.recovery}/pid"
          /bin/mkdir "$STATE/../proc/999"
          /bin/rm -f "$STATE/raceLifecycleTakeover"
          ;;
      esac
    fi
    /bin/mkdir "$@"
    ;;
  chmod) /bin/chmod "$@" ;;
  chown) [ "$#" -eq 2 ] && [ "$1" = 0:0 ] ;;
  stat)
    [ "$#" -eq 3 ] && [ "$1" = -c ] || exit 1
    case "$2" in
      %s) /usr/bin/stat -f '%z' "$3" ;;
      %a) /usr/bin/stat -f '%Lp' "$3" ;;
      %d:%i) /usr/bin/stat -f '%d:%i' "$3" ;;
      %u:%g)
        NON_ROOT_SUFFIX=$(get_state nonRootSuffix '')
        case "$3" in *"$NON_ROOT_SUFFIX") [ -n "$NON_ROOT_SUFFIX" ] && printf '2000:2000\\n' || printf '0:0\\n' ;; *) printf '0:0\\n' ;; esac
        ;;
      *) exit 1 ;;
    esac
    ;;
  sha256sum)
    HASH=$(/usr/bin/openssl dgst -sha256 -r "$1") || exit 1
    HASH=\${HASH%% *}
    printf '%s  %s\\n' "$HASH" "$1"
    ;;
  cp) /bin/cp "$@" ;;
  cat) /bin/cat "$@" ;;
  ls) /bin/ls "$@" ;;
  rm)
    for REMOVE_TARGET in "$@"; do
      case "$REMOVE_TARGET" in
        */docker/bin)
          if [ "$(get_state failActiveLinkRemoval '')" = true ]; then
            /bin/rm -f "$STATE/failActiveLinkRemoval"
            printf '%s\n' 'injected active link removal failure' >&2
            exit 1
          fi
          ;;
      esac
    done
    /bin/rm "$@" || exit 1
    for REMOVED in "$@"; do
      case "$REMOVED" in
        *.bootstrap.lock/intent)
          if [ "$(get_state failAfterHandoffIntentRemoval '')" = true ]; then
            /bin/rm -f "$STATE/failAfterHandoffIntentRemoval"
            printf '%s\n' 'injected failure after handoff intent removal' >&2
            exit 1
          fi
          ;;
        *.bootstrap.lock/pid)
          if [ "$(get_state failAfterHandoffOwnerRemoval '')" = true ]; then
            /bin/rm -f "$STATE/failAfterHandoffOwnerRemoval"
            printf '%s\n' 'injected failure after handoff owner removal' >&2
            exit 1
          fi
          ;;
      esac
    done
    ;;
  rmdir) /bin/rmdir "$@" ;;
  readlink) /usr/bin/readlink "$@" ;;
  ln) /bin/ln "$@" ;;
  fsync)
    if [ -d "$1" ] && [ "\${1##*/}" = docker ]; then
      COUNT=$(get_state rootFsyncCount 0); COUNT=$((COUNT + 1)); set_state rootFsyncCount "$COUNT"
      [ "$(get_state failRootFsyncNumber '')" != "$COUNT" ] || { printf '%s\\n' 'injected fsync failure' >&2; exit 1; }
    fi
    if [ -d "$1" ] && [ "\${1##*/}" = releases ]; then
      COUNT=$(get_state releasesFsyncCount 0); COUNT=$((COUNT + 1)); set_state releasesFsyncCount "$COUNT"
      [ "$(get_state failReleasesFsyncNumber '')" != "$COUNT" ] || { printf '%s\\n' 'injected releases fsync failure' >&2; exit 1; }
    fi
    ;;
  awk) /usr/bin/awk "$@" ;;
  mv)
    while [ "$#" -gt 0 ] && [ "\${1#-}" != "$1" ]; do shift; done
    [ "$#" -eq 2 ] || exit 1
    FROM=$1; TO=$2
    case "\${FROM##*/}" in
      .bin.next.*)
        COUNT=$(get_state linkMoveCount 0); COUNT=$((COUNT + 1)); set_state linkMoveCount "$COUNT"
        [ "$(get_state failLinkMoveNumber '')" != "$COUNT" ] || { printf '%s\\n' 'injected link move failure' >&2; exit 1; }
        ;;
    esac
    if [ "$(get_state failStageMove '')" = true ] && [ "\${FROM%.staging}" != "$FROM" ]; then
      printf '%s\\n' 'injected stage move failure' >&2; exit 1
    fi
    /bin/mv -fh "$FROM" "$TO" || exit 1
    CORRUPT=$(get_state corruptReleaseAfterLinkMove '')
    CORRUPT_MANIFEST=$(get_state corruptManifestAfterLinkMove '')
    case "\${FROM##*/}" in
      .bin.next.*)
        if [ -n "$CORRUPT" ]; then
          printf '%s\\n' corrupt >> "\${TO%/*}/releases/$CORRUPT/docker"
          /bin/rm -f "$STATE/corruptReleaseAfterLinkMove"
        fi
        if [ "$CORRUPT_MANIFEST" = true ]; then
          printf '\\n' >> "\${TO%/*}/$(/usr/bin/readlink "$TO")/.release-manifest.tsv"
          /bin/rm -f "$STATE/corruptManifestAfterLinkMove"
        fi
        ;;
    esac
    ;;
  *) printf 'unsupported fake busybox applet: %s\\n' "$APPLET" >&2; exit 1 ;;
esac
`;
}

function createFixture({ active = "v1" } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "release-transaction-")));
  const dockerRoot = path.join(root, "docker");
  const procRoot = path.join(root, "proc");
  const releases = path.join(dockerRoot, "releases");
  const runRoot = path.join(dockerRoot, "run");
  const stateDir = path.join(root, "fake-state");
  const callsFile = path.join(root, "fake-calls.log");
  const busybox = path.join(root, "busybox");
  fs.mkdirSync(releases, { recursive: true });
  fs.mkdirSync(runRoot);
  fs.mkdirSync(procRoot);
  fs.mkdirSync(stateDir);
  writeExecutable(busybox, fakeBusyboxSource(stateDir, callsFile));

  let runnable = source;
  for (const [from, to] of [
    ["#!/system/bin/sh", "#!/bin/sh"],
    ["DOCKER_ROOT=/data/docker", `DOCKER_ROOT=${shellQuote(dockerRoot)}`],
    ["PROC_ROOT=/proc", `PROC_ROOT=${shellQuote(procRoot)}`],
    ["BUSYBOX=/data/adb/ksu/bin/busybox", `BUSYBOX=${shellQuote(busybox)}`],
  ]) {
    assert.ok(runnable.includes(from), `missing source rewrite: ${from}`);
    runnable = runnable.replace(from, to);
  }
  const command = path.join(root, "release-transaction");
  writeExecutable(command, runnable);
  if (active !== "none") {
    createOldRelease({ releases }, active);
    fs.symlinkSync(`releases/${active}`, path.join(dockerRoot, "bin"));
  }
  return { root, dockerRoot, procRoot, releases, runRoot, stateDir, callsFile, command };
}

function createUninitializedFixture() {
  const item = createFixture({ active: "none" });
  fs.rmSync(item.dockerRoot, { recursive: true });
  return item;
}

function setBootstrapLock(item, pid, {
  live = false,
  mode = 0o700,
  extra = false,
  intent = false,
} = {}) {
  const lock = `${item.dockerRoot}.bootstrap.lock`;
  fs.mkdirSync(lock, { mode });
  fs.writeFileSync(path.join(lock, "pid"), `${pid}\n`, { mode: 0o600 });
  if (intent) {
    fs.writeFileSync(path.join(lock, "intent"), "BOOTSTRAP_INTENT_VERSION=1\n", { mode: 0o600 });
  }
  if (extra) fs.writeFileSync(path.join(lock, "unexpected"), "state\n");
  if (live) fs.mkdirSync(path.join(item.procRoot, String(pid)), { recursive: true });
  return lock;
}

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

function createOldRelease(item, version) {
  const directory = path.join(item.releases, version);
  fs.mkdirSync(directory);
  const rows = [];
  for (const name of runtimeMembers) {
    const contents = Buffer.from(`${name}:${version}\n`);
    fs.writeFileSync(path.join(directory, name), contents, { mode: 0o755 });
    rows.push(`${name}\t${contents.length}\t${sha256(contents)}\t0755`);
  }
  fs.writeFileSync(
    path.join(directory, ".release-manifest.tsv"),
    `RELEASE_MANIFEST_VERSION=1\n${rows.join("\n")}\n`,
    { mode: 0o600 },
  );
  return directory;
}

function prepareRelease(item, version) {
  const directory = path.join(item.root, `source-${version}`);
  const manifest = path.join(item.root, `manifest-${version}.tsv`);
  fs.mkdirSync(directory);
  const rows = [];
  for (const name of runtimeMembers) {
    const contents = Buffer.from(`${name}:${version}\n`);
    fs.writeFileSync(path.join(directory, name), contents, { mode: 0o755 });
    rows.push(`${name}\t${contents.length}\t${sha256(contents)}\t0755`);
  }
  fs.writeFileSync(manifest, `RELEASE_MANIFEST_VERSION=1\n${rows.join("\n")}\n`);
  return { directory, manifest };
}

function finalizePreparedRelease(item, prepared, version) {
  const final = path.join(item.releases, version);
  fs.cpSync(prepared.directory, final, { recursive: true });
  fs.copyFileSync(prepared.manifest, path.join(final, ".release-manifest.tsv"));
  fs.chmodSync(path.join(final, ".release-manifest.tsv"), 0o600);
  return final;
}

function writeActivationRecord(item, next, previous) {
  fs.writeFileSync(
    path.join(item.releases, ".activation"),
    `ACTIVATION_RECORD_VERSION=1\nNEW=${next}\nPREVIOUS=${previous}\n`,
    { mode: 0o600 },
  );
}

function prepareInstallAssets(item, buildId = "TEST.1") {
  const kernel = path.join(item.root, `Image-${buildId}.lz4`);
  const config = path.join(item.root, "host.conf.default");
  const kernelBytes = Buffer.from(`kernel:${buildId}\n`);
  const configBytes = Buffer.from([
    "HOST_CONFIG_VERSION=2",
    "AUTOSTART=0",
    "DISK_SIZE_BYTES=0",
    "BRIDGE_POOL_CIDR=172.17.0.0/16",
    "EXT4_FEATURES=^has_journal,^casefold",
    "MOUNT_OPTIONS=noatime,nodev",
    "",
  ].join("\n"));
  fs.writeFileSync(kernel, kernelBytes, { mode: 0o600 });
  fs.writeFileSync(config, configBytes, { mode: 0o644 });
  return {
    buildId,
    kernel,
    kernelBytes,
    kernelHash: sha256(kernelBytes),
    config,
    configBytes,
    configHash: sha256(configBytes),
  };
}

function stageInstallArgs(prepared, assets, expectedActive) {
  return [
    "stage-install", path.basename(prepared.directory).replace(/^source-/, ""),
    prepared.directory, prepared.manifest, expectedActive, assets.buildId,
    assets.kernel, String(assets.kernelBytes.length), assets.kernelHash,
    assets.config, String(assets.configBytes.length), assets.configHash,
  ];
}

function run(item, ...args) {
  const result = spawnSync("/bin/sh", [item.command, ...args], {
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, "release transaction must exit normally rather than by signal");
  assert.equal(typeof result.status, "number", "release transaction must produce an exit status");
  return result;
}

function configure(item, values) {
  fs.rmSync(item.stateDir, { recursive: true, force: true });
  fs.mkdirSync(item.stateDir);
  for (const [name, value] of Object.entries(values)) {
    fs.writeFileSync(path.join(item.stateDir, name), String(value));
  }
}

function activeTarget(item) {
  return fs.readlinkSync(path.join(item.dockerRoot, "bin"));
}

function record(item) {
  return fs.readFileSync(path.join(item.releases, ".activation"), "utf8");
}

function deactivationRecord(item) {
  return fs.readFileSync(path.join(item.releases, ".deactivation"), "utf8");
}

function removeFixture(item) {
  fs.rmSync(item.root, { recursive: true, force: true });
}

test("transaction source is inert, bounded, and uses the shared durability primitives", () => {
  assert.match(source, /^DOCKER_ROOT=\/data\/docker$/m);
  assert.match(source, /^PROC_ROOT=\/proc$/m);
  assert.match(source, /^LOCK_DIR=\$RUN_ROOT\/host-lifecycle\.lock$/m);
  assert.match(source, /bb mv -T "\$STAGING_RELEASE" "\$FINAL_RELEASE"/);
  assert.match(source, /bb mv -fT "\$TEMP_LINK" "\$ACTIVE_LINK"/);
  assert.match(source, /bb fsync "\$1"/);
  assert.match(source, /\[1357\]\[0145\]\[0145\]\) return 0/);
  assert.doesNotMatch(source, /0\$SAFE_MODE\s*&/);
  assert.doesNotMatch(source, /\brm\s+-rf\b|curl|wget|swap-boot|patch-engine|disk\.img|boot_/i);
});

test("probe reports clean and active layouts without mutation", () => {
  for (const active of ["none", "v1"]) {
    const item = active === "none" ? createUninitializedFixture() : createFixture({ active });
    try {
      const beforeCalls = fs.existsSync(item.callsFile) ? fs.readFileSync(item.callsFile) : Buffer.alloc(0);
      const result = run(item, "probe");
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `TRANSACTION_PROBE_VERSION=1\nactive=${active}\n`);
      assert.equal(fs.existsSync(path.join(item.runRoot, "host-lifecycle.lock")), false);
      assert.equal(fs.existsSync(`${item.dockerRoot}.bootstrap.lock`), false);
      const calls = fs.readFileSync(item.callsFile, "utf8");
      assert.doesNotMatch(calls, /^(mkdir|chmod|chown|cp|rm|rmdir|ln|fsync|mv) /m);
      assert.ok(calls.length >= beforeCalls.length);
    } finally {
      removeFixture(item);
    }
  }
});

test("probe classifies an exact stale intent-backed bootstrap without claiming it, then stage-install recovers", () => {
  const item = createUninitializedFixture();
  try {
    fs.mkdirSync(item.dockerRoot, { mode: 0o700 });
    fs.mkdirSync(item.runRoot, { mode: 0o700 });
    const bootstrap = setBootstrapLock(item, 777, { intent: true });
    const prepared = prepareRelease(item, "v1");
    const assets = prepareInstallAssets(item);
    const callsBefore = fs.existsSync(item.callsFile)
      ? fs.readFileSync(item.callsFile, "utf8").length
      : 0;

    let result = run(item, "probe");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "TRANSACTION_PROBE_VERSION=1\nactive=none\n");
    assert.deepEqual(fs.readdirSync(bootstrap).sort(), ["intent", "pid"]);
    assert.equal(fs.readFileSync(path.join(bootstrap, "pid"), "utf8"), "777\n");
    const probeCalls = fs.readFileSync(item.callsFile, "utf8").slice(callsBefore);
    assert.doesNotMatch(probeCalls, /^(mkdir|chmod|chown|cp|rm|rmdir|ln|fsync|mv) /m);

    result = run(item, ...stageInstallArgs(prepared, assets, "none"));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "result=activated\nactive=v1\nprevious=none\n");
    assert.equal(activeTarget(item), "releases/v1");
    assert.equal(fs.existsSync(bootstrap), false);
  } finally {
    removeFixture(item);
  }
});

test("probe refuses a real bin directory and ambiguous clean-host state without mutation", () => {
  const populated = createFixture({ active: "none" });
  try {
    fs.mkdirSync(path.join(populated.dockerRoot, "bin"));
    fs.writeFileSync(path.join(populated.dockerRoot, "bin", "legacy"), "keep\n");
    const result = run(populated, "probe");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /active release link is malformed or unsafe/);
    assert.equal(fs.readFileSync(path.join(populated.dockerRoot, "bin", "legacy"), "utf8"), "keep\n");
  } finally {
    removeFixture(populated);
  }

  const interrupted = createUninitializedFixture();
  try {
    const lock = setBootstrapLock(interrupted, 777);
    const result = run(interrupted, "probe");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /bootstrap has no durable recovery intent/);
    assert.equal(fs.readFileSync(path.join(lock, "pid"), "utf8"), "777\n");
  } finally {
    removeFixture(interrupted);
  }
});

test("probe refuses live and unsafe intent-backed bootstrap state without mutation", () => {
  for (const [label, arrange, expected] of [
    ["live owner", (item) => setBootstrapLock(item, 777, { intent: true, live: true }), /bootstrap is in progress/],
    ["unsafe partial root", (item) => {
      fs.mkdirSync(item.dockerRoot, { mode: 0o700 });
      fs.mkdirSync(item.runRoot, { mode: 0o700 });
      fs.writeFileSync(path.join(item.dockerRoot, "unexpected"), "keep\n");
      setBootstrapLock(item, 777, { intent: true });
    }, /partial bootstrap Docker root contains unexpected state/],
  ]) {
    const item = createUninitializedFixture();
    try {
      arrange(item);
      const before = fs.existsSync(item.callsFile) ? fs.readFileSync(item.callsFile, "utf8").length : 0;
      const result = run(item, "probe");
      assert.notEqual(result.status, 0, `${label}: ${result.stderr}`);
      assert.match(result.stderr, expected, label);
      const calls = fs.readFileSync(item.callsFile, "utf8").slice(before);
      assert.doesNotMatch(calls, /^(mkdir|chmod|chown|cp|rm|rmdir|ln|fsync|mv) /m, label);
      assert.equal(fs.readFileSync(path.join(`${item.dockerRoot}.bootstrap.lock`, "pid"), "utf8"), "777\n");
    } finally {
      removeFixture(item);
    }
  }
});

test("stage-install durably stages the kernel and default-off config before first activation", () => {
  const item = createUninitializedFixture();
  try {
    const prepared = prepareRelease(item, "v1");
    const assets = prepareInstallAssets(item);
    const result = run(item, ...stageInstallArgs(prepared, assets, "none"));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(activeTarget(item), "releases/v1");
    const installedKernel = path.join(item.dockerRoot, "kernel", assets.buildId, "Image.lz4");
    assert.deepEqual(fs.readFileSync(installedKernel), assets.kernelBytes);
    assert.equal(mode(installedKernel), 0o600);
    assert.deepEqual(fs.readFileSync(path.join(item.dockerRoot, "config", "host.conf")), assets.configBytes);
    assert.equal(mode(path.join(item.dockerRoot, "config", "host.conf")), 0o600);
    const calls = fs.readFileSync(item.callsFile, "utf8");
    const kernelMove = calls.indexOf(`mv -T ${path.join(item.dockerRoot, "kernel", `${assets.buildId}.staging`)} `);
    const linkMove = calls.indexOf(`mv -fT ${path.join(item.dockerRoot, ".bin.next.")}`);
    assert.ok(kernelMove >= 0 && linkMove > kernelMove, calls);
  } finally {
    removeFixture(item);
  }
});

test("stage-install refuses an unauthenticated kernel before clean-host mutation", () => {
  const item = createUninitializedFixture();
  try {
    const prepared = prepareRelease(item, "v1");
    const assets = prepareInstallAssets(item);
    fs.appendFileSync(assets.kernel, "tampered\n");
    const result = run(item, ...stageInstallArgs(prepared, assets, "none"));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /prepared kernel source has the wrong identity/);
    assert.equal(fs.existsSync(item.dockerRoot), false);
    assert.equal(fs.existsSync(`${item.dockerRoot}.bootstrap.lock`), false);
  } finally {
    removeFixture(item);
  }
});

test("stage-install preserves an existing root-owned config on upgrade", () => {
  const item = createFixture();
  try {
    const configRoot = path.join(item.dockerRoot, "config");
    fs.mkdirSync(configRoot, { mode: 0o700 });
    const configFile = path.join(configRoot, "host.conf");
    const operatorConfig = [
      "HOST_CONFIG_VERSION=2",
      "AUTOSTART=1",
      "DISK_SIZE_BYTES=8589934592",
      "BRIDGE_POOL_CIDR=10.64.0.0/20",
      "EXT4_FEATURES=^has_journal,^casefold",
      "MOUNT_OPTIONS=noatime,nodev",
      "",
    ].join("\n");
    fs.writeFileSync(configFile, operatorConfig, { mode: 0o600 });
    const prepared = prepareRelease(item, "v2");
    const assets = prepareInstallAssets(item);
    const result = run(item, ...stageInstallArgs(prepared, assets, "v1"));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(configFile, "utf8"), operatorConfig);
    assert.deepEqual(
      fs.readFileSync(path.join(item.dockerRoot, "kernel", assets.buildId, "Image.lz4")),
      assets.kernelBytes,
    );
  } finally {
    removeFixture(item);
  }
});

test("stage-install refuses a malformed existing config before host mutation", () => {
  const item = createFixture();
  try {
    const configRoot = path.join(item.dockerRoot, "config");
    fs.mkdirSync(configRoot, { mode: 0o700 });
    const configFile = path.join(configRoot, "host.conf");
    fs.writeFileSync(configFile, "operator-selected\n", { mode: 0o600 });
    const prepared = prepareRelease(item, "v2");
    const assets = prepareInstallAssets(item);
    const callsBefore = fs.existsSync(item.callsFile) ? fs.readFileSync(item.callsFile, "utf8") : "";
    const result = run(item, ...stageInstallArgs(prepared, assets, "v1"));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /existing host config is malformed or unsafe/);
    assert.equal(activeTarget(item), "releases/v1");
    assert.equal(fs.existsSync(path.join(item.releases, "v2")), false);
    assert.equal(fs.existsSync(path.join(item.dockerRoot, "kernel", assets.buildId)), false);
    const callsAfter = fs.existsSync(item.callsFile) ? fs.readFileSync(item.callsFile, "utf8") : "";
    const newCalls = callsAfter.slice(callsBefore.length);
    assert.doesNotMatch(newCalls, /^(mkdir|chmod|chown|cp|rm|rmdir|ln|fsync|mv) /m);
  } finally {
    removeFixture(item);
  }
});

test("stage-activate bootstraps only the minimal clean root before activating", () => {
  const item = createUninitializedFixture();
  try {
    const prepared = prepareRelease(item, "v1");
    const result = run(item, "stage-activate", "v1", prepared.directory, prepared.manifest, "none");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(activeTarget(item), "releases/v1");
    assert.deepEqual(fs.readdirSync(item.dockerRoot).sort(), ["bin", "releases", "run"]);
    assert.equal(mode(item.dockerRoot), 0o700);
    assert.equal(mode(item.runRoot), 0o700);
    assert.equal(mode(item.releases), 0o700);
    assert.equal(fs.existsSync(`${item.dockerRoot}.bootstrap.lock`), false);
    const calls = fs.readFileSync(item.callsFile, "utf8");
    assert.equal(calls.includes(`chmod 0700 ${item.root}\n`), false);
    assert.equal(calls.includes(`chown 0:0 ${item.root}\n`), false);
  } finally {
    removeFixture(item);
  }
});

test("a complete existing root is accepted without normalizing directory modes", () => {
  const item = createFixture({ active: "none" });
  try {
    fs.chmodSync(item.dockerRoot, 0o755);
    fs.chmodSync(item.runRoot, 0o711);
    fs.chmodSync(item.releases, 0o750);
    const prepared = prepareRelease(item, "v1");
    const result = run(item, "stage-activate", "v1", prepared.directory, prepared.manifest, "none");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(mode(item.dockerRoot), 0o755);
    assert.equal(mode(item.runRoot), 0o711);
    assert.equal(mode(item.releases), 0o750);
  } finally {
    removeFixture(item);
  }
});

test("an exact partial bootstrap resumes only with a proved-stale intent marker", () => {
  const item = createUninitializedFixture();
  try {
    fs.mkdirSync(item.dockerRoot, { mode: 0o700 });
    fs.mkdirSync(item.runRoot, { mode: 0o700 });
    setBootstrapLock(item, 777, { intent: true });
    const prepared = prepareRelease(item, "v1");
    const result = run(item, "stage-activate", "v1", prepared.directory, prepared.manifest, "none");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(activeTarget(item), "releases/v1");
    assert.equal(fs.existsSync(`${item.dockerRoot}.bootstrap.lock`), false);
  } finally {
    removeFixture(item);
  }
});

test("an exact partial bootstrap survives two interrupted stale-owner recoveries", () => {
  const item = createUninitializedFixture();
  try {
    fs.mkdirSync(item.dockerRoot, { mode: 0o700 });
    fs.mkdirSync(item.runRoot, { mode: 0o700 });
    const lock = path.join(item.runRoot, "host-lifecycle.lock");
    fs.mkdirSync(lock, { mode: 0o700 });
    fs.writeFileSync(path.join(lock, "pid"), "777\n", { mode: 0o600 });
    setBootstrapLock(item, 778, { intent: true });
    const prepared = prepareRelease(item, "v1");
    const result = run(item, "stage-activate", "v1", prepared.directory, prepared.manifest, "none");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(activeTarget(item), "releases/v1");
    assert.equal(fs.existsSync(`${item.dockerRoot}.bootstrap.lock`), false);
    assert.equal(fs.existsSync(lock), false);
  } finally {
    removeFixture(item);
  }
});

test("a stale bootstrap claimant rechecks the owner after winning recovery election", () => {
  const item = createUninitializedFixture();
  try {
    fs.mkdirSync(item.dockerRoot, { mode: 0o700 });
    fs.mkdirSync(item.runRoot, { mode: 0o700 });
    const bootstrap = setBootstrapLock(item, 777, { intent: true });
    configure(item, { raceBootstrapTakeover: true });
    const prepared = prepareRelease(item, "v1");
    const result = run(item, "stage-activate", "v1", prepared.directory, prepared.manifest, "none");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /bootstrap lock changed during stale recovery/);
    assert.equal(fs.readFileSync(path.join(bootstrap, "pid"), "utf8"), "999\n");
    assert.equal(fs.existsSync(path.join(item.dockerRoot, "bin")), false);
  } finally {
    removeFixture(item);
  }
});

test("partial state without durable bootstrap intent is refused unchanged", () => {
  const item = createUninitializedFixture();
  try {
    fs.mkdirSync(item.dockerRoot, { mode: 0o700 });
    fs.mkdirSync(item.runRoot, { mode: 0o700 });
    const prepared = prepareRelease(item, "v1");
    const result = run(item, "stage-activate", "v1", prepared.directory, prepared.manifest, "none");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /no durable bootstrap intent/);
    assert.deepEqual(fs.readdirSync(item.dockerRoot), ["run"]);
    assert.equal(fs.existsSync(`${item.dockerRoot}.bootstrap.lock`), false);
  } finally {
    removeFixture(item);
  }
});

test("a stale pre-intent lock cannot authorize an existing partial root", () => {
  const item = createUninitializedFixture();
  try {
    fs.mkdirSync(item.dockerRoot, { mode: 0o700 });
    fs.mkdirSync(item.runRoot, { mode: 0o700 });
    setBootstrapLock(item, 777);
    const prepared = prepareRelease(item, "v1");
    const result = run(item, "stage-activate", "v1", prepared.directory, prepared.manifest, "none");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /no persisted bootstrap intent/);
    assert.deepEqual(fs.readdirSync(item.dockerRoot), ["run"]);
    assert.equal(fs.existsSync(`${item.dockerRoot}.bootstrap.lock`), false);
  } finally {
    removeFixture(item);
  }
});

test("partial bootstrap recovery refuses nested state it could not have created", () => {
  for (const [label, arrange, expected] of [
    ["release payload", (item) => fs.writeFileSync(path.join(item.releases, "payload"), "keep\n"), /releases directory is not empty/],
    ["runtime debris", (item) => fs.writeFileSync(path.join(item.runRoot, "leftover"), "keep\n"), /run directory contains unexpected state/],
  ]) {
    const item = createUninitializedFixture();
    try {
      fs.mkdirSync(item.dockerRoot, { mode: 0o700 });
      fs.mkdirSync(item.runRoot, { mode: 0o700 });
      fs.mkdirSync(item.releases, { mode: 0o700 });
      arrange(item);
      const bootstrap = setBootstrapLock(item, 777, { intent: true });
      const prepared = prepareRelease(item, "v1");
      const result = run(item, "stage-activate", "v1", prepared.directory, prepared.manifest, "none");
      assert.equal(result.status, 1, `${label}: ${result.stderr}`);
      assert.match(result.stderr, expected, label);
      assert.equal(fs.existsSync(bootstrap), true, label);
      assert.equal(fs.existsSync(path.join(item.dockerRoot, "bin")), false, label);
    } finally {
      removeFixture(item);
    }
  }
});

test("empty and populated real bin directories remain untouched", () => {
  for (const populated of [false, true]) {
    const item = createFixture({ active: "none" });
    try {
      const bin = path.join(item.dockerRoot, "bin");
      fs.mkdirSync(bin);
      if (populated) fs.writeFileSync(path.join(bin, "legacy"), "keep\n");
      const prepared = prepareRelease(item, "v1");
      const result = run(item, "stage-activate", "v1", prepared.directory, prepared.manifest, "none");
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /active release link is malformed or unsafe/);
      assert.equal(fs.statSync(bin).isDirectory(), true);
      assert.deepEqual(fs.readdirSync(bin), populated ? ["legacy"] : []);
    } finally {
      removeFixture(item);
    }
  }
});

test("live, malformed, and symlink bootstrap locks refuse without creating a root", () => {
  for (const [label, arrange, expected] of [
    ["live", (item) => setBootstrapLock(item, 777, { live: true }), /bootstrap is in progress/],
    ["malformed", (item) => setBootstrapLock(item, 777, { extra: true }), /bootstrap lock is malformed/],
    ["symlink", (item) => {
      const target = path.join(item.root, "bootstrap-target");
      fs.mkdirSync(target);
      fs.symlinkSync(target, `${item.dockerRoot}.bootstrap.lock`);
    }, /bootstrap lock is malformed/],
  ]) {
    const item = createUninitializedFixture();
    try {
      arrange(item);
      const prepared = prepareRelease(item, "v1");
      const result = run(item, "stage-activate", "v1", prepared.directory, prepared.manifest, "none");
      assert.equal(result.status, 1, `${label}: ${result.stderr}`);
      assert.match(result.stderr, expected, label);
      assert.equal(fs.existsSync(item.dockerRoot), false, label);
    } finally {
      removeFixture(item);
    }
  }
});

test("invalid, non-clean stage, and rollback invocations never bootstrap", () => {
  const item = createUninitializedFixture();
  try {
    const prepared = prepareRelease(item, "v1");
    for (const args of [
      ["stage-activate", "bad/name", prepared.directory, prepared.manifest, "none"],
      ["stage-activate", "v2", prepared.directory, prepared.manifest, "v1"],
      ["rollback", "v1"],
    ]) {
      const result = run(item, ...args);
      assert.notEqual(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
      assert.equal(fs.existsSync(item.dockerRoot), false);
      assert.equal(fs.existsSync(`${item.dockerRoot}.bootstrap.lock`), false);
    }
  } finally {
    removeFixture(item);
  }
});

test("a bad clean-install payload is refused before bootstrap changes host state", () => {
  const item = createUninitializedFixture();
  try {
    const prepared = prepareRelease(item, "v1");
    fs.appendFileSync(path.join(prepared.directory, "docker"), "tampered\n");
    const result = run(item, "stage-activate", "v1", prepared.directory, prepared.manifest, "none");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /does not match its manifest/);
    assert.equal(fs.existsSync(item.dockerRoot), false);
    assert.equal(fs.existsSync(`${item.dockerRoot}.bootstrap.lock`), false);
  } finally {
    removeFixture(item);
  }
});

test("a world-writable existing root is refused without normalization", () => {
  const item = createFixture({ active: "none" });
  try {
    fs.chmodSync(item.dockerRoot, 0o777);
    const prepared = prepareRelease(item, "v1");
    const result = run(item, "stage-activate", "v1", prepared.directory, prepared.manifest, "none");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Docker root has unsafe type, ownership, or mode/);
    assert.equal(mode(item.dockerRoot), 0o777);
    assert.equal(fs.existsSync(path.join(item.dockerRoot, "bin")), false);
  } finally {
    removeFixture(item);
  }
});

test("an unavailable process root cannot turn a stale bootstrap owner into proof", () => {
  const item = createUninitializedFixture();
  try {
    const bootstrap = setBootstrapLock(item, 777, { intent: true });
    fs.rmSync(item.procRoot, { recursive: true });
    const prepared = prepareRelease(item, "v1");
    const result = run(item, "stage-activate", "v1", prepared.directory, prepared.manifest, "none");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /running or ambiguous/);
    assert.equal(fs.existsSync(item.dockerRoot), false);
    assert.equal(fs.readFileSync(path.join(bootstrap, "pid"), "utf8"), "777\n");
  } finally {
    removeFixture(item);
  }
});

test("a bootstrap fsync failure leaves exact durable intent and a retry completes", () => {
  const item = createUninitializedFixture();
  try {
    const prepared = prepareRelease(item, "v1");
    configure(item, { failRootFsyncNumber: 1 });
    let result = run(item, "stage-activate", "v1", prepared.directory, prepared.manifest, "none");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /cannot fsync Docker root/);
    const bootstrap = `${item.dockerRoot}.bootstrap.lock`;
    assert.deepEqual(fs.readdirSync(bootstrap).sort(), ["intent", "pid"]);
    assert.match(fs.readFileSync(path.join(bootstrap, "pid"), "utf8"), /^[0-9]+\n$/);
    assert.equal(fs.existsSync(path.join(item.dockerRoot, "bin")), false);

    configure(item, {});
    result = run(item, "stage-activate", "v1", prepared.directory, prepared.manifest, "none");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(activeTarget(item), "releases/v1");
    assert.equal(fs.existsSync(bootstrap), false);
  } finally {
    removeFixture(item);
  }
});

for (const [label, fault, remnant] of [
  ["intent removal", "failAfterHandoffIntentRemoval", ["pid"]],
  ["owner removal", "failAfterHandoffOwnerRemoval", []],
]) {
  test(`bootstrap handoff recovers after interrupted ${label}`, () => {
    const item = createUninitializedFixture();
    try {
      const prepared = prepareRelease(item, "v1");
      const assets = prepareInstallAssets(item);
      configure(item, { [fault]: true });

      let result = run(item, ...stageInstallArgs(prepared, assets, "none"));
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /cannot complete clean-host bootstrap lock handoff/);
      const bootstrap = `${item.dockerRoot}.bootstrap.lock`;
      const handoff = `${item.dockerRoot}.bootstrap.handoff`;
      const lifecycle = path.join(item.runRoot, "host-lifecycle.lock");
      assert.deepEqual(fs.readdirSync(bootstrap).sort(), remnant);
      assert.equal(fs.readFileSync(handoff, "utf8"), "BOOTSTRAP_INTENT_VERSION=1\n");
      assert.match(fs.readFileSync(path.join(lifecycle, "pid"), "utf8"), /^[0-9]+\n$/);
      assert.equal(fs.existsSync(path.join(item.dockerRoot, "bin")), false);

      const callsBeforeProbe = fs.readFileSync(item.callsFile, "utf8").length;
      result = run(item, "probe");
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "TRANSACTION_PROBE_VERSION=1\nactive=none\n");
      const probeCalls = fs.readFileSync(item.callsFile, "utf8").slice(callsBeforeProbe);
      assert.doesNotMatch(probeCalls, /^(mkdir|chmod|chown|cp|rm|rmdir|ln|fsync|mv) /m);
      assert.deepEqual(fs.readdirSync(bootstrap).sort(), remnant);

      result = run(item, ...stageInstallArgs(prepared, assets, "none"));
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "result=activated\nactive=v1\nprevious=none\n");
      assert.equal(activeTarget(item), "releases/v1");
      assert.equal(fs.existsSync(bootstrap), false);
      assert.equal(fs.existsSync(handoff), false);
    } finally {
      removeFixture(item);
    }
  });
}

test("pid-only and empty bootstrap locks without a handoff marker are never adopted", () => {
  for (const kind of ["pid-only", "empty"]) {
    const item = createUninitializedFixture();
    try {
      fs.mkdirSync(item.dockerRoot, { mode: 0o700 });
      fs.mkdirSync(item.runRoot, { mode: 0o700 });
      fs.mkdirSync(item.releases, { mode: 0o700 });
      const lifecycle = path.join(item.runRoot, "host-lifecycle.lock");
      fs.mkdirSync(lifecycle, { mode: 0o700 });
      fs.writeFileSync(path.join(lifecycle, "pid"), "777\n", { mode: 0o600 });
      const bootstrap = `${item.dockerRoot}.bootstrap.lock`;
      if (kind === "pid-only") setBootstrapLock(item, 777);
      else fs.mkdirSync(bootstrap, { mode: 0o700 });
      const prepared = prepareRelease(item, "v1");
      const before = fs.existsSync(item.callsFile) ? fs.readFileSync(item.callsFile, "utf8").length : 0;

      let result = run(item, "probe");
      assert.notEqual(result.status, 0, kind);
      assert.equal(fs.existsSync(`${item.dockerRoot}.bootstrap.handoff`), false, kind);
      let calls = fs.readFileSync(item.callsFile, "utf8").slice(before);
      assert.doesNotMatch(calls, /^(mkdir|chmod|chown|cp|rm|rmdir|ln|fsync|mv) /m, kind);

      const beforeStage = fs.readFileSync(item.callsFile, "utf8").length;
      result = run(item, "stage-activate", "v1", prepared.directory, prepared.manifest, "none");
      assert.notEqual(result.status, 0, kind);
      calls = fs.readFileSync(item.callsFile, "utf8").slice(beforeStage);
      assert.doesNotMatch(calls, /^(cp|ln|mv) /m, kind);
      assert.equal(fs.existsSync(path.join(item.dockerRoot, "bin")), false, kind);
      assert.deepEqual(fs.readdirSync(item.releases), [], kind);
    } finally {
      removeFixture(item);
    }
  }
});

test("stage-activate publishes a complete release atomically and retains one-step rollback state", () => {
  const item = createFixture();
  try {
    const prepared = prepareRelease(item, "v2");
    const result = run(item, "stage-activate", "v2", prepared.directory, prepared.manifest, "v1");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "result=activated\nactive=v2\nprevious=v1\n");
    assert.equal(activeTarget(item), "releases/v2");
    assert.equal(fs.existsSync(path.join(item.releases, "v2.staging")), false);
    assert.equal(fs.existsSync(path.join(item.releases, "v1")), true);
    assert.equal(fs.existsSync(path.join(item.releases, "v2", ".release-manifest.tsv")), true);
    assert.equal(record(item), "ACTIVATION_RECORD_VERSION=1\nNEW=v2\nPREVIOUS=v1\n");
    const calls = fs.readFileSync(item.callsFile, "utf8");
    assert.match(calls, /fsync .*\/v2\.staging\/docker\n/);
    assert.match(calls, /mv -T .*\/v2\.staging .*\/v2\n/);
    const linkMove = calls.indexOf("mv -fT " + path.join(item.dockerRoot, ".bin.next."));
    assert.ok(linkMove > calls.indexOf("fsync " + item.dockerRoot), calls);
  } finally {
    removeFixture(item);
  }
});

test("a second activation replaces the intentional rollback record", () => {
  const item = createFixture();
  try {
    const v2 = prepareRelease(item, "v2");
    let result = run(item, "stage-activate", "v2", v2.directory, v2.manifest, "v1");
    assert.equal(result.status, 0, result.stderr);
    const v3 = prepareRelease(item, "v3");
    result = run(item, "stage-activate", "v3", v3.directory, v3.manifest, "v2");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(activeTarget(item), "releases/v3");
    assert.equal(record(item), "ACTIVATION_RECORD_VERSION=1\nNEW=v3\nPREVIOUS=v2\n");
    assert.equal(fs.existsSync(path.join(item.releases, "v1")), true);
    assert.equal(fs.existsSync(path.join(item.releases, "v2")), true);
  } finally {
    removeFixture(item);
  }
});

test("upgrade, deactivation, and same-package reinstall converge", () => {
  const item = createFixture();
  try {
    const prepared = prepareRelease(item, "v2");
    let result = run(item, "stage-activate", "v2", prepared.directory, prepared.manifest, "v1");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(record(item), "ACTIVATION_RECORD_VERSION=1\nNEW=v2\nPREVIOUS=v1\n");

    result = run(item, "deactivate", "v2");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "result=deactivated\nactive=none\nprevious=v2\n");
    assert.equal(fs.existsSync(path.join(item.dockerRoot, "bin")), false);
    assert.equal(fs.existsSync(path.join(item.releases, ".activation")), false);
    assert.equal(fs.existsSync(path.join(item.releases, "v1")), true);
    assert.equal(fs.existsSync(path.join(item.releases, "v2")), true);
    result = run(item, "probe");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "TRANSACTION_PROBE_VERSION=1\nactive=none\n");

    result = run(item, "stage-activate", "v2", prepared.directory, prepared.manifest, "none");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "result=activated\nactive=v2\nprevious=none\n");
    assert.equal(activeTarget(item), "releases/v2");
    assert.equal(record(item), "ACTIVATION_RECORD_VERSION=1\nNEW=v2\nPREVIOUS=none\n");
  } finally {
    removeFixture(item);
  }
});

test("interrupted deactivation leaves a valid active release and retries cleanly", () => {
  const item = createFixture();
  try {
    const prepared = prepareRelease(item, "v2");
    let result = run(item, "stage-activate", "v2", prepared.directory, prepared.manifest, "v1");
    assert.equal(result.status, 0, result.stderr);
    configure(item, { failActiveLinkRemoval: true });

    result = run(item, "deactivate", "v2");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /cannot remove active release link/);
    assert.equal(activeTarget(item), "releases/v2");
    assert.equal(fs.existsSync(path.join(item.releases, ".activation")), false);
    const calls = fs.readFileSync(item.callsFile, "utf8");
    const recordRemoval = calls.indexOf(`rm -f ${path.join(item.releases, ".activation")}\n`);
    const recordFsync = calls.indexOf(`fsync ${item.releases}\n`, recordRemoval);
    const linkRemoval = calls.indexOf(`rm -f ${path.join(item.dockerRoot, "bin")}\n`, recordFsync);
    assert.ok(recordRemoval >= 0 && recordFsync > recordRemoval && linkRemoval > recordFsync, calls);

    result = run(item, "deactivate", "v2");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(item.dockerRoot, "bin")), false);
    assert.equal(fs.existsSync(path.join(item.releases, ".activation")), false);
  } finally {
    removeFixture(item);
  }
});

test("post-unlink fsync failure retains exact retry proof and converges", () => {
  const item = createFixture();
  try {
    const prepared = prepareRelease(item, "v2");
    let result = run(item, "stage-activate", "v2", prepared.directory, prepared.manifest, "v1");
    assert.equal(result.status, 0, result.stderr);
    configure(item, { failRootFsyncNumber: 1 });

    result = run(item, "deactivate", "v2");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /cannot persist active release removal/);
    assert.equal(fs.existsSync(path.join(item.dockerRoot, "bin")), false);
    assert.equal(fs.existsSync(path.join(item.releases, ".activation")), false);
    assert.equal(
      deactivationRecord(item),
      "DEACTIVATION_RECORD_VERSION=1\nEXPECTED=v2\n",
    );

    const callsBeforeProbe = fs.readFileSync(item.callsFile, "utf8").length;
    result = run(item, "probe");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "TRANSACTION_PROBE_VERSION=1\nactive=none\n");
    const probeCalls = fs.readFileSync(item.callsFile, "utf8").slice(callsBeforeProbe);
    assert.doesNotMatch(probeCalls, /^(mkdir|chmod|chown|cp|rm|rmdir|ln|fsync|mv) /m);

    result = run(item, "deactivate", "v1");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /belongs to a different release/);
    assert.equal(deactivationRecord(item), "DEACTIVATION_RECORD_VERSION=1\nEXPECTED=v2\n");

    result = run(item, "deactivate", "v2");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "result=deactivated\nactive=none\nprevious=v2\n");
    assert.equal(fs.existsSync(path.join(item.releases, ".deactivation")), false);
    assert.equal(fs.existsSync(path.join(item.releases, "v2")), true);
  } finally {
    removeFixture(item);
  }
});

test("final deactivation-record fsync failure restores exact retry proof", () => {
  const item = createFixture();
  try {
    const prepared = prepareRelease(item, "v2");
    let result = run(item, "stage-activate", "v2", prepared.directory, prepared.manifest, "v1");
    assert.equal(result.status, 0, result.stderr);
    configure(item, { failReleasesFsyncNumber: 3 });

    result = run(item, "deactivate", "v2");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /cannot clear completed deactivation record/);
    assert.equal(fs.existsSync(path.join(item.dockerRoot, "bin")), false);
    assert.equal(
      deactivationRecord(item),
      "DEACTIVATION_RECORD_VERSION=1\nEXPECTED=v2\n",
    );

    result = run(item, "deactivate", "v1");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /belongs to a different release/);
    assert.equal(deactivationRecord(item), "DEACTIVATION_RECORD_VERSION=1\nEXPECTED=v2\n");

    result = run(item, "deactivate", "v2");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "result=deactivated\nactive=none\nprevious=v2\n");
    assert.equal(fs.existsSync(path.join(item.releases, ".deactivation")), false);
  } finally {
    removeFixture(item);
  }
});

for (const [faultNumber, activationRemains] of [[1, true], [2, false]]) {
  test(`deactivation journal fsync ${faultNumber} retries and permits reinstall`, () => {
    const item = createFixture();
    try {
      const prepared = prepareRelease(item, "v2");
      let result = run(item, "stage-activate", "v2", prepared.directory, prepared.manifest, "v1");
      assert.equal(result.status, 0, result.stderr);
      configure(item, { failReleasesFsyncNumber: faultNumber });

      result = run(item, "deactivate", "v2");
      assert.equal(result.status, 1, result.stderr);
      assert.equal(activeTarget(item), "releases/v2");
      assert.equal(fs.existsSync(path.join(item.releases, ".activation")), activationRemains);
      assert.equal(
        deactivationRecord(item),
        "DEACTIVATION_RECORD_VERSION=1\nEXPECTED=v2\n",
      );

      result = run(item, "deactivate", "v2");
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.existsSync(path.join(item.dockerRoot, "bin")), false);
      assert.equal(fs.existsSync(path.join(item.releases, ".deactivation")), false);

      result = run(item, "stage-activate", "v2", prepared.directory, prepared.manifest, "none");
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "result=activated\nactive=v2\nprevious=none\n");
      assert.equal(activeTarget(item), "releases/v2");
    } finally {
      removeFixture(item);
    }
  });
}

test("rollback refuses a pending deactivation journal unchanged", () => {
  const item = createFixture();
  try {
    const prepared = prepareRelease(item, "v2");
    let result = run(item, "stage-activate", "v2", prepared.directory, prepared.manifest, "v1");
    assert.equal(result.status, 0, result.stderr);
    configure(item, { failReleasesFsyncNumber: 1 });
    result = run(item, "deactivate", "v2");
    assert.equal(result.status, 1, result.stderr);
    const pendingActivation = record(item);
    const pendingDeactivation = deactivationRecord(item);

    result = run(item, "rollback", "v2");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /pending deactivation must be resumed before rollback/);
    assert.equal(activeTarget(item), "releases/v2");
    assert.equal(record(item), pendingActivation);
    assert.equal(deactivationRecord(item), pendingDeactivation);
  } finally {
    removeFixture(item);
  }
});

test("deactivation re-proves stopped daemon and expected active under its lock", () => {
  for (const [label, injected, expected] of [
    ["daemon appears", { daemonAppearsOnLock: true }, /running or ambiguous/],
    ["active changes", { activeChangesOnLock: true }, /active release changed/],
  ]) {
    const item = createFixture();
    try {
      const prepared = prepareRelease(item, "v2");
      let result = run(item, "stage-activate", "v2", prepared.directory, prepared.manifest, "v1");
      assert.equal(result.status, 0, result.stderr);
      configure(item, injected);
      result = run(item, "deactivate", "v2");
      assert.equal(result.status, 1, `${label}: ${result.stderr}`);
      assert.match(result.stderr, expected, label);
      assert.equal(fs.existsSync(path.join(item.releases, ".activation")), true, label);
      assert.equal(activeTarget(item), label === "active changes" ? "releases/v1" : "releases/v2", label);
    } finally {
      removeFixture(item);
    }
  }
});

test("deactivation refuses a mismatched activation record without mutation", () => {
  const item = createFixture();
  try {
    writeActivationRecord(item, "v2", "v1");
    const beforeRecord = record(item);
    const result = run(item, "deactivate", "v1");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /does not describe the active release/);
    assert.equal(activeTarget(item), "releases/v1");
    assert.equal(record(item), beforeRecord);
  } finally {
    removeFixture(item);
  }
});

test("explicit rollback restores the recorded predecessor without deleting either release", () => {
  const item = createFixture();
  try {
    const prepared = prepareRelease(item, "v2");
    let result = run(item, "stage-activate", "v2", prepared.directory, prepared.manifest, "v1");
    assert.equal(result.status, 0, result.stderr);
    result = run(item, "rollback", "v2");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "result=rolled-back\nactive=v1\n");
    assert.equal(activeTarget(item), "releases/v1");
    assert.equal(fs.existsSync(path.join(item.releases, ".activation")), false);
    assert.equal(fs.existsSync(path.join(item.releases, "v1")), true);
    assert.equal(fs.existsSync(path.join(item.releases, "v2")), true);
  } finally {
    removeFixture(item);
  }
});

test("clean activation from no bin rolls back to absence while retaining the release", () => {
  const item = createFixture({ active: "none" });
  try {
    const prepared = prepareRelease(item, "v1");
    let result = run(item, "stage-activate", "v1", prepared.directory, prepared.manifest, "none");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "result=activated\nactive=v1\nprevious=none\n");
    assert.equal(activeTarget(item), "releases/v1");
    assert.equal(record(item), "ACTIVATION_RECORD_VERSION=1\nNEW=v1\nPREVIOUS=none\n");

    result = run(item, "rollback", "v1");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "result=rolled-back\nactive=none\n");
    assert.equal(fs.existsSync(path.join(item.dockerRoot, "bin")), false);
    assert.equal(fs.existsSync(path.join(item.releases, ".activation")), false);
    assert.equal(fs.existsSync(path.join(item.releases, "v1")), true);
  } finally {
    removeFixture(item);
  }
});

test("a link publication failure proves the old target and leaves no partial activation", () => {
  const item = createFixture();
  try {
    const prepared = prepareRelease(item, "v2");
    configure(item, { failLinkMoveNumber: 1 });
    const result = run(item, "stage-activate", "v2", prepared.directory, prepared.manifest, "v1");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /previous release was restored/);
    assert.equal(activeTarget(item), "releases/v1");
    assert.equal(fs.existsSync(path.join(item.releases, ".activation")), false);
    assert.equal(fs.existsSync(path.join(item.releases, "v2")), true);
  } finally {
    removeFixture(item);
  }
});

test("post-swap verification failure immediately rolls back to the old target", () => {
  const item = createFixture();
  try {
    const prepared = prepareRelease(item, "v2");
    configure(item, { corruptReleaseAfterLinkMove: "v2" });
    const result = run(item, "stage-activate", "v2", prepared.directory, prepared.manifest, "v1");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /failed verification; previous release was restored/);
    assert.equal(activeTarget(item), "releases/v1");
    assert.equal(fs.existsSync(path.join(item.releases, ".activation")), false);
  } finally {
    removeFixture(item);
  }
});

test("post-swap stored-manifest corruption immediately rolls back to the old target", () => {
  const item = createFixture();
  try {
    const prepared = prepareRelease(item, "v2");
    configure(item, { corruptManifestAfterLinkMove: true });
    const result = run(item, "stage-activate", "v2", prepared.directory, prepared.manifest, "v1");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /failed verification; previous release was restored/);
    assert.equal(activeTarget(item), "releases/v1");
    assert.equal(fs.existsSync(path.join(item.releases, ".activation")), false);
  } finally {
    removeFixture(item);
  }
});

test("an fsync failure after link replacement restores and proves the old target", () => {
  const item = createFixture();
  try {
    const prepared = prepareRelease(item, "v2");
    configure(item, { failRootFsyncNumber: 2 });
    const result = run(item, "stage-activate", "v2", prepared.directory, prepared.manifest, "v1");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /previous release was restored/);
    assert.equal(activeTarget(item), "releases/v1");
    assert.equal(fs.existsSync(path.join(item.releases, ".activation")), false);
    assert.equal(fs.existsSync(path.join(item.releases, "v2")), true);
  } finally {
    removeFixture(item);
  }
});

test("an unprovable automatic rollback returns the distinct attention status", () => {
  const item = createFixture();
  try {
    const prepared = prepareRelease(item, "v2");
    configure(item, { corruptReleaseAfterLinkMove: "v2", failLinkMoveNumber: 2 });
    const result = run(item, "stage-activate", "v2", prepared.directory, prepared.manifest, "v1");
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stderr, /rollback could not be proved/);
    assert.equal(activeTarget(item), "releases/v2");
    assert.equal(fs.existsSync(path.join(item.releases, ".activation")), true);
  } finally {
    removeFixture(item);
  }
});

test("a staging rename failure cannot change the active release", () => {
  const item = createFixture();
  try {
    const prepared = prepareRelease(item, "v2");
    configure(item, { failStageMove: true });
    const result = run(item, "stage-activate", "v2", prepared.directory, prepared.manifest, "v1");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /cannot publish finalized release directory/);
    assert.equal(activeTarget(item), "releases/v1");
    assert.equal(fs.existsSync(path.join(item.releases, "v2.staging")), true);
    assert.equal(fs.existsSync(path.join(item.releases, "v2")), false);
  } finally {
    removeFixture(item);
  }
});

test("an exact finalized release resumes after a pre-activation failure", () => {
  const item = createFixture();
  try {
    const prepared = prepareRelease(item, "v2");
    configure(item, { failLinkMoveNumber: 1 });
    let result = run(item, "stage-activate", "v2", prepared.directory, prepared.manifest, "v1");
    assert.equal(result.status, 1, result.stderr);
    assert.equal(activeTarget(item), "releases/v1");
    assert.equal(fs.existsSync(path.join(item.releases, "v2")), true);
    configure(item, {});
    result = run(item, "stage-activate", "v2", prepared.directory, prepared.manifest, "v1");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(activeTarget(item), "releases/v2");
  } finally {
    removeFixture(item);
  }
});

test("an exact complete staging tree resumes after an interrupted final rename", () => {
  const item = createFixture();
  try {
    const prepared = prepareRelease(item, "v2");
    configure(item, { failStageMove: true });
    let result = run(item, "stage-activate", "v2", prepared.directory, prepared.manifest, "v1");
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(path.join(item.releases, "v2.staging")), true);
    configure(item, {});
    result = run(item, "stage-activate", "v2", prepared.directory, prepared.manifest, "v1");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(activeTarget(item), "releases/v2");
    assert.equal(fs.existsSync(path.join(item.releases, "v2.staging")), false);
  } finally {
    removeFixture(item);
  }
});

test("an exact record-before-link interruption resumes the pending activation", () => {
  const item = createFixture();
  try {
    const prepared = prepareRelease(item, "v2");
    finalizePreparedRelease(item, prepared, "v2");
    writeActivationRecord(item, "v2", "v1");
    const result = run(item, "stage-activate", "v2", prepared.directory, prepared.manifest, "v1");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(activeTarget(item), "releases/v2");
    assert.equal(record(item), "ACTIVATION_RECORD_VERSION=1\nNEW=v2\nPREVIOUS=v1\n");
  } finally {
    removeFixture(item);
  }
});

test("an exact link-before-return interruption and same-version reinstall converge", () => {
  const item = createFixture();
  try {
    const prepared = prepareRelease(item, "v2");
    finalizePreparedRelease(item, prepared, "v2");
    writeActivationRecord(item, "v2", "v1");
    fs.unlinkSync(path.join(item.dockerRoot, "bin"));
    fs.symlinkSync("releases/v2", path.join(item.dockerRoot, "bin"));
    let result = run(item, "stage-activate", "v2", prepared.directory, prepared.manifest, "v1");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "result=already-active\nactive=v2\nprevious=v1\n");
    result = run(item, "stage-activate", "v2", prepared.directory, prepared.manifest, "v2");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "result=already-active\nactive=v2\nprevious=v1\n");
  } finally {
    removeFixture(item);
  }
});

test("a corrupted full predecessor is not retained as rollback state", () => {
  const item = createFixture();
  try {
    fs.appendFileSync(path.join(item.releases, "v1", "ctr"), "corrupt\n");
    const prepared = prepareRelease(item, "v2");
    const result = run(item, "stage-activate", "v2", prepared.directory, prepared.manifest, "v1");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /active release link is malformed or unsafe/);
    assert.equal(activeTarget(item), "releases/v1");
    assert.equal(fs.existsSync(path.join(item.releases, "v2.staging")), false);
  } finally {
    removeFixture(item);
  }
});

test("a partial pre-existing staging tree is refused and left untouched", () => {
  const item = createFixture();
  try {
    const staging = path.join(item.releases, "v2.staging");
    fs.mkdirSync(staging);
    fs.writeFileSync(path.join(staging, "sentinel"), "keep\n");
    const prepared = prepareRelease(item, "v2");
    const result = run(item, "stage-activate", "v2", prepared.directory, prepared.manifest, "v1");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /staging path exists with unverified content/);
    assert.equal(activeTarget(item), "releases/v1");
    assert.equal(fs.readFileSync(path.join(staging, "sentinel"), "utf8"), "keep\n");
  } finally {
    removeFixture(item);
  }
});

test("a populated real bin directory is refused before staging", () => {
  const item = createFixture();
  try {
    fs.unlinkSync(path.join(item.dockerRoot, "bin"));
    fs.mkdirSync(path.join(item.dockerRoot, "bin"));
    fs.writeFileSync(path.join(item.dockerRoot, "bin", "legacy"), "keep\n");
    const prepared = prepareRelease(item, "v2");
    const result = run(item, "stage-activate", "v2", prepared.directory, prepared.manifest, "v1");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /active release link is malformed or unsafe/);
    assert.equal(fs.readFileSync(path.join(item.dockerRoot, "bin", "legacy"), "utf8"), "keep\n");
    assert.equal(fs.existsSync(path.join(item.releases, "v2")), false);
  } finally {
    removeFixture(item);
  }
});

test("a live shared lifecycle lock refuses activation and remains intact", () => {
  const item = createFixture();
  try {
    const lock = path.join(item.runRoot, "host-lifecycle.lock");
    fs.mkdirSync(lock, { mode: 0o700 });
    fs.writeFileSync(path.join(lock, "pid"), "777\n", { mode: 0o600 });
    fs.mkdirSync(path.join(item.procRoot, "777"));
    const prepared = prepareRelease(item, "v2");
    const result = run(item, "stage-activate", "v2", prepared.directory, prepared.manifest, "v1");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /another lifecycle operation is in progress/);
    assert.equal(fs.readFileSync(path.join(lock, "pid"), "utf8"), "777\n");
    assert.equal(fs.existsSync(path.join(item.releases, "v2")), false);
  } finally {
    removeFixture(item);
  }
});

test("a stale lifecycle claimant rechecks the owner after winning recovery election", () => {
  const item = createFixture();
  try {
    const lock = path.join(item.runRoot, "host-lifecycle.lock");
    fs.mkdirSync(lock, { mode: 0o700 });
    fs.writeFileSync(path.join(lock, "pid"), "777\n", { mode: 0o600 });
    const inode = fs.statSync(lock).ino;
    configure(item, { raceLifecycleTakeover: true });
    const prepared = prepareRelease(item, "v2");
    const result = run(item, "stage-activate", "v2", prepared.directory, prepared.manifest, "v1");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /lifecycle lock changed during stale recovery/);
    assert.equal(fs.statSync(lock).ino, inode);
    assert.equal(fs.readFileSync(path.join(lock, "pid"), "utf8"), "999\n");
    assert.equal(fs.existsSync(path.join(lock, ".recovery")), false);
    assert.equal(activeTarget(item), "releases/v1");
    assert.equal(fs.existsSync(path.join(item.releases, "v2.staging")), false);
    assert.equal(fs.existsSync(path.join(item.releases, "v2")), false);
  } finally {
    removeFixture(item);
  }
});

for (const [label, mutate, expected] of [
  ["unsupported header", (_item, prepared) => fs.writeFileSync(prepared.manifest, "RELEASE_MANIFEST_VERSION=2\n"), /unsupported header/],
  ["trailing blank row", (_item, prepared) => fs.appendFileSync(prepared.manifest, "\n"), /blank or malformed row/],
  ["reordered rows", (_item, prepared) => {
    const lines = fs.readFileSync(prepared.manifest, "utf8").trimEnd().split("\n");
    [lines[1], lines[2]] = [lines[2], lines[1]];
    fs.writeFileSync(prepared.manifest, `${lines.join("\n")}\n`);
  }, /rows are not in canonical order/],
  ["wrong hash", (_item, prepared) => fs.appendFileSync(path.join(prepared.directory, "docker"), "changed\n"), /does not match its manifest/],
  ["wrong source mode", (_item, prepared) => fs.chmodSync(path.join(prepared.directory, "docker"), 0o644), /does not match its manifest/],
  ["non-executable manifest mode", (_item, prepared) => {
    const text = fs.readFileSync(prepared.manifest, "utf8").replace(/(docker\t[^\n]+\t)0755\n/, "$10644\n");
    fs.writeFileSync(prepared.manifest, text);
  }, /required runtime member is not executable/],
  ["unmanifested source member", (_item, prepared) => fs.writeFileSync(path.join(prepared.directory, "extra"), "extra\n"), /unmanifested member/],
  ["manifested extra member", (_item, prepared) => {
    const contents = Buffer.from("extra\n");
    fs.writeFileSync(path.join(prepared.directory, "extra"), contents, { mode: 0o755 });
    fs.appendFileSync(prepared.manifest, `extra\t${contents.length}\t${sha256(contents)}\t0755\n`);
  }, /rows are not in canonical order/],
]) {
  test(`strict manifest and source validation refuses ${label} before staging`, () => {
    const item = createFixture();
    try {
      const prepared = prepareRelease(item, "v2");
      mutate(item, prepared);
      const result = run(item, "stage-activate", "v2", prepared.directory, prepared.manifest, "v1");
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, expected);
      assert.equal(activeTarget(item), "releases/v1");
      assert.equal(fs.existsSync(path.join(item.releases, "v2.staging")), false);
      assert.equal(fs.existsSync(path.join(item.releases, "v2")), false);
    } finally {
      removeFixture(item);
    }
  });
}

for (const [label, arrange] of [
  ["dockerd process", (item) => {
    const processRoot = path.join(item.procRoot, "900");
    fs.mkdirSync(processRoot);
    fs.writeFileSync(path.join(processRoot, "comm"), "dockerd\n");
  }],
  ["ambiguous pidfile", (item) => fs.writeFileSync(path.join(item.runRoot, "docker.pid"), "900\n")],
]) {
  test(`${label} refuses activation before release staging`, () => {
    const item = createFixture();
    try {
      arrange(item);
      const prepared = prepareRelease(item, "v2");
      const result = run(item, "stage-activate", "v2", prepared.directory, prepared.manifest, "v1");
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /running or ambiguous/);
      assert.equal(activeTarget(item), "releases/v1");
      assert.equal(fs.existsSync(path.join(item.releases, "v2")), false);
    } finally {
      removeFixture(item);
    }
  });
}

for (const [label, arrange] of [
  ["active-release containerd shim", (item) => {
    const processRoot = path.join(item.procRoot, "901");
    fs.mkdirSync(processRoot);
    fs.writeFileSync(path.join(processRoot, "comm"), "containerd-shim\n");
    fs.symlinkSync(path.join(item.releases, "v1", "containerd-shim-runc-v2"), path.join(processRoot, "exe"));
  }],
  ["foreign containerd shim", (item) => {
    const processRoot = path.join(item.procRoot, "902");
    fs.mkdirSync(processRoot);
    fs.writeFileSync(path.join(processRoot, "comm"), "worker\n");
    fs.symlinkSync("/foreign/bin/containerd-shim-runc-v2", path.join(processRoot, "exe"));
  }],
]) {
  test(`${label} refuses both probe and activation`, () => {
    const item = createFixture();
    try {
      arrange(item);
      let result = run(item, "probe");
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /running or ambiguous/);
      assert.equal(activeTarget(item), "releases/v1");

      const prepared = prepareRelease(item, "v2");
      result = run(item, "stage-activate", "v2", prepared.directory, prepared.manifest, "v1");
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /running or ambiguous/);
      assert.equal(activeTarget(item), "releases/v1");
      assert.equal(fs.existsSync(path.join(item.releases, "v2")), false);
    } finally {
      removeFixture(item);
    }
  });
}

test("an exact absolute active link target is accepted and normalized on activation", () => {
  const item = createFixture();
  try {
    fs.unlinkSync(path.join(item.dockerRoot, "bin"));
    fs.symlinkSync(path.join(item.releases, "v1"), path.join(item.dockerRoot, "bin"));
    const prepared = prepareRelease(item, "v2");
    const result = run(item, "stage-activate", "v2", prepared.directory, prepared.manifest, "v1");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(activeTarget(item), "releases/v2");
  } finally {
    removeFixture(item);
  }
});

test("a non-executable active predecessor is refused before staging", () => {
  const item = createFixture();
  try {
    fs.chmodSync(path.join(item.releases, "v1", "dockerd"), 0o644);
    const prepared = prepareRelease(item, "v2");
    const result = run(item, "stage-activate", "v2", prepared.directory, prepared.manifest, "v1");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /active release link is malformed or unsafe/);
    assert.equal(activeTarget(item), "releases/v1");
    assert.equal(fs.existsSync(path.join(item.releases, "v2")), false);
  } finally {
    removeFixture(item);
  }
});

test("rollback refuses a predecessor that is no longer executable", () => {
  const item = createFixture();
  try {
    const prepared = prepareRelease(item, "v2");
    let result = run(item, "stage-activate", "v2", prepared.directory, prepared.manifest, "v1");
    assert.equal(result.status, 0, result.stderr);
    fs.chmodSync(path.join(item.releases, "v1", "dockerd"), 0o644);
    result = run(item, "rollback", "v2");
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stderr, /rollback could not be proved/);
    assert.equal(activeTarget(item), "releases/v2");
    assert.equal(fs.existsSync(path.join(item.releases, ".activation")), true);
  } finally {
    removeFixture(item);
  }
});

for (const [label, mutate] of [
  ["mode", (item) => fs.chmodSync(path.join(item.releases, ".activation"), 0o644)],
  ["owner", (item) => configure(item, { nonRootSuffix: "/.activation" })],
]) {
  test(`rollback refuses an activation record with wrong ${label}`, () => {
    const item = createFixture();
    try {
      const prepared = prepareRelease(item, "v2");
      let result = run(item, "stage-activate", "v2", prepared.directory, prepared.manifest, "v1");
      assert.equal(result.status, 0, result.stderr);
      mutate(item);
      result = run(item, "rollback", "v2");
      assert.equal(result.status, 3, result.stderr);
      assert.match(result.stderr, /rollback could not be proved/);
      assert.equal(activeTarget(item), "releases/v2");
      assert.equal(fs.existsSync(path.join(item.releases, ".activation")), true);
    } finally {
      removeFixture(item);
    }
  });
}
