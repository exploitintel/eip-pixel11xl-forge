import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(projectRoot, "module", "bin", "prepare-engine"), "utf8");
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
const packagedNames = ["buildkit-runc.sh", "dockerd.sh", "hostctl", "privns", "route-policy"];
const releaseNames = [...runtimeNames, ...packagedNames].toSorted();
const engineVersion = "1.2.3";
const tarballName = `docker-${engineVersion}.tgz`;
const rules = [
  ["/run/a", "/dev/a"],
  ["/run/b", "/dev/b"],
  ["/run/c", "/dev/c"],
];

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function writeExecutable(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, { mode: 0o755 });
}

function applyRules(contents, enabled) {
  let result = Buffer.from(contents);
  const counts = [];
  for (const [from, to] of rules) {
    const input = Buffer.from(from);
    const output = Buffer.from(to);
    let count = 0;
    if (enabled) {
      for (let offset = 0; offset <= result.length - input.length; offset += 1) {
        if (!result.subarray(offset, offset + input.length).equals(input)) continue;
        output.copy(result, offset);
        count += 1;
        offset += input.length - 1;
      }
    }
    counts.push(count);
  }
  return { contents: result, counts };
}

function writeOctal(header, offset, width, value) {
  const encoded = value.toString(8).padStart(width - 1, "0");
  assert.ok(encoded.length < width);
  header.write(encoded, offset, width - 1, "ascii");
  header[offset + width - 1] = 0;
}

function tarEntry({ name, contents = Buffer.alloc(0), type = "file", linkname = "" }) {
  const payload = Buffer.from(contents);
  const header = Buffer.alloc(512);
  assert.ok(Buffer.byteLength(name) <= 100, name);
  header.write(name, 0, 100, "ascii");
  writeOctal(header, 100, 8, type === "directory" ? 0o755 : 0o755);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, type === "file" ? payload.length : 0);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = { file: 0x30, directory: 0x35, symlink: 0x32 }[type];
  if (linkname) header.write(linkname, 157, 100, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("root", 265, 32, "ascii");
  header.write("root", 297, 32, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  if (type !== "file") return header;
  const padding = Buffer.alloc((512 - (payload.length % 512)) % 512);
  return Buffer.concat([header, payload, padding]);
}

function makeTarball(members) {
  const records = [tarEntry({ name: "docker/", type: "directory" })];
  records.push(...members.map(tarEntry));
  records.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(records), { level: 9 });
}

function busyboxSource(stateDir, callsFile) {
  return `#!/bin/sh
STATE=${shellQuote(stateDir)}
CALLS=${shellQuote(callsFile)}
APPLET=\${1:-}
shift || exit 1
printf 'busybox:%s' "$APPLET" >> "$CALLS"
for ARG in "$@"; do printf ' %s' "$ARG" >> "$CALLS"; done
printf '\n' >> "$CALLS"
case "$APPLET" in
  id) [ "$#" -eq 1 ] && [ "$1" = -u ] && printf '0\n' ;;
  stat)
    [ "$#" -eq 3 ] && [ "$1" = -c ] || exit 2
    case "$2" in
      %s) /usr/bin/stat -f '%z' "$3" ;;
      %a) /usr/bin/stat -f '%Lp' "$3" ;;
      %u:%g) printf '0:0\n' ;;
      *) exit 2 ;;
    esac
    ;;
  sha256sum)
    [ "$#" -eq 1 ] || exit 2
    HASH=$(/usr/bin/openssl dgst -sha256 -r "$1") || exit 1
    HASH=\${HASH%% *}
    printf '%s  %s\n' "$HASH" "$1"
    ;;
  readlink)
    [ "$#" -eq 2 ] && [ "$1" = -f ] || exit 2
    exec /bin/realpath "$2"
    ;;
  awk) exec /usr/bin/awk "$@" ;;
  tar) exec /usr/bin/tar "$@" ;;
  mkdir) exec /bin/mkdir "$@" ;;
  chmod) exec /bin/chmod "$@" ;;
  chown) [ "$#" -eq 2 ] && [ "$1" = 0:0 ] ;;
  cp) exec /bin/cp "$@" ;;
  rm) exec /bin/rm "$@" ;;
  ls) exec /bin/ls "$@" ;;
  mv)
    [ "\${1:-}" != -T ] || shift
    exec /bin/mv "$@"
    ;;
  *) printf 'unsupported fake BusyBox applet: %s\n' "$APPLET" >&2; exit 2 ;;
esac
`;
}

