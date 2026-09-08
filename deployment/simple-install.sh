#!/bin/bash
set -euo pipefail

usage() {
  printf '%s\n' 'usage: install.sh --serial ADB_SERIAL [--wipe] [--disk-gib 64] [--provider-env FILE]'
}

die() {
  printf 'install: %s\n' "$*" >&2
  exit 1
}

CURRENT_STAGE='Checking arguments and package'
NEXT_ACTION='Check the arguments and package files, then run the installer again.'
STAGE_STARTED=$SECONDS
HEARTBEAT_PID=

stop_progress() {
  if [[ -n "$HEARTBEAT_PID" ]]; then
    kill "$HEARTBEAT_PID" 2>/dev/null || true
    wait "$HEARTBEAT_PID" 2>/dev/null || true
    HEARTBEAT_PID=
  fi
}

# shellcheck disable=SC2329 # Invoked by the EXIT trap.
finish() {
  local rc=$? elapsed=$((SECONDS - STAGE_STARTED))
  trap - EXIT
  stop_progress
  if ((rc != 0)); then
    printf 'install: failed during "%s" (exit %s, %dm%02ds elapsed).\nNext: %s\n' \
      "$CURRENT_STAGE" "$rc" "$((elapsed / 60))" "$((elapsed % 60))" "$NEXT_ACTION" >&2
  fi
  exit "$rc"
}
trap 'finish' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

stage() {
  stop_progress
  CURRENT_STAGE=$1
  NEXT_ACTION=$2
  STAGE_STARTED=$SECONDS
  printf '\n[%dm%02ds] %s\n' "$((SECONDS / 60))" "$((SECONDS % 60))" "$CURRENT_STAGE" >&2
  # Stderr keeps progress out of captured image IDs, UIDs and status output.
  (
    trap - EXIT
    tick=
    trap 'if [[ -n "$tick" ]]; then kill "$tick" 2>/dev/null || true; wait "$tick" 2>/dev/null || true; fi; exit 0' INT TERM
    while kill -0 "$$" 2>/dev/null; do
      sleep 15 & tick=$!
      wait "$tick"
      elapsed=$((SECONDS - STAGE_STARTED))
      printf 'Still working: %s - %dm%02ds elapsed in this stage.\n' \
        "$CURRENT_STAGE" "$((elapsed / 60))" "$((elapsed % 60))" >&2
    done
  ) &
  HEARTBEAT_PID=$!
}

require_value() {
  [[ -n "${2:-}" && "$2" != --* && "$2" != -h ]] || die "$1 requires a value (see --help)"
}

hash_file() {
  local output
  if command -v shasum >/dev/null 2>&1; then
    output=$(shasum -a 256 -- "$1") || die "cannot hash $1"
  elif command -v sha256sum >/dev/null 2>&1; then
    output=$(sha256sum -- "$1") || die "cannot hash $1"
  else
    die 'neither shasum nor sha256sum is installed'
  fi
  FILE_SHA256=${output%% *}
}

verify_file() {
  local file=$1 expected=$2 label=$3
  hash_file "$file"
  [[ "$FILE_SHA256" == "$expected" ]] || die "$label has the wrong SHA-256"
}

SERIAL=
DISK_GIB=64
PROVIDER_ENV=
WIPE=0
EXPECTED_DEVICE=kodiak
EXPECTED_FINGERPRINT=google/kodiak/kodiak:17/CD1A.260714.001.A9/15938155:user/release-keys
EXPECTED_ANDROID_VERSION=17
EXPECTED_SECURITY_PATCH=2026-08-05
while (($#)); do
  case "$1" in
    --serial) require_value "$@"; SERIAL=$2; shift 2 ;;
    --disk-gib) require_value "$@"; DISK_GIB=$2; shift 2 ;;
    --provider-env) require_value "$@"; PROVIDER_ENV=$2; shift 2 ;;
    --wipe) WIPE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -n "$SERIAL" ]] || die '--serial is required'
