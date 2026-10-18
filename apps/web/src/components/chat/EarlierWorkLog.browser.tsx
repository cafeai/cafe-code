import "../../index.css";

import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  EventId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type EnvironmentApi,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type OrchestrationThreadActivityCursor,
  type OrchestrationThreadTurnActivityPageInput,
  type OrchestrationThreadTurnWorkLogPresenceInput,
} from "@cafecode/contracts";
import { getUiLocale, setUiLocale, uiText } from "@cafecode/shared/i18n";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cdp, page } from "vitest/browser";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { applyInterfaceScalePercent } from "../../interfaceScale";
import {
  deriveHistoricalWorkLogSummaries,
  deriveTimelineEntries,
  deriveWorkLogEntries,
} from "../../session-logic";
import { applyOrchestrationEvents, selectThreadByRef, syncServerThreadDetail } from "../../store";
import { MessagesTimeline } from "./MessagesTimeline";

// Keep the real timeline, store reducer, derivation, controls and browser input.
// The virtualizer has separate real-list coverage; this deterministic shell
// exposes every derived row so ownership/paging assertions cannot depend on
// unrelated scroll measurement or accidentally inspect an offscreen row.
vi.mock("@legendapp/list/react", async () => {
  const React = await import("react");
  return {
    LegendList: (props: {
      data: Array<{ id: string }>;
      keyExtractor: (item: { id: string }) => string;
      renderItem: (input: { item: { id: string } }) => React.ReactNode;
      ListHeaderComponent?: React.ReactNode;
      ListFooterComponent?: React.ReactNode;
      ref?: React.Ref<LegendListRef>;
    }) => {
      React.useImperativeHandle(
        props.ref,
        () =>
          ({
            scrollToEnd: vi.fn(),
            scrollToIndex: vi.fn(),
            getState: () => ({ isAtEnd: true }),
          }) as unknown as LegendListRef,
      );
      return (
        <div data-earlier-work-list="true">
          {props.ListHeaderComponent}
          {props.data.map((item) => (
            <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
          ))}
          {props.ListFooterComponent}
        </div>
      );
    },
  };
});

type Provider = "codex" | "claudeAgent";
const TURN_ID = TurnId.make("synthetic-long-running-turn");
const BASE_TIME = Date.parse("2026-10-10T12:00:00.000Z");
const time = (sequence: number) => new Date(BASE_TIME + sequence * 1_000).toISOString();

function toolActivity(
  provider: Provider,
  sequence: number,
  label: string,
  itemId: string,
  kind: "tool.updated" | "tool.completed" = "tool.completed",
): OrchestrationThreadActivity {
  return {
    id: EventId.make(`${itemId}:${sequence}`),
    turnId: TURN_ID,
    sequence,
    createdAt: time(sequence),
    tone: "tool",
    kind,
    summary: label,
    payload: {
      itemId,
      itemType: "command_execution",
      status: kind === "tool.completed" ? "completed" : "inProgress",
      title: label,
      data:
        provider === "claudeAgent"
          ? {
              toolName: "Bash",
              commandInspectionVersion: 1,
              inspectionProvider: "claudeAgent",
              input: { description: label, command: `echo ${label}` },
              ...(kind === "tool.completed"
                ? { output: `Synthetic output for ${label}`, outputTruncated: false }
                : {}),
            }
          : { toolCallId: itemId, command: `echo ${label}` },
    },
  };
}

function contextActivity(sequence: number): OrchestrationThreadActivity {
  return {
    id: EventId.make(`synthetic-context-${sequence}`),
    turnId: TURN_ID,
    sequence,
    createdAt: time(sequence),
    tone: "info",
    kind: "context-window.updated",
    summary: "Synthetic context usage",
    payload: { usedTokens: sequence, maxTokens: 200_000 },
  };
}

