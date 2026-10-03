import { readFileSync } from "node:fs";

/**
 * Read the one reviewed standalone Node pin, never process.version or a moving
 * LTS alias. Exact digits make this value safe for archive URLs and structured
 * version comparisons. One normal LF/CRLF terminator is allowed, but aliases,
 * ranges, prereleases, padding and multiple lines cannot silently select a
 * different runtime. Electron's bundled runtime deliberately does not use it.
 */
export function parseRepositoryNodeVersion(contents: string): string {
  const version = contents.endsWith("\r\n")
    ? contents.slice(0, -2)
    : contents.endsWith("\n")
      ? contents.slice(0, -1)
      : contents;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version);
  if (
    contents.length > 64 ||
    match === null ||
    match[0] !== version ||
    !match.slice(1).every((component) => Number.isSafeInteger(Number(component)))
  ) {
    throw new Error(".node-version must contain one exact stable Node.js version.");
  }
  return version;
}

export const REPOSITORY_NODE_VERSION = parseRepositoryNodeVersion(
  readFileSync(new URL("../../.node-version", import.meta.url), "utf8"),
);