function patcherSource(stateDir, callsFile) {
  return `#!/bin/sh
set -u
STATE=${shellQuote(stateDir)}
CALLS=${shellQuote(callsFile)}
printf 'patch-engine' >> "$CALLS"
for ARG in "$@"; do printf ' %s' "$ARG" >> "$CALLS"; done
printf '\n' >> "$CALLS"
[ "$#" -ge 8 ] || exit 90
INPUT=$1
OUTPUT=$2
shift 2
SIZE=
INPUT_HASH=
OUTPUT_HASH=
REPLACEMENTS=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --expect-input-size) SIZE=$2; shift 2 ;;
    --expect-input-sha256) INPUT_HASH=$2; shift 2 ;;
    --expect-output-sha256) OUTPUT_HASH=$2; shift 2 ;;
    --replace)
      ROW="$2	$3	$4"
      REPLACEMENTS="\${REPLACEMENTS}\${REPLACEMENTS:+
}\${ROW}"
      shift 4
      ;;
    *) exit 91 ;;
  esac
done
[ -n "$SIZE" ] && [ -n "$INPUT_HASH" ] && [ -n "$OUTPUT_HASH" ] || exit 92
ACTUAL_SIZE=$(/usr/bin/wc -c < "$INPUT" | /usr/bin/tr -d ' ')
ACTUAL_HASH=$(/usr/bin/openssl dgst -sha256 -r "$INPUT") || exit 1
ACTUAL_HASH=\${ACTUAL_HASH%% *}
[ "$ACTUAL_SIZE" = "$SIZE" ] && [ "$ACTUAL_HASH" = "$INPUT_HASH" ] || exit 93
EXPECTED=$STATE/expected/$INPUT_HASH
EXPECTED_ARGS=$STATE/arguments/$INPUT_HASH
[ -f "$EXPECTED" ] && [ -f "$EXPECTED_ARGS" ] || exit 94
[ "$REPLACEMENTS" = "$(/bin/cat "$EXPECTED_ARGS")" ] || exit 95
EXPECTED_HASH=$(/usr/bin/openssl dgst -sha256 -r "$EXPECTED") || exit 1
EXPECTED_HASH=\${EXPECTED_HASH%% *}
[ "$EXPECTED_HASH" = "$OUTPUT_HASH" ] || exit 96
NAME=$(/bin/cat "$STATE/names/$INPUT_HASH") || exit 1
[ ! -f "$STATE/fail-$NAME" ] || exit 97
/bin/cp "$EXPECTED" "$OUTPUT" || exit 1
/bin/chmod 0755 "$OUTPUT" || exit 1
[ ! -f "$STATE/corrupt-$NAME" ] || printf 'corrupt' >> "$OUTPUT"
printf '%s  %s\n' "$OUTPUT_HASH" "$OUTPUT"
`;
}

function curlSource(stateDir, callsFile) {
  return `#!/bin/sh
STATE=${shellQuote(stateDir)}
CALLS=${shellQuote(callsFile)}
printf 'curl' >> "$CALLS"
for ARG in "$@"; do printf ' %s' "$ARG" >> "$CALLS"; done
printf '\n' >> "$CALLS"
OUTPUT=
URL=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) OUTPUT=$2; shift 2 ;;
    --fail|--location|--tlsv1.2) shift ;;
    --proto|--proto-redir) shift 2 ;;
    https://*) URL=$1; shift ;;
    *) exit 81 ;;
  esac
done
[ -n "$OUTPUT" ] && [ -n "$URL" ] || exit 82
/bin/cp "$STATE/download.tgz" "$OUTPUT"
`;
}

