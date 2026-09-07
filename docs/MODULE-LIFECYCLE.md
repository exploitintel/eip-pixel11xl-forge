# Qualification module lifecycle

The tracked `module/` tree is the installable `0.1.0-rc.2` KernelSU-Next
qualification source. It supports only Pixel 11 Pro XL `kodiak` build
`CD1A.260714.001.A9`, KernelSU-Next 3.3.0 in LKM mode, and Wi-Fi through
`wlan0`. Cellular and automatic transport switching are deferred.

The complete public host check and two byte-identical ZIP assemblies pass on
the development host. The exact static AArch64 tools have been built twice
with byte-identical outputs and have executed in an isolated Linux/AArch64
environment, but have not executed on the phone. KernelSU-Next Manager,
Android SELinux, live Wi-Fi, active-slot kernel install and restore, reboot,
and uninstall still require qualification on the exact phone. No public
release or signature exists yet.

## Manager installation

KernelSU sources `customize.sh` inside the manager installer. The hook keeps
mutation in the separate `install-host` subprocess and restores executable
modes that the manager's extraction can normalize.

The module ZIP does not contain Docker Engine or a kernel candidate. Before
manager installation, provide the exact `docker-29.8.0.tgz` and
`Image-CD1A.260714.001.A9.lz4` inputs in `/data/local/tmp`, or provide already
verified copies with those names in `/data/docker/downloads`. Docker Engine
alone may use the package-pinned HTTPS origin through a qualified
`/system/bin/curl`; the kernel has no download fallback.

`install-host` performs this ordered contract:

1. `install-preflight` verifies the complete package input grammar, exact
   device, fingerprint, Android version, security patch, kernel release,
   KernelSU version and LKM mode, exact active slot agreement between
   `getprop ro.boot.slot_suffix` and the unique
   `androidboot.slot_suffix = "_a|_b"` record in `/proc/bootconfig`, full
   active boot partition, and embedded kernel payload.
2. `release-transaction probe` establishes the current active release without
   mutation and refuses ambiguous host or daemon state.
3. Conservative free-space checks independently require room in KernelSU's
   temporary filesystem for the archive, two prepared-runtime copies, kernel
   candidate, and a 256 MiB reserve, and under `/data` for one runtime,
   candidate, and another 256 MiB reserve. `kernelctl` separately checks room
   for the active-slot boot backup immediately before a kernel write. Available
   KiB values are compared in BusyBox awk so Android mksh never multiplies a
   multi-GiB filesystem size in its signed shell arithmetic.
4. `prepare-engine` acquires the exact Docker archive, validates its complete
   inventory, patches the eight pinned members, and verifies the generated
   13-member release payload in KernelSU's temporary directory.
5. `prepare-kernel` copies and verifies the exact build candidate in that same
   temporary directory.
6. One locked `stage-install` transaction persists the candidate under
   `/data/docker/kernel/CD1A.260714.001.A9/Image.lz4`, installs the clean-host
   default config when no config exists, publishes the immutable runtime under
   `/data/docker/releases/0.1.0-rc.2`, and selects it through the relative
   `/data/docker/bin` symlink.

Hashes bind every handoff between these steps. An invalid higher-priority
cache or sideload file causes refusal instead of fallback. Retry logic accepts
only exact complete staged, recorded, or already-active states and refuses
malformed remnants.

Existing Docker root, run, and releases directories must be real, root-owned,
owner-executable, and not writable by group or other. Their three octal mode
digits are checked directly so Android `mksh` cannot reinterpret values such
as `0755` as decimal arithmetic.

Installation does not allocate `disk.img`, mount storage, start Docker,
install Wi-Fi policy, write the boot partition, or reboot. A clean installation
defaults to autostart off and a zero disk size. An existing root-owned regular
config with mode `0600` is preserved; hostctl independently validates its
content before a lifecycle mutation.

## Host configuration version 2

The canonical path is `/data/docker/config/host.conf`. A clean installer
creates it as a root-owned regular file with mode `0600` and these exact six
lines:

```text
HOST_CONFIG_VERSION=2
AUTOSTART=0
DISK_SIZE_BYTES=0
BRIDGE_POOL_CIDR=172.17.0.0/16
EXT4_FEATURES=^has_journal,^casefold
MOUNT_OPTIONS=noatime,nodev
```