[[ -z "$PROVIDER_ENV" || -f "$PROVIDER_ENV" ]] || die "provider environment is missing: $PROVIDER_ENV"
case "$DISK_GIB" in 8|16|32|64) ;; *) die '--disk-gib must be 8, 16, 32, or 64' ;; esac
DISK_BYTES=$((DISK_GIB * 1024 * 1024 * 1024))

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
PAYLOAD=$SCRIPT_DIR/payload
for file in host-module.zip docker-engine.tgz kernel.lz4 stock-boot.img ksu-init-boot.img ksu-manager.apk ksu-grant-profile controller.tar operator.tar forge-control.apk forge-source.tar forge.lock ops.tar; do
  [[ -f "$PAYLOAD/$file" ]] || die "package file is missing: payload/$file"
done
verify_file "$PAYLOAD/stock-boot.img" 5fc827ab5adfaf81f84cd7b1ab8675684e5588aaff832e9ba45051a72d0b06a2 'stock boot image'
verify_file "$PAYLOAD/ksu-init-boot.img" bd471feb086b8bd0466dd2c1ec52598fbaa4a97c4bde7d58f7b0f051f02e553f 'KernelSU init_boot image'
verify_file "$PAYLOAD/ksu-manager.apk" fd0b12385c98fe9d5f4f1257b5f184e55c74c1376637507df0718305f5d7a924 'KernelSU Manager APK'
CONTROLLER_CONFIG_SHA256=$(sed -n 's/^CONTROLLER_CONFIG_SHA256=//p' "$PAYLOAD/forge.lock")
[[ "$CONTROLLER_CONFIG_SHA256" =~ ^[0-9a-f]{64}$ ]] || die 'payload/forge.lock has an invalid controller config ID'

if [[ -n "${ADB:-}" ]]; then
  ADB_BIN=$ADB
elif command -v adb >/dev/null 2>&1; then
  ADB_BIN=$(command -v adb)
elif [[ -x "$HOME/Library/Android/sdk/platform-tools/adb" ]]; then
  ADB_BIN=$HOME/Library/Android/sdk/platform-tools/adb
else
  die 'adb is not installed'
fi

if [[ -n "${FASTBOOT:-}" ]]; then
  FASTBOOT_BIN=$FASTBOOT
elif command -v fastboot >/dev/null 2>&1; then
  FASTBOOT_BIN=$(command -v fastboot)
elif [[ -x "$(dirname "$ADB_BIN")/fastboot" ]]; then
  FASTBOOT_BIN=$(dirname "$ADB_BIN")/fastboot
else
  die 'fastboot is not installed'
fi

