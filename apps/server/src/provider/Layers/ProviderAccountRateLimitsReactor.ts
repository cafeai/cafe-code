/**
 * ProviderAccountRateLimitsReactor — feeds Claude's event-sourced usage windows into
 * provider snapshots.
 *
 * Claude Code emits `rate_limit_event` (5h / weekly window reset + utilization) on its
 * normal session stream; the Claude adapter re-emits it as the `account.rate-limits.updated`
 * runtime event. Unlike Codex (whose limits come from the periodic probe), Claude has no
 * probe-time source — the probe never sends a prompt — so we consume the event here and
 * merge each window into the instance's `accountRateLimits` via the registry. From there it
 * reaches the UI through the existing snapshot change pipeline. We never call any usage
 * endpoint or touch the OAuth token; Claude Code does that internally and pushes us the event.
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
import * as Stream from "effect/Stream";

import { parseClaudeRateLimitUpdate } from "../claudeRateLimits.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { ProviderService } from "../Services/ProviderService.ts";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

export const ProviderAccountRateLimitsReactorLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const registry = yield* ProviderRegistry;

    const handleEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (event.type !== "account.rate-limits.updated") return;
        // Codex populates `accountRateLimits` from its authoritative probe; only Claude
        // is event-sourced. Leaving Codex on its probe path avoids parsing its differently
        // shaped notification here.
        if (event.provider !== CLAUDE_DRIVER) return;
        if (event.providerInstanceId === undefined) return;

        const update = parseClaudeRateLimitUpdate(event.payload.rateLimits);
        if (update === null) return;

        const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
        yield* registry.updateProviderAccountRateLimits({
          instanceId: event.providerInstanceId,
          slot: update.slot,
          window: update.window,
          checkedAt,
        });
      });

    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) =>
        handleEvent(event).pipe(Effect.ignoreCause({ log: true })),
      ),
    );
  }),
);
