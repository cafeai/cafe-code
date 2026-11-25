import { decodeString } from "micromark-util-decode-string";

import { formatWorkspaceRelativePath } from "./filePathDisplay";
import { resolvePathLinkTarget, splitPathAndPosition } from "./path-links";

const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\/;
const EXTERNAL_SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/;
const RELATIVE_PATH_PREFIX_PATTERN = /^(~\/|\.{1,2}[\\/])/;
const RELATIVE_FILE_PATH_PATTERN = /^[A-Za-z0-9._() -]+(?:[\\/][A-Za-z0-9._() -]+)+(?::\d+){0,2}$/;
const RELATIVE_FILE_NAME_PATTERN = /^[A-Za-z0-9._() -]+\.[A-Za-z0-9_-]+(?::\d+){0,2}$/;
const POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;
const POSITION_ONLY_PATTERN = /^\d+(?::\d+)?$/;
const POSIX_FILE_ROOT_PREFIXES = [
  "/Users/",
  "/home/",
  "/tmp/",
  "/var/",
  "/etc/",
  "/opt/",
  "/mnt/",
  "/Volumes/",
  "/private/",
  "/root/",
] as const;

interface MarkdownLinkDestination {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

function markdownCodeFenceRanges(source: string): ReadonlyArray<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let active: { start: number; indent: string; marker: string } | undefined;
  const fenceLines = /^([ \t]{0,3})(`{3,}|~{3,})([^\r\n]*)\r?$/gm;
  for (const line of source.matchAll(fenceLines)) {
    const indent = line[1] ?? "";
    const marker = line[2] ?? "";
    if (!active) {
      active = { start: line.index, indent, marker };
    } else if (
      indent === active.indent &&
      marker[0] === active.marker[0] &&
      marker.length >= active.marker.length &&
      /^[ \t]*$/.test(line[3] ?? "")
    ) {
      ranges.push({ start: active.start, end: line.index + line[0].length });
      active = undefined;
    }
  }
  if (active) ranges.push({ start: active.start, end: source.length });
  return ranges;
}

interface MarkdownLinkNode {
  readonly type: string;
  url?: string;
  readonly children?: ReadonlyArray<MarkdownLinkNode>;
  readonly position?: {
    readonly start: { readonly offset?: number };
    readonly end: { readonly offset?: number };
  };
}

// Windows extended paths are bounded near 32k UTF-16 code units. A source
// destination must not make every malformed opening scan a whole long chat.
const MAX_MARKDOWN_DESTINATION_LENGTH = 32_768;

function readMarkdownDestination(source: string, offset: number): MarkdownLinkDestination | null {
  const limit = Math.min(source.length, offset + MAX_MARKDOWN_DESTINATION_LENGTH);
  while (offset < limit && /\s/u.test(source[offset] ?? "")) offset += 1;
  if (offset === limit) return null;
  const enclosed = source[offset] === "<";
  const start = offset + (enclosed ? 1 : 0);
  let depth = 0;

  // This is a bounded destination reader, not an alternative Markdown parser.
  // Balanced parentheses and escaped punctuation keep the source range intact;
  // only an actual parser-created link/definition may authorize restoration.
  for (let cursor = start; cursor < limit; cursor += 1) {
    const char = source[cursor];
    if (char === "\\" && /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(source[cursor + 1] ?? "")) {
      cursor += 1;
      continue;
    }
    if (enclosed) {
      if (char === "\n" || char === "\r" || char === "<") return null;
      if (char === ">") return { value: source.slice(start, cursor), start, end: cursor };
      continue;
    }
    if (char === "(") {
      depth += 1;
      if (depth > 32) return null;
    } else if (char === ")") {
      if (depth === 0) return { value: source.slice(start, cursor), start, end: cursor };
      depth -= 1;
    } else if (/\s/u.test(char ?? "")) {
      return depth === 0 ? { value: source.slice(start, cursor), start, end: cursor } : null;
    } else if (char === "<") {
      return null;
    }
  }
  return limit === source.length && !enclosed && depth === 0
    ? { value: source.slice(start), start, end: source.length }
    : null;
}

/** Locate destination spans for normalization; these spans do not grant native file access. */
export function extractMarkdownLinkDestinations(
  source: string,
): ReadonlyArray<MarkdownLinkDestination> {
  const destinations: MarkdownLinkDestination[] = [];
  // Text inside a fence is source code or an explicit equation, never a
  // Markdown destination. Shielding `[f](x^2)` inside a math fence would hide
  // its equation syntax from the existing conservative math classifier, and
  // would also prevent subsequent repairs of TeX text-mode identifiers.
  const fences = markdownCodeFenceRanges(source);
  let fenceIndex = 0;
  const openings = /\]\(|^[ \t]*(?:>[ \t]*|(?:[-+*]|\d+[.)])[ \t]+)*\[(?:\\.|[^\]\\\r\n])+\]:/gm;
  for (const opening of source.matchAll(openings)) {
    while (fences[fenceIndex] && opening.index >= fences[fenceIndex]!.end) fenceIndex += 1;
    const fence = fences[fenceIndex];
    if (fence && opening.index >= fence.start) continue;
    const destination = readMarkdownDestination(source, opening.index + opening[0].length);
    if (destination?.value) destinations.push(destination);
  }
  return destinations;
}

/** Keep path escapes/URL delimiters out of provider math normalization. */
export function transformOutsideMarkdownLinkDestinations(
  source: string,
  transform: (text: string) => string,
): string {
  const destinations = extractMarkdownLinkDestinations(source).filter(({ value }) => {
    const decoded = decodeMarkdownLinkDestination(value);
    // Link-shaped equations such as `[f](x^2)` remain visible to the existing
    // standalone-math classifier. Only actual path/URL/fragment spellings need
    // protection from provider delimiter normalization.
    return (
      isLikelyPathCandidate(stripSearchAndHash(decoded).path) ||
      EXTERNAL_SCHEME_PATTERN.test(decoded) ||
      decoded.startsWith("#") ||
      decoded.startsWith("//")
    );
  });
  if (destinations.length === 0) return transform(source);

  // A collision-free inert token keeps each whole destination inside the
  // surrounding Markdown structure. Splitting the message into independent
  // chunks would lose code-fence and multiline-math context at each link.
  const existingMarkers = new Set(
    [...source.matchAll(/CAFELINKDESTINATION(\d+)X/g)].map((match) => match[1]),
  );
  let markerIndex = 0;
  while (existingMarkers.has(String(markerIndex))) markerIndex += 1;
  const marker = `CAFELINKDESTINATION${markerIndex}X`;
  const originals: string[] = [];
  const chunks: string[] = [];
  let offset = 0;
  for (const destination of destinations) {
    if (destination.start < offset) continue;
    chunks.push(source.slice(offset, destination.start), `${marker}${originals.length}END`);
    originals.push(destination.value);
    offset = destination.end;
  }
  chunks.push(source.slice(offset));
  return transform(chunks.join("")).replace(
    new RegExp(`${marker}(\\d+)END`, "g"),
    (token, index: string) => originals[Number(index)] ?? token,
  );
}

/** Match CommonMark's punctuation escapes while keeping native Windows separators literal. */
function isNativeWindowsDestination(source: string, cwd?: string): boolean {
  return (
    /^\/?[A-Za-z]:[\\/]/.test(source) ||
    WINDOWS_UNC_PATH_PATTERN.test(source) ||
    Boolean(
      cwd &&
      (WINDOWS_DRIVE_PATH_PATTERN.test(cwd) || WINDOWS_UNC_PATH_PATTERN.test(cwd)) &&
      // A Windows cwd does not change CommonMark's escape semantics for a
      // slash-based relative URL, e.g. `src/review\(final\).md`. Preserve
      // raw separators only for an explicit relative backslash prefix or a
      // backslash that cannot be a CommonMark punctuation escape. Bare
      // escaped filenames likewise remain ordinary Markdown destinations.
      !source.includes("/") &&
      (/^\.{1,2}\\/.test(source) || /\\[^!-/:-@[-`{-~]/u.test(source)) &&
      !hasExternalScheme(source) &&
      isLikelyPathCandidate(source),
    )
  );
}

