import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
export const ThreadSecretId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/));
export const ThreadSecretValue = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(16_384),
);
export const ThreadSecretMetadata = Schema.Struct({
  id: ThreadSecretId,
  label: Schema.String.check(Schema.isMaxLength(160)),
  reference: Schema.String.check(Schema.isMaxLength(64)),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type ThreadSecretMetadata = typeof ThreadSecretMetadata.Type;
export const ThreadSecretsCapabilitiesInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
}).annotate(strict);
export const ThreadSecretsCapabilitiesResult = Schema.Struct({ supported: Schema.Boolean });
export const ThreadSecretsInput = Schema.Struct({ threadId: ThreadId }).annotate(strict);
export const ThreadSecretInput = Schema.Struct({ threadId: ThreadId, id: ThreadSecretId }).annotate(
  strict,
);
export const ThreadSecretsPrepareInput = Schema.Struct({
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  text: Schema.String.check(Schema.isMaxLength(1_048_576)),
}).annotate(strict);
export const ThreadSecretsPrepareResult = Schema.Struct({ text: Schema.String });
export const ThreadSecretsListResult = Schema.Struct({
  secrets: Schema.Array(ThreadSecretMetadata).check(Schema.isMaxLength(64)),
});
export const ThreadSecretsSetInput = Schema.Struct({
  threadId: ThreadId,
  id: Schema.optionalKey(ThreadSecretId),
  label: Schema.optionalKey(ThreadSecretMetadata.fields.label),
  value: ThreadSecretValue,
}).annotate(strict);
export const ThreadSecretsSetResult = Schema.Struct({ secret: ThreadSecretMetadata });
export const ThreadSecretsRevealResult = Schema.Struct({ value: ThreadSecretValue });
export const ThreadSecretsRemoveResult = Schema.Struct({ removed: Schema.Boolean });
export const ThreadSecretsClearResult = Schema.Struct({
  removed: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 64 })),
});
export class ThreadSecretsError extends Schema.TaggedErrorClass<ThreadSecretsError>()(
  "ThreadSecretsError",
  {
    message: Schema.String,
  },
) {}

export interface ThreadSecretsApi {
  capabilities(
    input: typeof ThreadSecretsCapabilitiesInput.Type,
  ): Promise<typeof ThreadSecretsCapabilitiesResult.Type>;
  prepare(
    input: typeof ThreadSecretsPrepareInput.Type,
  ): Promise<typeof ThreadSecretsPrepareResult.Type>;
  list(input: typeof ThreadSecretsInput.Type): Promise<typeof ThreadSecretsListResult.Type>;
  set(input: typeof ThreadSecretsSetInput.Type): Promise<typeof ThreadSecretsSetResult.Type>;
  reveal(input: typeof ThreadSecretInput.Type): Promise<typeof ThreadSecretsRevealResult.Type>;
  remove(input: typeof ThreadSecretInput.Type): Promise<typeof ThreadSecretsRemoveResult.Type>;
  clear(input: typeof ThreadSecretsInput.Type): Promise<typeof ThreadSecretsClearResult.Type>;
}
