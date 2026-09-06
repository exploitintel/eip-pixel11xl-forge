# Byte-preserving boot kernel swap

Pixel 11 Pro XL build `CD1A.260714.001.A9` uses an Android boot header v4 image
with a page size of 4096 bytes and no ramdisk in `boot`. The reviewed swap tool
changes only two regions:

1. bytes 8 through 11 of the header become the little-endian size of the new
   compressed kernel;
2. the original page-rounded kernel region is replaced by the new kernel plus
   zero padding.

Everything after that existing region stays at its original absolute offset.
The tools refuse an invalid header, a non-v4 image, a non-empty ramdisk, a
truncated file, or a new kernel that does not fit.

The Python reference creates a new output and refuses to overwrite an existing
path. A swap requires all five independent expectations:

- `--expect-target-size DECIMAL` matches the complete input file size;
- `--expect-current-sha256 HEX` matches the complete input file;
- `--expect-current-kernel-sha256 HEX` matches the current payload named by the
  header's `kernel_size`;
- `--expect-image-sha256 HEX` matches the replacement `Image.lz4`;
- `--expect-output-sha256 HEX` matches the complete deterministic output.

All five checks complete before the tool creates the output. In particular, a
matching payload hash cannot authorize an input whose preserved tail differs.
The output directory must already exist, be controlled by the operator, and
must not be renamed or modified by another process during publication. The
tool pins that directory with one open descriptor, writes and fsyncs a random
owner-only temporary file there, then publishes it with a no-replace hard link.
`--print-kernel-sha256 BOOT_IMG` remains a read-only inspection command and
takes no swap arguments.

The matching C interface uses the same five mandatory expectations for an
in-place regular file or Linux block-device target and rejects other file
types. It verifies the target size, complete current target, current payload,
and replacement image before the first write. It then writes and fsyncs the
padded kernel region before writing and fsyncing the header. For readback it
requests the platform's uncached-I/O mechanism; on Linux block devices it fails
if neither direct I/O nor an explicit block-cache flush is available, while a
regular-file host fallback may be cached. It requires the complete readback
output hash before reporting success.

The caller must hold the exclusive lifecycle and target-writer lock throughout
the in-place C invocation. Revalidation on the writable descriptor narrows the
race before the first write but cannot exclude a separate process writing the
same block device. Exit status 1 means no write was attempted, while status 3
means a write may have begun. Every status-3 path prints `RECOVERY REQUIRED`;
treat the target as partial, do not boot it, and restore the exact expected
partition before retrying.

These host and synthetic-fixture contracts do not claim that the C binary or
any generated image has been qualified on a phone.

This repository never supplies a boot image. Use only a matching image obtained
by the device owner from Google's factory image. Preserve an off-device stock
copy and prove the exact slot-qualified fastboot recovery command before any
future on-device write.

Automated tests use synthetic boot images only. Running the tool does not imply
that a generated image is safe to flash.
