import { getPolarionBaseUrl } from "./config";
import { type ErrorResponse, makeError } from "./errors";

export const ATTACHMENT_RESOURCE_TYPES = [
  "document_attachments",
  "page_attachments",
  "workitem_attachments",
  "testrun_attachments",
  "testrecord_attachments",
  "teststepresult_attachments",
] as const;

export type AttachmentResourceType = (typeof ATTACHMENT_RESOURCE_TYPES)[number];

export type AttachmentReferenceArgs = {
  contentUrl?: string;
  resourceType?: AttachmentResourceType;
  resourceId?: string;
  revision?: string;
};

type RouteError = { error: ErrorResponse };
type ResourceShape = {
  parts: number;
  path: (parts: string[]) => string;
};

const RESOURCE_SHAPES: Record<AttachmentResourceType, ResourceShape> = {
  document_attachments: {
    parts: 4,
    path: ([projectId, spaceId, documentName, attachmentId]) =>
      `/projects/${encode(projectId)}/spaces/${encode(spaceId)}/documents/${encode(
        documentName,
      )}/attachments/${encode(attachmentId)}/content`,
  },
  page_attachments: {
    parts: 4,
    path: ([projectId, spaceId, pageName, attachmentId]) =>
      `/projects/${encode(projectId)}/spaces/${encode(spaceId)}/pages/${encode(
        pageName,
      )}/attachments/${encode(attachmentId)}/content`,
  },
  workitem_attachments: {
    parts: 3,
    path: ([projectId, workItemId, attachmentId]) =>
      `/projects/${encode(projectId)}/workitems/${encode(workItemId)}/attachments/${encode(
        attachmentId,
      )}/content`,
  },
  testrun_attachments: {
    parts: 3,
    path: ([projectId, testRunId, attachmentId]) =>
      `/projects/${encode(projectId)}/testruns/${encode(testRunId)}/attachments/${encode(
        attachmentId,
      )}/content`,
  },
  testrecord_attachments: {
    parts: 6,
    path: ([projectId, testRunId, testCaseProjectId, testCaseId, iteration, attachmentId]) =>
      `/projects/${encode(projectId)}/testruns/${encode(testRunId)}/testrecords/${encode(
        testCaseProjectId,
      )}/${encode(testCaseId)}/${encode(iteration)}/attachments/${encode(attachmentId)}/content`,
  },
  teststepresult_attachments: {
    parts: 7,
    path: ([
      projectId,
      testRunId,
      testCaseProjectId,
      testCaseId,
      iteration,
      testStepIndex,
      attachmentId,
    ]) =>
      `/projects/${encode(projectId)}/testruns/${encode(testRunId)}/testrecords/${encode(
        testCaseProjectId,
      )}/${encode(testCaseId)}/${encode(iteration)}/teststepresults/${encode(
        testStepIndex,
      )}/attachments/${encode(attachmentId)}/content`,
  },
};

function encode(value: string | undefined) {
  return encodeURIComponent(value ?? "");
}

function basePath(base: URL) {
  if (base.pathname === "/") return "";
  return base.pathname.endsWith("/") ? base.pathname.slice(0, -1) : base.pathname;
}

function urlForContentPath(path: string, revision: string | undefined) {
  const base = new URL(getPolarionBaseUrl());
  const url = new URL(base.toString());
  url.pathname = `${basePath(base)}${path}`;
  url.search = "";
  url.hash = "";
  if (revision) url.searchParams.set("revision", revision);
  return url;
}

function urlForRestRelative(rawPathAndQuery: string) {
  const base = new URL(getPolarionBaseUrl());
  const relative = rawPathAndQuery.startsWith("/") ? rawPathAndQuery : `/${rawPathAndQuery}`;
  return new URL(`${basePath(base)}${relative}`, base);
}

function pathWithinBase(url: URL, base: URL): string | undefined {
  const prefix = basePath(base);
  if (!prefix) return url.pathname;
  if (url.pathname === prefix) return "/";
  return url.pathname.startsWith(`${prefix}/`) ? url.pathname.slice(prefix.length) : undefined;
}

