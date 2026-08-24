import type { ToolLifecycleItemType } from "@cafecode/contracts";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const TOOL_ARGUMENT_PREVIEW_MAX_CHARS = 400;
const TOOL_ARGUMENT_PREVIEW_MAX_DEPTH = 4;
const TOOL_ARGUMENT_PREVIEW_MAX_KEYS = 16;
const TOOL_ARGUMENT_PREVIEW_MAX_ARRAY_ITEMS = 12;

function isSensitiveToolArgumentKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
  return (
    normalized === "auth" ||
    normalized === "authorization" ||
    normalized === "cookie" ||
    normalized === "headers" ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("credential") ||
    normalized.endsWith("credentials") ||
    normalized.endsWith("password") ||
    normalized.endsWith("privatekey") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("token")
  );
}

function sanitizeToolArgumentText(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Bidi_Control}]+/gu, " ")
    .replace(/(authorization:\s*bearer\s+)[^\s"']+/giu, "$1[redacted]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{16,}/giu, "$1[redacted]")
    .replace(/\b(?:npm_|sk-)[A-Za-z0-9_-]{16,}\b/gu, "[redacted]")
    .replace(/\s+/gu, " ")
    .trim();
}

function sanitizeToolArgumentPreview(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "string") {
    return sanitizeToolArgumentText(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if (seen.has(value)) {
    return "[circular]";
  }
  if (depth >= TOOL_ARGUMENT_PREVIEW_MAX_DEPTH) {
    return Array.isArray(value) ? "[array omitted]" : "[object omitted]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const preview = value
      .slice(0, TOOL_ARGUMENT_PREVIEW_MAX_ARRAY_ITEMS)
      .map((entry) => sanitizeToolArgumentPreview(entry, depth + 1, seen));
    if (value.length > TOOL_ARGUMENT_PREVIEW_MAX_ARRAY_ITEMS) {
      preview.push(`[${value.length - TOOL_ARGUMENT_PREVIEW_MAX_ARRAY_ITEMS} more items]`);
    }
    return preview;
  }

  const preview: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (const [key, entryValue] of entries.slice(0, TOOL_ARGUMENT_PREVIEW_MAX_KEYS)) {
    preview[key] = isSensitiveToolArgumentKey(key)
      ? "[redacted]"
      : sanitizeToolArgumentPreview(entryValue, depth + 1, seen);
  }
  if (entries.length > TOOL_ARGUMENT_PREVIEW_MAX_KEYS) {
    preview.omittedKeyCount = entries.length - TOOL_ARGUMENT_PREVIEW_MAX_KEYS;
  }
  return preview;
}

/**
 * Builds a compact user-visible preview of provider tool arguments.
 *
 * Provider MCP/dynamic-tool inputs are untrusted and can contain both very
 * large values and credentials. Keep this presentation bounded and redact
 * common secret-bearing keys before it is copied into the durable work log.
 */
export function summarizeToolArguments(
  value: unknown,
  maxChars = TOOL_ARGUMENT_PREVIEW_MAX_CHARS,
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const record = asRecord(value);
  if (record && Object.keys(record).length === 0) {
    return undefined;
  }
  if (Array.isArray(value) && value.length === 0) {
    return undefined;
  }
  const sanitized = sanitizeToolArgumentPreview(value, 0, new WeakSet<object>());
  const serialized =
    typeof sanitized === "string" ? sanitized : (JSON.stringify(sanitized) ?? undefined);
  const normalized = asTrimmedString(serialized);
  if (!normalized) {
    return undefined;
  }
  if (maxChars <= 3) {
    return normalized.slice(0, Math.max(0, maxChars));
  }
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 3)}...` : normalized;
}

function normalizeCommandValue(value: unknown): string | undefined {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value
    .map((entry) => asTrimmedString(entry))
    .filter((entry): entry is string => entry !== undefined);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function stripTrailingExitCode(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = /^(?<output>[\s\S]*?)(?:\s*<exited with exit code \d+>)\s*$/iu.exec(trimmed);
  const output = match?.groups?.output?.trim() ?? trimmed;
  return output.length > 0 ? output : undefined;
}

function extractCommandFromTitle(title: string | undefined): string | undefined {
  if (!title) {
    return undefined;
  }
  const backtickMatch = /`([^`]+)`/u.exec(title);
  return backtickMatch?.[1]?.trim() || undefined;
}

function extractToolCommand(data: Record<string, unknown> | undefined, title: string | undefined) {
  const item = asRecord(data?.item);
  const itemInput = asRecord(item?.input);
  const itemResult = asRecord(item?.result);
  const rawInput = asRecord(data?.rawInput);
  const candidates = [
    normalizeCommandValue(item?.command),
    normalizeCommandValue(itemInput?.command),
    normalizeCommandValue(itemResult?.command),
    normalizeCommandValue(data?.command),
    normalizeCommandValue(rawInput?.command),
  ];
  const direct = candidates.find((candidate) => candidate !== undefined);
  if (direct) {
    return direct;
  }
  const executable = asTrimmedString(rawInput?.executable);
  const args = normalizeCommandValue(rawInput?.args);
  if (executable && args) {
    return `${executable} ${args}`;
  }
  if (executable) {
    return executable;
  }
  return extractCommandFromTitle(title);
}

function maybePathLike(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (
    value.includes("/") ||
    value.includes("\\") ||
    value.startsWith(".") ||
    /\.(?:[a-z0-9]{1,12})$/iu.test(value)
  ) {
    return value;
  }
  return undefined;
}

function collectPaths(value: unknown, paths: string[], seen: Set<string>, depth: number): void {
  if (depth > 4 || paths.length >= 8) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectPaths(entry, paths, seen, depth + 1);
      if (paths.length >= 8) {
        return;
      }
    }
    return;
  }
  const record = asRecord(value);
  if (!record) {
    return;
  }
  for (const key of ["path", "filePath", "relativePath", "filename", "newPath", "oldPath"]) {
    const candidate = maybePathLike(asTrimmedString(record[key]));
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    paths.push(candidate);
    if (paths.length >= 8) {
      return;
    }
  }
  for (const nestedKey of ["locations", "item", "input", "result", "rawInput", "data", "changes"]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectPaths(record[nestedKey], paths, seen, depth + 1);
    if (paths.length >= 8) {
      return;
    }
  }
}

