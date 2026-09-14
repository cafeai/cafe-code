import * as Schema from "effect/Schema";

export const CafeMcpClientId = Schema.Literals(["codex", "claude", "grok", "opencode"]);
export type CafeMcpClientId = typeof CafeMcpClientId.Type;

export const CafeMcpClientStatus = Schema.Struct({
  id: CafeMcpClientId,
  name: Schema.String,
  status: Schema.Literals([
    "not-installed",
    "installed",
    "needs-repair",
    "conflict",
    "unavailable",
  ]),
  detail: Schema.String.check(Schema.isMaxLength(512)),
});
export type CafeMcpClientStatus = typeof CafeMcpClientStatus.Type;

export const CafeMcpStatus = Schema.Struct({
  enabled: Schema.Boolean,
  canManage: Schema.Boolean,
  canInstall: Schema.Boolean,
  bridgeReady: Schema.Boolean,
  clients: Schema.Array(CafeMcpClientStatus),
});
export type CafeMcpStatus = typeof CafeMcpStatus.Type;

export const CafeMcpClientUpdate = Schema.Struct({
  client: CafeMcpClientId,
  operation: Schema.Literals(["install", "remove"]),
});
export type CafeMcpClientUpdate = typeof CafeMcpClientUpdate.Type;

export class CafeMcpError extends Schema.TaggedErrorClass<CafeMcpError>()("CafeMcpError", {
  code: Schema.Literals(["configuration", "bridge_missing", "not_authorized", "unavailable"]),
  message: Schema.String.check(Schema.isMaxLength(512)),
}) {}
