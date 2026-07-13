import type { EditorId } from "@cafecode/contracts";
import type { DefaultEditorSelection } from "@cafecode/contracts/settings";

// Tail following must stop as soon as the user moves far enough to review an
// earlier line. A viewport-sized tolerance makes ordinary review scrolling
// indistinguishable from being pinned to the tail.
const TIMELINE_AT_END_TOLERANCE_PX = 8;

export function shouldPreserveTimelineScrollReviewIntent(input: {
  readonly lastKnownAtEnd: boolean;
  readonly userScrollIntentSinceReset: boolean;
  readonly userScrollIntentSettleUntilMs: number;
  readonly nowMs: number;
}): boolean {
  return (
    input.lastKnownAtEnd &&
    input.userScrollIntentSinceReset &&
    input.nowMs <= input.userScrollIntentSettleUntilMs
  );
}

export function isTimelineScrolledToEnd(state: {
  readonly isAtEnd: boolean;
  readonly contentLength?: number;
  readonly scroll?: number;
  readonly scrollLength?: number;
}): boolean {
  if (state.isAtEnd) {
    return true;
  }

  const { contentLength, scroll, scrollLength } = state;
  if (
    typeof contentLength !== "number" ||
    typeof scroll !== "number" ||
    typeof scrollLength !== "number" ||
    !Number.isFinite(contentLength) ||
    !Number.isFinite(scroll) ||
    !Number.isFinite(scrollLength)
  ) {
    return false;
  }

  const remainingScrollDistance = Math.max(0, contentLength - scroll - scrollLength);
  return remainingScrollDistance <= TIMELINE_AT_END_TOLERANCE_PX;
}

function isTruncatedOpenPath(path: string): boolean {
  const trimmed = path.trim();
  return trimmed.includes("…") || trimmed.includes("[truncated]") || trimmed.includes("...");
}

function normalizePathForOpen(path: string): string | null {
  if (path.includes("\0") || isTruncatedOpenPath(path) || /^[a-z][a-z0-9+.-]*:/iu.test(path)) {
    return null;
  }
  const normalized = path.replaceAll("\\", "/");
  const absolute = normalized.startsWith("/");
  const output: string[] = [];
  for (const part of normalized.split("/")) {
    if (part.length === 0 || part === ".") {
      continue;
    }
    if (part === "..") {
      if (output.length === 0) {
        return null;
      }
      output.pop();
      continue;
    }
    output.push(part);
  }
  return `${absolute ? "/" : ""}${output.join("/")}`;
}

export function resolveWorkspaceFilePath(
  filePath: string,
  workspaceRoot: string | undefined,
): string | null {
  const normalizedFilePath = normalizePathForOpen(filePath);
  if (!normalizedFilePath) {
    return null;
  }
  const normalizedWorkspaceRoot = workspaceRoot ? normalizePathForOpen(workspaceRoot) : null;
  if (!normalizedWorkspaceRoot) {
    return normalizedFilePath.startsWith("/") ? normalizedFilePath : null;
  }

  const absolutePath = normalizedFilePath.startsWith("/")
    ? normalizedFilePath
    : normalizePathForOpen(`${normalizedWorkspaceRoot}/${normalizedFilePath}`);
  if (!absolutePath) {
    return null;
  }
  if (
    absolutePath !== normalizedWorkspaceRoot &&
    !absolutePath.startsWith(`${normalizedWorkspaceRoot}/`)
  ) {
    return null;
  }
  return absolutePath;
}

export function resolveFileOpenEditor(
  defaultEditor: DefaultEditorSelection,
  availableEditors: ReadonlyArray<EditorId>,
): EditorId | null {
  if (defaultEditor === "system-default") {
    return null;
  }
  return availableEditors.includes(defaultEditor) ? defaultEditor : null;
}

const COMMAND_PATH_STRIP_PATTERN = /^[`'"[(<]+|[`'"\])>,;]+$/g;
const COMMAND_PATH_TOKEN_REJECT_PATTERN = /[{}"]/u;

function isOpenableCommandPathToken(token: string): boolean {
  if (COMMAND_PATH_TOKEN_REJECT_PATTERN.test(token) || isTruncatedOpenPath(token)) {
    return false;
  }
  const colonIndex = token.indexOf(":");
  if (colonIndex >= 0 && !/^[a-zA-Z]:[\\/]/u.test(token)) {
    return false;
  }
  return true;
}

export function extractOpenablePathTokens(
  text: string,
  workspaceRoot: string | undefined,
): ReadonlyArray<string> {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const rawToken of text.split(/\s+/u)) {
    const token = rawToken.trim().replace(COMMAND_PATH_STRIP_PATTERN, "");
    if (!token || token.startsWith("-") || !isOpenableCommandPathToken(token)) {
      continue;
    }
    if (!token.includes("/") && !token.startsWith(".")) {
      continue;
    }
    if (resolveWorkspaceFilePath(token, workspaceRoot) === null) {
      continue;
    }
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    paths.push(token);
  }
  return paths.slice(0, 4);
}
