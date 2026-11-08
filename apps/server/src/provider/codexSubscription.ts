import type { ServerProvider } from "@cafecode/contracts";
import type * as CodexSchema from "effect-codex-app-server/schema";

// Keep this exhaustive against the pinned app-server account/read schema. The
// lightweight usage endpoint carries the same plan names as an open string;
// never echo an unknown upstream value or infer a tier from quota percentages.
// https://learn.chatgpt.com/docs/app-server#authentication-modes
// Match Codex 0.160.0's account-status presentation. The Pro numerals are
// provider-owned names, not quota multipliers, prices, or evidence of account
// entitlement. Keep them as fixed display strings, with no billing inference.
// https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/subscription.rs#L12-L35
const CODEX_SUBSCRIPTION_LABELS = {
  free: "ChatGPT Free Subscription",
  go: "ChatGPT Go Subscription",
  plus: "ChatGPT Plus Subscription",
  pro: "ChatGPT Pro 200 Subscription",
  prolite: "ChatGPT Pro 100 Subscription",
  promax: "ChatGPT Pro 500 Subscription",
  team: "ChatGPT Business Subscription",
  self_serve_business_prolite: "ChatGPT Business Premium Subscription",
  self_serve_business_usage_based: "ChatGPT Business Subscription",
  business: "ChatGPT Enterprise Subscription",
  ent26: "ChatGPT Enterprise Subscription",
  enterprise_cbp_automation: "ChatGPT Enterprise (Automation) Subscription",
  enterprise_cbp_usage_based: "ChatGPT Enterprise Subscription",
  enterprise: "ChatGPT Enterprise Subscription",
  edu: "ChatGPT Edu Subscription",
  edu_plus: "ChatGPT Edu Plus Subscription",
  edu_pro: "ChatGPT Edu Pro Subscription",
  // Codex 0.164 names these reported plans in protocol/src/auth.rs. They are
  // display metadata only, never proof of model access or quota entitlement.
  // https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/protocol/src/auth.rs
  sci: "ChatGPT Academic Researchers Subscription",
  sci_plus: "ChatGPT Academic Researchers Plus Subscription",
  unknown: "ChatGPT Subscription",
} as const satisfies Record<CodexSchema.V2GetAccountResponse__PlanType, string>;

export function formatCodexSubscriptionLabel(planType: unknown): string {
  return typeof planType === "string" && Object.hasOwn(CODEX_SUBSCRIPTION_LABELS, planType)
    ? CODEX_SUBSCRIPTION_LABELS[planType as keyof typeof CODEX_SUBSCRIPTION_LABELS]
    : "ChatGPT Subscription";
}

/**
 * Enrich presentation only after authentication is established. Missing plan
 * metadata is inconclusive (especially in sparse updates), so leave the current
 * label alone; an explicitly unknown plan replaces a previously known tier with
 * the generic label. This must never turn usage metadata into authentication or
 * relabel API-key/Bedrock accounts as ChatGPT subscriptions.
 */
export function codexAuthWithSubscriptionPlan(
  auth: ServerProvider["auth"],
  planType: unknown,
): ServerProvider["auth"] {
  if (
    auth.status !== "authenticated" ||
    auth.type !== "chatgpt" ||
    planType === null ||
    planType === undefined
  ) {
    return auth;
  }
  const label = formatCodexSubscriptionLabel(planType);
  return label === auth.label ? auth : { ...auth, label };
}
