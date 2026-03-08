export interface PaginationMeta {
  total: number | undefined;
  page_size: number;
  page_number: number;
  has_next: boolean;
}

export function pagination(
  totalCount: number | undefined,
  pageSize: number,
  pageNumber: number,
  nextLink: string | undefined,
): PaginationMeta {
  return {
    total: totalCount,
    page_size: pageSize,
    page_number: pageNumber,
    has_next: !!nextLink,
  };
}

export function errorResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    isError: true,
  };
}

export function ok(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

export function fieldsParam(resourceType: string, fields?: string) {
  if (!fields) return undefined;
  return { [resourceType]: fields } as Record<string, string>;
}
