import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tool = path.join(projectRoot, "tools", "oci-image-info.py");
const tarOptions = { encoding: "utf8", env: { ...process.env, COPYFILE_DISABLE: "1" } };

function canonical(value) {
  return Buffer.from(JSON.stringify(value));
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

test("OCI verification binds platform, manifest, config, and blob bytes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oci-info-"));
  try {
    const layout = path.join(root, "layout");
    const blobs = path.join(layout, "blobs", "sha256");
    fs.mkdirSync(blobs, { recursive: true });
    const configBytes = canonical({ architecture: "arm64", os: "linux", created: "2026-09-05T12:18:50Z" });
    const configHash = sha256(configBytes);
    fs.writeFileSync(path.join(blobs, configHash), configBytes);
    const manifestBytes = canonical({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: `sha256:${configHash}`, size: configBytes.length },
      layers: [],
    });
    const manifestHash = sha256(manifestBytes);
    fs.writeFileSync(path.join(blobs, manifestHash), manifestBytes);
    fs.writeFileSync(path.join(layout, "oci-layout"), '{"imageLayoutVersion":"1.0.0"}\n');
    fs.writeFileSync(path.join(layout, "index.json"), JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [{
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: `sha256:${manifestHash}`,
        size: manifestBytes.length,
        platform: { os: "linux", architecture: "arm64" },
        annotations: {
          "io.containerd.image.name": "docker.io/library/eip-pixel11xl-forge-buildenv:test",
          "org.opencontainers.image.ref.name": "test",
        },
      }],
    }));
    const archive = path.join(root, "image.oci.tar");
    const packed = spawnSync("tar", ["-cf", archive, "-C", layout, "oci-layout", "index.json", "blobs"], tarOptions);
    assert.equal(packed.status, 0, packed.stderr);

    const ok = spawnSync(tool, [archive, "--expect-platform", "linux/arm64", "--expect-manifest", `sha256:${manifestHash}`, "--expect-config", `sha256:${configHash}`, "--require-safe-ref"], { encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(JSON.parse(ok.stdout), {
      manifest_digest: `sha256:${manifestHash}`,
      config_digest: `sha256:${configHash}`,
      platform: "linux/arm64",
      created: "2026-09-05T12:18:50Z",
      ref_name: "eip-pixel11xl-forge-buildenv:test",
    });

    const wrong = spawnSync(tool, [archive, "--expect-config", `sha256:${"0".repeat(64)}`], { encoding: "utf8" });
    assert.notEqual(wrong.status, 0);
    assert.match(wrong.stderr, /config mismatch/);

    const unsafeIndex = JSON.parse(fs.readFileSync(path.join(layout, "index.json"), "utf8"));
    unsafeIndex.manifests[0].annotations = {
      "io.containerd.image.name": "docker.io/library/victim:latest",
      "org.opencontainers.image.ref.name": "latest",
    };
    fs.writeFileSync(path.join(layout, "index.json"), JSON.stringify(unsafeIndex));
    const unsafeArchive = path.join(root, "unsafe.oci.tar");
    const repacked = spawnSync("tar", ["-cf", unsafeArchive, "-C", layout, "oci-layout", "index.json", "blobs"], tarOptions);
    assert.equal(repacked.status, 0, repacked.stderr);
    const unsafe = spawnSync(tool, [unsafeArchive, "--require-safe-ref"], { encoding: "utf8" });
    assert.notEqual(unsafe.status, 0);
    assert.match(unsafe.stderr, /unsafe|missing|load ref/);

    unsafeIndex.manifests[0].annotations = {
      "io.containerd.image.name": "docker.io/library/eip-pixel11xl-forge-buildenv:test",
      "org.opencontainers.image.ref.name": "test",
    };
    fs.writeFileSync(path.join(layout, "index.json"), JSON.stringify(unsafeIndex));
    fs.writeFileSync(path.join(layout, "manifest.json"), "[]\n");
    const legacyArchive = path.join(root, "legacy.oci.tar");
    const legacyPacked = spawnSync("tar", ["-cf", legacyArchive, "-C", layout, "oci-layout", "index.json", "blobs", "manifest.json"], tarOptions);
    assert.equal(legacyPacked.status, 0, legacyPacked.stderr);
    const legacy = spawnSync(tool, [legacyArchive, "--require-safe-ref"], { encoding: "utf8" });
    assert.notEqual(legacy.status, 0);
    assert.match(legacy.stderr, /inventory mismatch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
