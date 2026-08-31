import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(TestSqliteClient.layerMemory()));

layer("071_ProviderDaemonHardDeleteIdentity", (it) => {
  it.effect("installs empty sidecars without scanning or backfilling legacy bodies", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 70 });
      yield* sql`
        INSERT INTO provider_daemon_events (owner_key, emitted_at, event_json)
        VALUES (
          'provider-daemon',
          '2026-08-31T00:00:00.000Z',
          '{"legacy":"event body remains for on-demand typed hydration"}'
        )
      `;
      yield* sql`
        INSERT INTO provider_daemon_commands (
          command_id, method, status, request_json, created_at, updated_at
        ) VALUES (
          'provider-daemon:legacy-command',
          'sendTurn',
          'running',
          '{"legacy":"command body remains for on-demand typed hydration"}',
          '2026-08-31T00:00:00.000Z',
          '2026-08-31T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 71 });

      const counts = yield* sql<{
        readonly eventBodies: number;
        readonly eventIdentities: number;
        readonly commandBodies: number;
        readonly commandIdentities: number;
        readonly indexedCommands: number;
      }>`
        SELECT
          (SELECT COUNT(*) FROM provider_daemon_events) AS "eventBodies",
          (SELECT COUNT(*) FROM provider_daemon_event_threads) AS "eventIdentities",
          (SELECT COUNT(*) FROM provider_daemon_commands) AS "commandBodies",
          (SELECT COUNT(*) FROM provider_daemon_command_threads) AS "commandIdentities",
          (SELECT COUNT(*) FROM provider_daemon_indexed_commands) AS "indexedCommands"
      `;
      assert.deepEqual(counts, [
        {
          eventBodies: 1,
          eventIdentities: 0,
          commandBodies: 1,
          commandIdentities: 0,
          indexedCommands: 0,
        },
      ]);
    }),
  );
});