function fixture({ sourceKind = "cache", mutateMembers, curl = sourceKind === "download" } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "prepare-engine-")));
  const moduleDir = path.join(root, "module");
  const binDir = path.join(moduleDir, "bin");
  const tmpDir = path.join(root, "tmp");
  const cacheRoot = path.join(root, "cache");
  const sideloadRoot = path.join(root, "sideload");
  const systemBin = path.join(root, "system-bin");
  const stateDir = path.join(root, "state");
  const callsFile = path.join(root, "calls.log");
  for (const directory of [binDir, tmpDir, cacheRoot, sideloadRoot, systemBin, stateDir]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  fs.mkdirSync(path.join(stateDir, "expected"));
  fs.mkdirSync(path.join(stateDir, "arguments"));
  fs.mkdirSync(path.join(stateDir, "names"));

  const originals = new Map();
  const outputs = new Map();
  const records = new Map();
  for (const name of runtimeNames) {
    const original = name === "dockerd"
      ? Buffer.from(`input:${name}:/run/a:/run/b:/run/c\n`)
      : Buffer.from(`input:${name}:unchanged\n`);
    const patched = applyRules(original, name === "dockerd");
    const inputHash = sha256(original);
    originals.set(name, original);
    outputs.set(name, patched.contents);
    records.set(name, {
      size: original.length,
      inputHash,
      outputHash: sha256(patched.contents),
      patch: name === "dockerd" ? 1 : 0,
      counts: patched.counts,
    });
    fs.writeFileSync(path.join(stateDir, "expected", inputHash), patched.contents);
    fs.writeFileSync(path.join(stateDir, "names", inputHash), name);
    fs.writeFileSync(
      path.join(stateDir, "arguments", inputHash),
      name === "dockerd"
        ? rules.map(([from, to], index) => `${from}\t${to}\t${patched.counts[index]}`).join("\n")
        : "",
    );
  }

  let members = runtimeNames.map((name) => ({
    name: `docker/${name}`,
    contents: originals.get(name),
    type: "file",
  }));
  if (mutateMembers) members = mutateMembers(members.map((entry) => ({ ...entry })), originals);
  const tarball = makeTarball(members);
  fs.writeFileSync(path.join(stateDir, "download.tgz"), tarball);

  const installerRows = [
    "INSTALLER_INPUTS_VERSION=1",
    "MODULE\t0.1.0-dev\t1",
    `ENGINE\t${engineVersion}\t${tarballName}\t${tarball.length}\t${sha256(tarball)}\thttps://download.docker.com/linux/static/stable/aarch64/${tarballName}`,
    ...rules.map(([from, to], index) => `RULE\t${index}\t${from}\t${to}`),
    ...runtimeNames.map((name) => {
      const record = records.get(name);
      return [
        "BINARY", name, record.size, record.inputHash, record.outputHash,
        record.patch, ...record.counts,
      ].join("\t");
    }),
    "BUILD\tTEST.1\tkodiak\tgoogle/kodiak/kodiak:17/TEST.1/1:user/release-keys\t17\t2026-08-05\t6.12.69-test\t4096\t4096\t4\t1584\t0\tImage-TEST.1.lz4",
    "KSU\tTEST.1\tlkm\t3.3.0",
    `BOOT_STATE\tTEST.1\tcurrent-public\t1\t${"a".repeat(64)}\t4096\t${"b".repeat(64)}`,
  ];
  fs.writeFileSync(path.join(moduleDir, "installer-inputs.tsv"), `${installerRows.join("\n")}\n`);

  const expected = new Map(outputs);
  for (const name of packagedNames) {
    const contents = Buffer.from(`packaged:${name}\n`);
    expected.set(name, contents);
    fs.writeFileSync(path.join(binDir, name), contents, { mode: 0o755 });
  }
  const manifestRows = releaseNames.map((name) => {
    const contents = expected.get(name);
    return `${name}\t${contents.length}\t${sha256(contents)}\t0755`;
  });
  fs.writeFileSync(
    path.join(moduleDir, "release-manifest.tsv"),
    `RELEASE_MANIFEST_VERSION=1\n${manifestRows.join("\n")}\n`,
  );

  const busybox = path.join(root, "busybox");
  writeExecutable(busybox, busyboxSource(stateDir, callsFile));
  writeExecutable(path.join(binDir, "patch-engine"), patcherSource(stateDir, callsFile));
  if (curl) writeExecutable(path.join(systemBin, "curl"), curlSource(stateDir, callsFile));

  let runnable = source;
  for (const [from, to] of [
    ["#!/system/bin/sh", "#!/bin/sh"],
    ["BUSYBOX=/data/adb/ksu/bin/busybox", `BUSYBOX=${shellQuote(busybox)}`],
    ["SYSTEM_BIN=/system/bin", `SYSTEM_BIN=${shellQuote(systemBin)}`],
    ["CACHE_ROOT=/data/docker/downloads", `CACHE_ROOT=${shellQuote(cacheRoot)}`],
    ["SIDELOAD_ROOT=/data/local/tmp", `SIDELOAD_ROOT=${shellQuote(sideloadRoot)}`],
  ]) {
    assert.equal(runnable.split(from).length, 2, `expected one source constant: ${from}`);
    runnable = runnable.replace(from, to);
  }
  const command = path.join(binDir, "prepare-engine");
  writeExecutable(command, runnable);

  if (sourceKind === "cache") fs.writeFileSync(path.join(cacheRoot, tarballName), tarball);
  if (sourceKind === "sideload") fs.writeFileSync(path.join(sideloadRoot, tarballName), tarball);
  return {
    root, moduleDir, tmpDir, cacheRoot, sideloadRoot, stateDir, callsFile,
    command, tarball, expected,
    prepared: path.join(tmpDir, "eip-engine-prepared"),
    work: path.join(tmpDir, ".eip-engine-prepare.work"),
  };
}

