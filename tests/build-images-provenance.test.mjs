import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceBuilder = path.join(projectRoot, "eip", "build-images.sh");
const builderSource = fs.readFileSync(sourceBuilder, "utf8");
const temporaryRoot = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "pixel-build-provenance-test-")),
);
const fakeBin = path.join(temporaryRoot, "fake-bin");
const fakeGitProgram = path.join(temporaryRoot, "fake-git.mjs");
const fakeDockerProgram = path.join(temporaryRoot, "fake-docker.mjs");

const sourceRevision = "1".repeat(40);
const builderRevision = "2".repeat(40);
const imageId = `sha256:${"a".repeat(64)}`;
const configId = `sha256:${"b".repeat(64)}`;
const requiredSourceFiles = [
  ".dockerignore",
  "deploy/container/Dockerfile",
  "package.json",
  "package-lock.json",
];

fs.mkdirSync(fakeBin);
fs.writeFileSync(fakeGitProgram, String.raw`import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GIT_LOG, JSON.stringify(args) + "\n");

if (args[0] !== "-C" || args.length < 3) process.exit(90);
const candidate = path.resolve(args[1]);
const sourceRoot = fs.realpathSync(process.env.FAKE_SOURCE_ROOT);
const builderRoot = fs.realpathSync(process.env.FAKE_BUILDER_ROOT);

let role;
let top;
if (candidate === sourceRoot || candidate.startsWith(sourceRoot + path.sep)) {
  role = "source";
  top = sourceRoot;
} else if (candidate === builderRoot || candidate.startsWith(builderRoot + path.sep)) {
  role = "builder";
  top = builderRoot;
} else {
  process.exit(91);
}

if (process.env.FAKE_NON_REPO_ROLE === role) process.exit(92);
const command = args.slice(2);

if (command[0] === "rev-parse" && command[1] === "--show-toplevel") {
  process.stdout.write(top + "\n");
  process.exit(0);
}

if (command[0] === "rev-parse" && command[1] === "--verify" && command[2] === "HEAD") {
  const sourceAdvanced = role === "source"
    && process.env.FAKE_ARCHIVE_MARKER
    && fs.existsSync(process.env.FAKE_ARCHIVE_MARKER)
    && process.env.FAKE_SOURCE_REVISION_AFTER_ARCHIVE;
  const value = sourceAdvanced
    ? process.env.FAKE_SOURCE_REVISION_AFTER_ARCHIVE
    : role === "source"
      ? process.env.FAKE_SOURCE_REVISION
      : process.env.FAKE_BUILDER_REVISION;
  process.stdout.write(value + "\n");
  process.exit(0);
}

if (command[0] === "status") {
  const value = role === "source"
    ? process.env.FAKE_SOURCE_STATUS
    : process.env.FAKE_BUILDER_STATUS;
  if (value) process.stdout.write(value + "\n");
  process.exit(0);
}

if (command[0] === "ls-files" && command[1] === "--error-unmatch") {
  const relative = command.at(-1);
  const rejectedRole = process.env.FAKE_UNTRACKED_ROLE || "source";
  const shouldReject = role === rejectedRole && process.env.FAKE_UNTRACKED_FILE === relative;
  process.exit(shouldReject ? 1 : 0);
}

if (command[0] === "ls-files" && command.includes("--cached") && command.includes("--others")) {
  const paths = [];
  function visit(directory, relative = "") {
    for (const name of fs.readdirSync(directory).sort()) {
      const child = path.join(relative, name);
      if (child === ".git" || child === ".ignored-secret.env" || child.startsWith("node_modules/")) {
        continue;
      }
      const absolute = path.join(directory, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) visit(absolute, child);
      else paths.push(child);
    }
  }
  visit(sourceRoot);
  process.stdout.write(paths.map((value) => value + "\0").join(""));
  process.exit(0);
}

if (command[0] === "archive" && role === "source") {
  const outputArgument = command.find((value) => value.startsWith("--output="));
  if (!outputArgument) process.exit(95);
  const output = outputArgument.slice("--output=".length);
  const archived = spawnSync("tar", [
    "-C", sourceRoot,
    "--exclude", "./.git",
    "--exclude", "./.ignored-secret.env",
    "--exclude", "./node_modules",
    "-cf", output, ".",
  ]);
  if (archived.status === 0 && process.env.FAKE_ARCHIVE_MARKER) {
    fs.writeFileSync(process.env.FAKE_ARCHIVE_MARKER, "archived\n");
  }
  process.exit(archived.status ?? 96);
}

process.exit(94);
`);

