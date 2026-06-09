import {
  type AuthBearerBootstrapResult,
  type AuthClientMetadata,
  type AuthClientSession,
  type AuthBootstrapResult,
  type AuthPasswordBootstrapInput,
  type AuthPairingCredentialResult,
  type AuthSessionState,
  type AuthWebSocketTokenResult,
  type ServerAuthDescriptor,
} from "@cafecode/contracts/auth";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

import { AuthControlPlane } from "../Services/AuthControlPlane.ts";
import { AdminPasswordService } from "../Services/AdminPasswordService.ts";
import { ServerAuthPolicyLive } from "./ServerAuthPolicy.ts";
import { BootstrapCredentialService } from "../Services/BootstrapCredentialService.ts";
import { BootstrapCredentialError } from "../Services/BootstrapCredentialService.ts";
import { ServerAuthPolicy } from "../Services/ServerAuthPolicy.ts";
import {
  ServerAuth,
  type AuthenticatedSession,
  AuthError,
  type ServerAuthShape,
} from "../Services/ServerAuth.ts";
import {
  SessionCredentialError,
  SessionCredentialService,
} from "../Services/SessionCredentialService.ts";
import { AuthControlPlaneLive, AuthCoreLive } from "./AuthControlPlane.ts";

type BootstrapExchangeResult = {
  readonly response: AuthBootstrapResult;
  readonly sessionToken: string;
};

const AUTHORIZATION_PREFIX = "Bearer ";
const WEBSOCKET_TOKEN_QUERY_PARAM = "wsToken";
const PASSWORD_FAILURE_WINDOW_MS = 5 * 60 * 1000;
const PASSWORD_FAILURE_LIMIT = 5;

function passwordThrottleKey(metadata: AuthClientMetadata): string {
  return metadata.ipAddress ?? metadata.userAgent ?? "unknown-client";
}

export function toBootstrapExchangeAuthError(cause: BootstrapCredentialError): AuthError {
  if (cause.status === 500) {
    return new AuthError({
      message: "Failed to validate bootstrap credential.",
      status: 500,
      cause,
    });
  }

  return new AuthError({
    message: "Invalid bootstrap credential.",
    status: 401,
    cause,
  });
}

