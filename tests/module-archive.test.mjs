import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assembler = path.join(projectRoot, "tools", "assemble-module.py");
const moduleRoot = path.join(projectRoot, "module");
const toolchainProvenance = path.join(projectRoot, "tools", "aarch64-musl-toolchain.json");
const muslLicense = path.join(projectRoot, "tools", "licenses", "musl-COPYRIGHT");
const engineConfig = path.join(projectRoot, "tools", "engine.json");
const buildsConfig = path.join(projectRoot, "kernel", "builds.json");
const dockerdScript = path.join(projectRoot, "android", "dockerd.sh");
const buildkitRuncScript = path.join(projectRoot, "android", "buildkit-runc.sh");
const python = process.env.PYTHON || "python3";
const engineRuntimeNames = [
  "containerd",
  "containerd-shim-runc-v2",
  "ctr",
  "docker",
  "docker-init",
  "docker-proxy",
  "dockerd",
  "runc",
];
const packagedRuntimePaths = new Map([
  ["buildkit-runc.sh", "bin/buildkit-runc.sh"],
  ["dockerd.sh", "bin/dockerd.sh"],
  ["hostctl", "bin/hostctl"],
  ["privns", "bin/privns"],
  ["route-policy", "bin/route-policy"],
]);

function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function writeProgramHeader(buffer, offset, {
  type,
  flags = 0,
  fileOffset = 0,
  fileSize = 0,
  memorySize = fileSize,
  alignment = 1,
}) {
  buffer.writeUInt32LE(type, offset);
  buffer.writeUInt32LE(flags, offset + 4);
  buffer.writeBigUInt64LE(BigInt(fileOffset), offset + 8);
  buffer.writeBigUInt64LE(0n, offset + 16);
  buffer.writeBigUInt64LE(0n, offset + 24);
  buffer.writeBigUInt64LE(BigInt(fileSize), offset + 32);
  buffer.writeBigUInt64LE(BigInt(memorySize), offset + 40);
  buffer.writeBigUInt64LE(BigInt(alignment), offset + 48);
}

function syntheticElf({ machine = 183, interpreter = false, needed = false } = {}) {
  const programCount = 1 + Number(interpreter) + Number(needed);
  const buffer = Buffer.alloc(512);
  buffer.set(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), 0);
  buffer.writeUInt16LE(2, 16);
  buffer.writeUInt16LE(machine, 18);
  buffer.writeUInt32LE(1, 20);
  buffer.writeBigUInt64LE(0n, 24);
  buffer.writeBigUInt64LE(64n, 32);
  buffer.writeBigUInt64LE(0n, 40);
  buffer.writeUInt32LE(0, 48);
  buffer.writeUInt16LE(64, 52);
  buffer.writeUInt16LE(56, 54);
  buffer.writeUInt16LE(programCount, 56);
  buffer.writeUInt16LE(0, 58);
  buffer.writeUInt16LE(0, 60);
  buffer.writeUInt16LE(0, 62);

  writeProgramHeader(buffer, 64, {
    type: 1,
    flags: 5,
    fileOffset: 0,
    fileSize: buffer.length,
    alignment: 4096,
  });
  let headerOffset = 120;
  if (interpreter) {
    const value = Buffer.from("/lib/ld-musl-aarch64.so.1\0");
    value.copy(buffer, 384);
    writeProgramHeader(buffer, headerOffset, {
      type: 3,
      fileOffset: 384,
      fileSize: value.length,
    });
    headerOffset += 56;
  }
  if (needed) {
    buffer.writeBigInt64LE(1n, 416);
    buffer.writeBigUInt64LE(1n, 424);
    buffer.writeBigInt64LE(0n, 432);
    buffer.writeBigUInt64LE(0n, 440);
    writeProgramHeader(buffer, headerOffset, {
      type: 2,
      fileOffset: 416,
      fileSize: 32,
      alignment: 8,
    });
  }
  return buffer;
}

