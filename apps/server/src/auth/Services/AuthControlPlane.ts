import type * as AuthContracts from "@cafecode/contracts/auth";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import type { SessionRole } from "./SessionCredentialService.ts";

export const DEFAULT_SESSION_SUBJECT = "cli-issued-session";

export interface IssuedPairingLink {
  readonly id: string;
  readonly credential: string;
  readonly role: SessionRole;
  readonly subject: string;
  readonly label?: string;
  readonly createdAt: DateTime.Utc;
  readonly expiresAt: DateTime.Utc;
}

export interface IssuedBearerSession {
  readonly sessionId: AuthContracts.AuthSessionId;
  readonly token: string;
  readonly method: "bearer-session-token";
  readonly role: SessionRole;
  readonly subject: string;
  readonly client: AuthContracts.AuthClientMetadata;
  readonly expiresAt: DateTime.Utc;
}

export class AuthControlPlaneError extends Data.TaggedError("AuthControlPlaneError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface AuthControlPlaneShape {
  readonly createPairingLink: (input?: {
    readonly ttl?: Duration.Duration;
    readonly label?: string;
    readonly role?: SessionRole;
    readonly subject?: string;
  }) => Effect.Effect<IssuedPairingLink, AuthControlPlaneError>;
  readonly listPairingLinks: (input?: {
    readonly role?: SessionRole;
    readonly excludeSubjects?: ReadonlyArray<string>;
  }) => Effect.Effect<ReadonlyArray<AuthContracts.AuthPairingLink>, AuthControlPlaneError>;
  readonly revokePairingLink: (id: string) => Effect.Effect<boolean, AuthControlPlaneError>;
  readonly issueSession: (input?: {
    readonly ttl?: Duration.Duration;
    readonly subject?: string;
    readonly role?: SessionRole;
    readonly label?: string;
  }) => Effect.Effect<IssuedBearerSession, AuthControlPlaneError>;
  readonly listSessions: () => Effect.Effect<
    ReadonlyArray<AuthContracts.AuthClientSession>,
    AuthControlPlaneError
  >;
  readonly revokeSession: (
    sessionId: AuthContracts.AuthSessionId,
  ) => Effect.Effect<boolean, AuthControlPlaneError>;
  readonly revokeOtherSessionsExcept: (
    sessionId: AuthContracts.AuthSessionId,
  ) => Effect.Effect<number, AuthControlPlaneError>;
  readonly isAdminPasswordConfigured: Effect.Effect<boolean, AuthControlPlaneError>;
  readonly setAdminPassword: (password: string) => Effect.Effect<void, AuthControlPlaneError>;
  readonly clearAdminPassword: Effect.Effect<void, AuthControlPlaneError>;
}

export class AuthControlPlane extends Context.Service<AuthControlPlane, AuthControlPlaneShape>()(
  "cafecode/AuthControlPlane",
) {}
