import * as Equal from "effect/Equal";
import {
  type HistoricalWorkLogSummary,
  type TimelineEntry,
  type WorkLogEntry,
} from "../../session-logic";
import { type ChatMessage, type ProposedPlan } from "../../types";
import { type MessageId, type TurnId } from "@cafecode/contracts";

export const MAX_VISIBLE_WORK_LOG_ENTRIES = 6;

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  completedAt?: string | undefined;
}

export type MessagesTimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
    }
  | {
      kind: "historical-work";
      id: string;
      createdAt: string;
      turnId: TurnId;
      summary: HistoricalWorkLogSummary;
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      durationStart: string;
      showCompletionDivider: boolean;
      completionSummary: string | null;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
      revertTurnCount?: number | undefined;
    }
  | {
      kind: "completion-divider";
      id: string;
      createdAt: string;
      completionSummary: string | null;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | { kind: "working"; id: string; createdAt: string | null };

export interface StableMessagesTimelineRowsState {
  byId: Map<string, MessagesTimelineRow>;
  result: MessagesTimelineRow[];
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && message.completedAt) {
      lastBoundary = message.completedAt;
    }
  }

  return result;
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

export function resolveAssistantMessageCopyState({
  text,
  showCopyButton,
}: {
  text: string | null;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const hasText = text !== null && text.trim().length > 0;
  return {
    text: hasText ? text : null,
    visible: showCopyButton && hasText,
  };
}

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  completionDividerAfterEntryId: string | null;
  completionSummary?: string | null;
  isWorking: boolean;
  activeTurnInProgress?: boolean;
  activeTurnId?: TurnId | null;
  activeTurnStartedAt: string | null;
  revertTurnCountByUserMessageId: ReadonlyMap<MessageId, number>;
  historicalWorkLogSummariesByTurnId?: ReadonlyMap<TurnId, HistoricalWorkLogSummary>;
}): MessagesTimelineRow[] {
  const nextRows: MessagesTimelineRow[] = [];
  const insertedHistoricalWorkTurnIds = new Set<TurnId>();
  const durationStartByMessageId = computeMessageDurationStart(
    input.timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );
  const pushHistoricalWorkRow = (turnId: TurnId | null | undefined, anchorCreatedAt: string) => {
    if (turnId === null || turnId === undefined || insertedHistoricalWorkTurnIds.has(turnId)) {
      return;
    }
    const summary = input.historicalWorkLogSummariesByTurnId?.get(turnId);
    if (!summary) {
      return;
    }
    insertedHistoricalWorkTurnIds.add(turnId);
    nextRows.push({
      kind: "historical-work",
      id: `historical-work:${turnId}`,
      createdAt: summary.previewEntries.at(-1)?.createdAt ?? anchorCreatedAt,
      turnId,
      summary,
    });
  };

  for (let index = 0; index < input.timelineEntries.length; index += 1) {
    const timelineEntry = input.timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    if (timelineEntry.kind === "work") {
      const groupedEntries = [timelineEntry.entry];
      let cursor = index + 1;
      while (cursor < input.timelineEntries.length) {
        const nextEntry = input.timelineEntries[cursor];
        if (!nextEntry || nextEntry.kind !== "work") break;
        groupedEntries.push(nextEntry.entry);
        cursor += 1;
      }
      nextRows.push({
        kind: "work",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        groupedEntries,
      });
      if (
        input.completionDividerAfterEntryId !== null &&
        groupedEntries.some((entry) => entry.id === input.completionDividerAfterEntryId)
      ) {
        nextRows.push({
          kind: "completion-divider",
          id: `completion-divider:${input.completionDividerAfterEntryId}`,
          createdAt: groupedEntries.at(-1)?.createdAt ?? timelineEntry.createdAt,
          completionSummary: input.completionSummary ?? null,
        });
      }
      index = cursor - 1;
      continue;
    }

    if (timelineEntry.kind === "proposed-plan") {
      nextRows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      });
      if (input.completionDividerAfterEntryId === timelineEntry.id) {
        nextRows.push({
          kind: "completion-divider",
          id: `completion-divider:${timelineEntry.id}`,
          createdAt: timelineEntry.createdAt,
          completionSummary: input.completionSummary ?? null,
        });
      }
      continue;
    }

    const message = timelineEntry.message;
    if (message.role !== "user") {
      pushHistoricalWorkRow(message.turnId, message.createdAt);
    }

    const assistantTurnStillInProgress =
      message.role === "assistant" &&
      input.activeTurnInProgress === true &&
      input.activeTurnId != null &&
      message.turnId === input.activeTurnId;

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message,
      durationStart: durationStartByMessageId.get(message.id) ?? message.createdAt,
      showCompletionDivider: false,
      completionSummary: null,
      showAssistantCopyButton: message.role === "assistant",
      assistantCopyStreaming: message.streaming || assistantTurnStillInProgress,
      revertTurnCount:
        message.role === "user" ? input.revertTurnCountByUserMessageId.get(message.id) : undefined,
    });
    if (message.role === "user") {
      pushHistoricalWorkRow(message.turnId, message.createdAt);
    }
    if (input.completionDividerAfterEntryId === timelineEntry.id) {
      nextRows.push({
        kind: "completion-divider",
        id: `completion-divider:${timelineEntry.id}`,
        createdAt: timelineEntry.createdAt,
        completionSummary: input.completionSummary ?? null,
      });
    }
  }

  if (input.isWorking) {
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt,
    });
  }

  return nextRows;
}

export function computeStableMessagesTimelineRows(
  rows: MessagesTimelineRow[],
  previous: StableMessagesTimelineRowsState,
): StableMessagesTimelineRowsState {
  const next = new Map<string, MessagesTimelineRow>();
  let anyChanged = rows.length !== previous.byId.size;

  const result = rows.map((row, index) => {
    const prevRow = previous.byId.get(row.id);
    const nextRow = prevRow && isRowUnchanged(prevRow, row) ? prevRow : row;
    next.set(row.id, nextRow);
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true;
    }
    return nextRow;
  });

  return anyChanged ? { byId: next, result } : previous;
}

/** Shallow field comparison per row variant — avoids deep equality cost. */
function isRowUnchanged(a: MessagesTimelineRow, b: MessagesTimelineRow): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;

  switch (a.kind) {
    case "working":
      return a.createdAt === (b as typeof a).createdAt;

    case "proposed-plan":
      return a.proposedPlan === (b as typeof a).proposedPlan;

    case "completion-divider":
      return (
        a.createdAt === (b as typeof a).createdAt &&
        a.completionSummary === (b as typeof a).completionSummary
      );

    case "work":
      return Equal.equals(a.groupedEntries, (b as typeof a).groupedEntries);

    case "historical-work": {
      const bh = b as typeof a;
      return (
        a.createdAt === bh.createdAt &&
        a.turnId === bh.turnId &&
        Equal.equals(a.summary, bh.summary)
      );
    }

    case "message": {
      const bm = b as typeof a;
      return (
        a.message === bm.message &&
        a.durationStart === bm.durationStart &&
        a.showCompletionDivider === bm.showCompletionDivider &&
        a.completionSummary === bm.completionSummary &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming &&
        a.revertTurnCount === bm.revertTurnCount
      );
    }
  }
}
