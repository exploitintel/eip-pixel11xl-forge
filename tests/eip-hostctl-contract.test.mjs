import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "eip", "eip-hostctl.sh"), "utf8");

function functionBody(name, nextName) {
  const start = source.indexOf(`${name}() {\n`);
  const end = source.indexOf(`\n${nextName}() {\n`, start + 1);
  assert.notEqual(start, -1, `${name} is missing`);
  assert.notEqual(end, -1, `${nextName} boundary is missing`);
  return source.slice(start, end);
}

test("hostctl uses the canonical Forge maintenance record", () => {
  assert.match(source, /^MAINTENANCE_DIR=\/data\/docker\/eip-cve-control$/m);
  assert.match(source, /^MAINTENANCE_FILE=\/data\/docker\/eip-cve-control\/maintenance-v1$/m);
  const enable = functionBody("enable_maintenance", "disable_maintenance");
  assert.match(enable, /printf 'EIP_CVE_MAINTENANCE_V1\\n'/);
  assert.match(enable, /chmod 0644 "\$MAINTENANCE_TEMP"/);
});

test("park closes admission before proving lanes and Agent idle", () => {
  const park = functionBody("park_system", "write_park_when_idle_marker");
  assert.ok(park.indexOf("enable_maintenance") < park.indexOf("safe_idle_snapshot"));
  assert.match(park, /\[ "\$PARK_MODE" = pending \] \|\| disable_maintenance/);

  const idle = functionBody("safe_idle_snapshot", "stop_exact_daemon");
  assert.ok(idle.indexOf("work_snapshot park-proof") < idle.indexOf("broker_snapshot"));
  assert.match(idle, /\[ "\$AGENT_BUSY" = false \]/);
  assert.doesNotMatch(source, /publication is enabled and pre-intent publication/);
});

test("start reopens admission only for normal broker health", () => {
  const start = functionBody("start_system", "safe_idle_snapshot");
  assert.ok(start.indexOf("enable_maintenance") < start.indexOf('"$EIP" up'));
  assert.ok(start.indexOf("disable_maintenance") < start.indexOf("broker_snapshot"));
  assert.match(start, /\[ "\$BROKER_OK" = true \]/);
  assert.match(start, /enable_maintenance\n  die "Forge did not pass normal post-maintenance health/);
});

test("pending park retains admission and cancellation reopens it", () => {
  const pending = functionBody("write_park_when_idle_marker", "cancel_park_when_idle");
  assert.match(pending, /^write_park_when_idle_marker\(\) \{\n  enable_maintenance/m);
  const cancel = functionBody("cancel_park_when_idle", "reconcile_park_when_idle");
  assert.match(cancel, /rm -f "\$PARK_WHEN_IDLE_MARKER"/);
  assert.match(cancel, /disable_maintenance/);
  const reconcile = functionBody("reconcile_park_when_idle", "bounded_logs");
  assert.match(reconcile, /park_system pending/);
});
