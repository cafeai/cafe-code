import * as Schema from "effect/Schema";

import { PortSchema } from "./baseSchemas.ts";
import { ProviderDaemonClientConfig } from "./providerDaemon.ts";

export const DesktopBackendBootstrap = Schema.Struct({
  mode: Schema.Literal("desktop"),
  noBrowser: Schema.Boolean,
  port: PortSchema,
  httpsPort: Schema.optional(PortSchema),
  cafeCodeHome: Schema.String,
  host: Schema.String,
  desktopBootstrapToken: Schema.String,
  otlpTracesUrl: Schema.optional(Schema.String),
  otlpMetricsUrl: Schema.optional(Schema.String),
  providerDaemon: Schema.optional(ProviderDaemonClientConfig),
});

export type DesktopBackendBootstrap = typeof DesktopBackendBootstrap.Type;
