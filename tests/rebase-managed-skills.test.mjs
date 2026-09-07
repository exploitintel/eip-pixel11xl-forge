import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helper = path.join(root, "eip", "rebase-managed-skills.py");
const helperSource = fs.readFileSync(helper, "utf8");
const password = "PHONE_TEST_SECRET=must-not-leak";
const username = "operator";
const csrf = "c".repeat(64);
const oldRevision = "a".repeat(16);
const newRevision = "b".repeat(16);

test("the rebase request outlives Forge v4's bounded 30-second pack validator", () => {
  assert.match(helperSource, /REBASE_TIMEOUT_SECONDS = 60/);
  assert.match(helperSource, /timeout=REBASE_TIMEOUT_SECONDS/);
});

function jsonResponse(response, status, body, headers = {}) {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": encoded.length,
    ...headers,
  });
  response.end(encoded);
}

async function requestBody(request) {
  const parts = [];
  for await (const part of request) parts.push(part);
  return Buffer.concat(parts).toString("utf8");
}

async function runHelper(envFile, env = {}) {
  const child = spawn("python3", [helper, "--env-file", envFile], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { status, stdout, stderr };
}

async function harness({ baselineOutdated, rebase = "success", childEnv = {} }, verify) {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const rawBody = await requestBody(request);
    let body = null;
    try {
      body = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      body = "malformed";
    }
    calls.push({ method: request.method, path: request.url, headers: request.headers, body });

    if (request.method === "POST" && request.url === "/api/auth/login") {
      jsonResponse(response, 200, { ok: true, csrf }, {
        "set-cookie": "eip_session=fake; Path=/; HttpOnly; SameSite=Strict",
      });
      return;
    }
    if (request.method === "GET" && request.url === "/api/skills") {
      jsonResponse(response, 200, { revision: oldRevision, baselineOutdated });
      return;
    }
    if (request.method === "POST" && request.url === "/api/skills/rebase") {
      if (rebase === "conflict") {
        jsonResponse(response, 409, { code: "REBASE_CONFLICT", error: password });
        return;
      }
      jsonResponse(response, 200, {
        revision: newRevision,
        catalog: {
          revision: newRevision,
          baselineOutdated: rebase === "still-outdated",
        },
      });
      return;
    }
    jsonResponse(response, 500, { error: "unexpected request" });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pixel-managed-skills-test-"));
  const envFile = path.join(temporary, "eip-cve-ui.env");
  const address = server.address();
  fs.writeFileSync(
    envFile,
    [
      `EIP_CVE_UI_USER=${username}`,
      `EIP_CVE_UI_PASSWORD=${password}`,
      `EIP_CVE_UI_URL=http://127.0.0.1:${address.port}`,
      "UNRELATED_VALUE=ignored",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  try {
    const result = await runHelper(envFile, childEnv);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(password));
    await verify({ calls, result });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function assertAuthenticated(calls) {
  assert.deepEqual(calls[0].body, { username, password });
  assert.match(calls[1].headers.cookie ?? "", /(?:^|;\s*)eip_session=fake(?:;|$)/);
}

test("current managed-skills baseline authenticates and performs no mutation", async () => {
  await harness({ baselineOutdated: false }, ({ calls, result }) => {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no rebase needed/);
    assert.equal(result.stderr, "");
    assert.deepEqual(calls.map(({ method, path: requestPath }) => `${method} ${requestPath}`), [
      "POST /api/auth/login",
      "GET /api/skills",
    ]);
    assertAuthenticated(calls);
  });
});

test("outdated baseline rebases with the catalog revision and credential-bound CSRF", async () => {
  await harness({ baselineOutdated: true }, ({ calls, result }) => {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`completed at revision ${newRevision}`));
    assert.equal(result.stderr, "");
    assert.deepEqual(calls.map(({ method, path: requestPath }) => `${method} ${requestPath}`), [
      "POST /api/auth/login",
      "GET /api/skills",
      "POST /api/skills/rebase",
    ]);
    assertAuthenticated(calls);
    assert.deepEqual(calls[2].body, { expectedRevision: oldRevision });
    assert.equal(calls[2].headers["x-eip-csrf"], csrf);
    assert.match(calls[2].headers.cookie ?? "", /(?:^|;\s*)eip_session=fake(?:;|$)/);
  });
});

test("loopback migration ignores inherited HTTP and HTTPS proxies", async () => {
  let proxyCalls = 0;
  const proxy = http.createServer((_request, response) => {
    proxyCalls += 1;
    jsonResponse(response, 502, { error: "proxy must not receive UI credentials" });
  });
  await new Promise((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  const address = proxy.address();
  const proxyUrl = `http://127.0.0.1:${address.port}`;

  try {
    await harness({
      baselineOutdated: false,
      childEnv: {
        HTTP_PROXY: proxyUrl,
        http_proxy: proxyUrl,
        HTTPS_PROXY: proxyUrl,
        https_proxy: proxyUrl,
        NO_PROXY: "",
        no_proxy: "",
      },
    }, ({ calls, result }) => {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /no rebase needed/);
      assert.deepEqual(calls.map(({ method, path: requestPath }) => `${method} ${requestPath}`), [
        "POST /api/auth/login",
        "GET /api/skills",
      ]);
      assert.equal(proxyCalls, 0);
    });
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
  }
});

test("rebase conflict fails closed without calling reset-all or logging the response", async () => {
  await harness({ baselineOutdated: true, rebase: "conflict" }, ({ calls, result }) => {
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /rebase conflicted; no reset was attempted/);
    assert.equal(calls.some(({ path: requestPath }) => requestPath.includes("reset")), false);
  });
});

test("a successful response that remains outdated is rejected without reset", async () => {
  await harness({ baselineOutdated: true, rebase: "still-outdated" }, ({ calls, result }) => {
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /returned an outdated skills catalog; no reset was attempted/);
    assert.equal(calls.some(({ path: requestPath }) => requestPath.includes("reset")), false);
  });
});
