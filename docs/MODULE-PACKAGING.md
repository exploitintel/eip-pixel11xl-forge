# Installable qualification module packaging

The current packaging path produces a deterministic, executable
KernelSU-Next qualification installer for module version `0.1.0-rc.3`. It no
longer produces the old development-abort ZIP. It does not publish a release,
update feed, or signature, and running the packaging workflow performs no
phone, daemon, boot-partition, or network-policy action.

The supported package target is exactly:

```text
device: Pixel 11 Pro XL (kodiak)
Android build: CD1A.260714.001.A9
KernelSU-Next: 3.3.0
KernelSU runtime mode: lkm
network: Wi-Fi through wlan0 only
```

Cellular networking and transport switching remain deferred.

## Native tools

`tools/aarch64-musl-toolchain.json` pins one Bootlin stable 2025.08-1 SDK by
HTTPS URL, byte size, SHA-256, source tag and commit, component versions, and
tool paths. The SDK runs on x86_64 Linux and targets static AArch64 musl.
`tools/build-module-tools.sh` verifies the complete SDK before extracting it,
checks its compiler, sysroot, and readelf identities, and builds:

- `patch-engine`;
- `swap-boot-kernel`;
- `privns`; and
- `route-policy`.

The build is create-only and transactional. Every output must be ELF64
AArch64, have no `PT_INTERP`, and have no `DT_NEEDED`. The workflow performs
two clean builds and requires byte-identical outputs. The builder retains the
caller's utility `PATH`, but clears ambient compiler header, subprogram,
library, host-loader, and archive-option injection variables before inspecting,
extracting, or running the pinned SDK.

On x86_64 Linux with the exact SDK archive already present:

```sh
tools/build-module-tools.sh \
  --toolchain-archive /path/to/aarch64--musl--stable-2025.08-1.tar.xz \
  --out /new/module-tools
```

The SDK is a build input, not a module or release asset. Its musl notice is
byte-bound in the provenance record and tracked at
`tools/licenses/musl-COPYRIGHT`.

## Deterministic installable ZIP

`tools/assemble-module.py` combines the four prebuilt static helpers with the
tracked module source, generic Android runtime scripts, exact engine and build
records, toolchain provenance, and license notices. The caller must pass
`--installable`; an ambiguous command is refused.

The assembler rejects:

- symlinks, special files, unsafe names, and case-colliding member names;
- wrong-architecture or dynamically linked native helpers;
- a development-only module version or a `customize.sh` that does not invoke
  the installer subprocess;
- any `updateJson` property;
- unexpected module-source files;
- malformed engine or build records; and
- Docker inputs that differ from the exact eight recorded 29.8.0 binaries.

The archive uses byte-sorted entries, a fixed 1980 ZIP timestamp, normalized
0644 and 0755 modes, no directory or symlink members, and an exact internal
`MODULE-MANIFEST.json`. Two assemblies from byte-identical inputs must produce
the same ZIP bytes.

```sh
python3 tools/assemble-module.py \
  --installable \
  --patch-engine /new/module-tools/patch-engine \
  --swap-boot-kernel /new/module-tools/swap-boot-kernel \
  --privns /new/module-tools/privns \
  --route-policy /new/module-tools/route-policy \
  --toolchain-provenance tools/aarch64-musl-toolchain.json \
  --musl-license tools/licenses/musl-COPYRIGHT \
  --output /new/eip-pixel11xl-forge-0.1.0-rc.3.zip
```

## Package contents

The ZIP contains:

- `module.prop`, `customize.sh`, `service.sh`, `boot-completed.sh`,
  `action.sh`, and `uninstall.sh`;
- `hostctl`, `kernelctl`, the installer orchestrator, preparation helpers,
  and the release transaction helper;
- the generic `dockerd.sh` and `buildkit-runc.sh` launchers;
- static AArch64 `patch-engine`, `swap-boot-kernel`, `privns`, and
  `route-policy` helpers;
- exact `engine.json` and `builds.json` records;
- generated `installer-inputs.tsv` and `release-manifest.tsv` files;
- toolchain provenance and first-party and musl license notices; and
- `MODULE-MANIFEST.json`, which records every other packaged member's identity
  and mode and declares `installable: true`.

The ZIP deliberately contains no Docker Engine binary, kernel image, Google
firmware, boot image, credential, private Forge hook, release signature, or
update feed. Keeping Docker and the build-specific kernel outside the module
keeps the installer small and makes those large inputs independently
replaceable only when their exact records change.

