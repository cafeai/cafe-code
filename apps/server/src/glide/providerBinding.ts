import { type ThreadId, type ProviderInstanceId } from "@cafecode/contracts";
import { ProviderAdapterProcessError } from "../provider/Errors.ts";
import * as Effect from "effect/Effect";
import { readGlideSessionBroker, type GlideSessionBinding } from "./sessionRuntime.ts";

export type { GlideSessionBinding } from "./sessionRuntime.ts";
export const bindGlideSession = (input: {
  threadId: ThreadId;
  providerInstanceId: ProviderInstanceId;
  provider: "codex" | "claudeAgent" | "grok";
  runtimeMode: string;
}) =>
  Effect.tryPromise({
    try: () => readGlideSessionBroker()?.bind(input) ?? Promise.resolve(undefined),
    catch: () =>
      new ProviderAdapterProcessError({
        provider: input.provider,
        threadId: input.threadId,
        detail: "Could not attach Glide desktop tools.",
      }),
  });
export const disposeGlideSession = (binding: GlideSessionBinding | undefined) =>
  Effect.promise(() => binding?.dispose() ?? Promise.resolve()).pipe(
    Effect.catchCause(() => Effect.logWarning("Glide session cleanup remains incomplete.")),
  );
export const cancelGlideSession = (binding: GlideSessionBinding | undefined) =>
  Effect.promise(() => binding?.cancel() ?? Promise.resolve()).pipe(
    Effect.catchCause(() => Effect.logWarning("Glide cancellation cleanup remains incomplete.")),
  );
export const activateGlideSession = (
  binding: GlideSessionBinding | undefined,
  input: { threadId: ThreadId; provider: "codex" | "claudeAgent" | "grok" },
) =>
  Effect.tryPromise({
    try: () => binding?.activate() ?? Promise.resolve(),
    catch: () =>
      new ProviderAdapterProcessError({
        provider: input.provider,
        threadId: input.threadId,
        detail: "Could not activate Glide desktop tools.",
      }),
  });
