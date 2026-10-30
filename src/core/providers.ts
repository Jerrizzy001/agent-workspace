/** Interactive positional prompts verified against installed CLI --help. No global settings changes. */
export function providerArguments(
  provider: string,
  task: { title: string; description: string },
  requested?: unknown,
): string[] {
  if (provider === "shell") return [];
  const prompt =
    requested === undefined
      ? [task.title, task.description].filter(Boolean).join("\n\n")
      : requested;
  if (
    typeof prompt !== "string" ||
    !prompt.trim() ||
    prompt.includes("\0") ||
    Buffer.byteLength(prompt) > 65536
  )
    throw new Error("Invalid initial prompt");
  return ["--", prompt];
}
