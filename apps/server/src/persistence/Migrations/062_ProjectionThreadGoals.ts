import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /**
   * Goals are provider-owned thread state, not transcript messages. Keeping
   * them in a one-row-per-thread projection avoids adding objective text to
   * shell snapshots while still making detail reloads and reconnect recovery
   * deterministic. The objective is bounded again at the database boundary so
   * malformed replay data cannot grow this hot lookup without limit.
   */
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_goals (
      thread_id TEXT PRIMARY KEY,
      objective TEXT NOT NULL,
      status TEXT NOT NULL,
      token_budget INTEGER,
      tokens_used INTEGER NOT NULL,
      time_used_seconds INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      -- SQLite length(TEXT) counts Unicode code points, matching Codex's
      -- upstream objective limit rather than JavaScript UTF-16 code units.
      CHECK (length(objective) BETWEEN 1 AND 4000),
      CHECK (status IN (
        'active',
        'paused',
        'blocked',
        'usageLimited',
        'budgetLimited',
        'complete'
      )),
      CHECK (token_budget IS NULL OR (
        typeof(token_budget) = 'integer' AND token_budget > 0
      )),
      CHECK (typeof(tokens_used) = 'integer' AND tokens_used >= 0),
      CHECK (typeof(time_used_seconds) = 'integer' AND time_used_seconds >= 0)
    ) WITHOUT ROWID
  `;
});