`AUTOSTART` may be `0` or `1`. `DISK_SIZE_BYTES=0` means storage has not been
configured. A nonzero size must be decimal, 4096-byte aligned, and within the
bounded hostctl range. The Action uses exact 8, 16, and 32 GiB values. The
bridge pool must be an aligned private IPv4 CIDR between `/12` and `/24`; the
default and qualified value is `172.17.0.0/16`. The ext4 feature and mount
option lines are fixed for v0.1.

Disk-size bounds, alignment, and free-space calculations use the system awk.
This keeps supported multi-GiB byte values outside Android mksh's signed shell
arithmetic while preserving the exact decimal configuration value.

A missing file defaults to autostart off. The two-line version 1 form is read
as legacy. An autostart-only change can retain that legacy form, while an
explicit disk configuration upgrades it to version 2. A symlink, malformed
file, unexpected line, unsafe value, or unsafe existing installation config
fails closed.

## hostctl contract

The root-only interface is exactly:

```text
hostctl status
hostctl start
hostctl stop
hostctl autostart on|off
hostctl disk-init [--size-bytes BYTES]
```

The installed command is `/data/docker/bin/hostctl`. All mutations serialize
through `/data/docker/run/host-lifecycle.lock`. Only a precisely shaped stale
lock whose recorded PID no longer exists can be recovered.

Android exposes `/proc/mounts` as a symlink to `/proc/self/mounts`; hostctl
reads that standard kernel interface when checking the Docker data mount.

`status` is read-only and prints these 12 ordered fields:

```text
schema_version=2
daemon=STATE
containers=COUNT_OR_unknown
autostart=on|off|unknown
host_config=STATE
disk=STATE
mount=STATE
wifi_interface=STATE
bridge_routes=STATE
wifi_policy=STATE
ipv4_forwarding=STATE
api_firewall=STATE
```

The exact values describe independently observed state. A nonzero status means
at least one state is unsafe, ambiguous, invalid, or inconsistent with a
running daemon. It must not be treated as merely cosmetic.

### Disk initialization

`hostctl disk-init --size-bytes BYTES` records the explicit size, creates a
sparse `/data/docker/disk.img` without replacing an existing image, formats it
as the fixed ext4 profile, performs a read-only consistency check, associates
one loop device, and mounts it at `/data/docker/lib` with
`noatime,nodev`. It requires the requested image size plus a 1 GiB free-space
margin.

The command never silently selects a size, resizes an existing image, replaces
an existing path, hides a nonempty mountpoint, unmounts a filesystem, or repairs
a dirty filesystem. Repeating `disk-init` without a size converges an already
configured disk and mount. A different requested size is refused.

### Start and Wi-Fi repair

`hostctl start` requires an exact active immutable release and the reviewed
`dockerd.sh --runtime-only` marker. It also requires the PID, IPC, and user
namespace, SysV IPC, and POSIX message queue capabilities recorded in
`/proc/config.gz`. It then:

- validates version 2 storage configuration;
- requires `wlan0` with an IPv4 address and default route in table `wlan0`;
- refuses a bridge-pool overlap with any non-Docker route;
- creates or verifies the configured disk and mount;
- enables IPv4 forwarding;
- installs or verifies preference 9990 return-path routing to the main table
  and preference 9991 source routing from the bridge pool to table `wlan0`;
- retains the loopback TCP port 2375 rejection policy for status-schema
  compatibility, although the daemon no longer exposes a TCP API; and
- starts the exact managed daemon only when it is not already running.

The launcher binds the Docker API only to `/data/docker/run/docker.sock`.
Docker owns its normal bridge and container firewall rules.

The target's Android root context cannot issue these two route-netlink writes
directly. For a missing exact rule, `hostctl` starts the authenticated daemon,
builds a one-file scratch rootfs from the package-bound `route-policy` helper,
imports it locally, verifies the returned content-addressed image ID, and runs
it once with `--pull=never --rm --network host --privileged`. It then proves
the exact rule from host state and removes the exact temporary image and
staging directory. It never downloads an image, adopts a pre-existing tag, or
delegates any broader network policy.

