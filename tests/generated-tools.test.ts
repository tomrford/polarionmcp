import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { polarionConfig } from "../src/config";
import { executeGeneratedOperation } from "../src/generated/register-generated-tools";
import { runWithPolarionAccessToken } from "../src/request-context";

describe("generated tools", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockReset();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  function textPayload(result: Awaited<ReturnType<typeof executeGeneratedOperation>>) {
    const first = result.content[0];
    if (!first || first.type !== "text") throw new Error("Expected text content");
    return JSON.parse(first.text);
  }

  async function call(name: string, args: Record<string, unknown>, config = polarionConfig()) {
    return await runWithPolarionAccessToken("token", () =>
      executeGeneratedOperation(name, args, config),
    );
  }

  test("getProjects shapes pagination and auth headers", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [{ id: "PRJ", type: "projects", attributes: { name: "Project" } }],
        meta: { totalCount: 1 },
        links: {},
      }),
    );

    const result = await call("getProjects", { query: "id:PRJ*" });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.invalid/projects?query=id%3APRJ*");
    expect(init.headers).toEqual({
      Accept: "application/json",
      Authorization: "Bearer token",
    });
    expect(textPayload(result)).toMatchObject({
      kind: "collection",
      items: [{ id: "PRJ", type: "projects" }],
    });
  });

  test("patchWorkItem sends JSON body and returns ok for 204", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await call("patchWorkItem", {
      projectId: "PRJ",
      workItemId: "REQ-1",
      workflowAction: "start_progress",
      body: {
        data: {
          type: "workitems",
          id: "PRJ/REQ-1",
          attributes: { title: "Updated" },
        },
      },
    });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://example.invalid/projects/PRJ/workitems/REQ-1?workflowAction=start_progress",
    );
    expect(init.method).toBe("PATCH");
    expect(init.headers).toEqual({
      Accept: "application/json",
      Authorization: "Bearer token",
      "Content-Type": "application/json",
    });
    expect(textPayload(result)).toEqual({ ok: true });
  });

  test("getProjectFieldsMetadata passes required query params", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: { id: "meta", type: "fieldsmetadata", attributes: { fields: [] } },
        links: {},
      }),
    );

    const result = await call("getProjectFieldsMetadata", {
      projectId: "PRJ",
      resourceType: "workitems",
      targetType: "requirement",
    });

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://example.invalid/projects/PRJ/actions/getFieldsMetadata?resourceType=workitems&targetType=requirement",
    );
    expect(textPayload(result)).toMatchObject({
      kind: "resource",
      item: { type: "fieldsmetadata" },
    });
  });

  test("tool errors surface structured error payloads", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("bad request", { status: 400, headers: { "content-type": "text/plain" } }),
    );
    const result = await call("getProjects", {});
    expect("isError" in result && result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("HTTP 400");
  });

  test("normalizes rich text wrappers and removes links.self noise", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "PRJ",
            type: "projects",
            attributes: {
              description: { type: "text/plain", value: "Sandbox project" },
            },
            links: {
              self: "https://example.invalid/projects/PRJ",
              related: "https://example.invalid/projects/PRJ/related",
            },
          },
        ],
        links: { self: "https://example.invalid/projects" },
        meta: { totalCount: 1 },
      }),
    );

    const payload = textPayload(await call("getProjects", {}));
    expect(payload.kind).toBe("collection");
    expect(payload.items).toEqual([
      {
        id: "PRJ",
        type: "projects",
        attributes: { description: "Sandbox project" },
        links: { related: "https://example.invalid/projects/PRJ/related" },
      },
    ]);
    expect(payload.links).toBeUndefined();
  });

  test("fetches collection pages by page number and returns the full collection", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [
          { id: "1", type: "projects" },
          { id: "2", type: "projects" },
        ],
        links: { next: "https://example.invalid/projects?page[number]=2" },
        meta: { totalCount: 5 },
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [
          { id: "3", type: "projects" },
          { id: "4", type: "projects" },
        ],
        links: {},
        meta: { totalCount: 5 },
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [{ id: "5", type: "projects" }],
        links: {},
        meta: { totalCount: 5 },
      }),
    );

    const payload = textPayload(await call("getProjects", {}));
    expect(payload).toMatchObject({
      kind: "collection",
      items: [
        { id: "1", type: "projects" },
        { id: "2", type: "projects" },
        { id: "3", type: "projects" },
        { id: "4", type: "projects" },
        { id: "5", type: "projects" },
      ],
      meta: { totalCount: 5 },
    });
    expect(fetchSpy.mock.calls).toHaveLength(3);
    expect(fetchSpy.mock.calls[1]![0]).toBe("https://example.invalid/projects?page%5Bnumber%5D=2");
    expect(fetchSpy.mock.calls[2]![0]).toBe("https://example.invalid/projects?page%5Bnumber%5D=3");
  });

  test("uses REST_PAGE_SIZE on the first request", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [{ id: "1", type: "projects" }],
        links: {},
        meta: { totalCount: 1 },
      }),
    );

    await call("getProjects", {}, polarionConfig({ restPageSize: 250 }));
    expect(fetchSpy.mock.calls[0]![0]).toBe("https://example.invalid/projects?page%5Bsize%5D=250");
  });

  test("fetches follow-up pages in concurrency-sized batches", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [
          { id: "1", type: "projects" },
          { id: "2", type: "projects" },
        ],
        links: {},
        meta: { totalCount: 7 },
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [
          { id: "3", type: "projects" },
          { id: "4", type: "projects" },
        ],
        links: {},
        meta: { totalCount: 7 },
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [
          { id: "5", type: "projects" },
          { id: "6", type: "projects" },
        ],
        links: {},
        meta: { totalCount: 7 },
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [{ id: "7", type: "projects" }],
        links: {},
        meta: { totalCount: 7 },
      }),
    );

    const payload = textPayload(
      await call("getProjects", {}, polarionConfig({ fetchConcurrencyCount: 2 })),
    );
    expect(payload.items).toHaveLength(7);
    expect(fetchSpy.mock.calls).toHaveLength(4);
  });

  test("errors when a follow-up page returns non-JSON content", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [{ id: "1", type: "projects" }],
        links: { next: "https://example.invalid/projects?page[number]=2" },
        meta: { totalCount: 2 },
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response("<html>login</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    const result = await call("getProjects", {});
    expect("isError" in result && result.isError).toBe(true);
    expect(textPayload(result)).toMatchObject({
      error: true,
      status_code: 409,
      message: "Polarion pagination returned non-JSON content",
    });
  });

  test("returns the first collection when auto-paginated collection omits totalCount", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [{ id: "1", type: "projects" }],
        links: {},
        meta: {},
      }),
    );

    const result = await call("getProjects", {});
    expect(textPayload(result)).toMatchObject({
      kind: "collection",
      items: [{ id: "1", type: "projects" }],
      meta: {},
    });
    expect(fetchSpy.mock.calls).toHaveLength(1);
  });
});