function run(item, ...args) {
  return spawnSync("/bin/sh", [item.command, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, TMPDIR: item.tmpDir },
  });
}

function removeFixture(item) {
  fs.rmSync(item.root, { recursive: true, force: true });
}

function fileIdentity(file) {
  const status = fs.lstatSync(file);
  return { mode: status.mode & 0o777, size: status.size, hash: sha256(fs.readFileSync(file)) };
}

function assertCompleted(result) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, `unexpected signal: ${result.signal}`);
  assert.equal(typeof result.status, "number", "helper did not return an exit status");
}

function assertPrepared(item, acquisitionSource, result) {
  assertCompleted(result);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    `ENGINE_PREPARE_VERSION=1\nengine_version=${engineVersion}\nacquisition_source=${acquisitionSource}\nprepared_path=${item.prepared}\nmanifest_path=${path.join(item.moduleDir, "release-manifest.tsv")}\ninstaller_inputs_sha256=${sha256(fs.readFileSync(path.join(item.moduleDir, "installer-inputs.tsv")))}\nrelease_manifest_sha256=${sha256(fs.readFileSync(path.join(item.moduleDir, "release-manifest.tsv")))}\n`,
  );
  assert.deepEqual(fs.readdirSync(item.prepared).toSorted(), releaseNames);
  for (const name of releaseNames) {
    const file = path.join(item.prepared, name);
    assert.equal(fs.lstatSync(file).isFile(), true, name);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false, name);
    assert.equal(fs.statSync(file).mode & 0o777, 0o755, name);
    assert.deepEqual(fs.readFileSync(file), item.expected.get(name), name);
  }
  assert.equal(fs.existsSync(item.work), false);
  const calls = fs.existsSync(item.callsFile) ? fs.readFileSync(item.callsFile, "utf8") : "";
  assert.equal((calls.match(/^patch-engine /gm) ?? []).length, 8);
  assert.match(calls, /patch-engine .* --replace \/run\/a \/dev\/a 1 --replace \/run\/b \/dev\/b 1 --replace \/run\/c \/dev\/c 1/);
  return calls;
}

function assertRefused(item, result, expected) {
  assertCompleted(result);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, expected);
  assert.equal(fs.existsSync(item.prepared), false);
  assert.equal(fs.existsSync(item.work), false);
}

for (const sourceKind of ["cache", "sideload", "download"]) {
  test(`prepare-engine publishes one exact 13-member tree from ${sourceKind}`, () => {
    const item = fixture({ sourceKind });
    try {
      const sourceFile = sourceKind === "cache"
        ? path.join(item.cacheRoot, tarballName)
        : sourceKind === "sideload"
          ? path.join(item.sideloadRoot, tarballName)
          : path.join(item.stateDir, "download.tgz");
      const before = fileIdentity(sourceFile);
      const calls = assertPrepared(item, sourceKind, run(item));
      assert.deepEqual(fileIdentity(sourceFile), before);
      assert.equal(/^curl /m.test(calls), sourceKind === "download");
    } finally {
      removeFixture(item);
    }
  });
}

