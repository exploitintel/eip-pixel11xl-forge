import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const redeploy = path.join(root, "eip", "redeploy.sh");
const candidateId = `sha256:${"1".repeat(64)}`;
const previousId = `sha256:${"2".repeat(64)}`;
const differentId = `sha256:${"3".repeat(64)}`;
const remoteEscapedQuote = "'\\''";
const testSerial = "pixel-test-01";

const forbiddenDockerFake = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(path.join(process.env.FAKE_STATE_ROOT, "docker.calls"), JSON.stringify(args) + "\n");
process.stderr.write("host docker must not be invoked: " + JSON.stringify(args) + "\n");
process.exitCode = 91;
`;

const adbFake = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const stateRoot = process.env.FAKE_STATE_ROOT;
const statePath = path.join(stateRoot, "phone-state.json");
const remote = args[4] || "";
const wrapper = remote.match(/^su -c '(.*)'$/s);
const escapedQuote = "'\\''";
const command = wrapper ? wrapper[1].split(escapedQuote).join("'") : "";
fs.appendFileSync(
  path.join(stateRoot, "adb.calls"),
  JSON.stringify({ args, remote, command, quotingValid: Boolean(wrapper) }) + "\n",
);
if (
  args.length !== 5 || args[0] !== "-s" || args[1] !== process.env.FAKE_EXPECTED_SERIAL ||
  args[2] !== "shell" || args[3] !== "-T" || !wrapper
) {
  process.stderr.write("adb command lacked the exact device or one safely quoted remote command\n");
  process.exit(90);
}

let state;
try {
  state = JSON.parse(fs.readFileSync(statePath, "utf8"));
} catch {
  state = {
    activeId: process.env.FAKE_PREVIOUS_IMAGE_ID,
    rollbackId: null,
    promoted: false,
    rollbackRestored: false,
    sourceRestored: false,
    sourceFinalized: false,
    managedPrepared: false,
    managedRestored: false,
    started: false,
    upCalls: 0,
  };
}
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));

if (/^\/data\/eip-cve-backups\/deploy-[0-9a-f]{40}-[0-9a-f]{40}\/restore-source-ops\.sh check-pending [0-9a-f]{40} [0-9a-f]{40} sha256:[0-9a-f]{64}$/.test(command)) {
  if (process.env.FAKE_SOURCE_PENDING_FAILURE === "true" || state.sourceFinalized) process.exit(96);
  process.exit();
}
if (/^\/data\/eip-cve-backups\/deploy-[0-9a-f]{40}-[0-9a-f]{40}\/restore-source-ops\.sh finalize [0-9a-f]{40} [0-9a-f]{40} sha256:[0-9a-f]{64} sha256:[0-9a-f]{64}$/.test(command)) {
  if (process.env.FAKE_SOURCE_FINALIZE_FAILURE === "true") process.exit(95);
  const wasFinalized = state.sourceFinalized;
  state.sourceFinalized = true;
  save();
  if (!wasFinalized && process.env.FAKE_SOURCE_FINALIZE_AMBIGUOUS === "true") process.exit(49);
  process.exit();
}
if (/^\/data\/eip-cve-backups\/deploy-[0-9a-f]{40}-[0-9a-f]{40}\/restore-source-ops\.sh restore [0-9a-f]{40} [0-9a-f]{40} sha256:[0-9a-f]{64}$/.test(command)) {
  state.sourceRestored = true;
  save();
  if (process.env.FAKE_SOURCE_RESTORE_AMBIGUOUS === "true") process.exit(44);
  process.exit();
}
if (/^\/data\/eip-cve-backups\/deploy-[0-9a-f]{40}-[0-9a-f]{40}\/restore-source-ops\.sh check-restored [0-9a-f]{40} [0-9a-f]{40} sha256:[0-9a-f]{64}$/.test(command)) {
  process.exit(state.sourceRestored ? 0 : 97);
}
const managedState = command.match(/^\/data\/eip-cve-ops\/eip\.sh managed-state (prepare|check-candidate|restore|check-restored) ([0-9a-f]{64})$/);
if (managedState) {
  if (managedState[1] === "prepare") state.managedPrepared = true;
  if (managedState[1] === "restore") state.managedRestored = true;
  save();
  if (managedState[1] === "prepare" && process.env.FAKE_MANAGED_PREPARE_FAILURE === "true") process.exit(40);
  if (managedState[1] === "prepare" && process.env.FAKE_MANAGED_PREPARE_AMBIGUOUS === "true") process.exit(48);
  if (managedState[1] === "restore" && process.env.FAKE_MANAGED_RESTORE_AMBIGUOUS === "true") process.exit(45);
  if (managedState[1] === "check-candidate" && !state.managedPrepared) process.exit(98);
  if (managedState[1] === "check-restored" && !state.managedRestored) process.exit(99);
  process.exit();
}
if (command === "/data/eip-cve-ops/eip.sh skills-release") {
  if (process.env.FAKE_SKILLS_RELEASE_FAILURE === "true") process.exit(41);
  process.stdout.write("managed-skills rebase completed at revision bbbbbbbbbbbbbbbb\n");
  process.exit();
}
if (command === "/data/eip-cve-ops/eip.sh down") {
  state.started = false;
  save();
  process.exit();
}

const imageInspect = command.match(/ image inspect --format='\{\{\.Id\}\}' (\S+)$/);
if (imageInspect) {
  const reference = imageInspect[1];
  if (reference === "eip-cve-controller:phone") {
    process.stdout.write(process.env.FAKE_PHONE_LOADED_IMAGE_ID + "\n");
  } else if (reference === "eip-cve-controller:local") {
    process.stdout.write(state.activeId + "\n");
  } else if (reference === "eip-cve-controller:rollback" && state.rollbackId) {
    process.stdout.write(state.rollbackId + "\n");
  } else {
    process.stderr.write("unknown image reference: " + reference + "\n");
    process.exitCode = 92;
  }
  process.exit();
}

const tag = command.match(/ tag (sha256:[0-9a-f]{64}) (eip-cve-controller:\S+)$/);
if (tag) {
  let injectedExit = null;
  if (tag[2] === "eip-cve-controller:rollback") {
    state.rollbackId = process.env.FAKE_ROLLBACK_TAG_MISMATCH === "true"
      ? process.env.FAKE_DIFFERENT_IMAGE_ID
      : tag[1];
    if (process.env.FAKE_ROLLBACK_TAG_AMBIGUOUS === "true") injectedExit = 44;
  } else if (tag[2] === "eip-cve-controller:local") {
    if (tag[1] === process.env.FAKE_PREVIOUS_IMAGE_ID && process.env.FAKE_ROLLBACK_TAG_FAILURE === "true") {
      process.stderr.write("injected rollback tag failure\n");
      process.exit(96);
    }
    state.activeId = tag[1];
    if (tag[1] === process.env.FAKE_CANDIDATE_IMAGE_ID) state.promoted = true;
    if (tag[1] === process.env.FAKE_PREVIOUS_IMAGE_ID) state.rollbackRestored = true;
    if (tag[1] === process.env.FAKE_CANDIDATE_IMAGE_ID && process.env.FAKE_PROMOTION_AMBIGUOUS === "true") {
      injectedExit = 45;
    }
  } else {
    process.stderr.write("unexpected phone tag: " + tag[2] + "\n");
    process.exit(93);
  }
  save();
  if (injectedExit !== null) {
    process.stderr.write("injected ambiguous tag result\n");
    process.exit(injectedExit);
  }
  process.exit();
}

if (command === "/data/eip-cve-ops/eip.sh up --force-recreate") {
  state.upCalls += 1;
  state.started = true;
  save();
  if (state.activeId === process.env.FAKE_CANDIDATE_IMAGE_ID && process.env.FAKE_CANDIDATE_UP_FAILURE === "true") {
    process.stderr.write("injected candidate up failure\n");
    process.exit(42);
  }
  if (state.activeId === process.env.FAKE_PREVIOUS_IMAGE_ID && process.env.FAKE_ROLLBACK_UP_FAILURE === "true") {
    process.stderr.write("injected rollback up failure\n");
    process.exit(43);
  }
  if (state.activeId === process.env.FAKE_PREVIOUS_IMAGE_ID && state.rollbackRestored && !state.sourceRestored) {
    process.stderr.write("old image cannot start through candidate source and ops\n");
    process.exit(47);
  }
  process.exit();
}
if (command === "/data/eip-cve-ops/eip.sh up --force-recreate --no-deps ui") {
  state.upCalls += 1;
  state.started = true;
  save();
  if (process.env.FAKE_CANDIDATE_UP_FAILURE === "true") process.exit(42);
  process.exit();
}
if (command === "/data/eip-cve-ops/eip.sh up --force-recreate --no-deps chat") {
  state.upCalls += 1;
  state.started = true;
  save();
  if (process.env.FAKE_CANDIDATE_CHAT_UP_FAILURE === "true") process.exit(46);
  process.exit();
}
if (command === "/data/eip-cve-ops/eip.sh ps -q ui") {
  process.stdout.write("a".repeat(64) + "\n");
  process.exit();
}
if (command === "/data/eip-cve-ops/eip.sh ps -q chat") {
  process.stdout.write("b".repeat(64) + "\n");
  process.exit();
}
if (command.includes(" /data/docker/bin/docker inspect --format='{{.Image}}|")) {
  let health = "healthy";
  if (state.activeId === process.env.FAKE_CANDIDATE_IMAGE_ID && process.env.FAKE_HEALTH_MODE === "timeout") {
    health = "starting";
  }
  if (
    state.activeId === process.env.FAKE_PREVIOUS_IMAGE_ID && state.rollbackRestored &&
    process.env.FAKE_ROLLBACK_HEALTH_FAILURE === "true"
  ) {
    health = "starting";
  }
  if (
    state.activeId === process.env.FAKE_PREVIOUS_IMAGE_ID && !state.promoted &&
    process.env.FAKE_PREVIOUS_HEALTH_FAILURE === "true"
  ) {
    health = "starting";
  }
  process.stdout.write(state.activeId + "|" + health + "\n");
  process.exit();
}
if (command === "/data/eip-cve-ops/eip.sh ps") {
  process.stdout.write("NAME STATUS\nui unhealthy\nchat unhealthy\n");
  process.exit();
}
if (command === "/data/eip-cve-ops/eip.sh logs --no-color --tail 40 ui chat") {
  process.stdout.write("ui | bounded diagnostic\nchat | bounded diagnostic\n");
  process.exit();
}

process.stderr.write("unexpected fake adb command: " + command + "\n");
process.exitCode = 95;
`;

