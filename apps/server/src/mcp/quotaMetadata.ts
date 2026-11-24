import type { ServerProvider } from "@cafecode/contracts";
import {
  deriveAvailableRateLimitResetCount,
  deriveCodexRateLimitBuckets,
  deriveProviderRateLimitWindow,
} from "@cafecode/shared/threadResourceUsage";
import { z } from "zod";

export const nullableQuotaNumber = z.number().finite().nonnegative().nullable();
export const quotaWindowSchema = z
  .object({
    usedPercent: nullableQuotaNumber,
    remainingPercent: nullableQuotaNumber,
    windowDurationMins: nullableQuotaNumber,
    resetsAtEpochSeconds: nullableQuotaNumber,
  })
  .nullable();
export const quotaLimitSchema = z.object({
  limitId: z.string(),
  limitName: z.string().nullable(),
  normalModelSlug: z.string().nullable(),
  primary: quotaWindowSchema,
  secondary: quotaWindowSchema,
  credits: z
    .object({ balance: z.string().nullable(), hasCredits: z.boolean(), unlimited: z.boolean() })
    .nullable(),
});
export const quotaSchema = z.object({
  status: z.enum(["reported", "unknown"]),
  scope: z.literal("provider-account"),
  providerInstanceId: z.string().nullable(),
  checkedAt: z.string().nullable(),
  limits: z.array(quotaLimitSchema).max(128),
  availableResetCount: nullableQuotaNumber,
  truncated: z.boolean(),
});

export function accountRateLimitsForProvider(provider: ServerProvider | undefined) {
  // The UI can retain historical windows when a login cannot be revalidated.
  // These tools describe the current account and expose only qualified snapshots.
  return provider?.auth.status === "authenticated" && !provider.accountRateLimits?.stale
    ? provider.accountRateLimits
    : undefined;
}

function quotaWindow(input: Parameters<typeof deriveProviderRateLimitWindow>[0]) {
  const window = deriveProviderRateLimitWindow(input);
  return window
    ? {
        usedPercent: window.usedPercent,
        remainingPercent: window.remainingPercent,
        windowDurationMins: window.windowDurationMins,
        resetsAtEpochSeconds: window.resetsAt,
      }
    : null;
}

/** Share exactly the same cached account view with the chat-context tool.
 * The cache receipt dates the snapshot, not every retained native window. */
export function cachedProviderQuota(provider: ServerProvider | undefined, instanceId: string) {
  const account = accountRateLimitsForProvider(provider);
  const buckets = deriveCodexRateLimitBuckets(account);
  return {
    status: account ? ("reported" as const) : ("unknown" as const),
    scope: "provider-account" as const,
    providerInstanceId: instanceId,
    checkedAt: account?.checkedAt ?? null,
    limits: buckets.slice(0, 128).map((bucket) => ({
      limitId: bucket.id,
      limitName: bucket.snapshot.limitName ?? null,
      normalModelSlug: bucket.snapshot.normalModelSlug ?? null,
      primary: quotaWindow(bucket.snapshot.primary),
      secondary: quotaWindow(bucket.snapshot.secondary),
      credits: bucket.snapshot.credits
        ? {
            hasCredits: bucket.snapshot.credits.hasCredits,
            unlimited: bucket.snapshot.credits.unlimited,
            balance: bucket.snapshot.credits.balance ?? null,
          }
        : null,
    })),
    availableResetCount: deriveAvailableRateLimitResetCount(account),
    truncated: buckets.length > 128,
  };
}
