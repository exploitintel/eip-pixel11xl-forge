#!/usr/bin/env bash
# Build one supported Pixel 11 Pro XL kernel candidate from pinned public input.
set -euo pipefail

kernel_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root_dir=$(cd "$kernel_dir/.." && pwd)
builds_file="$kernel_dir/builds.json"
build_id=
source_archive=
out_dir=
builder_oci=
bootstrap_candidate=0
jobs=$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)

usage() {
  sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  cat >&2 <<'USAGE'

usage: kernel/build.sh --build-id ID --source-archive FILE --out DIR
       [--jobs N] [--builder-oci FILE] [--bootstrap-candidate]

--bootstrap-candidate is accepted only while the selected record has status
candidate-bootstrap. It establishes, but does not trust, the first candidate
hash. Normal and CI builds require the recorded builder and Image.lz4 hashes.
USAGE
  exit 2
}
fail() { echo "build.sh: $*" >&2; exit 1; }
need_value() { [ "$#" -ge 2 ] || usage; }
digest() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --build-id) need_value "$@"; build_id=$2; shift 2 ;;
    --source-archive) need_value "$@"; source_archive=$2; shift 2 ;;
    --out) need_value "$@"; out_dir=$2; shift 2 ;;
    --jobs) need_value "$@"; jobs=$2; shift 2 ;;
    --builder-oci) need_value "$@"; builder_oci=$2; shift 2 ;;
    --bootstrap-candidate) bootstrap_candidate=1; shift ;;
    -h|--help) usage ;;
    *) usage ;;
  esac
done

[ -n "$build_id" ] && [ -n "$source_archive" ] && [ -n "$out_dir" ] || usage
case "$jobs" in ''|*[!0-9]*) fail "--jobs must be a positive integer" ;; esac
[ "$jobs" -gt 0 ] || fail "--jobs must be a positive integer"
[ -f "$source_archive" ] || fail "source archive not found: $source_archive"
[ ! -e "$out_dir" ] || fail "output path already exists: $out_dir"
if [ -n "$builder_oci" ]; then [ -f "$builder_oci" ] || fail "builder OCI archive not found: $builder_oci"; fi
command -v python3 >/dev/null || fail "python3 is required"

source_archive=$(cd "$(dirname "$source_archive")" && pwd)/$(basename "$source_archive")
if [ -n "$builder_oci" ]; then
  builder_oci=$(cd "$(dirname "$builder_oci")" && pwd)/$(basename "$builder_oci")
fi
out_name=$(basename "$out_dir")
mkdir -p "$(dirname "$out_dir")"
out_parent=$(cd "$(dirname "$out_dir")" && pwd)
out_dir="$out_parent/$out_name"
[ ! -e "$out_dir" ] || fail "output path already exists: $out_dir"

"$root_dir/tools/validate-builds.py" --builds "$builds_file" >/dev/null

stage=$(mktemp -d "${TMPDIR:-/tmp}/eip-pixel11xl-build.XXXXXX")
candidate_out=$(mktemp -d "$out_parent/.eip-pixel11xl-candidate.XXXXXX")
volume=
builder_tag=
builder_requested_tag=
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
  if [ "$complete" -ne 1 ]; then rm -rf -- "$candidate_out"; fi
}
trap cleanup EXIT INT TERM

python3 - "$builds_file" "$build_id" > "$stage/record.json" <<'PY'
import json, sys
document = json.load(open(sys.argv[1], encoding="utf-8"))
matches = [item for item in document["builds"] if item["buildId"] == sys.argv[2]]
if len(matches) != 1:
    raise SystemExit(f"build ID must match exactly one record: {sys.argv[2]}")
json.dump(matches[0], sys.stdout, indent=2, sort_keys=True)
sys.stdout.write("\n")
PY

field() {
  python3 - "$stage/record.json" "$1" <<'PY'
import json, sys
value = json.load(open(sys.argv[1], encoding="utf-8"))
for part in sys.argv[2].split("."):
    value = value[part]
if value is not None:
    print(value)
PY
}

status=$(field status)
expected_archive_name=$(field source.normalizedArchive.name)
expected_archive_size=$(field source.normalizedArchive.size)
expected_archive_sha=$(field source.normalizedArchive.sha256)
expected_builder_manifest=$(field builder.ociManifestDigest)
expected_builder_config=$(field builder.configDigest)
expected_image_sha=$(field candidateImage.sha256)
build_host=$(field kbuild.host)

if [ "$bootstrap_candidate" -eq 1 ]; then
  [ "$status" = candidate-bootstrap ] || fail "bootstrap is allowed only for candidate-bootstrap records"
