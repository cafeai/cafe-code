import { ProviderUsageResetError, type CodexSettings } from "@cafecode/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import type * as CodexClient from "effect-codex-app-server/client";
import { codexAppServerRateLimitsToServer } from "./codexRateLimits.ts";
import { readCodexUsageIdentity, withCodexMetadataClient } from "./Layers/CodexProvider.ts";
import type { ProviderUsageResetOperation } from "./ProviderUsageReset.ts";

/**
 * Official contract: https://learn.chatgpt.com/docs/app-server#8-earned-rate-limit-resets-chatgpt
 * A retry always keeps its original idempotency key and optional credit id.
 * Never infer refreshed percentages from a successful consume response.
 */
export const requestCodexUsageReset = Effect.fn("requestCodexUsageReset")(function* <R = never>(
  client: CodexClient.CodexAppServerClientShape,
  operation: ProviderUsageResetOperation,
  beforeConsume: Effect.Effect<void, ProviderUsageResetError, R> = Effect.void,
) {
  const account = yield* client.request("account/read", {});
  if (account.account?.type !== "chatgpt") {
    return yield* Effect.fail(
      new ProviderUsageResetError({ message: "Usage resets require a ChatGPT Codex account." }),
    );
  }
  if (operation.action === "redeem") {
    yield* beforeConsume;
    yield* operation.beforeDispatch ?? Effect.void;
    yield* Effect.sync(() => operation.onDispatch?.());
  }
  const outcome =
    operation.action === "redeem"
      ? (yield* client.request("account/rateLimitResetCredit/consume", {
          idempotencyKey: operation.idempotencyKey,
          ...(operation.creditId ? { creditId: operation.creditId } : {}),
        })).outcome
      : null;
  if (operation.action === "redeem" && outcome !== null) {
    yield* Effect.sync(() => operation.onOutcome?.(outcome));
  }
  const rateLimits = yield* client.request("account/rateLimits/read", undefined).pipe(
    Effect.timeout(Duration.seconds(5)),
    Effect.flatMap((response) =>
      DateTime.now.pipe(
        Effect.map((now) => codexAppServerRateLimitsToServer(response, DateTime.formatIso(now))),
      ),
    ),
    // A completed redemption remains completed even if the subsequent read fails.
    // The UI explicitly shows unavailable fresh usage and offers a read-only refresh.
    Effect.catch((error) => (outcome === null ? Effect.fail(error) : Effect.succeed(null))),
  );
  return { outcome, rateLimits };
});

export const runCodexUsageReset = Effect.fn("runCodexUsageReset")(function* (input: {
  readonly settings: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly operation: ProviderUsageResetOperation;
}) {
  const identity = yield* readCodexUsageIdentity(input.settings, input.environment);
  if (!identity || (input.operation.action === "redeem" && input.operation.identity !== identity)) {
    return yield* Effect.fail(
      new ProviderUsageResetError({
        message: "Codex authentication changed. Reopen the reset dialog to check this account.",
      }),
    );
  }
  return yield* withCodexMetadataClient(
    {
      binaryPath: input.settings.binaryPath,
      homePath: input.settings.homePath,
      environment: input.environment,
      cwd: input.cwd,
    },
    (client) =>
      Effect.gen(function* () {
        // Fail closed if auth changed during process startup. Checking before consume
        // prevents an old dialog from spending a new account's scarce reset credit.
        const currentIdentity = yield* readCodexUsageIdentity(input.settings, input.environment);
        if (currentIdentity !== identity) {
          return yield* Effect.fail(
            new ProviderUsageResetError({
              message: "Codex authentication changed. Reopen the reset dialog.",
            }),
          );
        }
        const result = yield* requestCodexUsageReset(
          client,
          input.operation,
          readCodexUsageIdentity(input.settings, input.environment).pipe(
            Effect.flatMap((beforeConsumeIdentity) =>
              beforeConsumeIdentity === identity
                ? Effect.void
                : Effect.fail(
                    new ProviderUsageResetError({
                      message: "Codex authentication changed. Reopen the reset dialog.",
                    }),
                  ),
            ),
          ),
        );
        return { ...result, identity };
      }),
  );
});
