import crypto from "node:crypto";

export const PAGE = 4096;
export const HEADER_SIZE = 1584;

// Deterministic pseudo-random bytes so fixtures are stable across runs.
export function patternBytes(length, seed) {
  const out = Buffer.alloc(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    out[index] = (state >>> 16) & 0xff;
  }
  return out;
}

export function pageAlign(size) {
  return Math.ceil(size / PAGE) * PAGE;
}

// Boot image header v3/v4 layout (all little-endian u32 unless noted):
//   0   magic "ANDROID!" (8 bytes)
//   8   kernel_size
//   12  ramdisk_size
//   16  os_version
//   20  header_size
//   24  reserved[4]
//   40  header_version
//   44  cmdline (1536 bytes)
//   1580 signature_size (v4 only)
export function makeBootImage({
  kernel,
  tail = patternBytes(PAGE, 0x7a11),
  headerVersion = 4,
  ramdiskSize = 0,
  magic = "ANDROID!",
}) {
  const header = Buffer.alloc(PAGE);
  header.write(magic, 0, "latin1");
  header.writeUInt32LE(kernel.length, 8);
  header.writeUInt32LE(ramdiskSize, 12);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(HEADER_SIZE, 20);
  header.writeUInt32LE(headerVersion, 40);
  const kernelRegion = Buffer.alloc(pageAlign(kernel.length));
  kernel.copy(kernelRegion);
  return Buffer.concat([header, kernelRegion, tail]);
}

export function readKernelSize(image) {
  return image.readUInt32LE(8);
}

export function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// Reference result for swapping `newKernel` into `stock`, mirroring the
// procedure in docs/BOOT-SWAP.md: the kernel region keeps the stock kernel's
// page-rounded size, the new kernel is zero padded inside it, only bytes 8..12
// of the header change, and everything after the region keeps its offset.
export function expectedSwap(stock, newKernel) {
  const oldPad = pageAlign(readKernelSize(stock));
  const out = Buffer.from(stock);
  out.fill(0, PAGE, PAGE + oldPad);
  newKernel.copy(out, PAGE);
  out.writeUInt32LE(newKernel.length, 8);
  return out;
}
