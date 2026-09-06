# eip-pixel11xl-forge

## Supported target

| Device | Android build | Security patch | Kernel source | KernelSU-Next | Network | Package status |
| --- | --- | --- | --- | --- | --- | --- |
| Pixel 11 Pro XL (`kodiak`) | `CD1A.260714.001.A9` | 2026-08-05 | `5c5f2fea42dd4cc5ae1002945d86e305c09d3262` | 3.3.0 in LKM mode | Wi-Fi only | `0.1.0-rc.1` installable qualification source |

This repository packages the public host layer needed to run Docker Engine on
one exact Pixel 11 Pro XL build. It contains reproducible kernel inputs,
generic Android runtime helpers, an installable KernelSU-Next module source,
and host-side verification tools. It does not contain Forge application code,
credentials, device state, Google firmware, a boot image, Docker Engine
binaries, or a kernel binary.

The complete public host check passes for the current source. The four static
AArch64 tools have been built twice locally with byte-identical outputs and
their packaged command paths have executed in an isolated Linux/AArch64
environment. Two deterministic installer assemblies and exact archive
inspection also pass locally. The tools have not run on the phone, and
KernelSU-Next manager installation, the active-slot kernel cycle, live Wi-Fi
lifecycle, and recovery cycle remain device-qualification gates. There is no
public release, release signature, or update feed yet. The module intentionally
has no `updateJson`.

## What the RC installer does

The `0.1.0-rc.1` qualification package is an executable installer, not the old
development-abort ZIP. Assembly requires an explicit `--installable` flag.
The ZIP carries the module scripts, exact input records, four static AArch64
helpers, provenance, notices, and internal integrity manifests. It does not
embed the much larger Docker archive or the build-specific kernel candidate.

Before installing through KernelSU-Next Manager, supply these exact filenames:

```text
/data/local/tmp/docker-29.8.0.tgz
/data/local/tmp/Image-CD1A.260714.001.A9.lz4
```

An already verified copy in `/data/docker/downloads/` can be used instead.
Docker Engine may also be fetched from its pinned HTTPS origin when the device
has a qualified `/system/bin/curl`; the kernel candidate has no network
fallback. Every selected input is checked against its package-recorded size
and SHA-256 identity.

During manager installation the module:

- requires Pixel 11 Pro XL `kodiak`, build `CD1A.260714.001.A9`, and
  KernelSU-Next 3.3.0 in `lkm` runtime mode;
- proves the active slot using both Android slot state and `bootctl`;
- verifies the active boot partition's complete hash and embedded kernel
  payload hash against an accepted state;
- prepares and verifies the eight Docker 29.8.0 runtime binaries in the
  manager's temporary directory;
- stages the exact kernel candidate without writing a boot partition;
- publishes an immutable host release and atomically selects it; and
- installs a version 2 host configuration with autostart off on a clean host.

Installation does not allocate the Docker data disk, start Docker, change the
active boot partition, or reboot the phone. An existing root-owned regular
host configuration with mode `0600` and its autostart choice are preserved on
reinstall; hostctl validates its contents before any lifecycle mutation.

Read [docs/INSTALL.md](docs/INSTALL.md) before attempting qualification.

## v0.1 boundary

- Only the exact device and Android build listed above are accepted. Similar
  Pixels and later monthly builds fail closed.
- KernelSU-Next 3.3.0 in LKM mode is the qualified manager target.
- Container egress and intended LAN access are scoped to `wlan0`.
- Cellular networking, automatic transport switching, and cellular ingress
  are deferred. Containers are expected to lose network access when Wi-Fi is
  unavailable.
- No background service silently creates storage or enables autostart.
- Android monthly updates require a new exact build record and a complete new
  kernel, boot, Wi-Fi, and rollback qualification.

## Operator control

KernelSU-Next Manager exposes the module Action. It first prints the host and
kernel status, then uses Volume Down to cycle and Volume Up to select one
operation:

- start or conservatively stop the Forge host;
- initialize an explicit 8, 16, or 32 GiB sparse ext4 Docker disk;
- enable or disable autostart;
- install the exact staged kernel to the active slot; or
- restore the exact authenticated active-slot backup.

Start obtains a new strict kernel status immediately before it invokes
`hostctl`; a failed, malformed, or recovery-attention result cannot start the
host even if the status printed when the Action opened was healthy.

Storage and every boot-partition write require confirmation. The kernel
controller requires at least 50 percent battery, makes and verifies a durable
active-slot backup before installation, verifies the partition again after a
write, never selects another slot, and never reboots automatically. Status 3
means recovery attention: do not reboot and follow the printed active-slot
fastboot guidance.

For shell operation, the root-only lifecycle interface is:

```text
/data/docker/bin/hostctl status
/data/docker/bin/hostctl start
/data/docker/bin/hostctl stop
/data/docker/bin/hostctl autostart on|off
/data/docker/bin/hostctl disk-init [--size-bytes BYTES]
```

`hostctl start` is also the Wi-Fi reconnect repair operation. Calling it again
after `wlan0` regains an IPv4 address rechecks the disk and mount, bridge-pool
overlap, Wi-Fi policy rules, IPv4 forwarding, loopback Docker API firewall,
and exact daemon identity before returning `result=running`.

KernelSU cannot cancel module removal based on an uninstall-hook exit status.
The hook first publishes a standalone versioned recovery kit under
`/data/docker/recovery/0.1.0-rc.1`, then performs only cleanup it can prove
safe. A public or unknown kernel state or a failed daemon stop preserves the
active host link, releases, data, kernel, backups, and recovery kit while the
manager still removes the module directory. The kit retains exact kernel
status and active-slot restore commands after removal, including the explicit
KernelSU-Next 3.3.0 LKM environment required outside a manager hook.