export function decodeMarkdownLinkDestination(source: string, cwd?: string): string {
  return isNativeWindowsDestination(source, cwd)
    ? decodeString(source.replaceAll("\\", "&#92;"))
    : decodeString(source);
}

/** Restore native separators before ReactMarkdown applies its URL security policy. */
export function remarkNativeFileDestinations(options?: { readonly cwd?: string | undefined }) {
  return (tree: MarkdownLinkNode, file: { readonly value: unknown }): void => {
    const source = String(file.value);
    const pending = [tree];
    while (pending.length > 0) {
      const node = pending.pop();
      if (!node) continue;
      if (node.children) {
        for (const child of node.children) pending.push(child);
      }
      if (node.type !== "link" && node.type !== "definition") continue;
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined || !node.url) continue;

      // Child offsets exclude destinations inside nested labels/images. The
      // destination must also decode to this exact parser-admitted URL, so a
      // fake link written inside a title can never replace a hostile href.
      const labelEnd =
        node.children?.reduce(
          (offset, child) => Math.max(offset, child.position?.end.offset ?? start),
          start,
        ) ?? start;
      const candidate = extractMarkdownLinkDestinations(source.slice(start, end)).find(
        (destination) => start + destination.start >= labelEnd,
      );
      if (!candidate || decodeString(candidate.value) !== node.url) continue;
      if (
        candidate.value.includes("\\") &&
        isNativeWindowsDestination(candidate.value, options?.cwd)
      ) {
        // Use the parser's own character-reference decoding, but make raw
        // native backslashes literal references before decoding. This keeps
        // `&amp;` filenames working without inventing a partial entity parser.
        node.url = decodeMarkdownLinkDestination(candidate.value, options?.cwd);
      }
    }
  };
}

