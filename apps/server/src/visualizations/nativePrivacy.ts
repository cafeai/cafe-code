// @effect-diagnostics nodeBuiltinImport:off
import { ownRecord, readBoundedMcpAppJson } from "@cafecode/shared/mcpAppProtocol";
import type { GeneratedVisualizationNativeWitness } from "@cafecode/contracts/visualizationApi";
import type { VisualizationSessionBinding } from "./sessionRuntime.ts";
import { computeGeneratedVisualizationInputSha256 } from "./store.ts";
import { MessageId } from "@cafecode/contracts";
import { randomUUID } from "node:crypto";

export const isVisualizationServer = (value: unknown): value is string =>
  typeof value === "string" && /^cafe-visualizations-[A-Za-z0-9_-]{22}$/.test(value);
export const isVisualizationTool = (value: unknown): value is string =>
  typeof value === "string" &&
  /^mcp__cafe-visualizations-[A-Za-z0-9_-]{22}__(?:preview|publish)_visualization$/.test(value);
export const isPrivateMcpItem = (value: unknown): boolean => {
  const item = ownRecord(value);
  return (
    item?.type === "mcpToolCall" &&
    (isVisualizationServer(item.server) ||
      item.mcpAppUi != null ||
      item.mcpAppResourceUri != null ||
      item.appContext != null)
  );
};
const nativeIdentifier = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= 200 ? value : undefined;
const nativeIndex = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 4096
    ? value
    : undefined;

/** Received own data only. Missing/null parent denotes primary SDK traffic;
 * malformed, inherited and accessor identities never acquire primary rights. */
export function readVisualizationClaudeParent(
  value: unknown,
): { type: "root" } | { type: "child"; id: string } | undefined {
  const frame = ownRecord(value);
  if (!frame) return undefined;
  const parent = Object.getOwnPropertyDescriptor(frame, "parent_tool_use_id");
  if (parent && !("value" in parent)) return undefined;
  if (!parent && "parent_tool_use_id" in frame) return undefined;
  const id = parent?.value;
  if (id === null || id === undefined) {
    const agent = Object.getOwnPropertyDescriptor(frame, "agent_id");
    if (
      agent
        ? !("value" in agent) || (agent.value !== null && agent.value !== undefined)
        : "agent_id" in frame
    )
      return undefined;
    return { type: "root" };
  }
  if (typeof id !== "string" || !id.length || id.length > 200 || id.trim() !== id) return undefined;
  return { type: "child", id };
}

/**
 * Private native observations precede this copy. The copy is the only value
 * allowed into normal mapping, native journals, history hydration and debug.
 * Redaction is deliberately more conservative than completion authority: a
 * claimed UI descriptor need not be trusted to justify hiding its payload.
 */
export function redactVisualizationNativePayload<T>(value: T): T {
  let remaining = 50_000;
  const visit = (current: unknown, depth: number): unknown => {
    if (--remaining < 0 || depth > 32) return "[Private visualization payload omitted]";
    if (Array.isArray(current)) {
      if (current.length > remaining) return "[Private visualization payload omitted]";
      const next = current.map((entry) => visit(entry, depth + 1));
      return next.every((entry, index) => entry === current[index]) ? current : next;
    }
    const record = ownRecord(current);
    if (!record) return current;
    if (isPrivateMcpItem(record)) {
      // Do not retain server URI, tool arguments, HTML, received errors, result
      // metadata or invocation proof. The compact artifact is a separate read.
      return {
        id: nativeIdentifier(record.id),
        type: "mcpToolCall",
        server: "Private visualization",
        tool: "Visualization",
        status:
          typeof record.status === "string" &&
          ["inProgress", "completed", "failed"].includes(record.status)
            ? record.status
            : "unknown",
        arguments: {},
        result: null,
        error: record.error ? { message: "Visualization operation failed." } : null,
      };
    }
    let changed = false;
    const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, entry] of Object.entries(record)) {
      copy[key] = visit(entry, depth + 1);
      changed ||= copy[key] !== entry;
    }
    return changed ? copy : current;
  };
  return visit(value, 0) as T;
}

/** Bounded Claude native ID/index correlation. Overflow hides unknown results
 * instead of evicting an identity and leaking its later content. It never
 * establishes publication authority, which needs the exact session binding. */
