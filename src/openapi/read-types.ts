export type ReadOperationResourceGroup =
  | "collections"
  | "documents"
  | "enumerations"
  | "metadata"
  | "misc"
  | "pages"
  | "plans"
  | "projects"
  | "revisions"
  | "roles"
  | "testruns"
  | "users"
  | "workitems";

export type ReadPolicyMode = "curated" | "allowed" | "advanced" | "blocked";

export interface ReadOperationCatalogEntry {
  operationId: string;
  pathTemplate: string;
  pathParamNames: string[];
  queryParamNames: string[];
  resourceGroup: ReadOperationResourceGroup;
  isProjectScoped: boolean;
  isAllScope: boolean;
  description: string;
}

export interface ReadPolicyEntry {
  mode: ReadPolicyMode;
  reason: string;
  preferredTool?: string;
  resourceGroup: ReadOperationResourceGroup;
  advancedWarning?: string;
}

export interface ResolvedReadOperation {
  catalogEntry: ReadOperationCatalogEntry;
  policy: ReadPolicyEntry;
}
