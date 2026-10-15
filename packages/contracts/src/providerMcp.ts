import * as Schema from "effect/Schema";
import { ProviderSecurityInput, ProviderSecurityReadInput } from "./providerSecurity.ts";

const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const Text = Schema.String.check(Schema.isMaxLength(8192));
const ServerName = Schema.String.check(Schema.isPattern(/^[a-z0-9](?:[a-z0-9_]{0,46}[a-z0-9])?$/));
const Command = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4096),
  Schema.makeFilter((value) => value.trim().length > 0 && !/[\0\r\n]/.test(value)),
);
const Arguments = Schema.Array(
  Text.check(Schema.makeFilter((value) => !value.includes("\0"))),
).check(Schema.isMaxLength(128));
const EnvironmentName = Schema.String.check(Schema.isPattern(/^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/));
const EnvironmentValue = Schema.String.check(
  Schema.isMaxLength(16384),
  Schema.makeFilter((value) => !value.includes("\0")),
);
const Revision = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
export const ProviderMcpServerInput = Schema.Struct({
  name: ServerName,
  command: Command,
  args: Arguments,
  enabled: Schema.Boolean,
  // Omission preserves native credentials. Empty clears them. Values are never returned.
  env: Schema.optional(
    Schema.Record(EnvironmentName, EnvironmentValue).check(
      Schema.makeFilter((value) => Object.keys(value).length <= 64),
    ),
  ),
});
export const ProviderMcpAction = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("list") }),
  Schema.Struct({ kind: Schema.Literal("save"), server: ProviderMcpServerInput }),
  Schema.Struct({ kind: Schema.Literal("delete"), name: ServerName }),
  Schema.Struct({ kind: Schema.Literal("test"), name: ServerName }),
  Schema.Struct({
    kind: Schema.Literal("select"),
    tools: Schema.Array(Name).check(Schema.isMaxLength(2048)),
  }),
]);
export const ProviderMcpInput = Schema.Struct({
  ...ProviderSecurityInput.fields,
  expectedRevision: Schema.optional(Revision),
  action: ProviderMcpAction,
});
export type ProviderMcpInput = typeof ProviderMcpInput.Type;
export const ProviderMcpNativeInput = Schema.Struct({
  ...ProviderMcpInput.fields,
  configurationKey: ProviderSecurityReadInput.fields.configurationKey,
});
export type ProviderMcpNativeInput = typeof ProviderMcpNativeInput.Type;
export const ProviderMcpState = Schema.Struct({
  revision: Revision,
  servers: Schema.Array(
    Schema.Struct({
      name: ServerName,
      command: Command,
      args: Arguments,
      enabled: Schema.Boolean,
      environmentKeys: Schema.Array(EnvironmentName).check(Schema.isMaxLength(64)),
      tools: Schema.Array(Schema.Struct({ name: Name, description: Text, schemaHash: Name })).check(
        Schema.isMaxLength(2048),
      ),
      status: Name,
      error: Schema.optional(Schema.NullOr(Text)),
    }),
  ).check(Schema.isMaxLength(32)),
  selectedTools: Schema.Array(Name).check(Schema.isMaxLength(2048)),
});
export type ProviderMcpState = typeof ProviderMcpState.Type;
export const ProviderMcpResult = Schema.Struct({ state: Schema.NullOr(ProviderMcpState) });
export type ProviderMcpResult = typeof ProviderMcpResult.Type;