export class VisualizationNativePrivacy {
  private readonly toolIds = new Set<string>();
  private readonly streaming = new Set<string>();
  private overflow = false;
  redact<T>(value: T): T {
    let remaining = 50_000;
    const visit = (
      current: unknown,
      depth: number,
      inheritedParent: string | null | undefined,
    ): unknown => {
      if (--remaining < 0 || depth > 32) return "[Private visualization payload omitted]";
      if (Array.isArray(current)) {
        if (current.length > remaining) return "[Private visualization payload omitted]";
        const next = current.map((entry) => visit(entry, depth + 1, inheritedParent));
        return next.every((entry, index) => entry === current[index]) ? current : next;
      }
      const record = ownRecord(current);
      if (!record) return current;
      // SDK stream indexes are local to the parent tool query. A child stop
      // with the same index must never unmask the root's next private delta.
      let parent = inheritedParent;
      if (Object.hasOwn(record, "parent_tool_use_id")) {
        if (record.parent_tool_use_id === null) parent = null;
        else if (
          typeof record.parent_tool_use_id === "string" &&
          record.parent_tool_use_id.length > 0 &&
          record.parent_tool_use_id.length <= 200
        )
          parent = record.parent_tool_use_id;
        // An unowned malformed frame must remain private, but it is not a
        // visualization identity-table overflow. Poisoning the entire session
        // here would suppress later valid ordinary tool results. Keep unknown
        // parent authority local unless this frame actually carries a private
        // tool/stream whose future results cannot be correlated safely.
        else parent = undefined;
      }
      const toolKey = (id: string) => JSON.stringify([parent, id]);
      const index = nativeIndex(record.index);
      const streamKey =
        index === undefined || parent === undefined ? undefined : JSON.stringify([parent, index]);
      if (record.type === "tool_use" && isVisualizationTool(record.name)) {
        if (parent !== undefined && typeof record.id === "string" && record.id.length <= 200) {
          if (this.toolIds.size < 4096) this.toolIds.add(toolKey(record.id));
          else this.overflow = true;
        } else this.overflow = true;
        return {
          type: "tool_use",
          id: nativeIdentifier(record.id),
          name: "Visualization",
          input: {},
        };
      }
      if (
        record.type === "tool_result" &&
        (parent === undefined ||
          this.overflow ||
          (typeof record.tool_use_id === "string" && this.toolIds.has(toolKey(record.tool_use_id))))
      )
        return {
          type: "tool_result",
          tool_use_id: nativeIdentifier(record.tool_use_id),
          content: "[Private visualization result omitted]",
          is_error: record.is_error === true,
        };
      if (
        record.type === "content_block_start" &&
        isVisualizationTool(ownRecord(record.content_block)?.name)
      ) {
        if (streamKey !== undefined && this.streaming.size < 4096) this.streaming.add(streamKey);
        else this.overflow = true;
      }
      if (
        record.type === "content_block_delta" &&
        (parent === undefined ||
          this.overflow ||
          (streamKey !== undefined && this.streaming.has(streamKey)))
      )
        return {
          type: "content_block_delta",
          index: nativeIndex(record.index),
          delta: { type: "input_json_delta", partial_json: "" },
        };
      if (record.type === "content_block_stop" && streamKey !== undefined)
        this.streaming.delete(streamKey);
      let changed = false;
      const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [key, entry] of Object.entries(record)) {
        copy[key] = visit(entry, depth + 1, parent);
        changed ||= copy[key] !== entry;
      }
      return changed ? copy : current;
    };
    return visit(value, 0, null) as T;
  }
}

/** Read a tiny receipt only; never recursively search arbitrary tool content.
 * The receipt is a correlation candidate, not native/session authority. */
export function readVisualizationReceipt(
  result: unknown,
):
  | { proof: string; inputSha256: string; sessionGeneration: string; serverName: string }
  | undefined {
  const record = ownRecord(result);
  let candidate = ownRecord(ownRecord(record?.structuredContent)?.visualizationReceipt);
  if (!candidate && Array.isArray(record?.content) && record.content.length === 1) {
    const block = ownRecord(record.content[0]);
    const parsed =
      block?.type === "text" ? readBoundedMcpAppJson(block.text, 8192) : { ok: false as const };
    if (parsed.ok) candidate = ownRecord(parsed.value);
  }
  if (
    !candidate ||
    candidate.version !== 1 ||
    candidate.purpose !== "cafe-visualization-receipt" ||
    candidate.toolName !== "publish_visualization" ||
    typeof candidate.proof !== "string" ||
    !/^[a-f0-9]{64}$/.test(candidate.proof) ||
    typeof candidate.inputSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(candidate.inputSha256) ||
    typeof candidate.sessionGeneration !== "string" ||
    !isVisualizationServer(candidate.serverName)
  )
    return undefined;
  return {
    proof: candidate.proof,
    inputSha256: candidate.inputSha256,
    sessionGeneration: candidate.sessionGeneration,
    serverName: candidate.serverName,
  };
}

