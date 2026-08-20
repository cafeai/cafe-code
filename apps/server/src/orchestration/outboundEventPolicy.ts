import type { OrchestrationEvent } from "@cafecode/contracts";

export type OutboundEventClassification =
  | { readonly kind: "protected" }
  | { readonly kind: "appendable"; readonly key: string }
  | { readonly kind: "replaceable"; readonly key: string };

/**
 * Conservative overload policy for queued orchestration events.
 *
 * Unknown and lifecycle-shaped events are protected. Snapshot-like state with
 * a stable identity may be replaced, while append-only streaming text may only
 * be concatenated in order. This function is shared by hub routing and
 * connection flow control so adding a new event type cannot accidentally
 * acquire lossy behavior in one layer.
 */
export function classifyOutboundOrchestrationEvent(
  event: OrchestrationEvent,
): OutboundEventClassification {
  switch (event.type) {
    case "thread.message-sent":
      return event.payload.role === "assistant" && event.payload.streaming
        ? {
            kind: "appendable",
            key: `streaming-message:${event.aggregateId}:${event.payload.messageId}`,
          }
        : { kind: "protected" };
    case "thread.session-set":
      return {
        kind: "replaceable",
        key: `thread-session:${event.aggregateId}`,
      };
    default:
      return { kind: "protected" };
  }
}