function isAttachmentContentPath(path: string) {
  return [
    /^\/projects\/[^/]+\/spaces\/[^/]+\/documents\/[^/]+\/attachments\/[^/]+\/content$/,
    /^\/projects\/[^/]+\/spaces\/[^/]+\/pages\/[^/]+\/attachments\/[^/]+\/content$/,
    /^\/projects\/[^/]+\/workitems\/[^/]+\/attachments\/[^/]+\/content$/,
    /^\/projects\/[^/]+\/testruns\/[^/]+\/attachments\/[^/]+\/content$/,
    /^\/projects\/[^/]+\/testruns\/[^/]+\/testrecords\/[^/]+\/[^/]+\/[^/]+\/attachments\/[^/]+\/content$/,
    /^\/projects\/[^/]+\/testruns\/[^/]+\/testrecords\/[^/]+\/[^/]+\/[^/]+\/teststepresults\/[^/]+\/attachments\/[^/]+\/content$/,
  ].some((pattern) => pattern.test(path));
}

function resolveContentUrl(
  rawUrl: string,
  revision: string | undefined,
): { url: URL } | RouteError {
  const base = new URL(getPolarionBaseUrl());
  let url: URL;

  try {
    const trimmed = rawUrl.trim();
    if (trimmed.startsWith("/projects/")) {
      url = urlForRestRelative(trimmed);
    } else if (trimmed.startsWith("projects/")) {
      url = urlForRestRelative(trimmed);
    } else {
      url = new URL(trimmed, base);
    }
  } catch {
    return { error: makeError(400, "Invalid attachment content URL", rawUrl) };
  }

  if (revision) url.searchParams.set("revision", revision);

  if (url.username || url.password || url.origin !== base.origin) {
    return {
      error: makeError(403, "Rejected attachment URL", `URL must stay within ${base.origin}.`),
    };
  }

  if (url.hash) {
    return { error: makeError(400, "Rejected attachment URL", "Fragments are not supported.") };
  }

  const relativePath = pathWithinBase(url, base);
  if (!relativePath || !isAttachmentContentPath(relativePath)) {
    return {
      error: makeError(
        403,
        "Rejected attachment URL",
        "URL is not a known Polarion attachment content route.",
      ),
    };
  }

  for (const key of new Set(url.searchParams.keys())) {
    if (key !== "revision") {
      return {
        error: makeError(400, "Rejected attachment URL", `Unsupported query parameter: ${key}`),
      };
    }
  }

  return { url };
}

function resolveResourceId(
  resourceType: AttachmentResourceType,
  resourceId: string,
  revision: string | undefined,
): { url: URL } | RouteError {
  const shape = RESOURCE_SHAPES[resourceType];
  const parts = resourceId.split("/");

  if (parts.length !== shape.parts || parts.some((part) => part.length === 0)) {
    return {
      error: makeError(
        400,
        "Invalid attachment resourceId",
        `${resourceType} resource IDs must have ${shape.parts} slash-separated parts.`,
      ),
    };
  }

  return { url: urlForContentPath(shape.path(parts), revision) };
}

export function resolveAttachmentContentUrl(
  args: AttachmentReferenceArgs,
): { url: URL } | RouteError {
  if (args.contentUrl && (args.resourceType || args.resourceId)) {
    return {
      error: makeError(
        400,
        "Ambiguous attachment reference",
        "Use contentUrl or resourceType/resourceId.",
      ),
    };
  }

  if (args.contentUrl) return resolveContentUrl(args.contentUrl, args.revision);
  if (args.resourceType && args.resourceId) {
    return resolveResourceId(args.resourceType, args.resourceId, args.revision);
  }

  return {
    error: makeError(
      400,
      "Missing attachment reference",
      "Provide contentUrl from attachment links.content, or resourceType and resourceId from attachment metadata.",
    ),
  };
}
