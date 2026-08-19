const CHARS_PER_TOKEN = 4;
const MAX_TOKENS = 6_000;
const MAX_CHARS = MAX_TOKENS * CHARS_PER_TOKEN;

export function truncateResponse(content: unknown): string {
  const text = typeof content === "string" ? content : (JSON.stringify(content) ?? "undefined");
  if (text.length <= MAX_CHARS) return text;

  return `${text.slice(0, MAX_CHARS)}\n\n--- TRUNCATED ---\nResponse was ~${Math.ceil(
    text.length / CHARS_PER_TOKEN,
  ).toLocaleString()} tokens (limit: ${MAX_TOKENS.toLocaleString()}). Your code already ran successfully. Return a smaller filtered or aggregated value to send less data back to the agent.`;
}