An external root provisioner may activate one generic workload profile after
installation. The descriptor never enters the ZIP or immutable public release:
it selects only the fixed
`/data/docker/workload-profiles/PROFILE_ID/hook` path and binds that hook's
exact size and SHA-256. `hostctl` verifies the descriptor, fixed path, root
ownership, restrictive modes, and hook identity before invoking either of its
two fixed lifecycle phases under the public host lock. See
[MODULE-LIFECYCLE.md](MODULE-LIFECYCLE.md#optional-workload-profile).

The packaged uninstall hook uses the exact packaged kernel controller,
preflight, boot-swap helper, and installer inputs to publish a standalone
versioned recovery kit under `/data/docker/recovery/0.1.0-rc.3` before
KernelSU removes the module directory. The kit's generated
`recovery-manifest.tsv` binds its own contents, modes, and exact KernelSU-Next
3.3.0 version code and LKM environment. It is persistent host recovery state,
not another member embedded in the ZIP.

## Generated contracts

`release-manifest.tsv` is a canonical 13-member runtime manifest for the eight
pinned Docker outputs and exact packaged bytes of `buildkit-runc.sh`,
`dockerd.sh`, `hostctl`, `privns`, and `route-policy`. The release transaction
verifies every source and staged member by name, type, mode, size, and SHA-256
before an immutable version is published or selected.

`installer-inputs.tsv` is a strict ASCII, LF-only contract generated from the
exact module, engine, and eligible build records. It binds:

- module version and version code;
- the one accepted Docker HTTPS origin and archive identity;
- all patch rules and per-binary input and output identities;
- exact device, fingerprint, Android, security-patch, and kernel-release
  identity;
- the tested KernelSU-Next version and `lkm` runtime mode;
- the candidate kernel filename and identity; and
- accepted paired kernel-payload and full boot-partition states.

Its tab-separated row shapes are:

```text
INSTALLER_INPUTS_VERSION=1
MODULE VERSION VERSION_CODE
ENGINE VERSION TARBALL_BASENAME TARBALL_SIZE TARBALL_SHA256 HTTPS_URL
RULE INDEX FROM TO
BINARY NAME SIZE INPUT_SHA256 OUTPUT_SHA256 PATCH_FLAG COUNT_0 COUNT_1 COUNT_2
BUILD BUILD_ID CODENAME FINGERPRINT ANDROID_VERSION SECURITY_PATCH KERNEL_RELEASE PARTITION_SIZE PAGE_SIZE HEADER_VERSION HEADER_SIZE RAMDISK_SIZE CANDIDATE_NAME
KSU BUILD_ID lkm TESTED_VERSION
BOOT_STATE BUILD_ID ROLE PAYLOAD_SIZE PAYLOAD_SHA256 PARTITION_SIZE PARTITION_SHA256
```

Spaces above show fields for readability; package rows contain one literal tab
between fields. The file has one final LF and no other control or non-ASCII
bytes.

Successful preflight produces exactly:

```text
INSTALL_PREFLIGHT_VERSION=1
module_version=0.1.0-rc.3
build_id=CD1A.260714.001.A9
slot_suffix=_a|_b
boot_state=ROLE
installer_inputs_sha256=SHA256
```

The active suffix is accepted only when `getprop ro.boot.slot_suffix` is
exactly `_a` or `_b` and agrees with exactly one canonical
`androidboot.slot_suffix = "_a|_b"` record in `/proc/bootconfig`. A missing,
malformed, duplicate, or mismatched bootconfig record refuses preflight. The
contract does not depend on an optional Android `bootctl` executable.

The manager environment establishes the exact v3.3.0 LKM compatibility
contract. The target remains KernelSU-Next; the environment variables alone
cannot distinguish it from a manager that deliberately imitates the same
contract.

The generated manifests are deterministic integrity and selection metadata.
They authenticate inputs relative to the ZIP bytes already in hand, but they
do not authenticate delivery of that ZIP. A future public release still needs
the offline-signed `SHA256SUMS` contract.

## External installation inputs

The exact kernel and Docker archive are intentionally not in the ZIP. For the
qualification path, place both at their exact sideload names before selecting
the ZIP in KernelSU-Next Manager:

```sh
adb push docker-29.8.0.tgz /data/local/tmp/docker-29.8.0.tgz
adb push Image-CD1A.260714.001.A9.lz4 \
  /data/local/tmp/Image-CD1A.260714.001.A9.lz4
```

Input precedence is fail-closed:

1. If `/data/docker/downloads/NAME` exists, it must be a regular file with the
   exact recorded size and hash or installation stops.
2. Otherwise, if `/data/local/tmp/NAME` exists, it must match exactly or
   installation stops.
3. Docker Engine alone may use its pinned HTTPS URL through a qualified
   `/system/bin/curl` when neither local path exists.
4. The kernel has no network fallback and must exist in one of the first two
   locations.

An invalid higher-priority file is never skipped in favor of another copy.
Preparation occurs in KernelSU's private installer temporary directory. Only
after all cross-bound hashes, free-space checks, payloads, and release state
pass does one locked transaction stage the kernel and publish the host release.
The installer does not allocate storage, start Docker, write a boot partition,
or reboot.

## Workflow and qualification boundary

`.github/workflows/module.yml` is least-privilege and release-free. It:

1. runs the complete public host check;
2. verifies the pinned toolchain and Docker archives;
3. builds the four static tools twice and proves byte identity;
4. proves the C and Python engine patchers agree for all eight binaries;
5. assembles the installable ZIP twice with `--installable` and proves byte
   identity; and
6. uploads the commit-qualified ZIP, install guide, toolchain provenance, and
   `SHA256SUMS` for 14 days.

The workflow does not install a module, build or fetch the kernel candidate,
touch a phone, create a GitHub Release, sign an asset, or publish an update
feed.

The complete public host check, two byte-identical deterministic ZIP
assemblies, and exact archive inspection pass locally. The exact static
AArch64 tools have also been built twice with byte-identical outputs and have
executed through their packaged command paths in an isolated Linux/AArch64
environment. Completion still requires explicit qualification on the exact
Pixel of KernelSU BusyBox and Manager installation, SELinux behavior, native
helper execution, host lifecycle, active-slot boot write and restore, reboot,
Wi-Fi behavior, and uninstall. See [INSTALL.md](INSTALL.md).
