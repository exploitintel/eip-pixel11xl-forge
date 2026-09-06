import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const metadataPath = path.join(projectRoot, "tools", "aarch64-musl-toolchain.json");
const builderPath = path.join(projectRoot, "tools", "build-module-tools.sh");
const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));

test("the AArch64 musl SDK has a complete immutable provenance pin", () => {
  assert.equal(metadata.schemaVersion, 1);
  assert.deepEqual(metadata.identity.host, { os: "linux", architecture: "x86_64" });
  assert.deepEqual(metadata.identity.target, {
    architecture: "aarch64",
    elfClass: "ELF64",
    elfMachine: "AArch64",
    toolPrefix: "aarch64-buildroot-linux-musl",
  });
  assert.equal(metadata.archive.name, "aarch64--musl--stable-2025.08-1.tar.xz");
  assert.equal(path.posix.basename(new URL(metadata.archive.url).pathname), metadata.archive.name);
  assert.equal(metadata.archive.size, 81430896);
  assert.equal(metadata.archive.sha256, "defba831ffa1175236f137069333e21ed46d4d19feb5080a90cf248b6fc2cb08");
  assert.equal(metadata.archive.topLevelDirectory, "aarch64--musl--stable-2025.08-1");

  assert.equal(metadata.components.gcc.version, "14.3.0");
  assert.equal(metadata.components.binutils.version, "2.43.1");
  assert.equal(metadata.components.musl.version, "1.2.5");
  assert.equal(metadata.components.linuxHeaders.version, "5.4.296");
  assert.equal(metadata.provenance.sourceCommit, "83947c7bb6158072bc2f52b58e90891cd3dc04a2");
  assert.match(metadata.provenance.summary.sha256, /^[0-9a-f]{64}$/);
  assert.ok(metadata.provenance.summary.size > 0);

  for (const value of [
    metadata.archive.url,
    metadata.provenance.releasePage,
    metadata.provenance.checksumUrl,
    metadata.provenance.summary.url,
    metadata.provenance.sourceRepository,
    metadata.licenses.musl.url,
  ]) {
    assert.equal(new URL(value).protocol, "https:");
  }
  for (const value of Object.values(metadata.paths)) {
    assert.equal(path.posix.isAbsolute(value), false);
    assert.equal(value.split("/").includes(".."), false);
  }
});

test("the musl notice is byte-bound to its archive destination", () => {
  assert.deepEqual(metadata.licenses.musl, {
    version: "1.2.5",
    spdx: "MIT",
    url: "https://toolchains.bootlin.com/downloads/releases/licenses/musl-1.2.5/COPYRIGHT",
    size: 6204,
    sha256: "f9bc4423732350eb0b3f7ed7e91d530298476f8fec0c6c427a1c04ade22655af",
    archivePath: "LICENSES/musl-COPYRIGHT",
  });
});

function verifierFixture(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "module-elf-verifier-"));
  const readelf = path.join(root, "readelf");
  const binary = path.join(root, "helper");
  fs.writeFileSync(binary, "synthetic ELF input; readelf is a controlled fixture\n");
  fs.writeFileSync(readelf, `#!/bin/sh
[ -z "\${CPATH+x}\${C_INCLUDE_PATH+x}\${CPLUS_INCLUDE_PATH+x}\${OBJC_INCLUDE_PATH+x}" ] || exit 90
[ -z "\${GCC_EXEC_PREFIX+x}\${COMPILER_PATH+x}\${LIBRARY_PATH+x}" ] || exit 90
[ -z "\${GCC_COMPARE_DEBUG+x}\${COLLECT_GCC_OPTIONS+x}" ] || exit 90
[ -z "\${LD_PRELOAD+x}\${LD_LIBRARY_PATH+x}\${LD_AUDIT+x}\${TAR_OPTIONS+x}" ] || exit 90
case "$1" in
  -hW)
    if [ "${mode}" = wrong-class ]; then class=ELF32; else class=ELF64; fi
    if [ "${mode}" = wrong-machine ]; then machine='Advanced Micro Devices X86-64'; else machine=AArch64; fi
    printf '  Class:                             %s\\n' "$class"
    printf '  Machine:                           %s\\n' "$machine"
    ;;
  -lW)
    if [ "${mode}" = interp ]; then printf '  INTERP         0x000000\\n'; else printf '  LOAD           0x000000\\n'; fi
    ;;
  -dW)
    if [ "${mode}" = needed ]; then printf ' 0x0000000000000001 (NEEDED) Shared library: [libc.so]\\n'; else printf 'There is no dynamic section in this file.\\n'; fi
    ;;
  *) exit 2 ;;
esac
`);
  fs.chmodSync(readelf, 0o755);
  return { root, readelf, binary };
}

function verifyFixture(mode) {
  const fixture = verifierFixture(mode);
  try {
    return spawnSync(builderPath, ["verify-elf", "--readelf", fixture.readelf, fixture.binary], {
      cwd: projectRoot,
      encoding: "utf8",
    });
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

test("the ELF verifier accepts only static ELF64 AArch64 outputs", () => {
  const valid = verifyFixture("valid");
  assert.equal(valid.status, 0, valid.stderr);

  for (const [mode, message] of [
    ["wrong-class", /ELF class is not ELF64/],
    ["wrong-machine", /ELF machine is not AArch64/],
    ["interp", /PT_INTERP is forbidden/],
    ["needed", /DT_NEEDED is forbidden/],
  ]) {
    const result = verifyFixture(mode);
    assert.notEqual(result.status, 0, `${mode} should be rejected`);
    assert.match(result.stderr, message);
  }
});

test("the build clears ambient compiler, loader, and archive injection variables", () => {
  const fixture = verifierFixture("valid");
  try {
    const environment = { ...process.env };
    for (const name of [
      "CPATH",
      "C_INCLUDE_PATH",
      "CPLUS_INCLUDE_PATH",
      "OBJC_INCLUDE_PATH",
      "GCC_EXEC_PREFIX",
      "COMPILER_PATH",
      "LIBRARY_PATH",
      "GCC_COMPARE_DEBUG",
      "COLLECT_GCC_OPTIONS",
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "LD_AUDIT",
      "TAR_OPTIONS",
    ]) {
      environment[name] = path.join(fixture.root, "ambient-injection");
    }

    const negativeControl = spawnSync(
      fixture.readelf,
      ["-hW", "--", fixture.binary],
      { encoding: "utf8", env: environment },
    );
    assert.equal(negativeControl.status, 90);

    const sanitized = spawnSync(
      builderPath,
      ["verify-elf", "--readelf", fixture.readelf, fixture.binary],
      { cwd: projectRoot, encoding: "utf8", env: environment },
    );
    assert.equal(sanitized.status, 0, sanitized.stderr);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("the build path is create-only, transactional, and reproducibility-scoped", () => {
  const source = fs.readFileSync(builderPath, "utf8");
  assert.match(source, /\[ ! -e "\$out" \] && \[ ! -L "\$out" \]/);
  assert.match(source, /mktemp -d "\$\(dirname "\$out"\)\/\.module-tools\.XXXXXX"/);
  assert.match(source, /mv --no-clobber --no-target-directory "\$staging" "\$out"/);
  assert.match(source, /SOURCE_DATE_EPOCH=0/);
  assert.match(source, /-frandom-seed="\$name"/);
  assert.match(source, /-static/);
  assert.match(source, /PT_INTERP is forbidden/);
  assert.match(source, /DT_NEEDED is forbidden/);
  assert.match(source, /sources=\(patch-engine swap-boot-kernel privns route-policy\)/);
});
