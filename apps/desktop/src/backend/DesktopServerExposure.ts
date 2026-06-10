import * as NodeOS from "node:os";

import {
  createAdvertisedEndpoint,
  type CreateAdvertisedEndpointInput,
} from "@cafecode/shared/advertisedEndpoint";
import type {
  AdvertisedEndpoint,
  AdvertisedEndpointProvider,
  DesktopServerExposureMode,
  DesktopServerExposureState,
} from "@cafecode/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { DEFAULT_DESKTOP_SETTINGS, type DesktopSettings } from "../settings/DesktopAppSettings.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopAppSettingsService from "../settings/DesktopAppSettings.ts";

export const DESKTOP_LOOPBACK_HOST = "127.0.0.1";
const DESKTOP_LAN_BIND_HOST = "0.0.0.0";

export interface DesktopNetworkInterfaceInfo {
  readonly address: string;
  readonly family: string | number;
  readonly internal: boolean;
  readonly netmask?: string;
  readonly mac?: string;
  readonly cidr?: string | null;
  readonly scopeid?: number;
}

export type DesktopNetworkInterfaces = Readonly<
  Record<string, readonly DesktopNetworkInterfaceInfo[] | undefined>
>;

interface ResolvedDesktopServerExposure {
  readonly mode: DesktopServerExposureMode;
  readonly httpsEnabled: boolean;
  readonly bindHost: string;
  readonly localHttpUrl: string;
  readonly localWsUrl: string;
  readonly localHttpsUrl: string | null;
  readonly endpointUrl: string | null;
  readonly httpsEndpointUrl: string | null;
  readonly advertisedHost: string | null;
}

interface DesktopAdvertisedEndpointInput {
  readonly exposure: ResolvedDesktopServerExposure;
  readonly customHttpsEndpointUrls?: readonly string[];
}

const DESKTOP_CORE_ENDPOINT_PROVIDER: AdvertisedEndpointProvider = {
  id: "desktop-core",
  label: "Desktop",
  kind: "core",
  isAddon: false,
};

const DESKTOP_MANUAL_ENDPOINT_PROVIDER: AdvertisedEndpointProvider = {
  id: "manual",
  label: "Manual",
  kind: "manual",
  isAddon: false,
};

const normalizeOptionalHost = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
};

const isUsableLanIpv4Address = (address: string): boolean =>
  !address.startsWith("127.") && !address.startsWith("169.254.");

const isHttpsEndpointUrl = (value: string): boolean => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

const resolveLanAdvertisedHost = (
  networkInterfaces: DesktopNetworkInterfaces,
  explicitHost: string | undefined,
): string | null => {
  const normalizedExplicitHost = normalizeOptionalHost(explicitHost);
  if (normalizedExplicitHost) {
    return normalizedExplicitHost;
  }

  for (const interfaceAddresses of Object.values(networkInterfaces)) {
    if (!interfaceAddresses) continue;

    for (const address of interfaceAddresses) {
      if (address.internal) continue;
      if (address.family !== "IPv4") continue;
      if (!isUsableLanIpv4Address(address.address)) continue;
      return address.address;
    }
  }

  return null;
};

const resolveDesktopServerExposure = (input: {
  readonly mode: DesktopServerExposureMode;
  readonly httpsEnabled: boolean;
  readonly port: number;
  readonly httpsPort?: number;
  readonly networkInterfaces: DesktopNetworkInterfaces;
  readonly advertisedHostOverride?: string;
}): ResolvedDesktopServerExposure => {
  const localHttpUrl = `http://${DESKTOP_LOOPBACK_HOST}:${input.port}`;
  const localWsUrl = `ws://${DESKTOP_LOOPBACK_HOST}:${input.port}`;
  const localHttpsUrl =
    !input.httpsEnabled || input.httpsPort === undefined
      ? null
      : `https://${DESKTOP_LOOPBACK_HOST}:${input.httpsPort}`;

  if (input.mode === "local-only") {
    return {
      mode: input.mode,
      httpsEnabled: input.httpsEnabled,
      bindHost: DESKTOP_LOOPBACK_HOST,
      localHttpUrl,
      localWsUrl,
      localHttpsUrl,
      endpointUrl: null,
      httpsEndpointUrl: null,
      advertisedHost: null,
    };
  }

  const advertisedHost = resolveLanAdvertisedHost(
    input.networkInterfaces,
    input.advertisedHostOverride,
  );

  return {
    mode: input.mode,
    httpsEnabled: input.httpsEnabled,
    bindHost: DESKTOP_LAN_BIND_HOST,
    localHttpUrl,
    localWsUrl,
    localHttpsUrl,
    endpointUrl: advertisedHost ? `http://${advertisedHost}:${input.port}` : null,
    httpsEndpointUrl:
      input.httpsEnabled && advertisedHost && input.httpsPort !== undefined
        ? `https://${advertisedHost}:${input.httpsPort}`
        : null,
    advertisedHost,
  };
};

