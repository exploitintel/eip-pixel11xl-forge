import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(projectRoot, "tools", "route-policy.c");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pixel-route-policy-c-"));
const binary = path.join(temporaryRoot, "route-policy");

const compile = spawnSync(
  process.env.CC ?? "cc",
  [
    "-std=c99", "-Wall", "-Wextra", "-Werror", "-O2",
    "-DROUTE_POLICY_DESCRIBE_ONLY=1", "-o", binary, source,
  ],
  { cwd: projectRoot, encoding: "utf8" },
);
assert.equal(compile.status, 0, compile.stderr);

process.on("exit", () => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

function run(...args) {
  return spawnSync(binary, args, { cwd: projectRoot, encoding: "utf8" });
}

test("the helper describes only the two exact owned policy shapes", () => {
  let result = run("describe", "to-main", "172.17.0.0/16", "9990");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout,
    "operation=describe selector=to-main cidr=172.17.0.0/16 table=254 priority=9990\n");

  result = run("describe", "from-table", "10.64.0.0/20", "1016", "9991");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout,
    "operation=describe selector=from-table cidr=10.64.0.0/20 table=1016 priority=9991\n");
});

test("add and delete share the same strict selector contract", () => {
  for (const operation of ["add", "delete"]) {
    const toMain = run(operation, "to-main", "192.168.240.0/24", "9990");
    assert.equal(toMain.status, 1);
    assert.match(toMain.stderr, /mutation requires the Linux route-netlink build/);
    assert.doesNotMatch(toMain.stderr, /usage:/);

    const fromTable = run(operation, "from-table", "172.17.0.0/16", "1016", "9991");
    assert.equal(fromTable.status, 1);
    assert.match(fromTable.stderr, /mutation requires the Linux route-netlink build/);
    assert.doesNotMatch(fromTable.stderr, /usage:/);
  }
});

test("the helper rejects noncanonical, public, broad, and host-address CIDRs", () => {
  for (const cidr of [
    "172.017.0.0/16",
    "172.17.0.1/16",
    "172.17.0.0/016",
    "172.17.0.0/11",
    "172.17.0.0/25",
    "172.32.0.0/16",
    "192.0.2.0/24",
    "10.64.0.0",
    "10.64.0.0/20/1",
  ]) {
    const result = run("describe", "to-main", cidr, "9990");
    assert.equal(result.status, 2, `${cidr} should be rejected`);
    assert.match(result.stderr, /usage:/);
  }
});

test("the helper rejects every priority or table outside its owned contract", () => {
  for (const priority of ["0", "09990", "9989", "9991", "4294967296", "-1", "x9990"]) {
    const result = run("describe", "to-main", "172.17.0.0/16", priority);
    assert.equal(result.status, 2, `priority ${priority} should be rejected`);
  }
  for (const table of ["0", "0256", "254", "255", "4294967296", "-1", "wlan0"]) {
    const result = run("describe", "from-table", "172.17.0.0/16", table, "9991");
    assert.equal(result.status, 2, `table ${table} should be rejected`);
  }
  for (const priority of ["0", "09991", "9990", "9992", "4294967296", "-1"]) {
    const result = run("describe", "from-table", "172.17.0.0/16", "1016", priority);
    assert.equal(result.status, 2, `priority ${priority} should be rejected`);
  }
});

test("unknown operations, selectors, and extra arguments fail as usage errors", () => {
  for (const args of [
    [],
    ["probe", "to-main", "172.17.0.0/16", "9990"],
    ["describe", "other", "172.17.0.0/16", "9990"],
    ["describe", "to-main", "172.17.0.0/16"],
    ["describe", "to-main", "172.17.0.0/16", "9990", "extra"],
    ["describe", "from-table", "172.17.0.0/16", "1016"],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 2, `${JSON.stringify(args)} should be rejected`);
    assert.match(result.stderr, /usage:/);
  }
});

test("the Linux implementation is raw netlink only and has no ambient execution or I/O path", () => {
  const text = fs.readFileSync(source, "utf8");
  for (const required of [
    "AF_NETLINK", "NETLINK_ROUTE", "RTM_NEWRULE", "RTM_DELRULE",
    "NLM_F_REQUEST", "NLM_F_ACK", "NLM_F_CREATE", "NLM_F_EXCL",
    "FRA_PRIORITY", "FRA_TABLE", "FRA_DST", "FRA_SRC", "FR_ACT_TO_TBL",
  ]) {
    assert.ok(text.includes(required), `missing netlink contract token: ${required}`);
  }
  assert.doesNotMatch(text, /\b(?:system|popen|fork|exec[lv]?[ep]?|dlopen|open|fopen)\s*\(/);
  assert.doesNotMatch(text, /curl|wget|https?:|getaddrinfo|AF_INET6|SOCK_STREAM/);
});