function extractPrimaryPath(data: Record<string, unknown> | undefined): string | undefined {
  const paths: string[] = [];
  collectPaths(data, paths, new Set<string>(), 0);
  return paths[0];
}

function normalizeEquivalentValue(value: string | undefined): string | undefined {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    return undefined;
  }
  return trimmed
    .replace(/\s+/gu, " ")
    .replace(/\s+(?:complete|completed|started)\s*$/iu, "")
    .trim();
}

function isEquivalent(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizeEquivalentValue(left)?.toLowerCase();
  const normalizedRight = normalizeEquivalentValue(right)?.toLowerCase();
  return normalizedLeft !== undefined && normalizedLeft === normalizedRight;
}

function classifyToolAction(input: {
  readonly itemType?: ToolLifecycleItemType | null | undefined;
  readonly title?: string | undefined;
  readonly data?: Record<string, unknown> | undefined;
}): "command" | "read" | "file_change" | "search" | "other" {
  const itemType = input.itemType ?? undefined;
  const kind = asTrimmedString(input.data?.kind)?.toLowerCase();
  const title = asTrimmedString(input.title)?.toLowerCase();
  if (itemType === "command_execution" || kind === "execute" || title === "terminal") {
    return "command";
  }
  if (kind === "read" || title === "read file") {
    return "read";
  }
  if (
    itemType === "file_change" ||
    kind === "edit" ||
    kind === "move" ||
    kind === "delete" ||
    kind === "write"
  ) {
    return "file_change";
  }
  if (itemType === "web_search" || kind === "search" || title === "find" || title === "grep") {
    return "search";
  }
  return "other";
}

export interface ToolActivityPresentationInput {
  readonly itemType?: ToolLifecycleItemType | null | undefined;
  readonly title?: string | null | undefined;
  readonly detail?: string | null | undefined;
  readonly data?: unknown;
  readonly fallbackSummary?: string | null | undefined;
}

export interface ToolActivityPresentation {
  readonly summary: string;
  readonly detail?: string | undefined;
}

export function deriveToolActivityPresentation(
  input: ToolActivityPresentationInput,
): ToolActivityPresentation {
  const title = asTrimmedString(input.title);
  const detail = stripTrailingExitCode(asTrimmedString(input.detail));
  const fallbackSummary = asTrimmedString(input.fallbackSummary) ?? "Tool";
  const data = asRecord(input.data);
  const rawInput = asRecord(data?.rawInput);
  const rawOutput = asRecord(data?.rawOutput);
  const rawOutputAction = asRecord(rawOutput?.action);
  const command = extractToolCommand(data, title);
  const primaryPath = extractPrimaryPath(data);
  const action = classifyToolAction({
    itemType: input.itemType,
    title,
    data,
  });

  if (action === "command") {
    return {
      summary: "Ran command",
      ...(command ? { detail: command } : {}),
    };
  }

  if (action === "read") {
    if (primaryPath) {
      return {
        summary: "Read file",
        detail: primaryPath,
      };
    }
    return {
      summary: "Read file",
    };
  }

  if (action === "file_change") {
    return {
      summary: "Changed files",
      ...(primaryPath ? { detail: primaryPath } : {}),
    };
  }

  if (action === "search") {
    const query = summarizeToolArguments(
      asTrimmedString(rawInput?.query) ??
        asTrimmedString(rawInput?.pattern) ??
        asTrimmedString(rawInput?.searchTerm) ??
        asTrimmedString(rawInput?.url) ??
        asTrimmedString(asRecord(rawInput?.tool_input)?.query) ??
        asTrimmedString(asRecord(rawInput?.tool_input)?.pattern) ??
        asTrimmedString(asRecord(rawInput?.tool_input)?.searchTerm) ??
        // Grok 1.0.4's completed web-search update keeps the query beside the
        // sources in rawOutput.action rather than repeating it in rawInput.
        asTrimmedString(rawOutputAction?.query),
    );
    return {
      summary: "Searched files",
      ...(query ? { detail: query } : {}),
    };
  }

  if (detail && !isEquivalent(detail, title) && !isEquivalent(detail, fallbackSummary)) {
    return {
      summary: title ?? fallbackSummary,
      detail,
    };
  }

  const nestedToolArguments = summarizeToolArguments(rawInput?.tool_input);
  if (nestedToolArguments) {
    return {
      summary: title ?? fallbackSummary,
      detail: nestedToolArguments,
    };
  }

  return {
    summary: title ?? fallbackSummary,
  };
}
