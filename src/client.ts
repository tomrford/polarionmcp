import createClient from "openapi-fetch";
import type { paths } from "../generated/polarion.ts";

const baseUrl = process.env["POLARION_BASE_URL"];
const token = process.env["POLARION_ACCESS_TOKEN"];

if (!baseUrl) throw new Error("POLARION_BASE_URL is not set");
if (!token) throw new Error("POLARION_ACCESS_TOKEN is not set");

export const client = createClient<paths>({
  baseUrl,
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  },
});
