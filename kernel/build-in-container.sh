#!/usr/bin/env bash
# Internal hermetic compile step. Invoke only through kernel/build.sh.
set -euo pipefail

: "${BUILD_RECORD:?}"
: "${SOURCE_ARCHIVE:?}"
: "${JOBS:?}"

fail() { echo "build-in-container.sh: $*" >&2; exit 1; }
digest() { sha256sum "$1" | awk '{print $1}'; }

mapfile -t staged_input_hashes < <(python3 - "$BUILD_RECORD" <<'PY'
import json, sys
r = json.load(open(sys.argv[1], encoding="utf-8"))
scripts = {item["path"]: item["sha256"] for item in r["builder"]["buildScripts"]}
for path in ("kernel/build-in-container.sh", "tools/source-tree-manifest.py"):
    print(scripts[path])
print(r["upstreamLicenses"]["sha256"])
print(r["configs"]["stock"]["sha256"])
print(r["configs"]["fragment"]["sha256"])
PY
)
[ "${#staged_input_hashes[@]}" -eq 5 ] || fail "cannot read staged input identities"
[ "$(digest /work/build-in-container.sh)" = "${staged_input_hashes[0]}" ] || fail "build script sha256 mismatch"
[ "$(digest /work/source-tree-manifest.py)" = "${staged_input_hashes[1]}" ] || fail "manifest tool sha256 mismatch"
[ "$(digest /work/UPSTREAM-LICENSES.sha256)" = "${staged_input_hashes[2]}" ] || fail "license manifest sha256 mismatch"
[ "$(digest /work/stock.config)" = "${staged_input_hashes[3]}" ] || fail "stock config sha256 mismatch"
[ "$(digest /work/fragment.config)" = "${staged_input_hashes[4]}" ] || fail "config fragment sha256 mismatch"

mapfile -t values < <(python3 - "$BUILD_RECORD" <<'PY'
import json, sys
r = json.load(open(sys.argv[1], encoding="utf-8"))
fields = [
    r["kernel"]["upstreamCommit"],
    r["kernel"]["upstreamTree"],
    r["kernel"]["patchedTree"],
    r["source"]["sourceManifest"]["sha256"],
    r["source"]["sourceManifest"]["size"],
    r["source"]["patchedManifest"]["sha256"],
    r["source"]["patchedManifest"]["size"],
    r["configs"]["mergedSha256"],
    r["kernel"]["release"],
    r["kbuild"]["host"],
    r["kbuild"]["user"],
    r["kbuild"]["version"],
    r["kbuild"]["bannerTimestamp"],
    r["kbuild"]["initramfsEpoch"],
    r["reproducibilityKey"]["mtimeEpoch"],
    r["reproducibilityKey"]["pem"]["sha256"],
    r["reproducibilityKey"]["certificate"]["sha256"],
    r["reproducibilityKey"]["supportFiles"][0]["sha256"],
    r["reproducibilityKey"]["supportFiles"][1]["sha256"],
    r["reproducibilityKey"]["supportFiles"][2]["sha256"],
    r["candidateImage"]["sha256"],
    r["candidateImage"]["size"],
]
for value in fields:
    print("" if value is None else value)
PY
)
[ "${#values[@]}" -eq 22 ] || fail "cannot read build record"

commit=${values[0]}
upstream_tree=${values[1]}
patched_tree=${values[2]}
source_manifest_sha=${values[3]}
source_manifest_size=${values[4]}
patched_manifest_sha=${values[5]}
patched_manifest_size=${values[6]}
merged_config_sha=${values[7]}
expected_release=${values[8]}
build_host=${values[9]}
build_user=${values[10]}
build_version=${values[11]}
build_timestamp=${values[12]}
initramfs_epoch=${values[13]}
key_epoch=${values[14]}
pem_sha=${values[15]}
certificate_sha=${values[16]}
genkey_sha=${values[17]}
pem_cmd_sha=${values[18]}
x509_cmd_sha=${values[19]}
expected_image_sha=${values[20]}
expected_image_size=${values[21]}

export LC_ALL=C TZ=UTC ARCH=arm64 LLVM=1 LLVM_IAS=1
mkdir -p /ksrc/common /ksrc/out
tar -xzf "$SOURCE_ARCHIVE" -C /ksrc/common
cd /ksrc/common

# Reconstruct the exact upstream Git tree before trusting or patching content.
git init -q
git config user.name source-verifier
git config user.email source-verifier.invalid
git config core.autocrlf false
git add -f -A
actual_tree=$(git write-tree)
[ "$actual_tree" = "$upstream_tree" ] || fail "upstream tree mismatch: got $actual_tree, expected $upstream_tree"
sed 's#  kernel/#  #' /work/UPSTREAM-LICENSES.sha256 | sha256sum --check --strict - >/dev/null