const createDesktopEndpoint = (
  input: Omit<CreateAdvertisedEndpointInput, "provider" | "source">,
): AdvertisedEndpoint =>
  createAdvertisedEndpoint({
    ...input,
    provider: DESKTOP_CORE_ENDPOINT_PROVIDER,
    source: "desktop-core",
  });

const createManualEndpoint = (
  input: Omit<CreateAdvertisedEndpointInput, "provider" | "source">,
): AdvertisedEndpoint =>
  createAdvertisedEndpoint({
    ...input,
    provider: DESKTOP_MANUAL_ENDPOINT_PROVIDER,
    source: "user",
  });

const resolveDesktopCoreAdvertisedEndpoints = (
  input: DesktopAdvertisedEndpointInput,
): readonly AdvertisedEndpoint[] => {
  const localBaseUrl = input.exposure.localHttpsUrl ?? input.exposure.localHttpUrl;
  const lanBaseUrl = input.exposure.httpsEndpointUrl ?? input.exposure.endpointUrl;
  const endpoints: AdvertisedEndpoint[] = [
    createDesktopEndpoint({
      id: `desktop-loopback:${localBaseUrl}`,
      label: "This machine",
      httpBaseUrl: localBaseUrl,
      reachability: "loopback",
      status: "available",
      isDefault: lanBaseUrl === null,
      description: "Loopback endpoint for this desktop app.",
    }),
  ];

  if (lanBaseUrl) {
    endpoints.push(
      createDesktopEndpoint({
        id: `desktop-lan:${lanBaseUrl}`,
        label: "Local network",
        httpBaseUrl: lanBaseUrl,
        reachability: "lan",
        status: "available",
        isDefault: true,
        description: "Reachable from devices on the same network.",
      }),
    );
  }

  for (const customEndpointUrl of input.customHttpsEndpointUrls ?? []) {
    try {
      endpoints.push(
        createManualEndpoint({
          id: `manual:${customEndpointUrl}`,
          label: isHttpsEndpointUrl(customEndpointUrl) ? "Custom HTTPS" : "Custom endpoint",
          httpBaseUrl: customEndpointUrl,
          reachability: "public",
          status: "unknown",
          description: isHttpsEndpointUrl(customEndpointUrl)
            ? "User-configured HTTPS endpoint for this desktop backend."
            : "User-configured endpoint for this desktop backend.",
        }),
      );
    } catch {
      // Ignore malformed user-configured endpoints without dropping valid endpoints.
    }
  }

  return endpoints;
};

type DesktopServerExposurePersistenceOperation = "server-exposure-mode" | "server-https-enabled";

export class DesktopServerExposureNoNetworkAddressError extends Data.TaggedError(
  "DesktopServerExposureNoNetworkAddressError",
)<{
  readonly port: number;
}> {
  override get message() {
    return `No reachable network address is available for desktop network access on port ${this.port}.`;
  }
}

export class DesktopServerExposurePersistenceError extends Data.TaggedError(
  "DesktopServerExposurePersistenceError",
)<{
  readonly operation: DesktopServerExposurePersistenceOperation;
  readonly cause: DesktopAppSettingsService.DesktopSettingsWriteError;
}> {
  override get message() {
    return `Failed to persist desktop ${this.operation} settings.`;
  }
}

export type DesktopServerExposureSetModeError =
  | DesktopServerExposureNoNetworkAddressError
  | DesktopServerExposurePersistenceError;