`start` is idempotent and is also the supported Wi-Fi reconnect repair. If
Wi-Fi drops and later returns, invoke Start in the module Action or run
`/data/docker/bin/hostctl start` again. It rechecks and repairs the bounded host
policy before returning `result=running`; there is no continuous transport
monitor and no cellular fallback.

### Conservative stop

`hostctl stop` is idempotent for a proved stopped daemon. A running daemon is
stopped only when its executable, stable `argv[0]`, PID file, socket, API, and
container inventory all match the active release and the running-container
count is exactly zero. If an external workload profile is active, its
`pre-stop` phase runs before that inventory check. The daemon identity is
re-proved after the phase. The host then sends one `TERM`, waits for dockerd and
containerd to disappear, and removes only a proved-stale PID file.

It does not stop a foreign or ambiguous process, stop running containers,
force-kill, unmount storage, remove Wi-Fi policy, or delete data. Park or stop
containers through their owning workflow before stopping the host.

## Optional workload profile

The public module does not install, update, or remove an application workload.
It provides one optional integration seam so a separately provisioned,
root-owned workload can converge after Docker is ready and park its own
containers before the host's zero-container stop gate.

Activation grants the selected hook root execution during host lifecycle
operations. The descriptor hash detects substitution relative to the
root-provisioned descriptor; it does not authenticate the hook's publisher.
The external provisioner remains responsible for authenticating those bytes
before activation.

The activation descriptor has the fixed path
`/data/docker/config/workload-profile.conf`, is a root-owned regular file with
mode `0600`, and contains exactly these four ordered lines:

```text
WORKLOAD_PROFILE_VERSION=1
PROFILE_ID=PROFILE_ID
HOOK_SIZE=DECIMAL_BYTES
HOOK_SHA256=LOWERCASE_SHA256
```

`PROFILE_ID` is 1 through 64 lowercase ASCII characters, begins with an ASCII
letter or digit, and otherwise contains only letters, digits, dot, underscore,
or hyphen. The descriptor cannot provide a path or command. The selected hook
is always `/data/docker/workload-profiles/PROFILE_ID/hook`.

The config directory, workload-profile root, and selected profile directory
must be real root-owned directories with mode `0700`. The selected directory
contains exactly one member named `hook`. That member must be a real,
root-owned executable regular file with mode `0700`, and its size and SHA-256
must match the descriptor. A missing descriptor means no profile and preserves
the original host-only behavior. A dangling link, malformed descriptor,
unexpected selected-profile member, wrong owner or mode, unavailable identity
tool, or mismatched hook identity refuses the affected start or running-daemon
stop operation.

`hostctl` invokes the selected hook directly with exactly one argument and no
stdin. It clears the ambient environment and supplies only `PATH=/system/bin`,
the fixed Unix-socket `DOCKER_HOST`, and `WORKLOAD_PROFILE_ID`. The two allowed
arguments are:

- `post-start`, after the authenticated daemon and complete host policy are
  ready, on both initial and repeated Start; and
- `pre-stop`, before container inventory is measured for Stop.

Hook standard output is routed to hostctl's standard error so the hostctl
result channel stays machine-readable. Hooks must not print credentials or
other sensitive configuration.

Both phases run synchronously while `/data/docker/run/host-lifecycle.lock` is
held. Hostctl sends TERM after 240 seconds and, if the hook is still running,
KILL after a fixed 5-second grace. A timeout is a visible hook failure and never
permits the next lifecycle action. Hostctl captures the physical lock-directory
and owner-file identities before invoking a hook and re-proves those same
root-owned objects, exact owner record, and modes immediately afterward. A hook
cannot release or replace the lock and still reach a post-hook lifecycle action.
Provisioners must use the same lock when publishing or removing a profile,
publish the complete verified hook before atomically publishing the descriptor,
and remove the descriptor before retiring the hook. Hooks must be idempotent,
must not recursively call `hostctl`, and must not stop or replace the host
daemon. A nonzero `post-start` result makes Start fail visibly but leaves the
already-ready daemon running. A nonzero `pre-stop` result makes Stop fail
without inventory, `TERM`, or force cleanup. After either successful phase,
hostctl re-proves the same daemon identity; Stop then still requires an exact
zero running-container count. The
12-field status schema is unchanged and intentionally reports host state only;
workload-specific status belongs to the profile owner.

## Module Action

