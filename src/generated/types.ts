export type JsonSchema = Record<string, unknown>;

export type GeneratedOperation = {
  name: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  pathTemplate: string;
  description: string;
  resourceGroup: string;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  input: {
    required: string[];
    schema: JsonSchema;
    pathParams: string[];
    queryParams: string[];
    hasPageObject: boolean;
    hasBody: boolean;
  };
  wire: {
    pathParamMap: Record<string, string>;
    queryParamMap: Record<string, string>;
    pageParamMap?: { size: "page[size]"; number: "page[number]" };
    bodyContentType?: "application/json";
  };
  output: {
    mode: "json" | "no_content";
    summary: string;
  };
  meta: {
    inputSummary: string;
  };
};
