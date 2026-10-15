import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import pngWasm from "@jsquash/png/codec/pkg/squoosh_png_bg.wasm";
import webpWasm from "@jsquash/webp/codec/enc/webp_enc.wasm";
import webpSimdWasm from "@jsquash/webp/codec/enc/webp_enc_simd.wasm";
import {
  ATTACHMENT_RESOURCE_TYPES,
  type AttachmentReferenceArgs,
  resolveAttachmentContentUrl,
} from "./attachment-routes";
import { polarionConfig } from "./config";
import { httpError, isRedirect, makeError, networkError, redirectError } from "./errors";
import { authHeaders, errorResult } from "./helpers";
import { withToolLogging } from "./logging";
import { getPolarionAccessToken } from "./request-context";

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const HARD_MAX_BYTES = 8 * 1024 * 1024;
const HARD_INLINE_RESULT_MAX_BYTES = 8 * 1024 * 1024;
const READ_MODES = ["auto", "image", "text"] as const;
const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
// Lossless WebP only pays off for PNG; JPEG photos grow several times larger.
// Larger images are returned as-is: decoding and encoding them costs seconds and hundreds of MB.
const WEBP_TRANSCODE_MAX_PIXELS = 10_000_000;
const WEBP_MAX_DIMENSION = 16_383;
const SUPPORTED_TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/xhtml+xml",
  "application/yaml",
  "application/x-yaml",
]);

const ATTACHMENT_INPUT_SCHEMA = z.object({
  contentUrl: z.string().optional().describe("Attachment links.content URL from Polarion metadata"),
  resourceType: z.enum(ATTACHMENT_RESOURCE_TYPES).optional(),
  resourceId: z
    .string()
    .optional()
    .describe("Full slash-separated JSON:API attachment resource id"),
  revision: z.string().optional().describe("Optional revision override"),
  mode: z.enum(READ_MODES).optional().default("auto"),
  maxBytes: z.number().int().min(1).max(HARD_MAX_BYTES).optional().default(DEFAULT_MAX_BYTES),
  maxInlineResultBytes: z
    .number()
    .int()
    .min(1)
    .max(HARD_INLINE_RESULT_MAX_BYTES)
    .optional()
    .describe(
      "Maximum serialized MCP result bytes for inline image content. Defaults to 1000000, or READ_ATTACHMENT_INLINE_RESULT_MAX_BYTES when set.",
    ),
});

type ReadMode = (typeof READ_MODES)[number];
type ToolErrorResult = ReturnType<typeof errorResult>;
type AttachmentReadArgs = AttachmentReferenceArgs & {
  mode?: ReadMode;
  maxBytes?: number;
  maxInlineResultBytes?: number;
};
type ImageCandidate = {
  bytes: Uint8Array;
  mimeType: string;
  sourceMimeType: string;
  sourceByteLength: number;
  conversion?: "lossless-webp";
};

function contentTypeMime(headers: Headers) {
  const raw = headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  return raw && raw.length > 0 ? raw : undefined;
}

function contentLength(headers: Headers) {
  const raw = headers.get("content-length");
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

async function readLimitedBytes(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array } | { error: ToolErrorResult }> {
  const length = contentLength(response.headers);
  if (typeof length === "number" && length > maxBytes) {
    return {
      error: errorResult(
        makeError(413, "Attachment is too large", `Content-Length ${length} exceeds ${maxBytes}.`),
      ),
    };
  }

  if (!response.body) {
    return { bytes: new Uint8Array() };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return {
        error: errorResult(
          makeError(413, "Attachment is too large", `Read exceeded ${maxBytes} bytes.`),
        ),
      };
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes };
}

function sniffImageMime(bytes: Uint8Array) {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const head = String.fromCharCode(...bytes.slice(0, 12));
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
  return undefined;
}

function isTextMime(mimeType: string | undefined) {
  return !!mimeType && (mimeType.startsWith("text/") || SUPPORTED_TEXT_MIME_TYPES.has(mimeType));
}

function decodeUtf8(bytes: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return undefined;
  }
}

function toBase64(bytes: Uint8Array) {
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
  }
  return btoa(binary);
}

