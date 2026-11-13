import type { EnvironmentId, RelayNetworkSettings, ServerSettings } from "@cafecode/contracts";
import { canonicalBytes, Id32, readCanonical } from "@cafecode/relay/protocol";
import {
  restoreIdentity,
  createIdentity,
  privateIdentityBytes,
  type RelayIdentity,
} from "@cafecode/relay/crypto";
import { NetworkDescriptor, relayHttpEndpoint, verifyNetwork } from "@cafecode/relay/descriptor";
import { createInvitationUrl } from "@cafecode/relay/invitation";
import { RelayHost } from "@cafecode/relay/host";
import { NativeHostWorkClient, type HostWorkTls } from "@cafecode/relay/nativeHostWork";
import { serveRelayedHttp, HttpOpen, relativeAppPath } from "@cafecode/relay/http";
import { relayRpcProtocol } from "@cafecode/relay/rpc";
import { connectNative } from "@cafecode/relay/nativeWire";
import { unopaqueBounded } from "@cafecode/relay/bytes";
import { RelayError } from "@cafecode/relay/errors";
import type { RelayStream, SessionAuthResult } from "@cafecode/relay/session";
import type { RelayDial } from "@cafecode/relay/client";
import type { RelayNode } from "@cafecode/relay/descriptor";
import { Lifetime } from "@cafecode/relay/lifetime";
import { discoverNetwork } from "@cafecode/relay/discovery";
import { CAFE_RELAY_NETWORK } from "@cafecode/relay/cafeNetwork";
import { selfServiceHostLocator } from "@cafecode/relay/admission";
import { RelayHostController } from "./hostController.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as Stream from "effect/Stream";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type * as HttpServerError from "effect/unstable/http/HttpServerError";
import { AuthError } from "../auth/Services/ServerAuth.ts";
import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { makeRelayAuth } from "./auth.ts";
import {
  readRelayPrivate,
  createRelayPrivate,
  ensureRelayPrivateDirectory,
} from "./privateFiles.ts";
import { RelayServerRequest, relayEffectSocket } from "./request.ts";
import { RelayRequestContext } from "./requestContext.ts";

