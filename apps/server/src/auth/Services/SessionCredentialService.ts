import type * as AuthContracts from "@cafecode/contracts/auth";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export type SessionRole = "owner" | "client";

export interface IssuedSession {
  readonly sessionId: AuthContracts.AuthSessionId;
  readonly token: string;
  readonly method: AuthContracts.ServerAuthSessionMethod;
  readonly client: AuthContracts.AuthClientMetadata;
  readonly expiresAt: DateTime.DateTime;
  readonly role: SessionRole;
}

export interface VerifiedSession {
  readonly sessionId: AuthContracts.AuthSessionId;
  readonly token: string;
  readonly method: AuthContracts.ServerAuthSessionMethod;
  readonly client: AuthContracts.AuthClientMetadata;
  readonly expiresAt?: DateTime.DateTime;
  readonly subject: string;
  readonly role: SessionRole;
}

export type SessionCredentialChange =
  | {
      readonly type: "clientUpserted";
      readonly clientSession: AuthContracts.AuthClientSession;
    }
  | {
      readonly type: "clientRemoved";
      readonly sessionId: AuthContracts.AuthSessionId;
    };

export class SessionCredentialError extends Data.TaggedError("SessionCredentialError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface SessionCredentialServiceShape {
  readonly cookieName: string;
  readonly httpsCookieName: string | undefined;
  readonly issue: (input?: {
    readonly ttl?: Duration.Duration;
    readonly subject?: string;
    readonly method?: AuthContracts.ServerAuthSessionMethod;
    readonly role?: SessionRole;
    readonly client?: AuthContracts.AuthClientMetadata;
  }) => Effect.Effect<IssuedSession, SessionCredentialError>;
  readonly verify: (token: string) => Effect.Effect<VerifiedSession, SessionCredentialError>;
  readonly issueWebSocketToken: (
    sessionId: AuthContracts.AuthSessionId,
    input?: {
      readonly ttl?: Duration.Duration;
    },
  ) => Effect.Effect<
    {
      readonly token: string;
      readonly expiresAt: DateTime.DateTime;
    },
    SessionCredentialError
  >;
  readonly verifyWebSocketToken: (
    token: string,
  ) => Effect.Effect<VerifiedSession, SessionCredentialError>;
  readonly listActive: () => Effect.Effect<
    ReadonlyArray<AuthContracts.AuthClientSession>,
    SessionCredentialError
  >;
  readonly streamChanges: Stream.Stream<SessionCredentialChange>;
  readonly revoke: (
    sessionId: AuthContracts.AuthSessionId,
  ) => Effect.Effect<boolean, SessionCredentialError>;
  readonly revokeAllExcept: (
    sessionId: AuthContracts.AuthSessionId,
  ) => Effect.Effect<number, SessionCredentialError>;
  readonly markConnected: (sessionId: AuthContracts.AuthSessionId) => Effect.Effect<void, never>;
  readonly markDisconnected: (sessionId: AuthContracts.AuthSessionId) => Effect.Effect<void, never>;
}

export class SessionCredentialService extends Context.Service<
  SessionCredentialService,
  SessionCredentialServiceShape
>()("cafecode/auth/Services/SessionCredentialService") {}
