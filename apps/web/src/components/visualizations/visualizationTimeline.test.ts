import { MessageId, TurnId } from "@cafecode/contracts";
import type { VisualizationTimelineEntry } from "@cafecode/contracts/visualizationApi";
import {
  VisualizationArtifactId,
  VisualizationRevisionId,
} from "@cafecode/contracts/visualizations";
import { describe, expect, it } from "vitest";
import { deriveCompletionDividerAfterEntryId, deriveTimelineEntries } from "../../session-logic";
import {
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRows,
} from "../chat/MessagesTimeline.logic";
import { visualizationEntryIdentity } from "./visualizationEntryIdentity";

const artifactId = VisualizationArtifactId.make("8bdd2475-78f0-4563-9829-f29b073c0689");
const revisionId = VisualizationRevisionId.make("4e27bd63-c586-4f50-99b5-a722994d41dc");
const turnId = TurnId.make("visualization-history-turn");
const visualization: VisualizationTimelineEntry = {
  messageId: MessageId.make("visualization-history-message"),
  turnId,
  originItemId: "exact-origin",
  occurredAt: "2026-10-12T00:00:03.000Z",
  actor: { type: "root" },
  reference: {
    version: 1,
    purpose: "generated-visualization",
    artifactId,
    revisionId,
    title: "History fixture",
    width: 640,
    height: 240,
  },
};

describe("compact visualization timeline integration", () => {
  it("retains a durable artifact independently of the activity tail and anchors its exact turn completion", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: visualization.messageId,
          turnId,
          role: "assistant",
          text: "Final",
          createdAt: "2026-10-12T00:00:02.000Z",
          streaming: false,
        },
      ],
      [],
      [],
      [visualization],
    );
    const id = `visualization:${visualizationEntryIdentity(visualization)}`;
    expect(entries.map((entry) => entry.kind)).toEqual(["message", "visualization"]);
    expect(entries[1]).toEqual({
      id,
      kind: "visualization",
      createdAt: visualization.occurredAt,
      visualization,
    });
    expect(
      deriveCompletionDividerAfterEntryId(entries, {
        turnId,
        assistantMessageId: visualization.messageId,
        startedAt: "2026-10-12T00:00:01.000Z",
        completedAt: "2026-10-12T00:00:04.000Z",
      }),
    ).toBe(id);
    expect(JSON.stringify(entries)).not.toContain("rawJson");
    expect(JSON.stringify(entries)).not.toContain("source");
  });
  it("keeps stable recycled-row identity without leaking native viewer or private inspector state", () => {
    const timelineEntries = deriveTimelineEntries([], [], [], [visualization]);
    const rows = deriveMessagesTimelineRows({
      timelineEntries,
      completionDividerAfterEntryId: timelineEntries[0]!.id,
      isWorking: false,
      activeTurnStartedAt: null,
      revertTurnCountByUserMessageId: new Map(),
    });
    expect(rows.map((row) => row.kind)).toEqual(["visualization", "completion-divider"]);
    const first = computeStableMessagesTimelineRows(rows, { byId: new Map(), result: [] });
    const second = computeStableMessagesTimelineRows(
      deriveMessagesTimelineRows({
        timelineEntries,
        completionDividerAfterEntryId: timelineEntries[0]!.id,
        isWorking: false,
        activeTurnStartedAt: null,
        revertTurnCountByUserMessageId: new Map(),
      }),
      first,
    );
    expect(second).toBe(first);
    expect(second.result[0]).toBe(first.result[0]);
    expect(second.result[0]).not.toHaveProperty("leaseId");
    expect(second.result[0]).not.toHaveProperty("rawJson");
  });
  it("does not anchor another turn's completion to a more recent artifact", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: visualization.messageId,
          turnId,
          role: "assistant",
          text: "Final",
          createdAt: "2026-10-12T00:00:02.000Z",
          streaming: false,
        },
      ],
      [],
      [],
      [{ ...visualization, turnId: TurnId.make("other-turn") }],
    );
    expect(
      deriveCompletionDividerAfterEntryId(entries, {
        turnId,
        assistantMessageId: visualization.messageId,
        startedAt: "2026-10-12T00:00:01.000Z",
        completedAt: "2026-10-12T00:00:04.000Z",
      }),
    ).toBe(visualization.messageId);
  });
  it("keeps separate root and child invocation rows when immutable content is reused", () => {
    const child: VisualizationTimelineEntry = {
      ...visualization,
      messageId: MessageId.make("child-message"),
      turnId: TurnId.make("child-turn"),
      originItemId: "child-origin",
      actor: { type: "child", id: "exact-child", label: "Inspector" },
    };
    const entries = deriveTimelineEntries([], [], [], [visualization, child]);
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(2);
    expect(entries[0]?.kind === "visualization" && entries[0].visualization.actor).toEqual({
      type: "root",
    });
    expect(entries[1]?.kind === "visualization" && entries[1].visualization.actor).toEqual(
      child.actor,
    );
    const rows = deriveMessagesTimelineRows({
      timelineEntries: entries,
      completionDividerAfterEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
      revertTurnCountByUserMessageId: new Map(),
    });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    const reframed = {
      ...visualization,
      messageId: MessageId.make('a","b'),
      originItemId: "c",
    };
    const different = {
      ...visualization,
      messageId: MessageId.make("a"),
      originItemId: 'b","c',
    };
    expect(visualizationEntryIdentity(reframed)).not.toBe(visualizationEntryIdentity(different));
    expect(
      visualizationEntryIdentity({
        ...child,
        actor: { type: "child", id: "exact-child", label: "Renamed" },
      }),
    ).toBe(visualizationEntryIdentity(child));
  });
});