fs.writeFileSync(fakeDockerProgram, String.raw`import fs from "node:fs";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + "\n");

if (args[0] === "build") {
  const labels = {};
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] !== "--label") continue;
    const [key, ...value] = args[index + 1].split("=");
    labels[key] = value.join("=");
  }
  fs.writeFileSync(process.env.FAKE_DOCKER_STATE, JSON.stringify({ labels }));
  const contextRoot = args.at(-1);
  if (fs.existsSync(contextRoot + "/.git")
      || fs.existsSync(contextRoot + "/.ignored-secret.env")
      || fs.existsSync(contextRoot + "/node_modules")) {
    process.exit(45);
  }
  if (process.env.FAKE_RACE_MANIFEST) {
    fs.writeFileSync(process.env.FAKE_RACE_MANIFEST, "external-winner\n");
  }
  if (process.env.FAKE_BUILD_FAIL === "1") process.exit(42);
  process.exit(0);
}

if (args[0] === "image" && args[1] === "inspect") {
  if (process.env.FAKE_INSPECT_FAIL === "1") process.exit(43);
  if (process.env.FAKE_INSPECT_RAW !== undefined) {
    process.stdout.write(process.env.FAKE_INSPECT_RAW + "\n");
    process.exit(0);
  }
  const { labels } = JSON.parse(fs.readFileSync(process.env.FAKE_DOCKER_STATE, "utf8"));
  const fields = [
    process.env.FAKE_INSPECT_ID || process.env.FAKE_IMAGE_ID,
    process.env.FAKE_INSPECT_ARCH || "arm64",
    process.env.FAKE_INSPECT_SOURCE_REVISION || labels["org.opencontainers.image.revision"],
    process.env.FAKE_INSPECT_SOURCE_DIRTY || labels["io.exploitintel.build.source-dirty"],
    process.env.FAKE_INSPECT_BUILDER_REVISION || labels["io.exploitintel.build.builder-revision"],
    process.env.FAKE_INSPECT_BUILDER_DIRTY || labels["io.exploitintel.build.builder-dirty"],
    process.env.FAKE_INSPECT_SOURCE_SNAPSHOT_DIGEST
      || labels["io.exploitintel.build.source-snapshot-sha256"],
  ];
  process.stdout.write(fields.join("|") + "\n");
  process.exit(0);
}

if (args[0] === "image" && args[1] === "save") {
  if (process.env.FAKE_SAVE_FAIL === "1") process.exit(46);
  const config = process.env.FAKE_CONFIG_PATH
    || "blobs/sha256/" + process.env.FAKE_CONFIG_ID.replace(/^sha256:/, "");
  const directory = process.env.FAKE_DOCKER_STATE + ".archive";
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory);
  fs.writeFileSync(directory + "/manifest.json", JSON.stringify([{
    Config: config,
    RepoTags: ["eip-cve-controller:phone"],
    Layers: [],
  }]));
  const archived = spawnSync("tar", ["-C", directory, "-cf", "-", "manifest.json"]);
  fs.rmSync(directory, { recursive: true, force: true });
  if (archived.status !== 0) process.exit(47);
  process.stdout.write(archived.stdout);
  process.exit(0);
}

process.exit(44);
`);

