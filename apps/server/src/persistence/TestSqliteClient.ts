import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

type MemoryLayerConfig = {
  readonly busyTimeoutMs?: number;
};

type BunSqliteClientModule = {
  readonly layer: (config: {
    readonly filename: string;
    readonly disableWAL?: boolean;
  }) => Layer.Layer<SqlClient.SqlClient>;
};

type NodeSqliteClientModule = {
  readonly layerMemory: (config?: MemoryLayerConfig) => Layer.Layer<SqlClient.SqlClient>;
};

export const layerMemory = (config: MemoryLayerConfig = {}): Layer.Layer<SqlClient.SqlClient> =>
  Layer.unwrap(
    Effect.promise(async () => {
      if (process.versions.bun !== undefined) {
        const sqliteClient =
          (await import("@effect/sql-sqlite-bun/SqliteClient")) as BunSqliteClientModule;
        return sqliteClient.layer({
          filename: ":memory:",
          disableWAL: true,
        });
      }

      const sqliteClient = (await import("./NodeSqliteClient.ts")) as NodeSqliteClientModule;
      return sqliteClient.layerMemory(config);
    }),
  );