export interface MarkdownFileLinkMeta {
  filePath: string;
  targetPath: string;
  displayPath: string;
  basename: string;
  openPolicy: "direct" | "confirm";
  line?: number;
  column?: number;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function unwrapMarkdownLinkDestination(value: string): string {
  return value.startsWith("<") && value.endsWith(">") ? value.slice(1, -1) : value;
}

export function normalizeMarkdownLinkDestination(value: string): string {
  return unwrapMarkdownLinkDestination(value.trim());
}

function stripSearchAndHash(value: string): { path: string; hash: string } {
  const hashIndex = value.indexOf("#");
  const pathWithSearch = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const rawHash = hashIndex >= 0 ? value.slice(hashIndex) : "";
  const queryIndex = pathWithSearch.indexOf("?");
  const path = queryIndex >= 0 ? pathWithSearch.slice(0, queryIndex) : pathWithSearch;
  return { path, hash: rawHash };
}

function normalizeWindowsDrivePath(path: string): string {
  const normalizedRoot = path.replace(/^\/?([A-Za-z]):[\\/]+/, "$1:/");
  return /^[A-Za-z]:\//.test(normalizedRoot)
    ? normalizedRoot.replaceAll("\\", "/")
    : normalizedRoot;
}

function parseFileUrlHref(
  href: string,
  options?: { readonly decodePath?: boolean },
): { path: string; hash: string } | null {
  try {
    const parsed = new URL(href);
    if (parsed.protocol.toLowerCase() !== "file:") return null;

    const rawPath = parsed.pathname;
    if (rawPath.length === 0) return null;

    // Browser URL parser encodes "C:/foo" as "/C:/foo" for file URLs.
    // A remote file authority names a Windows UNC share. Silently discarding
    // it would open a different local file, so preserve it through rewriting
    // and the same workspace/confirmation policy as a native UNC destination.
    const normalizedPath = parsed.hostname
      ? `\\\\${parsed.hostname}${rawPath.replaceAll("/", "\\")}`
      : normalizeWindowsDrivePath(rawPath);

    return {
      path: options?.decodePath === false ? normalizedPath : safeDecode(normalizedPath),
      hash: parsed.hash,
    };
  } catch {
    return null;
  }
}

export function rewriteMarkdownFileUriHref(href: string | undefined): string | null {
  if (!href) return null;
  const normalizedHref = normalizeMarkdownLinkDestination(href);
  const target = parseFileUrlHref(normalizedHref, { decodePath: false });
  if (!target) return null;
  return `${target.path}${target.hash}`;
}

function looksLikePosixFilesystemPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (POSIX_FILE_ROOT_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  if (POSITION_SUFFIX_PATTERN.test(path)) return true;
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return /\.[A-Za-z0-9_-]+$/.test(basename);
}

function appendLineColumnFromHash(path: string, hash: string): string {
  if (!hash || POSITION_SUFFIX_PATTERN.test(path)) return path;
  const match = hash.match(/^#L(\d+)(?:C(\d+))?$/i);
  if (!match?.[1]) return path;
  const line = match[1];
  const column = match[2];
  return `${path}:${line}${column ? `:${column}` : ""}`;
}

function isLikelyPathCandidate(path: string): boolean {
  if (WINDOWS_DRIVE_PATH_PATTERN.test(path) || WINDOWS_UNC_PATH_PATTERN.test(path)) return true;
  if (RELATIVE_PATH_PREFIX_PATTERN.test(path)) return true;
  if (path.startsWith("/")) return looksLikePosixFilesystemPath(path);
  return RELATIVE_FILE_PATH_PATTERN.test(path) || RELATIVE_FILE_NAME_PATTERN.test(path);
}

function isRelativePath(path: string): boolean {
  return (
    RELATIVE_PATH_PREFIX_PATTERN.test(path) ||
    (!path.startsWith("/") &&
      !WINDOWS_DRIVE_PATH_PATTERN.test(path) &&
      !WINDOWS_UNC_PATH_PATTERN.test(path))
  );
}

function stripTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/g, "");
}

