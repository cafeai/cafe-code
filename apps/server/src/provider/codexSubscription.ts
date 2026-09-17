import type { ServerProvider } from "@cafecode/contracts";
import type * as CodexSchema from "effect-codex-app-server/schema";

// Keep this exhaustive against the pinned app-server account/read schema. The
// lightweight usage endpoint carries the same plan names as an open string;
// never echo an unknown upstream value or infer a tier from quota percentages.
// https://learn.chatgpt.com/docs/app-server#authentication-modes
const CODEX_SUBSCRIPTION_LABELS = {
  free: "ChatGPT Free Subscription",
  go: "ChatGPT Go Subscription",
  plus: "ChatGPT Plus Subscription",
  pro: "ChatGPT Pro 20x Subscription",
  prolite: "ChatGPT Pro 5x Subscription",
  team: "ChatGPT Team Subscription",
  self_serve_business_prolite: "ChatGPT Business ProLite Subscription",
  self_serve_business_usage_based: "ChatGPT Business Subscription",
  business: "ChatGPT Business Subscription",
  ent26: "ChatGPT Enterprise Subscription",
  enterprise_cbp_automation: "ChatGPT Enterprise Subscription",
  enterprise_cbp_usage_based: "ChatGPT Enterprise Subscription",
  enterprise: "ChatGPT Enterprise Subscription",
  edu: "ChatGPT Edu Subscription",
  edu_plus: "ChatGPT Edu Plus Subscription",
  edu_pro: "ChatGPT Edu Pro Subscription",
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
