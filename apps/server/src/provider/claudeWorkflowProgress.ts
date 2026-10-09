import type { RuntimeWorkflowPresentation } from "@cafecode/contracts";
import { compareSemverVersions, parseSemver } from "@cafecode/shared/semver";

/**
 * Qualified received-only extension of system/task_progress in Claude Code
 * 2.1.288. The public SDK omits this sibling from its types, so this decoder
 * owns the compatibility boundary; it never asks a private control API or
 * reads workflow journals. Unknown/prerelease executables have no authority.
 */
export function supportsClaudeWorkflowProgress(version: string | null | undefined): boolean {
  if (!version || version.length > 64) return false;
  const parsed = parseSemver(version);
  return (
    !!parsed && parsed.prerelease.length === 0 && compareSemverVersions(version, "2.1.288") >= 0
  );
}

export const CLAUDE_WORKFLOW_SNAPSHOT_LIMIT = 128;
export const CLAUDE_WORKFLOW_RETAINED_LIMIT = 32;
type WorkflowSnapshot = Pick<RuntimeWorkflowPresentation, "phases" | "agents" | "truncated">;

/** Do not allow display labels to become a second log line, path or secret. */
export function claudeWorkflowLabel(value: unknown, limit = 240): string | undefined {
  if (
    typeof value !== "string" ||
    value.length > 8_192 ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) ||
    /(?:https?:\/\/|file:\/\/|(?:\/[^\s/]+){2,}|[A-Za-z]:[\\/]|(?:api[_ -]?key|token|secret|password)\s*[:=]|Bearer\s+|sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{16,}\.)/i.test(
      value,
    )
  ) {
    return undefined;
  }
  const label = value.trim().replace(/\s+/g, " ");
  return label.length > 0 && label.length <= limit ? label : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
/** JSON fields must be own data, never an inherited value or an accessor. */
function data(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}
function counter(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function index(value: unknown): number | undefined {
  const parsed = counter(value);
  return parsed !== undefined && parsed >= 1 && parsed <= 10_000 ? parsed : undefined;
}

/**
 * Present snapshots replace the previous admitted arrays. Absence, malformed
 * envelopes or an excessive input do not erase good prior evidence. Only a
 * finite prefix is inspected/retained, with explicit incomplete presentation.
 * Sensitive agent prompts, errors, tool summaries, paths and logs are omitted
 * by construction, including unknown future fields.
 */
export function decodeClaudeWorkflowProgress(value: unknown): WorkflowSnapshot | undefined {
  // SDK frames are JSON, but reject hostile non-JSON objects as well. A proxy
  // trap or getter must not throw out of a presentation-only telemetry path.
  try {
    return decodeWorkflowSnapshot(value);
  } catch {
    return undefined;
  }
}

function decodeWorkflowSnapshot(value: unknown): WorkflowSnapshot | undefined {
  if (!Array.isArray(value) || value.length > 512) return undefined;
  const phases: NonNullable<RuntimeWorkflowPresentation["phases"]>[number][] = [];
  const agents: NonNullable<RuntimeWorkflowPresentation["agents"]>[number][] = [];
  const seen = new Set<string>();
  for (let offset = 0; offset < Math.min(value.length, CLAUDE_WORKFLOW_SNAPSHOT_LIMIT); offset++) {
    const raw = data(value, String(offset));
    const row = record(raw);
    const rowIndex = row ? index(data(row, "index")) : undefined;
    const rowType = row ? data(row, "type") : undefined;
    if (
      !row ||
      rowIndex === undefined ||
      (rowType !== "workflow_phase" && rowType !== "workflow_agent")
    )
      return undefined;
    const key = `${rowType}:${rowIndex}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    if (rowType === "workflow_phase") {
      const title = claudeWorkflowLabel(data(row, "title"));
      const kind = claudeWorkflowLabel(data(row, "kind"), 120);
      phases.push({ index: rowIndex, ...(title ? { title } : {}), ...(kind ? { kind } : {}) });
      continue;
    }
    const label = claudeWorkflowLabel(data(row, "label"));
    const model = claudeWorkflowLabel(data(row, "model"), 120);
    const fallbackModel = claudeWorkflowLabel(data(row, "fallbackModel"), 120);
    const phaseIndex = index(data(row, "phaseIndex"));
    const totalTokens = counter(data(row, "tokens"));
    const durationMs = counter(data(row, "durationMs"));
    const state = data(row, "state");
    const status =
      state === "start" || state === "progress"
        ? "running"
        : state === "done"
          ? "completed"
          : state === "error"
            ? "failed"
            : undefined;
    agents.push({
      index: rowIndex,
      ...(label ? { label } : {}),
      ...(model ? { model } : {}),
      ...(fallbackModel ? { fallbackModel } : {}),
      ...(phaseIndex !== undefined ? { phaseIndex } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(status ? { status } : {}),
    });
  }
  return { phases, agents, truncated: value.length > CLAUDE_WORKFLOW_SNAPSHOT_LIMIT };
}
