import {
  READ_OPERATION_CATALOG,
  READ_OPERATION_CATALOG_BY_ID,
} from "./read-catalog.ts";
import type {
  ReadOperationCatalogEntry,
  ReadPolicyEntry,
  ReadPolicyMode,
  ResolvedReadOperation,
} from "./read-types.ts";

const CURATED_TOOL_BY_OPERATION_ID = {
  getProjects: "list_projects",
  getWorkItems: "list_work_items",
  getWorkItem: "get_work_item",
  getDocuments: "list_documents",
  getDocument: "get_document",
  getLinkedWorkItems: "list_linked_work_items",
  getProjectFieldsMetadata: "get_fields_metadata",
  getAvailableEnumOptionsForWorkItemType: "get_enum_options",
  getWorkflowActionsForWorkItem: "get_workflow_actions",
} as const;

const ADVANCED_OPERATION_IDS = new Set([
  "getAllDocuments",
  "getAllPages",
  "getAllWorkItems",
  "getCurrentUser",
  "getGlobalCustomFields",
  "getGlobalEnumeration",
  "getGlobalEnumerations",
  "getGlobalFieldsMetadata",
  "getGlobalPages",
  "getMetadata",
  "getProjectTemplates",
  "getProjects",
  "getRepositorySpacePages",
  "getRevisions",
  "getRole",
  "getUser",
  "getUserGroup",
  "getUsers",
]);

const BLOCKED_OPERATION_IDS = new Set([
  "getAvatar",
  "getDefaultIcon",
  "getDefaultIcons",
  "getDocumentAttachmentContent",
  "getExportExcelTests",
  "getGlobalIcon",
  "getGlobalIcons",
  "getJob",
  "getJobLogContent",
  "getJobResultFileContent",
  "getJobs",
  "getLicense",
  "getLicenseAssignments",
  "getLicenseAssignmentsForUser",
  "getLicenseSlot",
  "getLicenseSlots",
  "getPageAttachmentContent",
  "getProjectIcon",
  "getProjectIcons",
  "getTestRecordAttachmentContent",
  "getTestRunAttachmentContent",
  "getTestStepResultAttachmentContent",
  "getWorkItemAttachmentContent",
]);

function classifyMode(entry: ReadOperationCatalogEntry): ReadPolicyMode {
  if (entry.operationId in CURATED_TOOL_BY_OPERATION_ID) return "curated";
  if (BLOCKED_OPERATION_IDS.has(entry.operationId)) return "blocked";
  if (ADVANCED_OPERATION_IDS.has(entry.operationId) || entry.isAllScope) {
    return "advanced";
  }
  return "allowed";
}

function reasonForMode(
  mode: ReadPolicyMode,
  entry: ReadOperationCatalogEntry,
): string {
  switch (mode) {
    case "curated":
      return "Covered by a curated high-signal tool.";
    case "advanced":
      return entry.isAllScope
        ? "Cross-project / all-project read requires explicit opt-in."
        : "Global read surface should require explicit advanced intent.";
    case "blocked":
      return "Blocked because the endpoint is binary, admin-like, export-oriented, or otherwise low-signal for MCP usage.";
    case "allowed":
      return "Safe project-scoped read available through the generic read escape hatch.";
  }
}

function advancedWarning(entry: ReadOperationCatalogEntry): string | undefined {
  if (classifyMode(entry) !== "advanced") return undefined;
  if (entry.isAllScope) {
    return "This operation reads across all projects. Use only with explicit all-project intent and tight filters.";
  }
  return "This operation is global rather than project-scoped. Use only when curated or project-scoped reads do not fit.";
}

export const READ_POLICY: Record<string, ReadPolicyEntry> = Object.fromEntries(
  READ_OPERATION_CATALOG.map((entry) => {
    const mode = classifyMode(entry);
    const preferredTool =
      mode === "curated"
        ? CURATED_TOOL_BY_OPERATION_ID[
            entry.operationId as keyof typeof CURATED_TOOL_BY_OPERATION_ID
          ]
        : undefined;

    return [
      entry.operationId,
      {
        mode,
        reason: reasonForMode(mode, entry),
        preferredTool,
        resourceGroup: entry.resourceGroup,
        advancedWarning: advancedWarning(entry),
      } satisfies ReadPolicyEntry,
    ];
  }),
);

export function getReadPolicy(operationId: string): ReadPolicyEntry | undefined {
  return READ_POLICY[operationId];
}

export function resolveReadOperation(
  operationId: string,
): ResolvedReadOperation | undefined {
  const catalogEntry = READ_OPERATION_CATALOG_BY_ID.get(operationId);
  const policy = READ_POLICY[operationId];
  if (!catalogEntry || !policy) return undefined;
  return { catalogEntry, policy };
}

export function getResolvedReadOperations(): ResolvedReadOperation[] {
  return READ_OPERATION_CATALOG.map((catalogEntry) => ({
    catalogEntry,
    policy: READ_POLICY[catalogEntry.operationId]!,
  }));
}
