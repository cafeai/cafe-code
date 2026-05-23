const TOOL_PAYLOAD_MAX_DEPTH = 5;
const TOOL_PAYLOAD_MAX_OBJECT_KEYS = 64;
const TOOL_PAYLOAD_MAX_ARRAY_ITEMS = 32;
const TOOL_PAYLOAD_TEXT_PREVIEW_LIMIT = 2_048;
const TOOL_PAYLOAD_COMMAND_LIMIT = 4_096;
const TOOL_PAYLOAD_CHANGED_FILE_LIMIT = 16;

const OUTPUT_PREVIEW_KEYS = new Set(["aggregatedOutput", "stdout", "stderr", "output"]);
const CONTENT_OMIT_KEYS = new Set([
  "content",
  "contents",
  "fileContent",
  "oldString",
  "newString",
  "old_string",
  "new_string",
  "replacement",
  "patch",
  "diff",
]);
const PATH_KEYS = new Set([
  "path",
  "filePath",
  "file_path",
  "relativePath",
  "relative_path",
  "filename",
  "newPath",
  "new_path",
  "oldPath",
  "old_path",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncatePayloadText(value: string, limit = TOOL_PAYLOAD_TEXT_PREVIEW_LIMIT): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

function isTruncatedPathCandidate(value: string): boolean {
  const normalized = value.trim();
  return (
    normalized.includes("…") || normalized.includes("[truncated]") || normalized.includes("...")
  );
}

function summarizeOmittedText(key: string, value: string): string {
  const lineCount = value.length === 0 ? 0 : value.split(/\r?\n/u).length;
  return `[${key} omitted: ${value.length.toLocaleString()} chars, ${lineCount.toLocaleString()} lines]`;
}

function sanitizePayloadValue(value: unknown, key: string | null, depth: number): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (key && CONTENT_OMIT_KEYS.has(key)) {
      return summarizeOmittedText(key, value);
    }
    const limit = key === "command" ? TOOL_PAYLOAD_COMMAND_LIMIT : TOOL_PAYLOAD_TEXT_PREVIEW_LIMIT;
    return truncatePayloadText(value, limit);
  }
  if (Array.isArray(value)) {
    if (depth >= TOOL_PAYLOAD_MAX_DEPTH) {
      return `[array omitted: ${value.length.toLocaleString()} items]`;
    }
    const sanitized = value
      .slice(0, TOOL_PAYLOAD_MAX_ARRAY_ITEMS)
      .map((entry) => sanitizePayloadValue(entry, null, depth + 1));
    if (value.length > TOOL_PAYLOAD_MAX_ARRAY_ITEMS) {
      sanitized.push(`[${value.length - TOOL_PAYLOAD_MAX_ARRAY_ITEMS} more items omitted]`);
    }
    return sanitized;
  }
  if (!isRecord(value)) {
    return String(value);
  }
  if (depth >= TOOL_PAYLOAD_MAX_DEPTH) {
    return "[object omitted]";
  }

  const output: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (const [entryKey, entryValue] of entries.slice(0, TOOL_PAYLOAD_MAX_OBJECT_KEYS)) {
    if (typeof entryValue === "string" && OUTPUT_PREVIEW_KEYS.has(entryKey)) {
      output[entryKey] = truncatePayloadText(entryValue);
      output[`${entryKey}Truncated`] = entryValue.length > TOOL_PAYLOAD_TEXT_PREVIEW_LIMIT;
      continue;
    }
    output[entryKey] = sanitizePayloadValue(entryValue, entryKey, depth + 1);
  }
  if (entries.length > TOOL_PAYLOAD_MAX_OBJECT_KEYS) {
    output.omittedKeyCount = entries.length - TOOL_PAYLOAD_MAX_OBJECT_KEYS;
  }
  return output;
}

function collectChangedFilePaths(value: unknown, target: string[], seen: Set<string>, depth = 0) {
  if (depth > TOOL_PAYLOAD_MAX_DEPTH || target.length >= TOOL_PAYLOAD_CHANGED_FILE_LIMIT) {
    return;
  }
  if (typeof value === "string") {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFilePaths(entry, target, seen, depth + 1);
      if (target.length >= TOOL_PAYLOAD_CHANGED_FILE_LIMIT) {
        return;
      }
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  for (const [key, entryValue] of Object.entries(value)) {
    if (PATH_KEYS.has(key) && typeof entryValue === "string") {
      const normalized = entryValue.trim();
      if (normalized.length > 0 && !isTruncatedPathCandidate(normalized) && !seen.has(normalized)) {
        seen.add(normalized);
        target.push(normalized);
      }
      if (target.length >= TOOL_PAYLOAD_CHANGED_FILE_LIMIT) {
        return;
      }
    }
  }

  for (const nestedValue of Object.values(value)) {
    collectChangedFilePaths(nestedValue, target, seen, depth + 1);
    if (target.length >= TOOL_PAYLOAD_CHANGED_FILE_LIMIT) {
      return;
    }
  }
}

function firstStringAtPath(value: unknown, path: ReadonlyArray<string>): string | null {
  let cursor: unknown = value;
  for (const segment of path) {
    if (!isRecord(cursor)) {
      return null;
    }
    cursor = cursor[segment];
  }
  return typeof cursor === "string" && cursor.trim().length > 0 ? cursor : null;
}

export function sanitizeProviderToolData(
  data: unknown,
  options: { readonly itemType?: string | undefined } = {},
): Record<string, unknown> | undefined {
  if (data === undefined) {
    return undefined;
  }
  const sanitized = sanitizePayloadValue(data, null, 0);
  const output = isRecord(sanitized) ? sanitized : { value: sanitized };
  delete output.changedFiles;

  const command =
    firstStringAtPath(data, ["command"]) ??
    firstStringAtPath(data, ["item", "command"]) ??
    firstStringAtPath(data, ["item", "input", "command"]) ??
    firstStringAtPath(data, ["item", "result", "command"]);
  if (command) {
    output.command = truncatePayloadText(command, TOOL_PAYLOAD_COMMAND_LIMIT);
  }

  if (options.itemType === undefined || options.itemType === "file_change") {
    const changedFiles: string[] = [];
    collectChangedFilePaths(data, changedFiles, new Set<string>());
    if (changedFiles.length > 0) {
      output.changedFiles = changedFiles.map((path) => ({ path }));
    }
  }

  return output;
}

export function sanitizeActivityPayload(payload: unknown): unknown {
  if (!isRecord(payload)) {
    return payload;
  }
  if (!("data" in payload)) {
    return payload;
  }
  return {
    ...payload,
    data: sanitizeProviderToolData(payload.data, {
      itemType: typeof payload.itemType === "string" ? payload.itemType : undefined,
    }),
  };
}

export function sanitizeThreadActivityAppendedEventPayload(payload: unknown): unknown {
  if (!isRecord(payload)) {
    return payload;
  }
  const activity = payload.activity;
  if (!isRecord(activity)) {
    return payload;
  }
  return {
    ...payload,
    activity: {
      ...activity,
      payload: sanitizeActivityPayload(activity.payload),
    },
  };
}
