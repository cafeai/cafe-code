/**
 * Typed mapping for Codex app-server account rate-limit responses and rolling updates.
 *
 * `account/rateLimits/read` returns the complete account snapshot, while
 * `account/rateLimits/updated` is intentionally sparse. Nullable fields in a rolling
 * notification mean "unavailable in this update", not "clear the cached value", so the
 * reactor maps only values that are actually present and lets the provider registry merge
 * them into the most recent snapshot.
 *
 * @module codexRateLimits
 */
import type {
  ServerProviderAccountRateLimitResetCredit,
  ServerProviderAccountRateLimits,
  ServerProviderAccountRateLimitSnapshot,
  ServerProviderAccountRateLimitWindow,
} from "@cafecode/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as CodexSchema from "effect-codex-app-server/schema";

const decodeRateLimitsUpdatedNotification = Schema.decodeUnknownOption(
  CodexSchema.V2AccountRateLimitsUpdatedNotification,
);

function mapRateLimitWindow(
  window: CodexSchema.V2GetAccountRateLimitsResponse__RateLimitWindow | null | undefined,
): ServerProviderAccountRateLimitWindow | null {
  if (!window) return null;
  return {
    usedPercent: window.usedPercent,
    ...(window.windowDurationMins !== undefined
      ? { windowDurationMins: window.windowDurationMins }
      : {}),
    ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
  };
}

function mapCredits(
  credits: CodexSchema.V2GetAccountRateLimitsResponse__CreditsSnapshot | null,
): Exclude<ServerProviderAccountRateLimitSnapshot["credits"], undefined> {
  if (credits === null) return null;
  return {
    hasCredits: credits.hasCredits,
    unlimited: credits.unlimited,
    ...(credits.balance !== undefined ? { balance: credits.balance } : {}),
  };
}

function mapSpendControlLimit(
  limit: CodexSchema.V2GetAccountRateLimitsResponse__SpendControlLimitSnapshot | null | undefined,
): Exclude<ServerProviderAccountRateLimitSnapshot["individualLimit"], undefined> {
  if (limit === null || limit === undefined) return null;
  return {
    limit: limit.limit,
    remainingPercent: limit.remainingPercent,
    resetsAt: limit.resetsAt,
    used: limit.used,
  };
}

function mapRateLimitSnapshot(
  snapshot: CodexSchema.V2GetAccountRateLimitsResponse__RateLimitSnapshot,
): ServerProviderAccountRateLimitSnapshot {
  return {
    ...(snapshot.limitId !== undefined ? { limitId: snapshot.limitId } : {}),
    ...(snapshot.limitName !== undefined ? { limitName: snapshot.limitName } : {}),
    ...(snapshot.planType !== undefined ? { planType: snapshot.planType } : {}),
    ...(snapshot.rateLimitReachedType !== undefined
      ? { rateLimitReachedType: snapshot.rateLimitReachedType }
      : {}),
    ...(snapshot.spendControlReached !== undefined
      ? { spendControlReached: snapshot.spendControlReached }
      : {}),
    ...(snapshot.individualLimit !== undefined
      ? { individualLimit: mapSpendControlLimit(snapshot.individualLimit) }
      : {}),
    ...(snapshot.primary !== undefined ? { primary: mapRateLimitWindow(snapshot.primary) } : {}),
    ...(snapshot.secondary !== undefined
      ? { secondary: mapRateLimitWindow(snapshot.secondary) }
      : {}),
    ...(snapshot.credits !== undefined ? { credits: mapCredits(snapshot.credits) } : {}),
  };
}

function mapRateLimitResetCredit(
  credit: CodexSchema.V2GetAccountRateLimitsResponse__RateLimitResetCredit,
): ServerProviderAccountRateLimitResetCredit {
  return {
    id: credit.id,
    resetType: credit.resetType,
    status: credit.status,
    grantedAt: credit.grantedAt,
    ...(credit.expiresAt !== undefined ? { expiresAt: credit.expiresAt } : {}),
    ...(credit.title !== undefined ? { title: credit.title } : {}),
    ...(credit.description !== undefined ? { description: credit.description } : {}),
  };
}