function writeExecutable(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o755 });
}

function manifest(overrides = {}) {
  const value = {
    schemaVersion: 1,
    kind: "eip-controller-build-manifest",
    createdAt: "2026-09-05T20:00:00Z",
    provenanceLevel: "source-attributed",
    scope: "controller-only",
    platform: "linux/arm64",
    builder: {
      revision: "4".repeat(40),
      dirty: false,
    },
    controller: {
      tag: "eip-cve-controller:phone",
      imageId: candidateId,
      sourceRevision: "5".repeat(40),
      sourceDirty: false,
      sourceSnapshotDigest: `sha256:${"6".repeat(64)}`,
      dockerfile: "deploy/container/Dockerfile",
      target: "controller",
      uid: 2000,
      gid: 2000,
    },
  };
  return {
    ...value,
    ...overrides,
    builder: { ...value.builder, ...(overrides.builder ?? {}) },
    controller: { ...value.controller, ...(overrides.controller ?? {}) },
  };
}

function harness({ manifestOverrides, environment = {}, serialArgs = ["--serial", testSerial] } = {}) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pixel-redeploy-test-"));
  const fakeBin = path.join(temporaryRoot, "bin");
  const fakeHome = path.join(temporaryRoot, "home");
  const adb = path.join(fakeHome, "Library", "Android", "sdk", "platform-tools", "adb");
  fs.mkdirSync(fakeBin, { recursive: true });
  writeExecutable(path.join(fakeBin, "docker"), forbiddenDockerFake);
  writeExecutable(adb, adbFake);
  writeExecutable(path.join(fakeBin, "sleep"), "#!/bin/sh\nexit 0\n");
  const manifestPath = path.join(temporaryRoot, "controller-build.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest(manifestOverrides), null, 2)}\n`);

  const env = {
    ...process.env,
    HOME: fakeHome,
    PATH: `${fakeBin}:${process.env.PATH}`,
    FAKE_STATE_ROOT: temporaryRoot,
    FAKE_EXPECTED_SERIAL: testSerial,
    FAKE_CANDIDATE_IMAGE_ID: candidateId,
    FAKE_DIFFERENT_IMAGE_ID: differentId,
    FAKE_PHONE_LOADED_IMAGE_ID: candidateId,
    FAKE_PREVIOUS_IMAGE_ID: previousId,
    FAKE_HEALTH_MODE: "healthy",
    ...environment,
  };
  if (!("DOCKER_HOST" in environment)) delete env.DOCKER_HOST;

  const result = spawnSync("/bin/bash", [redeploy, ...serialArgs, "--manifest", manifestPath], {
    cwd: root,
    encoding: "utf8",
    env,
    timeout: 30_000,
  });
  const readCalls = (name) => {
    const file = path.join(temporaryRoot, name);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  };
  return {
    ...result,
    temporaryRoot,
    dockerCalls: readCalls("docker.calls"),
    adbCalls: readCalls("adb.calls"),
    phoneState: fs.existsSync(path.join(temporaryRoot, "phone-state.json"))
      ? JSON.parse(fs.readFileSync(path.join(temporaryRoot, "phone-state.json"), "utf8"))
      : null,
  };
}

