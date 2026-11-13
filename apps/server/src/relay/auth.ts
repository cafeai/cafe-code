import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { opaque, randomOpaque, unopaque } from "@cafecode/relay/bytes";
import { sha256 } from "@cafecode/relay/crypto";
import { RelayError } from "@cafecode/relay/errors";
import type { SessionAuth, SessionAuthResult } from "@cafecode/relay/session";
import {
  SessionCredentialService,
  type VerifiedSession,
} from "../auth/Services/SessionCredentialService.ts";
import { ServerAuth } from "../auth/Services/ServerAuth.ts";
import { TwoFactorService } from "../auth/Services/TwoFactorService.ts";
import type { EnvironmentId } from "@cafecode/contracts";

const RoleRow = Schema.Struct({ role: Schema.Literals(["client", "owner"]) });
const CountRow = Schema.Struct({
  count: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
const rowsRole = Schema.decodeUnknownEffect(Schema.Array(RoleRow));
const rowsCount = Schema.decodeUnknownEffect(Schema.Array(CountRow));
const denial = () => new RelayError("AUTH_REJECTED");

/** Uses the existing session service/2FA, with a separate relay-only purpose. */
export const makeRelayAuth = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* SessionCredentialService;
  const auth = yield* ServerAuth;
  const twoFactor = yield* TwoFactorService;
  const issue = (scope: {
    readonly networkId: string;
    readonly hostKey: string;
    readonly environmentId: EnvironmentId;
    readonly role: "client" | "owner";
  }) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          yield* sql`DELETE FROM relay_invitations WHERE expires_at <= ${now}`;
          const counts = yield* rowsCount(
            yield* sql`SELECT COUNT(*) AS count FROM relay_invitations`,
          );
          if (!counts[0] || counts[0].count >= 128) return yield* new RelayError("BUSY");
          const secret = randomOpaque(),
            id = randomOpaque(16),
            expiresAt = now + 300_000;
          const digest = opaque(sha256(unopaque(secret, 32)));
          yield* sql`INSERT INTO relay_invitations (id,secret_hash,network_id,host_key,environment_id,role,expires_at)
      VALUES (${id},${digest},${scope.networkId},${scope.hostKey},${scope.environmentId},${scope.role},${expiresAt})`;
          return { id, secret, expiresAt };
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          error instanceof RelayError ? error : new RelayError("UNAVAILABLE"),
        ),
      );

  const validateBinding = (
    scope: { readonly networkId: string; readonly hostKey: string; readonly deviceKey: string },
    session: VerifiedSession,
  ) =>
    Effect.gen(function* () {
      if (session.method !== "bearer-session-token" || session.managementLaunchContext)
        return yield* denial();
      yield* sessions.validateActiveSession(session).pipe(Effect.mapError(denial));
      const now = yield* Clock.currentTimeMillis;
      const counts = yield* rowsCount(
        yield* sql`SELECT COUNT(*) AS count FROM relay_device_sessions WHERE network_id=${scope.networkId} AND host_key=${scope.hostKey} AND device_key=${scope.deviceKey} AND session_id=${session.sessionId} AND expires_at > ${now}`,
      );
      if (counts[0]?.count !== 1) return yield* denial();
    }).pipe(Effect.mapError((error) => (error instanceof RelayError ? error : denial())));

  const authenticate = (
    scope: {
      readonly networkId: string;
      readonly hostKey: string;
      readonly environmentId: EnvironmentId;
      readonly deviceKey: string;
    },
    input: SessionAuth,
  ) =>
    Effect.gen(function* () {
      if (input.environmentId !== scope.environmentId)
        return yield* new RelayError("ENVIRONMENT_MISMATCH");
      if (input.operation === "resume") {
        const session = yield* sessions.verify(input.credential).pipe(Effect.mapError(denial));
        yield* validateBinding(scope, session);
        if (!session.expiresAt) return yield* denial();
        return {
          result: {
            environmentId: scope.environmentId,
            bearerToken: input.credential,
            role: session.role,
            expiresAt: session.expiresAt.epochMilliseconds,
          } satisfies SessionAuthResult,
          session,
        };
      }
      // Only a fresh first factor can enroll a device. A bearer alone cannot
      // create/replace this binding. The pair secret is never accepted by direct
      // or native desktop bootstrap, and has no desktop exemption from 2FA.
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          yield* sql`DELETE FROM relay_device_sessions WHERE expires_at <= ${now}`;
          const counts = yield* rowsCount(
            yield* sql`SELECT COUNT(*) AS count FROM relay_device_sessions`,
          );
          if (!counts[0] || counts[0].count >= 256) return yield* new RelayError("BUSY");
          let token: string;
          if (input.operation === "pair") {
            let digest: string;
            try {
              digest = opaque(sha256(unopaque(input.credential, 32)));
            } catch {
              return yield* denial();
            }
            const lookup = () =>
              sql`SELECT role FROM relay_invitations WHERE secret_hash=${digest} AND network_id=${scope.networkId} AND host_key=${scope.hostKey} AND environment_id=${scope.environmentId} AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ${now}`.pipe(
                Effect.flatMap(rowsRole),
              );
            const available = yield* lookup();
            if (available.length !== 1) return yield* denial();
            yield* twoFactor
              .verify(input.secondFactor)
              .pipe(
                Effect.mapError(
                  (error) =>
                    new RelayError(
                      error.reason === "two-factor-required"
                        ? "SECOND_FACTOR_REQUIRED"
                        : error.reason === "two-factor-locked"
                          ? "SECOND_FACTOR_LOCKED"
                          : error.reason === "two-factor-invalid"
                            ? "SECOND_FACTOR_REJECTED"
                            : "AUTH_REJECTED",
                    ),
                ),
              );
            const consumedAt = yield* Clock.currentTimeMillis;
            const consumed =
              yield* sql`UPDATE relay_invitations SET consumed_at=${consumedAt} WHERE secret_hash=${digest} AND network_id=${scope.networkId} AND host_key=${scope.hostKey} AND environment_id=${scope.environmentId} AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ${consumedAt} RETURNING role`.pipe(
                Effect.flatMap(rowsRole),
              );
            const grant = consumed[0];
            if (!grant || consumed.length !== 1) return yield* denial();
            const issued = yield* sessions.issue({
              method: "bearer-session-token",
              subject: "relay-pairing",
              role: grant.role,
              client: { deviceType: "unknown", label: "Relay viewer" },
            });
            token = issued.token;
          } else {
            const result = yield* auth
              .exchangePasswordCredentialForBearerSession(
                {
                  password: input.credential,
                  ...(input.secondFactor ? { secondFactor: input.secondFactor } : {}),
                },
                { deviceType: "unknown", label: "Relay viewer" },
              )
              .pipe(
                Effect.mapError(
                  (error) =>
                    new RelayError(
                      error.reason === "two-factor-required"
                        ? "SECOND_FACTOR_REQUIRED"
                        : error.reason === "two-factor-locked"
                          ? "SECOND_FACTOR_LOCKED"
                          : error.reason === "two-factor-invalid"
                            ? "SECOND_FACTOR_REJECTED"
                            : "AUTH_REJECTED",
                    ),
                ),
              );
            token = result.sessionToken;
          }
          const session = yield* sessions.verify(token);
          if (!session.expiresAt || session.managementLaunchContext) return yield* denial();
          // This INSERT and the session creation commit in the same SQL transaction.
          // No bearer/AUTH_OK is returned while binding persistence can still fail.
          yield* sql`INSERT INTO relay_device_sessions (network_id,host_key,device_key,session_id,expires_at) VALUES (${scope.networkId},${scope.hostKey},${scope.deviceKey},${session.sessionId},${session.expiresAt.epochMilliseconds})`;
          return {
            result: {
              environmentId: scope.environmentId,
              bearerToken: token,
              role: session.role,
              expiresAt: session.expiresAt.epochMilliseconds,
            } satisfies SessionAuthResult,
            session,
          };
        }),
      );
    }).pipe(Effect.mapError((error) => (error instanceof RelayError ? error : denial())));
  const revoke = (id: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const rows =
        yield* sql`UPDATE relay_invitations SET revoked_at=${now} WHERE id=${id} AND consumed_at IS NULL AND revoked_at IS NULL RETURNING id`;
      return rows.length === 1;
    }).pipe(Effect.mapError(() => new RelayError("UNAVAILABLE")));
  return { issue, revoke, authenticate, validateBinding };
});
