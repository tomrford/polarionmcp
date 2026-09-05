import assert from "node:assert/strict";
import { createServer, request as rawRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createSupervisor } from "../src/serve.mjs";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

async function fixture(t, reply, options = {}) {
  const polarion = createServer(reply);
  const base = await listen(polarion);
  const supervisor = createSupervisor({
    env: { POLARION_BASE_URL: `${base}/polarion/rest/v1` },
    ...options,
  });
  const url = await listen(supervisor);
  t.after(async () => {
    await close(supervisor);
    await close(polarion);
  });
  return url;
}

async function call(url, name, args, { query = "", signal } = {}) {
  const response = await fetch(`${url}/mcp${query}`, {
    method: "POST",
    headers: {
      authorization: "Bearer runtime-test-token",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-11-25",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
    signal,
  });
  const text = await response.text();
  const data = text.split("\n").find((line) => line.startsWith("data:"));
  return {
    status: response.status,
    body: response.ok ? JSON.parse(data ? data.slice(5) : text) : text,
  };
}

test(
  "private Polarion access preserves auth, query mode and complete response bodies",
  { timeout: 10_000 },
  async (t) => {
    const items = Array.from({ length: 2_000 }, (_, index) => ({
      id: String(index),
      type: "projects",
      attributes: { name: "Project ".repeat(20) },
    }));
    const url = await fixture(t, async (request, response) => {
      assert.equal(request.headers.authorization, "Bearer runtime-test-token");
      assert.equal(request.url, "/polarion/rest/v1/projects?query=id%3APRJ*");
      // Request upload has finished, but the response is still pending.
      await delay(100);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: items, meta: { totalCount: items.length } }));
    });
    const result = await call(
      url,
      "getProjects",
      { query: "id:PRJ*" },
      { query: "?codemode=false" },
    );
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.result.structuredContent.items, items);
  },
);

test("malformed request targets cannot crash the launcher", { timeout: 10_000 }, async (t) => {
  const url = await fixture(t, (_request, response) => response.end());
  const status = await new Promise((resolve, reject) => {
    const request = rawRequest(url, { path: "//[" }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on("error", reject);
    request.end();
  });
  assert.equal(status, 404);
  assert.equal((await fetch(`${url}/healthz`)).status, 200);
});

test(
  "CPU-bound code is killed without blocking health, other requests or subsequent calls",
  { timeout: 10_000 },
  async (t) => {
    const url = await fixture(t, (_request, response) => response.writeHead(500).end(), {
      timeoutMs: 1_500,
    });
    const stalled = call(url, "code", {
      code: "async () => { let sum = 0; for (let i = 0; i < 100_000_000_000; i++) sum = (sum + i) | 0; return sum; }",
    });
    await delay(200);
    assert.equal(
      (await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1_000) })).status,
      200,
    );
    const concurrent = await call(url, "code", { code: "async _ => 42" });
    assert.equal(concurrent.body.result.content[0].text, "42");
    const timedOut = await stalled;
    assert.equal(timedOut.status, 504);
    assert.match(timedOut.body, /exceeded 1500ms/);
    const recovered = await call(url, "code", { code: "async () => 43" });
    assert.equal(recovered.body.result.content[0].text, "43");
  },
);

test(
  "client disconnect releases capacity after a worker has started",
  { timeout: 10_000 },
  async (t) => {
    const started = Promise.withResolvers();
    const disconnected = Promise.withResolvers();
    const url = await fixture(
      t,
      (_request, response) => {
        started.resolve();
        response.once("close", disconnected.resolve);
      },
      { maxConcurrent: 1 },
    );
    const controller = new AbortController();
    const pending = call(
      url,
      "code",
      { code: "async () => await codemode.getProjects({})" },
      { signal: controller.signal },
    );
    const aborted = assert.rejects(pending, /abort/i);
    await started.promise;
    assert.equal((await call(url, "code", { code: "async () => 1" })).status, 503);
    controller.abort();
    await aborted;
    await disconnected.promise;
    let recovered;
    for (let attempt = 0; attempt < 20; attempt++) {
      recovered = await call(url, "code", { code: "async () => 2" });
      if (recovered.status !== 503) break;
      await delay(20);
    }
    assert.equal(recovered.body.result.content[0].text, "2");
  },
);

test(
  "missing executable returns an error and releases capacity",
  { timeout: 10_000 },
  async (t) => {
    const url = await fixture(t, (_request, response) => response.end(), {
      binary: "/nonexistent/polarion-review-workerd",
      maxConcurrent: 1,
    });
    assert.equal((await call(url, "code", { code: "async () => 1" })).status, 502);
    await delay(20);
    assert.equal((await call(url, "code", { code: "async () => 2" })).status, 502);
  },
);