function normalizePathForWorkspaceComparison(path: string): string {
  const windows = WINDOWS_DRIVE_PATH_PATTERN.test(path) || WINDOWS_UNC_PATH_PATTERN.test(path);
  const normalized = stripTrailingSeparators(
    windows ? normalizeWindowsDrivePath(path).replaceAll("\\", "/") : path,
  );
  return WINDOWS_DRIVE_PATH_PATTERN.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

export function isPathInsideWorkspace(
  targetPath: string,
  cwd: string | undefined,
  additionalWorkspaceRoots: ReadonlyArray<string> = [],
): boolean {
  const workspaceRoots = [cwd, ...additionalWorkspaceRoots].filter(
    (root): root is string => typeof root === "string" && root.trim().length > 0,
  );
  if (workspaceRoots.length === 0) {
    return false;
  }

  const target = normalizePathForWorkspaceComparison(splitPathAndPosition(targetPath).path);
  if (target.length === 0) {
    return false;
  }

  // A textual workspace prefix is inconclusive when traversal appears: an
  // earlier segment can be a symlink, so lexical normalization would invent
  // containment that the filesystem has not established. Preserve the exact
  // destination for the user's action, but require consent for such paths.
  if (target.split("/").includes("..")) return false;

  return workspaceRoots.some((root) => {
    const workspace = normalizePathForWorkspaceComparison(splitPathAndPosition(root).path);
    if (workspace.length === 0) {
      return false;
    }
    return target === workspace || target.startsWith(`${workspace}/`);
  });
}

function hasExternalScheme(path: string): boolean {
  const match = path.match(EXTERNAL_SCHEME_PATTERN);
  if (!match) return false;
  const rest = match[2] ?? "";
  if (rest.startsWith("//")) return true;
  return !POSITION_ONLY_PATTERN.test(rest);
}

export function resolveMarkdownFileLinkTarget(
  href: string | undefined,
  cwd?: string,
): string | null {
  if (!href) return null;
  const rawHref = normalizeMarkdownLinkDestination(href);
  if (rawHref.length === 0 || rawHref.startsWith("#")) return null;
  // Protocol-relative web destinations are not native UNC paths. They remain
  // browser links even when their final segment resembles a source filename.
  if (rawHref.startsWith("//")) return null;

  const fileUrlTarget = rawHref.toLowerCase().startsWith("file:")
    ? parseFileUrlHref(rawHref)
    : null;
  const source = fileUrlTarget ?? stripSearchAndHash(rawHref);
  const decodedPath = normalizeWindowsDrivePath(
    fileUrlTarget ? source.path.trim() : safeDecode(source.path.trim()),
  );
  const decodedHash = safeDecode(source.hash.trim());

  if (decodedPath.length === 0) return null;
  if (
    !WINDOWS_DRIVE_PATH_PATTERN.test(decodedPath) &&
    !WINDOWS_UNC_PATH_PATTERN.test(decodedPath) &&
    hasExternalScheme(decodedPath)
  ) {
    return null;
  }

  if (!isLikelyPathCandidate(decodedPath)) return null;

  const pathWithPosition = appendLineColumnFromHash(decodedPath, decodedHash);
  if (!isRelativePath(pathWithPosition)) {
    return pathWithPosition;
  }

  if (!cwd) return null;
  // `resolvePathLinkTarget` deliberately follows the host path style used by
  // terminal links. Markdown links, however, are also emitted into an `href`.
  // A Windows drive cwd written with forward slashes would otherwise produce
  // a mixed value such as `C:/repo\\docs\\file.md`, which browsers preserve
  // literally and the desktop shell cannot compare consistently. Normalize
  // drive paths again after resolving the relative segment; UNC and POSIX
  // paths retain their existing representation.
  return normalizeWindowsDrivePath(resolvePathLinkTarget(pathWithPosition, cwd));
}

function basenameOfPath(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
}

/** Encode a literal native citation path for the ordinary Markdown link policy. */
export function formatMarkdownFileCitation(path: string, cwd?: string): string | null {
  if (
    !path.trim() ||
    /[\p{Cc}\p{Cs}]/u.test(path) ||
    (!WINDOWS_DRIVE_PATH_PATTERN.test(path) && hasExternalScheme(path))
  ) {
    return null;
  }

  const encoded = encodeURIComponent(path).replaceAll("%2F", "/").replaceAll("%3A", ":");
  const href = isRelativePath(path) && !isLikelyPathCandidate(path) ? `./${encoded}` : encoded;
  const target = resolveMarkdownFileLinkTarget(href, cwd);
  if (!target) return null;

  const basename = basenameOfPath(splitPathAndPosition(target).path);
  if (!basename) return null;
  const label = basename.replace(
    /[\\[\]&<>$*_`~|]/g,
    (character) => `&#${character.charCodeAt(0)};`,
  );
  return `[${label}](<${href}>)`;
}

export function resolveMarkdownFileLinkMeta(
  href: string | undefined,
  cwd?: string,
  additionalWorkspaceRoots: ReadonlyArray<string> = [],
): MarkdownFileLinkMeta | null {
  const targetPath = resolveMarkdownFileLinkTarget(href, cwd);
  if (!targetPath) return null;

  const { path, line, column } = splitPathAndPosition(targetPath);
  const parsedLine = line ? Number.parseInt(line, 10) : Number.NaN;
  const parsedColumn = column ? Number.parseInt(column, 10) : Number.NaN;
  const lineNumber = Number.isFinite(parsedLine) ? parsedLine : undefined;
  const columnNumber = Number.isFinite(parsedColumn) ? parsedColumn : undefined;

  return {
    filePath: path,
    targetPath,
    displayPath: formatWorkspaceRelativePath(targetPath, cwd),
    basename: basenameOfPath(path),
    openPolicy: isPathInsideWorkspace(targetPath, cwd, additionalWorkspaceRoots)
      ? "direct"
      : "confirm",
    ...(lineNumber !== undefined ? { line: lineNumber } : {}),
    ...(columnNumber !== undefined ? { column: columnNumber } : {}),
  };
}
