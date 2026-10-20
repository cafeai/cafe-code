import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Schema from "effect/Schema";
import { expect, it } from "@effect/vitest";
import { AuthSessionId } from "@cafecode/contracts/auth";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { ServerConfigShape } from "../../config.ts";
import { ServerConfig } from "../../config.ts";
import { SqlitePersistenceTest } from "../../persistence/Sqlite.test.fixture.ts";
import { SessionCredentialService } from "../Services/SessionCredentialService.ts";
import { ServerSecretStoreLive } from "./ServerSecretStore.ts";
import { SessionCredentialServiceLive } from "./SessionCredentialService.ts";

// Preserve deliberately malformed/historical fixture values and exact native JSON bytes;
// this codec does not replace production admission or grant received-data authority.
const encodeFixtureJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const makeServerConfigLayer = (
  overrides?: Partial<
    Pick<
      ServerConfigShape,
      "desktopBootstrapToken" | "httpsEnabled" | "httpsPort" | "mode" | "port" | "dataProfile"
    >
  >,
) =>
  Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      return {
        ...config,
        ...overrides,
      } satisfies ServerConfigShape;
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-session-test-" })));

const makeSessionCredentialLayer = (
  overrides?: Partial<
    Pick<
      ServerConfigShape,
      "desktopBootstrapToken" | "httpsEnabled" | "httpsPort" | "mode" | "port" | "dataProfile"
    >
  >,
) =>
  SessionCredentialServiceLive.pipe(
    // Expose this same isolated in-memory database to the identity-change and
    // unreadable-row fixtures below; never connect to a profile database.
    Layer.provideMerge(SqlitePersistenceTest),
    Layer.provide(ServerSecretStoreLive),
    Layer.provide(makeServerConfigLayer(overrides)),
  );