export async function claimVisualizationNativeItem(
  binding: VisualizationSessionBinding,
  item: unknown,
  witness: Omit<
    GeneratedVisualizationNativeWitness,
    "serverName" | "toolName" | "inputSha256" | "sessionGeneration"
  >,
): Promise<void> {
  const record = ownRecord(item);
  if (
    record?.type !== "mcpToolCall" ||
    record.status !== "completed" ||
    record.server !== binding.name ||
    record.tool !== "publish_visualization" ||
    record.id !== witness.nativeItemId ||
    record.error != null
  )
    return;
  const inputSha256 = computeGeneratedVisualizationInputSha256(record.arguments);
  const receipt = readVisualizationReceipt(record.result);
  if (
    !inputSha256 ||
    !receipt ||
    receipt.inputSha256 !== inputSha256 ||
    receipt.serverName !== binding.name ||
    receipt.sessionGeneration !== binding.authority.sessionGeneration
  )
    return;
  await binding.claimNativeCompletion(
    {
      ...witness,
      sessionGeneration: binding.authority.sessionGeneration,
      serverName: binding.name,
      toolName: "publish_visualization",
      inputSha256,
    },
    receipt.proof,
  );
}

/** Claude's tool-result frame does not repeat its native server/tool/input. Keep
 * only the input commitment and exact native witness from the matching use.
 * Never correlate a child result through a root or a sibling's parent identity. */
export class ClaudeVisualizationCompletionObserver {
  private readonly calls = new Map<
    string,
    {
      inputSha256: string;
      witness: Omit<
        GeneratedVisualizationNativeWitness,
        "serverName" | "toolName" | "inputSha256" | "sessionGeneration"
      >;
    }
  >();
  private overflow = false;
  private readonly retired = new Set<string>();
  async observe(
    binding: VisualizationSessionBinding,
    value: unknown,
    witness: Omit<
      GeneratedVisualizationNativeWitness,
      "serverName" | "toolName" | "inputSha256" | "sessionGeneration" | "nativeItemId" | "messageId"
    >,
  ): Promise<void> {
    const frame = ownRecord(value);
    const message = ownRecord(frame?.message);
    if (!frame || !message || !Array.isArray(message.content) || message.content.length > 256)
      return;
    const admittedParent = readVisualizationClaudeParent(frame);
    if (!admittedParent) return;
    const parent = admittedParent.type === "child" ? admittedParent.id : null;
    for (const block of message.content) {
      const tool = ownRecord(block);
      if (!tool) continue;
      if (
        frame.type === "assistant" &&
        tool.type === "tool_use" &&
        tool.name === `mcp__${binding.name}__publish_visualization` &&
        typeof tool.id === "string" &&
        tool.id.length <= 200
      ) {
        const inputSha256 = computeGeneratedVisualizationInputSha256(tool.input);
        if (!inputSha256 || this.overflow) continue;
        if (this.calls.size + this.retired.size >= 4096) {
          this.overflow = true;
          continue;
        }
        const key = JSON.stringify([witness.nativeThreadId, parent, tool.id]);
        if (this.retired.has(key)) continue;
        const prior = this.calls.get(key);
        if (
          prior &&
          (prior.inputSha256 !== inputSha256 || prior.witness.nativeTurnId !== witness.nativeTurnId)
        ) {
          this.calls.delete(key);
          this.retired.add(key);
          continue;
        }
        this.calls.set(key, {
          inputSha256,
          witness: {
            ...witness,
            nativeItemId: tool.id,
            messageId: MessageId.make(`visual-${randomUUID()}`),
          },
        });
      }
      if (
        frame.type !== "user" ||
        tool.type !== "tool_result" ||
        typeof tool.tool_use_id !== "string"
      )
        continue;
      const key = JSON.stringify([witness.nativeThreadId, parent, tool.tool_use_id]);
      const prior = this.calls.get(key);
      if (
        !prior ||
        prior.witness.nativeThreadId !== witness.nativeThreadId ||
        prior.witness.nativeTurnId !== witness.nativeTurnId ||
        JSON.stringify(prior.witness.actor) !== JSON.stringify(witness.actor)
      )
        continue;
      this.calls.delete(key);
      this.retired.add(key);
      if (tool.is_error === true) continue;
      const result =
        typeof tool.content === "string"
          ? { content: [{ type: "text", text: tool.content }] }
          : { content: tool.content };
      const receipt = readVisualizationReceipt(result);
      if (
        !receipt ||
        receipt.inputSha256 !== prior.inputSha256 ||
        receipt.serverName !== binding.name ||
        receipt.sessionGeneration !== binding.authority.sessionGeneration
      )
        continue;
      await binding.claimNativeCompletion(
        {
          ...prior.witness,
          serverName: binding.name,
          toolName: "publish_visualization",
          inputSha256: prior.inputSha256,
          sessionGeneration: binding.authority.sessionGeneration,
        },
        receipt.proof,
      );
    }
  }
}
