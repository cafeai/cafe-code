import * as Schema from "effect/Schema";
export const CafeMcpStatus = Schema.Struct({ enabled: Schema.Boolean, canManage: Schema.Boolean });
export type CafeMcpStatus = typeof CafeMcpStatus.Type;
export class CafeMcpError extends Schema.TaggedErrorClass<CafeMcpError>()("CafeMcpError", {
  code: Schema.Literals(["configuration", "bridge_missing", "not_authorized", "unavailable"]),
  message: Schema.String.check(Schema.isMaxLength(512)),
}) {}
