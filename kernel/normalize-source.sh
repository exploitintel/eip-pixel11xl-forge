#!/usr/bin/env bash
# Normalize a regenerated Gitiles tarball after verifying its full Git tree.
set -euo pipefail

kernel_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root_dir=$(cd "$kernel_dir/.." && pwd)
build_id=
raw_archive=
builder_oci=
out_dir=

usage() {
  echo "usage: $0 --build-id ID --raw-archive FILE --builder-oci FILE --out DIR" >&2
  exit 2
}
fail() { echo "normalize-source.sh: $*" >&2; exit 1; }
need_value() { [ "$#" -ge 2 ] || usage; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --build-id) need_value "$@"; build_id=$2; shift 2 ;;
    --raw-archive) need_value "$@"; raw_archive=$2; shift 2 ;;
    --builder-oci) need_value "$@"; builder_oci=$2; shift 2 ;;
    --out) need_value "$@"; out_dir=$2; shift 2 ;;
    -h|--help) usage ;;
    *) usage ;;
  esac
done
[ -n "$build_id" ] && [ -n "$raw_archive" ] && [ -n "$builder_oci" ] && [ -n "$out_dir" ] || usage
[ -f "$raw_archive" ] || fail "raw archive not found"
[ -f "$builder_oci" ] || fail "builder OCI archive not found"
[ ! -e "$out_dir" ] || fail "output path exists"
raw_archive=$(cd "$(dirname "$raw_archive")" && pwd)/$(basename "$raw_archive")
builder_oci=$(cd "$(dirname "$builder_oci")" && pwd)/$(basename "$builder_oci")
out_name=$(basename "$out_dir")
mkdir -p "$(dirname "$out_dir")"
out_parent=$(cd "$(dirname "$out_dir")" && pwd)
out_dir="$out_parent/$out_name"
[ ! -e "$out_dir" ] || fail "output path exists"
"$root_dir/tools/validate-builds.py" --builds "$kernel_dir/builds.json" >/dev/null

stage=$(mktemp -d "${TMPDIR:-/tmp}/eip-source-normalize.XXXXXX")
candidate=$(mktemp -d "$out_parent/.eip-source-candidate.XXXXXX")
volume=
builder_tag=
builder_image_id=
builder_image_preexisting=0
complete=0
cleanup() {
  if [ -n "$volume" ]; then docker volume rm "$volume" >/dev/null 2>&1 || true; fi
  if [ -n "$builder_tag" ]; then docker image rm "$builder_tag" >/dev/null 2>&1 || true; fi
  if [ -n "$builder_image_id" ] && [ "$builder_image_preexisting" -eq 0 ]; then
    docker image rm "$builder_image_id" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$stage"
  if [ "$complete" -ne 1 ]; then rm -rf -- "$candidate"; fi
}
trap cleanup EXIT INT TERM

cp "$raw_archive" "$stage/raw-source.tar.gz"
raw_archive="$stage/raw-source.tar.gz"
"$root_dir/tools/check-source-archive.py" "$raw_archive" >/dev/null
cp "$builder_oci" "$stage/imported-buildenv.oci.tar"
builder_oci="$stage/imported-buildenv.oci.tar"

python3 - "$kernel_dir/builds.json" "$build_id" > "$stage/record.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
r = [item for item in d["builds"] if item["buildId"] == sys.argv[2]]
if len(r) != 1: raise SystemExit("unknown or duplicate build ID")
json.dump(r[0], sys.stdout, sort_keys=True); print()
PY
mkdir -p "$stage/patches"
cp "$root_dir/tools/source-tree-manifest.py" "$stage/source-tree-manifest.py"
cp "$kernel_dir/normalize-source-in-container.sh" "$stage/normalize-source-in-container.sh"
cp "$kernel_dir/UPSTREAM-LICENSES.sha256" "$stage/UPSTREAM-LICENSES.sha256"
python3 - "$stage/record.json" <<'PY' | while IFS= read -r relative; do
import json, sys
for item in json.load(open(sys.argv[1], encoding="utf-8"))["patches"]: print(item["path"])
PY
  cp "$root_dir/$relative" "$stage/patches/$(basename "$relative")"
done

mapfile_compat=$(python3 - "$stage/record.json" <<'PY'
import json, sys
r=json.load(open(sys.argv[1], encoding="utf-8"))
print(r["builder"]["ociManifestDigest"] or "")
print(r["builder"]["configDigest"] or "")
PY
)
expected_manifest=$(printf '%s\n' "$mapfile_compat" | sed -n '1p')
expected_config=$(printf '%s\n' "$mapfile_compat" | sed -n '2p')
[ -n "$expected_manifest" ] && [ -n "$expected_config" ] || fail "builder baseline is not recorded"
builder_info=$("$root_dir/tools/oci-image-info.py" "$builder_oci" --expect-platform linux/arm64 \
  --expect-manifest "$expected_manifest" --expect-config "$expected_config" --require-safe-ref)
archive_ref=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["ref_name"] or "")' <<< "$builder_info")
[[ "$archive_ref" =~ ^eip-pixel11xl-forge-buildenv:[a-z0-9][a-z0-9_.-]*$ ]] \
  || fail "unsafe builder OCI ref name: ${archive_ref:-none}"
if docker image inspect "$archive_ref" >/dev/null 2>&1; then
  fail "refusing to replace existing local image tag: $archive_ref"
fi
if docker image inspect "$expected_manifest" >/dev/null 2>&1 \
  || docker image inspect "$expected_config" >/dev/null 2>&1; then
  builder_image_preexisting=1
fi
docker load --input "$builder_oci" >/dev/null
builder_tag=$archive_ref
loaded_id=$(docker image inspect "$archive_ref" --format '{{.Id}}')
[ "$loaded_id" = "$expected_manifest" ] || [ "$loaded_id" = "$expected_config" ] \
  || fail "loaded OCI ref does not resolve to the verified manifest or config"
builder_image_id=$loaded_id

volume=$(docker volume create)
docker run --rm --pull=never --network none --platform linux/arm64 \
  -e BUILD_RECORD=/work/record.json -e RAW_ARCHIVE=/input/source.tar.gz \
  -v "$volume:/ksrc" -v "$stage:/work:ro" -v "$raw_archive:/input/source.tar.gz:ro" \
  -v "$candidate:/out" "$builder_tag" /work/normalize-source-in-container.sh

"$root_dir/tools/check-source-archive.py" "$raw_archive" >/dev/null

mv "$candidate" "$out_dir"
complete=1
echo "normalize-source.sh: verified normalized source in $out_dir"