python3 /work/source-tree-manifest.py /ksrc/common --output /out/source-tree.jsonl
[ "$(stat -c %s /out/source-tree.jsonl)" = "$source_manifest_size" ] || fail "source manifest size mismatch"
[ "$(digest /out/source-tree.jsonl)" = "$source_manifest_sha" ] || fail "source manifest sha256 mismatch"

mapfile -t patch_values < <(python3 - "$BUILD_RECORD" <<'PY'
import json, os, sys
r = json.load(open(sys.argv[1], encoding="utf-8"))
for item in r["patches"]:
    print(os.path.basename(item["path"]))
    print(item["sha256"])
PY
)
[ "$((${#patch_values[@]} % 2))" -eq 0 ] || fail "invalid patch record"
for ((index=0; index<${#patch_values[@]}; index+=2)); do
  patch_name=${patch_values[index]}
  patch_sha=${patch_values[index + 1]}
  patch_path="/work/patches/$patch_name"
  [ "$(digest "$patch_path")" = "$patch_sha" ] || fail "patch sha256 mismatch: $patch_name"
  patch -p1 --fuzz=0 --no-backup-if-mismatch -i "$patch_path" >/dev/null
done

git add -f -A
actual_patched_tree=$(git write-tree)
[ "$actual_patched_tree" = "$patched_tree" ] || fail "patched tree mismatch: got $actual_patched_tree, expected $patched_tree"
python3 /work/source-tree-manifest.py /ksrc/common --output /out/patched-source-tree.jsonl
[ "$(stat -c %s /out/patched-source-tree.jsonl)" = "$patched_manifest_size" ] || fail "patched manifest size mismatch"
[ "$(digest /out/patched-source-tree.jsonl)" = "$patched_manifest_sha" ] || fail "patched manifest sha256 mismatch"
rm -rf /ksrc/common/.git

# Seed the historical link counter. Do not set KBUILD_BUILD_VERSION or
# KBUILD_BUILD_TIMESTAMP: doing so changes init/version.o.
echo $((build_version - 1)) > /ksrc/out/.version
mkdir -p /tmp/eip-build-shim
cat > /tmp/eip-build-shim/date <<SHIM
#!/bin/sh
if [ \$# -eq 0 ]; then echo "$build_timestamp"; exit 0; fi
exec /usr/bin/date "\$@"
SHIM
chmod 0755 /tmp/eip-build-shim/date
export PATH=/tmp/eip-build-shim:$PATH

cat > /tmp/eip-build-shim/cpiotime.c <<'CPIOTIME'
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
static int state = -1;
static time_t fixed;
static int active(void) {
    if (state < 0) {
        char exe[4096];
        ssize_t n = readlink("/proc/self/exe", exe, sizeof exe - 1);
        exe[n > 0 ? n : 0] = 0;
        const char *base = strrchr(exe, '/');
        base = base ? base + 1 : exe;
        const char *env = getenv("INITRAMFS_EPOCH");
        fixed = env ? (time_t) atol(env) : 0;
        state = fixed && strcmp(base, "gen_init_cpio") == 0;
    }
    return state;
}
time_t time(time_t *out) {
    if (active()) {
        if (out) *out = fixed;
        return fixed;
    }
    time_t (*real_time)(time_t *) = (time_t (*)(time_t *)) dlsym(RTLD_NEXT, "time");
    return real_time(out);
}
CPIOTIME
cc -shared -fPIC -O2 -o /tmp/eip-build-shim/cpiotime.so /tmp/eip-build-shim/cpiotime.c -ldl
export INITRAMFS_EPOCH="$initramfs_epoch"
export LD_PRELOAD=/tmp/eip-build-shim/cpiotime.so

# Stage the public D4 fixture with fixed mtimes and its original Kbuild command
# records. Any attempted regeneration or metadata drift is caught below.
mkdir -p /ksrc/out/certs
install -m 0644 /work/keys/signing_key.pem /ksrc/out/certs/signing_key.pem
install -m 0644 /work/keys/signing_key.x509 /ksrc/out/certs/signing_key.x509
install -m 0644 /work/keys/x509.genkey /ksrc/out/certs/x509.genkey
install -m 0644 /work/keys/.signing_key.pem.cmd /ksrc/out/certs/.signing_key.pem.cmd
install -m 0644 /work/keys/.signing_key.x509.cmd /ksrc/out/certs/.signing_key.x509.cmd
touch -d "@$key_epoch" /ksrc/out/certs/signing_key.pem /ksrc/out/certs/signing_key.x509 \
  /ksrc/out/certs/x509.genkey /ksrc/out/certs/.signing_key.pem.cmd /ksrc/out/certs/.signing_key.x509.cmd
[ "$(digest /ksrc/out/certs/signing_key.pem)" = "$pem_sha" ] || fail "staged D4 PEM mismatch"
[ "$(digest /ksrc/out/certs/signing_key.x509)" = "$certificate_sha" ] || fail "staged D4 certificate mismatch"
[ "$(digest /ksrc/out/certs/x509.genkey)" = "$genkey_sha" ] || fail "staged D4 x509 config mismatch"
[ "$(digest /ksrc/out/certs/.signing_key.pem.cmd)" = "$pem_cmd_sha" ] || fail "staged D4 PEM command mismatch"
[ "$(digest /ksrc/out/certs/.signing_key.x509.cmd)" = "$x509_cmd_sha" ] || fail "staged D4 certificate command mismatch"

cp /work/stock.config /ksrc/out/.config
scripts/kconfig/merge_config.sh -m -O /ksrc/out /ksrc/out/.config /work/fragment.config >/dev/null
make -s -C /ksrc/common O=/ksrc/out olddefconfig
config_sha=$(digest /ksrc/out/.config)
[ "$config_sha" = "$merged_config_sha" ] || fail "merged config sha256 mismatch: got $config_sha, expected $merged_config_sha"

grep -qx '# CONFIG_MODULE_SIG_FORCE is not set' /ksrc/out/.config || fail "CONFIG_MODULE_SIG_FORCE is not disabled"
if grep -qx 'CONFIG_MODULE_SIG_PROTECT=y' /ksrc/out/.config; then fail "CONFIG_MODULE_SIG_PROTECT is enabled"; fi
grep -qx 'CONFIG_MODULE_SIG_PROTECT_LIST=""' /ksrc/out/.config || fail "module signature protection list is not empty"

{
  echo "platform: linux/arm64"
  echo "clang: $(clang --version | head -1)"
  echo "lld: $(ld.lld --version | head -1)"
  echo "rustc: $(rustc --version)"
  echo "bindgen: $(bindgen --version)"
  echo "pahole: $(pahole --version)"
  echo "lz4: $(lz4 --version 2>&1 | head -1)"
  echo "debian: $(cat /etc/debian_version)"
  echo "packages:"
  cat /usr/local/share/eip-pixel11xl-forge/dpkg-packages.txt
} > /out/toolchain.txt

make -s -j"$JOBS" -C /ksrc/common O=/ksrc/out \
  KBUILD_BUILD_HOST="$build_host" KBUILD_BUILD_USER="$build_user" Image Image.lz4

[ "$(digest /ksrc/out/certs/signing_key.pem)" = "$pem_sha" ] || fail "Kbuild changed the D4 PEM"
[ "$(digest /ksrc/out/certs/signing_key.x509)" = "$certificate_sha" ] || fail "Kbuild changed the D4 certificate"
[ "$(digest /ksrc/out/certs/x509.genkey)" = "$genkey_sha" ] || fail "Kbuild changed the D4 x509 config"
[ "$(digest /ksrc/out/certs/.signing_key.pem.cmd)" = "$pem_cmd_sha" ] || fail "Kbuild changed the D4 PEM command"
[ "$(digest /ksrc/out/certs/.signing_key.x509.cmd)" = "$x509_cmd_sha" ] || fail "Kbuild changed the D4 certificate command"

python3 - /ksrc/out/vmlinux /ksrc/out/certs/signing_key.x509 <<'PY'
import sys
kernel = open(sys.argv[1], "rb").read()
certificate = open(sys.argv[2], "rb").read()
count = kernel.count(certificate)
if count != 1:
    raise SystemExit(f"D4 certificate occurs {count} times in vmlinux, expected exactly once")
PY

actual_release=$(sed -n 's/^#define UTS_RELEASE "\(.*\)"$/\1/p' /ksrc/out/include/generated/utsrelease.h)
[ "$actual_release" = "$expected_release" ] || fail "kernel release mismatch: got $actual_release, expected $expected_release"

cp /ksrc/out/arch/arm64/boot/Image /out/Image
cp /ksrc/out/arch/arm64/boot/Image.lz4 /out/Image.lz4
cp /ksrc/out/.config /out/config
strings /ksrc/out/vmlinux | grep -m1 -E '^Linux version .* #[0-9]+ ' > /out/version.txt || true
cat /ksrc/out/include/generated/utsrelease.h >> /out/version.txt
llvm-readelf -n /ksrc/out/vmlinux > /out/vmlinux-notes.txt

if [ -n "$expected_image_sha" ]; then
  [ "$(digest /out/Image.lz4)" = "$expected_image_sha" ] || fail "Image.lz4 sha256 differs from the recorded candidate"
  [ "$(stat -c %s /out/Image.lz4)" = "$expected_image_size" ] || fail "Image.lz4 size differs from the recorded candidate"
fi

rm -f /ksrc/out/certs/signing_key.pem
echo "built commit $commit from tree $upstream_tree to patched tree $patched_tree"
