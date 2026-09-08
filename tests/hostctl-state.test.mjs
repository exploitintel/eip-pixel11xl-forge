import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(projectRoot, "eip", "hostctl-state.mjs"), "utf8");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pixel-hostctl-state-"));
  const state = path.join(root, "state");
  const runs = path.join(state, "runs");
  const pocsRepo = path.join(root, "publish-target");
  fs.mkdirSync(runs, { recursive: true });
  fs.mkdirSync(pocsRepo);
  fs.writeFileSync(path.join(state, "queue.json"), '{"items":[]}\n');
  const script = path.join(root, "hostctl-state.mjs");
  fs.writeFileSync(script, source.replace(
    'const stateRoot = "/data/eip-cve/state";',
    `const stateRoot = ${JSON.stringify(state)};`,
  ));
  return { root, state, runs, pocsRepo, script };
}

function run(item, { parkProof = false, publishEnabled = "false", omitPublishEnabled = false } = {}) {
  const env = { ...process.env, EIP_POCS_REPO: item.pocsRepo };
  if (omitPublishEnabled) delete env.EIP_CVE_PUBLISH_ENABLED;
  else env.EIP_CVE_PUBLISH_ENABLED = publishEnabled;
  return spawnSync(process.execPath, [item.script, ...(parkProof ? ["--park-proof"] : [])], {
    encoding: "utf8",
    env,
  });
}

function fields(output) {
  return Object.fromEntries(output.trim().split("\n").map((line) => line.split("=")));
}

function meta(overrides = {}) {
  return {
    cve: "CVE-2099-1234",
    startedAt: "2099-01-02T03:04:05.678Z",
    status: "running",
    ...overrides,
  };
}

function writeMeta(item, name, value) {
  fs.writeFileSync(path.join(item.runs, `${name}.meta.json`), `${JSON.stringify(value)}\n`);
  if ((value.kind ?? "run") === "run" && value.status === "running") {
    fs.writeFileSync(path.join(item.state, "queue.json"), `${JSON.stringify({
      items: [{ cve: value.cve, state: "running", startedAt: value.startedAt }],
    })}\n`);
  }
}

function publicationIntent(item, overrides = {}) {
  return {
    schema: "eip-cve-publication-intent-v1",
    cve: "CVE-2099-1234",
    pocsRepo: item.pocsRepo,
    queueItemSha256: "a".repeat(64),
    repository: "github.com/example/security-labs",
    fetchUrl: "https://github.com/example/security-labs.git",
    pushUrl: "git@github.com:example/security-labs.git",
    baseBranch: "main",
    baseSha: "b".repeat(40),
    branch: "add/cve-2099-1234",
    commit: "c".repeat(40),
    phase: "prepared",
    pr: null,
    publishedAt: null,
    ...overrides,
  };
}

function writePublicationIntent(item, value, name = value.cve) {
  const intents = path.join(item.state, "publication-intents");
  fs.mkdirSync(intents, { recursive: true });
  fs.writeFileSync(path.join(intents, `${name}.json`), `${JSON.stringify(value)}\n`);
}

