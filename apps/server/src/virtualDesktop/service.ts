import { VIRTUAL_DESKTOP_DAEMON_PATH } from "@cafecode/contracts";
import {
  VirtualDesktopError,
  VirtualDesktopRequest,
  VirtualDesktopState,
  DesktopObservationRetention,
  DesktopViewerAppearance,
  DesktopResolution,
  VirtualDesktopId,
} from "@cafecode/contracts";
import { requestProviderDaemonJson } from "@cafecode/shared/providerDaemonHttp";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { desktopError } from "./nativeClient.ts";
import { readDesktopManager } from "./runtime.ts";

const Flags = Schema.Struct({
  virtualDesktopsEnabled: Schema.Boolean,
  desktopControlMcpEnabled: Schema.Boolean,
  desktopObservationRetention: DesktopObservationRetention,
  desktopDefaultResolution: Schema.optionalKey(DesktopResolution),
});
export const DesktopInternalRequest = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("terminate-all") }),
  Schema.Struct({ operation: Schema.Literal("manage"), input: VirtualDesktopRequest }),
  Schema.Struct({ operation: Schema.Literal("preview"), id: VirtualDesktopId }),
  Schema.Struct({ operation: Schema.Literal("policy"), policy: Flags }),
  Schema.Struct({
    operation: Schema.Literal("connect"),
    id: Schema.String,
    environment: Schema.Record(Schema.String, Schema.String),
    appearance: Schema.optionalKey(DesktopViewerAppearance),
  }),
  Schema.Struct({ operation: Schema.Literal("authorize"), token: Schema.String }),
  Schema.Struct({
    operation: Schema.Literal("tool"),
    token: Schema.String,
    name: Schema.String,
    args: Schema.Record(Schema.String, Schema.Unknown),
  }),
]);
export const DESKTOP_DAEMON_PATH = VIRTUAL_DESKTOP_DAEMON_PATH;
export async function dispatchDesktopRequest(
  input: typeof DesktopInternalRequest.Type,
  signal?: AbortSignal,
): Promise<unknown> {
  const manager = readDesktopManager();
  if (!manager) {
    if (input.operation === "manage" && input.input.operation === "status")
      return {
        supported: false,
        enabled: false,
        controlEnabled: false,
        available: false,
        reason: "Virtual desktops require Linux with the local provider runtime.",
        desktops: [],
        selectedDesktopId: null,
        activeDesktopId: null,
        selectionPending: false,
      } satisfies VirtualDesktopState;
    throw desktopError("unavailable", "The virtual desktop runtime is unavailable.");
  }
  switch (input.operation) {
    case "terminate-all":
      await manager.terminateAll();
      return {};
    case "manage":
      return manager.manage(input.input);
    case "preview":
      return manager.preview(input.id, signal);
    case "policy":
      await manager.setPolicy(input.policy);
      return {};
    case "connect":
      await manager.connect(input.id, input.environment, input.appearance);
      return {};
    case "authorize":
      manager.authorize(input.token);
      return {};
    case "tool":
      return manager.tool(input.token, input.name, input.args, signal);
  }
}

/** Separate from the provider command ledger: never persist/replay screenshots,
 * bearer capabilities, keyboard text, or non-idempotent physical input. */
const decodeDesktopError = Schema.decodeUnknownOption(VirtualDesktopError);
const decodeDesktopState = Schema.decodeUnknownEffect(VirtualDesktopState);

export const makeDesktopService = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const settings = yield* ServerSettingsService;
  const request = (input: typeof DesktopInternalRequest.Type) =>
    Effect.tryPromise({
      try: async (signal) => {
        if (!config.providerDaemon) return dispatchDesktopRequest(input, signal);
        const result = await requestProviderDaemonJson(config.providerDaemon, DESKTOP_DAEMON_PATH, {
          method: "POST",
          body: JSON.stringify(input),
          timeoutMs: 50_000,
          maxResponseBytes: 16 * 1024 * 1024,
          signal,
        });
        const body: unknown = JSON.parse(result.body);
        if (result.statusCode !== 200) {
          const error = decodeDesktopError(body);
          if (error._tag === "Some") throw error.value;
          throw desktopError("operation_failed", "The desktop runtime is unavailable.");
        }
        return body;
      },
      catch: (error) =>
        error instanceof VirtualDesktopError
          ? error
          : desktopError(
              "operation_failed",
              "The desktop request was interrupted. Check its state before retrying.",
            ),
    });
  return {
    manage: (input: VirtualDesktopRequest) =>
      request({ operation: "manage", input }).pipe(
        Effect.flatMap((v) => decodeDesktopState(v)),
        Effect.mapError((error) =>
          error instanceof VirtualDesktopError
            ? error
            : desktopError("operation_failed", "Could not read the desktop state."),
        ),
      ),
    request,
    syncPolicy: settings.getSettings.pipe(
      Effect.flatMap((policy) => request({ operation: "policy", policy })),
    ),
  };
});
