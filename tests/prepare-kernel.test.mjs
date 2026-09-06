import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(projectRoot, "module", "bin", "prepare-kernel"), "utf8");
const buildId = "TEST.1";
const imageName = `Image-${buildId}.lz4`;
const image = Buffer.from("qualified synthetic kernel candidate\n");

function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function writeExecutable(file, contents) {
  fs.writeFileSync(file, contents, { mode: 0o755 });
}

function inputBytes() {
  return Buffer.from([
    "INSTALLER_INPUTS_VERSION=1",
    "MODULE\t0.1.0\t1",
    `BUILD\t${buildId}\tkodiak\tgoogle/kodiak/kodiak:17/TEST.1/1:user/release-keys\t17\t2026-08-05\t6.12.69-test\t67108864\t4096\t4\t1584\t0\t${imageName}`,
    `BOOT_STATE\t${buildId}\tcurrent-public\t${image.length}\t${sha256(image)}\t67108864\t${"a".repeat(64)}`,
    "",
  ].join("\n"));
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
  stat)
    [ "$#" -eq 3 ] && [ "$1" = -c ] && [ "$2" = %s ] || exit 2
    /usr/bin/stat -f '%z' "$3"
    ;;
  sha256sum)
    HASH=$(/usr/bin/openssl dgst -sha256 -r "$1") || exit 1
    HASH=\${HASH%% *}
    printf '%s  %s\n' "$HASH" "$1"
    ;;
  readlink) [ "$#" -eq 2 ] && [ "$1" = -f ] && exec /bin/realpath "$2" ;;
  awk)
    /usr/bin/awk "$@"
    STATUS=$?
    if [ -f "$STATE/replace-input-after-awk" ]; then
      printf '\n' >> "$STATE/../module/installer-inputs.tsv"
      /bin/rm -f "$STATE/replace-input-after-awk"
    fi
    exit "$STATUS"
    ;;
  mkdir) exec /bin/mkdir "$@" ;;
  chmod) exec /bin/chmod "$@" ;;
  chown) [ "$#" -eq 2 ] && [ "$1" = 0:0 ] ;;
  cp) exec /bin/cp "$@" ;;
  rm) exec /bin/rm "$@" ;;
  mv) [ "\${1:-}" != -T ] || shift; exec /bin/mv "$@" ;;
  *) printf 'unsupported applet: %s\n' "$APPLET" >&2; exit 2 ;;
