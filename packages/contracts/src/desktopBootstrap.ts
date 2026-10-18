import * as Schema from "effect/Schema";

import { PortSchema } from "./baseSchemas.ts";
import { ProviderDaemonClientConfig } from "./providerDaemon.ts";

export const DesktopBackendBootstrap = Schema.Struct({
  mode: Schema.Literal("desktop"),
  noBrowser: Schema.Boolean,
  port: PortSchema,
  httpsPort: Schema.optional(PortSchema),
  cafeCodeHome: Schema.String,
  // Keep the historical home field effective, so a stale child that ignores
  // new metadata still cannot open Production for a Debug launch. New children
  // validate the configured/effective pair and resolve it exactly once.
  dataProfile: Schema.optional(Schema.Literals(["production", "debug"])),
  configuredCafeCodeHome: Schema.optional(Schema.String),
  host: Schema.String,
  desktopBootstrapToken: Schema.String,
  // A separate per-spawn secret proves that readiness came from this exact
  // child. It is never a renderer/bootstrap credential or public descriptor.
  desktopReadinessToken: Schema.optional(
    Schema.String.check(Schema.isMaxLength(64), Schema.isPattern(/^[a-f0-9]{64}$/u)),
  ),
  // The desktop alone opts into its exact child's private progress pipe.
  // Never infer this descriptor from ambient process state or an environment.
  startupProgressFd: Schema.optional(Schema.Literal(4)),
  otlpTracesUrl: Schema.optional(Schema.String),
  otlpMetricsUrl: Schema.optional(Schema.String),
  providerDaemon: Schema.optional(ProviderDaemonClientConfig),
});

export type DesktopBackendBootstrap = typeof DesktopBackendBootstrap.Type;
