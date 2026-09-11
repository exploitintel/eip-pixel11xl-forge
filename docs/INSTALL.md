# Pixel qualification install guide

This guide is for the `0.1.0-rc.3` qualification package on one exact Pixel 11
Pro XL. It is not a public release procedure. No signed public ZIP or update
feed exists yet. The static AArch64 tools have been built twice locally with
byte-identical outputs and executed in an isolated Linux/AArch64 environment.
The complete public host check and two deterministic ZIP assemblies also pass
locally. Phone execution, manager installation, live host, kernel, and recovery
remain qualification gates.

Do not use this procedure on another model or Android build.

## Exact target

```text
device: Pixel 11 Pro XL
codename: kodiak
Android build: CD1A.260714.001.A9
KernelSU implementation: KernelSU-Next
KernelSU version: 3.3.0
KernelSU runtime mode: LKM
network: Wi-Fi through wlan0 only
```

Cellular networking and automatic Wi-Fi-to-cellular switching are not part of
v0.1 qualification.

## Recovery prerequisites

Complete all of these before installing the module:

- Back up the phone. An unlocked bootloader is required, and first unlock
  erases user data.
- Keep the exact factory `boot.img` for `CD1A.260714.001.A9` off-device.
- Keep the matching factory package and its recovery instructions available
  from another computer.
- Use a known-good data cable and a computer with working current ADB and
  fastboot tools.
- Prove both ADB and fastboot can see this phone before any candidate kernel
  write.
- Record the active slot in both Android and fastboot and require agreement.
- Keep the phone at 50 percent battery or higher. External power is strongly
  recommended during qualification.
- Disable or defer any unsupported Android OTA until the stock kernel has been
  restored and a new build record is qualified.

Record the Android-side identity:

```sh
adb devices
adb shell getprop ro.product.device
adb shell getprop ro.build.id
adb shell getprop ro.build.fingerprint
adb shell getprop ro.boot.slot_suffix
```

The device must report `kodiak`, the build must be
`CD1A.260714.001.A9`, and the suffix must be `_a` or `_b`.

Prove the bootloader path while the known-good cable and computer are still in
place:

```sh
adb reboot bootloader
fastboot devices
fastboot getvar current-slot
fastboot reboot
adb wait-for-device
```

Prepare, but do not run, the one recovery command matching the recorded active
slot:

```text
active _a: fastboot flash boot_a /off-device/path/to/CD1A.260714.001.A9/boot.img
active _b: fastboot flash boot_b /off-device/path/to/CD1A.260714.001.A9/boot.img
```

Never guess the slot and never substitute a boot image from another build.

## Qualification artifacts

The required files are:

```text
eip-pixel11xl-forge-0.1.0-rc.3.zip
docker-29.8.0.tgz
Image-CD1A.260714.001.A9.lz4
```

The first file is the deterministic KernelSU-Next installer. The other two are
deliberately not embedded in it. The module workflow produces a short-lived
commit-qualified artifact containing the ZIP, `SHA256SUMS`, and toolchain
provenance after two byte-identical static-tool builds and two byte-identical
ZIP assemblies.

At the current checkpoint, the complete public host check, two byte-identical
static-helper builds, isolated Linux/AArch64 helper execution, two exact ZIP
assemblies, and archive inspection pass locally. Use only the named ZIP from
the accompanying qualification bundle and verify its complete `SHA256SUMS`
before beginning the phone procedure.

This artifact is not yet release-signed. Keep the exact source commit and CI
run with the qualification record, and verify the downloaded bundle before
using it:

```sh
sha256sum --check --strict SHA256SUMS
```

The candidate kernel must come from the exact recorded build and must retain
the exact filename above. Do not rename an unrelated image to satisfy the
installer.

## Stage the external inputs

For the initial qualification, sideload both large inputs before opening
KernelSU-Next Manager:

```sh
adb push docker-29.8.0.tgz /data/local/tmp/docker-29.8.0.tgz
adb push Image-CD1A.260714.001.A9.lz4 \
  /data/local/tmp/Image-CD1A.260714.001.A9.lz4
```

The installer checks the exact recorded size and SHA-256 of each file. If a
same-named file already exists in `/data/docker/downloads`, that cache takes
precedence and must match exactly. An invalid cache is a hard refusal, not a
reason to fall through to the sideload. Docker Engine can use its pinned HTTPS
origin through a qualified system curl when no local copy exists; the kernel
cannot.

## Install through KernelSU-Next Manager

