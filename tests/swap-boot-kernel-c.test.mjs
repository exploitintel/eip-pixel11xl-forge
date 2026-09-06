import assert from "node:assert/strict";
import crypto from "node:crypto";
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
  sha256,
} from "./helpers/boot-image-fixture.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(projectRoot, "tools", "swap-boot-kernel.c");
const pythonTool = path.join(projectRoot, "tools", "swap-boot-kernel.py");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pixel-swap-boot-kernel-c-"));
const binary = path.join(temporaryRoot, "swap-boot-kernel");

// Host build: an ordinary dynamic binary. Static linking is a property of
// the CI arm64 build, not of the algorithm under test here.
const build = spawnSync("cc", ["-std=c99", "-Wall", "-Wextra", "-Werror", "-O2", "-o", binary, source], {
  encoding: "utf8",
});
assert.equal(build.status, 0, build.stderr);

// The final writable-descriptor I/O must cover the entire target. This order
// is a source-level safety contract because a deterministic fixture cannot
// reproduce the last-instruction race with an external block-device writer.
const sourceText = fs.readFileSync(source, "utf8");
const writableGateStart = sourceText.indexOf("fd = open(target_path, O_RDWR | O_SYNC)");
const firstWrite = sourceText.indexOf("if (write_exact(fd, region", writableGateStart);
const writableGate = sourceText.slice(writableGateStart, firstWrite);
const payloadCheck = writableGate.indexOf("inspect_kernel_fd(fd, target_bytes");
const fullTargetCheck = writableGate.indexOf("sha256_fd_exact(fd, target_bytes, rw_full_hash)");
const writeMarker = writableGate.indexOf("write_started = 1");
assert.ok(writableGateStart >= 0 && firstWrite > writableGateStart);
assert.ok(payloadCheck >= 0 && payloadCheck < fullTargetCheck, "payload inspection must precede full hash");
assert.ok(fullTargetCheck < writeMarker, "full hash must be the final I/O before writing");

function run(args, extraEnvironment = {}) {
  return spawnSync(binary, args, {
    cwd: temporaryRoot,
    encoding: "utf8",
    env: { ...process.env, ...extraEnvironment },
  });
}

function write(name, buffer) {
  const file = path.join(temporaryRoot, name);
  fs.writeFileSync(file, buffer);
  return file;
}

const stockKernel = patternBytes(5000, 0x1001);
const tail = patternBytes(PAGE, 0x7a11);
const stock = makeBootImage({ kernel: stockKernel, tail });
const newKernel = patternBytes(3000, 0x2002);
const newKernelPath = write("Image.lz4", newKernel);
const stockKernelHash = sha256(stockKernel);
const newKernelHash = sha256(newKernel);
const expected = expectedSwap(stock, newKernel);

function gates({
  target = stock,
  currentKernel = stockKernel,
  image = newKernel,
  output = expected,
  targetSize = target.length,
  currentFullHash = sha256(target),
  currentKernelHash = sha256(currentKernel),
  imageHash = sha256(image),
  outputFullHash = sha256(output),
} = {}) {
  return [
    "--expect-target-size", String(targetSize),
    "--expect-current-sha256", currentFullHash,
    "--expect-current-kernel-sha256", currentKernelHash,
    "--expect-image-sha256", imageHash,
    "--expect-output-sha256", outputFullHash,
  ];
}

function replaceGate(items, name, value) {
  const changed = [...items];
  const index = changed.indexOf(name);
  assert.notEqual(index, -1, `missing gate ${name}`);
  changed[index + 1] = value;
  return changed;
}

