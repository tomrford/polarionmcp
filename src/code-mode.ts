export function isCodeModeRequest(url: URL): boolean {
  return url.searchParams.get("codemode") !== "false";
}

export function isCodeModeProcess(
  args: string[] = Deno.args,
  env: { get(name: string): string | undefined } = Deno.env,
): boolean {
  if (args.includes("--codemode=false")) return false;

  const flagIndex = args.indexOf("--codemode");
  if (flagIndex >= 0 && args[flagIndex + 1] === "false") return false;

  return env.get("CODEMODE") !== "false";
}
