import { createHash } from "node:crypto";
import { ProviderTaskControlInput, ProviderTaskControlResult } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { makeProviderDaemonCommandLedger } from "../providerDaemon/CommandLedger.ts";

const decodeTaskControlResult = Schema.decodeUnknownEffect(ProviderTaskControlResult);

export interface TaskControlJournal {
  readonly run: (
    input: ProviderTaskControlInput,
    execute: Effect.Effect<ProviderTaskControlResult>,
  ) => Effect.Effect<ProviderTaskControlResult>;
}

/** The immutable, schema-canonical tuple owns its receipt, not a browser click
 * id. A lost acknowledgement must never turn a reconnect into another stop or
 * background request. Unfinished claims deliberately remain unknown. */
export const makeTaskControlJournal = Effect.gen(function* () {
  const ledger = yield* makeProviderDaemonCommandLedger({
    ownerKey: "provider-task-controls",
    recoverAbandonedOnStartup: false,
  });
  const encode = Schema.encodeSync(Schema.fromJsonString(ProviderTaskControlInput));
  return {
    run: (input, execute) =>
      Effect.gen(function* () {
        const commandId = createHash("sha256")
          .update("cafe-task-control-v1\0")
          .update(encode(input))
          .digest("hex");
        const response = yield* ledger.runOnce(
          { method: "controlTask", commandId, payload: input },
          execute.pipe(Effect.map((value) => ({ ok: true as const, value }))),
        );
        if (!response.ok) return { status: "unknown" as const };
        return yield* decodeTaskControlResult(response.value).pipe(
          Effect.catch(() => Effect.succeed({ status: "unknown" as const })),
        );
      }),
  } satisfies TaskControlJournal;
});
