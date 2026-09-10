#!/usr/bin/env bash
# Fail closed when private material or unexpected top-level content enters Git.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
fail() { echo "check-public-tree.sh: $*" >&2; exit 1; }
digest() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || fail "repository is not a Git work tree"

candidate_paths=$(mktemp "${TMPDIR:-/tmp}/eip-public-candidates.XXXXXX")
scan_paths=$(mktemp "${TMPDIR:-/tmp}/eip-public-scan.XXXXXX")
trap 'rm -f "$candidate_paths" "$scan_paths"' EXIT

# The candidate is every tracked file plus every non-ignored untracked file.
# In particular, Git still reports an ignored file that was added with -f.
git ls-files -z --cached --others --exclude-standard > "$candidate_paths"
while IFS= read -r -d '' file; do
  fail "tracked cache path: $file"
done < <(git ls-files -z --cached -- .cache)

cp "$candidate_paths" "$scan_paths"
# Preserve the local-tree safety check for ignored files outside disposable
# build/output directories. This catches, for example, a local stock image
# even before anybody tries to add it.
while IFS= read -r -d '' file; do
  case "$file" in
    .cache/*|out/*|dist/*|.work/*) continue ;;
  esac
  printf '%s\0' "$file"
done < <(git ls-files -z --others --ignored --exclude-standard) >> "$scan_paths"

for forbidden in .private stock artifacts baseline PLAN.md PACKAGING-PLAN.md PROVENANCE.md; do
  [ ! -e "$forbidden" ] || fail "forbidden public path: $forbidden"
done

allowed_top='^(\.github|android|android-app|deployment|docs|eip|kernel|module|schemas|tests|tools|\.gitignore|AGENTS\.md|CLAUDE\.md|FORGE_REVISION|LICENSE|NOTICE\.md|README\.md|package\.json)$'
while IFS= read -r entry; do
  [[ "$entry" =~ $allowed_top ]] || fail "unexpected top-level path: $entry"
done < <(find . -mindepth 1 -maxdepth 1 ! -name .git ! -name .cache -exec basename {} \; | LC_ALL=C sort)

while IFS= read -r -d '' file; do
  [ -e "$file" ] || [ -L "$file" ] || continue
  [ ! -L "$file" ] || fail "symlink in public candidate: $file"
  [ -f "$file" ] || fail "non-regular file in public candidate: $file"
  top=${file%%/*}
  [[ "$top" =~ $allowed_top ]] || fail "unexpected candidate top-level path: $top"
  case "$file" in
    *.img|*.jks|*.keystore|*.p12|*.env|*.env.*|*/Image|*/Image.lz4)
      [ "$file" = eip/container.build.env ] && continue
      fail "generated, firmware, or credential-shaped file: $file" ;;
  esac
  size=$(wc -c < "$file" | tr -d ' ')
  [ "$size" -le 2097152 ] || fail "unexpected source file over 2 MiB: $file"
done < "$scan_paths"

private_key_path=kernel/keys/reproducibility/signing_key.pem
private_key_sha=8c184c93005ffcbb1bccfd45f01f6049b1d693768735da20c7d744f164fe9524
key_count=0
key_file=
while IFS= read -r -d '' file; do
  [ -f "$file" ] || continue
  if LC_ALL=C grep -IqE -- '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----' "$file"; then
    key_count=$((key_count + 1))
    key_file=$file
  else
    status=$?
    [ "$status" -eq 1 ] || fail "could not scan private-key material in $file"
  fi
done < "$scan_paths"
[ "$key_count" -eq 1 ] && [ "$key_file" = "$private_key_path" ] \
  || fail "unexpected private-key material: ${key_file:-none}"
[ "$(digest "$private_key_path")" = "$private_key_sha" ] || fail "D4 public fixture hash changed"

patterns='/Users/[^/]+/|pixel11-docker/\.private|boot_docker4\.img|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|(^|[^A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}'
while IFS= read -r -d '' file; do
  [ -f "$file" ] || continue
  case "$file" in
    tools/check-public-tree.sh|tools/check-candidate.py) continue ;;
  esac
  if findings=$(LC_ALL=C grep -nIE -- "$patterns" "$file"); then
    echo "$findings" >&2
    fail "private identifier or secret pattern found"
  else
    status=$?
    [ "$status" -eq 1 ] || fail "could not scan secret patterns in $file"
  fi
done < "$scan_paths"

while IFS= read -r -d '' file; do
  [ -f "$file" ] || continue
  description=$(file -b -- "$file") || fail "could not identify file type: $file"
  case "$description" in
    *ELF*|*Mach-O*|*PE32*|*executable*binary*|*Certificate,\ Version=3*) ;;
    *) continue ;;
  esac
  case "$file" in
    kernel/keys/reproducibility/signing_key.x509) ;;
    *) fail "compiled binary in public source tree: $file" ;;
  esac
done < "$scan_paths"

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum --check --strict kernel/UPSTREAM-LICENSES.sha256 >/dev/null
else
  shasum -a 256 -c kernel/UPSTREAM-LICENSES.sha256 >/dev/null
fi

echo "public tree check passed"