function eventFor(threadId: ThreadId, activity: OrchestrationThreadActivity): OrchestrationEvent {
  return {
    type: "thread.activity-appended",
    sequence: activity.sequence!,
    eventId: EventId.make(`synthetic-ledger-${activity.sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: activity.createdAt,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: { threadId, activity },
  };
}

function fixture(
  provider: Provider,
  oldCount = 8,
  owner = "original",
  historicalTurnCount = 0,
  retainConfiguration = false,
) {
  const environmentId = EnvironmentId.make(`earlier-work-${owner}`);
  const threadId = ThreadId.make(`earlier-work-${provider}-${owner}`);
  const old = Array.from({ length: oldCount }, (_, index) =>
    toolActivity(
      provider,
      index + 1,
      `${owner} earlier command ${index + 1}`,
      `${owner}-old-${index + 1}`,
    ),
  );
  const hidden = Array.from({ length: 497 }, (_, index) => contextActivity(oldCount + index + 1));
  const recentSequence = oldCount + hidden.length + 1;
  const recent = [
    toolActivity(
      provider,
      recentSequence,
      `${owner} recent command`,
      `${owner}-recent`,
      "tool.updated",
    ),
    toolActivity(provider, recentSequence + 1, `${owner} recent command`, `${owner}-recent`),
  ];
  const configuration: OrchestrationThreadActivity[] = retainConfiguration
    ? [
        {
          id: EventId.make(`${owner}-configuration`),
          turnId: TURN_ID,
          sequence: 0,
          createdAt: time(0),
          tone: "info",
          kind: "provider.turn.configuration",
          summary: "Turn accepted",
          payload: {
            turnConfiguration: {
              version: 1,
              provider,
              providerInstanceId: provider,
              providerDisplayName: "Synthetic provider",
              model: "synthetic-model",
              runtimeMode: DEFAULT_RUNTIME_MODE,
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              settingsSource: "submitted",
            },
          },
        },
      ]
    : [];
  const allActivities = [...configuration, ...old, ...hidden, ...recent];
  const thread: OrchestrationThread = {
    id: threadId,
    projectId: null,
    title: "Synthetic long-running chat",
    modelSelection: { instanceId: ProviderInstanceId.make(provider), model: "synthetic-model" },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    createdAt: time(0),
    updatedAt: time(recentSequence + 1),
    archivedAt: null,
    deletedAt: null,
    messages: [
      ...Array.from({ length: historicalTurnCount }, (_, index) => ({
        id: MessageId.make(`${owner}-historical-message-${index}`),
        role: "user" as const,
        text: `Synthetic prior turn ${index}`,
        turnId: TurnId.make(`${owner}-historical-turn-${index}`),
        streaming: false,
        createdAt: time(index - historicalTurnCount - 1),
        updatedAt: time(index - historicalTurnCount - 1),
      })),
      ...Array.from({ length: 5 }, (_, index) => ({
        id: MessageId.make(`${owner}-message-${index}`),
        role: index === 0 ? ("user" as const) : ("assistant" as const),
        text: `Synthetic ${owner} message ${index}`,
        turnId: TURN_ID,
        streaming: false,
        createdAt: time(index * 2),
        updatedAt: time(index * 2),
      })),
    ],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    latestTurn: {
      turnId: TURN_ID,
      state: "running",
      requestedAt: time(0),
      startedAt: time(0),
      completedAt: null,
      assistantMessageId: null,
    },
    session: {
      threadId,
      status: "running",
      providerName: provider,
      providerInstanceId: ProviderInstanceId.make(provider),
      runtimeMode: DEFAULT_RUNTIME_MODE,
      activeTurnId: TURN_ID,
      lastError: null,
      updatedAt: time(0),
    },
  };
  let state = syncServerThreadDetail(
    { activeEnvironmentId: environmentId, environmentStateById: {} },
    thread,
    environmentId,
    0,
  );
  state = applyOrchestrationEvents(
    state,
    allActivities.map((activity) => eventFor(threadId, activity)),
    environmentId,
  );
  const readThread = () => {
    const selected = selectThreadByRef(state, { environmentId, threadId });
    if (!selected) throw new Error("Synthetic thread fixture unavailable");
    return selected;
  };
  return {
    provider,
    environmentId,
    threadId,
    old,
    allActivities,
    readThread,
    appendHistoricalCommand: (turnId: TurnId) => {
      const sequence = Math.max(...allActivities.map((activity) => activity.sequence ?? 0)) + 1;
      const activity = {
        ...toolActivity(provider, sequence, "Late historical command", "late-historical-command"),
        turnId,
      };
      allActivities.push(activity);
      state = applyOrchestrationEvents(state, [eventFor(threadId, activity)], environmentId);
      return activity.id;
    },
    appendContexts: (count: number) => {
      const first = Math.max(...allActivities.map((activity) => activity.sequence ?? 0)) + 1;
      const activities = Array.from({ length: count }, (_, index) =>
        contextActivity(first + index),
      );
      allActivities.push(...activities);
      state = applyOrchestrationEvents(
        state,
        activities.map((activity) => eventFor(threadId, activity)),
        environmentId,
      );
    },
  };
}

type Fixture = ReturnType<typeof fixture>;
function precedes(
  activity: OrchestrationThreadActivity,
  before: OrchestrationThreadActivityCursor | undefined,
) {
  if (!before) return true;
  if (activity.sequence !== undefined && before.sequence !== null)
    return activity.sequence < before.sequence;
  return (
    activity.createdAt < before.createdAt ||
    (activity.createdAt === before.createdAt && activity.id < before.activityId)
  );
}

function installApi(data: Fixture) {
  const eligibleActivities = (input: {
    turnId: TurnId;
    before?: OrchestrationThreadActivityCursor | undefined;
    excludeActivityIds?: ReadonlyArray<EventId> | undefined;
    excludeTurnStartAck?: boolean | undefined;
  }) =>
    data.allActivities.filter(
      (activity) =>
        activity.turnId === input.turnId &&
        (activity.kind.startsWith("tool.") ||
          activity.kind === "provider.turn.configuration" ||
          activity.kind === "task.progress") &&
        !(
          input.excludeTurnStartAck &&
          activity.kind === "task.progress" &&
          typeof activity.payload === "object" &&
          activity.payload !== null &&
          "taskId" in activity.payload &&
          activity.payload?.taskId === `codex-turn-start:${input.turnId}`
        ) &&
        precedes(activity, input.before) &&
        !input.excludeActivityIds?.includes(activity.id),
    );
  const getThreadTurnWorkLogPresence = vi.fn(
    async (input: OrchestrationThreadTurnWorkLogPresenceInput) => ({
      threadId: data.threadId,
      turnIdsWithWorkLog: input.turnIds.filter(
        (turnId) => eligibleActivities({ ...input, turnId }).length > 0,
      ),
    }),
  );
  const validPage = (input: OrchestrationThreadTurnActivityPageInput) => {
    const eligible = eligibleActivities(input);
    return {
      threadId: data.threadId,
      turnId: input.turnId,
      offset: input.offset,
      limit: input.limit,
      totalCount: eligible.length,
      activities: input.before
        ? eligible.slice(-input.limit)
        : eligible.slice(input.offset, input.offset + input.limit),
      ...(input.before ? { before: input.before } : {}),
      ...(input.excludeActivityIds ? { excludeActivityIds: input.excludeActivityIds } : {}),
      ...(input.excludeTurnStartAck !== undefined
        ? { excludeTurnStartAck: input.excludeTurnStartAck }
        : {}),
    };
  };
  const getThreadTurnActivityPage = vi.fn(async (input: OrchestrationThreadTurnActivityPageInput) =>
    validPage(input),
  );
  __setEnvironmentApiOverrideForTests(data.environmentId, {
    orchestration: { getThreadTurnWorkLogPresence, getThreadTurnActivityPage },
  } as unknown as EnvironmentApi);
  return { getThreadTurnWorkLogPresence, getThreadTurnActivityPage, validPage };
}

function TimelineFixture({
  data,
  thread = data.readThread(),
}: {
  data: Fixture;
  thread?: ReturnType<Fixture["readThread"]>;
}) {
  const summary = deriveHistoricalWorkLogSummaries({
    messages: thread.messages,
    activities: thread.activities,
    latestTurnId: thread.latestTurn?.turnId ?? null,
  });
  const entries = deriveTimelineEntries(
    thread.messages,
    [],
    deriveWorkLogEntries(thread.activities, thread.latestTurn?.turnId ?? undefined),
  );
  const props: ComponentProps<typeof MessagesTimeline> = {
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnId: thread.session?.activeTurnId ?? thread.latestTurn?.turnId ?? null,
    activeTurnStartedAt: null,
    listRef: createRef<LegendListRef | null>(),
    timelineEntries: entries,
    historicalWorkLogSummariesByTurnId: summary,
    completionDividerAfterEntryId: null,
    completionSummary: null,
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: vi.fn(),
    isRevertingCheckpoint: false,
    onImageExpand: vi.fn(),
    activeThreadEnvironmentId: data.environmentId,
    activeProvider: ProviderDriverKind.make(data.provider),
    markdownCwd: undefined,
    timestampFormat: "24-hour",
    workspaceRoot: undefined,
    activeThreadId: data.threadId,
    stickToEndRevision: 0,
    autoFollowTail: false,
    onIsAtEndChange: vi.fn(),
    onUserScrollIntent: vi.fn(),
  };
  return (
    <div className="bg-background text-foreground" style={{ width: "100%", maxWidth: 700 }}>
      <MessagesTimeline {...props} />
    </div>
  );
}

function commandRows(label: string) {
  // Claude uses an inspectable received command; Codex uses an ordinary row.
  // Restrict to actual rendered command controls/text, not snapshot arrays.
  return [...document.querySelectorAll("button")].filter(
    (element) => element.getAttribute("aria-label") === `Inspect command: ${label}`,
  );
}

beforeEach(async () => {
  await page.viewport(1000, 800);
});
afterEach(async () => {
  __resetEnvironmentApiOverridesForTests();
  applyInterfaceScalePercent(100);
  document.documentElement.classList.remove("dark");
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
});

describe("Earlier work in a retained current turn", () => {
  it.each(["disconnected", "failed"] as const)(
    "keeps an unverified Earlier work section hidden after a %s availability check",
    async (failure) => {
      const data = fixture("codex");
      data.appendContexts(1);
      const api = installApi(data);
      if (failure === "disconnected") __resetEnvironmentApiOverridesForTests();
      else
        api.getThreadTurnWorkLogPresence.mockRejectedValueOnce(
          new Error("private synthetic presence failure"),
        );
      const screen = await render(<TimelineFixture data={data} />);
      try {
        await expect.element(page.getByText("Synthetic original message 0")).toBeVisible();
        if (failure === "failed")
          await vi.waitFor(() =>
            expect(api.getThreadTurnWorkLogPresence.mock.settledResults[0]?.type).toBe("rejected"),
          );
        for (let index = 0; index < 3; index++) {
          data.appendContexts(1);
          await screen.rerender(<TimelineFixture data={data} thread={data.readThread()} />);
          expect(page.getByRole("button", { name: /^Earlier work/ }).elements()).toHaveLength(0);
        }
        expect(api.getThreadTurnWorkLogPresence).toHaveBeenCalledTimes(
          failure === "failed" ? 1 : 0,
        );
        expect(api.getThreadTurnActivityPage).not.toHaveBeenCalled();
        expect(document.body.textContent).not.toContain("private synthetic presence failure");
      } finally {
        await screen.unmount();
      }
    },
  );

  it("removes an exhausted empty disclosure without displaying its empty message or rediscovering it on context updates", async () => {
    const data = fixture("codex");
    data.appendContexts(1);
    const api = installApi(data);
    api.getThreadTurnActivityPage.mockImplementationOnce(async (input) => ({
      ...api.validPage(input),
      totalCount: 0,
      activities: [],
    }));
    const screen = await render(<TimelineFixture data={data} />);
    const emptyMessages: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node.textContent?.includes("No earlier commands in this page."))
            emptyMessages.push(node.textContent);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    try {
      await page.getByRole("button", { name: /^Earlier work/ }).click();
      await vi.waitFor(() =>
        expect(page.getByRole("button", { name: /^Earlier work/ }).elements()).toHaveLength(0),
      );
      for (let index = 0; index < 3; index++) {
        data.appendContexts(1);
        await screen.rerender(<TimelineFixture data={data} thread={data.readThread()} />);
      }
      expect(page.getByRole("button", { name: /^Earlier work/ }).elements()).toHaveLength(0);
      expect(emptyMessages).toEqual([]);
      expect(api.getThreadTurnWorkLogPresence).toHaveBeenCalledTimes(1);
      expect(api.getThreadTurnActivityPage).toHaveBeenCalledTimes(1);
    } finally {
      observer.disconnect();
      await screen.unmount();
    }
  });

  it("keeps a stale empty page hidden while allowing genuinely newly evicted work to be opened", async () => {
    const data = fixture("codex");
    data.appendContexts(1);
    const api = installApi(data);
    let release!: (page: ReturnType<typeof api.validPage>) => void;
    let captured!: OrchestrationThreadTurnActivityPageInput;
    api.getThreadTurnActivityPage.mockImplementationOnce((input) => {
      captured = input;
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const screen = await render(<TimelineFixture data={data} />);
    try {
      await page.getByRole("button", { name: /^Earlier work/ }).click();
      await vi.waitFor(() => expect(api.getThreadTurnActivityPage).toHaveBeenCalledTimes(1));
      data.appendContexts(1);
      await screen.rerender(<TimelineFixture data={data} thread={data.readThread()} />);
      release({ ...api.validPage(captured), totalCount: 0, activities: [] });
      await vi.waitFor(() =>
        expect(page.getByRole("button", { name: /^Earlier work/ }).elements()).toHaveLength(0),
      );
      data.appendContexts(1);
      await screen.rerender(<TimelineFixture data={data} thread={data.readThread()} />);
      expect(page.getByRole("button", { name: /^Earlier work/ }).elements()).toHaveLength(0);
      expect(api.getThreadTurnActivityPage).toHaveBeenCalledTimes(1);

      // Context receipts now actually evict the command that was still inline
      // at the captured empty range. That new history must remain accessible.
      data.appendContexts(500);
      await screen.rerender(<TimelineFixture data={data} thread={data.readThread()} />);
      const earlier = page.getByRole("button", { name: /^Earlier work/ });
      await expect.element(earlier).toHaveAttribute("aria-expanded", "false");
      expect(api.getThreadTurnActivityPage).toHaveBeenCalledTimes(1);
      await earlier.click();
      await expect.element(page.getByText(/original recent command/).first()).toBeVisible();
      expect(api.getThreadTurnActivityPage).toHaveBeenCalledTimes(2);
    } finally {
      if (captured) release?.({ ...api.validPage(captured), totalCount: 0, activities: [] });
      await screen.unmount();
    }
  });

  it.each(["codex", "claudeAgent"] as const)(
    "does not rediscover an empty %s log from turn settings retained before the live window",
    async (provider) => {
      const data = fixture(provider, 0, "retained-only", 0, true);
      data.appendContexts(2);
      if (provider === "codex") {
        // This separate persisted receipt has already left the real store
        // window. Excluding the retained settings id alone cannot remove it.
        data.allActivities.unshift({
          ...contextActivity(0),
          id: EventId.make("evicted-turn-start-ack"),
          kind: "task.progress",
          payload: { taskId: `codex-turn-start:${TURN_ID}` },
        });
      }
      const api = installApi(data);
      const screen = await render(<TimelineFixture data={data} />);
      try {
        await vi.waitFor(() => expect(api.getThreadTurnWorkLogPresence).toHaveBeenCalledTimes(1));
        expect(api.getThreadTurnWorkLogPresence.mock.calls[0]?.[0]).toMatchObject({
          before: { sequence: 2 },
          excludeActivityIds: ["retained-only-configuration"],
          ...(provider === "codex" ? { excludeTurnStartAck: true } : {}),
        });
        await expect.element(page.getByText("Synthetic retained-only message 0")).toBeVisible();
        expect(page.getByRole("button", { name: /^Earlier work/ }).elements()).toHaveLength(0);
        for (let index = 0; index < 8; index++) {
          data.appendContexts(1);
          await screen.rerender(<TimelineFixture data={data} thread={data.readThread()} />);
        }
        expect(page.getByRole("button", { name: /^Earlier work/ }).elements()).toHaveLength(0);
        expect(api.getThreadTurnWorkLogPresence).toHaveBeenCalledTimes(1);
        expect(api.getThreadTurnActivityPage).not.toHaveBeenCalled();
      } finally {
        await screen.unmount();
      }
    },
  );

  it("still reads evicted commands while excluding already-inline retained settings", async () => {
    const data = fixture("codex", 8, "retained-and-evicted", 0, true);
    data.appendContexts(1);
    const api = installApi(data);
    const screen = await render(<TimelineFixture data={data} />);
    try {
      await page.getByRole("button", { name: /^Earlier work/ }).click();
      await expect
        .element(page.getByText(/retained-and-evicted earlier command 7/).first())
        .toBeVisible();
      expect(api.getThreadTurnActivityPage.mock.calls[0]?.[0].excludeActivityIds).toEqual([
        "retained-and-evicted-configuration",
      ]);
      await page.getByRole("button", { name: "Show older", exact: true }).click();
      await expect
        .element(page.getByText(/retained-and-evicted earlier command 1/).first())
        .toBeVisible();
      expect(
        api.getThreadTurnActivityPage.mock.calls.every(
          ([input]) => input.excludeActivityIds?.[0] === "retained-and-evicted-configuration",
        ),
      ).toBe(true);
    } finally {
      await screen.unmount();
    }
  });

  it("rechecks positive earlier-work presence when received settings replace its only saved receipt", async () => {
    const data = fixture("codex", 0, "late-settings", 0, true);
    data.appendContexts(2);
    data.allActivities.unshift({
      ...contextActivity(0),
      id: EventId.make("late-settings-start-ack"),
      kind: "task.progress",
      payload: { taskId: `codex-turn-start:${TURN_ID}` },
    });
    const thread = data.readThread();
    const withoutSettings = {
      ...thread,
      activities: thread.activities.filter(
        (activity) => activity.kind !== "provider.turn.configuration",
      ),
    };
    const api = installApi(data);
    const screen = await render(<TimelineFixture data={data} thread={withoutSettings} />);
    try {
      await expect.element(page.getByRole("button", { name: /^Earlier work/ })).toBeVisible();
      expect(api.getThreadTurnWorkLogPresence).toHaveBeenCalledTimes(1);

      // The settings arrive after a positive availability result. They now
      // replace the saved ACK, so its old positive cannot keep an empty row
      // visible until the user clicks it.
      await screen.rerender(<TimelineFixture data={data} thread={thread} />);
      await vi.waitFor(() =>
        expect(page.getByRole("button", { name: /^Earlier work/ }).elements()).toHaveLength(0),
      );
      expect(api.getThreadTurnWorkLogPresence).toHaveBeenCalledTimes(2);
      expect(api.getThreadTurnWorkLogPresence.mock.calls[1]?.[0]).toMatchObject({
        excludeActivityIds: ["late-settings-configuration"],
        excludeTurnStartAck: true,
      });
      data.appendContexts(1);
      await screen.rerender(<TimelineFixture data={data} thread={data.readThread()} />);
      expect(page.getByRole("button", { name: /^Earlier work/ }).elements()).toHaveLength(0);
      expect(api.getThreadTurnWorkLogPresence).toHaveBeenCalledTimes(2);
      expect(api.getThreadTurnActivityPage).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it.each(["codex", "claudeAgent"] as const)(
    "recovers evicted %s commands through the real 500-row store window without duplicating recent work",
    async (provider) => {
      const data = fixture(provider);
      const api = installApi(data);
      expect(data.allActivities).toHaveLength(507);
      expect(data.readThread().activities).toHaveLength(500);
      expect(data.readThread().messages).toHaveLength(5);
      expect(data.readThread().activities.some((activity) => activity.id === data.old[6]?.id)).toBe(
        false,
      );
      const screen = await render(<TimelineFixture data={data} />);
      try {
        const earlier = page.getByRole("button", { name: /^Earlier work/ });
        await expect.element(earlier).toHaveAttribute("aria-expanded", "false");
        expect(api.getThreadTurnActivityPage).not.toHaveBeenCalled();
        await earlier.click();
        await expect.element(earlier).toHaveAttribute("aria-expanded", "true");
        await expect.element(page.getByText(/original earlier command 7/).first()).toBeVisible();
        expect(api.getThreadTurnActivityPage).toHaveBeenCalledTimes(1);
        expect(api.getThreadTurnActivityPage.mock.calls[0]?.[0]).toMatchObject({
          threadId: data.threadId,
          turnId: TURN_ID,
          offset: 0,
          limit: 6,
          before: { sequence: 8, activityId: data.old[7]!.id },
        });
        expect(api.getThreadTurnWorkLogPresence).toHaveBeenCalledTimes(1);
        expect(
          api.getThreadTurnWorkLogPresence.mock.calls.every(
            ([input]) => input.turnIds.length === 1 && input.before !== undefined,
          ),
        ).toBe(true);
        if (provider === "claudeAgent")
          expect(commandRows("original recent command")).toHaveLength(1);
        else expect(page.getByText(/original recent command/).elements()).toHaveLength(1);
        await page.getByRole("button", { name: "Show older", exact: true }).click();
        await expect.element(page.getByText(/original earlier command 1/).first()).toBeVisible();
        expect(api.getThreadTurnActivityPage.mock.calls[1]?.[0]).toMatchObject({
          offset: 0,
          limit: 24,
          before: { sequence: 2, activityId: data.old[1]!.id },
        });
        await page.getByRole("button", { name: "Recent", exact: true }).click();
        await expect.element(earlier).toHaveAttribute("aria-expanded", "true");
        await expect.element(page.getByText(/original earlier command 7/).first()).toBeVisible();
        expect(page.getByText(/original earlier command 1/).elements()).toHaveLength(0);
        expect(api.getThreadTurnActivityPage.mock.calls[2]?.[0]).toMatchObject({
          offset: 0,
          limit: 6,
          before: { sequence: 8, activityId: data.old[7]!.id },
        });
        const openedDisclosure = earlier.element();
        data.appendContexts(500);
        await screen.rerender(<TimelineFixture data={data} thread={data.readThread()} />);
        await expect.element(earlier).toHaveAttribute("aria-expanded", "true");
        expect(earlier.element()).toBe(openedDisclosure);
        await expect.element(page.getByText(/original earlier command 7/).first()).toBeVisible();
        expect(api.getThreadTurnWorkLogPresence).toHaveBeenCalledTimes(1);
        expect(api.getThreadTurnActivityPage).toHaveBeenCalledTimes(3);
      } finally {
        await screen.unmount();
      }
    },
  );

  it("loads chronological earlier pages explicitly while retaining the received recent operation once", async () => {
    const data = fixture("claudeAgent", 36);
    const api = installApi(data);
    const screen = await render(<TimelineFixture data={data} />);
    try {
      await page.getByRole("button", { name: /^Earlier work/ }).click();
      await expect
        .element(page.getByRole("button", { name: "Inspect command: original earlier command 35" }))
        .toBeVisible();
      await page.getByRole("button", { name: "Show older", exact: true }).click();
      await expect
        .element(
          page.getByRole("button", {
            name: "Inspect command: original earlier command 6",
            exact: true,
          }),
        )
        .toBeVisible();
      expect(api.getThreadTurnActivityPage.mock.calls.map(([input]) => input.limit)).toEqual([
        6, 24,
      ]);
      const labels = [
        ...document.querySelectorAll(
          "[data-historical-work-log-row] button[aria-label^='Inspect command:']",
        ),
      ].map((element) => element.getAttribute("aria-label"));
      expect(labels).toEqual(
        Array.from(
          { length: 30 },
          (_, index) => `Inspect command: original earlier command ${index + 6}`,
        ),
      );
      expect(commandRows("original recent command")).toHaveLength(1);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps failed paging manual and retries only after explicit user input", async () => {
    const data = fixture("codex");
    const api = installApi(data);
    api.getThreadTurnActivityPage.mockRejectedValueOnce(
      new Error("synthetic private page failure"),
    );
    const screen = await render(<TimelineFixture data={data} />);
    try {
      await page.getByRole("button", { name: /^Earlier work/ }).click();
      await expect.element(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
      expect(document.body.textContent).not.toContain("synthetic private page failure");
      expect(api.getThreadTurnActivityPage).toHaveBeenCalledTimes(1);
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await expect.element(page.getByText(/original earlier command 7/).first()).toBeVisible();
      expect(api.getThreadTurnActivityPage).toHaveBeenCalledTimes(2);
    } finally {
      await screen.unmount();
    }
  });

  it.each([
    "old-server",
    "foreign-thread",
    "foreign-turn",
    "changed-cursor",
    "out-of-bound-row",
    "malformed-row",
  ] as const)(
    "rejects %s page data instead of displaying an unqualified historical result",
    async (failure) => {
      const data = fixture("codex");
      const api = installApi(data);
      api.getThreadTurnActivityPage.mockImplementationOnce(async (input) => {
        const valid = api.validPage(input);
        if (failure === "old-server") {
          const { before: _before, ...legacy } = valid;
          return legacy;
        }
        if (failure === "foreign-thread")
          return { ...valid, threadId: ThreadId.make("foreign-synthetic-thread") };
        if (failure === "foreign-turn")
          return { ...valid, turnId: TurnId.make("foreign-synthetic-turn") };
        if (failure === "changed-cursor")
          return {
            ...valid,
            before: { ...input.before!, sequence: (input.before!.sequence ?? 0) + 1 },
          };
        if (failure === "malformed-row")
          return { ...valid, activities: [{ ...valid.activities[0]!, sequence: Number.NaN }] };
        return { ...valid, activities: [data.allActivities.at(-1)!] };
      });
      const screen = await render(<TimelineFixture data={data} />);
      try {
        await page.getByRole("button", { name: /^Earlier work/ }).click();
        await expect
          .element(page.getByRole("button", { name: "Retry", exact: true }))
          .toBeVisible();
        expect(page.getByText(/original earlier command 7/).elements()).toHaveLength(0);
        expect(api.getThreadTurnActivityPage).toHaveBeenCalledTimes(1);
      } finally {
        await screen.unmount();
      }
    },
  );

  it("discards a delayed page after the selected environment/thread owner changes", async () => {
    const previous = fixture("codex");
    const api = installApi(previous);
    const next = fixture("codex", 8, "next");
    const nextApi = installApi(next);
    let release!: (value: ReturnType<typeof api.validPage>) => void;
    api.getThreadTurnActivityPage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const screen = await render(<TimelineFixture data={previous} />);
    try {
      await page.getByRole("button", { name: /^Earlier work/ }).click();
      await vi.waitFor(() => expect(api.getThreadTurnActivityPage).toHaveBeenCalledTimes(1));
      const request = api.getThreadTurnActivityPage.mock.calls[0]![0];
      await screen.rerender(<TimelineFixture data={next} />);
      release(api.validPage(request));
      await expect
        .element(page.getByText("Synthetic next message 0", { exact: true }))
        .toBeVisible();
      const nextEarlier = page.getByRole("button", { name: /^Earlier work/ });
      await expect.element(nextEarlier).toHaveAttribute("aria-expanded", "false");
      await nextEarlier.click();
      await expect.element(page.getByText(/next earlier command 7/).first()).toBeVisible();
      expect(page.getByText(/original earlier command 7/).elements()).toHaveLength(0);
      expect(api.getThreadTurnActivityPage).toHaveBeenCalledTimes(1);
      expect(nextApi.getThreadTurnActivityPage).toHaveBeenCalledTimes(1);
      expect(nextApi.getThreadTurnActivityPage.mock.calls[0]?.[0].threadId).toBe(next.threadId);
    } finally {
      release?.(
        api.validPage({ threadId: previous.threadId, turnId: TURN_ID, offset: 0, limit: 6 }),
      );
      await screen.unmount();
    }
  });

  it("keeps an opened received page stable through hidden live updates without a presence/page RPC storm", async () => {
    const data = fixture("codex");
    // Retire the final old snapshot command before mounting; subsequent hidden
    // updates now leave the first ordinary live operation identity unchanged.
    data.appendContexts(1);
    const api = installApi(data);
    const screen = await render(<TimelineFixture data={data} />);
    try {
      await page.getByRole("button", { name: /^Earlier work/ }).click();
      await expect.element(page.getByText(/original earlier command 7/).first()).toBeVisible();
      const pageCount = api.getThreadTurnActivityPage.mock.calls.length;
      const presenceCount = api.getThreadTurnWorkLogPresence.mock.calls.length;
      for (let index = 0; index < 8; index++) {
        data.appendContexts(1);
        // Browser fixtures use the real React Compiler. Pass immutable reducer
        // snapshots as props rather than asking a memoized component to notice
        // mutation hidden behind an unchanged closure-bearing fixture object.
        await screen.rerender(<TimelineFixture data={data} thread={data.readThread()} />);
      }
      await expect.element(page.getByText(/original earlier command 7/).first()).toBeVisible();
      expect(api.getThreadTurnActivityPage).toHaveBeenCalledTimes(pageCount);
      expect(api.getThreadTurnWorkLogPresence).toHaveBeenCalledTimes(presenceCount);
    } finally {
      await screen.unmount();
    }
  });

  it("rechecks a stale negative presence reply after the first inline operation is evicted", async () => {
    const data = fixture("codex");
    const api = installApi(data);
    let release!: (value: Awaited<ReturnType<typeof api.getThreadTurnWorkLogPresence>>) => void;
    api.getThreadTurnWorkLogPresence.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const screen = await render(<TimelineFixture data={data} />);
    try {
      await vi.waitFor(() => expect(api.getThreadTurnWorkLogPresence).toHaveBeenCalledTimes(1));
      // The candidate is still the exact same current turn, but its first
      // inline operation has left the raw snapshot window. An older negative
      // cannot hide newly missing work indefinitely under that stable turn id.
      const previousThread = data.readThread();
      const previousWitness = deriveHistoricalWorkLogSummaries({
        messages: previousThread.messages,
        activities: previousThread.activities,
        latestTurnId: TURN_ID,
      }).get(TURN_ID)?.presenceRevision;
      data.appendContexts(1);
      const nextThread = data.readThread();
      const nextWitness = deriveHistoricalWorkLogSummaries({
        messages: nextThread.messages,
        activities: nextThread.activities,
        latestTurnId: TURN_ID,
      }).get(TURN_ID)?.presenceRevision;
      expect(nextWitness).not.toBe(previousWitness);
      await screen.rerender(<TimelineFixture data={data} thread={nextThread} />);
      release({ threadId: data.threadId, turnIdsWithWorkLog: [] });
      await vi.waitFor(() => expect(api.getThreadTurnWorkLogPresence).toHaveBeenCalledTimes(2));
      expect(
        api.getThreadTurnWorkLogPresence.mock.calls.map(([input]) => input.before?.sequence),
      ).toEqual([8, 9]);
      const earlier = page.getByRole("button", { name: /^Earlier work/ });
      await expect.element(earlier).toHaveAttribute("aria-expanded", "false");
      expect(api.getThreadTurnActivityPage).not.toHaveBeenCalled();
      await earlier.click();
      await expect.element(page.getByText(/original earlier command 7/).first()).toBeVisible();
      expect(api.getThreadTurnActivityPage).toHaveBeenCalledTimes(1);
    } finally {
      release?.({ threadId: data.threadId, turnIdsWithWorkLog: [] });
      await screen.unmount();
    }
  });

  it("keeps completed presence batches while a later batch is still pending", async () => {
    const data = fixture("codex", 8, "original", 257);
    const api = installApi(data);
    let release!: (value: Awaited<ReturnType<typeof api.getThreadTurnWorkLogPresence>>) => void;
    let withheldTurnIds: ReadonlyArray<TurnId> = [];
    api.getThreadTurnWorkLogPresence.mockImplementation(async (input) => {
      if (!input.before && input.turnIds.length === 1 && withheldTurnIds.length === 0) {
        withheldTurnIds = input.turnIds;
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      return { threadId: data.threadId, turnIdsWithWorkLog: [...input.turnIds] };
    });
    const screen = await render(<TimelineFixture data={data} />);
    try {
      await vi.waitFor(() =>
        expect(api.getThreadTurnWorkLogPresence.mock.calls.length).toBeGreaterThanOrEqual(2),
      );
      // Wait for the first batch to become real timeline rows while the next
      // singleton is held. Publishing that progress must not restart another
      // read for the same pending batch or fetch historical activity payloads.
      await expect.element(page.getByRole("button", { name: /^Work log/ }).first()).toBeVisible();
      release({ threadId: data.threadId, turnIdsWithWorkLog: [...withheldTurnIds] });
      await expect.element(page.getByRole("button", { name: /^Earlier work/ })).toBeVisible();
      expect(
        api.getThreadTurnWorkLogPresence.mock.calls.map(([input]) => input.turnIds.length),
      ).toEqual([256, 1, 1]);
      expect(
        api.getThreadTurnWorkLogPresence.mock.calls.map(([input]) => input.before !== undefined),
      ).toEqual([false, false, true]);
      expect(api.getThreadTurnActivityPage).not.toHaveBeenCalled();
    } finally {
      release?.({ threadId: data.threadId, turnIdsWithWorkLog: [...withheldTurnIds] });
      await screen.unmount();
    }
  });

  it("keeps late snapshot-proven historical work discoverable after it leaves the raw window", async () => {
    const data = fixture("codex", 8, "original", 1);
    const historicalTurnId = TurnId.make("original-historical-turn-0");
    const api = installApi(data);
    api.getThreadTurnWorkLogPresence.mockImplementation(async (input) => ({
      threadId: data.threadId,
      // The initial negative is accurate before the late exact-turn activity.
      // Keeping it negative proves retained snapshot evidence, not a lucky
      // later RPC response, preserves the collapsed historical entry point.
      turnIdsWithWorkLog: input.before ? [TURN_ID] : [],
    }));
    const screen = await render(<TimelineFixture data={data} />);
    try {
      await vi.waitFor(() => expect(api.getThreadTurnWorkLogPresence).toHaveBeenCalledTimes(2));
      await expect.element(page.getByRole("button", { name: /^Earlier work/ })).toBeVisible();
      expect(page.getByRole("button", { name: /^Work log/ }).elements()).toHaveLength(0);
      const activityId = data.appendHistoricalCommand(historicalTurnId);
      await screen.rerender(<TimelineFixture data={data} thread={data.readThread()} />);
      await expect.element(page.getByRole("button", { name: /^Work log/ })).toBeVisible();
      data.appendContexts(500);
      expect(data.readThread().activities).toHaveLength(500);
      expect(data.readThread().activities.some((activity) => activity.id === activityId)).toBe(
        false,
      );
      await screen.rerender(<TimelineFixture data={data} thread={data.readThread()} />);
      const historical = page.getByRole("button", { name: /^Work log/ });
      await expect.element(historical).toHaveAttribute("aria-expanded", "false");
      expect(api.getThreadTurnActivityPage).not.toHaveBeenCalled();
      await historical.click();
      await expect.element(page.getByText(/Late historical command/).first()).toBeVisible();
      expect(
        api.getThreadTurnWorkLogPresence.mock.calls.filter(([input]) => !input.before),
      ).toHaveLength(1);
      expect(api.getThreadTurnActivityPage).toHaveBeenCalledTimes(2);
      expect(
        api.getThreadTurnActivityPage.mock.calls.every(
          ([input]) => input.turnId === historicalTurnId,
        ),
      ).toBe(true);
    } finally {
      await screen.unmount();
    }
  });

  it("does not manufacture terminal outcomes when hydrating a turn with unknown latest metadata", async () => {
    const previousLocale = getUiLocale();
    setUiLocale("en");
    const data = fixture("codex");
    const api = installApi(data);
    const thread = { ...data.readThread(), latestTurn: null, session: null };
    const activities: OrchestrationThreadActivity[] = [
      {
        id: EventId.make("hydrated-compaction-start"),
        turnId: TURN_ID,
        sequence: 1,
        createdAt: time(1),
        tone: "tool",
        kind: "tool.started",
        summary: "Context compaction started",
        payload: {
          itemType: "context_compaction",
          itemId: "hydrated-compaction",
          title: "Context compaction",
        },
      },
      {
        id: EventId.make("hydrated-legacy-child-start"),
        turnId: TURN_ID,
        sequence: 2,
        createdAt: time(2),
        tone: "tool",
        // Native control-plane completion proves the Started command, not the
        // spawned child's completion. Missing latest metadata is no substitute
        // for a real parent or child terminal observation.
        kind: "tool.completed",
        summary: "Subagent task",
        payload: {
          itemType: "collab_agent_tool_call",
          itemId: "hydrated-legacy-child",
          detail: "Started /root/hydrated_legacy_child",
        },
      },
    ];
    api.getThreadTurnActivityPage.mockImplementation(async (input) => ({
      threadId: data.threadId,
      turnId: input.turnId,
      offset: input.offset,
      limit: input.limit,
      totalCount: activities.length,
      activities: activities.slice(input.offset, input.offset + input.limit),
    }));
    const screen = await render(<TimelineFixture data={data} thread={thread} />);
    try {
      const historical = page.getByRole("button", { name: /^Work log/ });
      await expect.element(historical).toHaveAttribute("aria-expanded", "false");
      expect(api.getThreadTurnActivityPage).not.toHaveBeenCalled();
      await historical.click();
      await expect.element(page.getByText("Compacting context", { exact: true })).toBeVisible();
      const child = page.getByRole("button", {
        name: /^Hydrated legacy child, Status unavailable\./,
      });
      await expect.element(child).toBeVisible();
      expect(child.element().querySelector("[data-subagent-status]")?.textContent).toBe(
        "Status unavailable",
      );
      expect(child.element().querySelector("[data-subagent-terminal-elapsed]")).toBeNull();
      expect(page.getByText("Context compacted", { exact: true }).elements()).toHaveLength(0);
      expect(page.getByText("Completed", { exact: true }).elements()).toHaveLength(0);
      expect(page.getByText("Done", { exact: true }).elements()).toHaveLength(0);
      const compactionNode = page.getByText("Compacting context", { exact: true }).element();
      const childNode = child.element();
      // Locale changes are presentation-only: retain the hydrated rows, the
      // unknown child outcome and the exact owner-scoped history reads.
      for (const locale of ["ja", "ko", "en"] as const) {
        setUiLocale(locale);
        await expect
          .element(
            page.getByText(uiText("Compacting context", {}, undefined, locale), { exact: true }),
          )
          .toBeVisible();
        expect(
          page
            .getByText(uiText("Compacting context", {}, undefined, locale), { exact: true })
            .element(),
        ).toBe(compactionNode);
        expect(childNode.isConnected).toBe(true);
        await expect
          .poll(() => childNode.querySelector("[data-subagent-status]")?.textContent)
          .toBe(uiText("Status unavailable", {}, undefined, locale));
        expect(childNode.querySelector("[data-subagent-terminal-elapsed]")).toBeNull();
        for (const outcome of ["Context compacted", "Completed", "Done"] as const) {
          expect(
            page.getByText(uiText(outcome, {}, undefined, locale), { exact: true }).elements(),
          ).toHaveLength(0);
        }
      }
      expect(api.getThreadTurnActivityPage).toHaveBeenCalledTimes(2);
      expect(
        api.getThreadTurnActivityPage.mock.calls.every(
          ([input]) =>
            input.threadId === data.threadId &&
            input.turnId === TURN_ID &&
            input.before === undefined,
        ),
      ).toBe(true);
    } finally {
      await screen.unmount();
      setUiLocale(previousLocale);
    }
  });

  it.each([
    { theme: "light", scale: 80, reducedMotion: false },
    { theme: "dark", scale: 130, reducedMotion: true },
  ] as const)(
    "keeps Earlier work usable in $theme at $scale percent (reduced motion=$reducedMotion)",
    async ({ theme, scale, reducedMotion }) => {
      await page.viewport(480, 760);
      document.documentElement.classList.toggle("dark", theme === "dark");
      applyInterfaceScalePercent(scale);
      await cdp().send("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-reduced-motion", value: reducedMotion ? "reduce" : "no-preference" },
        ],
      });
      const data = fixture("claudeAgent");
      installApi(data);
      const screen = await render(<TimelineFixture data={data} />);
      try {
        const earlier = page.getByRole("button", { name: /^Earlier work/ });
        await expect.element(earlier).toBeVisible();
        await earlier.click();
        await expect
          .element(
            page.getByRole("button", {
              name: "Inspect command: original earlier command 7",
              exact: true,
            }),
          )
          .toBeVisible();
        const controls = [
          earlier.element(),
          page.getByRole("button", { name: "Show older", exact: true }).element(),
          page.getByRole("button", { name: "Recent", exact: true }).element(),
        ];
        for (const control of controls) {
          const bounds = control.getBoundingClientRect();
          expect(bounds.width).toBeGreaterThan(0);
          expect(bounds.left).toBeGreaterThanOrEqual(-1);
          expect(bounds.right).toBeLessThanOrEqual(window.innerWidth + 1);
        }
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
      } finally {
        await screen.unmount();
      }
    },
  );
});
