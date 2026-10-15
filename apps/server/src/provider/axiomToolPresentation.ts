import { summarizeToolArguments } from "@cafecode/shared/toolActivity";
import type { AcpToolCallState } from "./acp/AcpRuntimeModel.ts";

export type AxiomWebTool = "web_search" | "fetch_url";
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Native Axiom titles retain the neutral tool name after their human description.
 * Remember only that finite identity: ACP progress/output updates omit the title.
 * This affects received-data presentation, never tool permissions or execution. */
export function presentAxiomToolCall(
  tool: AcpToolCallState,
  rawPayload: unknown,
  names: Map<string, AxiomWebTool>,
): AcpToolCallState {
  if (tool.kind !== "search" && tool.kind !== "fetch") return tool;
  const title = record(record(rawPayload)?.update)?.title;
  const name =
    typeof title === "string" ? / · (web_search|fetch_url)$/u.exec(title)?.[1] : undefined;
  if (
    (name === "web_search" || name === "fetch_url") &&
    (names.has(tool.toolCallId) || names.size < 4096)
  )
    names.set(tool.toolCallId, name);
  const nativeToolName = names.get(tool.toolCallId);
  if (!nativeToolName) return tool;
  const input = record(tool.data.rawInput);
  const detail =
    summarizeToolArguments(nativeToolName === "web_search" ? input?.query : input?.url) ??
    tool.command;
  const { detail: _previousDetail, ...rest } = tool;
  return {
    ...rest,
    title: nativeToolName === "web_search" ? "Searched the web" : "Opened web page",
    ...(detail ? { detail } : {}),
    data: { ...tool.data, nativeToolName },
  };
}