test("a successful redeploy retains rollback before promoting and proves both services", () => {
  const result = harness();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /healthy: ui and chat use sha256:/);
  assert.deepEqual(result.dockerCalls, []);
  assert.equal(result.phoneState.rollbackId, previousId);
  assert.equal(result.phoneState.activeId, candidateId);
  assert.equal(result.phoneState.promoted, true);
  assert.equal(result.phoneState.started, true);

  for (const call of result.adbCalls) {
    assert.deepEqual(call.args.slice(0, 4), ["-s", testSerial, "shell", "-T"]);
    assert.equal(call.args.length, 5, "adb receives an exact serial and one remote COMMAND");
    assert.equal(call.quotingValid, true);
    assert.match(call.remote, /^su -c '.*'$/s);
  }
  const commands = result.adbCalls.map(({ command }) => command);
  const retain = commands.indexOf(`${phoneDocker()} tag ${previousId} eip-cve-controller:rollback`);
  const stop = commands.indexOf("/data/eip-cve-ops/eip.sh down");
  const prepare = commands.indexOf(`/data/eip-cve-ops/eip.sh managed-state prepare ${"1".repeat(64)}`);
  const promote = commands.indexOf(`${phoneDocker()} tag ${candidateId} eip-cve-controller:local`);
  const uiStart = commands.indexOf("/data/eip-cve-ops/eip.sh up --force-recreate --no-deps ui");
  const release = commands.indexOf("/data/eip-cve-ops/eip.sh skills-release");
  const chatStart = commands.indexOf("/data/eip-cve-ops/eip.sh up --force-recreate --no-deps chat");
  const finalize = commands.findIndex((command) => command.includes("/restore-source-ops.sh finalize "));
  const candidateChecks = commands.filter((command) => command.includes(" managed-state check-candidate "));
  assert.ok(retain >= 0 && retain < stop && stop < prepare && prepare < promote);
  assert.ok(promote < uiStart && uiStart < release && release < chatStart);
  assert.ok(chatStart < finalize);
  assert.equal(candidateChecks.length, 1, "a successful prepare already proves its own postcondition");
  assert.ok(commands.includes("/data/eip-cve-ops/eip.sh ps -q ui"));
  assert.ok(commands.includes("/data/eip-cve-ops/eip.sh ps -q chat"));
  assert.doesNotMatch(commands.join("\n"), /\b(?:prune|rmi|rm|delete)\b/);
  const templateCalls = result.adbCalls.filter(({ command }) => command.includes("--format='{{"));
  assert.ok(templateCalls.length >= 4);
  for (const call of templateCalls) {
    assert.ok(call.remote.includes(remoteEscapedQuote), "embedded quotes are escaped inside su -c");
  }
});