function makeFixture(prefix = "module-archive-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const moduleSource = path.join(root, "module");
  const binaries = path.join(root, "binaries");
  fs.cpSync(moduleRoot, moduleSource, { recursive: true });
  fs.mkdirSync(binaries);
  const tools = {
    patchEngine: path.join(binaries, "patch-engine"),
    swapBootKernel: path.join(binaries, "swap-boot-kernel"),
    privns: path.join(binaries, "privns"),
    routePolicy: path.join(binaries, "route-policy"),
  };
  for (const tool of Object.values(tools)) {
    fs.writeFileSync(tool, syntheticElf(), { mode: 0o755 });
  }
  return { root, moduleSource, tools };
}

function assemble(item, output, overrides = {}) {
  const values = {
    moduleSource: item.moduleSource,
    patchEngine: item.tools.patchEngine,
    swapBootKernel: item.tools.swapBootKernel,
    privns: item.tools.privns,
    routePolicy: item.tools.routePolicy,
    toolchainProvenance,
    muslLicense,
    engineConfig,
    buildsConfig,
    dockerdScript,
    buildkitRuncScript,
    installable: true,
    ...overrides,
  };
  const args = [
    assembler,
    ...(values.installable ? ["--installable"] : []),
    "--module-source", values.moduleSource,
    "--patch-engine", values.patchEngine,
    "--swap-boot-kernel", values.swapBootKernel,
    "--privns", values.privns,
    "--route-policy", values.routePolicy,
    "--toolchain-provenance", values.toolchainProvenance,
    "--musl-license", values.muslLicense,
    "--engine-config", values.engineConfig,
    "--builds-config", values.buildsConfig,
    "--dockerd-script", values.dockerdScript,
    "--buildkit-runc-script", values.buildkitRuncScript,
    "--output", output,
  ];
  return spawnSync(python, args, { encoding: "utf8", timeout: 10_000 });
}

function inspectArchive(archive) {
  const script = String.raw`
import base64
import json
import stat
import sys
import zipfile

result = []
with zipfile.ZipFile(sys.argv[1], "r") as archive:
    for info in archive.infolist():
        result.append({
            "name": info.filename,
            "data": base64.b64encode(archive.read(info)).decode("ascii"),
            "time": list(info.date_time),
            "mode": "%04o" % ((info.external_attr >> 16) & 0o7777),
            "fileType": stat.S_IFMT(info.external_attr >> 16),
            "createSystem": info.create_system,
            "compression": info.compress_type,
            "extra": base64.b64encode(info.extra).decode("ascii"),
        })
print(json.dumps(result, separators=(",", ":")))
`;
  const result = spawnSync(python, ["-c", script, archive], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).map((entry) => ({
    ...entry,
    contents: Buffer.from(entry.data, "base64"),
  }));
}