test("a present invalid cache refuses without falling through to sideload or curl", () => {
  const item = fixture({ sourceKind: "sideload", curl: true });
  try {
    const cache = path.join(item.cacheRoot, tarballName);
    const sideload = path.join(item.sideloadRoot, tarballName);
    fs.writeFileSync(cache, "wrong archive");
    const beforeCache = fileIdentity(cache);
    const beforeSideload = fileIdentity(sideload);
    const result = run(item);
    assertRefused(item, result, /existing-host engine cache has an unsafe type or wrong identity/);
    assert.deepEqual(fileIdentity(cache), beforeCache);
    assert.deepEqual(fileIdentity(sideload), beforeSideload);
    const calls = fs.readFileSync(item.callsFile, "utf8");
    assert.doesNotMatch(calls, /^curl |^patch-engine /m);
  } finally {
    removeFixture(item);
  }
});

test("absence of archives and a qualified downloader gives the exact sideload instruction", () => {
  const item = fixture({ sourceKind: "none", curl: false });
  try {
    const result = run(item);
    assertRefused(
      item,
      result,
      new RegExp(`no qualified downloader; sideload with: adb push ${tarballName} ${item.sideloadRoot}/${tarballName}`),
    );
  } finally {
    removeFixture(item);
  }
});

for (const [label, mutateMembers] of [
  ["missing member", (members) => members.filter((entry) => entry.name !== "docker/runc")],
  ["extra member", (members) => [...members, { name: "docker/extra", contents: "extra", type: "file" }]],
  ["duplicate member", (members) => [...members, { ...members.find((entry) => entry.name === "docker/runc") }]],
  ["traversal member", (members) => [...members, { name: "docker/../escape", contents: "escape", type: "file" }]],
  ["linked member", (members) => members.map((entry) => entry.name === "docker/runc"
    ? { name: entry.name, type: "symlink", linkname: "docker" }
    : entry)],
]) {
  test(`prepare-engine refuses an archive with a ${label}`, () => {
    const item = fixture({ mutateMembers });
    try {
      const result = run(item);
      assertRefused(item, result, /archive inventory is not the exact pinned shape|archive member has the wrong identity|cannot stream engine archive member/);
      const calls = fs.readFileSync(item.callsFile, "utf8");
      assert.doesNotMatch(calls, /^curl /m);
    } finally {
      removeFixture(item);
    }
  });
}

for (const [label, marker, expected] of [
  ["patcher refusal", "fail-docker-proxy", /engine (patch|copy verification) failed: docker-proxy/],
  ["corrupt patcher output", "corrupt-dockerd", /prepared engine binary has the wrong identity: dockerd/],
]) {
  test(`${label} cleans all unpublished temporary engine state`, () => {
    const item = fixture();
    try {
      fs.writeFileSync(path.join(item.stateDir, marker), "yes\n");
      assertRefused(item, run(item), expected);
    } finally {
      removeFixture(item);
    }
  });
}

test("a malformed release manifest cannot publish an otherwise valid engine tree", () => {
  const item = fixture();
  try {
    const manifest = path.join(item.moduleDir, "release-manifest.tsv");
    fs.writeFileSync(manifest, fs.readFileSync(manifest, "utf8").replace(
      "RELEASE_MANIFEST_VERSION=1",
      "RELEASE_MANIFEST_VERSION=2",
    ));
    assertRefused(item, run(item), /release manifest is malformed/);
  } finally {
    removeFixture(item);
  }
});

test("prepare-engine is a no-argument TMPDIR-only preparation primitive", () => {
  assert.doesNotMatch(source, /release-transaction|stage-activate|hostctl start|swap-boot-kernel/);
  const activeSource = source.split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  assert.match(activeSource, /^CACHE_ROOT=\/data\/docker\/downloads$/m);
  assert.equal((activeSource.match(/\/data\/docker/g) ?? []).length, 1);
  const item = fixture();
  try {
    const result = run(item, "unexpected");
    assertCompleted(result);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /accepts no arguments/);
    assert.equal(fs.existsSync(item.work), false);
    assert.equal(fs.existsSync(item.prepared), false);
  } finally {
    removeFixture(item);
  }
});