else
  [ -n "$expected_builder_manifest" ] && [ -n "$expected_builder_config" ] || fail "builder digest baseline is not recorded"
  [ -n "$expected_image_sha" ] || fail "candidate Image.lz4 hash is not recorded; use the reviewed bootstrap procedure"
fi

[ "$(basename "$source_archive")" = "$expected_archive_name" ] || fail "source archive filename mismatch"
staged_source="$stage/$expected_archive_name"
cp "$source_archive" "$staged_source"
source_archive="$staged_source"
actual_archive_size=$(wc -c < "$source_archive" | tr -d ' ')
[ "$actual_archive_size" = "$expected_archive_size" ] || fail "source archive size mismatch: got $actual_archive_size, expected $expected_archive_size"
actual_archive_sha=$(digest "$source_archive")
[ "$actual_archive_sha" = "$expected_archive_sha" ] || fail "source archive sha256 mismatch: got $actual_archive_sha, expected $expected_archive_sha"

# Reject archive paths or object types that could escape or change extraction
# semantics. Content identity is checked again as a reconstructed Git tree.
"$root_dir/tools/check-source-archive.py" "$source_archive" >/dev/null

command -v docker >/dev/null || fail "docker is required"
docker info >/dev/null 2>&1 || fail "Docker is not available"

mkdir -p "$stage/patches" "$stage/keys"
cp "$kernel_dir/build-in-container.sh" "$stage/build-in-container.sh"
cp "$root_dir/tools/source-tree-manifest.py" "$stage/source-tree-manifest.py"
cp "$kernel_dir/UPSTREAM-LICENSES.sha256" "$stage/UPSTREAM-LICENSES.sha256"
cp "$(field configs.stock.path | sed "s#^#$root_dir/#")" "$stage/stock.config"
cp "$(field configs.fragment.path | sed "s#^#$root_dir/#")" "$stage/fragment.config"

python3 - "$stage/record.json" <<'PY' | while IFS= read -r relative; do
import json, sys
r = json.load(open(sys.argv[1], encoding="utf-8"))
for item in r["patches"]:
    print(item["path"])
PY
  cp "$root_dir/$relative" "$stage/patches/$(basename "$relative")"
done

python3 - "$stage/record.json" <<'PY' | while IFS= read -r relative; do
import json, sys
r = json.load(open(sys.argv[1], encoding="utf-8"))
print(r["reproducibilityKey"]["pem"]["path"])
print(r["reproducibilityKey"]["certificate"]["path"])
for item in r["reproducibilityKey"]["supportFiles"]:
    print(item["path"])
PY
  cp "$root_dir/$relative" "$stage/keys/$(basename "$relative")"
done

if [ -z "$builder_oci" ]; then
  builder_oci="$stage/buildenv.oci.tar"
  builder_requested_tag="eip-pixel11xl-forge-buildenv:local-$(basename "$stage" | tr '[:upper:]' '[:lower:]')"
  "$kernel_dir/build-builder.sh" --output "$builder_oci" --tag "$builder_requested_tag"
else
  cp "$builder_oci" "$stage/imported-buildenv.oci.tar"
  builder_oci="$stage/imported-buildenv.oci.tar"
fi

inspect_args=("$builder_oci" --expect-platform linux/arm64 --require-safe-ref)
if [ -n "$expected_builder_manifest" ]; then inspect_args+=(--expect-manifest "$expected_builder_manifest"); fi
if [ -n "$expected_builder_config" ]; then inspect_args+=(--expect-config "$expected_builder_config"); fi
builder_info=$("$root_dir/tools/oci-image-info.py" "${inspect_args[@]}")
actual_builder_manifest=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["manifest_digest"])' <<< "$builder_info")
actual_builder_config=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["config_digest"])' <<< "$builder_info")
archive_ref=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["ref_name"] or "")' <<< "$builder_info")
if [ -n "$expected_builder_config" ]; then
  [ "$actual_builder_config" = "$expected_builder_config" ] || fail "builder config digest mismatch"
fi
[[ "$archive_ref" =~ ^eip-pixel11xl-forge-buildenv:[a-z0-9][a-z0-9_.-]*$ ]] \
  || fail "unsafe builder OCI ref name: ${archive_ref:-none}"
if docker image inspect "$archive_ref" >/dev/null 2>&1; then
  fail "refusing to replace existing local image tag: $archive_ref"
fi
if docker image inspect "$actual_builder_manifest" >/dev/null 2>&1 \
  || docker image inspect "$actual_builder_config" >/dev/null 2>&1; then
  builder_image_preexisting=1
fi
docker load --input "$builder_oci" >/dev/null
builder_tag=$archive_ref
loaded_id=$(docker image inspect "$archive_ref" --format '{{.Id}}')
[ "$loaded_id" = "$actual_builder_manifest" ] || [ "$loaded_id" = "$actual_builder_config" ] \
  || fail "loaded OCI ref does not resolve to the verified manifest or config"