KernelSU-Next Manager's Action first prints `hostctl status` and
`kernelctl status`. Volume Down cycles the menu and Volume Up selects. The menu
times out without mutation after 15 seconds.

The Action provides:

1. Start Forge host.
2. Stop Forge host.
3. Initialize an 8 GiB Docker disk.
4. Initialize a 16 GiB Docker disk.
5. Initialize a 32 GiB Docker disk.
6. Enable autostart.
7. Disable autostart.
8. Install the package-authorized kernel.
9. Restore the package-authorized kernel backup.
10. Exit.

Stop, disk configuration, autostart changes, kernel installation, and kernel
restore require a second Volume Up confirmation. Volume Down or a 10-second
timeout cancels. Each invocation performs at most one selected operation.
Start obtains and strictly parses a fresh `kernelctl status` immediately before
calling `hostctl start`. A failed, malformed, changed, or recovery-attention
kernel result refuses Start rather than relying on the earlier display.

## Kernel lifecycle

`kernelctl` always reuses `install-preflight --runtime` to classify the exact
device, build, active slot, KernelSU environment, full boot partition, and
kernel payload. Its interface is:

```text
kernelctl status
kernelctl install INSTALL:BUILD_ID:_a|_b
kernelctl restore RESTORE:BUILD_ID:_a|_b
```

Status prints:

```text
KERNELCTL_VERSION=1
build_id=CD1A.260714.001.A9
slot_suffix=_a|_b
boot_state=ROLE
staged_image=missing|invalid|ready
```

The confirmation token is derived from a fresh strict status and binds the
verb, exact build, and current active suffix. Install and restore never address
the inactive slot, `init_boot`, `vendor_boot`, or another AVB partition.

Before install, the controller requires the exact staged image, at least 50
percent battery, enough space for the full active boot partition plus a 256 MiB
reserve, and a verified durable backup and metadata pair under
`/data/docker/boot-backup/`. If an interruption leaves the exact backup image
before its metadata, retry re-proves the image against the freshly selected
live source partition before publishing the metadata. Metadata without its
image, or any mismatched image, remains a hard refusal. The controller passes
the expected source partition, source payload, candidate payload, and final
partition identities to the in-place swap helper, then reclassifies the
result. Restore accepts exactly one authorized backup, verifies it again,
writes it to the same active slot, and reclassifies the result.

Neither operation reboots. Status 3 means a write may have left the partition
incomplete. Do not reboot. Use the printed command with the exact known-good
off-device boot image, for example:

```text
fastboot flash boot_a /off-device/path/to/CD1A.260714.001.A9/boot.img
fastboot flash boot_b /off-device/path/to/CD1A.260714.001.A9/boot.img
```

Use only the line matching the recorded active suffix.

## Boot and autostart

`service.sh` is intentionally an immediate no-op. After Android reports boot
complete, `boot-completed.sh` acts only when strict `hostctl status` reports
schema 2, a ready config, and autostart on. Before dispatching a background
start it also requires:

- the installed active-release hostctl;
- the module and kernel controller as safe regular executables;
- `/proc/config.gz` with the required PID, IPC, user namespace, SysV IPC, and
  POSIX message queue capabilities; and
- exact `kernelctl status` success for this build, active slot, and boot state.

A failed gate does not start Docker. Capability or identity refusals are
appended to `/data/docker/hostctl.log` when possible. A successful dispatch
runs the same convergent `hostctl start` path used by the Action, including the
Wi-Fi policy checks and an active profile's `post-start` phase. It never
guesses a different interface.

## Release transaction and retries

Host versions live as immutable direct children of `/data/docker/releases`.
`/data/docker/bin` is a relative symlink selecting one complete version. A
canonical manifest covers all 13 runtime members, including their exact names,
modes, sizes, and SHA-256 hashes.

The internal `release-transaction` supports a read-only probe, runtime-only
stage and activate, installer stage and activate, deactivation, and rollback.
It validates the complete predecessor before changing selection, refuses
dockerd, containerd, or any detected containerd shim during selection changes,
publishes a new release with an atomic same-parent rename, and replaces the
active symlink with another atomic same-parent rename. An activation record
binds the current and previous version for rollback.

An interruption can leave the old complete selection, the new complete
selection, or exact retry metadata. It must never expose a partial release
through `/data/docker/bin`. Retry logic resumes only exact states; corrupt or
unexpected staging remains visible for operator diagnosis and is not broadly
deleted.

