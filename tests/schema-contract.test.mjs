import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildsSchema = JSON.parse(fs.readFileSync(path.join(projectRoot, "kernel", "builds.schema.json"), "utf8"));
const builds = JSON.parse(fs.readFileSync(path.join(projectRoot, "kernel", "builds.json"), "utf8"));
const releaseSchema = JSON.parse(fs.readFileSync(path.join(projectRoot, "schemas", "release-metadata-v1.schema.json"), "utf8"));

function typeMatches(value, expected) {
  return {
    array: Array.isArray(value),
    boolean: typeof value === "boolean",
    integer: Number.isInteger(value),
    null: value === null,
    object: value !== null && typeof value === "object" && !Array.isArray(value),
    string: typeof value === "string",
  }[expected] ?? false;
}

function validate(value, schema, root = schema, location = "$") {
  if (schema.$ref) {
    assert.match(schema.$ref, /^#\//, `${location}: only local refs are supported by the test validator`);
    const target = schema.$ref.slice(2).split("/").reduce((item, part) => item[part], root);
    return validate(value, target, root, location);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    assert.ok(types.some((item) => typeMatches(value, item)), `${location}: wrong type`);
  }
  if (Object.hasOwn(schema, "const")) assert.deepEqual(value, schema.const, `${location}: wrong const`);
  if (schema.enum) assert.ok(schema.enum.some((item) => Object.is(item, value)), `${location}: outside enum`);
  if (typeof value === "string") {
    if (schema.pattern) assert.match(value, new RegExp(schema.pattern), `${location}: pattern mismatch`);
    if (schema.minLength !== undefined) assert.ok(value.length >= schema.minLength, `${location}: too short`);
  }
  if (Number.isInteger(value) && schema.minimum !== undefined) {
    assert.ok(value >= schema.minimum, `${location}: below minimum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined) assert.ok(value.length >= schema.minItems, `${location}: too few items`);
    if (schema.maxItems !== undefined) assert.ok(value.length <= schema.maxItems, `${location}: too many items`);
    if (schema.uniqueItems) {
      const canonical = value.map((item) => JSON.stringify(item));
      assert.equal(new Set(canonical).size, canonical.length, `${location}: duplicate items`);
    }
    if (schema.items) value.forEach((item, index) => validate(item, schema.items, root, `${location}[${index}]`));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const name of schema.required ?? []) assert.ok(Object.hasOwn(value, name), `${location}: missing ${name}`);
    if (schema.additionalProperties === false) {
      const extra = Object.keys(value).filter((name) => !Object.hasOwn(schema.properties ?? {}, name));
      assert.deepEqual(extra, [], `${location}: unexpected properties`);
    }
    for (const [name, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, name)) validate(value[name], propertySchema, root, `${location}.${name}`);
    }
  }
}

function clone(value) {
  return structuredClone(value);
}

test("the complete supported-build document conforms to its checked schema", () => {
  validate(builds, buildsSchema);

  const wrongType = clone(builds);
  wrongType.builds[0].candidateImage.size = "123";
  assert.throws(() => validate(wrongType, buildsSchema), /wrong type/);

  const extra = clone(builds);
  extra.builds[0].builder.unreviewed = true;
  assert.throws(() => validate(extra, buildsSchema), /unexpected properties/);

  const missingScriptLock = clone(builds);
  delete missingScriptLock.builds[0].builder.buildScripts;
  assert.throws(() => validate(missingScriptLock, buildsSchema), /missing buildScripts/);
});

test("release metadata v1 rejects type confusion and non-strict versions", () => {
  const valid = {
    schema_version: 1,
    repository: "example-owner/eip-pixel11xl-forge",
    tag: "v0.1.0",
    source_ref: "refs/tags/v0.1.0",
    commit: "a".repeat(40),
    signer_workflow: "example-owner/eip-pixel11xl-forge/.github/workflows/kernel.yml",
    channel: "prerelease",
    module: { version: "0.1.0", version_code: 1 },
    builds: [{
      build_id: "CD1A.260714.001.A9",
      device: "kodiak",
      build_fingerprint: "google/kodiak/kodiak:17/CD1A.260714.001.A9/15938155:user/release-keys",
    }],
  };
  validate(valid, releaseSchema);

  for (const mutate of [
    (item) => { item.repository = 7; },
    (item) => { item.tag = "v01.2.3"; },
    (item) => { item.source_ref = "refs/tags/v1x.2y.3z"; },
    (item) => { item.module.version = "01.2.3"; },
    (item) => { item.builds[0].build_id = "../unsafe"; },
  ]) {
    const invalid = clone(valid);
    mutate(invalid);
    assert.throws(() => validate(invalid, releaseSchema));
  }
});