builder_image_id=$loaded_id
actual_os=$(docker image inspect "$builder_tag" --format '{{.Os}}')
actual_arch=$(docker image inspect "$builder_tag" --format '{{.Architecture}}')
[ "$actual_os/$actual_arch" = linux/arm64 ] || fail "loaded builder platform mismatch: $actual_os/$actual_arch"

volume=$(docker volume create)

docker run --rm --pull=never --network none --platform linux/arm64 \
  --hostname "$build_host" \
  -e BUILD_RECORD=/work/record.json \
  -e SOURCE_ARCHIVE=/input/source.tar.gz \
  -e JOBS="$jobs" \
  -v "$volume:/ksrc" \
  -v "$stage:/work:ro" \
  -v "$source_archive:/input/source.tar.gz:ro" \
  -v "$candidate_out:/out" \
  "$builder_tag" /work/build-in-container.sh

[ "$(wc -c < "$source_archive" | tr -d ' ')" = "$expected_archive_size" ] || fail "staged source archive size changed during build"
[ "$(digest "$source_archive")" = "$expected_archive_sha" ] || fail "staged source archive changed during build"

image_sha=$(digest "$candidate_out/Image")
image_size=$(wc -c < "$candidate_out/Image" | tr -d ' ')
image_lz4_sha=$(digest "$candidate_out/Image.lz4")
image_lz4_size=$(wc -c < "$candidate_out/Image.lz4" | tr -d ' ')

if [ -n "$expected_image_sha" ]; then
  [ "$image_lz4_sha" = "$expected_image_sha" ] || fail "Image.lz4 sha256 differs from the build record"
fi

mv "$candidate_out/Image.lz4" "$candidate_out/Image-$build_id.lz4"
mv "$candidate_out/config" "$candidate_out/config-$build_id"
mv "$candidate_out/toolchain.txt" "$candidate_out/toolchain-$build_id.txt"
mv "$candidate_out/source-tree.jsonl" "$candidate_out/source-tree-$build_id.jsonl"
mv "$candidate_out/patched-source-tree.jsonl" "$candidate_out/patched-source-tree-$build_id.jsonl"
mv "$candidate_out/version.txt" "$candidate_out/version-$build_id.txt"
mv "$candidate_out/vmlinux-notes.txt" "$candidate_out/vmlinux-notes-$build_id.txt"
rm "$candidate_out/Image"
cp "$source_archive" "$candidate_out/$expected_archive_name"
for patch_path in "$stage"/patches/*.patch; do
  cp "$patch_path" "$candidate_out/patch-$build_id-$(basename "$patch_path")"
done

python3 - "$stage/record.json" "$candidate_out/build-record-$build_id.json" \
  "$actual_builder_manifest" "$actual_builder_config" "$image_sha" "$image_size" "$image_lz4_sha" "$image_lz4_size" <<'PY'
import json, sys
source = json.load(open(sys.argv[1], encoding="utf-8"))
record = {
    "schemaVersion": 1,
    "buildId": source["buildId"],
    "device": source["device"],
    "kernel": source["kernel"],
    "source": source["source"],
    "upstreamLicenses": source["upstreamLicenses"],
    "configs": source["configs"],
    "patches": source["patches"],
    "reproducibilityKey": source["reproducibilityKey"],
    "builder": {
        **source["builder"],
        "ociManifestDigest": sys.argv[3],
        "configDigest": sys.argv[4],
    },
    "kbuild": source["kbuild"],
    "outputs": {
        "Image": {"size": int(sys.argv[6]), "sha256": sys.argv[5]},
        "Image.lz4": {"size": int(sys.argv[8]), "sha256": sys.argv[7]},
    },
}
with open(sys.argv[2], "w", encoding="utf-8", newline="\n") as output:
    json.dump(record, output, indent=2, sort_keys=True)
    output.write("\n")
PY

(
  cd "$candidate_out"
  LC_ALL=C find . -maxdepth 1 -type f ! -name SHA256SUMS -print \
    | sed 's#^./##' | LC_ALL=C sort \
    | while IFS= read -r name; do
        if command -v sha256sum >/dev/null 2>&1; then sha256sum "$name"; else shasum -a 256 "$name"; fi
      done > SHA256SUMS
)

mv "$candidate_out" "$out_dir"
complete=1
echo "build.sh: Image.lz4 $image_lz4_size bytes $image_lz4_sha"
echo "build.sh: builder $actual_builder_manifest ($actual_builder_config)"
echo "build.sh: candidate artifacts $out_dir"
