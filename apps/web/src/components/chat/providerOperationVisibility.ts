import {
  isPublicReasoningSummaryProvider,
  type PublicReasoningSummaryProvider,
} from "@cafecode/shared/providerWorkLog";

/**
 * Only explicitly projected presentation contracts are inspected: version-1
 * public reasoning summaries from an admitted provider (Claude summaries and
 * OpenCode thinking) and Claude command inspections. Never turn an arbitrary
 * saved provider object into a renderer disclosure: raw results can contain
 * file bodies, resource capabilities or signatures.
 */
export interface ProviderPublicSummary {
  readonly provider: PublicReasoningSummaryProvider;
  readonly text: string;
  readonly truncated: boolean;
  readonly status: "inProgress" | "completed" | "failed";
}

export interface ClaudeCommandInspection {
  readonly description?: string;
  readonly descriptionTruncated?: boolean;
  readonly command?: string;
  readonly commandTruncated: boolean;
  /** An empty received output is different from output that was not recorded. */
  readonly output?: string;
  readonly outputTruncated: boolean;
  readonly status?: "inProgress" | "completed" | "failed";
  readonly startedAt?: string;
  readonly completedAt?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function status(value: unknown): ProviderPublicSummary["status"] | undefined {
  return value === "inProgress" || value === "completed" || value === "failed" ? value : undefined;
}

function observedTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value))
    return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? value : undefined;
}

/** Keep multiline text inert, bounded, and free of terminal/bidi controls. */
function boundedText(
  value: unknown,
  limit: number,
): { text: string; truncated: boolean } | undefined {
  if (typeof value !== "string") return undefined;
  const sanitized = value
    .slice(0, limit)
    .replace(/\p{Cc}/gu, (character) =>
      character === "\n" || character === "\r" || character === "\t" ? character : "",
    )
    .replace(/\p{Bidi_Control}/gu, "")
    .replace(/(authorization:\s*bearer\s+)[^\s"']+/giu, "$1[redacted]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{16,}/giu, "$1[redacted]")
    .replace(/\b(?:npm_|sk-)[A-Za-z0-9_-]{16,}\b/gu, "[redacted]");
  return {
    text: sanitized.slice(0, limit),
    truncated: value.length > limit || sanitized.length > limit,
  };
}

export function mergeClaudeCommandInspections(
  previous: ClaudeCommandInspection,
  next: ClaudeCommandInspection,
): ClaudeCommandInspection {
  const { status: previousStatus, ...previousDetails } = previous;
  const currentStatus = next.status ?? (next.completedAt ? undefined : previousStatus);
  return {
    ...previousDetails,
    ...next,
    commandTruncated:
      next.command === undefined ? previous.commandTruncated : next.commandTruncated,
    outputTruncated: next.output === undefined ? previous.outputTruncated : next.outputTruncated,
    descriptionTruncated:
      next.description === undefined
        ? previous.descriptionTruncated === true
        : next.descriptionTruncated === true,
    ...(currentStatus ? { status: currentStatus } : {}),
  };
}

export function readProviderPublicSummary(payload: unknown): ProviderPublicSummary | undefined {
  const data = record(payload);
  if (
    data?.streamKind !== "reasoning_summary_text" ||
    data.summaryVersion !== 1 ||
    !isPublicReasoningSummaryProvider(data.provider) ||
    typeof data.itemId !== "string" ||
    !data.itemId.trim() ||
    typeof data.detail !== "string" ||
    data.detail.length > 4_096 ||
    typeof data.truncated !== "boolean"
  )
    return undefined;
  // The current public-summary contract is already normalized at trusted
  // ingestion. Reject malformed retained rows consistently with history
  // queries, rather than silently turning unsafe data into recent-only work.
  const nonLayoutText = data.detail.replaceAll("\n", "").replaceAll("\r", "").replaceAll("\t", "");
  if (/[\p{Cc}\p{Bidi_Control}]/u.test(nonLayoutText)) return undefined;
  const summaryText = boundedText(data.detail, 4_096);
  if (!summaryText?.text.trim()) return undefined;
  const summaryStatus = status(data.status);
  if (!summaryStatus) return undefined;
  return {
    provider: data.provider,
    text: summaryText.text,
    truncated: data.truncated === true || summaryText.truncated,
    status: summaryStatus,
  };
}

export function readClaudeCommandInspection(payload: unknown): ClaudeCommandInspection | undefined {
  const envelope = record(payload);
  const data = record(envelope?.data);
  // This deliberately does not widen existing Codex/Grok or MCP/file rows.
  if (
    envelope?.itemType !== "command_execution" ||
    data?.toolName !== "Bash" ||
    data.commandInspectionVersion !== 1 ||
    data.inspectionProvider !== "claudeAgent"
  )
    return undefined;
  const input = record(data.input);
  const descriptionText = boundedText(input?.description, 2_048);
  const description = descriptionText?.text.trim();
  const rawCommand = typeof data.command === "string" ? data.command : input?.command;
  const commandText = boundedText(rawCommand, 4_096);
  const command = commandText?.text.trim();
  const outputText = boundedText(data.output, 2_048);
  const output = outputText?.text;
  const commandStatus = status(envelope.status);
  const startedAt = observedTimestamp(data.startedAt);
  const completedAt = observedTimestamp(data.completedAt);
  return {
    ...(description ? { description } : {}),
    descriptionTruncated: data.descriptionTruncated === true || descriptionText?.truncated === true,
    ...(command ? { command } : {}),
    ...(output !== undefined ? { output } : {}),
    commandTruncated: data.commandTruncated === true || commandText?.truncated === true,
    outputTruncated: data.outputTruncated === true || outputText?.truncated === true,
    ...(commandStatus ? { status: commandStatus } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
  };
}

/**
 * Collapsed-row preview only: drop a leading `cd <workspace root> &&|;` that
 * merely restates the chat's own working directory, so the row shows the
 * command that matters (Codex receives its cwd separately and never shows it).
 * The target must equal the workspace root exactly; any other directory, a
 * bare `cd`, or a prefix with nothing after it is left untouched. The expanded
 * disclosure always shows the complete received command.
 */
export function compactCommandPreview(command: string, workspaceRoot: string | undefined): string {
  if (!workspaceRoot) return command;
  const match = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|"']+))\s*(?:&&|;)\s*/u.exec(command);
  if (!match) return command;
  const target = match[1] ?? match[2] ?? match[3] ?? "";
  const trimSlash = (path: string) => (path.length > 1 ? path.replace(/[/\\]+$/u, "") : path);
  const remainder = command.slice(match[0].length);
  return trimSlash(target) === trimSlash(workspaceRoot) && remainder.trim().length > 0
    ? remainder
    : command;
}
