#!/bin/bash
set -euo pipefail

usage() {
  cat <<'EOF'
usage: build-simple-package.sh \
  --forge-source DIR \
  --module ZIP \
  --kernel IMAGE \
  --ksu-grant-helper FILE \
  --controller TAR \
  --operator TAR \
  --apk APK \
  [--engine TGZ] \
  [--ksu-apk APK] \
  [--stock-boot IMAGE --ksu-init-boot IMAGE] \
  --output DIR
EOF
}

die() {
  printf 'build-simple-package: %s\n' "$*" >&2
  exit 1
}

FORGE_SOURCE=
MODULE=
ENGINE=
KERNEL=
STOCK_BOOT=
KSU_INIT_BOOT=
KSU_APK=
KSU_GRANT_HELPER=
CONTROLLER=
OPERATOR=
APK=
OUTPUT=

while (($#)); do
  case "$1" in
    --forge-source) FORGE_SOURCE=${2:-}; shift 2 ;;
    --module) MODULE=${2:-}; shift 2 ;;
    --engine) ENGINE=${2:-}; shift 2 ;;
    --kernel) KERNEL=${2:-}; shift 2 ;;
    --stock-boot) STOCK_BOOT=${2:-}; shift 2 ;;
    --ksu-init-boot) KSU_INIT_BOOT=${2:-}; shift 2 ;;
    --ksu-apk) KSU_APK=${2:-}; shift 2 ;;
    --ksu-grant-helper) KSU_GRANT_HELPER=${2:-}; shift 2 ;;
    --controller) CONTROLLER=${2:-}; shift 2 ;;
    --operator) OPERATOR=${2:-}; shift 2 ;;
    --apk) APK=${2:-}; shift 2 ;;
    --output) OUTPUT=${2:-}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

for value in FORGE_SOURCE MODULE KERNEL KSU_GRANT_HELPER CONTROLLER OPERATOR APK OUTPUT; do
  [[ -n "${!value}" ]] || die "missing --${value,,}"
done
if [[ -n "$STOCK_BOOT" || -n "$KSU_INIT_BOOT" ]]; then
  [[ -n "$STOCK_BOOT" && -n "$KSU_INIT_BOOT" ]] || \
    die '--stock-boot and --ksu-init-boot must be supplied together'
fi
[[ -d "$FORGE_SOURCE" ]] || die "Forge source is not a directory: $FORGE_SOURCE"
for file in "$MODULE" "$KERNEL" "$KSU_GRANT_HELPER" "$CONTROLLER" "$OPERATOR" "$APK"; do
  [[ -f "$file" ]] || die "file is missing: $file"
done
if [[ -n "$ENGINE" ]]; then
  [[ -f "$ENGINE" ]] || die "file is missing: $ENGINE"
fi
if [[ -n "$KSU_APK" ]]; then
  [[ -f "$KSU_APK" ]] || die "file is missing: $KSU_APK"
fi
if [[ -n "$STOCK_BOOT" ]]; then
  [[ -f "$STOCK_BOOT" ]] || die "file is missing: $STOCK_BOOT"
  [[ -f "$KSU_INIT_BOOT" ]] || die "file is missing: $KSU_INIT_BOOT"
fi
[[ ! -e "$OUTPUT" ]] || die "output already exists: $OUTPUT"

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
PROJECT_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd -P)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/eip-simple-package.XXXXXX")
trap 'rm -rf -- "$WORK"' EXIT

for command in git tar node; do
  command -v "$command" >/dev/null 2>&1 || die "$command is unavailable"
done

hash_file() {
  local output
  if command -v shasum >/dev/null 2>&1; then
    output=$(shasum -a 256 -- "$1") || die "cannot hash $1"
  elif command -v sha256sum >/dev/null 2>&1; then
    output=$(sha256sum -- "$1") || die "cannot hash $1"
  else
    die 'neither shasum nor sha256sum is available'
  fi
  HASH=${output%% *}
}

FORGE_REVISION=$(git -C "$FORGE_SOURCE" rev-parse --verify HEAD 2>/dev/null) || \
  die 'cannot resolve Forge source revision'
[[ "$FORGE_REVISION" =~ ^[0-9a-f]{40}$ ]] || die 'Forge source revision is invalid'
PINNED_FORGE_REVISION=$(tr -d '\r\n' < "$PROJECT_ROOT/FORGE_REVISION")
[[ "$FORGE_REVISION" == "$PINNED_FORGE_REVISION" ]] || \
  die "Forge source must be the pinned revision $PINNED_FORGE_REVISION"
git -C "$FORGE_SOURCE" archive --format=tar HEAD > "$WORK/forge-source.tar"
hash_file "$WORK/forge-source.tar"
FORGE_SOURCE_SHA256=$HASH

