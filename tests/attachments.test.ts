import decodePng from "@jsquash/png/decode";
import decodeWebp, { init as initWebpDecoder } from "@jsquash/webp/decode";
import webpDecoderWasm from "@jsquash/webp/codec/dec/webp_dec.wasm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readAttachment } from "../src/attachments";
import { runWithPolarionAccessToken } from "../src/request-context";
import { diagramPng } from "./diagram-fixture";

describe("attachment fetch", () => {
  afterEach(() => vi.restoreAllMocks());

  test("does not follow redirects", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://example.invalid/login" },
      }),
    );
    const result = await runWithPolarionAccessToken("token", () =>
      readAttachment({
        contentUrl: "/projects/PRJ/workitems/WI-1/attachments/A-1/content",
      }),
    );
    expect("isError" in result && result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text!)).toMatchObject({
      status_code: 502,
      message: "Polarion redirected the request",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });
});

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

  test.each([
    ["a PNG above the pixel cap", withPngSize(diagramPng, 20_000, 20_000), "image/png"],
    ["a PNG that fails to decode", diagramPng.slice(0, 64), "image/png"],
    ["a JPEG", Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0]), "image/jpeg"],
  ])("returns %s unchanged", async (_label, bytes, mimeType) => {
    vi.mocked(fetch).mockImplementation(
      async () => new Response(bytes, { headers: { "content-type": mimeType } }),
    );
    const result = await read();
    expect("isError" in result && result.isError).toBeFalsy();
    const image = result.content.find((part) => part.type === "image");
    if (!image || !("data" in image)) throw new Error("Expected an inline image");
    expect(image.mimeType).toBe(mimeType);
    expect(Uint8Array.from(atob(image.data), (char) => char.charCodeAt(0))).toEqual(bytes);
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

describe("attachment text selection", () => {
  afterEach(() => vi.restoreAllMocks());

  function readWith(body: BodyInit, contentType: string, mode?: "auto" | "image" | "text") {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(body, { headers: { "content-type": contentType } }),
    );
    return runWithPolarionAccessToken("attachment-test-token", () =>
      readAttachment({
        contentUrl: "/projects/PRJ/workitems/WI-1/attachments/A-1/content",
        mode,
      }),
    );
  }

  test.each(["auto", "text"] as const)(
    "reads image/svg+xml as UTF-8 text in %s mode",
    async (mode) => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Hi</text></svg>';
      const result = await readWith(svg, "image/svg+xml; charset=utf-8", mode);
      expect("isError" in result && result.isError).toBeFalsy();
      expect(result.content).toEqual([{ type: "text", text: svg }]);
      expect("structuredContent" in result && result.structuredContent).toMatchObject({
        kind: "attachment",
        mimeType: "image/svg+xml",
        byteLength: svg.length,
      });
    },
  );

  test("rejects image/svg+xml in image mode and unsupported binary image types", async () => {
    const svgAsImage = await readWith("<svg/>", "image/svg+xml", "image");
    expect("isError" in svgAsImage && svgAsImage.isError).toBe(true);
    expect(JSON.parse(svgAsImage.content[0].text!)).toMatchObject({
      status_code: 415,
      message: "Unsupported attachment image type",
      details: "image/svg+xml",
    });

    for (const mode of ["auto", "text"] as const) {
      const tiff = await readWith(Uint8Array.from([0x49, 0x49, 0x2a, 0x00]), "image/tiff", mode);
      expect("isError" in tiff && tiff.isError).toBe(true);
      expect(JSON.parse(tiff.content[0].text!)).toMatchObject({
        status_code: 415,
        message: "Unsupported attachment image type",
        details: "image/tiff",
      });
    }
  });

  test("reads structured +xml/+json/+yaml text types in auto mode and rejects non-UTF-8 bytes", async () => {
    const xml = '<mxfile><diagram name="Arch"/></mxfile>';
    const xmlResult = await readWith(xml, "application/vnd.jgraph.mxfile+xml");
    expect("isError" in xmlResult && xmlResult.isError).toBeFalsy();
    expect(xmlResult.content).toEqual([{ type: "text", text: xml }]);

    const json = '{"title":"Problem"}';
    const jsonResult = await readWith(json, "application/problem+json");
    expect("isError" in jsonResult && jsonResult.isError).toBeFalsy();
    expect(jsonResult.content).toEqual([{ type: "text", text: json }]);

    const yaml = "openapi: 3.1.0\n";
    const yamlResult = await readWith(yaml, "application/openapi+yaml");
    expect("isError" in yamlResult && yamlResult.isError).toBeFalsy();
    expect(yamlResult.content).toEqual([{ type: "text", text: yaml }]);

    const svgz = Uint8Array.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe]);
    const invalidUtf8 = await readWith(svgz, "image/svg+xml");
    expect("isError" in invalidUtf8 && invalidUtf8.isError).toBe(true);
    expect(JSON.parse(invalidUtf8.content[0].text!)).toMatchObject({
      status_code: 415,
      message: "Unsupported attachment content",
    });

    const malformed = await readWith(
      Uint8Array.from([0x49, 0x49, 0x2a, 0x00]),
      "image/tiff,broken+xml",
    );
    expect("isError" in malformed && malformed.isError).toBe(true);
    expect(JSON.parse(malformed.content[0].text!)).toMatchObject({
      status_code: 415,
      message: "Unsupported attachment image type",
    });
  });

  test("declared text and SVG MIME types take precedence over magic-byte image sniffing", async () => {
    const yaml = await readWith("GIF89a", "application/example+yaml", "auto");
    expect("isError" in yaml && yaml.isError).toBeFalsy();
    expect(yaml.content).toEqual([{ type: "text", text: "GIF89a" }]);

    const svgAsImage = await readWith("GIF89a", "image/svg+xml", "image");
    expect("isError" in svgAsImage && svgAsImage.isError).toBe(true);
    expect(JSON.parse(svgAsImage.content[0].text!)).toMatchObject({
      status_code: 415,
      message: "Unsupported attachment image type",
      details: "image/svg+xml",
    });

    const octetGif = await readWith("GIF89a", "application/octet-stream", "auto");
    expect("isError" in octetGif && octetGif.isError).toBeFalsy();
    expect(octetGif.content.find((part) => part.type === "image")).toMatchObject({
      type: "image",
      mimeType: "image/gif",
    });
  });
});

function withPngSize(png: Uint8Array, width: number, height: number) {
  const copy = png.slice();
  const view = new DataView(copy.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return copy;
}
