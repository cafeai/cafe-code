// Native checkout/fixture IO retains its existing descriptor, identity and lifetime semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { readFile } from "node:fs/promises";

export function parseJsonText(jsonText: string): unknown {
  return JSON.parse(jsonText.charCodeAt(0) === 0xfeff ? jsonText.slice(1) : jsonText);
}

export async function readJsonFile(filePath: string): Promise<unknown> {
  return parseJsonText(await readFile(filePath, "utf8"));
}
