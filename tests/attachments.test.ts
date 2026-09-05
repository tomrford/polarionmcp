import decodePng from "@jsquash/png/decode";
import decodeWebp, { init as initWebpDecoder } from "@jsquash/webp/decode";
import webpDecoderWasm from "@jsquash/webp/codec/dec/webp_dec.wasm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readAttachment } from "../src/attachments";
import { runWithPolarionAccessToken } from "../src/request-context";
import { diagramPng } from "./diagram-fixture";

describe("attachment image selection", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(diagramPng, { headers: { "content-type": "image/png" } }),
    );
  });
  afterEach(() => vi.restoreAllMocks());

  function read(maxInlineResultBytes?: number) {
    return runWithPolarionAccessToken("attachment-test-token", () =>
      readAttachment({
        contentUrl: "/projects/PRJ/workitems/WI-1/attachments/A-1/content",
        maxInlineResultBytes,
      }),
    );
  }

  test("diagram converts to smaller WebP without changing dimensions or pixels", async () => {
    const result = await read();
    const image = result.content.find((part) => part.type === "image");
    if (!image || !("data" in image)) throw new Error("Expected an inline image");
    expect(image.mimeType).toBe("image/webp");
    const bytes = Uint8Array.from(atob(image.data), (char) => char.charCodeAt(0));
    expect(bytes.length).toBeLessThan(diagramPng.length);

    await initWebpDecoder(webpDecoderWasm);
    const decoded = await decodeWebp(bytes.buffer);
    const original = await decodePng(diagramPng.buffer);
    expect([decoded.width, decoded.height]).toEqual([320, 160]);
    expect(decoded.data).toEqual(original.data);
  });

  test("inline budget includes base64 and metadata, with an exact size boundary", async () => {
    const result = await read();
    const budget = new TextEncoder().encode(JSON.stringify(result)).length;
    expect((await read(budget)).content.some((part) => part.type === "image")).toBe(true);

    const oversized = await read(budget - 1);
    expect(oversized.content.some((part) => part.type === "image")).toBe(false);
    expect(JSON.parse(oversized.content[0].text!)).toMatchObject({
      inline: false,
      mimeType: "image/webp",
      conversion: "lossless-webp",
      inlineResultByteLength: budget,
      maxInlineResultBytes: budget - 1,
    });
  });
});
