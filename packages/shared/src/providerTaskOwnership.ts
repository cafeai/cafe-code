import {
  ProviderTaskOwner,
  SubagentRuntimeId,
  type OrchestrationSessionStatus,
} from "@cafecode/contracts";
import * as Schema from "effect/Schema";
import { isLiveWorkRuntimeCurrent } from "./liveWork.ts";

const isOwner = Schema.is(ProviderTaskOwner);
const isRuntimeId = Schema.is(SubagentRuntimeId);

/** Read only received own data fields. A getter, inherited value, tool input or
 * provider result must never execute merely to choose decorative artwork. */
function own(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const field = Object.getOwnPropertyDescriptor(value, key);
  return field && "value" in field ? field.value : undefined;
}

/** Reconstruct only the finite display contract rather than forwarding the
 * original record. Unknown extra fields cannot smuggle private data into an
 * activity, and native identities remain exact rather than display-normalized.
 * This field confers no task, history, runtime or liveness authority. */
export function readProviderTaskOwnerPayload(payload: unknown): ProviderTaskOwner | undefined {
  const value = own(payload, "taskOwner");
  const type = own(value, "type");
  if (type === "root") return { type: "root" };
  if (type !== "child") return undefined;
  const id = own(value, "id");
  if (typeof id !== "string" || id.length === 0 || id.length > 512) return undefined;
  const candidate = { type: "child" as const, id };
  return isOwner(candidate) ? candidate : undefined;
}

/** The same opaque child seed used in the roster, only under this activity's
 * current native generation. A saved label/control or missing owner is not
 * proof. Read-only/foreground presentation cannot borrow a replacement owner's
 * seed, and root remains an empty slot rather than a tool-category icon. */
export function providerTaskOwnerAvatarSeed(
  payload: unknown,
  session: {
    subagentRuntimeId?: string | null | undefined;
    orchestrationStatus: OrchestrationSessionStatus;
  } | null,
): string | undefined {
  const runtimeId = own(payload, "nativeWorkRuntimeId");
  if (
    typeof runtimeId !== "string" ||
    !isRuntimeId(runtimeId) ||
    !isLiveWorkRuntimeCurrent(runtimeId, session)
  )
    return undefined;
  const owner = readProviderTaskOwnerPayload(payload);
  return owner?.type === "child" ? owner.id : undefined;
}