for (const [name, program] of [["git", fakeGitProgram], ["docker", fakeDockerProgram]]) {
  const wrapper = path.join(fakeBin, name);
  fs.writeFileSync(
    wrapper,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(program)} "$@"\n`,
  );
  fs.chmodSync(wrapper, 0o755);
}
const fakeLink = path.join(fakeBin, "link");
fs.writeFileSync(fakeLink, [
  "#!/bin/sh",
  "[ \"${FAKE_LINK_FAIL:-0}\" = 0 ] || exit 41",
  "exec /bin/link \"$@\"",
  "",
].join("\n"));
fs.chmodSync(fakeLink, 0o755);

function buildProfile(overrides = {}, extra = "") {
  const values = {
    uid: "2000",
    gid: "2000",
    arch: "arm64",
    tag: "phone",
    ...overrides,
  };
  return [
    "# Parsed as data, never executed.",
    `EIP_CVE_UID=${values.uid}`,
    `EIP_CVE_GID=${values.gid}`,
    `EIP_CVE_PLATFORM_ARCH=${values.arch}`,
    `EIP_CVE_IMAGE_TAG=${values.tag}`,
    extra,
    "",
  ].join("\n");
}

function makeHarness(options = {}) {
  const root = fs.mkdtempSync(path.join(temporaryRoot, "case-"));
  const builderRoot = path.join(root, "Pixel companion with spaces");
  const sourceRoot = path.join(root, "Forge source with spaces");
  const outputRoot = path.join(root, "output with spaces");
  const scriptDirectory = path.join(builderRoot, "eip");
  const script = path.join(scriptDirectory, "build-images.sh");
  const profile = path.join(scriptDirectory, "container.build.env");
  const gitLog = path.join(root, "git-calls.jsonl");
  const dockerLog = path.join(root, "docker-calls.jsonl");
  const dockerState = path.join(root, "docker-state.json");
  const archiveMarker = path.join(root, "archive-complete");
  const tempRoot = path.join(root, "temporary files");
  const manifest = path.join(outputRoot, "controller build.json");

  fs.mkdirSync(scriptDirectory, { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, "deploy", "container"), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, "nested"));
  fs.mkdirSync(outputRoot);
  fs.mkdirSync(tempRoot);
  fs.writeFileSync(script, builderSource, { mode: 0o755 });
  fs.writeFileSync(profile, options.profile ?? buildProfile());
  for (const relative of requiredSourceFiles) {
    const target = path.join(sourceRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${relative}\n`);
  }
  fs.writeFileSync(path.join(sourceRoot, ".git"), "gitdir: ignored-by-snapshot\n");
  fs.writeFileSync(path.join(sourceRoot, ".ignored-secret.env"), "SECRET=must-not-be-snapshotted\n");
  fs.mkdirSync(path.join(sourceRoot, "node_modules"));
  fs.writeFileSync(path.join(sourceRoot, "node_modules", "ignored-bulk.bin"), Buffer.alloc(128 * 1024, 7));

  return {
    root,
    builderRoot,
    sourceRoot,
    outputRoot,
    script,
    profile,
    gitLog,
    dockerLog,
    dockerState,
    archiveMarker,
    tempRoot,
    manifest,
  };
}

function readCalls(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

function run(harness, args = [
  "--source", harness.sourceRoot,
  "--manifest", harness.manifest,
], overrides = {}) {
  fs.writeFileSync(harness.gitLog, "");
  fs.writeFileSync(harness.dockerLog, "");
  fs.rmSync(harness.dockerState, { force: true });
  fs.rmSync(harness.archiveMarker, { force: true });
  const result = spawnSync("bash", [harness.script, ...args], {
    cwd: harness.root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      TMPDIR: harness.tempRoot,
      FAKE_GIT_LOG: harness.gitLog,
      FAKE_DOCKER_LOG: harness.dockerLog,
      FAKE_DOCKER_STATE: harness.dockerState,
      FAKE_ARCHIVE_MARKER: harness.archiveMarker,
      FAKE_SOURCE_ROOT: harness.sourceRoot,
      FAKE_BUILDER_ROOT: harness.builderRoot,
      FAKE_SOURCE_REVISION: sourceRevision,
      FAKE_BUILDER_REVISION: builderRevision,
      FAKE_SOURCE_STATUS: "",
      FAKE_BUILDER_STATUS: "",
      FAKE_IMAGE_ID: imageId,
      FAKE_CONFIG_ID: configId,
      ...overrides,
    },
  });
  return {
    ...result,
    gitCalls: readCalls(harness.gitLog),
    dockerCalls: readCalls(harness.dockerLog),
  };
}

function assertFailedBeforeDocker(result) {
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(result.dockerCalls, []);
}