export type DesktopServerExposureError = DesktopServerExposureSetModeError;

export interface DesktopServerExposureBackendConfig {
  readonly port: number;
  readonly httpsPort: number | undefined;
  readonly bindHost: string;
  readonly httpBaseUrl: URL;
  readonly httpsBaseUrl: URL | undefined;
}

export interface DesktopServerExposureChange {
  readonly state: DesktopServerExposureState;
  readonly requiresRelaunch: boolean;
}

export interface DesktopServerExposureShape {
  readonly getState: Effect.Effect<DesktopServerExposureState>;
  readonly backendConfig: Effect.Effect<DesktopServerExposureBackendConfig>;
  readonly configureFromSettings: (input: {
    readonly port: number;
    readonly httpsPort?: number;
  }) => Effect.Effect<DesktopServerExposureState>;
  readonly setMode: (
    mode: DesktopServerExposureMode,
  ) => Effect.Effect<DesktopServerExposureChange, DesktopServerExposureSetModeError>;
  readonly setHttpsEnabled: (
    enabled: boolean,
  ) => Effect.Effect<DesktopServerExposureChange, DesktopServerExposureSetModeError>;
  readonly getAdvertisedEndpoints: Effect.Effect<readonly AdvertisedEndpoint[]>;
}

export class DesktopServerExposure extends Context.Service<
  DesktopServerExposure,
  DesktopServerExposureShape
>()("cafecode/desktop/ServerExposure") {}

export interface DesktopNetworkInterfacesServiceShape {
  readonly read: Effect.Effect<DesktopNetworkInterfaces>;
}

export class DesktopNetworkInterfacesService extends Context.Service<
  DesktopNetworkInterfacesService,
  DesktopNetworkInterfacesServiceShape
>()("cafecode/desktop/ServerExposure/NetworkInterfaces") {}

interface RuntimeState {
  readonly requestedMode: DesktopServerExposureMode;
  readonly mode: DesktopServerExposureMode;
  readonly httpsEnabled: boolean;
  readonly port: number;
  readonly httpsPort: number | undefined;
  readonly bindHost: string;
  readonly localHttpUrl: string;
  readonly localWsUrl: string;
  readonly localHttpsUrl: Option.Option<string>;
  readonly httpBaseUrl: URL;
  readonly httpsBaseUrl: Option.Option<URL>;
  readonly endpointUrl: Option.Option<string>;
  readonly httpsEndpointUrl: Option.Option<string>;
  readonly advertisedHost: Option.Option<string>;
}

interface ResolvedRuntimeState {
  readonly state: RuntimeState;
  readonly unavailable: boolean;
}

const initialRuntimeState = (): RuntimeState =>
  runtimeStateFromResolvedExposure({
    requestedMode: DEFAULT_DESKTOP_SETTINGS.serverExposureMode,
    settings: DEFAULT_DESKTOP_SETTINGS,
    exposure: resolveDesktopServerExposure({
      mode: DEFAULT_DESKTOP_SETTINGS.serverExposureMode,
      httpsEnabled: DEFAULT_DESKTOP_SETTINGS.serverHttpsEnabled,
      port: 0,
      networkInterfaces: {},
    }),
    port: 0,
    httpsPort: undefined,
  });

const toContractState = (state: RuntimeState): DesktopServerExposureState => ({
  mode: state.mode,
  httpsEnabled: state.httpsEnabled,
  endpointUrl: Option.getOrNull(state.endpointUrl),
  advertisedHost: Option.getOrNull(state.advertisedHost),
});

const toBackendConfig = (state: RuntimeState): DesktopServerExposureBackendConfig => ({
  port: state.port,
  httpsPort: state.httpsEnabled ? state.httpsPort : undefined,
  bindHost: state.bindHost,
  httpBaseUrl: state.httpBaseUrl,
  httpsBaseUrl: Option.getOrUndefined(state.httpsBaseUrl),
});

const toResolvedExposure = (state: RuntimeState): ResolvedDesktopServerExposure => ({
  mode: state.mode,
  httpsEnabled: state.httpsEnabled,
  bindHost: state.bindHost,
  localHttpUrl: state.localHttpUrl,
  localWsUrl: state.localWsUrl,
  localHttpsUrl: Option.getOrNull(state.localHttpsUrl),
  endpointUrl: Option.getOrNull(state.endpointUrl),
  httpsEndpointUrl: Option.getOrNull(state.httpsEndpointUrl),
  advertisedHost: Option.getOrNull(state.advertisedHost),
});