test("empty and terminal metadata report idle", () => {
  const item = fixture();
  try {
    writeMeta(item, "old", meta({ status: "exited" }));
    const result = run(item);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fields(result.stdout), {
      work: "idle",
      active_count: "0",
      active_kind: "none",
      active_cve: "none",
      active_phase: "none",
      active_started_at: "none",
    });
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test("normal status remains idle when publication is enabled", () => {
  const item = fixture();
  try {
    const result = run(item, { publishEnabled: "true" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fields(result.stdout).work, "idle");
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test("park proof inspects real state regardless of the publication setting", () => {
  for (const options of [
    { publishEnabled: "false" },
    { publishEnabled: "true" },
    { publishEnabled: "yes" },
    { omitPublishEnabled: true },
  ]) {
    const item = fixture();
    try {
      const result = run(item, { parkProof: true, ...options });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fields(result.stdout).work, "idle");
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  }
});

test("cancelled metadata is a valid terminal record", () => {
  const item = fixture();
  try {
    writeMeta(item, "cancelled", meta({ status: "cancelled" }));
    const result = run(item);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fields(result.stdout).work, "idle");
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test("every lane is active, including launch intent before a PID", () => {
  for (const kind of ["run", "scout", "qa", "verify"]) {
    const item = fixture();
    try {
      const value = meta({ pid: null, spawned: false, processIdentity: null });
      if (kind !== "run") value.kind = kind;
      if (kind === "scout") value.cve = null;
      writeMeta(item, kind, value);
      const result = run(item);
      assert.equal(result.status, 10, result.stderr);
      const output = fields(result.stdout);
      assert.equal(output.work, "active");
      assert.equal(output.active_count, "1");
      assert.equal(output.active_kind, kind);
      assert.equal(output.active_cve, kind === "scout" ? "none" : "CVE-2099-1234");
      assert.equal(output.active_phase, kind === "run" ? "router" : kind);
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  }
});

test("run phase follows the exact v4 lab milestone order", () => {
  const cases = [
    ["router", () => {}],
    ["research", (lab) => fs.writeFileSync(path.join(lab, "INTEL.md"), "intel\n")],
    ["branch", (lab) => { fs.mkdirSync(path.join(lab, "lab")); fs.writeFileSync(path.join(lab, "lab", "compose.yaml"), "x\n"); }],
    ["poc", (lab) => { fs.mkdirSync(path.join(lab, "poc")); fs.writeFileSync(path.join(lab, "poc", "poc.py"), "x\n"); }],
    ["publish", (lab) => { fs.mkdirSync(path.join(lab, "publish")); fs.writeFileSync(path.join(lab, "publish", "README.md"), "x\n"); }],
  ];
  for (const [expected, prepare] of cases) {
    const item = fixture();
    try {
      const lab = path.join(item.state, "labs", "CVE-2099-1234");
      fs.mkdirSync(lab, { recursive: true });
      prepare(lab);
      writeMeta(item, "run", meta());
      assert.equal(fields(run(item).stdout).active_phase, expected);
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  }
});

test("concurrent lanes are never hidden by the run lane", () => {
  const item = fixture();
  try {
    writeMeta(item, "run", meta());
    writeMeta(item, "qa", meta({ kind: "qa" }));
    const result = run(item);
    assert.equal(result.status, 10);
    assert.deepEqual(fields(result.stdout), {
      work: "active",
      active_count: "2",
      active_kind: "multiple",
      active_cve: "multiple",
      active_phase: "multiple",
      active_started_at: "multiple",
    });
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test("every durable publication intent keeps the host active through reconciliation", () => {
  for (const phase of ["prepared", "branch", "published"]) {
    const item = fixture();
    try {
      const overrides = phase === "published"
        ? { phase, pr: "https://github.com/example/security-labs/pull/7", publishedAt: "2099-01-02T03:04:05.678Z" }
        : { phase };
      writePublicationIntent(item, publicationIntent(item, overrides));
      const result = run(item);
      assert.equal(result.status, 10, result.stderr);
      assert.deepEqual(fields(result.stdout), {
        work: "active",
        active_count: "1",
        active_kind: "publish",
        active_cve: "CVE-2099-1234",
        active_phase: "publish",
        active_started_at: "unknown",
      });
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  }
});

test("a durable publication intent is counted alongside every live lane", () => {
  const item = fixture();
  try {
    writeMeta(item, "qa", meta({ kind: "qa" }));
    writePublicationIntent(item, publicationIntent(item));
    const result = run(item);
    assert.equal(result.status, 10, result.stderr);
    assert.deepEqual(fields(result.stdout), {
      work: "active",
      active_count: "2",
      active_kind: "multiple",
      active_cve: "multiple",
      active_phase: "multiple",
      active_started_at: "multiple",
    });
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test("malformed publication intent directories and records fail closed", () => {
  const malformedRecords = [
    (item) => writePublicationIntent(item, publicationIntent(item, { schema: "unknown" })),
    (item) => writePublicationIntent(item, publicationIntent(item), "CVE-2099-9999"),
    (item) => writePublicationIntent(item, publicationIntent(item, { pocsRepo: "/wrong/checkout" })),
    (item) => writePublicationIntent(item, publicationIntent(item, { fetchUrl: "https://user@example.com/example/security-labs.git" })),
    (item) => writePublicationIntent(item, { ...publicationIntent(item), unexpected: true }),
    (item) => {
      const intents = path.join(item.state, "publication-intents");
      fs.mkdirSync(intents);
      fs.writeFileSync(path.join(intents, "CVE-2099-1234.json"), "{\"phase\":");
    },
    (item) => {
      const intents = path.join(item.state, "publication-intents");
      fs.mkdirSync(intents);
      fs.writeFileSync(path.join(intents, "CVE-2099-1234.json.tmp"), "temporary\n");
    },
  ];
  for (const prepare of malformedRecords) {
    const item = fixture();
    try {
      prepare(item);
      const result = run(item);
      assert.equal(result.status, 11);
      assert.equal(fields(result.stdout).work, "ambiguous");
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  }

  const linkedFile = fixture();
  try {
    const intents = path.join(linkedFile.state, "publication-intents");
    fs.mkdirSync(intents);
    const target = path.join(linkedFile.root, "intent.json");
    fs.writeFileSync(target, `${JSON.stringify(publicationIntent(linkedFile))}\n`);
    fs.symlinkSync(target, path.join(intents, "CVE-2099-1234.json"));
    assert.equal(run(linkedFile).status, 11);
  } finally {
    fs.rmSync(linkedFile.root, { recursive: true, force: true });
  }

  const linkedDirectory = fixture();
  try {
    const target = path.join(linkedDirectory.root, "intent-directory");
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(linkedDirectory.state, "publication-intents"));
    assert.equal(run(linkedDirectory).status, 11);
  } finally {
    fs.rmSync(linkedDirectory.root, { recursive: true, force: true });
  }
});

test("malformed, linked, unreadable-shape, and unknown-status metadata fail closed", () => {
  const cases = [
    () => "{\"status\":\"exited\"",
    () => "[]\n",
    () => '{"status":"success"}\n',
    () => '{"status":"exited"}\nnot-json\n',
  ];
  for (const make of cases) {
    const item = fixture();
    try {
      fs.writeFileSync(path.join(item.runs, "bad.meta.json"), make());
      const result = run(item);
      assert.equal(result.status, 11);
      assert.equal(fields(result.stdout).work, "ambiguous");
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  }

  const linked = fixture();
  try {
    fs.writeFileSync(path.join(linked.root, "target.json"), '{"status":"exited"}\n');
    fs.symlinkSync(path.join(linked.root, "target.json"), path.join(linked.runs, "bad.meta.json"));
    assert.equal(run(linked).status, 11);
  } finally {
    fs.rmSync(linked.root, { recursive: true, force: true });
  }
});

test("a running queue attempt without its exact run meta fails closed", () => {
  const item = fixture();
  try {
    fs.writeFileSync(path.join(item.state, "queue.json"), `${JSON.stringify({
      items: [{ cve: "CVE-2099-1234", state: "running", startedAt: "2099-01-02T03:04:05.678Z" }],
    })}\n`);
    const result = run(item);
    assert.equal(result.status, 11);
    assert.equal(fields(result.stdout).work, "ambiguous");
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test("missing queue is the valid empty default but malformed present queue fails closed", () => {
  const missing = fixture();
  try {
    fs.rmSync(path.join(missing.state, "queue.json"));
    assert.equal(run(missing).status, 0);
  } finally {
    fs.rmSync(missing.root, { recursive: true, force: true });
  }

  const malformed = fixture();
  try {
    fs.writeFileSync(path.join(malformed.state, "queue.json"), '{"items":');
    assert.equal(run(malformed).status, 11);
  } finally {
    fs.rmSync(malformed.root, { recursive: true, force: true });
  }
});
