// Native Proxy detection precedes reflection so a log-only copy cannot execute
// application/plugin traps while deliberately omitting private question data.
import { types } from "node:util";
import type { ProviderRuntimeEvent } from "@cafecode/contracts";

const ROUTING_FIELDS = [
  "eventId",
  "provider",
  "providerInstanceId",
  "subagentRuntimeId",
  "threadId",
  "createdAt",
  "turnId",
  "itemId",
  "requestId",
] as const;
const MAX_ROUTING_FIELD_CHARS = 512;

function ownData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** This is an operational log record, deliberately not a valid replacement
 * ProviderRuntimeEvent. Questions, answers and full-text annotation keys stay
 * on the authenticated event/control path. Never mutate that source event,
 * recursively serialize it, or spread unknown siblings into this projection. */
export function projectProviderEventForOperationalLog(event: ProviderRuntimeEvent): unknown {
  if (types.isProxy(event)) return { observation: "omitted-unsafe-provider-event" };
  const type = ownData(event, "type");
  if (typeof type !== "string") return { observation: "omitted-unsafe-provider-event" };
  if (type !== "user-input.requested" && type !== "user-input.resolved") {
    // Preserve existing observability for every unrelated event. The separate
    // private diagnostic snapshot continues to require its own owner reader.
    return { ...event, diagnostic: undefined };
  }

  const projected: Record<string, unknown> = Object.create(null);
  projected.type = type;
  for (const field of ROUTING_FIELDS) {
    const value = ownData(event, field);
    if (typeof value === "string" && value.length <= MAX_ROUTING_FIELD_CHARS)
      projected[field] = value;
  }

  const payload: Record<string, unknown> = Object.create(null);
  payload.contentOmitted = true;
  projected.payload = payload;
  const source = ownData(event, "payload");
  if (source === null || typeof source !== "object" || types.isProxy(source)) return projected;
  if (type === "user-input.requested") {
    const questions = ownData(source, "questions");
    if (!types.isProxy(questions) && Array.isArray(questions)) {
      const length = ownData(questions, "length");
      if (typeof length === "number" && Number.isSafeInteger(length) && length >= 0)
        payload.questionCount = length;
    }
    for (const field of ["isBlocking", "supportsUnanswered"] as const) {
      const value = ownData(source, field);
      if (typeof value === "boolean") payload[field] = value;
    }
  } else {
    for (const field of ["autoResolved", "cancelled"] as const) {
      const value = ownData(source, field);
      if (typeof value === "boolean") payload[field] = value;
    }
    // Presence is sufficient operational evidence. Do not enumerate the map:
    // its keys are full question text, and its values need not be inspected.
    const unanswered = Object.getOwnPropertyDescriptor(source, "unanswered");
    if (unanswered && "value" in unanswered && unanswered.value !== undefined)
      payload.hasExplicitUnanswered = true;
  }
  return projected;
}