function mapRateLimitResetCredits(
  summary:
    | CodexSchema.V2GetAccountRateLimitsResponse__RateLimitResetCreditsSummary
    | null
    | undefined,
): ServerProviderAccountRateLimits["rateLimitResetCredits"] | undefined {
  if (summary === undefined) return undefined;
  if (summary === null) return null;
  return {
    availableCount: summary.availableCount,
    ...(summary.credits !== undefined
      ? {
          credits: summary.credits === null ? null : summary.credits.map(mapRateLimitResetCredit),
        }
      : {}),
  };
}

export function codexAppServerRateLimitsToServer(
  response: CodexSchema.V2GetAccountRateLimitsResponse,
  checkedAt: string,
): ServerProviderAccountRateLimits {
  const byLimitId =
    response.rateLimitsByLimitId === null || response.rateLimitsByLimitId === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(response.rateLimitsByLimitId).map(([limitId, snapshot]) => [
            limitId,
            mapRateLimitSnapshot(snapshot),
          ]),
        );
  const rateLimitResetCredits = mapRateLimitResetCredits(response.rateLimitResetCredits);

  return {
    rateLimits: mapRateLimitSnapshot(response.rateLimits),
    ...(byLimitId ? { rateLimitsByLimitId: byLimitId } : {}),
    ...(rateLimitResetCredits !== undefined ? { rateLimitResetCredits } : {}),
    checkedAt,
  };
}

export interface CodexRateLimitSnapshotUpdate {
  readonly limitId: string;
  readonly snapshot: ServerProviderAccountRateLimitSnapshot;
}

function mapRollingRateLimitWindow(
  window: CodexSchema.V2AccountRateLimitsUpdatedNotification__RateLimitWindow | null | undefined,
): ServerProviderAccountRateLimitWindow | undefined {
  if (!window) return undefined;
  return {
    usedPercent: window.usedPercent,
    ...(typeof window.windowDurationMins === "number"
      ? { windowDurationMins: window.windowDurationMins }
      : {}),
    ...(typeof window.resetsAt === "number" ? { resetsAt: window.resetsAt } : {}),
  };
}

function mapRollingCredits(
  credits: CodexSchema.V2AccountRateLimitsUpdatedNotification__CreditsSnapshot,
): Exclude<ServerProviderAccountRateLimitSnapshot["credits"], null | undefined> {
  return {
    hasCredits: credits.hasCredits,
    unlimited: credits.unlimited,
    ...(credits.balance ? { balance: credits.balance } : {}),
  };
}

/**
 * Decode the canonical runtime payload for `account/rateLimits/updated` and retain only
 * non-null fields. App-server documents this notification as a sparse rolling update;
 * retaining nulls here would incorrectly erase metadata from the latest full read.
 */
export function parseCodexRateLimitUpdate(raw: unknown): CodexRateLimitSnapshotUpdate | null {
  const decoded = decodeRateLimitsUpdatedNotification(raw);
  if (Option.isNone(decoded)) return null;

  const update = decoded.value.rateLimits;
  const limitId = update.limitId?.trim() || "codex";
  const primary = mapRollingRateLimitWindow(update.primary);
  const secondary = mapRollingRateLimitWindow(update.secondary);
  const snapshot: ServerProviderAccountRateLimitSnapshot = {
    limitId,
    ...(update.limitName ? { limitName: update.limitName } : {}),
    ...(update.planType ? { planType: update.planType } : {}),
    ...(update.rateLimitReachedType ? { rateLimitReachedType: update.rateLimitReachedType } : {}),
    ...(typeof update.spendControlReached === "boolean"
      ? { spendControlReached: update.spendControlReached }
      : {}),
    ...(update.individualLimit
      ? { individualLimit: mapSpendControlLimit(update.individualLimit) }
      : {}),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(update.credits ? { credits: mapRollingCredits(update.credits) } : {}),
  };

  return Object.keys(snapshot).length > 1 ? { limitId, snapshot } : null;
}
