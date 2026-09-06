import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wrapperPath = path.join(projectRoot, "android", "buildkit-runc.sh");
const dockerdPath = path.join(projectRoot, "android", "dockerd.sh");
const wrapperSource = fs.readFileSync(wrapperPath, "utf8");
const dockerdSource = fs.readFileSync(dockerdPath, "utf8");

assert.equal(fs.statSync(wrapperPath).mode & 0o111, 0o111, "wrapper must be executable");
assert.match(wrapperSource, /^#!\/system\/bin\/sh\n/);
assert.match(wrapperSource, /^RUNC=\/data\/docker\/bin\/runc$/m);
assert.match(wrapperSource, /^STATE_ROOT=\/dev\/docker\/buildkit-runc$/m);
assert.match(wrapperSource, /^exec "\$RUNC" --root "\$STATE_ROOT" "\$@"$/m);

assert.match(dockerdSource, /^BUILDKIT_RUNC=\$D\/bin\/buildkit-runc\.sh$/m);
assert.match(dockerdSource, /^export DOCKER_BUILDKIT_RUNC_COMMAND=\$BUILDKIT_RUNC$/m);
assert.match(dockerdSource, /if \[ ! -x "\$BUILDKIT_RUNC" \]; then/);

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pixel-buildkit-runc-"));
const fakeRunc = path.join(temporaryRoot, "runc");
const callLog = path.join(temporaryRoot, "runc-call.json");
const runnableWrapper = path.join(temporaryRoot, "buildkit-runc.sh");

fs.writeFileSync(fakeRunc, `#!/bin/sh\nprintf '%s\\n' "$@" > "$FAKE_RUNC_LOG"\n`, { mode: 0o755 });
fs.writeFileSync(
  runnableWrapper,
  wrapperSource
    .replace("#!/system/bin/sh", "#!/bin/sh")
    .replace("RUNC=/data/docker/bin/runc", `RUNC=${fakeRunc}`)
    .replace("STATE_ROOT=/dev/docker/buildkit-runc", "STATE_ROOT=/tmp/test-buildkit-runc"),
  { mode: 0o755 },
);

const result = spawnSync(runnableWrapper, ["run", "--bundle", "/tmp/bundle", "build-step"], {
  encoding: "utf8",
  env: { ...process.env, FAKE_RUNC_LOG: callLog },
});
assert.equal(result.status, 0, result.stderr);
assert.deepEqual(fs.readFileSync(callLog, "utf8").trim().split("\n"), [
  "--root",
  "/tmp/test-buildkit-runc",
  "run",
  "--bundle",
  "/tmp/bundle",
  "build-step",
]);

fs.rmSync(temporaryRoot, { recursive: true, force: true });