See [docs/MODULE-LIFECYCLE.md](docs/MODULE-LIFECYCLE.md) for the complete
configuration, status, boot-hook, kernel, and uninstall contracts.

## Repository contents

- `kernel/` preserves exact source identity, configs, patches, the public D4
  reproducibility-key fixture, the pinned builder recipe, and candidate build
  tools.
- `tools/` contains the deterministic installer assembler and reference boot
  and Docker Engine patchers.
- `android/` contains the generic Docker launcher and runtime helpers.
- `module/` contains the installable qualification module source.
- `tests/` verifies the public contracts without privileged phone mutation.

The D4 module-signing keypair is intentionally public and reproducibility-only.
It is not a secret, an artifact signature, or a release trust root. Any runtime
or config that enforces kernel module signatures invalidates this build design.

## Kernel source and build

The full upstream commit is
`5c5f2fea42dd4cc5ae1002945d86e305c09d3262`; its Git tree is
`ea11a8a82242341af2f1ea4ed88850996fc5d855`. The build accepts only the exact
normalized source archive and hashes recorded in `kernel/builds.json`.

Google's Gitiles archive endpoint can regenerate tarballs whose container bytes
differ even when file contents do not. A candidate source archive therefore
pins the exact attached archive bytes, while the verified Git commit, tree, and
normalized file manifest establish content identity.

```sh
kernel/build.sh \
  --build-id CD1A.260714.001.A9 \
  --source-archive /path/to/kernel-common-5c5f2fea42dd4cc5ae1002945d86e305c09d3262.tar.gz \
  --out /new/empty/output-directory
```

To reconstruct the normalized archive from a regenerated Gitiles tarball:

```sh
kernel/build-builder.sh --output /new/buildenv.oci.tar
kernel/normalize-source.sh \
  --build-id CD1A.260714.001.A9 \
  --raw-archive /path/to/googlesource-download.tar.gz \
  --builder-oci /new/buildenv.oci.tar \
  --out /new/normalized-source
```

See [docs/REPRODUCIBILITY.md](docs/REPRODUCIBILITY.md).

## Boot and engine tools

`tools/swap-boot-kernel.py` creates a new byte-preserving boot-image output and
refuses to overwrite an existing path. `tools/swap-boot-kernel.c` is the
separately tested in-place interface packaged for device qualification. Both
bind the complete partition identity, current payload, replacement payload,
and expected output. Read [docs/BOOT-SWAP.md](docs/BOOT-SWAP.md).

`tools/patch-engine.py` verifies the exact Docker static archive recorded in
`tools/engine.json`, applies reviewed same-length substitutions, and verifies
each output. `tools/patch-engine.c` applies the same rules to one fully
identified extracted member. See [docs/ENGINE-PATCH.md](docs/ENGINE-PATCH.md).

`tools/route-policy.c` is the narrow static AArch64 route-netlink helper used
only during host start. Android root cannot directly create the two required
policy rules on this target, so `hostctl` imports the packaged helper into a
temporary local scratch image and runs it through the already authenticated
daemon with host networking. The image is content-addressed, never pulled,
and removed after exact post-verification.

Docker's static install has no automatic security-update path. Every Docker
Engine release and relevant security advisory requires a new review and pinned
archive record independently of Android's monthly build cycle.

## Recovery prerequisite

Before any module qualification or kernel write, keep the matching factory
`boot.img` off-device. Prove that a known-good cable, ADB, and fastboot all see
the phone, record the active slot, keep the battery at 50 percent or higher,
and rehearse the exact active-slot recovery command:

```text
fastboot flash boot_a /off-device/path/to/CD1A.260714.001.A9/boot.img
fastboot flash boot_b /off-device/path/to/CD1A.260714.001.A9/boot.img
```

Use only the line matching the recorded active suffix. Never guess a slot or
use an image from another build. Unlocking the bootloader erases device data
the first time and weakens the stock security model.

## Accepted risks and known limits

- One patch deliberately allows symbol CRC mismatches so stock vendor modules
  can load. The bypass is visible in dmesg and weakens a compatibility check.
- Bridge netfilter, IPv6 NAT, the cgroup PIDs controller, and the cgroup device
  controller remain disabled because enabling them changed vendor-module data
  layouts in the target build. Docker features requiring them are limited.
- The overlayfs patch relaxes a dentry-operation refusal for Android's
  casefolded F2FS path. Docker data remains on explicitly created ext4 storage.
- Wi-Fi is the only v0.1 network claim. Cellular behavior is neither configured
  nor qualified by this project.
- The complete host-side synthetic suite and isolated Linux/AArch64 helper
  execution pass. These checks do not substitute for KernelSU BusyBox, Android
  SELinux, execution on the exact phone, manager installation, live networking,
  boot, or recovery qualification.

## Release verification contract

A future public release will require an offline minisign signature for
release integrity and GitHub artifact attestations for online provenance. The
offline public key and signed release assets do not exist yet. The current
workflow uploads only a short-lived, commit-qualified qualification artifact
and does not publish a GitHub Release or update feed.

See [docs/release/POLICY.md](docs/release/POLICY.md) for the future release
immutability, versioning, key-rotation, and publication rules.

## License

First-party tooling is MIT licensed. Linux kernel materials retain upstream
licenses under `kernel/COPYING` and `kernel/LICENSES/`. See `NOTICE.md`.