CONTROLLER_CONFIG=$(tar -xOf "$CONTROLLER" manifest.json 2>/dev/null | node -e '
let input = "";
process.stdin.on("data", chunk => input += chunk).on("end", () => {
  const manifest = JSON.parse(input);
  if (!Array.isArray(manifest) || manifest.length !== 1) process.exit(2);
  process.stdout.write(String(manifest[0].Config || ""));
});
') || die 'cannot read controller image manifest'
[[ "$CONTROLLER_CONFIG" =~ ^blobs/sha256/[0-9a-f]{64}$ ]] || \
  die 'controller image manifest has an invalid config path'
# shellcheck disable=SC2016 # JavaScript template interpolation belongs to Node.
CONTROLLER_LABELS=$(tar -xOf "$CONTROLLER" "$CONTROLLER_CONFIG" 2>/dev/null | node -e '
let input = "";
process.stdin.on("data", chunk => input += chunk).on("end", () => {
  const labels = JSON.parse(input).config?.Labels || {};
  process.stdout.write(`${labels["org.opencontainers.image.revision"] || ""}|${labels["io.exploitintel.build.source-snapshot-sha256"] || ""}`);
});
') || die 'cannot read controller image labels'
IFS='|' read -r CONTROLLER_REVISION CONTROLLER_SOURCE_SHA256 <<< "$CONTROLLER_LABELS"
[[ "$CONTROLLER_REVISION" == "$FORGE_REVISION" ]] || \
  die "controller was built from $CONTROLLER_REVISION, but Forge source is $FORGE_REVISION"
[[ "$CONTROLLER_SOURCE_SHA256" == "sha256:$FORGE_SOURCE_SHA256" ]] || \
  die 'controller source snapshot does not match the packaged Forge source'
hash_file "$CONTROLLER"
CONTROLLER_SHA256=$HASH
CONTROLLER_CONFIG_SHA256=${CONTROLLER_CONFIG##*/}

mkdir -p "$OUTPUT/payload" "$WORK/ops"
cp "$SCRIPT_DIR/simple-install.sh" "$OUTPUT/install.sh"
cp "$SCRIPT_DIR/prepare-firmware.sh" "$OUTPUT/prepare-firmware.sh"
cp "$MODULE" "$OUTPUT/payload/host-module.zip"
if [[ -n "$ENGINE" ]]; then
  cp "$ENGINE" "$OUTPUT/payload/docker-engine.tgz"
fi
cp "$KERNEL" "$OUTPUT/payload/kernel.lz4"
if [[ -n "$STOCK_BOOT" ]]; then
  cp "$STOCK_BOOT" "$OUTPUT/payload/stock-boot.img"
  cp "$KSU_INIT_BOOT" "$OUTPUT/payload/ksu-init-boot.img"
fi
if [[ -n "$KSU_APK" ]]; then
  cp "$KSU_APK" "$OUTPUT/payload/ksu-manager.apk"
fi
cp "$KSU_GRANT_HELPER" "$OUTPUT/payload/ksu-grant-profile"
cp "$CONTROLLER" "$OUTPUT/payload/controller.tar"
cp "$OPERATOR" "$OUTPUT/payload/operator.tar"
cp "$APK" "$OUTPUT/payload/forge-control.apk"
cp "$WORK/forge-source.tar" "$OUTPUT/payload/forge-source.tar"
cat > "$OUTPUT/payload/forge.lock" <<EOF
FORGE_REVISION=$FORGE_REVISION
FORGE_SOURCE_SHA256=$FORGE_SOURCE_SHA256
CONTROLLER_CONFIG_SHA256=$CONTROLLER_CONFIG_SHA256
CONTROLLER_ARCHIVE_SHA256=$CONTROLLER_SHA256
EOF

cp "$PROJECT_ROOT/eip/compose.android.yaml" "$WORK/ops/compose.android.yaml"
cp "$PROJECT_ROOT/eip/operator-entry.sh" "$WORK/ops/entry.sh"
cp "$PROJECT_ROOT/eip/phone-eip.sh" "$WORK/ops/eip.sh"
cp "$PROJECT_ROOT/eip/eip-hostctl.sh" "$WORK/ops/eip-hostctl.sh"
cp "$PROJECT_ROOT/eip/hostctl-state.mjs" "$WORK/ops/hostctl-state.mjs"
cp "$PROJECT_ROOT/eip/rebase-managed-skills.py" "$WORK/ops/rebase-managed-skills.py"
cp "$PROJECT_ROOT/eip/redeploy-managed-state.sh" "$WORK/ops/redeploy-managed-state.sh"
cp "$PROJECT_ROOT/eip/preflight.sh" "$WORK/ops/preflight.sh"
cp "$PROJECT_ROOT/eip/fix-routing.sh" "$WORK/ops/fix-routing.sh"
cp "$PROJECT_ROOT/eip/merge-env.sh" "$WORK/ops/merge-env.sh"
cp "$PROJECT_ROOT/eip/set-ollama.sh" "$WORK/ops/set-ollama.sh"
cp "$PROJECT_ROOT/eip/set-ollama-key.sh" "$WORK/ops/set-ollama-key.sh"
chmod 0755 "$WORK/ops"/*.sh "$WORK/ops"/*.py
tar -C "$WORK/ops" -cf "$OUTPUT/payload/ops.tar" .
chmod 0755 "$OUTPUT/install.sh" "$OUTPUT/prepare-firmware.sh"

printf 'Package ready: %s\n' "$OUTPUT"
if [[ -n "$STOCK_BOOT" ]]; then
  printf 'Install with: %s/install.sh --serial ADB_SERIAL\n' "$OUTPUT"
else
  printf 'Prepare firmware with: %s/prepare-firmware.sh --factory-zip FILE --serial ADB_SERIAL\n' "$OUTPUT"
fi