1. Confirm KernelSU-Next reports version 3.3.0 and LKM mode.
2. Select `eip-pixel11xl-forge-0.1.0-rc.3.zip` in the module installer.
3. Read the complete installer output. Do not treat a refusal as a warning.
4. Reboot only if the manager reports a clean module installation and no
   recovery-attention message.

Before committing the module, the installer checks the exact manager, device,
build, Android identity, active slot, full boot partition, embedded kernel
payload, Docker archive, generated runtime, kernel candidate, free space, and
existing host release state. It then stages the kernel and activates the
immutable host release.

The install itself does not write the boot partition, create `disk.img`, mount
storage, start Docker, enable autostart, or reboot. On a clean host the config
is version 2 with autostart off and disk size zero. A pre-existing root-owned
regular config with mode `0600` is preserved and must pass hostctl's separate
strict content validation before use.

## Install the qualified kernel

After the module is present:

1. Open its Action in KernelSU-Next Manager.
2. Review the printed Forge host and kernel status.
3. Use Volume Down until `Install authenticated kernel` is selected.
4. Press Volume Up to select it.
5. Check that the displayed build, active suffix, and fastboot fallback match
   the recovery record.
6. Press Volume Up again within 10 seconds to confirm the write.

The controller requires at least 50 percent battery, makes a full active-slot
backup, verifies the backup and metadata, writes only the active `boot_a` or
`boot_b` partition, and verifies the complete resulting partition and payload.
It does not reboot.

If the Action exits with status 3 or prints `RECOVERY REQUIRED`, do not reboot.
Use the prepared fastboot command for the recorded active slot. Otherwise,
reboot under operator control and wait for Android to return.

After reboot, open the Action again. Kernel status must identify the same build
and slot, report `boot_state=current-public`, and report
`staged_image=ready`.

## Configure storage and start Forge

The installer deliberately leaves storage unallocated. In the module Action,
select exactly one disk preset and confirm it:

- 8 GiB;
- 16 GiB; or
- 32 GiB.

Disk initialization creates one sparse ext4 image and mounts it at
`/data/docker/lib`. It refuses resize, replacement, a dirty image, an
unexpected mount, a nonempty unmounted data directory, or insufficient free
space.

