import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Clock from "effect/Clock";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { AuthSessionId, EnvironmentId } from "@cafecode/contracts";
import { randomOpaque } from "@cafecode/relay/bytes";
import { SqlitePersistenceTest } from "../persistence/Sqlite.test.fixture.ts";
import { ServerConfig } from "../config.ts";
import { ServerAuthLive } from "../auth/Layers/ServerAuth.ts";
import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore.ts";
import { ServerAuth } from "../auth/Services/ServerAuth.ts";
import { SessionCredentialService } from "../auth/Services/SessionCredentialService.ts";
import { TwoFactorService } from "../auth/Services/TwoFactorService.ts";
import { totpAtStep } from "../auth/totp.ts";
import { makeRelayAuth } from "./auth.ts";

const dependencies = ServerAuthLive.pipe(
  Layer.provide(ServerSecretStoreLive),
  Layer.provideMerge(SqlitePersistenceTest),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "cafe-relay-auth-" })),
);
const scope = () => ({
  networkId: randomOpaque(),
  hostKey: randomOpaque(),
  environmentId: EnvironmentId.make("relay-auth-test"),
  deviceKey: randomOpaque(),
});

it.layer(NodeServices.layer)("durable Cafe relay auth", (it) => {
  it.effect(
    "commits device/session together, rejects bearer-only enrollment, and honors revocation",
    () =>
      Effect.gen(function* () {
        const relay = yield* makeRelayAuth,
          sql = yield* SqlClient.SqlClient,
          ordinary = yield* ServerAuth,
          sessions = yield* SessionCredentialService;
        const binding = scope(),
          invitation = yield* relay.issue({ ...binding, role: "client" });
        const revoked = yield* relay.issue({ ...binding, role: "client" });
        expect(yield* relay.revoke(revoked.id)).toBe(true);
        expect(
          (yield* relay
            .authenticate(binding, {
              environmentId: binding.environmentId,
              operation: "pair",
              credential: revoked.secret,
            })
            .pipe(Effect.flip)).code,
        ).toBe("AUTH_REJECTED");
        expect(
          (yield* ordinary
            .exchangeBootstrapCredentialForBearerSession(invitation.secret, {
              deviceType: "unknown",
            })
            .pipe(Effect.flip)).status,
        ).toBe(401);
        const input = {
          environmentId: binding.environmentId,
          operation: "pair" as const,
          credential: invitation.secret,
        };
        yield* sql`CREATE TRIGGER reject_relay_binding BEFORE INSERT ON relay_device_sessions BEGIN SELECT RAISE(ABORT, 'synthetic-refusal'); END`;
        yield* relay.authenticate(binding, input).pipe(Effect.flip);
        expect((yield* sql`SELECT COUNT(*) AS count FROM auth_sessions`)[0]?.count).toBe(0);
        expect((yield* sql`SELECT COUNT(*) AS count FROM relay_device_sessions`)[0]?.count).toBe(0);
        expect(
          (yield* sql`SELECT consumed_at FROM relay_invitations WHERE id=${invitation.id}`)[0]
            ?.consumed_at,
        ).toBeNull();
        yield* sql`DROP TRIGGER reject_relay_binding`;
        const paired = yield* relay.authenticate(binding, input);
        expect(paired.result.role).toBe("client");
        yield* relay.authenticate(binding, input).pipe(Effect.flip);
        const resume = {
          environmentId: binding.environmentId,
          operation: "resume" as const,
          credential: paired.result.bearerToken,
        };
        expect((yield* relay.authenticate(binding, resume)).session.sessionId).toBe(
          paired.session.sessionId,
        );
        expect(
          (yield* relay
            .authenticate({ ...binding, deviceKey: randomOpaque() }, resume)
            .pipe(Effect.flip)).code,
        ).toBe("AUTH_REJECTED");
        const bearerAlone = yield* sessions.issue({
          method: "bearer-session-token",
          role: "owner",
        });
        expect(
          (yield* relay
            .authenticate(binding, { ...resume, credential: bearerAlone.token })
            .pipe(Effect.flip)).code,
        ).toBe("AUTH_REJECTED");
        expect(
          (yield* relay
            .authenticate(binding, { ...resume, environmentId: "foreign-environment" })
            .pipe(Effect.flip)).code,
        ).toBe("ENVIRONMENT_MISMATCH");
        yield* sessions.revoke(paired.session.sessionId);
        expect((yield* relay.authenticate(binding, resume).pipe(Effect.flip)).code).toBe(
          "AUTH_REJECTED",
        );
      }).pipe(Effect.provide(dependencies)),
  );

  it.effect(
    "leaves an invitation unconsumed for missing/wrong 2FA and permits one competing commit",
    () =>
      Effect.gen(function* () {
        const relay = yield* makeRelayAuth,
          factor = yield* TwoFactorService,
          sql = yield* SqlClient.SqlClient;
        const setupOwner = AuthSessionId.make("relay-factor-owner"),
          setup = yield* factor.begin(setupOwner);
        yield* factor.enable(
          setupOwner,
          totpAtStep(setup.secret, Math.floor((yield* Clock.currentTimeMillis) / 30_000)),
        );
        const binding = scope(),
          invitation = yield* relay.issue({ ...binding, role: "owner" }),
          input = {
            environmentId: binding.environmentId,
            operation: "pair" as const,
            credential: invitation.secret,
          };
        expect((yield* relay.authenticate(binding, input).pipe(Effect.flip)).code).toBe(
          "SECOND_FACTOR_REQUIRED",
        );
        expect(
          (yield* relay
            .authenticate(binding, { ...input, secondFactor: "not-an-otp" })
            .pipe(Effect.flip)).code,
        ).toBe("AUTH_REJECTED");
        expect((yield* sql`SELECT consumed_at FROM relay_invitations`)[0]?.consumed_at).toBeNull();
        yield* TestClock.adjust("30 seconds");
        const secondFactor = totpAtStep(
          setup.secret,
          Math.floor((yield* Clock.currentTimeMillis) / 30_000),
        );
        const results = yield* Effect.all(
          [
            relay.authenticate(binding, { ...input, secondFactor }).pipe(Effect.result),
            relay
              .authenticate({ ...binding, deviceKey: randomOpaque() }, { ...input, secondFactor })
              .pipe(Effect.result),
          ],
          { concurrency: 2 },
        );
        expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
        expect((yield* sql`SELECT COUNT(*) AS count FROM relay_device_sessions`)[0]?.count).toBe(1);
        expect((yield* sql`SELECT COUNT(*) AS count FROM auth_sessions`)[0]?.count).toBe(1);
      }).pipe(Effect.provide(dependencies)),
  );
});
