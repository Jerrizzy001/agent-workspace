export function providerModel(
  provider: string,
  requested?: unknown,
): string | undefined {
  if (requested === undefined) return undefined;
  if (
    typeof requested !== "string" ||
    /[\r\n\0]/.test(requested) ||
    Buffer.byteLength(requested) > 200
  )
    throw new Error("Invalid provider model");
  const model = requested.trim();
  if (!model) return undefined;
  if (provider === "shell")
    throw new Error("Shell sessions do not support a model");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model))
    throw new Error("Invalid provider model");
  return model;
}
/** Interactive positional prompts verified against installed CLI --help. No global settings changes. */
export function providerArguments(
  provider: string,
  task: { title: string; description: string },
  requested?: unknown,
  requestedModel?: unknown,
): string[] {
  const model = providerModel(provider, requestedModel);
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
  return [...(model ? ["--model", model] : []), "--", prompt];
}
