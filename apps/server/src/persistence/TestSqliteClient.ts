import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

type MemoryLayerConfig = {
  readonly busyTimeoutMs?: number;
};

export const layerMemory = (config: MemoryLayerConfig = {}): Layer.Layer<SqlClient.SqlClient> =>
  NodeSqliteClient.layerMemory(config);
