import * as Schema from "effect/Schema";
import { CommandId, ThreadId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/** The original command identity survives transport retries into the daemon ledger. */
export const ProviderCompactThreadInput = Schema.Struct({
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  operationId: CommandId,
});
export type ProviderCompactThreadInput = typeof ProviderCompactThreadInput.Type;