function runtimeStateFromResolvedExposure(input: {
  readonly requestedMode: DesktopServerExposureMode;
  readonly settings: DesktopSettings;
  readonly exposure: ResolvedDesktopServerExposure;
  readonly port: number;
  readonly httpsPort: number | undefined;
}): RuntimeState {
  const localHttpsUrl = Option.fromNullishOr(input.exposure.localHttpsUrl);
  return {
    requestedMode: input.requestedMode,
    mode: input.exposure.mode,
    httpsEnabled: input.exposure.httpsEnabled,
    port: input.port,
    httpsPort: input.httpsPort,
    bindHost: input.exposure.bindHost,
    localHttpUrl: input.exposure.localHttpUrl,
    localWsUrl: input.exposure.localWsUrl,
    localHttpsUrl,
    httpBaseUrl: new URL(input.exposure.localHttpUrl),
    httpsBaseUrl: Option.map(localHttpsUrl, (value) => new URL(value)),
    endpointUrl: Option.fromNullishOr(input.exposure.endpointUrl),
    httpsEndpointUrl: Option.fromNullishOr(input.exposure.httpsEndpointUrl),
    advertisedHost: Option.fromNullishOr(input.exposure.advertisedHost),
  };
}

function resolveRuntimeState(input: {
  readonly requestedMode: DesktopServerExposureMode;
  readonly httpsEnabled: boolean;
  readonly settings: DesktopSettings;
  readonly port: number;
  readonly httpsPort: number | undefined;
  readonly networkInterfaces: DesktopNetworkInterfaces;
  readonly advertisedHostOverride: Option.Option<string>;
}): ResolvedRuntimeState {
  const advertisedHostOverride = Option.getOrUndefined(input.advertisedHostOverride);
  const requestedExposure = resolveDesktopServerExposure({
    mode: input.requestedMode,
    httpsEnabled: input.httpsEnabled,
    port: input.port,
    ...(input.httpsPort === undefined ? {} : { httpsPort: input.httpsPort }),
    networkInterfaces: input.networkInterfaces,
    ...(advertisedHostOverride ? { advertisedHostOverride } : {}),
  });
  const unavailable =
    input.requestedMode === "network-accessible" && requestedExposure.endpointUrl === null;
  const exposure = unavailable
    ? resolveDesktopServerExposure({
        mode: "local-only",
        httpsEnabled: input.httpsEnabled,
        port: input.port,
        ...(input.httpsPort === undefined ? {} : { httpsPort: input.httpsPort }),
        networkInterfaces: input.networkInterfaces,
        ...(advertisedHostOverride ? { advertisedHostOverride } : {}),
      })
    : requestedExposure;

  return {
    state: runtimeStateFromResolvedExposure({
      requestedMode: input.requestedMode,
      settings: input.settings,
      exposure,
      port: input.port,
      httpsPort: input.httpsPort,
    }),
    unavailable,
  };
}

const requiresBackendRelaunch = (previous: RuntimeState, next: RuntimeState): boolean =>
  previous.port !== next.port ||
  previous.httpsPort !== next.httpsPort ||
  previous.httpsEnabled !== next.httpsEnabled ||
  previous.bindHost !== next.bindHost ||
  previous.localHttpUrl !== next.localHttpUrl ||
  Option.getOrNull(previous.localHttpsUrl) !== Option.getOrNull(next.localHttpsUrl);