phone() {
  local command=$1 quoted
  quoted=${command//\'/\'\\\'\'}
  "$ADB_BIN" -s "$SERIAL" shell -T "su -c '$quoted'"
}

push() {
  "$ADB_BIN" -s "$SERIAL" push "$1" "$2" >/dev/null
}

wait_android() {
  stage 'Waiting for Android to boot' 'Keep USB connected; check that Android boots and USB debugging is authorized.'
  "$ADB_BIN" -s "$SERIAL" wait-for-device
  local attempt
  for attempt in {1..90}; do
    if [[ $("$ADB_BIN" -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r') == 1 ]]; then
      return 0
    fi
    sleep 2
  done
  die 'Android did not finish booting'
}

wait_fastboot() {
  stage 'Waiting for fastboot' 'Check the USB connection and whether the phone is on the bootloader screen.'
  local attempt
  for attempt in {1..60}; do
    "$FASTBOOT_BIN" devices | grep -q "^${SERIAL}[[:space:]]" && return 0
    sleep 1
  done
  die 'phone did not enter fastboot'
}

validate_android_target() {
  local device fingerprint android_version security_patch
  stage "Verifying supported phone $SERIAL" 'Boot the supported Pixel build, authorize USB debugging, and try again.'
  device=$("$ADB_BIN" -s "$SERIAL" shell getprop ro.product.device | tr -d '\r')
  fingerprint=$("$ADB_BIN" -s "$SERIAL" shell getprop ro.build.fingerprint | tr -d '\r')
  android_version=$("$ADB_BIN" -s "$SERIAL" shell getprop ro.build.version.release | tr -d '\r')
  security_patch=$("$ADB_BIN" -s "$SERIAL" shell getprop ro.build.version.security_patch | tr -d '\r')
  [[ "$device" == "$EXPECTED_DEVICE" ]] || die "unsupported device: ${device:-unavailable}"
  [[ "$fingerprint" == "$EXPECTED_FINGERPRINT" ]] || die "unsupported Android build: ${fingerprint:-unavailable}"
  [[ "$android_version" == "$EXPECTED_ANDROID_VERSION" ]] || die "unsupported Android version: ${android_version:-unavailable}"
  [[ "$security_patch" == "$EXPECTED_SECURITY_PATCH" ]] || die "unsupported security patch: ${security_patch:-unavailable}"
}

validate_fastboot_target() {
  local product
  product=$("$FASTBOOT_BIN" -s "$SERIAL" getvar product 2>&1 | sed -n 's/^product: //p')
  [[ "$product" == "$EXPECTED_DEVICE" ]] || die "unsupported fastboot product: ${product:-unavailable}"
}

make_shell_root_image() {
  local output_dir=$1
  command -v unzip >/dev/null 2>&1 || die 'unzip is not installed'
  unzip -p "$PAYLOAD/ksu-manager.apk" lib/arm64-v8a/libksud.so >"$output_dir/ksud"
  unzip -p "$PAYLOAD/ksu-manager.apk" lib/arm64-v8a/libadbroot.so >"$output_dir/libadbroot.so"
  chmod 700 "$output_dir/ksud"
  push "$output_dir/ksud" /data/local/tmp/eip-ksud
  push "$PAYLOAD/ksu-init-boot.img" /data/local/tmp/eip-ksu-init-boot.img
  "$ADB_BIN" -s "$SERIAL" shell chmod 700 /data/local/tmp/eip-ksud
  "$ADB_BIN" -s "$SERIAL" shell '/data/local/tmp/eip-ksud boot-patch --boot /data/local/tmp/eip-ksu-init-boot.img --kmi android16-6.12 --allow-shell --no-install --out /data/local/tmp --out-name eip-ksu-shell-root.img'
  "$ADB_BIN" -s "$SERIAL" pull /data/local/tmp/eip-ksu-shell-root.img "$output_dir/ksu-init-boot.img" >/dev/null
  "$ADB_BIN" -s "$SERIAL" shell rm -f /data/local/tmp/eip-ksud /data/local/tmp/eip-ksu-init-boot.img /data/local/tmp/eip-ksu-shell-root.img
  [[ -s "$output_dir/ksu-init-boot.img" ]] || die 'KernelSU shell-root image was not created'
  [[ $(wc -c < "$output_dir/ksu-init-boot.img" | tr -d ' ') == 8388608 ]] || \
    die 'KernelSU shell-root image has the wrong size'
}

if ((WIPE)); then
  validate_android_target
  stage "Factory-wiping $SERIAL" 'Check the fastboot error above; do not interrupt an active wipe.'
  "$ADB_BIN" -s "$SERIAL" reboot bootloader >/dev/null 2>&1 || true
  wait_fastboot
  validate_fastboot_target
  stage 'Wiping Android user data' 'Check the fastboot error above before deciding whether to repeat the wipe.'
  "$FASTBOOT_BIN" -s "$SERIAL" -w
  "$FASTBOOT_BIN" -s "$SERIAL" reboot
  stop_progress
  printf 'WIPE COMPLETE\n'
  exit 0
fi

stage 'Waiting for Android setup and authorized USB debugging' 'Complete Android setup, enable USB debugging, authorize this computer, and keep USB connected.'
until "$ADB_BIN" -s "$SERIAL" shell true >/dev/null 2>&1; do
  sleep 2
done
validate_android_target

root_available() {
  [[ $($ADB_BIN -s "$SERIAL" shell "su -c 'id -u'" 2>/dev/null | tr -d '\r') == 0 ]]
}

bootstrap_root() {
  local slot bootstrap_dir
  stage 'Preparing KernelSU bootstrap' 'Check the package inputs and the USB error above.'
  bootstrap_dir=$(mktemp -d "${TMPDIR:-/tmp}/eip-forge-bootstrap.XXXXXX")
  make_shell_root_image "$bootstrap_dir"
  slot=$($ADB_BIN -s "$SERIAL" shell getprop ro.boot.slot_suffix | tr -d '\r' | sed 's/^_//')
  "$ADB_BIN" -s "$SERIAL" reboot bootloader >/dev/null 2>&1 || true
  wait_fastboot
  validate_fastboot_target
  case "$slot" in a|b) ;; *) die "cannot determine active slot: $slot" ;; esac

  stage "Bootstrapping KernelSU on slot $slot" 'Check the fastboot error and matching firmware inputs before recovery; do not guess a slot.'
  "$FASTBOOT_BIN" -s "$SERIAL" flash "boot_$slot" "$PAYLOAD/stock-boot.img"
  "$FASTBOOT_BIN" -s "$SERIAL" flash "init_boot_$slot" "$bootstrap_dir/ksu-init-boot.img"
  "$FASTBOOT_BIN" -s "$SERIAL" reboot
  wait_android

  stage 'Installing KernelSU userspace without UI' 'Check the bootstrap output above and whether Android completed booting.'
  push "$bootstrap_dir/ksud" /data/local/tmp/eip-ksud
  push "$bootstrap_dir/libadbroot.so" /data/local/tmp/eip-libadbroot.so
  "$ADB_BIN" -s "$SERIAL" shell chmod 700 /data/local/tmp/eip-ksud
  printf '%s\n' 'exec /data/local/tmp/eip-ksud install --libadbroot /data/local/tmp/eip-libadbroot.so' | \
    "$ADB_BIN" -s "$SERIAL" shell -T /data/local/tmp/eip-ksud debug su
  for attempt in {1..15}; do
    root_available && break
    sleep 2
  done
  root_available || die 'KernelSU userspace bootstrap did not provide shell root'

  stage 'Installing KernelSU Manager' 'Check the APK installation error and available phone storage.'
  "$ADB_BIN" -s "$SERIAL" install -r "$PAYLOAD/ksu-manager.apk" >/dev/null
  "$ADB_BIN" -s "$SERIAL" shell 'rm -f /data/local/tmp/eip-ksud /data/local/tmp/eip-libadbroot.so; pm grant com.rifsxd.ksunext android.permission.POST_NOTIFICATIONS >/dev/null 2>&1 || true'
  "$ADB_BIN" -s "$SERIAL" reboot >/dev/null 2>&1 || true
  wait_android
  rm -rf "$bootstrap_dir"
  root_available || die 'KernelSU shell root did not survive reboot'
}

prepare_disk() {
  phone "sed -i 's/^DISK_SIZE_BYTES=.*/DISK_SIZE_BYTES=$DISK_BYTES/' /data/docker/config/host.conf"
  phone "mkdir -p /data/docker/lib /data/docker/run; if ! test -f /data/docker/disk.img; then truncate -s $DISK_BYTES /data/docker/disk.img; mke2fs -q -t ext4 -O '^has_journal,^casefold' /data/docker/disk.img; fi"
  # shellcheck disable=SC2016 # Variables in phone commands expand on Android.
  phone 'if ! grep -q " /data/docker/lib ext4 " /proc/self/mounts; then loop=$(losetup -j /data/docker/disk.img | sed -n "1s/:.*//p"); test -n "$loop" || loop=$(losetup -f --show /data/docker/disk.img); mount -t ext4 -o noatime,nodev "$loop" /data/docker/lib; fi'
}

start_docker() {
  prepare_disk
  phone 'echo 1 > /proc/sys/net/ipv4/ip_forward; iptables -C INPUT -p tcp --dport 7171 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport 7171 -j ACCEPT; ip rule show | grep -q "9990:.*to 172.17.0.0/16 lookup main" || ip rule add to 172.17.0.0/16 lookup main pref 9990; ip rule show | grep -q "9991:.*from 172.17.0.0/16 lookup wlan0" || ip rule add from 172.17.0.0/16 lookup 1016 pref 9991'
  if ! phone 'DOCKER_HOST=unix:///data/docker/run/docker.sock /data/docker/bin/docker info >/dev/null 2>&1'; then
    phone 'setsid sh /data/docker/bin/dockerd.sh --runtime-only </dev/null >/dev/null 2>&1 &'
  fi
  local attempt
  for attempt in {1..30}; do
    phone 'DOCKER_HOST=unix:///data/docker/run/docker.sock /data/docker/bin/docker info >/dev/null 2>&1' && return 0
    sleep 2
  done
  die 'Docker did not start'
}

enable_control_app() {
  local control_uid
  control_uid=$("$ADB_BIN" -s "$SERIAL" shell 'pm list packages -U com.exploitintel.forgecontrol' \
    | tr -d '\r' | sed -n 's/.* uid://p')
  [[ "$control_uid" =~ ^[0-9]+$ ]] || die 'cannot determine Forge Control UID'

  push "$PAYLOAD/ksu-grant-profile" /data/local/tmp/eip-ksu-grant-profile
  phone "chmod 700 /data/local/tmp/eip-ksu-grant-profile; /data/local/tmp/eip-ksu-grant-profile $control_uid com.exploitintel.forgecontrol; rc=\$?; rm -f /data/local/tmp/eip-ksu-grant-profile; exit \$rc"
  phone 'pm grant com.exploitintel.forgecontrol android.permission.POST_NOTIFICATIONS >/dev/null 2>&1 || true'
  "$ADB_BIN" -s "$SERIAL" shell 'am start -n com.exploitintel.forgecontrol/.MainActivity >/dev/null'
}

load_image() {
  local archive=$1 tag=$2 expected_id=${3:-} remote=/data/local/tmp/eip-simple-$1 output source current_id
  stage "Checking image $archive" 'Check the Docker or USB error above.'
  if [[ -n "$expected_id" ]]; then
    current_id=$(phone "DOCKER_HOST=unix:///data/docker/run/docker.sock /data/docker/bin/docker image inspect --format '{{.Id}}' $tag" 2>/dev/null | tr -d '\r') || true
  elif phone "DOCKER_HOST=unix:///data/docker/run/docker.sock /data/docker/bin/docker image inspect $tag >/dev/null 2>&1"; then
    printf 'Using existing %s\n' "$tag" >&2
    return 0
  fi
  if [[ -n "$expected_id" && "$current_id" == "sha256:$expected_id" ]]; then
    printf 'Using existing %s\n' "$tag" >&2
    return 0
  fi
  stage "Transferring $archive" 'Check the USB connection and available phone storage.'
  push "$PAYLOAD/$archive" "$remote"
  stage "Loading $archive" 'Check the Docker error and available phone storage; large imports can take several minutes.'
  output=$(phone "DOCKER_HOST=unix:///data/docker/run/docker.sock /data/docker/bin/docker load -i $remote")
  phone "rm -f $remote"
  source=$(printf '%s\n' "$output" | tr -d '\r' | sed -n 's/^Loaded image ID: //p' | tail -n 1)
  if [[ -z "$source" ]]; then
    source=$(printf '%s\n' "$output" | tr -d '\r' | sed -n 's/^Loaded image: //p' | tail -n 1)
  fi
  [[ -n "$source" ]] || die "Docker did not report the image loaded from $archive"
  if [[ -n "$expected_id" ]]; then
    current_id=$(phone "DOCKER_HOST=unix:///data/docker/run/docker.sock /data/docker/bin/docker image inspect --format '{{.Id}}' $source" | tr -d '\r')
    [[ "$current_id" == "sha256:$expected_id" ]] || die "$archive loaded the wrong image ID"
  fi
  phone "DOCKER_HOST=unix:///data/docker/run/docker.sock /data/docker/bin/docker tag $source $tag"
}

stage "Checking root on $SERIAL" 'Check that Android is booted and KernelSU shell root is available.'
if ! root_available; then
  bootstrap_root
fi
root_available || die 'KernelSU root is not available'

HOST_INSTALLED=false
if phone 'test -x /data/docker/bin/docker' >/dev/null 2>&1; then
  HOST_INSTALLED=true
fi

if [[ "$HOST_INSTALLED" == false ]]; then
  stage 'Installing the Pixel Docker host' 'Check the module output above, package inputs, USB connection, and available phone storage.'
  push "$PAYLOAD/docker-engine.tgz" /data/local/tmp/docker-29.8.0.tgz
  push "$PAYLOAD/kernel.lz4" /data/local/tmp/Image-CD1A.260714.001.A9.lz4
  push "$PAYLOAD/host-module.zip" /data/local/tmp/eip-pixel11xl-forge.zip
  phone '/data/adb/ksud module install /data/local/tmp/eip-pixel11xl-forge.zip'
  prepare_disk
  slot=$("$ADB_BIN" -s "$SERIAL" shell getprop ro.boot.slot_suffix | tr -d '\r')
  case "$slot" in _a|_b) ;; *) die "cannot determine active slot: $slot" ;; esac
  module_root=$(phone 'if test -x /data/adb/modules_update/eip-pixel11xl-forge/bin/kernelctl; then printf /data/adb/modules_update/eip-pixel11xl-forge; else printf /data/adb/modules/eip-pixel11xl-forge; fi' | tr -d '\r')
  phone "KSU=true KSU_VER=3.3.0 KSU_VER_CODE=33214 KSU_RUNTIME_MODE=lkm $module_root/bin/kernelctl install INSTALL:CD1A.260714.001.A9:$slot"
  "$ADB_BIN" -s "$SERIAL" reboot >/dev/null 2>&1 || true
  wait_android