it.layer(NodeServices.layer)("SessionCredentialServiceLive", (it) => {
  for (const mode of ["web", "desktop"] as const) {
    it.effect(`uses explicit Debug HTTP and HTTPS cookie names in ${mode} mode`, () =>
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;

        expect(sessions.cookieName).toBe("t3_debug_session_13773");
        expect(sessions.httpsCookieName).toBe("t3_debug_session_https_13774");
        const issued = yield* sessions.issue({ subject: "debug-browser", role: "client" });
        const verified = yield* sessions.verify(issued.token);
        expect(verified.sessionId).toBe(issued.sessionId);
        expect(verified.role).toBe("client");
      }).pipe(
        Effect.provide(
          makeSessionCredentialLayer({
            dataProfile: "debug",
            mode,
            port: 13773,
            httpsEnabled: true,
            httpsPort: 13774,
          }),
        ),
      ),
    );
  }

  it.effect("uses a distinct cookie name for the HTTPS sibling listener", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;

      expect(sessions.cookieName).toBe("t3_session");
      expect(sessions.httpsCookieName).toBe("t3_session_https_9443");
    }).pipe(
      Effect.provide(
        makeSessionCredentialLayer({
          httpsEnabled: true,
          httpsPort: 9443,
        }),
      ),
    ),
  );

  it.effect("issues and verifies signed browser session tokens", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const issued = yield* sessions.issue({
        subject: "desktop-bootstrap",
        role: "owner",
        client: {
          label: "Desktop app",
          deviceType: "desktop",
          os: "macOS",
          browser: "Electron",
          ipAddress: "127.0.0.1",
        },
      });
      const verified = yield* sessions.verify(issued.token);

      expect(verified.method).toBe("browser-session-cookie");
      expect(verified.subject).toBe("desktop-bootstrap");
      expect(verified.role).toBe("owner");
      expect(verified.client.label).toBe("Desktop app");
      expect(verified.client.browser).toBe("Electron");
      expect(verified.expiresAt?.toString()).toBe(issued.expiresAt.toString());
    }).pipe(Effect.provide(makeSessionCredentialLayer())),
  );
  it.effect("rejects malformed session tokens", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const error = yield* Effect.flip(sessions.verify("not-a-session-token"));

      expect(error._tag).toBe("SessionCredentialError");
      expect(error.message).toContain("Malformed session token");
    }).pipe(Effect.provide(makeSessionCredentialLayer())),
  );
  it.effect("verifies session tokens against the Effect clock", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const issued = yield* sessions.issue({
        method: "bearer-session-token",
        subject: "test-clock",
      });
      const verified = yield* sessions.verify(issued.token);

      expect(verified.method).toBe("bearer-session-token");
      expect(verified.subject).toBe("test-clock");
      expect(verified.role).toBe("client");
    }).pipe(Effect.provide(Layer.merge(makeSessionCredentialLayer(), TestClock.layer()))),
  );

  it.effect("rejects websocket tokens once the parent session has expired", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const issued = yield* sessions.issue({
        method: "bearer-session-token",
        subject: "short-lived",
        ttl: Duration.seconds(1),
      });
      const websocket = yield* sessions.issueWebSocketToken(issued.sessionId);

      yield* TestClock.adjust(Duration.seconds(2));

      const error = yield* Effect.flip(sessions.verifyWebSocketToken(websocket.token));
      expect(error.message).toContain("expired");
    }).pipe(Effect.provide(Layer.merge(makeSessionCredentialLayer(), TestClock.layer()))),
  );

  it.effect("validates only the exact still-active persisted upgrade identity", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const issued = yield* sessions.issue({ subject: "diagnostic-owner", role: "owner" });
      const captured = yield* sessions.verify(issued.token);
      expect(yield* sessions.validateActiveSession(captured)).toBeUndefined();

      const { expiresAt: _expiry, ...withoutExpiry } = captured;
      for (const changed of [
        { ...captured, sessionId: AuthSessionId.make(crypto.randomUUID()) },
        { ...captured, subject: "foreign-diagnostic-owner" },
        { ...captured, method: "bearer-session-token" as const },
        { ...captured, role: "client" as const },
        withoutExpiry,
        { ...captured, expiresAt: DateTime.add(issued.expiresAt, { milliseconds: 1 }) },
      ]) {
        const error = yield* Effect.flip(sessions.validateActiveSession(changed));
        expect(error._tag).toBe("SessionCredentialError");
        expect(error.message).toBe("The authenticated session is no longer active.");
        expect(error.cause).toBeUndefined();
        expect(encodeFixtureJson(error)).not.toContain(issued.token);
      }
      // Rejected alternative claims cannot change the real session or revoke
      // its valid identity; the original captured owner remains admitted.
      expect(yield* sessions.validateActiveSession(captured)).toBeUndefined();
    }).pipe(Effect.provide(makeSessionCredentialLayer())),
  );

  it.effect("refuses a revoked owner even when its upgrade identity is retained", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const issued = yield* sessions.issue({ subject: "revoked-diagnostic-owner", role: "owner" });
      const captured = yield* sessions.verify(issued.token);
      yield* sessions.validateActiveSession(captured);
      expect(yield* sessions.revoke(issued.sessionId)).toBe(true);
      const error = yield* Effect.flip(sessions.validateActiveSession(captured));
      expect(error.message).toBe("The authenticated session is no longer active.");
      expect(error.cause).toBeUndefined();
    }).pipe(Effect.provide(makeSessionCredentialLayer())),
  );

  it.effect("refuses the captured owner at its exact persisted expiry boundary", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const issued = yield* sessions.issue({
        subject: "expired-diagnostic-owner",
        role: "owner",
        ttl: Duration.seconds(1),
      });
      const captured = yield* sessions.verify(issued.token);
      yield* sessions.validateActiveSession(captured);
      // The production fence uses <=, so equality must already be expired.
      // Advancing the isolated clock does not wait or alter a native clock.
      yield* TestClock.adjust(Duration.seconds(1));
      const error = yield* Effect.flip(sessions.validateActiveSession(captured));
      expect(error.message).toBe("The authenticated session is no longer active.");
      expect(error.cause).toBeUndefined();
    }).pipe(Effect.provide(Layer.merge(makeSessionCredentialLayer(), TestClock.layer()))),
  );

  it.effect("keeps active parent-session admission independent of the expired upgrade token", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const parent = yield* sessions.issue({
        subject: "diagnostic-parent-owner",
        role: "owner",
        ttl: Duration.hours(1),
      });
      const upgrade = yield* sessions.issueWebSocketToken(parent.sessionId, {
        ttl: Duration.seconds(1),
      });
      const captured = yield* sessions.verifyWebSocketToken(upgrade.token);
      expect(captured.expiresAt?.epochMilliseconds).toBe(parent.expiresAt.epochMilliseconds);
      yield* TestClock.adjust(Duration.seconds(2));
      const expiredUpgrade = yield* Effect.flip(sessions.verifyWebSocketToken(upgrade.token));
      expect(expiredUpgrade.message).toContain("expired");
      // Upgrade credentials are checked when admitting the connection. Subsequent private reads
      // must validate its still-active exact parent, not replay that credential.
      expect(yield* sessions.validateActiveSession(captured)).toBeUndefined();
    }).pipe(Effect.provide(Layer.merge(makeSessionCredentialLayer(), TestClock.layer()))),
  );

  it.effect("rejects persisted identity replacement and hides unreadable row or SQL causes", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const sql = yield* SqlClient.SqlClient;
      const issued = yield* sessions.issue({ subject: "original-diagnostic-owner", role: "owner" });
      const captured = yield* sessions.verify(issued.token);
      yield* sessions.validateActiveSession(captured);
      const expectRefusal = Effect.gen(function* () {
        const error = yield* Effect.flip(sessions.validateActiveSession(captured));
        expect(error._tag).toBe("SessionCredentialError");
        expect(error.message).toBe("The authenticated session is no longer active.");
        expect(error.cause).toBeUndefined();
        expect(encodeFixtureJson(error)).not.toMatch(
          /synthetic-private-row-sentinel|original-diagnostic-owner|auth_sessions|no such table/u,
        );
      });

      // Mutate only the freshly minted fixture row to prove admission observes
      // current durable evidence rather than caching the earlier upgrade.
      yield* sql`UPDATE auth_sessions SET subject = 'synthetic-private-row-sentinel'
        WHERE session_id = ${issued.sessionId}`;
      yield* expectRefusal;
      yield* sql`UPDATE auth_sessions SET subject = ${captured.subject}, role = 'client'
        WHERE session_id = ${issued.sessionId}`;
      yield* expectRefusal;
      yield* sql`UPDATE auth_sessions SET role = 'owner', method = 'bearer-session-token'
        WHERE session_id = ${issued.sessionId}`;
      yield* expectRefusal;
      yield* sql`UPDATE auth_sessions SET method = ${captured.method}, expires_at = ${DateTime.formatIso(DateTime.add(issued.expiresAt, { milliseconds: 1 }))}
        WHERE session_id = ${issued.sessionId}`;
      yield* expectRefusal;
      yield* sql`UPDATE auth_sessions SET expires_at = ${DateTime.formatIso(issued.expiresAt)}, role = 'synthetic-private-row-sentinel'
        WHERE session_id = ${issued.sessionId}`;
      // The invalid role exercises the real repository's schema/decode error,
      // whose detailed cause can contain the received private stored value.
      yield* expectRefusal;
      yield* sql`UPDATE auth_sessions SET role = 'owner' WHERE session_id = ${issued.sessionId}`;
      yield* sessions.validateActiveSession(captured);
      // This table exists solely in the test-owned memory database. Removing
      // it forces an actual driver failure, with no user data or OS changes.
      yield* sql`DROP TABLE auth_sessions`;
      yield* expectRefusal;
    }).pipe(Effect.provide(makeSessionCredentialLayer())),
  );

  it.effect("lists active sessions, tracks connectivity, and revokes other sessions", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const owner = yield* sessions.issue({
        subject: "desktop-bootstrap",
        role: "owner",
        client: {
          label: "Desktop app",
          deviceType: "desktop",
          os: "macOS",
          browser: "Electron",
        },
      });
      const client = yield* sessions.issue({
        subject: "one-time-token",
        role: "client",
        client: {
          label: "Julius iPhone",
          deviceType: "mobile",
          os: "iOS",
          browser: "Safari",
          ipAddress: "192.168.1.88",
        },
      });

      yield* sessions.markConnected(client.sessionId);
      const beforeRevoke = yield* sessions.listActive();
      const revokedCount = yield* sessions.revokeAllExcept(owner.sessionId);
      const afterRevoke = yield* sessions.listActive();
      const revokedClient = yield* Effect.flip(sessions.verify(client.token));

      expect(beforeRevoke).toHaveLength(2);
      expect(beforeRevoke.find((entry) => entry.sessionId === client.sessionId)?.connected).toBe(
        true,
      );
      expect(beforeRevoke.find((entry) => entry.sessionId === client.sessionId)?.client.label).toBe(
        "Julius iPhone",
      );
      expect(
        beforeRevoke.find((entry) => entry.sessionId === owner.sessionId)?.client.deviceType,
      ).toBe("desktop");
      expect(revokedCount).toBe(1);
      expect(afterRevoke).toHaveLength(1);
      expect(afterRevoke[0]?.sessionId).toBe(owner.sessionId);
      expect(revokedClient.message).toContain("revoked");
    }).pipe(Effect.provide(makeSessionCredentialLayer())),
  );

  it.effect("persists lastConnectedAt on first connect and updates it after reconnect", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const issued = yield* sessions.issue({
        subject: "reconnect-test",
        method: "bearer-session-token",
      });

      const beforeConnect = yield* sessions.listActive();
      expect(beforeConnect[0]?.lastConnectedAt).toBeNull();

      yield* TestClock.adjust(Duration.seconds(1));
      yield* sessions.markConnected(issued.sessionId);
      const firstConnect = yield* sessions.listActive();
      const firstConnectedAt = firstConnect[0]?.lastConnectedAt;

      expect(firstConnect[0]?.connected).toBe(true);
      expect(firstConnectedAt).not.toBeNull();

      yield* TestClock.adjust(Duration.seconds(1));
      yield* sessions.markConnected(issued.sessionId);
      const stillConnected = yield* sessions.listActive();

      expect(stillConnected[0]?.lastConnectedAt?.toString()).toBe(firstConnectedAt?.toString());

      yield* sessions.markDisconnected(issued.sessionId);
      yield* sessions.markDisconnected(issued.sessionId);
      const afterDisconnect = yield* sessions.listActive();

      expect(afterDisconnect[0]?.connected).toBe(false);
      expect(afterDisconnect[0]?.lastConnectedAt?.toString()).toBe(firstConnectedAt?.toString());

      yield* TestClock.adjust(Duration.seconds(1));
      yield* sessions.markConnected(issued.sessionId);
      const afterReconnect = yield* sessions.listActive();

      expect(afterReconnect[0]?.connected).toBe(true);
      expect(afterReconnect[0]?.lastConnectedAt).not.toBeNull();
      expect(afterReconnect[0]?.lastConnectedAt?.toString()).not.toBe(firstConnectedAt?.toString());
    }).pipe(Effect.provide(Layer.merge(makeSessionCredentialLayer(), TestClock.layer()))),
  );
});
