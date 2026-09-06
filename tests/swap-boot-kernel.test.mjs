import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  PAGE,
  expectedSwap,
  makeBootImage,
  patternBytes,
  readKernelSize,
  sha256,
} from "./helpers/boot-image-fixture.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tool = path.join(projectRoot, "tools", "swap-boot-kernel.py");
const bootSwapDocumentation = fs.readFileSync(path.join(projectRoot, "docs", "BOOT-SWAP.md"), "utf8");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pixel-swap-boot-kernel-"));

assert.equal(fs.statSync(tool).mode & 0o111, 0o111, "tool must be executable");
assert.match(fs.readFileSync(tool, "utf8"), /^#!\/usr\/bin\/env python3\n/);
assert.match(
  bootSwapDocumentation,
  /output directory must already exist, be controlled by the operator,[\s\S]*must not be renamed or modified by another process during publication/,
);

function run(args) {
  return spawnSync(tool, args, { cwd: temporaryRoot, encoding: "utf8" });
}

function write(name, buffer) {
  const file = path.join(temporaryRoot, name);
  fs.writeFileSync(file, buffer);
  return file;
}

function assertNoToolTemps(context) {
  const leftovers = fs.readdirSync(temporaryRoot).filter((name) => (
    name.startsWith(".swap-boot-kernel.") && name.endsWith(".tmp")
  ));
  assert.deepEqual(leftovers, [], `${context}: temporary output leaked`);
}

function gates({
  target = stock,
  currentKernel = stockKernel,
  image = newKernel,
  output = expected,
} = {}) {
  return [
    "--expect-target-size", String(target.length),
    "--expect-current-sha256", sha256(target),
    "--expect-current-kernel-sha256", sha256(currentKernel),
    "--expect-image-sha256", sha256(image),
    "--expect-output-sha256", sha256(output),
  ];
}

function replaceGate(items, name, value) {
  const changed = [...items];
  const index = changed.indexOf(name);
  assert.notEqual(index, -1, `missing gate ${name}`);
  changed[index + 1] = value;
  return changed;
}

function refused(name, {
  targetPath = stockPath,
  imagePath = newKernelPath,
  expectationArgs = gates(),
  pattern,
} = {}) {
  const output = path.join(temporaryRoot, `${name}.img`);
  const result = run([targetPath, imagePath, "-o", output, ...expectationArgs]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, pattern);
  assert.equal(fs.existsSync(output), false, `${name} must not create output`);
  assertNoToolTemps(name);
}

// A three page stock image: header page, two kernel pages, one tail page.
const stockKernel = patternBytes(5000, 0x1001);
const tail = patternBytes(PAGE, 0x7a11);
const stock = makeBootImage({ kernel: stockKernel, tail });
assert.equal(stock.length, 4 * PAGE);
const stockPath = write("stock.img", stock);

// Happy path: a smaller kernel lands zero padded in the old region, the tail
// keeps its offset, and only the kernel_size field of the header changes.
const newKernel = patternBytes(3000, 0x2002);
const newKernelPath = write("Image.lz4", newKernel);
const expected = expectedSwap(stock, newKernel);
const outPath = path.join(temporaryRoot, "out.img");
const ok = run([stockPath, newKernelPath, "-o", outPath, ...gates()]);
assert.equal(ok.status, 0, ok.stderr);
const out = fs.readFileSync(outPath);
assert.equal(out.length, stock.length);
assert.equal(readKernelSize(out), 3000);
assert.deepEqual(out.subarray(PAGE, PAGE + 3000), newKernel);
assert.ok(out.subarray(PAGE + 3000, PAGE + 2 * PAGE).every((byte) => byte === 0), "padding must be zero");
assert.deepEqual(out.subarray(3 * PAGE), tail, "tail must be untouched at the same offset");
assert.deepEqual(out.subarray(0, 8), stock.subarray(0, 8));
assert.deepEqual(out.subarray(12, PAGE), stock.subarray(12, PAGE), "only kernel_size may change");
assert.deepEqual(out, expected);
assert.match(ok.stdout, new RegExp(`^${sha256(expected)}  `, "m"));
assertNoToolTemps("successful swap");

// A kernel exactly filling the region is accepted; one byte more is refused.
const exactKernel = patternBytes(2 * PAGE, 0x3003);
const exactExpected = expectedSwap(stock, exactKernel);
const exact = run([
  stockPath,
  write("exact.lz4", exactKernel),
  "-o",
  path.join(temporaryRoot, "exact.img"),
  ...gates({ image: exactKernel, output: exactExpected }),
]);
assert.equal(exact.status, 0, exact.stderr);
const bigKernel = patternBytes(2 * PAGE + 1, 0x4004);
const oversized = run([
  stockPath,
  write("big.lz4", bigKernel),
  "-o",
  path.join(temporaryRoot, "big.img"),
  ...gates({ image: bigKernel, output: stock }),
]);
assert.equal(oversized.status, 1);
assert.match(oversized.stderr, /larger than the stock kernel region/);
assert.equal(fs.existsSync(path.join(temporaryRoot, "big.img")), false, "no output on refusal");

// Every identity is mandatory and is checked before an output is created.
refused("wrong-size", {
  expectationArgs: replaceGate(gates(), "--expect-target-size", String(stock.length + 1)),
  pattern: /target size mismatch/,
});
refused("wrong-current", {
  expectationArgs: replaceGate(gates(), "--expect-current-sha256", "00".repeat(32)),
  pattern: /current sha256 mismatch/,
});
refused("wrong-payload", {
  expectationArgs: replaceGate(gates(), "--expect-current-kernel-sha256", "11".repeat(32)),
  pattern: /current kernel sha256 mismatch/,
});
refused("wrong-image", {
  expectationArgs: replaceGate(gates(), "--expect-image-sha256", "22".repeat(32)),
  pattern: /image sha256 mismatch/,
});
refused("wrong-output", {
  expectationArgs: replaceGate(gates(), "--expect-output-sha256", "33".repeat(32)),
  pattern: /output sha256 mismatch/,
});

// A matching kernel payload cannot hide changed preserved partition bytes.
const alteredTail = Buffer.from(stock);
alteredTail[alteredTail.length - 1] ^= 0xff;
refused("altered-tail", {
  targetPath: write("altered-tail-stock.img", alteredTail),
  pattern: /current sha256 mismatch/,
});

// A complete payload without the rest of its page-rounded region is still a
// truncated boot image. Slice assignment must never extend it into an output.
const truncatedPadding = stock.subarray(0, PAGE + stockKernel.length);
refused("truncated-padding", {
  targetPath: write("truncated-padding-stock.img", truncatedPadding),
  expectationArgs: gates({ target: truncatedPadding, output: stock }),
  pattern: /page-rounded kernel region runs past the end/,
});

// Header refusals: magic, header version, and a ramdisk that would move.
const badMagicImage = makeBootImage({ kernel: stockKernel, magic: "ANDROIDX" });
const badMagic = run([
  write("magic.img", badMagicImage), newKernelPath, "-o", path.join(temporaryRoot, "m.img"),
  ...gates({ target: badMagicImage, output: expectedSwap(badMagicImage, newKernel) }),
]);
assert.equal(badMagic.status, 1);
assert.match(badMagic.stderr, /magic/);
const badVersionImage = makeBootImage({ kernel: stockKernel, headerVersion: 2 });
const badVersion = run([
  write("v2.img", badVersionImage), newKernelPath, "-o", path.join(temporaryRoot, "v.img"),
  ...gates({ target: badVersionImage, output: expectedSwap(badVersionImage, newKernel) }),
]);
assert.equal(badVersion.status, 1);
assert.match(badVersion.stderr, /header version/);
const ramdiskImage = makeBootImage({ kernel: stockKernel, ramdiskSize: 100 });
const withRamdisk = run([
  write("rd.img", ramdiskImage), newKernelPath, "-o", path.join(temporaryRoot, "r.img"),
  ...gates({ target: ramdiskImage, output: expectedSwap(ramdiskImage, newKernel) }),
]);
assert.equal(withRamdisk.status, 1);
assert.match(withRamdisk.stderr, /ramdisk/);

// A zero-sized embedded kernel is not a valid swappable boot image. Keep the
// Python structural contract aligned with the in-place C implementation.
const zeroKernelImage = Buffer.from(stock);
zeroKernelImage.writeUInt32LE(0, 8);
const zeroKernelPath = write("zero-kernel-input.img", zeroKernelImage);
refused("zero-kernel", {
  targetPath: zeroKernelPath,
  expectationArgs: gates({
    target: zeroKernelImage,
    currentKernel: Buffer.alloc(0),
    output: stock,
  }),
  pattern: /kernel_size is zero/,
});
const inspectZeroKernel = run(["--print-kernel-sha256", zeroKernelPath]);
assert.equal(inspectZeroKernel.status, 1);
assert.match(inspectZeroKernel.stderr, /kernel_size is zero/);

// Refuse to overwrite an existing output.
const existingBytes = fs.readFileSync(outPath);
const existing = run([stockPath, newKernelPath, "-o", outPath, ...gates()]);
assert.equal(existing.status, 1);
assert.match(existing.stderr, /exists/);
assert.deepEqual(fs.readFileSync(outPath), existingBytes);

// A dangling output symlink is an existing path and must not be replaced.
const danglingOut = path.join(temporaryRoot, "dangling-output.img");
const danglingTarget = path.join(temporaryRoot, "does-not-exist.img");
fs.symlinkSync(danglingTarget, danglingOut);
const dangling = run([stockPath, newKernelPath, "-o", danglingOut, ...gates()]);
assert.equal(dangling.status, 1, dangling.stderr);
assert.match(dangling.stderr, /exists/);
assert.equal(fs.lstatSync(danglingOut).isSymbolicLink(), true);
assert.equal(fs.readlinkSync(danglingOut), danglingTarget);
assert.equal(fs.existsSync(danglingTarget), false);
assertNoToolTemps("dangling output refusal");

// Predictable legacy sidecars are never opened, truncated, followed, or moved.
const sidecarOut = path.join(temporaryRoot, "sidecar-output.img");
const sidecar = `${sidecarOut}.tmp`;
const sidecarSentinel = Buffer.from("existing sidecar must survive");
fs.writeFileSync(sidecar, sidecarSentinel);
const sidecarResult = run([stockPath, newKernelPath, "-o", sidecarOut, ...gates()]);
assert.equal(sidecarResult.status, 0, sidecarResult.stderr);
assert.deepEqual(fs.readFileSync(sidecar), sidecarSentinel);
assert.deepEqual(fs.readFileSync(sidecarOut), expected);
assert.equal(fs.lstatSync(sidecarOut).isSymbolicLink(), false);
assertNoToolTemps("pre-existing predictable sidecar");

const symlinkSidecarOut = path.join(temporaryRoot, "symlink-sidecar-output.img");
const symlinkSidecar = `${symlinkSidecarOut}.tmp`;
const sidecarVictim = path.join(temporaryRoot, "sidecar-victim.txt");
const victimSentinel = Buffer.from("symlink target must survive");
fs.writeFileSync(sidecarVictim, victimSentinel);
fs.symlinkSync(sidecarVictim, symlinkSidecar);
const symlinkSidecarResult = run([
  stockPath, newKernelPath, "-o", symlinkSidecarOut, ...gates(),
]);
assert.equal(symlinkSidecarResult.status, 0, symlinkSidecarResult.stderr);
assert.equal(fs.lstatSync(symlinkSidecar).isSymbolicLink(), true);
assert.equal(fs.readlinkSync(symlinkSidecar), sidecarVictim);
assert.deepEqual(fs.readFileSync(sidecarVictim), victimSentinel);
assert.deepEqual(fs.readFileSync(symlinkSidecarOut), expected);
assert.equal(fs.lstatSync(symlinkSidecarOut).isSymbolicLink(), false);
assertNoToolTemps("pre-existing predictable sidecar symlink");

// A publish error after the secure temporary file is written still cleans it.
const tooLongOutput = path.join(temporaryRoot, "x".repeat(300));
const publishFailure = run([stockPath, newKernelPath, "-o", tooLongOutput, ...gates()]);
assert.equal(publishFailure.status, 1, publishFailure.stderr);
assert.match(publishFailure.stderr, /cannot write/);
assertNoToolTemps("failed atomic publication");

// Inspection mode prints the kernel payload size and sha256 and writes nothing.
const inspect = run(["--print-kernel-sha256", stockPath]);
assert.equal(inspect.status, 0, inspect.stderr);
assert.equal(inspect.stdout.trim(), `${stockKernel.length} ${sha256(stockKernel)}`);
const inspectOut = run(["--print-kernel-sha256", outPath]);
assert.equal(inspectOut.stdout.trim(), `${newKernel.length} ${sha256(newKernel)}`);
assert.equal(run(["--print-kernel-sha256", stockPath, ...gates()]).status, 2);

// Missing or malformed mandatory expectations are usage errors and create no output.
assert.equal(run([]).status, 2);
assert.equal(run([stockPath]).status, 2);
for (const option of [
  "--expect-target-size",
  "--expect-current-sha256",
  "--expect-current-kernel-sha256",
  "--expect-image-sha256",
  "--expect-output-sha256",
]) {
  const expectationArgs = gates();
  const index = expectationArgs.indexOf(option);
  expectationArgs.splice(index, 2);
  const output = path.join(temporaryRoot, `missing-${option.slice(2)}.img`);
  const result = run([stockPath, newKernelPath, "-o", output, ...expectationArgs]);
  assert.equal(result.status, 2, `${option} must be mandatory`);
  assert.equal(fs.existsSync(output), false);
  assertNoToolTemps(`missing ${option}`);
}
assert.equal(run([
  stockPath, newKernelPath, "-o", path.join(temporaryRoot, "bad-size-syntax.img"),
  ...replaceGate(gates(), "--expect-target-size", "+16384"),
]).status, 2);
assert.equal(run([
  stockPath, newKernelPath, "-o", path.join(temporaryRoot, "bad-hash-syntax.img"),
  ...replaceGate(gates(), "--expect-current-sha256", "not-a-sha256"),
]).status, 2);
assert.equal(run([
  stockPath, newKernelPath, "-o", path.join(temporaryRoot, "legacy-option.img"),
  "--expect-sha256", sha256(expected), ...gates(),
]).status, 2);

fs.rmSync(temporaryRoot, { recursive: true, force: true });