esac
`;
}

function fixture(sourceKind = "sideload") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "prepare-kernel-")));
  const moduleDir = path.join(root, "module");
  const binDir = path.join(moduleDir, "bin");
  const tmpDir = path.join(root, "tmp");
  const cacheRoot = path.join(root, "cache");
  const sideloadRoot = path.join(root, "sideload");
  const state = path.join(root, "state");
  const calls = path.join(root, "calls.log");
  for (const directory of [binDir, tmpDir, cacheRoot, sideloadRoot, state]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const inputs = path.join(moduleDir, "installer-inputs.tsv");
  fs.writeFileSync(inputs, inputBytes());
  const busybox = path.join(root, "busybox");
  writeExecutable(busybox, busyboxSource(state, calls));
  let runnable = source;
  for (const [from, to] of [
    ["#!/system/bin/sh", "#!/bin/sh"],
    ["BUSYBOX=/data/adb/ksu/bin/busybox", `BUSYBOX=${shellQuote(busybox)}`],
    ["CACHE_ROOT=/data/docker/downloads", `CACHE_ROOT=${shellQuote(cacheRoot)}`],
    ["SIDELOAD_ROOT=/data/local/tmp", `SIDELOAD_ROOT=${shellQuote(sideloadRoot)}`],
  ]) {
    assert.equal(runnable.split(from).length, 2, from);
    runnable = runnable.replace(from, to);
  }
  const command = path.join(binDir, "prepare-kernel");
  writeExecutable(command, runnable);
  if (sourceKind === "cache") fs.writeFileSync(path.join(cacheRoot, imageName), image);
  if (sourceKind === "sideload") fs.writeFileSync(path.join(sideloadRoot, imageName), image);
  return {
    root, tmpDir, cacheRoot, sideloadRoot, state, calls, inputs, command,
    prepared: path.join(tmpDir, "eip-kernel-prepared"),
    work: path.join(tmpDir, ".eip-kernel-prepare.work"),
  };
}

function run(item, inputHash = sha256(fs.readFileSync(item.inputs)), ...args) {
  const result = spawnSync("/bin/sh", [item.command, buildId, inputHash, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, TMPDIR: item.tmpDir },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(typeof result.status, "number");
  return result;
}

function remove(item) {
  fs.rmSync(item.root, { recursive: true, force: true });
}

for (const sourceKind of ["cache", "sideload"]) {
  test(`prepare-kernel publishes the exact ${sourceKind} candidate in TMPDIR`, () => {
    const item = fixture(sourceKind);
    try {
      const sourceFile = path.join(item[`${sourceKind}Root`], imageName);
      const before = fs.readFileSync(sourceFile);
      const inputHash = sha256(fs.readFileSync(item.inputs));
      const result = run(item, inputHash);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, [
        "KERNEL_PREPARE_VERSION=1",
        `build_id=${buildId}`,
        `acquisition_source=${sourceKind}`,
        `prepared_path=${item.prepared}`,
        `image_size=${image.length}`,
        `image_sha256=${sha256(image)}`,
        `installer_inputs_sha256=${inputHash}`,
        "",
      ].join("\n"));
      assert.deepEqual(fs.readFileSync(item.prepared), image);
      assert.equal(fs.statSync(item.prepared).mode & 0o777, 0o600);
      assert.deepEqual(fs.readFileSync(sourceFile), before);
      assert.equal(fs.existsSync(item.work), false);
    } finally {
      remove(item);
    }
  });
}

test("an invalid present cache refuses without falling through to a valid sideload", () => {
  const item = fixture("sideload");
  try {
    fs.writeFileSync(path.join(item.cacheRoot, imageName), "wrong\n");
    const result = run(item);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /existing-host kernel cache has an unsafe type or wrong identity/);
    assert.equal(fs.existsSync(item.prepared), false);
    assert.equal(fs.existsSync(item.work), false);
  } finally {
    remove(item);
  }
});

test("a missing image prints the exact sideload command and leaves no output", () => {
  const item = fixture("none");
  try {
    const result = run(item);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`adb push ${imageName} ${item.sideloadRoot}/${imageName}`));
    assert.equal(fs.existsSync(item.prepared), false);
    assert.equal(fs.existsSync(item.work), false);
  } finally {
    remove(item);
  }
});

test("prepare-kernel binds the preflight hash and detects a changing input", () => {
  for (const mode of ["wrong-hash", "changed-after-selection"]) {
    const item = fixture();
    try {
      if (mode === "changed-after-selection") fs.writeFileSync(path.join(item.state, "replace-input-after-awk"), "yes\n");
      const result = run(item, mode === "wrong-hash" ? "0".repeat(64) : sha256(fs.readFileSync(item.inputs)));
      assert.notEqual(result.status, 0, mode);
      assert.match(result.stderr, /do not match preflight|changed during kernel selection/, mode);
      assert.equal(fs.existsSync(item.prepared), false, mode);
    } finally {
      remove(item);
    }
  }
});

test("prepare-kernel refuses unsafe invocation and pre-existing private paths", () => {
  const item = fixture();
  try {
    let result = spawnSync("/bin/sh", [item.command], {
      encoding: "utf8", timeout: 15_000, env: { ...process.env, TMPDIR: item.tmpDir },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 2);
    fs.mkdirSync(item.work);
    result = run(item);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /work path already exists/);
    assert.equal(fs.existsSync(item.work), true);
  } finally {
    remove(item);
  }
});

test("prepare-kernel is a bounded TMPDIR-only copy primitive", () => {
  assert.doesNotMatch(source, /\bcurl\b|\bwget\b|swap-boot-kernel|release-transaction|hostctl|\bdd\b/);
  assert.doesNotMatch(source, /\/data\/docker\/(?:kernel|boot-backup|releases|run)/);
  assert.match(source, /^CACHE_ROOT=\/data\/docker\/downloads$/m);
});