Deactivation durably records the exact selected version before clearing its
activation record and removing the selector. If interruption or a directory
durability failure occurs after removal, that version-bound journal authorizes
only the matching retry. Probe validates it without mutation, and a later
activation reconciles only an exact inactive journal. Wrong-version retries,
an unexpected selector, malformed metadata, or newly observed daemon state
remain hard refusals.

## Uninstall

KernelSU always removes the module directory after invoking `uninstall.sh` and
ignores the hook's exit status. The hook therefore cannot veto manager removal
or ask the operator to retry with the module files still present.

Before inspecting the kernel or host, the hook atomically publishes or exactly
validates this standalone, root-owned recovery kit:

```text
/data/docker/recovery/0.1.0-rc.2/
  bin/kernelctl
  bin/install-preflight
  bin/swap-boot-kernel
  installer-inputs.tsv
  recovery-manifest.tsv
```

The directories are mode `0700`, executables are `0755`, and the two manifest
files are `0600`. Every source size and hash is recorded, and the recovery
manifest binds the exact `KSU`, `3.3.0`, `33214`, and `lkm` execution
environment. Creation stages an exact sibling tree, fsyncs its members and
directories, publishes it with an atomic rename, and fsyncs the recovery root.
An existing symlink, extra member, wrong mode, or identity mismatch is rejected
rather than replaced.

If the hook cannot prove this kit, it prints that the module must be reinstalled
or fastboot recovery made ready and tells the operator not to reboot. KernelSU
still removes the module directory, so the hook never claims that a nonzero
status preserved those source files.

The persistent recovery commands are:

```text
KSU=true KSU_VER=3.3.0 KSU_VER_CODE=33214 KSU_RUNTIME_MODE=lkm /data/docker/recovery/0.1.0-rc.2/bin/kernelctl status
KSU=true KSU_VER=3.3.0 KSU_VER_CODE=33214 KSU_RUNTIME_MODE=lkm /data/docker/recovery/0.1.0-rc.2/bin/kernelctl restore RESTORE:CD1A.260714.001.A9:_a
KSU=true KSU_VER=3.3.0 KSU_VER_CODE=33214 KSU_RUNTIME_MODE=lkm /data/docker/recovery/0.1.0-rc.2/bin/kernelctl restore RESTORE:CD1A.260714.001.A9:_b
```

Use only the restore line matching the freshly reported active suffix. If the
kernel state is unknown, recovery-required, or `current-public`, the hook
preserves `/data/docker/bin`, every release, and all data, and prints these
commands plus the active-slot fastboot fallback. KernelSU still deletes the
module directory, but the external kit remains usable.

For a stock or authorized predecessor kernel, the hook resolves the exact
active release and asks its versioned hostctl to stop. A running-container
inventory, ambiguous process, unsafe release, failed stop, malformed
acknowledgment, changed active link, or status 3 preserves the active link and
prints the direct versioned stop command, for example:

```text
/data/docker/releases/0.1.0-rc.2/hostctl stop
```

Only a stock or predecessor kernel plus exact `result=stopped` and an unchanged
release identity allows the hook to ask `release-transaction` to deactivate
that exact release. After a transaction failure, the hook performs one bounded
same-version retry only when the selector has disappeared or it proves an exact
root-owned deactivation journal for that release. It never unlinks
`/data/docker/bin` directly.

Manager uninstall preserves:

- `/data/docker/disk.img` and container data;
- every immutable release;
- downloaded inputs;
- staged kernels;
- boot backups and metadata;
- any externally provisioned workload profile and activation descriptor; and
- the standalone versioned recovery kit and diagnostic material.

It does not force-stop containers, unmount storage, erase data, remove the
kernel backup, restore a boot partition automatically, or reboot.

## Qualification boundary

Host tests use synthetic boot images and fake host, process, disk, route, and
manager environments. They prove the scripted contract but do not authorize a
phone write or replace tests against KernelSU BusyBox, Android SELinux, actual
loop/ext4 behavior, exact static ARM64 execution, live Docker, Wi-Fi reconnect,
boot, fastboot recovery, or manager uninstall. Follow [INSTALL.md](INSTALL.md)
for the explicit device-qualification sequence.
