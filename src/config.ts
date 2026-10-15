import { env } from "cloudflare:workers";
import { DEFAULT_GUIDELINES } from "./guidelines";

export type PolarionConfig = {
  baseUrl: string;
  guidelines: string;
  restPageSize?: number;
  fetchConcurrencyCount: number;
  collectionPageCap?: number;
  collectionItemCap?: number;
  inlineAttachmentMaxBytes: number;
};

const DEFAULT_INLINE_ATTACHMENT_MAX_BYTES = 1_000_000;
const HARD_INLINE_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;

function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function positiveOverride(name: string, value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer; received ${value}.`);
  }
  return value;
}

function optionalPositiveInt(name: string, value: string | undefined): number | undefined {
  const raw = optionalText(value);
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer; received ${value}.`);
  }
  return parsed;
}

export function polarionConfig(overrides: Partial<PolarionConfig> = {}): PolarionConfig {
  const baseUrl = optionalText(overrides.baseUrl ?? env.POLARION_BASE_URL);
  if (!baseUrl) throw new Error("POLARION_BASE_URL is not set");

  const inline =
    overrides.inlineAttachmentMaxBytes ??
    optionalPositiveInt(
      "READ_ATTACHMENT_INLINE_RESULT_MAX_BYTES",
      env.READ_ATTACHMENT_INLINE_RESULT_MAX_BYTES,
    ) ??
    DEFAULT_INLINE_ATTACHMENT_MAX_BYTES;
  if (inline > HARD_INLINE_ATTACHMENT_MAX_BYTES) {
    throw new Error(
      `READ_ATTACHMENT_INLINE_RESULT_MAX_BYTES must be an integer from 1 to ${HARD_INLINE_ATTACHMENT_MAX_BYTES}.`,
    );
  }

  return {
    baseUrl,
    guidelines: optionalText(overrides.guidelines ?? env.POLARION_GUIDELINES) ?? DEFAULT_GUIDELINES,
    restPageSize:
      overrides.restPageSize ?? optionalPositiveInt("REST_PAGE_SIZE", env.REST_PAGE_SIZE),
    fetchConcurrencyCount:
      overrides.fetchConcurrencyCount ??
      optionalPositiveInt("FETCH_CONCURRENCY_COUNT", env.FETCH_CONCURRENCY_COUNT) ??
      1,
    collectionPageCap: positiveOverride("collectionPageCap", overrides.collectionPageCap),
    collectionItemCap: positiveOverride("collectionItemCap", overrides.collectionItemCap),
    inlineAttachmentMaxBytes: inline,
  };
}