fi

stage 'Starting Docker on the phone' 'Check the Docker startup output above and available phone storage.'
start_docker

load_image controller.tar eip-cve-controller:local "$CONTROLLER_CONFIG_SHA256"
load_image operator.tar eip-operator-shell:phone
stage 'Downloading the pinned architecture handler' 'Check the phone Wi-Fi connection and registry error above.'
phone 'DOCKER_HOST=unix:///data/docker/run/docker.sock /data/docker/bin/docker pull tonistiigi/binfmt@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0'

stage 'Checking existing Forge state' 'Check the reported state in Forge Control before trying installation again.'
if phone 'test -x /data/eip-cve-ops/eip-hostctl.sh' >/dev/null 2>&1; then
  current_state=$(phone '/data/eip-cve-ops/eip-hostctl.sh status' 2>/dev/null | tr -d '\r' | sed -n 's/^system=//p')
  case "$current_state" in
    ready|running) phone '/data/eip-cve-ops/eip-hostctl.sh park' ;;
    parked|'') ;;
    *) die "existing Forge state is $current_state" ;;
  esac
fi

stage 'Installing Forge source and phone commands' 'Check the archive or USB error above and available phone storage.'
push "$PAYLOAD/forge-source.tar" /data/local/tmp/eip-forge-source.tar
push "$PAYLOAD/ops.tar" /data/local/tmp/eip-forge-ops.tar
phone 'rm -rf /data/eip-cve-src /data/eip-cve-ops; mkdir -p /data/eip-cve-src /data/eip-cve-ops; tar -xf /data/local/tmp/eip-forge-source.tar -C /data/eip-cve-src; tar -xf /data/local/tmp/eip-forge-ops.tar -C /data/eip-cve-ops; chmod 0755 /data/eip-cve-ops/*.sh /data/eip-cve-ops/*.py; rm -f /data/local/tmp/eip-forge-source.tar /data/local/tmp/eip-forge-ops.tar'

