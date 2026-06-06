import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  ATTACHMENT_RESOURCE_TYPES,
  type AttachmentReferenceArgs,
  resolveAttachmentContentUrl,
} from "./attachment-routes.ts";
import { httpError, makeError, networkError } from "./errors.ts";
import { authHeaders, errorResult, type RequestContextLike } from "./helpers.ts";
import { withToolLogging } from "./logging.ts";
import { runWithPolarionAccessToken } from "./request-context.ts";

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const HARD_MAX_BYTES = 8 * 1024 * 1024;

const READ_MODES = ["auto", "image", "text"] as const;
const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const SUPPORTED_TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/xhtml+xml",
  "application/yaml",
  "application/x-yaml",
]);

type ReadMode = (typeof READ_MODES)[number];
type ResolveAccessToken = (extra: RequestContextLike) => string | undefined;
type ToolErrorResult = ReturnType<typeof errorResult>;
type AttachmentToolResult = CallToolResult | ToolErrorResult;
type AttachmentReadArgs = AttachmentReferenceArgs & { mode?: ReadMode; maxBytes?: number };
type ByteReadResult = { bytes: Uint8Array } | { error: ToolErrorResult };

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

async function readLimitedBytes(response: Response, maxBytes: number): Promise<ByteReadResult> {
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
  const head = ascii(bytes.slice(0, 12));
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
  return undefined;
}

function ascii(bytes: Uint8Array) {
  return String.fromCharCode(...bytes);
}

function isTextMime(mimeType: string | undefined) {
  return !!mimeType && (mimeType.startsWith("text/") || SUPPORTED_TEXT_MIME_TYPES.has(mimeType));
}

function decodeUtf8(bytes: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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

function metadata(mimeType: string, byteLength: number, url: URL) {
  return {
    kind: "attachment",
    mimeType,
    byteLength,
    path: url.pathname,
    ...(url.searchParams.get("revision") ? { revision: url.searchParams.get("revision") } : {}),
  };
}

function renderAttachmentResult(
  bytes: Uint8Array,
  mimeType: string | undefined,
  mode: ReadMode,
  url: URL,
): AttachmentToolResult {
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
    const payload = metadata(imageMimeType, bytes.length, url);
    return {
      content: [
        { type: "image", data: toBase64(bytes), mimeType: imageMimeType },
        { type: "text", text: JSON.stringify(payload) },
      ],
      structuredContent: payload,
    };
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
        content: [{ type: "text", text }],
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

async function readAttachment(
  args: AttachmentReadArgs,
  extra: RequestContextLike,
  resolveAccessToken: ResolveAccessToken,
): Promise<AttachmentToolResult> {
  const token = resolveAccessToken(extra);
  if (!token) return errorResult(makeError(401, "No Polarion access token available"));

  const resolved = resolveAttachmentContentUrl(args);
  if ("error" in resolved) return errorResult(resolved.error);

  const maxBytes = args.maxBytes ?? DEFAULT_MAX_BYTES;
  const mode = args.mode ?? "auto";

  try {
    return await runWithPolarionAccessToken(token, async () => {
      const response = await fetch(resolved.url, {
        method: "GET",
        headers: {
          Accept: "application/octet-stream, image/*, text/*",
          ...authHeaders(extra),
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
      );
    });
  } catch (error) {
    return errorResult(networkError(error));
  }
}

export function registerAttachmentTool(
  server: McpServer,
  options: { resolveAccessToken: ResolveAccessToken },
) {
  server.registerTool(
    "read_attachment",
    {
      description:
        "Read a Polarion attachment after code has found its attachment metadata. Accepts links.content as contentUrl, or resourceType plus JSON:API resourceId. Returns only supported image or UTF-8 text content.",
      inputSchema: {
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
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withToolLogging(
      "read_attachment",
      async (args, extra) =>
        await readAttachment(
          args as AttachmentReadArgs,
          extra as RequestContextLike,
          options.resolveAccessToken,
        ),
      (args) => ({
        operation_id: "read_attachment",
        method: "GET",
        target_id:
          typeof (args as AttachmentReadArgs).resourceId === "string"
            ? (args as AttachmentReadArgs).resourceId
            : undefined,
      }),
    ),
  );
}