const make = Effect.gen(function* () {
  const config = yield* DesktopConfig.DesktopConfig;
  const networkInterfaces = yield* DesktopNetworkInterfacesService;
  const desktopSettings = yield* DesktopAppSettingsService.DesktopAppSettings;
  const stateRef = yield* Ref.make(initialRuntimeState());

  const readNetworkInterfaces = networkInterfaces.read;

  const getState = Ref.get(stateRef).pipe(Effect.map(toContractState));
  const backendConfig = Ref.get(stateRef).pipe(Effect.map(toBackendConfig));

  const configureFromSettings = Effect.fn("desktop.serverExposure.configureFromSettings")(
    function* ({ port, httpsPort }: { readonly port: number; readonly httpsPort?: number }) {
      yield* Effect.annotateCurrentSpan({ port, httpsPort });
      const settings = yield* desktopSettings.get;
      const currentNetworkInterfaces = yield* readNetworkInterfaces;
      const resolved = resolveRuntimeState({
        requestedMode: settings.serverExposureMode,
        httpsEnabled: settings.serverHttpsEnabled,
        settings,
        port,
        httpsPort,
        networkInterfaces: currentNetworkInterfaces,
        advertisedHostOverride: config.desktopLanHostOverride,
      });
      yield* Ref.set(stateRef, resolved.state);
      return toContractState(resolved.state);
    },
  );

  const setMode = Effect.fn("desktop.serverExposure.setMode")(function* (
    mode: DesktopServerExposureMode,
  ) {
    yield* Effect.annotateCurrentSpan({ mode });
    const previous = yield* Ref.get(stateRef);
    const currentSettings = yield* desktopSettings.get;
    const nextSettings = {
      ...currentSettings,
      serverExposureMode: mode,
    };
    const currentNetworkInterfaces = yield* readNetworkInterfaces;
    const resolved = resolveRuntimeState({
      requestedMode: mode,
      settings: nextSettings,
      port: previous.port,
      httpsPort: previous.httpsPort,
      httpsEnabled: nextSettings.serverHttpsEnabled,
      networkInterfaces: currentNetworkInterfaces,
      advertisedHostOverride: config.desktopLanHostOverride,
    });

    if (resolved.unavailable) {
      return yield* new DesktopServerExposureNoNetworkAddressError({ port: previous.port });
    }

    const change = yield* desktopSettings.setServerExposureMode(mode).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopServerExposurePersistenceError({
            operation: "server-exposure-mode",
            cause,
          }),
      ),
    );

    yield* Ref.set(stateRef, resolved.state);
    return {
      state: toContractState(resolved.state),
      requiresRelaunch: change.changed || requiresBackendRelaunch(previous, resolved.state),
    };
  });

  const setHttpsEnabled = Effect.fn("desktop.serverExposure.setHttpsEnabled")(function* (
    enabled: boolean,
  ) {
    yield* Effect.annotateCurrentSpan({ enabled });
    const previous = yield* Ref.get(stateRef);
    const currentSettings = yield* desktopSettings.get;
    const nextSettings = {
      ...currentSettings,
      serverHttpsEnabled: enabled,
    };
    const currentNetworkInterfaces = yield* readNetworkInterfaces;
    const resolved = resolveRuntimeState({
      requestedMode: nextSettings.serverExposureMode,
      httpsEnabled: enabled,
      settings: nextSettings,
      port: previous.port,
      httpsPort: previous.httpsPort,
      networkInterfaces: currentNetworkInterfaces,
      advertisedHostOverride: config.desktopLanHostOverride,
    });

    const change = yield* desktopSettings.setServerHttpsEnabled(enabled).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopServerExposurePersistenceError({
            operation: "server-https-enabled",
            cause,
          }),
      ),
    );

    yield* Ref.set(stateRef, resolved.state);
    return {
      state: toContractState(resolved.state),
      requiresRelaunch: change.changed || requiresBackendRelaunch(previous, resolved.state),
    };
  });

  const getAdvertisedEndpoints = Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    return resolveDesktopCoreAdvertisedEndpoints({
      exposure: toResolvedExposure(state),
      customHttpsEndpointUrls: config.desktopHttpsEndpointUrls,
    });
  }).pipe(Effect.withSpan("desktop.serverExposure.getAdvertisedEndpoints"));

  return DesktopServerExposure.of({
    getState,
    backendConfig,
    configureFromSettings,
    setMode,
    setHttpsEnabled,
    getAdvertisedEndpoints,
  });
});

export const layer = Layer.effect(DesktopServerExposure, make);

export const networkInterfacesLayer = Layer.succeed(
  DesktopNetworkInterfacesService,
  DesktopNetworkInterfacesService.of({
    read: Effect.sync(() => NodeOS.networkInterfaces()),
  }),
);
