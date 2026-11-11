/** Inspect the actual model-facing invocation while allowing each session to
 * mint its own private namespace. The surrounding user/provider prompt remains
 * available for exact policy assertions in the adapter tests. */
export function inspectSecretRunnerInstructions(instructions: string | undefined) {
  const start = instructions?.indexOf("\n\nCafe Secrets:") ?? -1;
  if (!instructions || start < 0) throw new Error("Cafe Secrets runner guidance is missing.");
  const next = instructions.indexOf("\n\n", start + 2);
  const end = next < 0 ? instructions.length : next;
  const block = instructions.slice(start, end);
  const match = /--cafe-secret-exec '([^\r\n]+)' '<JSON request>'(?:\n|$)/.exec(block);
  if (!match) throw new Error("Cafe Secrets runner invocation is missing.");
  return {
    withoutRunner: instructions.slice(0, start) + instructions.slice(end),
    connectionPath:
      process.platform === "win32"
        ? match[1]!.replaceAll("''", "'")
        : match[1]!.replaceAll("'\\''", "'"),
  };
}