function refused(targetPath, imagePath, expectationArgs, pattern) {
  const before = fs.readFileSync(targetPath);
  const result = run([targetPath, imagePath, ...expectationArgs]);
  assert.equal(result.status, 1, `expected refusal: ${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, pattern);
  assert.doesNotMatch(result.stderr, /RECOVERY REQUIRED/);
  assert.deepEqual(fs.readFileSync(targetPath), before, "target must not change on refusal");
}

// The built-in SHA-256 is the only cryptographic primitive protecting a
// partition write. Check it at every block boundary against node:crypto.
for (const length of [1, 55, 56, 63, 64, 65, 1000, PAGE, 1048577]) {
  const kernel = crypto.randomBytes(length);
  const image = write(`sha-${length}.img`, makeBootImage({ kernel }));
  const result = run(["--print-kernel-sha256", image]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `${length} ${sha256(kernel)}`, `sha256 of ${length} bytes`);
}

// Inspection mode matches the Python tool exactly.
const stockPath = write("stock.img", stock);
const inspect = run(["--print-kernel-sha256", stockPath]);
assert.equal(inspect.status, 0, inspect.stderr);
assert.equal(inspect.stdout.trim(), `${stockKernel.length} ${stockKernelHash}`);
const pythonInspect = spawnSync(pythonTool, ["--print-kernel-sha256", stockPath], { encoding: "utf8" });
assert.equal(inspect.stdout, pythonInspect.stdout);

// Happy path: all five identities match, and the in-place result is byte
// identical to both the expected fixture and the Python reference output.
const target = write("target.img", stock);
const ok = run([target, newKernelPath, ...gates()]);
assert.equal(ok.status, 0, ok.stderr);
assert.deepEqual(fs.readFileSync(target), expected);
assert.match(ok.stdout, new RegExp(`^installed ${newKernel.length} ${newKernelHash}$`, "m"));
const pythonOut = path.join(temporaryRoot, "python.img");
const python = spawnSync(pythonTool, [stockPath, newKernelPath, "-o", pythonOut, ...gates()], {
  encoding: "utf8",
});
assert.equal(python.status, 0, python.stderr);
assert.deepEqual(fs.readFileSync(target), fs.readFileSync(pythonOut));

// Already installed is valid only when the complete output identity and the
// embedded image payload both match. A read-only mode and historical mtime
// make an accidental same-byte rewrite observable even though contents would
// remain identical.
const alreadyTarget = write("already-installed.img", expected);
const historicalTime = new Date("2001-01-01T00:00:00Z");
fs.utimesSync(alreadyTarget, historicalTime, historicalTime);
fs.chmodSync(alreadyTarget, 0o444);
const alreadyMtime = fs.statSync(alreadyTarget, { bigint: true }).mtimeNs;
const again = run([
  alreadyTarget,
  newKernelPath,
  ...gates({ target: expected, currentKernel: newKernel }),
]);
const afterAlreadyMtime = fs.statSync(alreadyTarget, { bigint: true }).mtimeNs;
fs.chmodSync(alreadyTarget, 0o644);
assert.equal(again.status, 0, again.stderr);
assert.match(again.stdout, /^already installed/m);
assert.equal(afterAlreadyMtime, alreadyMtime, "already installed must not write the target");
assert.deepEqual(fs.readFileSync(alreadyTarget), expected);

// A test-only dynamic interposer makes the first fsync fail after the kernel
// pwrite. This exercises the dirty-target contract without adding a fault hook
// to the production binary.
const fsyncFaultCode = process.platform === "darwin" ? `
#include <errno.h>
#include <unistd.h>
static int fail_fsync(int fd) {
    (void)fd;
    errno = EIO;
    return -1;
}
__attribute__((used)) static struct {
    const void *replacement;
    const void *replacee;
} fsync_interpose __attribute__((section("__DATA,__interpose"))) = {
    (const void *)(unsigned long)&fail_fsync,
    (const void *)(unsigned long)&fsync
};
` : `
#include <errno.h>
#include <unistd.h>
int fsync(int fd) {
    (void)fd;
    errno = EIO;
    return -1;
}
`;
const fsyncFaultSource = write("fail-fsync.c", Buffer.from(fsyncFaultCode));
const fsyncFaultLibrary = path.join(
  temporaryRoot,
  process.platform === "darwin" ? "libfail-fsync.dylib" : "libfail-fsync.so",
);
const fsyncFaultBuildArgs = process.platform === "darwin"
  ? ["-dynamiclib", "-Wall", "-Wextra", "-Werror", "-o", fsyncFaultLibrary, fsyncFaultSource]
  : ["-shared", "-fPIC", "-Wall", "-Wextra", "-Werror", "-o", fsyncFaultLibrary, fsyncFaultSource];
const fsyncFaultBuild = spawnSync("cc", fsyncFaultBuildArgs, { encoding: "utf8" });
assert.equal(fsyncFaultBuild.status, 0, fsyncFaultBuild.stderr);
const fsyncFaultEnvironment = process.platform === "darwin"
  ? { DYLD_FORCE_FLAT_NAMESPACE: "1", DYLD_INSERT_LIBRARIES: fsyncFaultLibrary }
  : { LD_PRELOAD: fsyncFaultLibrary };
const dirtyTarget = write("dirty-after-write.img", stock);
const dirty = run([dirtyTarget, newKernelPath, ...gates()], fsyncFaultEnvironment);
assert.equal(dirty.status, 3, dirty.stderr);
assert.match(dirty.stderr, /fsync after kernel/);
assert.match(dirty.stderr, /RECOVERY REQUIRED: target may be partially modified/);
const dirtyBytes = fs.readFileSync(dirtyTarget);
assert.notDeepEqual(dirtyBytes, stock, "fault must occur after bytes were changed");
assert.equal(dirtyBytes.readUInt32LE(8), stockKernel.length, "header write must not have begun");

// Only regular files and Linux block devices are valid targets. A character
// device must fail before any size or identity check can authorize it.
const nonRegular = run(["/dev/null", newKernelPath, ...gates()]);
assert.equal(nonRegular.status, 1, nonRegular.stderr);
assert.match(nonRegular.stderr, /measure target/);
assert.doesNotMatch(nonRegular.stderr, /RECOVERY REQUIRED/);

// Every mismatch is refused before the first write.
refused(
  write("wrong-size.img", stock),
  newKernelPath,
  replaceGate(gates(), "--expect-target-size", String(stock.length + 1)),
  /target size mismatch/,
);
refused(
  write("wrong-current-full.img", stock),
  newKernelPath,
  replaceGate(gates(), "--expect-current-sha256", "00".repeat(32)),
  /current full sha256 mismatch/,
);
refused(
  write("wrong-current-kernel.img", stock),
  newKernelPath,
  replaceGate(gates(), "--expect-current-kernel-sha256", "11".repeat(32)),
  /current kernel sha256 mismatch/,
);
refused(
  write("wrong-image.img", stock),
  newKernelPath,
  replaceGate(gates(), "--expect-image-sha256", "22".repeat(32)),
  /image sha256 mismatch/,
);
refused(
  write("wrong-output.img", stock),
  newKernelPath,
  replaceGate(gates(), "--expect-output-sha256", "33".repeat(32)),
  /output full sha256 mismatch before write/,
);

// A matching stock payload cannot conceal a changed byte in the preserved
// tail: the full current-input gate must reject it.
const alteredStockTail = Buffer.from(stock);
alteredStockTail[alteredStockTail.length - 1] ^= 0xff;
refused(
  write("altered-stock-tail.img", alteredStockTail),
  newKernelPath,
  gates(),
  /current full sha256 mismatch/,
);

// Nor may a matching installed payload conceal a changed preserved tail.
// Payload-only idempotence was the dangerous false positive this contract
// closes.
const alteredInstalledTail = Buffer.from(expected);
alteredInstalledTail[alteredInstalledTail.length - 1] ^= 0xff;
refused(
  write("altered-installed-tail.img", alteredInstalledTail),
  newKernelPath,
  gates({ target: expected, currentKernel: newKernel }),
  /installed payload matches but output full sha256 mismatch/,
);

// Conversely, a claimed full output identity cannot hide the wrong payload.
refused(
  write("output-identity-wrong-payload.img", stock),
  newKernelPath,
  gates({ output: stock }),
  /expected output full sha256 matches but installed payload does not match image/,
);

const bigKernel = patternBytes(2 * PAGE + 1, 0x4004);
const bigPath = write("big.lz4", bigKernel);
refused(
  write("oversized.img", stock),
  bigPath,
  gates({ image: bigKernel, output: Buffer.alloc(stock.length, 0xa5) }),
  /larger than the stock kernel region/,
);

// Header and bounds refusals retain the same payload and full-input gates, so
// each malformed image reaches the structural check without weakening them.
function malformedGates(targetImage) {
  return gates({ target: targetImage, output: Buffer.alloc(targetImage.length, 0x5a) });
}

const badMagic = makeBootImage({ kernel: stockKernel, magic: "ANDROIDX" });
refused(write("magic.img", badMagic), newKernelPath, malformedGates(badMagic), /magic/);
const badVersion = makeBootImage({ kernel: stockKernel, headerVersion: 2 });
refused(write("v2.img", badVersion), newKernelPath, malformedGates(badVersion), /header version/);
const withRamdisk = makeBootImage({ kernel: stockKernel, ramdiskSize: 100 });
refused(write("rd.img", withRamdisk), newKernelPath, malformedGates(withRamdisk), /ramdisk/);
const badHeaderSize = makeBootImage({ kernel: stockKernel });
badHeaderSize.writeUInt32LE(1580, 20);
refused(write("hs.img", badHeaderSize), newKernelPath, malformedGates(badHeaderSize), /header size/);
const zeroKernel = makeBootImage({ kernel: stockKernel });
zeroKernel.writeUInt32LE(0, 8);
refused(write("zero.img", zeroKernel), newKernelPath, malformedGates(zeroKernel), /kernel_size is zero/);
const pastEnd = makeBootImage({ kernel: stockKernel });
pastEnd.writeUInt32LE(0xffffffff, 8);
refused(write("past.img", pastEnd), newKernelPath, malformedGates(pastEnd), /past the end/);
const short = stock.subarray(0, 100);
refused(write("short.img", short), newKernelPath, malformedGates(short), /shorter/);
refused(
  write("empty-image-target.img", stock),
  write("empty.lz4", Buffer.alloc(0)),
  gates({ image: Buffer.alloc(0), output: Buffer.alloc(stock.length, 0x6b) }),
  /empty/,
);
assert.equal(
  run(["--print-kernel-sha256", path.join(temporaryRoot, "past.img")]).status,
  1,
  "inspection refuses a kernel_size past the end",
);

// A kernel exactly filling the stock region is accepted.
const exactKernel = patternBytes(2 * PAGE, 0x3003);
const exactPath = write("exact.lz4", exactKernel);
const exactTarget = write("exact-target.img", stock);
const exactExpected = expectedSwap(stock, exactKernel);
const exact = run([
  exactTarget,
  exactPath,
  ...gates({ image: exactKernel, output: exactExpected }),
]);
assert.equal(exact.status, 0, exact.stderr);
assert.deepEqual(fs.readFileSync(exactTarget), exactExpected);

// A partition-sized target keeps a long tail byte-for-byte and includes that
// tail in both full-partition identity gates.
const longTail = patternBytes(10 * PAGE, 0x6006);
const longStock = makeBootImage({ kernel: stockKernel, tail: longTail });
const longExpected = expectedSwap(longStock, newKernel);
const partition = write("partition.img", longStock);
const onPartition = run([
  partition,
  newKernelPath,
  ...gates({ target: longStock, output: longExpected }),
]);
assert.equal(onPartition.status, 0, onPartition.stderr);
assert.deepEqual(fs.readFileSync(partition), longExpected);

// Linux regular files do not use O_DIRECT for verification. An otherwise
// valid target whose last read is not sector aligned must still succeed.
const unalignedTail = patternBytes(PAGE + 1, 0x7007);
const unalignedStock = makeBootImage({ kernel: stockKernel, tail: unalignedTail });
const unalignedExpected = expectedSwap(unalignedStock, newKernel);
assert.notEqual(unalignedStock.length % PAGE, 0);
const unalignedTarget = write("unaligned-regular.img", unalignedStock);
const unaligned = run([
  unalignedTarget,
  newKernelPath,
  ...gates({ target: unalignedStock, output: unalignedExpected }),
]);
assert.equal(unaligned.status, 0, unaligned.stderr);
assert.deepEqual(fs.readFileSync(unalignedTarget), unalignedExpected);

// All five expectations are mandatory. Invalid sizes and digests are usage
// errors, and inspection mode remains separate from swap mode.
assert.equal(run([]).status, 2);
assert.equal(run([target, newKernelPath]).status, 2);
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
  assert.equal(run([target, newKernelPath, ...expectationArgs]).status, 2, `${option} must be mandatory`);
}
assert.equal(run([target, newKernelPath, ...replaceGate(gates(), "--expect-target-size", "0")]).status, 2);
assert.equal(run([target, newKernelPath, ...replaceGate(gates(), "--expect-target-size", "+16384")]).status, 2);
assert.equal(run([target, newKernelPath, ...replaceGate(gates(), "--expect-current-sha256", "not-a-sha256")]).status, 2);
assert.equal(run(["--print-kernel-sha256", stockPath, ...gates()]).status, 2);

fs.rmSync(temporaryRoot, { recursive: true, force: true });
