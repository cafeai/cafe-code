import * as Schema from "effect/Schema";
import * as Exit from "effect/Exit";
import { ProviderInstanceId } from "@cafecode/contracts";

// This is signed launch intent, not proof that a native provider query has
// finished opening or still owns this account. Resource readers must resolve
// the current runtime separately and must never borrow another account's data.
// Keep the authenticated metadata finite without changing historical entity-ID
// schemas used elsewhere. Exact whitespace and control characters are rejected
// instead of normalizing a received identity into a different one.
const LaunchIdentifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
  Schema.isPattern(/^\S(?:[\s\S]*\S)?$/u),
  Schema.isPattern(/^[^\p{Cc}\p{Bidi_Control}]+$/u),
);
const isProviderInstanceId = Schema.is(ProviderInstanceId);

export const ManagementLaunchContext = Schema.Struct({
  threadId: LaunchIdentifier.pipe(Schema.brand("ThreadId")),
  // Reuse the canonical provider slug domain without its input-trimming
  // transformation: authenticated identities must already be exact.
  providerInstanceId: LaunchIdentifier.check(Schema.makeFilter(isProviderInstanceId)).pipe(
    Schema.brand("ProviderInstanceId"),
  ),
  launchNonce: Schema.String.check(Schema.isUUID()),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ManagementLaunchContext = typeof ManagementLaunchContext.Type;

const decodeLaunchContext = Schema.decodeUnknownExit(ManagementLaunchContext);

/**
 * Optional launch metadata must not prevent a historical, otherwise valid
 * provider session from opening. Unsupported legacy identifiers receive no
 * default; their owner can still pass an explicit thread ID to management
 * tools. This fallback belongs only at internal launch construction: an
 * explicitly supplied malformed signed claim is rejected by the issuer.
 */
export function makeManagementLaunchContext(
  input: ManagementLaunchContext,
): ManagementLaunchContext | undefined {
  const decoded = decodeLaunchContext(input);
  return Exit.isSuccess(decoded) ? decoded.value : undefined;
}
