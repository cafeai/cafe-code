import type { EnvironmentId } from "@cafecode/contracts";
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
import { serveRelayedHttp, HttpOpen, relativeAppPath } from "@cafecode/relay/http";
import { connectNative } from "@cafecode/relay/nativeWire";
import { unopaqueBounded } from "@cafecode/relay/bytes";
import { RelayError } from "@cafecode/relay/errors";
import type { RelayStream, SessionAuthResult } from "@cafecode/relay/session";
import type { RelayDial } from "@cafecode/relay/client";
import type { RelayNode } from "@cafecode/relay/descriptor";
import type { Lifetime } from "@cafecode/relay/lifetime";
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
import { readRelayPrivate, createRelayPrivate } from "./privateFiles.ts";
import { RelayServerRequest, relayEffectSocket } from "./request.ts";
import { RelayRequestContext } from "./requestContext.ts";

const Config = Schema.Struct({
  version: Schema.Literal(1),
  networks: Schema.Array(
    Schema.Struct({
      descriptor: NetworkDescriptor,
      viewerOrigin: Schema.String.check(Schema.isMaxLength(256)),
      locator: Id32,
      credentials: Schema.Array(
        Schema.Struct({
          nodeId: Id32,
          token: Id32,
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
  readonly start: (handler: Handler) => Effect.Effect<void>;
  readonly status: Effect.Effect<{
    readonly enabled: boolean;
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
  const runWith = Effect.runPromiseWith(services);
  const run = async <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
    const result = await runWith(Effect.result(effect));
    if (Result.isFailure(result))
      throw result.failure instanceof RelayError ? result.failure : new RelayError("UNAVAILABLE");
    return result.success;
  };
  let active = true,
    handler: Handler | undefined;
  let handlerServices = services;
  const hosts: Array<{
    readonly host: RelayHost;
    readonly descriptor: NetworkDescriptor;
    readonly identity: RelayIdentity;
    readonly origin: string;
    readonly locator: string;
    readonly environmentId: EnvironmentId;
  }> = [];
  const raw = yield* Effect.tryPromise({
    try: () => readRelayPrivate(config.stateDir, "config.json", 32_768),
    catch: () => new RelayError("UNAVAILABLE"),
  });
  if (raw) {
    const parsed = yield* Effect.try({
      try: () => readCanonical(Config, raw, 32_768),
      catch: () => new RelayError("PROTOCOL_ERROR"),
    });
    const seen = new Set<string>();
    for (const entry of parsed.networks) {
      if (seen.has(entry.descriptor.networkId)) return yield* new RelayError("NETWORK_MISMATCH");
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
      const keyName = `host-${descriptor.networkId}.key` as const;
      const saved = yield* Effect.tryPromise({
        try: () => readRelayPrivate(config.stateDir, keyName, 128),
        catch: () => new RelayError("UNAVAILABLE"),
      });
      const identity = yield* Effect.tryPromise({
        try: () => (saved ? Promise.resolve(restoreIdentity(saved)) : createIdentity()),
        catch: () => new RelayError("CRYPTO_FAILURE"),
      });
      if (!saved)
        yield* Effect.tryPromise({
          try: () => createRelayPrivate(config.stateDir, keyName, privateIdentityBytes(identity)),
          catch: () => new RelayError("UNAVAILABLE"),
        });
      const environmentId = yield* environment.getEnvironmentId;
      const scope = { networkId: descriptor.networkId, hostKey: identity.publicKey, environmentId };
      const resume = (auth: SessionAuthResult, deviceKey: string) =>
        run(
          relayAuth.authenticate(
            { ...scope, deviceKey },
            { environmentId, operation: "resume", credential: auth.bearerToken },
          ),
        );
      const host = new RelayHost({
        network: descriptor,
        identity,
        credentials: entry.credentials.map((credential) => ({
          nodeId: credential.nodeId,
          locator: entry.locator,
          token: credential.token,
          admissionIdentity: restoreIdentity(unopaqueBounded(credential.admissionPrivateKey, 128)),
        })),
        dial: Option.isSome(connector)
          ? connector.value.dial
          : (node, resources) => connectNative(node.url, resources),
        ...(Option.isSome(connector) && connector.value.measureLatency
          ? { measureLatency: connector.value.measureLatency }
          : {}),
        handlers: {
          authenticate: async (auth, deviceKey) => {
            if (!active) throw new RelayError("UNAVAILABLE");
            const result = await run(relayAuth.authenticate({ ...scope, deviceKey }, auth));
            if (!active) throw new RelayError("UNAVAILABLE");
            return result.result;
          },
          validate: async (auth, deviceKey) => {
            await resume(auth, deviceKey);
            if (!active) throw new RelayError("UNAVAILABLE");
          },
          open: async (stream: RelayStream, metadata) => {
            if (!active || !handler || !stream.owner.auth) throw new RelayError("AUTH_REQUIRED");
            const ownedHandler = handler,
              authenticated = await resume(stream.owner.auth, stream.owner.remotePublicKey);
            if (!active || !stream.active) throw new RelayError("UNAVAILABLE");
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
                  active && stream.active
                    ? Effect.void
                    : Effect.fail(new AuthError({ message: "Unauthorized request.", status: 401 })),
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
              );
            try {
              if (stream.kind === "rpc") {
                const open = readCanonical(HttpOpen, canonicalBytes(metadata));
                if (!isRelayAppRoute(open.method, open.path, true))
                  throw new RelayError("PROTOCOL_ERROR");
                const socket = relayEffectSocket(stream).pipe(
                  Effect.tap(() =>
                    Effect.tryPromise({
                      try: () => stream.accept({ protocol: "ndjson" }),
                      catch: () => new RelayError("UNAVAILABLE"),
                    }).pipe(Effect.orDie),
                  ),
                );
                await handle(
                  new Request("https://relay.cafecode.invalid" + open.path, {
                    headers: { authorization: "Bearer " + stream.owner.auth.bearerToken },
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
  }
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      active = false;
      await Promise.allSettled(hosts.map((entry) => entry.host.close()));
    }),
  );
  const status = Effect.sync(() => ({
    enabled: hosts.length > 0,
    networks: hosts.map((entry) => ({
      networkId: entry.descriptor.networkId,
      serving: entry.host.stats().servingNodes.length,
    })),
  }));
  const invitation: RuntimeShape["invitation"] = (networkId, role) =>
    Effect.gen(function* () {
      const entry = hosts.find((value) => value.descriptor.networkId === networkId);
      if (!entry || !active || !handler) return yield* new RelayError("UNAVAILABLE");
      const ticket = yield* Effect.tryPromise({
        try: () => entry.host.invitationTicket(),
        catch: () => new RelayError("UNAVAILABLE"),
      });
      const issued = yield* relayAuth.issue({
        networkId,
        hostKey: entry.identity.publicKey,
        environmentId: entry.environmentId,
        role,
      });
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
        yield* Effect.promise(async () => {
          await Promise.allSettled(hosts.map((entry) => entry.host.start()));
        }).pipe(Effect.forkIn(runtimeScope));
      }),
  } satisfies RuntimeShape;
});
export const RelayRuntimeLive = Layer.effect(RelayRuntime, makeRelayRuntime);
