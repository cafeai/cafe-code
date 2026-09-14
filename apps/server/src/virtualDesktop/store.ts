import type { ThreadId, VirtualDesktopSnapshot } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export interface DesktopDefinition {
  readonly id: string;
  readonly name: string;
  readonly incarnation: string;
  readonly directory: string;
  readonly boot_id: string;
  readonly pid: number | null;
  readonly process_start: string | null;
  readonly state: VirtualDesktopSnapshot["state"];
  readonly created_at: number;
}
export interface DesktopStore {
  list(): Promise<readonly DesktopDefinition[]>;
  put(value: DesktopDefinition): Promise<void>;
  selected(threadId: ThreadId): Promise<string | null>;
  attach(threadId: ThreadId, id: string | null): Promise<void>;
  retire(id: string): Promise<void>;
  deleteStopped(id: string): Promise<boolean>;
  attached(id: string): Promise<boolean>;
}
export const makeDesktopStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const run = Effect.runPromise;
  // Abandoned future draft ids are collected only after a month. Live thread
  // relationships are protected by the projection; deletion uses the trigger.
  yield* sql`DELETE FROM virtual_desktop_attachments WHERE updated_at < ${Date.now() - 30 * 24 * 60 * 60 * 1000}
    AND NOT EXISTS (SELECT 1 FROM projection_threads WHERE thread_id = virtual_desktop_attachments.thread_id)`;
  return {
    // Delete attachments and the stopped definition atomically. A failed delete
    // must neither detach a live desktop nor leave a row that returns on reload.
    // The storage guard complements the manager's serialized lifecycle check.
    deleteStopped: (id) =>
      run(
        sql.withTransaction(
          Effect.gen(function* () {
            const [row] = yield* sql<
              Pick<DesktopDefinition, "state" | "pid" | "process_start">
            >`SELECT state,pid,process_start FROM virtual_desktops WHERE id=${id}`;
            if (!row) return true;
            if (row.state !== "stopped" || row.pid !== null || row.process_start !== null)
              return false;
            yield* sql`DELETE FROM virtual_desktop_attachments WHERE desktop_id=${id}`;
            yield* sql`DELETE FROM virtual_desktops WHERE id=${id}`;
            return true;
          }),
        ),
      ),
    attached: async (id) =>
      (await run(sql`SELECT 1 FROM virtual_desktop_attachments WHERE desktop_id = ${id} LIMIT 1`))
        .length > 0,
    retire: (id) =>
      run(
        sql`DELETE FROM virtual_desktop_attachments WHERE desktop_id = ${id}`.pipe(Effect.asVoid),
      ),
    list: () =>
      run(
        sql<DesktopDefinition>`SELECT * FROM virtual_desktops ORDER BY CASE WHEN pid IS NOT NULL THEN 0 WHEN state IN ('stopped','failed') THEN 2 ELSE 1 END, created_at DESC`,
      ),
    put: async (v) => {
      await run(
        sql`INSERT INTO virtual_desktops (id,name,incarnation,directory,boot_id,pid,process_start,state,created_at)
      VALUES (${v.id},${v.name},${v.incarnation},${v.directory},${v.boot_id},${v.pid},${v.process_start},${v.state},${v.created_at})
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,pid=excluded.pid,process_start=excluded.process_start,state=excluded.state`.pipe(
          Effect.asVoid,
        ),
      );
    },
    selected: async (threadId) =>
      (
        await run(
          sql<{
            desktop_id: string;
          }>`SELECT desktop_id FROM virtual_desktop_attachments WHERE thread_id=${threadId}`,
        )
      )[0]?.desktop_id ?? null,
    attach: (threadId, id) =>
      run(
        id === null
          ? sql`DELETE FROM virtual_desktop_attachments WHERE thread_id=${threadId}`.pipe(
              Effect.asVoid,
            )
          : sql`INSERT INTO virtual_desktop_attachments (thread_id,desktop_id,updated_at) VALUES (${threadId},${id},${Date.now()})
        ON CONFLICT(thread_id) DO UPDATE SET desktop_id=excluded.desktop_id,updated_at=excluded.updated_at`.pipe(
              Effect.asVoid,
            ),
      ),
  } satisfies DesktopStore;
});