test("an already-active candidate is rejected before replaying its deployment transaction", () => {
  const result = harness({ environment: { FAKE_PREVIOUS_IMAGE_ID: candidateId } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /candidate image is already active; refusing to replay/);
  const commands = result.adbCalls.map(({ command }) => command);
  assert.equal(commands.some((command) => command.includes(" tag ")), false);
  assert.equal(commands.includes("/data/eip-cve-ops/eip.sh down"), false);
});

test("an ambiguous source transaction finalization is resolved idempotently", () => {
  const result = harness({ environment: { FAKE_SOURCE_FINALIZE_AMBIGUOUS: "true" } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /finalization returned nonzero, but its exact postcondition is present/);
  assert.equal(result.phoneState.sourceFinalized, true);
  const commands = result.adbCalls.map(({ command }) => command);
  assert.equal(commands.filter((command) => command.includes("/restore-source-ops.sh finalize ")).length, 2);
});

test("a source transaction finalization failure rolls back the candidate", () => {
  const result = harness({ environment: { FAKE_SOURCE_FINALIZE_FAILURE: "true" } });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /transaction could not be finalized/);
  assert.match(result.stderr, /rollback succeeded/);
  assert.equal(result.phoneState.sourceRestored, true);
  assert.equal(result.phoneState.activeId, previousId);
});

test("ADB receives quoted Go templates inside one remote su command", () => {
  const result = harness();
  assert.equal(result.status, 0, result.stderr);
  const templateCalls = result.adbCalls.filter(({ command }) => command.includes("--format='{{"));
  assert.ok(templateCalls.some(({ command }) => command.includes("{{.Id}}")));
  assert.ok(templateCalls.some(({ command }) => command.includes("{{.Image}}|")));
  for (const { args, command, remote } of templateCalls) {
    assert.deepEqual(args, ["-s", testSerial, "shell", "-T", quotedRemote(command)]);
    assert.equal(remote, quotedRemote(command));
    assert.ok(remote.includes(remoteEscapedQuote));
  }
});

test("a phone candidate mismatch stops before rollback or promotion", () => {
  const result = harness({ environment: { FAKE_PHONE_LOADED_IMAGE_ID: differentId } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /phone candidate controller image does not match/);
  const commands = result.adbCalls.map(({ command }) => command);
  assert.equal(commands.some((command) => command.includes(" tag ")), false);
  assert.equal(commands.includes("/data/eip-cve-ops/eip.sh up --force-recreate"), false);
  assert.deepEqual(result.dockerCalls, []);
});

test("an unhealthy current stack blocks every tag mutation", () => {
  const result = harness({ environment: { FAKE_PREVIOUS_HEALTH_FAILURE: "true" } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /current ui and chat must both be healthy/);
  const commands = result.adbCalls.map(({ command }) => command);
  assert.equal(commands.some((command) => command.includes(" tag ")), false);
  assert.equal(commands.includes("/data/eip-cve-ops/eip.sh up --force-recreate"), false);
});

test("an ambiguous rollback-tag result proceeds only after its exact postcondition", () => {
  const result = harness({ environment: { FAKE_ROLLBACK_TAG_AMBIGUOUS: "true" } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /rollback-tag command returned nonzero, but its exact postcondition is present/);
  assert.equal(result.phoneState.rollbackId, previousId);
  assert.equal(result.phoneState.activeId, candidateId);
  const commands = result.adbCalls.map(({ command }) => command);
  const retain = commands.indexOf(`${phoneDocker()} tag ${previousId} eip-cve-controller:rollback`);
  const verify = commands.indexOf(`${phoneDocker()} image inspect --format='{{.Id}}' eip-cve-controller:rollback`);
  const promote = commands.indexOf(`${phoneDocker()} tag ${candidateId} eip-cve-controller:local`);
  assert.ok(retain >= 0 && retain < verify && verify < promote);
});

test("a wrong rollback-tag postcondition stops while the active image is untouched", () => {
  const result = harness({ environment: { FAKE_ROLLBACK_TAG_MISMATCH: "true" } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /rollback tag does not retain the previous controller image/);
  assert.equal(result.phoneState.activeId, previousId);
  assert.equal(result.phoneState.promoted, false);
  const commands = result.adbCalls.map(({ command }) => command);
  assert.equal(commands.includes(`${phoneDocker()} tag ${candidateId} eip-cve-controller:local`), false);
  assert.equal(commands.includes("/data/eip-cve-ops/eip.sh up --force-recreate"), false);
});

test("a promotion that mutates then reports failure is rolled back and recovered", () => {
  const result = harness({ environment: { FAKE_PROMOTION_AMBIGUOUS: "true" } });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /candidate promotion command returned nonzero/);
  assert.match(result.stderr, /rollback succeeded/);
  assert.equal(result.phoneState.promoted, true, "the injected promotion mutation occurred");
  assert.equal(result.phoneState.rollbackRestored, true);
  assert.equal(result.phoneState.activeId, previousId);
  assert.equal(result.phoneState.upCalls, 1, "only the recovered previous stack is recreated");
});

test("an unhealthy candidate times out, captures evidence, and rolls back", () => {
  const result = harness({ environment: { FAKE_HEALTH_MODE: "timeout" } });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /did not become healthy/);
  assert.match(result.stderr, /rollback succeeded/);
  assert.match(result.stdout, /bounded compose status/);
  assert.match(result.stdout, /bounded ui and chat logs/);
  assert.equal(result.phoneState.activeId, previousId);
  assert.equal(result.phoneState.rollbackRestored, true);
  assert.equal(result.phoneState.upCalls, 2);
  const commands = result.adbCalls.map(({ command }) => command);
  assert.equal(commands.filter((command) => command === "/data/eip-cve-ops/eip.sh ps -q ui").length, 32);
  assert.equal(commands.filter((command) => command === "/data/eip-cve-ops/eip.sh ps -q chat").length, 2);
  const statusEvidence = commands.indexOf("/data/eip-cve-ops/eip.sh ps");
  const logEvidence = commands.indexOf("/data/eip-cve-ops/eip.sh logs --no-color --tail 40 ui chat");
  const restore = commands.indexOf(`${phoneDocker()} tag ${previousId} eip-cve-controller:local`);
  assert.ok(statusEvidence >= 0 && statusEvidence < logEvidence && logEvidence < restore);
});

test("a candidate up failure captures evidence and restores a healthy previous stack", () => {
  const result = harness({ environment: { FAKE_CANDIDATE_UP_FAILURE: "true" } });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /candidate UI recreation failed/);
  assert.match(result.stderr, /rollback succeeded/);
  assert.equal(result.phoneState.activeId, previousId);
  assert.equal(result.phoneState.rollbackRestored, true);
  assert.equal(result.phoneState.upCalls, 2);
  const commands = result.adbCalls.map(({ command }) => command);
  const candidateUp = commands.indexOf("/data/eip-cve-ops/eip.sh up --force-recreate --no-deps ui");
  const statusEvidence = commands.indexOf("/data/eip-cve-ops/eip.sh ps");
  const restore = commands.indexOf(`${phoneDocker()} tag ${previousId} eip-cve-controller:local`);
  const rollbackUp = commands.lastIndexOf("/data/eip-cve-ops/eip.sh up --force-recreate");
  assert.ok(candidateUp >= 0 && candidateUp < statusEvidence && statusEvidence < restore && restore < rollbackUp);
});

test("a v4 skills-release failure restores managed state and source context before the old image", () => {
  const result = harness({ environment: { FAKE_SKILLS_RELEASE_FAILURE: "true" } });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Forge v4 managed-skills rebase failed/);
  assert.match(result.stderr, /rollback succeeded/);
  assert.equal(result.phoneState.managedRestored, true);
  assert.equal(result.phoneState.sourceRestored, true);
  assert.equal(result.phoneState.activeId, previousId);

  const commands = result.adbCalls.map(({ command }) => command);
  const release = commands.indexOf("/data/eip-cve-ops/eip.sh skills-release");
  const managedRestore = commands.indexOf(`/data/eip-cve-ops/eip.sh managed-state restore ${"1".repeat(64)}`);
  const sourceRestore = commands.findIndex((command) => command.includes("/restore-source-ops.sh restore "));
  const imageRestore = commands.indexOf(`${phoneDocker()} tag ${previousId} eip-cve-controller:local`);
  const oldStart = commands.lastIndexOf("/data/eip-cve-ops/eip.sh up --force-recreate");
  assert.ok(release >= 0 && release < managedRestore && managedRestore < sourceRestore);
  assert.ok(sourceRestore < imageRestore && imageRestore < oldStart);
});

test("the source transaction must match before any tag or service mutation", () => {
  const result = harness({ environment: { FAKE_SOURCE_PENDING_FAILURE: "true" } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /matching source and operations transaction is not pending/);
  const commands = result.adbCalls.map(({ command }) => command);
  assert.equal(commands.some((command) => command.includes(" tag ")), false);
  assert.equal(commands.includes("/data/eip-cve-ops/eip.sh down"), false);
});

test("an ambiguous source restore continues only after its exact postcondition", () => {
  const result = harness({
    environment: {
      FAKE_SKILLS_RELEASE_FAILURE: "true",
      FAKE_SOURCE_RESTORE_AMBIGUOUS: "true",
    },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /source and operations restore returned nonzero, but its exact postcondition is present/);
  assert.match(result.stderr, /rollback succeeded/);
  assert.equal(result.phoneState.sourceRestored, true);
  assert.equal(result.phoneState.activeId, previousId);
});

test("an ambiguous managed snapshot is accepted only after its exact postcondition", () => {
  const result = harness({ environment: { FAKE_MANAGED_PREPARE_AMBIGUOUS: "true" } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /managed-skills snapshot returned nonzero, but its exact postcondition is present/);
  assert.equal(result.phoneState.managedPrepared, true);
  assert.equal(result.phoneState.activeId, candidateId);
});

test("a failed rollback is reported and never converted to candidate success", () => {
  const result = harness({
    environment: {
      FAKE_HEALTH_MODE: "timeout",
      FAKE_ROLLBACK_HEALTH_FAILURE: "true",
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /rollback failed: ui and chat are not healthy/);
  assert.match(result.stderr, /automatic rollback did not recover/);
  assert.doesNotMatch(result.stdout, /^healthy: ui and chat use/m);
  assert.equal(result.phoneState.activeId, previousId);
  assert.equal(result.phoneState.rollbackRestored, true);
  const commands = result.adbCalls.map(({ command }) => command);
  assert.equal(commands.filter((command) => command === "/data/eip-cve-ops/eip.sh ps").length, 2);
  assert.equal(commands.filter((command) => command === "/data/eip-cve-ops/eip.sh logs --no-color --tail 40 ui chat").length, 2);
});

test("dirty attribution is rejected before any Docker or phone command", () => {
  const result = harness({ manifestOverrides: { builder: { dirty: true } } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /requires clean Forge and companion source/);
  assert.deepEqual(result.dockerCalls, []);
  assert.deepEqual(result.adbCalls, []);
});

test("manifest contract mismatches are rejected before any command", async (t) => {
  const cases = [
    ["schema", { schemaVersion: 2 }],
    ["kind", { kind: "other-manifest" }],
    ["platform", { platform: "linux/amd64" }],
    ["tag", { controller: { tag: "eip-cve-controller:other" } }],
    ["image ID", { controller: { imageId: "sha256:not-an-id" } }],
    ["Forge dirty state", { controller: { sourceDirty: true } }],
    ["source attribution", { controller: { sourceSnapshotDigest: "sha256:not-a-digest" } }],
  ];
  for (const [name, manifestOverrides] of cases) {
    await t.test(name, () => {
      const result = harness({ manifestOverrides });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /invalid build manifest/);
      assert.deepEqual(result.dockerCalls, []);
      assert.deepEqual(result.adbCalls, []);
    });
  }
});

test("an ambient Docker relay target is rejected before command execution", () => {
  const result = harness({ environment: { DOCKER_HOST: "tcp://127.0.0.1:2375" } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /DOCKER_HOST must be unset/);
  assert.deepEqual(result.dockerCalls, []);
  assert.deepEqual(result.adbCalls, []);
});

test("exactly one safe explicit ADB serial is required", async (t) => {
  const cases = [
    ["missing", []],
    ["empty", ["--serial", ""]],
    ["unsafe", ["--serial", "pixel one"]],
    ["option-like", ["--serial", "-sneaky"]],
    ["duplicate", ["--serial", testSerial, "--serial", testSerial]],
  ];
  for (const [name, serialArgs] of cases) {
    await t.test(name, () => {
      const result = harness({ serialArgs });
      assert.equal(result.status, 2);
      assert.deepEqual(result.dockerCalls, []);
      assert.deepEqual(result.adbCalls, []);
    });
  }
});

test("deployment tooling has no host Docker export or proxy path", () => {
  const eipRoot = path.join(root, "eip");
  assert.equal(fs.existsSync(path.join(eipRoot, "deploy-to-phone.sh")), false);
  assert.equal(fs.existsSync(path.join(root, "phone-docker-proxy.py")), false);
  for (const name of fs.readdirSync(eipRoot).filter((entry) => entry.endsWith(".sh"))) {
    const source = fs.readFileSync(path.join(eipRoot, name), "utf8");
    assert.doesNotMatch(source, /\bdocker\s+save\b/i, `${name} exports an image through host Docker`);
    assert.doesNotMatch(source, /DOCKER_HOST=tcp:\/\//, `${name} selects a Docker TCP proxy`);
    assert.doesNotMatch(source, /phone-docker-proxy/, `${name} references the obsolete proxy`);
  }
});

function phoneDocker() {
  return "DOCKER_HOST=unix:///data/docker/run/docker.sock /data/docker/bin/docker";
}

function quotedRemote(command) {
  return `su -c '${command.replaceAll("'", remoteEscapedQuote)}'`;
}