function parseBearerToken(request: HttpServerRequest.HttpServerRequest): string | null {
  const header = request.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith(AUTHORIZATION_PREFIX)) {
    return null;
  }
  const token = header.slice(AUTHORIZATION_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

export const makeServerAuth = Effect.gen(function* () {
  const policy = yield* ServerAuthPolicy;
  const bootstrapCredentials = yield* BootstrapCredentialService;
  const adminPassword = yield* AdminPasswordService;
  const authControlPlane = yield* AuthControlPlane;
  const sessions = yield* SessionCredentialService;
  const baseDescriptor = yield* policy.getDescriptor();
  const passwordFailuresRef = yield* Ref.make(
    new Map<string, { readonly count: number; readonly resetAt: number }>(),
  );

  const getDescriptor = (): Effect.Effect<ServerAuthDescriptor> =>
    adminPassword.isConfigured.pipe(
      Effect.map((passwordConfigured) => {
        if (!passwordConfigured || baseDescriptor.bootstrapMethods.includes("password")) {
          return baseDescriptor;
        }

        return {
          ...baseDescriptor,
          bootstrapMethods: [...baseDescriptor.bootstrapMethods, "password"],
        } satisfies ServerAuthDescriptor;
      }),
      Effect.catch(() => Effect.succeed(baseDescriptor)),
    );

  const issuePasswordSession = (
    method: "browser-session-cookie" | "bearer-session-token",
    requestMetadata: AuthPasswordBootstrapInput,
    clientMetadata: Parameters<ServerAuthShape["exchangePasswordCredential"]>[1],
  ) =>
    sessions.issue({
      method,
      subject: requestMetadata.username
        ? `admin-password:${requestMetadata.username}`
        : "admin-password",
      role: "owner",
      client: {
        ...clientMetadata,
        ...(requestMetadata.username ? { label: requestMetadata.username } : {}),
      },
    });

  const assertPasswordAttemptAllowed = (
    metadata: Parameters<ServerAuthShape["exchangePasswordCredential"]>[1],
  ) =>
    Effect.gen(function* () {
      const key = passwordThrottleKey(metadata);
      const now = yield* Clock.currentTimeMillis;
      const blocked = yield* Ref.get(passwordFailuresRef).pipe(
        Effect.map((failures) => {
          const entry = failures.get(key);
          return (
            entry !== undefined && entry.resetAt > now && entry.count >= PASSWORD_FAILURE_LIMIT
          );
        }),
      );
      if (blocked) {
        return yield* new AuthError({
          message: "Too many password attempts. Try again later.",
          status: 401,
        });
      }
    });

  const recordPasswordFailure = (
    metadata: Parameters<ServerAuthShape["exchangePasswordCredential"]>[1],
  ) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        Ref.update(passwordFailuresRef, (failures) => {
          const key = passwordThrottleKey(metadata);
          const existing = failures.get(key);
          const next = new Map(failures);
          if (!existing || existing.resetAt <= now) {
            next.set(key, { count: 1, resetAt: now + PASSWORD_FAILURE_WINDOW_MS });
          } else {
            next.set(key, { count: existing.count + 1, resetAt: existing.resetAt });
          }
          return next;
        }),
      ),
    );

  const clearPasswordFailures = (
    metadata: Parameters<ServerAuthShape["exchangePasswordCredential"]>[1],
  ) =>
    Ref.update(passwordFailuresRef, (failures) => {
      const next = new Map(failures);
      next.delete(passwordThrottleKey(metadata));
      return next;
    });

  const authenticateToken = (token: string): Effect.Effect<AuthenticatedSession, AuthError> =>
    sessions.verify(token).pipe(
      Effect.tapError((cause: SessionCredentialError) =>
        Effect.logWarning("Rejected authenticated session credential.").pipe(
          Effect.annotateLogs({
            reason: cause.message,
          }),
        ),
      ),
      Effect.map((session) => ({
        sessionId: session.sessionId,
        subject: session.subject,
        method: session.method,
        role: session.role,
        ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
      })),
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Unauthorized request.",
            status: 401,
            cause,
          }),
      ),
    );

  const authenticateRequest = (request: HttpServerRequest.HttpServerRequest) => {
    const cookieToken = request.cookies[sessions.cookieName];
    const bearerToken = parseBearerToken(request);
    const credential = cookieToken ?? bearerToken;
    if (!credential) {
      return Effect.fail(
        new AuthError({
          message: "Authentication required.",
          status: 401,
        }),
      );
    }
    return authenticateToken(credential);
  };

  const getSessionState: ServerAuthShape["getSessionState"] = (request) =>
    getDescriptor().pipe(
      Effect.flatMap((descriptor) =>
        authenticateRequest(request).pipe(
          Effect.map(
            (session) =>
              ({
                authenticated: true,
                auth: descriptor,
                role: session.role,
                sessionMethod: session.method,
                ...(session.expiresAt ? { expiresAt: DateTime.toUtc(session.expiresAt) } : {}),
              }) satisfies AuthSessionState,
          ),
          Effect.catchTag("AuthError", () =>
            Effect.succeed({
              authenticated: false,
              auth: descriptor,
            } satisfies AuthSessionState),
          ),
        ),
      ),
    );

  const exchangeBootstrapCredential: ServerAuthShape["exchangeBootstrapCredential"] = (
    credential,
    requestMetadata,
  ) =>
    bootstrapCredentials.consume(credential).pipe(
      Effect.mapError(toBootstrapExchangeAuthError),
      Effect.flatMap((grant) =>
        sessions
          .issue({
            method: "browser-session-cookie",
            subject: grant.subject,
            role: grant.role,
            client: {
              ...requestMetadata,
              ...(grant.label ? { label: grant.label } : {}),
            },
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new AuthError({
                  message: "Failed to issue authenticated session.",
                  cause,
                }),
            ),
          ),
      ),
      Effect.map(
        (session) =>
          ({
            response: {
              authenticated: true,
              role: session.role,
              sessionMethod: session.method,
              expiresAt: DateTime.toUtc(session.expiresAt),
            } satisfies AuthBootstrapResult,
            sessionToken: session.token,
          }) satisfies BootstrapExchangeResult,
      ),
    );

  const exchangeBootstrapCredentialForBearerSession: ServerAuthShape["exchangeBootstrapCredentialForBearerSession"] =
    (credential, requestMetadata) =>
      bootstrapCredentials.consume(credential).pipe(
        Effect.mapError(toBootstrapExchangeAuthError),
        Effect.flatMap((grant) =>
          sessions
            .issue({
              method: "bearer-session-token",
              subject: grant.subject,
              role: grant.role,
              client: {
                ...requestMetadata,
                ...(grant.label ? { label: grant.label } : {}),
              },
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new AuthError({
                    message: "Failed to issue authenticated session.",
                    cause,
                  }),
              ),
            ),
        ),
        Effect.map(
          (session) =>
            ({
              authenticated: true,
              role: session.role,
              sessionMethod: "bearer-session-token",
              expiresAt: DateTime.toUtc(session.expiresAt),
              sessionToken: session.token,
            }) satisfies AuthBearerBootstrapResult,
        ),
      );

  const exchangePasswordCredential: ServerAuthShape["exchangePasswordCredential"] = (
    input,
    requestMetadata,
  ) =>
    Effect.gen(function* () {
      yield* assertPasswordAttemptAllowed(requestMetadata);
      const verified = yield* adminPassword.verifyPassword(input.password).pipe(
        Effect.mapError(
          (cause) =>
            new AuthError({
              message: "Failed to validate password credential.",
              status: cause.status === 500 ? 500 : 401,
              cause,
            }),
        ),
      );
      if (!verified) {
        yield* recordPasswordFailure(requestMetadata);
        return yield* new AuthError({
          message: "Invalid password credential.",
          status: 401,
        });
      }

      yield* clearPasswordFailures(requestMetadata);
      const session = yield* issuePasswordSession(
        "browser-session-cookie",
        input,
        requestMetadata,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new AuthError({
              message: "Failed to issue authenticated session.",
              status: 500,
              cause,
            }),
        ),
      );

      return {
        response: {
          authenticated: true,
          role: session.role,
          sessionMethod: session.method,
          expiresAt: DateTime.toUtc(session.expiresAt),
        } satisfies AuthBootstrapResult,
        sessionToken: session.token,
      };
    });

  const exchangePasswordCredentialForBearerSession: ServerAuthShape["exchangePasswordCredentialForBearerSession"] =
    (input, requestMetadata) =>
      Effect.gen(function* () {
        yield* assertPasswordAttemptAllowed(requestMetadata);
        const verified = yield* adminPassword.verifyPassword(input.password).pipe(
          Effect.mapError(
            (cause) =>
              new AuthError({
                message: "Failed to validate password credential.",
                status: cause.status === 500 ? 500 : 401,
                cause,
              }),
          ),
        );
        if (!verified) {
          yield* recordPasswordFailure(requestMetadata);
          return yield* new AuthError({
            message: "Invalid password credential.",
            status: 401,
          });
        }

        yield* clearPasswordFailures(requestMetadata);
        const session = yield* issuePasswordSession(
          "bearer-session-token",
          input,
          requestMetadata,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new AuthError({
                message: "Failed to issue authenticated session.",
                status: 500,
                cause,
              }),
          ),
        );

        return {
          authenticated: true,
          role: session.role,
          sessionMethod: "bearer-session-token",
          expiresAt: DateTime.toUtc(session.expiresAt),
          sessionToken: session.token,
        } satisfies AuthBearerBootstrapResult;
      });

  const issuePairingCredential: ServerAuthShape["issuePairingCredential"] = (input) =>
    authControlPlane
      .createPairingLink({
        role: input?.role ?? "client",
        subject: input?.role === "owner" ? "owner-bootstrap" : "one-time-token",
        ...(input?.label ? { label: input.label } : {}),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new AuthError({
              message: "Failed to issue pairing credential.",
              cause,
            }),
        ),
        Effect.map(
          (issued) =>
            ({
              id: issued.id,
              credential: issued.credential,
              ...(issued.label ? { label: issued.label } : {}),
              expiresAt: issued.expiresAt,
            }) satisfies AuthPairingCredentialResult,
        ),
      );

  const listPairingLinks: ServerAuthShape["listPairingLinks"] = () =>
    authControlPlane
      .listPairingLinks({
        role: "client",
        excludeSubjects: ["owner-bootstrap"],
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new AuthError({
              message: "Failed to load pairing links.",
              cause,
            }),
        ),
      );

  const revokePairingLink: ServerAuthShape["revokePairingLink"] = (id) =>
    authControlPlane.revokePairingLink(id).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Failed to revoke pairing link.",
            cause,
          }),
      ),
    );

  const listClientSessions: ServerAuthShape["listClientSessions"] = (currentSessionId) =>
    authControlPlane.listSessions().pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Failed to load paired clients.",
            cause,
          }),
      ),
      Effect.map((clientSessions) =>
        clientSessions.map(
          (clientSession): AuthClientSession => ({
            ...clientSession,
            current: clientSession.sessionId === currentSessionId,
          }),
        ),
      ),
    );

  const revokeClientSession: ServerAuthShape["revokeClientSession"] = (
    currentSessionId,
    targetSessionId,
  ) =>
    Effect.gen(function* () {
      if (currentSessionId === targetSessionId) {
        return yield* new AuthError({
          message: "Use revoke other clients to keep the current owner session active.",
          status: 403,
        });
      }
      return yield* authControlPlane.revokeSession(targetSessionId).pipe(
        Effect.mapError(
          (cause) =>
            new AuthError({
              message: "Failed to revoke client session.",
              cause,
            }),
        ),
      );
    });

  const revokeOtherClientSessions: ServerAuthShape["revokeOtherClientSessions"] = (
    currentSessionId,
  ) =>
    authControlPlane.revokeOtherSessionsExcept(currentSessionId).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Failed to revoke other client sessions.",
            cause,
          }),
      ),
    );

  const issueStartupPairingUrl: ServerAuthShape["issueStartupPairingUrl"] = (baseUrl) =>
    issuePairingCredential({ role: "owner" }).pipe(
      Effect.map((issued) => {
        const url = new URL(baseUrl);
        url.pathname = "/pair";
        url.searchParams.delete("token");
        url.hash = new URLSearchParams([["token", issued.credential]]).toString();
        return url.toString();
      }),
    );

  const issueWebSocketToken: ServerAuthShape["issueWebSocketToken"] = (session) =>
    sessions.issueWebSocketToken(session.sessionId).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Failed to issue websocket token.",
            cause,
          }),
      ),
      Effect.map(
        (issued) =>
          ({
            token: issued.token,
            expiresAt: DateTime.toUtc(issued.expiresAt),
          }) satisfies AuthWebSocketTokenResult,
      ),
    );

  const authenticateWebSocketUpgrade: ServerAuthShape["authenticateWebSocketUpgrade"] = (request) =>
    Effect.gen(function* () {
      const requestUrl = HttpServerRequest.toURL(request);
      if (Option.isSome(requestUrl)) {
        const websocketToken = requestUrl.value.searchParams.get(WEBSOCKET_TOKEN_QUERY_PARAM);
        if (websocketToken && websocketToken.trim().length > 0) {
          return yield* sessions.verifyWebSocketToken(websocketToken).pipe(
            Effect.map((session) => ({
              sessionId: session.sessionId,
              subject: session.subject,
              method: session.method,
              role: session.role,
              ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
            })),
            Effect.mapError(
              (cause) =>
                new AuthError({
                  message: "Unauthorized request.",
                  status: 401,
                  cause,
                }),
            ),
          );
        }
      }

      return yield* authenticateRequest(request);
    });

  return {
    getDescriptor,
    getSessionState,
    exchangeBootstrapCredential,
    exchangeBootstrapCredentialForBearerSession,
    exchangePasswordCredential,
    exchangePasswordCredentialForBearerSession,
    issuePairingCredential,
    listPairingLinks,
    revokePairingLink,
    listClientSessions,
    revokeClientSession,
    revokeOtherClientSessions,
    authenticateHttpRequest: authenticateRequest,
    authenticateWebSocketUpgrade,
    issueWebSocketToken,
    issueStartupPairingUrl,
  } satisfies ServerAuthShape;
});

export const ServerAuthLive = Layer.effect(ServerAuth, makeServerAuth).pipe(
  Layer.provideMerge(AuthControlPlaneLive),
  Layer.provideMerge(AuthCoreLive),
  Layer.provideMerge(ServerAuthPolicyLive),
);
