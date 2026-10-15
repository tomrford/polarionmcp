import assert from "node:assert/strict";
import { chmod, readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execPath } from "node:process";
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
  const arrivals = new Map();
  const arrival = (label) => {
    if (!arrivals.has(label)) arrivals.set(label, Promise.withResolvers());
    return arrivals.get(label);
  };
  supervisor.on("request", (request) => {
    const label = new URLSearchParams(request.url.split("?", 2)[1]).get("runtimeCase");
    if (label) arrival(label).resolve();
  });
  const url = await listen(supervisor);
  t.after(async () => {
    await close(supervisor);
    await close(polarion);
  });
  return {
    url,
    arrived: (label) => arrival(label).promise,
    shutdown: () => new Promise((resolve) => supervisor.close(resolve)),
  };
}

async function call(
  url,
  name,
  args,
  { query = "", signal, token = "runtime-test-token", label } = {},
) {
  const target = new URL(`/mcp${query}`, url);
  if (label) target.searchParams.set("runtimeCase", label);
  const response = await fetch(target, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
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

function assertCode(result, expected) {
  assert.equal(result.status, 200);
  assert.equal(result.body.result.isError ?? false, false);
  assert.equal(result.body.result.content[0].text, expected);
}

async function gates(t, options = {}) {
  const entries = new Map();
  const seen = [];
  let active = 0;
  let peak = 0;
  const entry = (key) => {
    if (!entries.has(key))
      entries.set(key, {
        entered: Promise.withResolvers(),
        released: Promise.withResolvers(),
        closed: Promise.withResolvers(),
      });
    return entries.get(key);
  };
  const server = await fixture(
    t,
    async (request, response) => {
      const key = new URL(request.url, "http://localhost").searchParams.get("query");
      const gate = entry(key);
      seen.push(key);
      peak = Math.max(peak, ++active);
      response.once("close", () => {
        active--;
        gate.closed.resolve();
      });
      gate.entered.resolve(request.headers.authorization);
      await gate.released.promise;
      if (!response.destroyed)
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ data: [{ id: key, type: "projects" }] }));
    },
    options,
  );
  return {
    ...server,
    seen,
    entered: (key) => entry(key).entered.promise,
    release: (key) => entry(key).released.resolve(),
    closed: (key) => entry(key).closed.promise,
    peak: () => peak,
    call: (key, options = {}) =>
      call(
        server.url,
        "getProjects",
        { query: key },
        {
          query: "?codemode=false",
          label: key,
          ...options,
        },
      ),
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
    const { url } = await fixture(t, async (request, response) => {
      assert.equal(request.headers.authorization, "Bearer runtime-test-token");
      assert.equal(request.url, "/polarion/rest/v1/projects?query=id%3APRJ*");
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
    assertCode(await call(url, "code", { code: "async () => 44" }), "44");
  },
);

test("malformed request targets cannot crash the launcher", { timeout: 10_000 }, async (t) => {
  const { url } = await fixture(t, (_request, response) => response.end());
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
  "four requests execute concurrently and waiting requests enter in FIFO order",
  { timeout: 15_000 },
  async (t) => {
    const gate = await gates(t);
    const running = ["a", "b", "c", "d"].map((key) => gate.call(key));
    await Promise.all(["a", "b", "c", "d"].map(gate.entered));
    const queued = [];
    for (const key of ["e", "f", "g"]) {
      queued.push(gate.call(key));
      await gate.arrived(key);
    }
    assert.deepEqual([...gate.seen].sort(), ["a", "b", "c", "d"]);
    gate.release("a");
    await gate.entered("e");
    assert.deepEqual(gate.seen.slice(4), ["e"]);
    gate.release("e");
    await gate.entered("f");
    gate.release("f");
    await gate.entered("g");
    assert.deepEqual(gate.seen.slice(4), ["e", "f", "g"]);
    for (const key of ["b", "c", "d", "g"]) gate.release(key);
    const results = await Promise.all([...running, ...queued]);
    assert.deepEqual(
      results.map((result) => result.status),
      [200, 200, 200, 200, 200, 200, 200],
    );
    assert.deepEqual(
      results.map((result) => result.body.result.structuredContent.items[0].id),
      ["a", "b", "c", "d", "e", "f", "g"],
    );
    assert.equal(gate.peak(), 4);
  },
);

test(
  "queue overflow returns 503 while admitted work retains its order",
  { timeout: 10_000 },
  async (t) => {
    const gate = await gates(t, { maxConcurrent: 1, maxQueued: 2 });
    const first = gate.call("first");
    await gate.entered("first");
    const second = gate.call("second");
    await gate.arrived("second");
    const third = gate.call("third");
    await gate.arrived("third");
    const overflow = await gate.call("overflow");
    assert.equal(overflow.status, 503);
    assert.match(overflow.body, /busy|queue|capacity/i);
    for (const key of ["first", "second", "third"]) {
      gate.release(key);
      if (key !== "third") await gate.entered(key === "first" ? "second" : "third");
    }
    assert.deepEqual(
      (await Promise.all([first, second, third])).map((result) => result.status),
      [200, 200, 200],
    );
    assert.deepEqual(gate.seen, ["first", "second", "third"]);
  },
);

test(
  "the deadline includes waiting time and is not restarted on admission",
  { timeout: 10_000 },
  async (t) => {
    const gate = await gates(t, { maxConcurrent: 1, timeoutMs: 1_500 });
    const first = gate.call("first");
    await gate.entered("first");
    const queued = gate.call("queued");
    await gate.arrived("queued");
    await delay(950);
    gate.release("first");
    assert.equal((await first).status, 200);
    await gate.entered("queued");
    const result = await Promise.race([
      queued,
      delay(1_100).then(() => {
        throw new Error("Admission restarted the request deadline");
      }),
    ]);
    assert.equal(result.status, 504);
    assert.match(result.body, /exceeded 1500ms/);
    await gate.closed("queued");
    assertCode(await call(gate.url, "code", { code: "async () => 45" }), "45");
  },
);

test(
  "expired queued requests do not dispatch after a timed-out host is replaced",
  { timeout: 10_000 },
  async (t) => {
    const gate = await gates(t, { maxConcurrent: 1, timeoutMs: 1_500 });
    const first = gate.call("first");
    await gate.entered("first");
    const head = gate.call("head");
    await gate.arrived("head");
    const expired = gate.call("expired");
    await gate.arrived("expired");
    gate.release("first");
    assert.equal((await first).status, 200);
    await gate.entered("head");
    assert.deepEqual(
      (await Promise.all([head, expired])).map((result) => result.status),
      [504, 504],
    );
    assertCode(await call(gate.url, "code", { code: "async () => 46" }), "46");
    assert.deepEqual(gate.seen, ["first", "head"]);
  },
);

test(
  "disconnecting queued work removes it without executing it",
  { timeout: 10_000 },
  async (t) => {
    const gate = await gates(t, { maxConcurrent: 1 });
    const first = gate.call("first");
    await gate.entered("first");
    const controller = new AbortController();
    const gone = gate.call("gone", { signal: controller.signal });
    const aborted = assert.rejects(gone, /abort/i);
    await gate.arrived("gone");
    controller.abort();
    await aborted;
    const survivor = gate.call("survivor");
    await gate.arrived("survivor");
    gate.release("first");
    await gate.entered("survivor");
    gate.release("survivor");
    assert.deepEqual(
      (await Promise.all([first, survivor])).map((result) => result.status),
      [200, 200],
    );
    assert.deepEqual(gate.seen, ["first", "survivor"]);
  },
);

test(
  "disconnecting running work cancels its API call and admits waiting work",
  { timeout: 10_000 },
  async (t) => {
    const gate = await gates(t, { maxConcurrent: 1 });
    const controller = new AbortController();
    const pending = gate.call("aborted", { signal: controller.signal });
    const aborted = assert.rejects(pending, /abort/i);
    await gate.entered("aborted");
    const waiting = gate.call("waiting");
    await gate.arrived("waiting");
    controller.abort();
    await aborted;
    await gate.closed("aborted");
    await gate.entered("waiting");
    gate.release("waiting");
    const result = await waiting;
    assert.equal(result.status, 200);
    assert.equal(result.body.result.structuredContent.items[0].id, "waiting");
  },
);

test(
  "CPU-bound code times out while health and other hosts keep serving",
  { timeout: 10_000 },
  async (t) => {
    const { url } = await fixture(t, (_request, response) => response.writeHead(500).end(), {
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
    assertCode(await call(url, "code", { code: "async () => 42" }), "42");
    const timedOut = await stalled;
    assert.equal(timedOut.status, 504);
    assert.match(timedOut.body, /exceeded 1500ms/);
    assertCode(await call(url, "code", { code: "async () => 43" }), "43");
  },
);

test(
  "successive requests get fresh code globals and their own authorization",
  { timeout: 10_000 },
  async (t) => {
    const { url } = await fixture(
      t,
      (request, response) => {
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            data: [{ id: request.headers.authorization, type: "projects" }],
          }),
        );
      },
      { maxConcurrent: 1 },
    );
    for (const token of ["first-token", "second-token", "first-token"]) {
      const result = await call(
        url,
        "code",
        {
          code: `async () => {
      const previous = globalThis.runtimeMarker ?? null;
      globalThis.runtimeMarker = ${JSON.stringify(token)};
      return { previous, authorization: (await codemode.getProjects({})).items[0].id };
    }`,
        },
        { token },
      );
      assertCode(result, JSON.stringify({ previous: null, authorization: `Bearer ${token}` }));
    }
  },
);

test("concurrent code requests retain different caller tokens", { timeout: 10_000 }, async (t) => {
  const gate = await gates(t, { maxConcurrent: 2 });
  const run = (key, token) =>
    call(
      gate.url,
      "code",
      {
        code: `async () => (await codemode.getProjects({query: ${JSON.stringify(key)}})).items[0].id`,
      },
      { token },
    );
  const alpha = run("alpha", "alpha-token");
  const beta = run("beta", "beta-token");
  assert.equal(await gate.entered("alpha"), "Bearer alpha-token");
  assert.equal(await gate.entered("beta"), "Bearer beta-token");
  gate.release("beta");
  assertCode(await beta, "beta");
  gate.release("alpha");
  assertCode(await alpha, "alpha");
});

for (const [name, background] of [
  ["timers", 'setTimeout(() => void codemode.getProjects({query: "escaped"}), 150)'],
  [
    "waitUntil RPC",
    'this.ctx.waitUntil(new Promise(resolve => setTimeout(resolve, 150)).then(() => codemode.getProjects({query: "escaped"})))',
  ],
  [
    "waitUntil CPU",
    "this.ctx.waitUntil(new Promise(resolve => setTimeout(resolve, 150)).then(() => { while (true) {} }))",
  ],
]) {
  test(`${name} cannot outlive a completed code request`, { timeout: 10_000 }, async (t) => {
    const gate = await gates(t, { maxConcurrent: 1, timeoutMs: 1_500 });
    assertCode(
      await call(gate.url, "code", { code: `async () => { ${background}; return "done"; }` }),
      "done",
    );
    await delay(300);
    gate.release("proof");
    const result = await gate.call("proof");
    assert.equal(result.status, 200);
    assert.equal(result.body.result.structuredContent.items[0].id, "proof");
    assert.deepEqual(gate.seen, ["proof"]);
    assertCode(await call(gate.url, "code", { code: "async () => 47" }), "47");
  });
}

test(
  "an unawaited in-flight API call is canceled when its code result completes",
  { timeout: 10_000 },
  async (t) => {
    const gate = await gates(t, { maxConcurrent: 1 });
    const pending = call(gate.url, "code", {
      code: `async () => {
    void codemode.getProjects({query: "orphan"});
    await codemode.getProjects({query: "barrier"});
    return "done";
  }`,
    });
    await Promise.all([gate.entered("orphan"), gate.entered("barrier")]);
    gate.release("barrier");
    assertCode(await pending, "done");
    await Promise.race([
      gate.closed("orphan"),
      delay(1_000).then(() => {
        throw new Error("Completed request left its API call running");
      }),
    ]);
    assertCode(await call(gate.url, "code", { code: "async () => 48" }), "48");
    assert.deepEqual([...gate.seen].sort(), ["barrier", "orphan"]);
  },
);

test(
  "missing executable returns 502 repeatedly and releases capacity",
  { timeout: 10_000 },
  async (t) => {
    const { url } = await fixture(t, (_request, response) => response.end(), {
      binary: "/nonexistent/polarion-review-workerd",
      maxConcurrent: 1,
    });
    const startup = await call(url, "code", { code: "async () => 1" });
    assert.equal(startup.status, 502);
    assert.equal(startup.body, "Worker request failed");
    assert.equal((await call(url, "code", { code: "async () => 2" })).status, 502);
    assert.equal((await fetch(`${url}/healthz`)).status, 200);
  },
);

test(
  "a worker that dies after accepting a request warns that writes may have completed",
  { timeout: 10_000 },
  async (t) => {
    const binary = resolve(tmpdir(), `polarion-crash-host-${randomUUID()}.mjs`);
    await writeFile(
      binary,
      `#!${execPath}
import { createServer } from "node:http";
import { writeSync } from "node:fs";
const server = createServer((request) => {
  request.resume();
  process.exit(1);
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  writeSync(3, JSON.stringify({ event: "listen", socket: "http", port }) + "\\n");
});
`,
    );
    await chmod(binary, 0o755);
    t.after(() => rm(binary, { force: true }));
    const { url } = await fixture(t, (_request, response) => response.end(), {
      binary,
      maxConcurrent: 1,
    });
    const result = await call(url, "code", { code: "async () => 1" });
    assert.equal(result.status, 502);
    assert.match(
      result.body,
      /Worker request failed\. Polarion writes already sent may have completed\./,
    );
  },
);

test(
  "a failed host startup recovers after its configuration becomes available",
  { timeout: 10_000 },
  async (t) => {
    const config = resolve("dist", `runtime-recovery-${randomUUID()}.capnp`);
    t.after(() => rm(config, { force: true }));
    const { url } = await fixture(t, (_request, response) => response.end(), {
      config,
      maxConcurrent: 1,
    });
    assert.equal((await call(url, "code", { code: "async () => 49" })).status, 502);
    assert.equal((await fetch(`${url}/readyz`)).status, 503);
    await writeFile(config, await readFile("dist/config.capnp", "utf8"));
    await delay(1_100);
    assertCode(await call(url, "code", { code: "async () => 49" }), "49");
  },
);

test(
  "workers retire only after completing their request lease and recover with new configuration",
  { timeout: 10_000 },
  async (t) => {
    const config = resolve("dist", `runtime-recycle-${randomUUID()}.capnp`);
    const contents = await readFile("dist/config.capnp", "utf8");
    await writeFile(config, contents);
    t.after(() => rm(config, { force: true }));
    const { url } = await fixture(t, (_request, response) => response.end(), {
      config,
      maxConcurrent: 1,
      maxRequestsPerWorker: 2,
    });
    assertCode(await call(url, "code", { code: "async () => 50" }), "50");
    await rm(config);
    assertCode(await call(url, "code", { code: "async () => 51" }), "51");
    assert.equal((await call(url, "code", { code: "async () => 52" })).status, 502);
    await writeFile(config, contents);
    await delay(1_100);
    assertCode(await call(url, "code", { code: "async () => 52" }), "52");
  },
);

test(
  "shutdown completes active and queued requests before closing the supervisor",
  { timeout: 10_000 },
  async (t) => {
    const gate = await gates(t, { maxConcurrent: 1 });
    const running = gate.call("running");
    await gate.entered("running");
    const queued = gate.call("queued");
    await gate.arrived("queued");
    const stopped = gate.shutdown();
    assert.deepEqual(
      (await Promise.all([running, queued])).map((result) => result.status),
      [503, 503],
    );
    await stopped;
    await gate.closed("running");
    assert.deepEqual(gate.seen, ["running"]);
  },
);