function assertNoManifestTemporaryFiles(harness) {
  const leftovers = fs.readdirSync(harness.outputRoot)
    .filter((name) => name.includes(".tmp."));
  assert.deepEqual(leftovers, []);
  assert.deepEqual(fs.readdirSync(harness.tempRoot), []);
}

// CLI ambiguity is rejected without invoking Git or Docker.
{
  const harness = makeHarness();
  const cases = [
    [],
    ["--source", harness.sourceRoot],
    ["--manifest", harness.manifest],
    ["--wat"],
    ["positional"],
    ["--source", harness.sourceRoot, "--source", harness.sourceRoot, "--manifest", harness.manifest],
    ["--source", harness.sourceRoot, "--manifest", harness.manifest, "--manifest", harness.manifest],
    ["--source", harness.sourceRoot, "--manifest", harness.manifest, "--allow-dirty", "--allow-dirty"],
  ];
  for (const args of cases) {
    const result = run(harness, args);
    assertFailedBeforeDocker(result);
  }
  const help = run(harness, ["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--source/);
  assert.deepEqual(help.dockerCalls, []);
}

// Existing files and even dangling symlinks are never replaced.
{
  const existing = makeHarness();
  fs.writeFileSync(existing.manifest, "preserve\n");
  assertFailedBeforeDocker(run(existing));
  assert.equal(fs.readFileSync(existing.manifest, "utf8"), "preserve\n");

  const linked = makeHarness();
  fs.symlinkSync("missing-target.json", linked.manifest);
  assertFailedBeforeDocker(run(linked));
  assert.equal(fs.lstatSync(linked.manifest).isSymbolicLink(), true);
}

// The source must be the repository root with every required tracked contract file.
{
  const nonRepository = makeHarness();
  const unrelated = path.join(nonRepository.root, "not a repository");
  fs.mkdirSync(unrelated);
  assertFailedBeforeDocker(run(nonRepository, [
    "--source", unrelated,
    "--manifest", nonRepository.manifest,
  ]));

  const nested = makeHarness();
  assertFailedBeforeDocker(run(nested, [
    "--source", path.join(nested.sourceRoot, "nested"),
    "--manifest", nested.manifest,
  ]));

  const missing = makeHarness();
  fs.rmSync(path.join(missing.sourceRoot, "package-lock.json"));
  assertFailedBeforeDocker(run(missing));

  const untracked = makeHarness();
  assertFailedBeforeDocker(run(untracked, undefined, {
    FAKE_UNTRACKED_FILE: "deploy/container/Dockerfile",
  }));

  const invalidRevision = makeHarness();
  assertFailedBeforeDocker(run(invalidRevision, undefined, {
    FAKE_SOURCE_REVISION: "short",
  }));

  const untrackedBuilder = makeHarness();
  assertFailedBeforeDocker(run(untrackedBuilder, undefined, {
    FAKE_UNTRACKED_FILE: "eip/build-images.sh",
    FAKE_UNTRACKED_ROLE: "builder",
  }));
}

// A checkout change during context preparation is caught before Docker.
{
  const harness = makeHarness();
  const result = run(harness, undefined, {
    FAKE_SOURCE_REVISION_AFTER_ARCHIVE: "9".repeat(40),
  });
  assertFailedBeforeDocker(result);
  assertNoManifestTemporaryFiles(harness);
}

// The four profile values are parsed exactly once and validated as inert data.
{
  const invalidProfiles = [
    buildProfile({}, "EIP_CVE_UID=2001"),
    buildProfile({ uid: "0" }),
    buildProfile({ gid: "group" }),
    buildProfile({ arch: "amd64" }),
    buildProfile({ tag: "latest" }),
    [
      "EIP_CVE_GID=2000",
      "EIP_CVE_PLATFORM_ARCH=arm64",
      "EIP_CVE_IMAGE_TAG=phone",
      "",
    ].join("\n"),
  ];
  for (const profile of invalidProfiles) {
    const harness = makeHarness({ profile });
    assertFailedBeforeDocker(run(harness));
  }
}

// Safe no-replace publication support is proved before Docker mutates a tag.
{
  const harness = makeHarness();
  const result = run(harness, undefined, { FAKE_LINK_FAIL: "1" });
  assertFailedBeforeDocker(result);
  assertNoManifestTemporaryFiles(harness);
}

// Dirty status is a hard default failure and its file names never leak.
for (const [role, overrides] of [
  ["source", { FAKE_SOURCE_STATUS: "?? private-source-token-name" }],
  ["builder", { FAKE_BUILDER_STATUS: " M private-builder-token-name" }],
]) {
  const harness = makeHarness();
  const result = run(harness, undefined, overrides);
  assertFailedBeforeDocker(result);
  assert.equal(`${result.stdout}${result.stderr}`.includes("private-"), false, role);
}

// --allow-dirty records Forge and companion state independently.
for (const [sourceDirty, builderDirty] of [[true, false], [false, true], [true, true]]) {
  const harness = makeHarness();
  const result = run(harness, [
    "--source", harness.sourceRoot,
    "--manifest", harness.manifest,
    "--allow-dirty",
  ], {
    FAKE_SOURCE_STATUS: sourceDirty ? "?? private-source-token-name" : "",
    FAKE_BUILDER_STATUS: builderDirty ? " M private-builder-token-name" : "",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const manifest = JSON.parse(fs.readFileSync(harness.manifest, "utf8"));
  assert.equal(manifest.controller.sourceDirty, sourceDirty);
  assert.equal(manifest.builder.dirty, builderDirty);
  const build = result.dockerCalls[0];
  assert.equal(build.includes(`io.exploitintel.build.source-dirty=${sourceDirty}`), true);
  assert.equal(build.includes(`io.exploitintel.build.builder-dirty=${builderDirty}`), true);
  assert.equal(`${result.stdout}${result.stderr}`.includes("private-"), false);
}

// A clean source path with spaces produces one exact controller-only build.
{
  const harness = makeHarness();
  const inertMarker = path.join(harness.root, "profile-was-executed");
  fs.writeFileSync(
    harness.profile,
    buildProfile({}, `UNUSED_VALUE=$(touch ${inertMarker})`),
  );
  const result = run(harness);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.existsSync(inertMarker), false, "profile content was executed");
  assert.equal(result.dockerCalls.length, 3);

  const actualBuild = result.dockerCalls[0];
  const contextRoot = actualBuild.at(-1);
  const snapshotLabel = actualBuild.find((value) =>
    value.startsWith("io.exploitintel.build.source-snapshot-sha256="));
  assert.match(contextRoot, /\/eip-controller-context\.[^/]+\/context$/);
  assert.notEqual(contextRoot, harness.sourceRoot);
  assert.match(snapshotLabel, /^io\.exploitintel\.build\.source-snapshot-sha256=sha256:[0-9a-f]{64}$/);
  const sourceSnapshotDigest = snapshotLabel.slice(
    "io.exploitintel.build.source-snapshot-sha256=".length,
  );

  const expectedBuild = [
    "build",
    "--platform", "linux/arm64",
    "--build-arg", "EIP_CVE_UID=2000",
    "--build-arg", "EIP_CVE_GID=2000",
    "--label", "org.opencontainers.image.source=https://github.com/exploitintel/eip-pixel11xl-forge",
    "--label", `org.opencontainers.image.revision=${sourceRevision}`,
    "--label", "io.exploitintel.build.source-dirty=false",
    "--label", `io.exploitintel.build.builder-revision=${builderRevision}`,
    "--label", "io.exploitintel.build.builder-dirty=false",
    "--label", `io.exploitintel.build.source-snapshot-sha256=${sourceSnapshotDigest}`,
    "--file", path.join(contextRoot, "deploy", "container", "Dockerfile"),
    "--target", "controller",
    "--tag", "eip-cve-controller:phone",
    contextRoot,
  ];
  assert.deepEqual(actualBuild, expectedBuild);
  assert.deepEqual(result.dockerCalls[1].slice(0, 3), ["image", "inspect", "--format"]);
  assert.equal(result.dockerCalls[1].at(-1), "eip-cve-controller:phone");
  assert.deepEqual(result.dockerCalls[2], ["image", "save", "eip-cve-controller:phone"]);
  assert.equal(JSON.stringify(result.dockerCalls).includes("operator"), false);
  assert.equal(JSON.stringify(result.dockerCalls).toLowerCase().includes("ollama"), false);

  const text = fs.readFileSync(harness.manifest, "utf8");
  const manifest = JSON.parse(text);
  assert.deepEqual(Object.keys(manifest), [
    "schemaVersion", "kind", "createdAt", "provenanceLevel", "scope",
    "platform", "builder", "controller",
  ]);
  assert.deepEqual(Object.keys(manifest.builder), ["revision", "dirty"]);
  assert.deepEqual(Object.keys(manifest.controller), [
    "tag", "imageId", "sourceRevision", "sourceDirty", "sourceSnapshotDigest",
    "dockerfile", "target", "uid", "gid",
  ]);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.kind, "eip-controller-build-manifest");
  assert.match(manifest.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(manifest.provenanceLevel, "source-attributed");
  assert.equal(manifest.scope, "controller-only");
  assert.equal(manifest.platform, "linux/arm64");
  assert.deepEqual(manifest.builder, { revision: builderRevision, dirty: false });
  assert.deepEqual(manifest.controller, {
    tag: "eip-cve-controller:phone",
    imageId: configId,
    sourceRevision,
    sourceDirty: false,
    sourceSnapshotDigest,
    dockerfile: "deploy/container/Dockerfile",
    target: "controller",
    uid: 2000,
    gid: 2000,
  });
  assert.equal(text.includes(harness.sourceRoot), false);
  assert.equal(text.includes(harness.builderRoot), false);
  assert.equal(fs.statSync(harness.manifest).mode & 0o777, 0o600);
  assertNoManifestTemporaryFiles(harness);
}

// Build or inspection failures never publish a manifest.
for (const overrides of [
  { FAKE_BUILD_FAIL: "1" },
  { FAKE_INSPECT_FAIL: "1" },
  { FAKE_INSPECT_ID: "sha256:short" },
  { FAKE_INSPECT_ARCH: "amd64" },
  { FAKE_INSPECT_SOURCE_REVISION: "3".repeat(40) },
  { FAKE_INSPECT_SOURCE_DIRTY: "true" },
  { FAKE_INSPECT_BUILDER_REVISION: "4".repeat(40) },
  { FAKE_INSPECT_BUILDER_DIRTY: "true" },
  { FAKE_INSPECT_SOURCE_SNAPSHOT_DIGEST: `sha256:${"b".repeat(64)}` },
  { FAKE_INSPECT_RAW: `${imageId}|arm64|too|many|fields|for|this|manifest` },
  { FAKE_SAVE_FAIL: "1" },
  { FAKE_CONFIG_PATH: "blobs/sha256/short" },
]) {
  const harness = makeHarness();
  const result = run(harness, undefined, overrides);
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.existsSync(harness.manifest), false);
  assertNoManifestTemporaryFiles(harness);
}

// A target that appears during the build wins; the builder never overwrites it.
{
  const harness = makeHarness();
  const result = run(harness, undefined, { FAKE_RACE_MANIFEST: harness.manifest });
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.readFileSync(harness.manifest, "utf8"), "external-winner\n");
  assertNoManifestTemporaryFiles(harness);
}

// Output allocation problems are detected before Docker can replace the tag.
{
  const harness = makeHarness();
  const overlongManifest = path.join(harness.outputRoot, `${"x".repeat(300)}.json`);
  const result = run(harness, [
    "--source", harness.sourceRoot,
    "--manifest", overlongManifest,
  ]);
  assertFailedBeforeDocker(result);
  assertNoManifestTemporaryFiles(harness);
}

// The builder parses as Bash and contains no live-device, provider, image
// transfer, container execution, or stable-tag promotion operation.
{
  const syntax = spawnSync("bash", ["-n", sourceBuilder], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.doesNotMatch(builderSource, /\badb\b/);
  assert.doesNotMatch(builderSource, /\b(?:curl|wget)\b/);
  assert.doesNotMatch(builderSource, /\bdocker\s+(?:run|push|pull|save|load|tag)\b/);
  assert.doesNotMatch(builderSource, /EIP_(?:FIREWALL|BUILD)_TEST/);
  assert.equal((builderSource.match(/\bdocker build\b/g) ?? []).length, 1);
  assert.equal((builderSource.match(/\bdocker image inspect\b/g) ?? []).length, 1);
}