if ! phone 'test -f /data/eip-cve/container.env'; then
  stage 'Creating Forge state' 'Check the bootstrap output above and available phone storage.'
  phone '/data/eip-cve-ops/eip.sh bootstrap'
  phone '/data/eip-cve-ops/set-ollama.sh https://ollama.com'
fi

stage 'Configuring providers' 'Check the configuration error above and the supplied provider file format (KEY=VALUE); do not paste credentials into reports.'
if [[ -n "$PROVIDER_ENV" ]]; then
  printf 'Installing provider configuration\n' >&2
  push "$PROVIDER_ENV" /data/local/tmp/eip-provider.env
  # shellcheck disable=SC2016 # Preserve the remote merge result through cleanup.
  phone '/data/eip-cve-ops/merge-env.sh < /data/local/tmp/eip-provider.env; rc=$?; rm -f /data/local/tmp/eip-provider.env; exit $rc'
fi

stage 'Installing Forge Control' 'Check the APK installation error and available phone storage.'
"$ADB_BIN" -s "$SERIAL" install -r "$PAYLOAD/forge-control.apk" >/dev/null

stage 'Restarting Docker for the Forge update' 'Check the Docker startup output above and available phone storage.'
start_docker

stage 'Starting Forge WebUI' 'Check the UI startup output above and available phone storage.'
phone '/data/eip-cve-ops/eip.sh up --force-recreate --no-deps ui'
ui_ready=false
for attempt in {1..30}; do
  if ui_status=$(phone '/data/eip-cve-ops/eip-hostctl.sh status' 2>/dev/null | tr -d '\r') && \
    printf '%s\n' "$ui_status" | grep -qx 'ui_health=healthy'; then
    ui_ready=true
    break
  fi
  sleep 5
