import { describe, expect, it } from "vitest";
import {
  EventId,
  ProviderInstanceId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@cafecode/contracts";

import { deriveSubagentActivities, type SubagentRuntimeContext } from "./subagent-activity";
import { deriveActiveSubagentWorkEntries, deriveHistoricalWorkLogSummaries } from "./session-logic";

const oldTurn = TurnId.make("older-parent-turn");
const currentTurn = TurnId.make("current-parent-turn");
const runtimeSession: SubagentRuntimeContext = {
  subagentRuntimeId: "native-runtime-a",
  orchestrationStatus: "ready",
};

function activity(
  kind: "task.started" | "task.progress" | "task.completed",
  sequence: number,
  runtimeId: string | undefined = "native-runtime-a",
  label = "Audit worker",
  childId = "exact-child",
) {
  return {
    id: EventId.make(`child-event-${sequence}`),
    turnId: oldTurn,
    kind,
    sequence,
    tone: "info",
    summary: "Subagent update",
    // A very old start is deliberate: age is not evidence of completion.
    createdAt: `2026-01-01T00:00:0${sequence}.000Z`,
    payload: {
      taskId: childId,
      ...(kind === "task.completed" ? { status: "completed" } : {}),
      subagent: {
        threadId: childId,
        historyId: "exact-public-history",
        label,
        status: kind === "task.completed" ? "completed" : "active",
        ...(runtimeId !== undefined ? { runtimeId } : {}),
      },
    },
  } satisfies OrchestrationThreadActivity;
}

describe("subagent native runtime liveness overlay", () => {
  it("revokes an older task receipt on liveness-only progress without hiding the live child", () => {
    const capability = {
      providerInstanceId: ProviderInstanceId.make("claude-account"),
      taskGeneration: "00000000-0000-4000-8000-000000000002",
      canStop: true,
      canBackground: false,
    };
    const base = activity("task.started", 1);
    const started = {
      ...base,
      payload: { ...base.payload, subagent: { ...base.payload.subagent, taskControl: capability } },
    };
    const newerLevel = activity("task.progress", 2);
    expect(deriveSubagentActivities([started], { runtimeSession })[0]?.taskControl).toEqual(
      capability,
    );
    // The provider has observed a newer native run, but its explicit start
    // bookend has not arrived. A complete progress sibling omits controls,
    // and neither durable replay nor Work Log conversion may inherit them.
    for (const rows of [
      [started, newerLevel],
      [newerLevel, started],
    ]) {
      const child = deriveSubagentActivities(rows, { runtimeSession })[0];
      expect(child).toMatchObject({ status: "active", id: "exact-child" });
      expect(child?.taskControl).toBeUndefined();
      expect(
        deriveActiveSubagentWorkEntries(rows, currentTurn, { runtimeSession })[0]?.subagent
          ?.taskControl,
      ).toBeUndefined();
    }
  });

  it("keeps quiet older-turn children active across ready parent state and renderer reconnects", () => {
    const rows = [activity("task.started", 1)];
    const first = deriveSubagentActivities(rows, { runtimeSession });
    const reconnected = deriveSubagentActivities([...rows], {
      runtimeSession: { ...runtimeSession },
    });
    expect(first).toEqual(reconnected);
    expect(first[0]).toMatchObject({ status: "active", startedAt: rows[0]!.createdAt });
    expect(deriveActiveSubagentWorkEntries(rows, currentTurn, { runtimeSession })).toHaveLength(1);
  });

  it("keeps surviving children live after a failed root without reopening terminal children", () => {
    // A definitive root failure does not terminate its app-server context. The
    // backend publishes ready only after independently verifying that exact
    // native context, while retaining the root's failure separately. Renderer
    // liveness must follow that publication, not the parent turn's outcome.
    const survivingSession = {
      ...runtimeSession,
      lastError: "Synthetic root request failed.",
    };
    const rows = [
      activity("task.started", 1, "native-runtime-a", "Surviving worker", "live-child"),
      activity("task.completed", 2, "native-runtime-a", "Settled worker", "terminal-child"),
      activity("task.progress", 3, "native-runtime-a", "Settled worker", "terminal-child"),
    ];
    const snapshot = structuredClone(rows);
    const children = deriveSubagentActivities(rows, {
      terminalTurnIds: new Set([oldTurn]),
      runtimeSession: survivingSession,
    });
    expect(children.map((child) => [child.id, child.status])).toEqual([
      ["live-child", "active"],
      ["terminal-child", "completed"],
    ]);
    // No running parent is required for canonical native child lifecycle.
    expect(
      deriveActiveSubagentWorkEntries(rows, null, { runtimeSession: survivingSession }).map(
        (entry) => entry.subagent?.id,
      ),
    ).toEqual(["live-child"]);
    expect(rows).toEqual(snapshot);
  });

  it.each([
    null,
    { orchestrationStatus: "ready" as const },
    { ...runtimeSession, subagentRuntimeId: "native-runtime-b" },
    { ...runtimeSession, orchestrationStatus: "stopped" as const },
    { ...runtimeSession, orchestrationStatus: "error" as const },
    { ...runtimeSession, subagentRuntimeId: null },
  ])(
    "makes retained nonterminal children unknown when current native evidence is %j",
    (session) => {
      const rows = [activity("task.started", 1)];
      const snapshot = structuredClone(rows);
      const [child] = deriveSubagentActivities(rows, { runtimeSession: session });
      expect(child).toMatchObject({
        id: "exact-child",
        historyId: "exact-public-history",
        label: "Audit worker",
        status: "unknown",
        startedAt: rows[0]!.createdAt,
      });
      expect(child?.completedAt).toBeUndefined();
      expect(
        deriveActiveSubagentWorkEntries(rows, currentTurn, { runtimeSession: session }),
      ).toEqual([]);
      expect(rows).toEqual(snapshot);
    },
  );

  it("never borrows runtime evidence for unstamped old rows", () => {
    const row = activity("task.started", 1);
    const payload = row.payload as { subagent: { runtimeId?: string } };
    delete payload.subagent.runtimeId;
    expect(deriveSubagentActivities([row], { runtimeSession })[0]?.status).toBe("unknown");
  });

  it("requires a fresh native observation before old work becomes live in a replacement runtime", () => {
    const old = activity("task.started", 1);
    const replacement = { ...runtimeSession, subagentRuntimeId: "native-runtime-b" };
    expect(deriveSubagentActivities([old], { runtimeSession: replacement })[0]?.status).toBe(
      "unknown",
    );
    const [confirmed] = deriveSubagentActivities(
      [old, activity("task.progress", 2, "native-runtime-b")],
      { runtimeSession: replacement },
    );
    expect(confirmed).toMatchObject({ status: "active", startedAt: "2026-01-01T00:00:02.000Z" });
    const [unstamped] = deriveSubagentActivities(
      [
        old,
        {
          ...activity("task.progress", 2),
          payload: {
            taskId: "exact-child",
            subagent: { threadId: "exact-child", status: "active" },
          },
        },
      ],
      { runtimeSession },
    );
    // A delayed unstamped row cannot downgrade an exact current witness.
    expect(unstamped?.status).toBe("active");
  });

  it("keeps same-runtime completion terminal despite delayed progress and only reopens on explicit start", () => {
    const rows = [activity("task.started", 1), activity("task.completed", 2)];
    const replacement = runtimeSession;
    const delayed = activity("task.progress", 3);
    expect(
      deriveSubagentActivities([...rows, delayed], { runtimeSession: replacement })[0],
    ).toMatchObject({ status: "completed", completedAt: rows[1]!.createdAt });
    const restarted = activity("task.started", 4);
    expect(
      deriveSubagentActivities([...rows, delayed, restarted], { runtimeSession: replacement })[0],
    ).toMatchObject({ status: "active", startedAt: restarted.createdAt });
  });

  it("uses the latest structured label when a live child is renamed", () => {
    const started = activity("task.started", 1, "native-runtime-a", "Initial worker title");
    const renamed = activity("task.progress", 2, "native-runtime-a", "Fresh worker title");

    expect(deriveSubagentActivities([started, renamed], { runtimeSession })[0]).toMatchObject({
      label: "Fresh worker title",
      status: "active",
      startedAt: started.createdAt,
    });
  });

  it("uses the fresh structured label when an explicit start reopens a terminal child", () => {
    const started = activity("task.started", 1, "native-runtime-a", "Completed worker title");
    const completed = activity("task.completed", 2, "native-runtime-a", "Completed worker title");
    const restarted = activity("task.started", 3, "native-runtime-a", "New worker title");

    expect(
      deriveSubagentActivities([started, completed, restarted], { runtimeSession })[0],
    ).toMatchObject({
      label: "New worker title",
      status: "active",
      startedAt: restarted.createdAt,
    });
  });

  it("retracts an assistant-first provisional identity before showing its authoritative task", () => {
    const provisional = activity(
      "task.progress",
      1,
      "native-runtime-a",
      "Recovered child title",
      "agent-tool-assistant-first",
    );
    const independent = activity(
      "task.progress",
      2,
      "native-runtime-a",
      "Independent child title",
      "agent-tool-independent",
    );
    const retractionBase = activity(
      "task.progress",
      3,
      "native-runtime-a",
      "Recovered child title",
      "agent-tool-assistant-first",
    );
    const retraction: OrchestrationThreadActivity = {
      ...retractionBase,
      payload: {
        ...retractionBase.payload,
        visibility: "ambient",
      },
    };
    const authoritative = activity(
      "task.started",
      4,
      "native-runtime-a",
      "Authoritative child title",
      "task-assistant-first",
    );

    const rows = deriveSubagentActivities([provisional, independent, retraction, authoritative], {
      runtimeSession,
    });
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "agent-tool-independent",
          label: "Independent child title",
          status: "active",
        }),
        expect.objectContaining({
          id: "task-assistant-first",
          label: "Authoritative child title",
          status: "active",
        }),
      ]),
    );
  });

  it.each(["task.progress", "task.completed"] as const)(
    "does not let delayed foreign-runtime %s supersede exact current native evidence",
    (kind) => {
      const replacement = { ...runtimeSession, subagentRuntimeId: "native-runtime-b" };
      const old = activity("task.started", 1);
      const fresh = activity("task.progress", 2, "native-runtime-b");
      const delayed = activity(kind, 3);
      const [row] = deriveSubagentActivities([old, fresh, delayed], {
        runtimeSession: replacement,
      });
      expect(row).toMatchObject({
        status: "active",
        runtimeId: "native-runtime-b",
        updatedAt: fresh.createdAt,
      });
      const unstamped = {
        ...delayed,
        payload: {
          taskId: "exact-child",
          subagent: { threadId: "exact-child", status: "completed" },
        },
      };
      expect(
        deriveSubagentActivities([old, fresh, unstamped], { runtimeSession: replacement })[0],
      ).toMatchObject({ status: "active", runtimeId: "native-runtime-b" });
    },
  );

  it("accepts exact current runtime metadata after an older runtime's recorded completion", () => {
    const oldRows = [activity("task.started", 1), activity("task.completed", 2)];
    const replacement = { ...runtimeSession, subagentRuntimeId: "native-runtime-b" };
    const confirmed = activity("task.progress", 3, "native-runtime-b");
    const [row] = deriveSubagentActivities([...oldRows, confirmed], {
      runtimeSession: replacement,
    });
    expect(row).toMatchObject({ status: "active", runtimeId: "native-runtime-b" });
    expect(row?.completedAt).toBeUndefined();
  });

  it("rejects foreign-runtime visibility tombstones but applies current native retraction", () => {
    const fresh = activity("task.progress", 1);
    const hidden = {
      ...activity("task.progress", 2, "native-runtime-b"),
      payload: {
        taskId: "exact-child",
        visibility: "ambient",
        subagent: {
          threadId: "exact-child",
          runtimeId: "native-runtime-b",
        },
      },
    };
    expect(deriveSubagentActivities([fresh, hidden], { runtimeSession })[0]?.status).toBe("active");
    hidden.payload.subagent.runtimeId = "native-runtime-a";
    expect(deriveSubagentActivities([fresh, hidden], { runtimeSession })).toEqual([]);
  });

  it("retains unknown workers in historical summaries with exact detail binding", () => {
    const summaries = deriveHistoricalWorkLogSummaries({
      messages: [],
      activities: [activity("task.started", 1)],
      latestTurnId: currentTurn,
      runtimeSession: null,
    });
    expect(summaries.get(oldTurn)?.subagentEntries?.[0]?.subagent).toMatchObject({
      status: "unknown",
      id: "exact-child",
      historyId: "exact-public-history",
    });
  });
});