function serializedByteLength(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

let codecsReady: Promise<void> | undefined;

type WasmInit = (module?: WebAssembly.Module) => Promise<unknown>;

async function initImageCodecs() {
  const [{ init: initPng }, { init: initWebp }, { simd }] = await Promise.all([
    import("@jsquash/png/decode"),
    import("@jsquash/webp/encode"),
    import("wasm-feature-detect"),
  ]);
  await Promise.all([
    initPng(pngWasm),
    (initWebp as WasmInit)((await simd()) ? webpSimdWasm : webpWasm),
  ]);
}

function pngDimensions(bytes: Uint8Array) {
  // IHDR is always the first chunk: width and height are big-endian at offsets 16 and 20.
  if (bytes.length < 24) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function shouldTranscode(bytes: Uint8Array, mimeType: string) {
  if (mimeType !== "image/png") return false;
  const size = pngDimensions(bytes);
  return (
    !!size &&
    size.width <= WEBP_MAX_DIMENSION &&
    size.height <= WEBP_MAX_DIMENSION &&
    size.width * size.height <= WEBP_TRANSCODE_MAX_PIXELS
  );
}

async function transcodeLosslessWebp(bytes: Uint8Array): Promise<Uint8Array | undefined> {
  codecsReady ??= initImageCodecs().catch((error) => {
    codecsReady = undefined;
    throw error;
  });
  try {
    await codecsReady;
    const imageData = await (await import("@jsquash/png/decode")).default(bytes.slice().buffer);
    const encoded = await (
      await import("@jsquash/webp/encode")
    ).default(imageData, {
      lossless: 1,
      quality: 100,
      // Method 6 matches cwebp -z 9 but is 10-30x slower in wasm for a near-identical size.
      method: 4,
    });
    return new Uint8Array(encoded);
  } catch {
    return undefined;
  }
}

async function inlineImageCandidate(
  bytes: Uint8Array,
  mimeType: string,
  url: URL,
): Promise<{ candidate: ImageCandidate; result: ImageResult; byteLength: number }> {
  const original: ImageCandidate = {
    bytes,
    mimeType,
    sourceMimeType: mimeType,
    sourceByteLength: bytes.length,
  };
  const originalResult = imageResult(original, url);
  const originalLength = serializedByteLength(originalResult);
  const webp = shouldTranscode(bytes, mimeType) ? await transcodeLosslessWebp(bytes) : undefined;
  if (webp) {
    const converted: ImageCandidate = {
      ...original,
      bytes: webp,
      mimeType: "image/webp",
      conversion: "lossless-webp",
    };
    const convertedResult = imageResult(converted, url);
    const convertedLength = serializedByteLength(convertedResult);
    if (convertedLength < originalLength) {
      return { candidate: converted, result: convertedResult, byteLength: convertedLength };
    }
  }
  return { candidate: original, result: originalResult, byteLength: originalLength };
}

function metadata(
  mimeType: string,
  byteLength: number,
  url: URL,
  extra: Record<string, unknown> = {},
) {
  return {
    kind: "attachment",
    mimeType,
    byteLength,
    path: url.pathname,
    ...(url.searchParams.get("revision") ? { revision: url.searchParams.get("revision") } : {}),
    ...extra,
  };
}

type ImageResult = ReturnType<typeof imageResult>;

function imageResult(candidate: ImageCandidate, url: URL) {
  const extra: Record<string, unknown> = {};
  if (candidate.conversion) {
    extra.conversion = candidate.conversion;
    extra.originalMimeType = candidate.sourceMimeType;
    extra.originalByteLength = candidate.sourceByteLength;
  }
  const payload = metadata(candidate.mimeType, candidate.bytes.length, url, extra);
  return {
    content: [
      { type: "image" as const, data: toBase64(candidate.bytes), mimeType: candidate.mimeType },
      { type: "text" as const, text: JSON.stringify(payload) },
    ],
    structuredContent: payload,
  };
}

function oversizedImageResult(
  candidate: ImageCandidate,
  url: URL,
  maxInlineResultBytes: number,
  inlineResultByteLength: number,
) {
  const extra: Record<string, unknown> = {
    inline: false,
    inlineResultByteLength,
    maxInlineResultBytes,
  };
  if (candidate.conversion) {
    extra.conversion = candidate.conversion;
    extra.originalMimeType = candidate.sourceMimeType;
    extra.originalByteLength = candidate.sourceByteLength;
  }
  const payload = metadata(candidate.mimeType, candidate.bytes.length, url, extra);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

async function renderAttachmentResult(
  bytes: Uint8Array,
  mimeType: string | undefined,
  mode: ReadMode,
  url: URL,
  maxInlineResultBytes: number,
) {
  const sniffedImageMime = sniffImageMime(bytes);
  const headerImageMime =
    mimeType && SUPPORTED_IMAGE_MIME_TYPES.has(mimeType) ? mimeType : undefined;

  if (mode !== "text" && (headerImageMime || sniffedImageMime)) {
    if (headerImageMime && sniffedImageMime && headerImageMime !== sniffedImageMime) {
      return errorResult(
        makeError(
          415,
          "Attachment image type mismatch",
          `Header reported ${headerImageMime}, bytes look like ${sniffedImageMime}.`,
        ),
      );
    }
    if (headerImageMime && !sniffedImageMime) {
      return errorResult(makeError(415, "Attachment bytes do not match image content type"));
    }

    const imageMimeType = sniffedImageMime ?? headerImageMime!;
    const { candidate, result, byteLength } = await inlineImageCandidate(bytes, imageMimeType, url);
    if (byteLength <= maxInlineResultBytes) return result;
    return oversizedImageResult(candidate, url, maxInlineResultBytes, byteLength);
  }

  if (mimeType?.startsWith("image/")) {
    return errorResult(makeError(415, "Unsupported attachment image type", mimeType));
  }

  const canAttemptText =
    mode === "text" ||
    isTextMime(mimeType) ||
    (mode === "auto" && (!mimeType || mimeType === "application/octet-stream"));
  if (mode !== "image" && canAttemptText) {
    const text = decodeUtf8(bytes);
    if (typeof text === "string") {
      const payload = metadata(mimeType ?? "text/plain", bytes.length, url);
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: payload,
      };
    }
  }

  return errorResult(
    makeError(
      415,
      "Unsupported attachment content",
      "Only PNG, JPEG, GIF, WebP, and UTF-8 text attachments are supported.",
    ),
  );
}

export async function readAttachment(args: AttachmentReadArgs) {
  const token = getPolarionAccessToken();
  if (!token) return errorResult(makeError(401, "No Polarion access token available"));

  const resolved = resolveAttachmentContentUrl(args);
  if ("error" in resolved) return errorResult(resolved.error);

  const maxBytes = args.maxBytes ?? DEFAULT_MAX_BYTES;
  const mode = args.mode ?? "auto";
  const inlineMax = args.maxInlineResultBytes ?? polarionConfig().inlineAttachmentMaxBytes;

  try {
    const response = await fetch(resolved.url, {
      method: "GET",
      redirect: "manual",
      headers: {
        Accept: "application/octet-stream, image/*, text/*",
        ...authHeaders(),
      },
    });
    if (isRedirect(response)) return errorResult(redirectError(response));
    if (!response.ok) return errorResult(httpError(response.status, await response.text()));
    const body = await readLimitedBytes(response, maxBytes);
    if ("error" in body) return body.error;
    return renderAttachmentResult(
      body.bytes,
      contentTypeMime(response.headers),
      mode,
      resolved.url,
      inlineMax,
    );
  } catch (error) {
    return errorResult(networkError(error));
  }
}

export function registerAttachmentTool(server: McpServer) {
  server.registerTool(
    "read_attachment",
    {
      description:
        "Read a Polarion attachment after code has found its attachment metadata. Accepts links.content as contentUrl, or resourceType plus JSON:API resourceId. Returns only supported image or UTF-8 text content.",
      inputSchema: ATTACHMENT_INPUT_SCHEMA,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withToolLogging("read_attachment", readAttachment, (args) => ({
      operation_id: "read_attachment",
      method: "GET",
      target_id: typeof args.resourceId === "string" ? args.resourceId : undefined,
    })),
  );
}