done
if [[ "$ui_ready" != true ]]; then
  phone '/data/eip-cve-ops/eip.sh logs --no-color --tail 40 ui' || true
  phone '/data/eip-cve-ops/eip.sh down' || true
  die 'Forge WebUI did not become healthy for the managed-skills update'
fi

stage 'Updating managed skills' 'Check the managed-skills migration error above; no existing customization was reset.'
if ! phone '/data/eip-cve-ops/eip.sh skills-release'; then
  phone '/data/eip-cve-ops/eip.sh logs --no-color --tail 40 ui' || true
  phone '/data/eip-cve-ops/eip.sh down' || true
  die 'managed-skills update failed'
fi

stage 'Starting Forge' 'Check the startup output above; use Forge Control Host details and logs to inspect the reported state.'
phone '/data/eip-cve-ops/eip-hostctl.sh start'
stage 'Waiting for Forge readiness' 'Check the status and logs above; use Forge Control Host details to identify the unhealthy service.'
# shellcheck disable=SC2034 # Fixed retry count; only the number of attempts matters.
for attempt in {1..60}; do
  if ready_status=$(phone '/data/eip-cve-ops/eip-hostctl.sh status' 2>/dev/null | tr -d '\r') && \
    printf '%s\n' "$ready_status" | grep -qx 'system=ready'; then
    stage 'Authorizing and opening Forge Control' 'Check the root-profile or app-launch error above.'
    enable_control_app
    stop_progress
    printf '\nInstallation complete in %dm%02ds.\n' "$((SECONDS / 60))" "$((SECONDS % 60))"
    printf '%s\n' "$ready_status" | sed -n \
      -e 's/^docker=/Docker: /p' -e 's/^ui_health=/WebUI: /p' -e 's/^chat_health=/Agent chat: /p'
    if [[ -n "$PROVIDER_ENV" ]]; then
      printf 'Provider file: imported (credentials not tested upstream).\n'
    else
      printf 'Provider file: not supplied; no keys imported.\n'
    fi
    printf 'Open Forge Control on the phone, then tap Open Forge WebUI.\n'
    printf 'READY\n'
    exit 0
  fi
  sleep 2
done

printf 'Last Forge status:\n%s\n' "${ready_status:-unavailable}" >&2
phone '/data/eip-cve-ops/eip-hostctl.sh logs' || true
die 'Forge did not become READY'
