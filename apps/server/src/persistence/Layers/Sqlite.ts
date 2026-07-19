import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { ServerConfig } from "../../config.ts";

type RuntimeSqliteLayerConfig = {
  readonly filename: string;
  readonly busyTimeoutMs?: number;
  readonly disableWAL?: boolean;
  readonly spanAttributes?: Record<string, unknown>;
};

export const SQLITE_BUSY_TIMEOUT_MS = 15_000;

const makeRuntimeSqliteLayer = (config: RuntimeSqliteLayerConfig) => NodeSqliteClient.layer(config);

const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA busy_timeout = 15000;`;
    yield* sql`PRAGMA journal_mode = WAL;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    yield* runMigrations();
  }),
);

export const makeSqlitePersistenceLive = Effect.fn("makeSqlitePersistenceLive")(function* (
  dbPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

  return Layer.provideMerge(
    setup,
    makeRuntimeSqliteLayer({
      filename: dbPath,
      busyTimeoutMs: SQLITE_BUSY_TIMEOUT_MS,
      disableWAL: true,
      spanAttributes: {
        "db.name": path.basename(dbPath),
        "service.name": "cafe-code-server",
      },
    }),
  );
}, Layer.unwrap);

export const SqlitePersistenceMemory = Layer.provideMerge(
  setup,
  makeRuntimeSqliteLayer({
    filename: ":memory:",
    busyTimeoutMs: SQLITE_BUSY_TIMEOUT_MS,
    disableWAL: true,
  }),
);

export const layerConfig = Layer.unwrap(
  Effect.map(Effect.service(ServerConfig), ({ dbPath }) => makeSqlitePersistenceLive(dbPath)),
);
