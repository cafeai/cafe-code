import type { MaxConcurrentSubagents, ProviderInstanceId, ThreadId } from "@cafecode/contracts";

interface SessionLimitIdentity {
  readonly threadId: ThreadId;
  readonly providerName: string | null;
  readonly providerInstanceId?: ProviderInstanceId | null | undefined;
  readonly maxConcurrentSubagents?: MaxConcurrentSubagents | null | undefined;
}

/**
 * Old lifecycle producers omit this additive field. Preserve known configured
 * evidence only for the same authenticated chat/account binding; never borrow
 * a prior account's limit. An explicit null is authoritative no-override evidence.
 * This does not resolve defaults or grant permission to replace a live process.
 */
export function materializedSubagentLimitFields(
  incoming: SessionLimitIdentity,
  previous?: SessionLimitIdentity | null,
): { readonly maxConcurrentSubagents?: MaxConcurrentSubagents | null } {
  if (incoming.maxConcurrentSubagents !== undefined) {
    return { maxConcurrentSubagents: incoming.maxConcurrentSubagents };
  }
  if (
    previous !== undefined &&
    previous !== null &&
    incoming.threadId === previous.threadId &&
    incoming.providerName === previous.providerName &&
    incoming.providerInstanceId != null &&
    incoming.providerInstanceId === previous.providerInstanceId &&
    previous.maxConcurrentSubagents !== undefined
  ) {
    return { maxConcurrentSubagents: previous.maxConcurrentSubagents };
  }
  return {};
}