test("assembler produces a sorted byte-reproducible installable module with an exact manifest", () => {
  const item = makeFixture();
  try {
    const first = path.join(item.root, "first.zip");
    const second = path.join(item.root, "second.zip");
    let result = assemble(item, first);
    assert.equal(result.status, 0, result.stderr);
    result = assemble(item, second);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readFileSync(first), fs.readFileSync(second));
    assert.equal(fs.statSync(first).mode & 0o777, 0o644);

    const archive = inspectArchive(first);
    const names = archive.map((entry) => entry.name);
    assert.deepEqual(names, names.toSorted());
    assert.equal(new Set(names).size, names.length);
    assert.equal(names.includes("META-INF/com/google/android/update-binary"), false);
    assert.deepEqual(
      [
        "LICENSE",
        "LICENSES/musl-COPYRIGHT",
        "MODULE-MANIFEST.json",
        "NOTICE.md",
        "action.sh",
        "bin/buildkit-runc.sh",
        "bin/dockerd.sh",
        "bin/hostctl",
        "bin/install-host",
        "bin/install-preflight",
        "bin/kernelctl",
        "bin/patch-engine",
        "bin/prepare-engine",
        "bin/prepare-kernel",
        "bin/privns",
        "bin/route-policy",
        "bin/release-transaction",
        "bin/swap-boot-kernel",
        "boot-completed.sh",
        "builds.json",
        "customize.sh",
        "engine.json",
        "host.conf.default",
        "installer-inputs.tsv",
        "module.prop",
        "provenance/toolchain.json",
        "release-manifest.tsv",
        "service.sh",
        "uninstall.sh",
      ].filter((name) => !names.includes(name)),
      [],
    );
    for (const entry of archive) {
      assert.deepEqual(entry.time, [1980, 1, 1, 0, 0, 0], entry.name);
      assert.equal(entry.fileType, 0o100000, entry.name);
      assert.equal(entry.createSystem, 3, entry.name);
      assert.equal(entry.compression, 0, entry.name);
      assert.equal(entry.extra, "", entry.name);
      assert.equal(entry.name.startsWith("/"), false, entry.name);
      assert.equal(entry.name.split("/").includes(".."), false, entry.name);
      assert.equal(entry.name.includes("\\"), false, entry.name);
    }

    const byName = new Map(archive.map((entry) => [entry.name, entry]));
    assert.deepEqual(byName.get("engine.json").contents, fs.readFileSync(engineConfig));
    assert.deepEqual(byName.get("builds.json").contents, fs.readFileSync(path.join(projectRoot, "kernel", "builds.json")));
    assert.deepEqual(byName.get("LICENSE").contents, fs.readFileSync(path.join(projectRoot, "LICENSE")));
    assert.deepEqual(byName.get("NOTICE.md").contents, fs.readFileSync(path.join(projectRoot, "NOTICE.md")));
    assert.deepEqual(byName.get("provenance/toolchain.json").contents, fs.readFileSync(toolchainProvenance));
    assert.deepEqual(byName.get("LICENSES/musl-COPYRIGHT").contents, fs.readFileSync(muslLicense));
    assert.deepEqual(byName.get("bin/dockerd.sh").contents, fs.readFileSync(dockerdScript));
    assert.deepEqual(byName.get("bin/buildkit-runc.sh").contents, fs.readFileSync(buildkitRuncScript));
    assert.deepEqual(byName.get("customize.sh").contents, fs.readFileSync(path.join(moduleRoot, "customize.sh")));
    assert.match(
      byName.get("customize.sh").contents.toString("utf8"),
      /INSTALL_HOST_OUTPUT=\$\(KSU="\$KSU" BOOTMODE="\$BOOTMODE" ARCH="\$ARCH" \\\n\s+KSU_VER="\$KSU_VER" KSU_VER_CODE="\$KSU_VER_CODE" \\\n\s+KSU_RUNTIME_MODE="\$KSU_RUNTIME_MODE" TMPDIR="\$TMPDIR" \\\n\s+"\$MODPATH\/bin\/install-host" 2>&1\)/,
    );

    const engine = JSON.parse(fs.readFileSync(engineConfig, "utf8"));
    const expectedRows = [];
    for (const name of [...engineRuntimeNames, ...packagedRuntimePaths.keys()].toSorted()) {
      if (engineRuntimeNames.includes(name)) {
        const record = engine.binaries[name];
        expectedRows.push(`${name}\t${record.size}\t${record.sha256}\t0755`);
      } else {
        const payload = byName.get(packagedRuntimePaths.get(name));
        assert.ok(payload, name);
        assert.equal(payload.mode, "0755", name);
        expectedRows.push(`${name}\t${payload.contents.length}\t${sha256(payload.contents)}\t0755`);
      }
    }
    assert.equal(
      byName.get("release-manifest.tsv").contents.toString("ascii"),
      `RELEASE_MANIFEST_VERSION=1\n${expectedRows.join("\n")}\n`,
    );
    assert.equal(byName.get("release-manifest.tsv").mode, "0644");

    const moduleProperties = new Map(
      byName.get("module.prop").contents.toString("utf8").trimEnd().split("\n")
        .map((line) => line.split("=", 2)),
    );
    const builds = JSON.parse(byName.get("builds.json").contents);
    const installerRows = [
      "INSTALLER_INPUTS_VERSION=1",
      `MODULE\t${moduleProperties.get("version")}\t${moduleProperties.get("versionCode")}`,
      [
        "ENGINE",
        engine.engine.version,
        path.posix.basename(new URL(engine.engine.tarball.url).pathname),
        engine.engine.tarball.size,
        engine.engine.tarball.sha256,
        engine.engine.tarball.url,
      ].join("\t"),
      ...engine.rules.map((rule, index) => ["RULE", index, rule.from, rule.to].join("\t")),
      ...engineRuntimeNames.toSorted().map((name) => {
        const record = engine.binaries[name];
        const counts = engine.rules.map((rule) => record.replacements[rule.from] ?? 0);
        return [
          "BINARY", name, record.size, record.inputSha256, record.sha256,
          Object.keys(record.replacements).length > 0 ? 1 : 0,
          ...counts,
        ].join("\t");
      }),
      ...builds.builds.toSorted((left, right) => left.buildId.localeCompare(right.buildId, "en", { sensitivity: "variant" }))
        .map((build) => [
          "BUILD", build.buildId, build.device.codename, build.device.buildFingerprint,
          build.device.androidVersion, build.device.securityPatch, build.kernel.release,
          build.boot.partitionSize, build.boot.pageSize, build.boot.headerVersion,
          build.boot.headerSize, build.boot.ramdiskSize, build.candidateImage.name,
        ].join("\t")),
      ...builds.builds.flatMap((build) => build.kernelSuNext.testedVersions.map((version) =>
        ["KSU", build.buildId, "lkm", version].join("\t"),
      )).toSorted(),
      ...builds.builds.flatMap((build) => [
        ...build.boot.acceptedInputs.map((input) => [
          "BOOT_STATE", build.buildId, input.role, input.payload.size,
          input.payload.sha256, input.partition.size, input.partition.sha256,
        ].join("\t")),
        [
          "BOOT_STATE", build.buildId, "current-public", build.candidateImage.size,
          build.candidateImage.sha256, build.boot.partitionSize,
          build.boot.candidateOutputPartitionSha256,
        ].join("\t"),
      ]).toSorted(),
    ];
    assert.equal(
      byName.get("installer-inputs.tsv").contents.toString("ascii"),
      `${installerRows.join("\n")}\n`,
    );
    assert.equal(byName.get("installer-inputs.tsv").mode, "0644");
    for (const name of engineRuntimeNames) {
      assert.equal(names.includes(`bin/${name}`), false, `engine payload leaked into archive: ${name}`);
    }

    const manifest = JSON.parse(byName.get("MODULE-MANIFEST.json").contents);
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.artifact, "eip-pixel11xl-forge-module");
    assert.equal(manifest.installable, true);
    assert.equal(manifest.manifestPath, "MODULE-MANIFEST.json");
    assert.equal(manifest.module.id, "eip-pixel11xl-forge");
    assert.doesNotMatch(manifest.module.version, /-dev$/);
    const manifestedNames = manifest.entries.map((entry) => entry.path);
    assert.deepEqual(manifestedNames, names.filter((name) => name !== "MODULE-MANIFEST.json"));
    for (const record of manifest.entries) {
      const actual = byName.get(record.path);
      assert.ok(actual, record.path);
      assert.deepEqual(Object.keys(record).toSorted(), ["mode", "path", "sha256", "size", "type"]);
      assert.equal(record.type, "file");
      assert.equal(record.size, actual.contents.length, record.path);
      assert.equal(record.sha256, sha256(actual.contents), record.path);
      assert.equal(record.mode, actual.mode, record.path);
    }
    assert.equal(byName.get("bin/patch-engine").mode, "0755");
    assert.equal(byName.get("bin/swap-boot-kernel").mode, "0755");
    assert.equal(byName.get("bin/privns").mode, "0755");
    assert.equal(byName.get("bin/route-policy").mode, "0755");
    assert.equal(byName.get("bin/dockerd.sh").mode, "0755");
    assert.equal(byName.get("bin/buildkit-runc.sh").mode, "0755");
    assert.equal(byName.get("bin/release-transaction").mode, "0755");
    assert.equal(byName.get("bin/install-preflight").mode, "0755");
    assert.equal(byName.get("bin/kernelctl").mode, "0755");
    assert.equal(byName.get("action.sh").mode, "0755");
    assert.equal(byName.get("uninstall.sh").mode, "0755");
    assert.equal(byName.get("module.prop").mode, "0644");
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

for (const [label, mutate, expected] of [
  ["missing engine runtime", (config) => delete config.binaries.ctr, /omits required runtime binary: ctr/],
  ["extra engine runtime", (config) => {
    config.binaries.extra = { ...config.binaries.ctr };
  }, /contains unexpected runtime binary: extra/],
  ["non-positive engine size", (config) => {
    config.binaries.docker.size = 0;
  }, /size must be a positive integer: docker/],
  ["non-canonical engine hash", (config) => {
    config.binaries.docker.sha256 = "A".repeat(64);
  }, /output sha256 is invalid: docker/],
]) {
  test(`assembler refuses a release manifest with ${label}`, () => {
    const item = makeFixture(`module-archive-manifest-${label.replaceAll(" ", "-")}-`);
    try {
      const config = JSON.parse(fs.readFileSync(engineConfig, "utf8"));
      mutate(config);
      const alteredConfig = path.join(item.root, "engine.json");
      fs.writeFileSync(alteredConfig, `${JSON.stringify(config)}\n`);
      const output = path.join(item.root, "unsafe.zip");
      const result = assemble(item, output, { engineConfig: alteredConfig });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expected);
      assert.equal(fs.existsSync(output), false);
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });
}

for (const [label, mutate, expected] of [
  ["revoked build", (_engine, builds) => {
    builds.builds[0].status = "revoked";
  }, /build is not eligible for installer inputs/],
  ["ambiguous observable build", (_engine, builds) => {
    const duplicate = structuredClone(builds.builds[0]);
    duplicate.buildId = "CD1A.260714.001.A10";
    duplicate.candidateImage.name = "Image-CD1A.260714.001.A10.lz4";
    builds.builds.push(duplicate);
  }, /ambiguous observable device identity/],
  ["current-public identity collision", (_engine, builds) => {
    const build = builds.builds[0];
    build.boot.acceptedInputs.push({
      role: "predecessor",
      payload: { size: build.candidateImage.size, sha256: build.candidateImage.sha256 },
      partition: {
        size: build.boot.partitionSize,
        sha256: build.boot.candidateOutputPartitionSha256,
      },
    });
  }, /current-public boot identity duplicates an accepted input/],
  ["one full boot identity mapped to different payloads", (_engine, builds) => {
    const build = builds.builds[0];
    const stock = build.boot.acceptedInputs[0];
    build.boot.acceptedInputs.push({
      role: "predecessor",
      payload: { size: stock.payload.size, sha256: "a".repeat(64) },
      partition: structuredClone(stock.partition),
    });
  }, /maps one full boot identity to multiple payloads/],
  ["unknown engine replacement rule", (engine) => {
    engine.binaries.dockerd.replacements["/unknown"] = 1;
  }, /names an unknown replacement rule/],
  ["unsupported KernelSU runtime mode", (_engine, builds) => {
    builds.builds[0].kernelSuNext.installationMode = "GKI";
  }, /supports only the LKM KernelSU mode/],
]) {
  test(`assembler refuses installer inputs with ${label}`, () => {
    const item = makeFixture(`module-archive-installer-${label.replaceAll(/[^a-z]+/gi, "-")}-`);
    try {
      const engine = JSON.parse(fs.readFileSync(engineConfig, "utf8"));
      const builds = JSON.parse(fs.readFileSync(buildsConfig, "utf8"));
      mutate(engine, builds);
      const alteredEngine = path.join(item.root, "engine.json");
      const alteredBuilds = path.join(item.root, "builds.json");
      fs.writeFileSync(alteredEngine, `${JSON.stringify(engine)}\n`);
      fs.writeFileSync(alteredBuilds, `${JSON.stringify(builds)}\n`);
      const output = path.join(item.root, "unsafe.zip");
      const result = assemble(item, output, {
        engineConfig: alteredEngine,
        buildsConfig: alteredBuilds,
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expected);
      assert.equal(fs.existsSync(output), false);
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });
}

test("assembler requires explicit installable intent", () => {
  const item = makeFixture("module-archive-installable-flag-");
  try {
    const output = path.join(item.root, "implicit.zip");
    const result = assemble(item, output, { installable: false });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /without --installable/);
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test("assembler refuses a disabled installer handoff or exit in sourced customize", () => {
  const item = makeFixture("module-archive-customize-");
  try {
    const customize = path.join(item.moduleSource, "customize.sh");
    const original = fs.readFileSync(customize, "utf8");
    const mutations = [
      ["handoff-removed", original.replace(
        '"$MODPATH/bin/install-host" 2>&1)',
        "INSTALL_HOST_OUTPUT=disabled",
      )],
      ["early-exit", original.replace("#!/system/bin/sh\n", "#!/system/bin/sh\nexit 0\n")],
    ];
    for (const [label, contents] of mutations) {
      fs.writeFileSync(customize, contents);
      const output = path.join(item.root, `${label}.zip`);
      const result = assemble(item, output);
      assert.notEqual(result.status, 0, label);
      assert.match(result.stderr, /does not invoke the bounded install-host subprocess|must use abort rather than exit/, label);
      assert.equal(fs.existsSync(output), false, label);
    }
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test("assembler refuses a development-only module version", () => {
  const item = makeFixture("module-archive-development-version-");
  try {
    const properties = path.join(item.moduleSource, "module.prop");
    fs.writeFileSync(
      properties,
      fs.readFileSync(properties, "utf8").replace("version=0.1.0-rc.3", "version=0.1.0-dev"),
    );
    const output = path.join(item.root, "development.zip");
    const result = assemble(item, output);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must not use a development-only version/);
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

for (const [label, elf, expected] of [
  ["wrong architecture", syntheticElf({ machine: 62 }), /not AArch64 ELF/],
  ["PT_INTERP", syntheticElf({ interpreter: true }), /has PT_INTERP and is not static/],
  ["DT_NEEDED", syntheticElf({ needed: true }), /has DT_NEEDED and is not static/],
]) {
  test(`assembler refuses a ${label} helper`, () => {
    const item = makeFixture(`module-archive-${label.toLowerCase().replaceAll(/[^a-z]+/g, "-")}-`);
    try {
      fs.writeFileSync(item.tools.patchEngine, elf);
      const output = path.join(item.root, "unsafe.zip");
      const result = assemble(item, output);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expected);
      assert.equal(fs.existsSync(output), false);
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });
}

test("assembler refuses unsafe or unexpected module members", () => {
  for (const [label, mutate, expected] of [
    ["symlink", (item) => fs.symlinkSync("module.prop", path.join(item.moduleSource, "linked.prop")), /contains a symlink/],
    ["special", (item) => {
      const result = spawnSync("mkfifo", [path.join(item.moduleSource, "fifo")], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }, /contains a special file/],
    ["unsafe name", (item) => fs.writeFileSync(path.join(item.moduleSource, "escape\\member"), "bad\n"), /unsafe archive member path/],
    ["ordinary junk", (item) => fs.writeFileSync(path.join(item.moduleSource, "stray.txt"), "junk\n"), /unexpected module source member: stray\.txt/],
    ["alternate installer", (item) => {
      const installer = path.join(item.moduleSource, "META-INF", "com", "google", "android");
      fs.mkdirSync(installer, { recursive: true });
      fs.writeFileSync(path.join(installer, "update-binary"), "#!/system/bin/sh\n");
    }, /unexpected module source member: META-INF\/com\/google\/android\/update-binary/],
  ]) {
    const item = makeFixture(`module-archive-${label.replaceAll(" ", "-")}-`);
    try {
      mutate(item);
      const output = path.join(item.root, "unsafe.zip");
      const result = assemble(item, output);
      assert.notEqual(result.status, 0, `${label}: ${result.stderr}`);
      assert.match(result.stderr, expected);
      assert.equal(fs.existsSync(output), false);
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  }
});

test("assembler refuses a musl license that does not match provenance", () => {
  const item = makeFixture("module-archive-license-");
  try {
    const alteredLicense = path.join(item.root, "musl-COPYRIGHT");
    fs.writeFileSync(alteredLicense, Buffer.concat([fs.readFileSync(muslLicense), Buffer.from("tampered\n")]));
    const output = path.join(item.root, "tampered-license.zip");
    const result = assemble(item, output, { muslLicense: alteredLicense });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /musl license size does not match toolchain provenance/);
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test("assembler never replaces an existing or dangling output", () => {
  const item = makeFixture("module-archive-output-");
  try {
    const existing = path.join(item.root, "existing.zip");
    fs.writeFileSync(existing, "sentinel\n");
    let result = assemble(item, existing);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exists; refusing to overwrite/);
    assert.equal(fs.readFileSync(existing, "utf8"), "sentinel\n");

    const dangling = path.join(item.root, "dangling.zip");
    fs.symlinkSync("missing-target", dangling);
    result = assemble(item, dangling);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exists; refusing to overwrite/);
    assert.equal(fs.readlinkSync(dangling), "missing-target");
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});