Then select `Start Forge host`. Start requires connected Wi-Fi on `wlan0`,
rejects route overlap, converges the bounded Wi-Fi policy and loopback Docker
API firewall, verifies the exact runtime, and starts Docker. On an unextended
public installation it does not deploy or run an application workload. If a
separate root provisioner has installed the exact optional workload profile
defined in [MODULE-LIFECYCLE.md](MODULE-LIFECYCLE.md#optional-workload-profile),
Start invokes its identity-checked `post-start` phase after host readiness. A
profile refusal is a failed Start even though a newly started Docker daemon is
left running for safe diagnosis.

Start also recovers the bounded Docker and containerd PID/socket artifacts
that may survive a reboot under `/data` after their numeric PIDs have been
reused by unrelated Android processes. It first proves that no Docker runtime
process or API is live and never signals the unrelated PID. Stop retains its
stricter behavior and refuses a foreign or ambiguous PID identity.

The root shell status command is:

```sh
adb shell su -c '/data/docker/bin/hostctl status'
```

Expected healthy running state has `schema_version=2`, `daemon=running`,
`host_config=ready`, `disk=ready`, `mount=ready`,
`wifi_interface=ready`, `bridge_routes=ready`, `wifi_policy=ready`,
`ipv4_forwarding=on`, and `api_firewall=ready`. The container count is
independent and may be zero or a known positive value.

## Wi-Fi reconnect qualification

The automated host fixture covers Wi-Fi loss and explicit repair. Do not turn
the qualification phone's Wi-Fi radio off during the initial checkpoint: the
provider-side cellular issue makes that transport transition unsafe to use as
a host test until it can be investigated separately.

After a normal Wi-Fi reconnect is observed without deliberately toggling the
radio, use a disposable test container and no sensitive workload:

1. Wait until `wlan0` has an IPv4 address and its numeric Wi-Fi routing table
   has a default route.
2. Select `Start Forge host` again, or run:

```sh
adb shell su -c '/data/docker/bin/hostctl start'
```

3. Require `result=running`, then repeat the egress, LAN, and status checks.

There is no continuous reconnect daemon. Repeated Start is the bounded repair
operation. The deliberate Wi-Fi off/on live gate remains deferred with all
cellular behavior.

## Stop and autostart

`Stop Forge host` refuses while the running-container inventory is nonzero or
unknown. With no workload profile, park or stop the containers through their
owning workflow before selecting Stop. An active profile gets one synchronous
`pre-stop` phase under the host lock before inventory, allowing its owner to
park only its own containers. Hook failure, changed daemon identity, or a
remaining container refuses Stop without a host signal. A clean Stop sends a
normal `TERM` only to the exact managed daemon and never force-kills or
unmounts storage.

Autostart is an explicit Action choice. When enabled, the post-boot hook starts
the host only after strict config, kernel capability, active-slot identity, and
Wi-Fi gates pass. A failed gate leaves Docker stopped and records a bounded
diagnostic in `/data/docker/hostctl.log` when possible.

## Kernel restore and uninstall

Before an unsupported OTA or module removal, restore the authenticated backup:

1. Open the Action and select `Restore authenticated kernel backup`.
2. Verify the exact build, active suffix, and fallback command.
3. Confirm with Volume Up.
4. If status 3 or recovery guidance appears, do not reboot and use fastboot.
5. On clean success, the active boot partition is back to its authorized source
   identity. Reboot remains operator-controlled.

Before asking KernelSU-Next Manager to remove the module, complete the kernel
restore and park all containers so `hostctl stop` can succeed. This is the only
clean removal path.

KernelSU always deletes the module directory after running its uninstall hook
and ignores the hook's exit status. The hook cannot block removal. It first
publishes a standalone recovery kit at:

```text
/data/docker/recovery/0.1.0-rc.3/
```

Read the uninstall output and require the exact `standalone recovery kit ready`
message. If the kit cannot be proven, do not reboot. Reinstall the same module
or make the prepared active-slot fastboot recovery immediately available;
KernelSU will still have removed the module directory.

If the kernel is stock or an authorized predecessor and the exact active
hostctl returns `result=stopped`, the hook delegates removal of only the active
`/data/docker/bin` selector to the release transaction. A version-bound
deactivation journal makes an interrupted removal safely retryable. After a
transaction failure, the hook performs one bounded same-version retry only if
the selector disappeared or an exact root-owned journal for that release is
present. If the public kernel is still active, kernel state is unknown,
recovery attention exists, containers prevent stop, or daemon or release
identity is ambiguous, it preserves that selector and prints recovery guidance.
The manager still removes the module directory.

The external kit remains available after manager removal:

```text
KSU=true KSU_VER=3.3.0 KSU_VER_CODE=33214 KSU_RUNTIME_MODE=lkm /data/docker/recovery/0.1.0-rc.3/bin/kernelctl status
KSU=true KSU_VER=3.3.0 KSU_VER_CODE=33214 KSU_RUNTIME_MODE=lkm /data/docker/recovery/0.1.0-rc.3/bin/kernelctl restore RESTORE:CD1A.260714.001.A9:_a
KSU=true KSU_VER=3.3.0 KSU_VER_CODE=33214 KSU_RUNTIME_MODE=lkm /data/docker/recovery/0.1.0-rc.3/bin/kernelctl restore RESTORE:CD1A.260714.001.A9:_b
```

Run status first and use only the restore token matching its reported active
suffix. If the host stop failed, use the exact versioned command printed by
the hook, such as:

```text
/data/docker/releases/0.1.0-rc.3/hostctl stop
```

The fastboot fallback remains:

```text
fastboot flash boot_a /off-device/path/to/CD1A.260714.001.A9/boot.img
fastboot flash boot_b /off-device/path/to/CD1A.260714.001.A9/boot.img
```

Use only the active-slot line. Manager uninstall preserves the Docker disk and
data, immutable releases, downloaded inputs, staged kernel, boot backups,
any externally provisioned workload profile, standalone recovery kit, and
diagnostic material. It never erases or restores these automatically.

## Qualification record

Do not call the installer complete until the record contains:

- the exact source commit and workflow run;
- hashes for the installer ZIP, static helpers, Docker archive, candidate
  kernel, and known-good factory boot image;
- clean manager install output;
- exact active-slot and boot identity before and after kernel install;
- successful reboot and Android bring-up;
- Docker disk, start, status, container egress, and intended LAN evidence;
- continuously connected Wi-Fi DNS/egress and intended LAN evidence, with the
  deliberate loss/reconnect phone gate recorded as deferred under D3;
- conservative stop and autostart-off evidence;
- authenticated kernel restore and reboot evidence;
- exact manager uninstall behavior, preserved-data evidence, and post-removal
  recovery-kit status execution; and
- the tested fastboot recovery path.

Only after those gates pass should the project move from an installable
qualification candidate toward a signed public release.
