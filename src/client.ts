import createClient from "openapi-fetch";
import type { paths } from "../generated/polarion.ts";

const baseUrl = process.env["POLARION_BASE_URL"];

if (!baseUrl) throw new Error("POLARION_BASE_URL is not set");

export const client = createClient<paths>({
  baseUrl,
  headers: {
    Accept: "application/json",
  },
});