export const RelayHostConfig = Schema.Struct({
  version: Schema.Literal(1),
  networks: Schema.Array(
    Schema.Struct({
      descriptor: NetworkDescriptor,
      viewerOrigin: Schema.String.check(Schema.isMaxLength(256)),
      locator: Id32,
      credentials: Schema.Array(
        Schema.Struct({
          nodeId: Id32,
          token: Schema.NullOr(Id32),
          admissionPrivateKey: Schema.String.check(Schema.isMaxLength(172)),
        }),
      ).check(Schema.isMaxLength(16)),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
});
type Handler = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  HttpServerError.HttpServerError,
  Scope.Scope | HttpServerRequest.HttpServerRequest
>;
interface RuntimeShape {
  readonly setEnabled: (enabled: boolean) => Effect.Effect<void, RelayError>;
  readonly setNetworks: (
    networks: readonly RelayNetworkSettings[],
  ) => Effect.Effect<void, RelayError>;
  readonly start: (handler: Handler) => Effect.Effect<void, never, Scope.Scope>;
  readonly status: Effect.Effect<{
    readonly enabled: boolean;
    readonly phase?: string;
    readonly configured?: boolean;
    readonly networks: readonly { readonly networkId: string; readonly serving: number }[];
  }>;
  readonly invitation: (
    networkId: string,
    role: "client" | "owner",
  ) => Effect.Effect<
    { readonly id: string; readonly url: string; readonly expiresAt: number },
    RelayError
  >;
  readonly revokeInvitation: (id: string) => Effect.Effect<boolean, RelayError>;
}
export class RelayRuntime extends Context.Service<RelayRuntime, RuntimeShape>()(
  "cafecode/relay/RelayRuntime",
) {}

/** Scoped native connector. Tests trust only their exact fixture CA, keeping
 * the default connector, global TLS policy, URL and host identity pin intact. */
export interface RelayRuntimeIOShape {
  readonly dial: RelayDial;
  readonly measureLatency?: (node: RelayNode, lifetime: Lifetime) => Promise<number>;
  readonly onHostStarted?: (networkId: string, serving: number) => void;
  readonly hostWorkTls?: HostWorkTls;
  readonly defaultNetwork?: RelayNetworkSettings;
  readonly fetchNetwork?: typeof globalThis.fetch;
}
export class RelayRuntimeIO extends Context.Service<RelayRuntimeIO, RelayRuntimeIOShape>()(
  "cafecode/relay/RelayRuntimeIO",
) {}

/** Enumerated application surface; every native/control and unknown route denies. */
export function isRelayAppRoute(method: string, path: string, rpc = false): boolean {
  const url = relativeAppPath(path),
    pathname = url.pathname;
  if (rpc)
    return (
      method === "GET" &&
      pathname === "/ws" &&
      [...url.searchParams.keys()].every((key) => key === "wsToken")
    );
  if (
    (method === "GET" || method === "HEAD") &&
    (pathname === "/.well-known/cafe-code/environment" ||
      pathname === "/api/project-favicon" ||
      pathname === "/api/chat-images" ||
      /^\/api\/branding\/app-icon\/v1\/[^/]+\/[^/]+\.png$/.test(pathname) ||
      /^\/api\/branding\/sidebar-image\/[^/]+$/.test(pathname) ||
      /^\/api\/visualizations\/poster\/[^/]+\/[^/]+$/.test(pathname) ||
      /^\/attachments\/[^/]+$/.test(pathname))
  )
    return true;
  if (
    (method === "GET" || method === "POST") &&
    /^\/api\/attachments(?:\/[^/]+(?:\/(?:retain|discard))?)?$/.test(pathname)
  )
    return true;
  if (pathname === "/api/branding/sidebar-image" && method === "POST") return true;
  const authRoutes = new Set([
    "GET /api/auth/session",
    "POST /api/auth/ws-token",
    "POST /api/auth/pairing-token",
    "GET /api/auth/admin-password",
    "POST /api/auth/admin-password",
    "POST /api/auth/admin-password/clear",
    "GET /api/auth/pairing-links",
    "POST /api/auth/pairing-links/revoke",
    "GET /api/auth/clients",
    "POST /api/auth/clients/revoke",
    "POST /api/auth/clients/revoke-others",
    "GET /api/auth/two-factor",
    "POST /api/auth/two-factor/setup",
    "POST /api/auth/two-factor/enable",
    "POST /api/auth/two-factor/disable",
    "GET /api/relay",
    "POST /api/relay",
    "POST /api/relay/networks",
    "POST /api/relay/invitations",
    "POST /api/relay/invitations/revoke",
    "POST /api/client-debug-log",
    "POST /api/observability/v1/traces",
    "GET /api/notifications/web-push/public-key",
    "POST /api/notifications/web-push/subscriptions",
    "POST /api/notifications/web-push/subscriptions/locale",
    "POST /api/notifications/web-push/unsubscribe",
  ]);
  return authRoutes.has(method + " " + pathname);
}

export const makeRelayRuntime = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const environment = yield* ServerEnvironment;
  const relayAuth = yield* makeRelayAuth;
  const services = yield* Effect.context<never>();
  const runtimeScope = yield* Scope.Scope;
  const connector = yield* Effect.serviceOption(RelayRuntimeIO);
  const hostWork = new NativeHostWorkClient(
    Option.isSome(connector) ? connector.value.hostWorkTls : undefined,
  );
  const runWith = Effect.runPromiseWith(services);
  const run = async <A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal): Promise<A> => {
    const result = await runWith(Effect.result(effect), signal ? { signal } : undefined);
    if (Result.isFailure(result))
      throw result.failure instanceof RelayError ? result.failure : new RelayError("UNAVAILABLE");
    return result.success;
  };
  let active = true,
    handler: Handler | undefined;
  let handlerServices = services;
  type HostEntry = {
    readonly host: RelayHost;
    readonly descriptor: NetworkDescriptor;
    readonly identity: RelayIdentity;
    readonly origin: string;
    readonly locator: string;
    readonly environmentId: EnvironmentId;
  };
  const raw = yield* Effect.tryPromise({
    try: () => readRelayPrivate(config.stateDir, "config.json", 32_768),
    catch: () => new RelayError("UNAVAILABLE"),
  });
  const parsed = raw ? readCanonical(RelayHostConfig, raw, 32_768) : undefined;
  const settings = yield* ServerSettingsService;
  let desiredEnabled = parsed !== undefined;
  let selectedNetworks: readonly RelayNetworkSettings[] = [];
  let preferenceRevision = 0,
    savedRevision = 0;
  let saving: Promise<void> | undefined;
  let observedSettings = "";
  const create = async (lifetime: Lifetime): Promise<HostEntry[]> => {
    const hosts: HostEntry[] = [];
    try {
      return await run(
        Effect.gen(function* () {
          const current = () => {
            if (!active || !lifetime.active) throw new RelayError("UNAVAILABLE");
          };
          current();
          let entries = selectedNetworks.length ? undefined : parsed?.networks;
          if (!entries) {
            const networks = selectedNetworks.length
              ? selectedNetworks
              : [
                  Option.isSome(connector) && connector.value.defaultNetwork
                    ? connector.value.defaultNetwork
                    : { label: "Cafe relays", ...CAFE_RELAY_NETWORK },
                ];
            const defaults: (typeof RelayHostConfig.Type.networks)[number][] = [];
            for (const selected of networks) {
              current();
              const descriptor = yield* Effect.tryPromise({
                try: () =>
                  discoverNetwork({
                    bootstrapUrls: selected.bootstrapUrls,
                    rootPublicKey: selected.rootPublicKey,
                    minimumRevision: selected.minimumRevision,
                    lifetime,
                    ...(Option.isSome(connector) && connector.value.fetchNetwork
                      ? { fetcher: connector.value.fetchNetwork }
                      : {}),
                  }),
                catch: () => new RelayError("UNAVAILABLE"),
              });
              current();
              yield* Effect.tryPromise({
                try: () => ensureRelayPrivateDirectory(config.stateDir),
                catch: () => new RelayError("UNAVAILABLE"),
              });
              current();
              const key = `host-admission-${descriptor.networkId}.key` as const;
              const saved = yield* Effect.tryPromise({
                try: () => readRelayPrivate(config.stateDir, key, 128),
                catch: () => new RelayError("UNAVAILABLE"),
              });
              current();
              const identity = yield* Effect.tryPromise({
                try: () => (saved ? Promise.resolve(restoreIdentity(saved)) : createIdentity()),
                catch: () => new RelayError("CRYPTO_FAILURE"),
              });
              current();
              if (!saved)
                yield* Effect.tryPromise({
                  try: () =>
                    createRelayPrivate(config.stateDir, key, privateIdentityBytes(identity)),
                  catch: () => new RelayError("UNAVAILABLE"),
                });
              current();
              defaults.push({
                descriptor,
                viewerOrigin: selected.viewerOrigin,
                locator: selfServiceHostLocator(descriptor.networkId, identity.publicKey),
                credentials: descriptor.nodes.map((node) => ({
                  nodeId: node.id,
                  token: null,
                  admissionPrivateKey: Buffer.from(privateIdentityBytes(identity)).toString(
                    "base64url",
                  ),
                })),
              });
            }
            entries = defaults;
          }
          const seen = new Set<string>();
          for (const entry of entries) {
            current();
            if (seen.has(entry.descriptor.networkId))
              return yield* new RelayError("NETWORK_MISMATCH");
            seen.add(entry.descriptor.networkId);
            const now = yield* Clock.currentTimeMillis;
            const descriptor = yield* Effect.tryPromise({
              try: () =>
                verifyNetwork(canonicalBytes(entry.descriptor), {
                  rootPublicKey: entry.descriptor.rootPublicKey,
                  now,
                }),
              catch: () => new RelayError("NETWORK_MISMATCH"),
            });
            current();
            const keyName = `host-${descriptor.networkId}.key` as const;
            const saved = yield* Effect.tryPromise({
              try: () => readRelayPrivate(config.stateDir, keyName, 128),
              catch: () => new RelayError("UNAVAILABLE"),
            });
            current();
            const identity = yield* Effect.tryPromise({
              try: () => (saved ? Promise.resolve(restoreIdentity(saved)) : createIdentity()),
              catch: () => new RelayError("CRYPTO_FAILURE"),
            });
            current();
            if (!saved)
              yield* Effect.tryPromise({
                try: () =>
                  createRelayPrivate(config.stateDir, keyName, privateIdentityBytes(identity)),
                catch: () => new RelayError("UNAVAILABLE"),
              });
            current();
            const environmentId = yield* environment.getEnvironmentId;
            current();
            const scope = {
              networkId: descriptor.networkId,
              hostKey: identity.publicKey,
              environmentId,
            };
            const resume = (auth: SessionAuthResult, deviceKey: string) =>
              run(
                relayAuth.authenticate(
                  { ...scope, deviceKey },
                  { environmentId, operation: "resume", credential: auth.bearerToken },
                ),
              );
            const host = new RelayHost({
              network: descriptor,
              work: hostWork,
              identity,
              credentials: entry.credentials.map((credential) => ({
                nodeId: credential.nodeId,
                locator: entry.locator,
                token: credential.token,
                admissionIdentity: restoreIdentity(
                  unopaqueBounded(credential.admissionPrivateKey, 128),
                ),
              })),
              dial: Option.isSome(connector)
                ? connector.value.dial
                : (node, resources) => connectNative(node.url, resources),
              ...(Option.isSome(connector) && connector.value.measureLatency
                ? { measureLatency: connector.value.measureLatency }
                : {}),
              handlers: {
                authenticate: async (auth, deviceKey) => {
                  if (!active || !lifetime.active) throw new RelayError("UNAVAILABLE");
                  const result = await run(relayAuth.authenticate({ ...scope, deviceKey }, auth));
                  if (!active || !lifetime.active) throw new RelayError("UNAVAILABLE");
                  return result.result;
                },
                validate: async (auth, deviceKey) => {
                  await resume(auth, deviceKey);
                  if (!active || !lifetime.active) throw new RelayError("UNAVAILABLE");
                },
                open: async (stream: RelayStream, metadata) => {
                  if (!active || !lifetime.active || !handler || !stream.owner.auth)
                    throw new RelayError("AUTH_REQUIRED");
                  const ownedHandler = handler,
                    authenticated = await resume(stream.owner.auth, stream.owner.remotePublicKey);
                  if (!active || !lifetime.active || !stream.active)
                    throw new RelayError("UNAVAILABLE");
                  const validate = relayAuth
                    .validateBinding(
                      { ...scope, deviceKey: stream.owner.remotePublicKey },
                      authenticated.session,
                    )
                    .pipe(
                      Effect.mapError(
                        () => new AuthError({ message: "Unauthorized request.", status: 401 }),
                      ),
                      Effect.tap(() =>
                        active && lifetime.active && stream.active
                          ? Effect.void
                          : Effect.fail(
                              new AuthError({ message: "Unauthorized request.", status: 401 }),
                            ),
                      ),
                    );
                  const requestContext = { sessionId: authenticated.session.sessionId, validate };
                  const requestScope = await run(Scope.make());
                  const handle = (
                    request: Request,
                    upgrade?: HttpServerRequest.HttpServerRequest["upgrade"],
                  ) =>
                    run(
                      ownedHandler.pipe(
                        Effect.provideService(
                          HttpServerRequest.HttpServerRequest,
                          new RelayServerRequest(HttpServerRequest.fromWeb(request), upgrade),
                        ),
                        Effect.provideService(RelayRequestContext, requestContext),
                        Scope.provide(requestScope),
                      ),
                      stream.signal,
                    );
                  try {
                    if (stream.kind === "rpc") {
                      const open = readCanonical(HttpOpen, canonicalBytes(metadata));
                      if (!isRelayAppRoute(open.method, open.path, true))
                        throw new RelayError("PROTOCOL_ERROR");
                      const protocol = relayRpcProtocol(open.headers);
                      const socket = relayEffectSocket(stream, protocol).pipe(
                        Effect.tap(() =>
                          Effect.tryPromise({
                            try: () => stream.accept({ protocol }),
                            catch: () => new RelayError("UNAVAILABLE"),
                          }).pipe(Effect.orDie),
                        ),
                      );
                      await handle(
                        new Request("https://relay.cafecode.invalid" + open.path, {
                          headers: { authorization: "Bearer " + stream.owner.auth.bearerToken },
                          signal: stream.signal,
                        }),
                        socket,
                      );
                      stream.retire();
                    } else
                      await serveRelayedHttp(stream, metadata, async (request) => {
                        if (
                          !isRelayAppRoute(
                            request.method,
                            new URL(request.url).pathname + new URL(request.url).search,
                          )
                        )
                          throw new RelayError("PROTOCOL_ERROR");
                        const response = await handle(request);
                        return HttpServerResponse.toWeb(response, { context: handlerServices });
                      });
                  } finally {
                    await run(Scope.close(requestScope, Exit.void));
                  }
                },
              },
            });
            hosts.push({
              host,
              descriptor,
              identity,
              origin: entry.viewerOrigin,
              locator: entry.locator,
              environmentId,
            });
          }

          return hosts;
        }),
      );
    } catch (error) {
      for (const entry of hosts) entry.host.retire();
      await Promise.allSettled(hosts.map((entry) => entry.host.close()));
      throw error;
    }
  };
  const controller = new RelayHostController(create, (entry) => {
    if (active && Option.isSome(connector))
      connector.value.onHostStarted?.(
        entry.descriptor.networkId,
        entry.host.stats().servingNodes.length,
      );
  });
  const applySettings = (value: ServerSettings) => {
    const signature = JSON.stringify([value.relayEnabled, value.relayNetworks]);
    if (signature === observedSettings) return;
    observedSettings = signature;
    if (saving) return;
    const networksChanged =
      JSON.stringify(selectedNetworks) !== JSON.stringify(value.relayNetworks);
    selectedNetworks = value.relayNetworks;
    desiredEnabled = value.relayEnabled ?? parsed !== undefined;
    controller.request(desiredEnabled, true, networksChanged);
  };
  {
    applySettings(yield* settings.getSettings);
    yield* Stream.runForEach(settings.streamChanges, (value) =>
      Effect.sync(() => applySettings(value)),
    ).pipe(Effect.forkIn(runtimeScope));
  }
  const savePreferences = () => {
    if (saving) return saving;
    const job = (async () => {
      // Finalization joins the latest admitted preference as well as the held
      // write. Retirement prevents hosting, but must not discard an Off queued
      // behind an older in-flight On write.
      while (savedRevision !== preferenceRevision) {
        const revision = preferenceRevision;
        await run(
          settings.updateSettingsWith(() =>
            Effect.sync(() => ({
              relayEnabled: desiredEnabled,
              relayNetworks: [...selectedNetworks],
            })),
          ),
        );
        if (revision === preferenceRevision) {
          savedRevision = revision;
          if (active) controller.request(desiredEnabled, true);
        }
      }
    })();
    saving = job;
    void job
      .finally(() => {
        if (saving === job) saving = undefined;
      })
      .catch(() => {});
    return job;
  };
  let closing: Promise<void> | undefined;
  const close = () => {
    active = false;
    const stopping = controller.close();
    return (closing ??= Promise.allSettled([stopping, saving]).then(() => hostWork.close()));
  };
  yield* Effect.addFinalizer(() => Effect.promise(close));
  const status = Effect.sync(() => ({
    enabled: controller.enabled,
    configured: true,
    phase: controller.phase,
    networkSettings: selectedNetworks,
    networks: controller.entries.map((entry) => ({
      networkId: entry.descriptor.networkId,
      serving: entry.host.active ? entry.host.stats().servingNodes.length : 0,
    })),
  }));
  const invitation: RuntimeShape["invitation"] = (networkId, role) =>
    Effect.gen(function* () {
      const entry = controller.entries.find((value) => value.descriptor.networkId === networkId);
      if (!entry || !active || !controller.enabled || !handler)
        return yield* new RelayError("UNAVAILABLE");
      const current = () =>
        active && controller.enabled && entry.host.active && controller.entries.includes(entry);
      const ticket = yield* Effect.tryPromise({
        try: () => entry.host.invitationTicket(),
        catch: () => new RelayError("UNAVAILABLE"),
      });
      if (!current()) return yield* new RelayError("UNAVAILABLE");
      const issued = yield* relayAuth.issue({
        networkId,
        hostKey: entry.identity.publicKey,
        environmentId: entry.environmentId,
        role,
      });
      if (!current()) {
        yield* relayAuth.revoke(issued.id);
        return yield* new RelayError("UNAVAILABLE");
      }
      const now = yield* Clock.currentTimeMillis;
      const url = yield* Effect.try({
        try: () =>
          createInvitationUrl(
            entry.origin,
            {
              version: 1,
              networkId,
              networkRootPublicKey: entry.descriptor.rootPublicKey,
              minimumRevision: entry.descriptor.revision,
              bootstrapUrls: entry.descriptor.nodes
                .slice(0, 3)
                .map((node) => relayHttpEndpoint(node, "/v1/network")),
              hostPublicKey: entry.identity.publicKey,
              environmentId: entry.environmentId,
              locator: entry.locator,
              nodeId: ticket.node.id,
              registrationId: ticket.registrationId,
              inviteTicket: ticket.token,
              pairingSecret: issued.secret,
              expiresAt: Math.min(issued.expiresAt, ticket.expiresAt),
            },
            now,
          ),
        catch: () => new RelayError("PROTOCOL_ERROR"),
      });
      return { id: issued.id, url, expiresAt: Math.min(issued.expiresAt, ticket.expiresAt) };
    });
  return {
    status,
    setEnabled: (enabled) =>
      Effect.tryPromise({
        try: () => {
          if (!active) throw new RelayError("UNAVAILABLE");
          desiredEnabled = enabled;
          preferenceRevision++;
          controller.request(enabled, false);
          return savePreferences();
        },
        catch: () => new RelayError("UNAVAILABLE"),
      }),
    setNetworks: (networks) =>
      Effect.tryPromise({
        try: () => {
          if (!active) throw new RelayError("UNAVAILABLE");
          for (const network of networks) {
            if (
              new URL(network.viewerOrigin).origin !== network.viewerOrigin ||
              new URL(network.viewerOrigin).protocol !== "https:"
            )
              throw new RelayError("PROTOCOL_ERROR");
            for (const endpoint of network.bootstrapUrls) {
              const url = new URL(endpoint);
              if (
                url.protocol !== "https:" ||
                url.username ||
                url.password ||
                url.search ||
                url.hash ||
                url.pathname !== "/v1/network"
              )
                throw new RelayError("PROTOCOL_ERROR");
            }
          }
          if (new Set(networks.map((network) => network.rootPublicKey)).size !== networks.length)
            throw new RelayError("PROTOCOL_ERROR");
          selectedNetworks = networks.length
            ? networks
            : [{ label: "Cafe relays", ...CAFE_RELAY_NETWORK }];
          preferenceRevision++;
          controller.request(desiredEnabled, false, true);
          return savePreferences();
        },
        catch: () => new RelayError("UNAVAILABLE"),
      }),
    invitation,
    revokeInvitation: relayAuth.revoke,
    start: (app: Handler) =>
      Effect.gen(function* () {
        if (handler || !active) return;
        // Retain the exact services of the listening router. Its request, private
        // relay context and request scope are supplied separately for each OPEN;
        // the server scope must never replace that stream's cleanup owner.
        handlerServices = (yield* Effect.context<never>()).pipe(
          Context.omit(Scope.Scope, HttpServerRequest.HttpServerRequest, RelayRequestContext),
        );
        handler = app.pipe(Effect.provide(handlerServices));
        // The listening router owns admitted requests. Drain its relay work
        // before its dependencies retire, rather than waiting for this lower
        // runtime layer's finalizer after those services have started closing.
        yield* Effect.addFinalizer(() => Effect.promise(close));
        controller.start();
      }),
  } satisfies RuntimeShape;
});
export const RelayRuntimeLive = Layer.effect(RelayRuntime, makeRelayRuntime);
