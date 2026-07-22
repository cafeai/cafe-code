import { readFile } from "node:fs/promises";

export function parseJsonText(jsonText: string): unknown {
  return JSON.parse(jsonText.charCodeAt(0) === 0xfeff ? jsonText.slice(1) : jsonText);
}

export async function readJsonFile(filePath: string): Promise<unknown> {
  return parseJsonText(await readFile(filePath, "utf8"));
}
