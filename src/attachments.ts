import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import jpegWasm from "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm";
import pngWasm from "@jsquash/png/codec/pkg/squoosh_png_bg.wasm";
import webpWasm from "@jsquash/webp/codec/enc/webp_enc.wasm";
import webpSimdWasm from "@jsquash/webp/codec/enc/webp_enc_simd.wasm";
import {
  ATTACHMENT_RESOURCE_TYPES,
  type AttachmentReferenceArgs,
  resolveAttachmentContentUrl,
} from "./attachment-routes";
import { polarionConfig } from "./config";
import { httpError, makeError, networkError } from "./errors";
import { authHeaders, errorResult } from "./helpers";
import { withToolLogging } from "./logging";
import { getPolarionAccessToken } from "./request-context";

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const HARD_MAX_BYTES = 8 * 1024 * 1024;
const HARD_INLINE_RESULT_MAX_BYTES = 8 * 1024 * 1024;
const READ_MODES = ["auto", "image", "text"] as const;
const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const WEBP_TRANSCODE_MIME_TYPES = new Set(["image/jpeg", "image/png"]);
const SUPPORTED_TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/xhtml+xml",
  "application/yaml",
  "application/x-yaml",
]);

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
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maxBytes) {
      return { error: errorResult(makeError(413, "Attachment is too large")) };
    }
    return { bytes };
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
  const [{ init: initPng }, { init: initJpeg }, { init: initWebp }, { simd }] = await Promise.all([
    import("@jsquash/png/decode"),
    import("@jsquash/jpeg/decode"),
    import("@jsquash/webp/encode"),
    import("wasm-feature-detect"),
  ]);
  await Promise.all([
    initPng(pngWasm),
    (initJpeg as WasmInit)(jpegWasm),
    (initWebp as WasmInit)((await simd()) ? webpSimdWasm : webpWasm),
  ]);
}

async function transcodeLosslessWebp(
  bytes: Uint8Array,
  mimeType: string,
): Promise<{ bytes: Uint8Array } | { error: ToolErrorResult }> {
  try {
    codecsReady ??= initImageCodecs();
    await codecsReady;
    const source = Uint8Array.from(bytes).buffer;
    const imageData =
      mimeType === "image/png"
        ? await (await import("@jsquash/png/decode")).default(source)
        : await (await import("@jsquash/jpeg/decode")).default(source);
    const encoded = await (
      await import("@jsquash/webp/encode")
    ).default(imageData, {
      lossless: 1,
    });
    return { bytes: new Uint8Array(encoded) };
  } catch (error) {
    codecsReady = undefined;
    const details = error instanceof Error ? error.message : String(error);
    return {
      error: errorResult(makeError(500, "Image conversion failed", details)),
    };
  }
}

async function inlineImageCandidate(
  bytes: Uint8Array,
  mimeType: string,
): Promise<{ candidate: ImageCandidate } | { error: ToolErrorResult }> {
  if (!WEBP_TRANSCODE_MIME_TYPES.has(mimeType)) {
    return {
      candidate: {
        bytes,
        mimeType,
        sourceMimeType: mimeType,
        sourceByteLength: bytes.length,
      },
    };
  }

  const result = await transcodeLosslessWebp(bytes, mimeType);
  if ("error" in result) return result;
  return {
    candidate: {
      bytes: result.bytes,
      mimeType: "image/webp",
      sourceMimeType: mimeType,
      sourceByteLength: bytes.length,
      conversion: "lossless-webp",
    },
  };
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
    const candidateResult = await inlineImageCandidate(bytes, imageMimeType);
    if ("error" in candidateResult) return candidateResult.error;
    const result = imageResult(candidateResult.candidate, url);
    const resultByteLength = serializedByteLength(result);
    if (resultByteLength <= maxInlineResultBytes) return result;
    return oversizedImageResult(
      candidateResult.candidate,
      url,
      maxInlineResultBytes,
      resultByteLength,
    );
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
      headers: {
        Accept: "application/octet-stream, image/*, text/*",
        ...authHeaders(),
      },
    });
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
      inputSchema: z.object({
        contentUrl: z
          .string()
          .optional()
          .describe("Attachment links.content URL from Polarion metadata"),
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
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withToolLogging(
      "read_attachment",
      async (args) => await readAttachment(args),
      (args) => ({
        operation_id: "read_attachment",
        method: "GET",
        target_id: typeof args.resourceId === "string" ? args.resourceId : undefined,
      }),
    ),
  );
}
