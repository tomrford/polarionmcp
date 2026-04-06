import createClient from "openapi-fetch";
import type { paths } from "../generated/polarion.ts";

const rawBaseUrl = Deno.env.get("POLARION_BASE_URL");

if (!rawBaseUrl) throw new Error("POLARION_BASE_URL is not set");

const baseUrl: string = rawBaseUrl;

export function getPolarionBaseUrl(): string {
  return baseUrl;
}

export const client = createClient<paths>({
  baseUrl,
  headers: {
    Accept: "application/json",
  },
});
