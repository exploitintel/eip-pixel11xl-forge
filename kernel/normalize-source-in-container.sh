#!/usr/bin/env bash
# Internal source normalization step. Invoke through normalize-source.sh.
set -euo pipefail

: "${BUILD_RECORD:?}"
: "${RAW_ARCHIVE:?}"
fail() { echo "normalize-source-in-container.sh: $*" >&2; exit 1; }
digest() { sha256sum "$1" | awk '{print $1}'; }

mapfile -t staged_input_hashes < <(python3 - "$BUILD_RECORD" <<'PY'
import json, sys
r = json.load(open(sys.argv[1], encoding="utf-8"))
scripts = {item["path"]: item["sha256"] for item in r["builder"]["buildScripts"]}
print(scripts["kernel/normalize-source-in-container.sh"])
print(scripts["tools/source-tree-manifest.py"])
print(r["upstreamLicenses"]["sha256"])
PY
)
[ "${#staged_input_hashes[@]}" -eq 3 ] || fail "cannot read staged input identities"
[ "$(digest /work/normalize-source-in-container.sh)" = "${staged_input_hashes[0]}" ] || fail "normalizer script sha256 mismatch"
[ "$(digest /work/source-tree-manifest.py)" = "${staged_input_hashes[1]}" ] || fail "manifest tool sha256 mismatch"
[ "$(digest /work/UPSTREAM-LICENSES.sha256)" = "${staged_input_hashes[2]}" ] || fail "license manifest sha256 mismatch"

mapfile -t values < <(python3 - "$BUILD_RECORD" <<'PY'
import json, sys
r = json.load(open(sys.argv[1], encoding="utf-8"))
for value in (
    r["kernel"]["upstreamTree"],
    r["kernel"]["patchedTree"],
    r["builder"]["sourceDateEpoch"],
    r["source"]["normalizedArchive"]["name"],
    r["source"]["normalizedArchive"]["size"],
    r["source"]["normalizedArchive"]["sha256"],
    r["source"]["sourceManifest"]["size"],
    r["source"]["sourceManifest"]["sha256"],
    r["source"]["patchedManifest"]["size"],
    r["source"]["patchedManifest"]["sha256"],
): print(value)
PY
)
[ "${#values[@]}" -eq 10 ] || fail "cannot read build record"
upstream_tree=${values[0]}
patched_tree=${values[1]}
source_epoch=${values[2]}
archive_name=${values[3]}
archive_size=${values[4]}
archive_sha=${values[5]}
source_manifest_size=${values[6]}
source_manifest_sha=${values[7]}
patched_manifest_size=${values[8]}
patched_manifest_sha=${values[9]}

export LC_ALL=C TZ=UTC
mkdir -p /ksrc/source
tar -xzf "$RAW_ARCHIVE" -C /ksrc/source
cd /ksrc/source
git init -q
git config user.name source-verifier
git config user.email source-verifier.invalid
git config core.autocrlf false
git add -f -A
actual_tree=$(git write-tree)
[ "$actual_tree" = "$upstream_tree" ] || fail "upstream tree mismatch: got $actual_tree, expected $upstream_tree"
sed 's#  kernel/#  #' /work/UPSTREAM-LICENSES.sha256 | sha256sum --check --strict - >/dev/null

python3 /work/source-tree-manifest.py /ksrc/source --output /out/source-tree.jsonl
[ "$(stat -c %s /out/source-tree.jsonl)" = "$source_manifest_size" ] || fail "source manifest size mismatch"
[ "$(digest /out/source-tree.jsonl)" = "$source_manifest_sha" ] || fail "source manifest sha256 mismatch"

tar --sort=name --format=posix --pax-option=delete=atime,delete=ctime \
  --mtime="@$source_epoch" --owner=0 --group=0 --numeric-owner \
  --exclude=./.git -C /ksrc/source -cf "/out/${archive_name%.gz}" .
gzip -n -9 "/out/${archive_name%.gz}"
[ "$(stat -c %s "/out/$archive_name")" = "$archive_size" ] || fail "normalized archive size mismatch"
[ "$(digest "/out/$archive_name")" = "$archive_sha" ] || fail "normalized archive sha256 mismatch"

mapfile -t patch_values < <(python3 - "$BUILD_RECORD" <<'PY'
import json, os, sys
r = json.load(open(sys.argv[1], encoding="utf-8"))
for item in r["patches"]:
    print(os.path.basename(item["path"])); print(item["sha256"])
PY
)
for ((index=0; index<${#patch_values[@]}; index+=2)); do
  name=${patch_values[index]}
  expected=${patch_values[index + 1]}
  [ "$(digest "/work/patches/$name")" = "$expected" ] || fail "patch sha256 mismatch: $name"
  patch -p1 --fuzz=0 --no-backup-if-mismatch -i "/work/patches/$name" >/dev/null
done
git add -f -A
actual_patched_tree=$(git write-tree)
[ "$actual_patched_tree" = "$patched_tree" ] || fail "patched tree mismatch: got $actual_patched_tree, expected $patched_tree"
python3 /work/source-tree-manifest.py /ksrc/source --output /out/patched-source-tree.jsonl
[ "$(stat -c %s /out/patched-source-tree.jsonl)" = "$patched_manifest_size" ] || fail "patched manifest size mismatch"
[ "$(digest /out/patched-source-tree.jsonl)" = "$patched_manifest_sha" ] || fail "patched manifest sha256 mismatch"
printf '%s  upstream Git tree\n%s  patched Git tree\n' "$actual_tree" "$actual_patched_tree" > /out/git-trees.txt
