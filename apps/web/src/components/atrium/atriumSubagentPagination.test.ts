import { describe, expect, it } from "vitest";

import {
  ATRIUM_SUBAGENT_PAGE_SIZE,
  paginateAtriumSubagents,
  partitionAtriumSubagents,
} from "./atriumSubagentPagination";
import type { AtriumSubagent } from "./taskAtriumData";

function worker(
  rowKey: string,
  status: AtriumSubagent["status"],
  observedAt: number,
  overrides: Partial<AtriumSubagent> = {},
): AtriumSubagent {
  return {
    rowKey,
    id: `child-${rowKey}`,
    label: `Worker ${rowKey}`,
    detail: "Retained provider observation",
    status,
    running: status === "active" || status === "waiting",
    startedAt: 1,
    completedAt: null,
    activity: {
      id: `child-${rowKey}`,
      rowId: rowKey,
      turnId: null,
      label: `Worker ${rowKey}`,
      status,
      startedAt: new Date(1).toISOString(),
      updatedAt: new Date(observedAt).toISOString(),
      lifecycleRevision: `revision-${rowKey}`,
    },
    ...overrides,
  };
}

describe("Atrium subagent presentation paging", () => {
  it("keeps only confirmed live rows active and retains every other outcome in history", () => {
    const rows = [
      worker("active", "active", 1),
      worker("done", "completed", 2),
      worker("waiting", "waiting", 3),
      worker("failed", "failed", 4),
      worker("stopped", "stopped", 5),
      worker("unknown", "unknown", 6),
      worker("unconfirmed", "active", 7, { running: false }),
    ];
    const original = [...rows];
    Object.freeze(rows);
    const groups = partitionAtriumSubagents(rows);
    expect(groups.active.map((row) => row.rowKey)).toEqual(["active", "waiting"]);
    expect(groups.history.map((row) => row.rowKey)).toEqual([
      "unconfirmed",
      "unknown",
      "stopped",
      "failed",
      "done",
    ]);
    expect([...groups.active, ...groups.history]).toHaveLength(rows.length);
    expect(rows).toEqual(original);
    for (const row of [...groups.active, ...groups.history]) expect(rows).toContain(row);
  });

  it("sorts history newest first using completion then observation and deterministic row keys", () => {
    const lateRename = worker("renamed", "completed", 100, { completedAt: 10 });
    const recent = worker("recent", "unknown", 50);
    const tieB = worker("tie-b", "failed", 30);
    const tieA = worker("tie-a", "stopped", 30);
    const { history } = partitionAtriumSubagents([lateRename, tieB, recent, tieA]);
    expect(history.map((row) => row.rowKey)).toEqual(["recent", "tie-a", "tie-b", "renamed"]);
    expect(recent.completedAt).toBeNull();
    expect(recent.activity.status).toBe("unknown");
  });

  it("uses finite start metadata only when historical observation dates are unavailable", () => {
    const old = worker("old", "unknown", 1, { startedAt: 10, completedAt: Number.NaN });
    old.activity.updatedAt = "unavailable";
    const missing = worker("missing", "unknown", 1, { startedAt: null });
    missing.activity.updatedAt = "unavailable";
    expect(partitionAtriumSubagents([missing, old]).history).toEqual([old, missing]);
  });

  it("visits all 800 history rows in bounded pages without mutating or dropping identities", () => {
    const rows = Array.from({ length: 800 }, (_, index) =>
      worker(`history-${index.toString().padStart(3, "0")}`, "completed", index),
    );
    const { history } = partitionAtriumSubagents(rows);
    const visited: AtriumSubagent[] = [];
    for (let index = 0; index < 160; index += 1) {
      const page = paginateAtriumSubagents(history, index);
      expect(page.rows).toHaveLength(ATRIUM_SUBAGENT_PAGE_SIZE);
      expect(page).toMatchObject({
        total: 800,
        pageCount: 160,
        pageIndex: index,
        start: index * 5 + 1,
        end: index * 5 + 5,
      });
      visited.push(...page.rows);
    }
    expect(visited).toEqual(history);
    expect(new Set(visited.map((row) => row.rowKey)).size).toBe(800);
    expect(rows[0]?.rowKey).toBe("history-000");
  });

  it("applies the same five-row ceiling to active workers and partial last pages", () => {
    const rows = Array.from({ length: 8 }, (_, index) => worker(String(index), "active", index));
    const { active } = partitionAtriumSubagents(rows);
    expect(paginateAtriumSubagents(active, 0).rows).toEqual(rows.slice(0, 5));
    expect(paginateAtriumSubagents(active, 1)).toMatchObject({
      rows: rows.slice(5),
      start: 6,
      end: 8,
      pageIndex: 1,
      pageCount: 2,
    });
  });

  it("clamps a shrinking roster immediately and handles an empty view without phantom ranges", () => {
    expect(paginateAtriumSubagents(["remaining"], 159)).toEqual({
      rows: ["remaining"],
      total: 1,
      start: 1,
      end: 1,
      pageIndex: 0,
      pageCount: 1,
    });
    expect(paginateAtriumSubagents([], 159)).toEqual({
      rows: [],
      total: 0,
      start: 0,
      end: 0,
      pageIndex: 0,
      pageCount: 1,
    });
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "normalizes invalid local page input %s without losing rows",
    (pageIndex) => {
      expect(paginateAtriumSubagents(["only"], pageIndex).rows).toEqual(["only"]);
      expect(paginateAtriumSubagents(["only"], pageIndex).pageIndex).toBe(0);
    },
  );
});
