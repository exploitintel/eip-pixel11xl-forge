#!/usr/bin/env bash
# Build the pinned arm64 kernel environment as a normalized OCI image.
set -euo pipefail

kernel_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
output=
load=0
tag=eip-pixel11xl-forge-buildenv:local

usage() {
  echo "usage: $0 --output FILE [--tag NAME] [--load]" >&2
  exit 2
}
fail() { echo "build-builder.sh: $*" >&2; exit 1; }
need_value() { [ "$#" -ge 2 ] || usage; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) need_value "$@"; output=$2; shift 2 ;;
    --load) load=1; shift ;;
    --tag) need_value "$@"; tag=$2; shift 2 ;;
    -h|--help) usage ;;
    *) usage ;;
  esac
done

[ -n "$output" ] || usage
[ ! -e "$output" ] || fail "output exists: $output"
[[ "$tag" =~ ^eip-pixel11xl-forge-buildenv:[a-z0-9][a-z0-9_.-]*$ ]] \
  || fail "tag must use the isolated eip-pixel11xl-forge-buildenv namespace"
command -v docker >/dev/null || fail "docker is required"
docker info >/dev/null 2>&1 || fail "Docker is not available"
if [ "$load" -eq 1 ] && docker image inspect "$tag" >/dev/null 2>&1; then
  fail "refusing to replace existing local image tag: $tag"
fi

mkdir -p "$(dirname "$output")"
export SOURCE_DATE_EPOCH=1788609530

args=(
  buildx build
  --platform linux/arm64
  --no-cache
  --pull=false
  --provenance=false
  --sbom=false
  --file "$kernel_dir/Dockerfile.buildenv"
  --output "type=oci,dest=$output,rewrite-timestamp=true"
)
args+=(--tag "$tag")
args+=("$kernel_dir")

docker "${args[@]}"

inspect_args=("$output" --expect-platform linux/arm64 --require-safe-ref)
builder_info=$("$kernel_dir/../tools/oci-image-info.py" "${inspect_args[@]}")
archive_ref=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["ref_name"] or "")' <<< "$builder_info")
[ "$archive_ref" = "$tag" ] || fail "OCI archive ref name mismatch: got ${archive_ref:-none}, expected $tag"
printf '%s\n' "$builder_info"

if [ "$load" -eq 1 ]; then
  manifest_digest=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["manifest_digest"])' <<< "$builder_info")
  config_digest=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["config_digest"])' <<< "$builder_info")
  docker load --input "$output" >/dev/null
  docker image inspect "$tag" >/dev/null
  loaded_id=$(docker image inspect "$tag" --format '{{.Id}}')
  [ "$loaded_id" = "$manifest_digest" ] || [ "$loaded_id" = "$config_digest" ] \
    || fail "loaded tag does not resolve to the verified OCI manifest or config"
fi
