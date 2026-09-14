import { DesktopObservationReference } from "@cafecode/contracts";
import * as Schema from "effect/Schema";

const decodeReference = Schema.decodeUnknownOption(DesktopObservationReference);
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export function readDesktopObservationReference(
  value: unknown,
): DesktopObservationReference | undefined {
  const decoded = decodeReference(value);
  return decoded._tag === "Some" ? decoded.value : undefined;
}

/** Codex's generated McpToolCallResult exposes structuredContent. Never parse
 * free-form model text or guess a screenshot by timestamps or tool position. */
export function readDesktopObservationItem(value: unknown):
  | {
      reference?: DesktopObservationReference;
      pending: boolean;
    }
  | undefined {
  const item = record(value);
  if (
    item?.type !== "mcpToolCall" ||
    item.server !== "cafe-desktop" ||
    (item.tool !== "observe" && item.tool !== "act")
  )
    return undefined;
  const reference = readDesktopObservationReference(
    record(record(item.result)?.structuredContent)?.desktopObservation,
  );
  // Only act results with an actual retained reference become screenshot rows.
  // Ordinary action acknowledgements never create a pending/empty image row.
  if (item.tool === "act" && !reference) return undefined;
  return { ...(reference ? { reference } : {}), pending: item.status === "inProgress" };
}
