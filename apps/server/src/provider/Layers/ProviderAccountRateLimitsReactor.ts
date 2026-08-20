/**
 * ProviderAccountRateLimitsReactor — keeps provider usage snapshots current.
 *
 * Claude Code emits `rate_limit_event` (5h / weekly window reset + utilization) on its
 * normal session stream; the Claude adapter re-emits it as the `account.rate-limits.updated`
 * runtime event. Unlike Codex (whose limits come from the periodic probe), Claude has no
 * probe-time source — the probe never sends a prompt — so we consume the event here and
 * merge each window into the instance's `accountRateLimits` via the registry. Codex emits
 * sparse `account/rateLimits/updated` snapshots during active sessions; those updates are
 * merged into the latest full probe so a transient probe failure cannot leave a live quota
 * update invisible. From there both providers reach the UI through the existing snapshot
 * change pipeline. Codex and Grok expose their account usage through bounded, redacted
 * usage-only refreshes rather than prompt stream notifications. Trigger those refreshes after
 * a canonical terminal turn event, when the just-finished prompt has actually affected the
 * allowance, instead of when the prompt is submitted. The provider drivers own all credential
 * access; this reactor sees only the redacted resulting snapshot.
 *
 * This is a self-starting daemon layer: building it forks a scoped consumer of
 * `ProviderService.streamEvents` (a fresh PubSub subscription, independent of the other
 * consumers) for the lifetime of the runtime.
 *
 * @module ProviderAccountRateLimitsReactor
 */
import { ProviderDriverKind, type ProviderRuntimeEvent } from "@cafecode/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { parseClaudeRateLimitUpdate } from "../claudeRateLimits.ts";
import { parseCodexRateLimitUpdate } from "../codexRateLimits.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { ProviderService } from "../Services/ProviderService.ts";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const GROK_DRIVER = ProviderDriverKind.make("grok");
const TERMINAL_ACCOUNT_USAGE_REFRESH_THROTTLE_MS = 60_000;

export function providerAccountRateLimitUpdateFromEvent(event: ProviderRuntimeEvent) {
  if (event.type !== "account.rate-limits.updated") return null;
  if (event.providerInstanceId === undefined) return null;

  if (event.provider === CODEX_DRIVER) {
    const update = parseCodexRateLimitUpdate(event.payload.rateLimits);
    return update === null
      ? null
      : {
          kind: "snapshot" as const,
          instanceId: event.providerInstanceId,
          limitId: update.limitId,
          snapshot: update.snapshot,
        };
  }
  if (event.provider !== CLAUDE_DRIVER) return null;

  const update = parseClaudeRateLimitUpdate(event.payload.rateLimits);
  return update === null
    ? null
    : {
        kind: "window" as const,
        instanceId: event.providerInstanceId,
        slot: update.slot,
        window: update.window,
      };
}

export function providerAccountUsageRefreshInstanceFromEvent(event: ProviderRuntimeEvent) {
  if (event.type !== "turn.completed" && event.type !== "turn.aborted") return null;
  if (event.providerInstanceId === undefined) return null;
  if (event.provider !== CODEX_DRIVER && event.provider !== GROK_DRIVER) return null;
  return event.providerInstanceId;
}

export const ProviderAccountRateLimitsReactorLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const registry = yield* ProviderRegistry;
    const terminalUsageRefreshAtRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map());

    const handleEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
      Effect.gen(function* () {
        const update = providerAccountRateLimitUpdateFromEvent(event);
        if (update !== null) {
          const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
          if (update.kind === "snapshot") {
            yield* registry.updateProviderAccountRateLimits({
              instanceId: update.instanceId,
              limitId: update.limitId,
              snapshot: update.snapshot,
              checkedAt,
            });
          } else {
            yield* registry.updateProviderAccountRateLimits({
              instanceId: update.instanceId,
              slot: update.slot,
              window: update.window,
              checkedAt,
            });
          }
        }

        const refreshInstanceId = providerAccountUsageRefreshInstanceFromEvent(event);
        if (refreshInstanceId === null) return;

        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        const shouldRefresh = yield* Ref.modify(terminalUsageRefreshAtRef, (previous) => {
          const refreshKey = String(refreshInstanceId);
          const previousRefreshAt = previous.get(refreshKey);
          if (
            previousRefreshAt !== undefined &&
            nowMs - previousRefreshAt < TERMINAL_ACCOUNT_USAGE_REFRESH_THROTTLE_MS
          ) {
            return [false, previous] as const;
          }
          const next = new Map(previous);
          next.set(refreshKey, nowMs);
          return [true, next] as const;
        });
        if (!shouldRefresh) return;

        // This consumer is independent of provider runtime ingestion. A usage
        // endpoint outage must never delay or change the terminal turn state.
        yield* registry.refreshInstanceAccountUsage(refreshInstanceId).pipe(
          Effect.catchCause(() =>
            Effect.logWarning("provider terminal usage refresh failed", {
              eventType: event.type,
              instanceId: refreshInstanceId,
              provider: event.provider,
            }),
          ),
          Effect.asVoid,
        );
      });

    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) =>
        handleEvent(event).pipe(Effect.ignoreCause({ log: true })),
      ),
    );
  }),
);
