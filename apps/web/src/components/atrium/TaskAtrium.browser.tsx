import "../../index.css";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderTurnConfiguration,
} from "@cafecode/contracts";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const CODEX_TURN_CONFIGURATION: ProviderTurnConfiguration = {
  version: 1,
  provider: ProviderDriverKind.make("codex"),
  providerInstanceId: ProviderInstanceId.make("codex_personal"),
  providerDisplayName: "Codex Personal",
  model: "gpt-6.1-sol",
  modelDisplayName: "GPT-6.1 Sol",
  effort: "ultra",
  fastMode: true,
  runtimeMode: "full-access",
  interactionMode: "default",
  settingsSource: "submitted",
};

const CLAUDE_TURN_CONFIGURATION: ProviderTurnConfiguration = {
  version: 1,
  provider: ProviderDriverKind.make("claudeAgent"),
  providerInstanceId: ProviderInstanceId.make("claude_work"),
  providerDisplayName: "Claude Work",
  model: "claude-opus-5-5",
  modelDisplayName: "Opus 5.5",
  effort: "max",
  fastMode: false,
  runtimeMode: "auto-accept-edits",
  interactionMode: "plan",
  settingsSource: "session",
};

const SUBMITTED_SETTINGS_DESCRIPTION =
  "Settings Cafe submitted for this accepted turn. Provider defaults may be inherited; this is not independent execution or billing confirmation.";
const SESSION_SETTINGS_DESCRIPTION =
  "Settings of the existing session that accepted this input. Provider defaults may be inherited; this is not independent execution or billing confirmation.";

const atriumHarness = vi.hoisted(() => {
  const now = Date.now();
  const thread = "thread-1";
  const env = "env-1";
  const state = {
    activeEnvironmentId: env,
    environmentStateById: {
      [env]: {
        projectIds: ["project-1"],
        projectById: { "project-1": { id: "project-1", name: "cafe-code" } },
        threadIds: [thread, "thread-2", "thread-error"],
        threadSessionById: {},
        threadTurnStateById: {},
        activityIdsByThreadId: { [thread]: ["a1", "a2"] },
        activityByThreadId: {
          [thread]: {
            a1: {
              id: "a1",
              tone: "tool",
              kind: "tool.started",
              summary: "Subagent task started",
              payload: {
                itemType: "collab_agent_tool_call",
                itemId: "task-1",
                detail: "explore: mapping canvas call sites",
              },
              turnId: null,
              createdAt: new Date(now - 5_000).toISOString(),
            },
            a2: {
              id: "a2",
              tone: "tool",
              kind: "tool.started",
              summary: "Command run started",
              payload: { itemType: "command_execution", itemId: "cmd-1", detail: "yarn build" },
              turnId: null,
              createdAt: new Date(now - 1_000).toISOString(),
            },
          },
        },
        sidebarThreadSummaryById: {
          "thread-error": {
            id: "thread-error",
            environmentId: env,
            projectId: "project-1",
            title: "Recover failed provider session",
            session: {
              provider: "claudeAgent",
              orchestrationStatus: "error",
              status: "error",
              activeTurnId: "turn-error",
              createdAt: new Date(now - 180_000).toISOString(),
              updatedAt: new Date(now - 30_000).toISOString(),
            },
            createdAt: new Date(now - 180_000).toISOString(),
            archivedAt: null,
            latestTurn: {
              turnId: "turn-error",
              state: "error",
              requestedAt: new Date(now - 90_000).toISOString(),
              startedAt: new Date(now - 89_000).toISOString(),
              completedAt: new Date(now - 30_000).toISOString(),
              assistantMessageId: null,
            },
            branch: null,
            worktreePath: null,
            latestUserMessageAt: null,
            hasPendingApprovals: false,
            hasPendingUserInput: false,
            hasActionableProposedPlan: false,
          },
          "thread-2": {
            id: "thread-2",
            environmentId: env,
            projectId: "project-1",
            title: "Fix flaky provider reconnect test",
            session: { provider: "codex", orchestrationStatus: "running" },
            createdAt: new Date(now - 300_000).toISOString(),
            archivedAt: null,
            latestTurn: {
              turnId: "t2",
              state: "running",
              requestedAt: new Date(now - 252_000).toISOString(),
              startedAt: new Date(now - 252_000).toISOString(),
              completedAt: null,
              assistantMessageId: null,
            },
            branch: null,
            worktreePath: null,
            latestUserMessageAt: null,
            hasPendingApprovals: false,
            hasPendingUserInput: false,
            hasActionableProposedPlan: false,
          },
          [thread]: {
            id: thread,
            environmentId: env,
            projectId: "project-1",
            title: "Port the ambiance engine to WebGL",
            session: {
              provider: "claudeAgent",
              orchestrationStatus: "running",
              subagentRuntimeId: "native-runtime-a",
            },
            createdAt: new Date(now - 120_000).toISOString(),
            archivedAt: null,
            latestTurn: {
              turnId: "turn-1",
              state: "running",
              requestedAt: new Date(now - 66_000).toISOString(),
              startedAt: new Date(now - 66_000).toISOString(),
              completedAt: null,
              assistantMessageId: null,
            },
            branch: null,
            worktreePath: null,
            latestUserMessageAt: null,
            hasPendingApprovals: false,
            hasPendingUserInput: false,
            hasActionableProposedPlan: false,
          },
        },
      },
    },
  };
  const useStore = Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
    getState: () => state,
  });
  const theme = { value: "dark" as "light" | "dark" };
  const updateSettings = vi.fn();
  const retainedDetails: Array<{
    environmentId: string;
    threadId: string;
    release: ReturnType<typeof vi.fn>;
  }> = [];
  const retainThreadDetailSubscription = vi.fn((environmentId: string, threadId: string) => {
    const release = vi.fn();
    retainedDetails.push({ environmentId, threadId, release });
    return release;
  });
  const usage = {
    cost: 0,
    tokens: 0,
    loaded: false,
    hasUnpriced: false,
    daily: [],
    rangeTokens: 0,
    rangeCost: 0,
    outputTokens: 0,
    cachedShare: null,
    cacheSavings: 0,
    raw: null,
  };
  const subagentDetailReads = vi.fn(async (_request: unknown) => ({
    provider: "claudeAgent",
    messages: [{ key: "public-report", role: "assistant", text: "Latest worker report" }],
    gaps: [],
    truncated: false,
  }));
  const loadedUsage = {
    cost: 2.5,
    tokens: 3_539_966_200,
    loaded: true,
    hasUnpriced: false,
    daily: [{ day: "2026-08-25", tokens: 350_000, cost: 0.25 }],
    rangeTokens: 350_000,
    rangeCost: 0.25,
    outputTokens: 539_966_200,
    cachedShare: 0.5,
    cacheSavings: 1.25,
    raw: {
      totals: {
        generatingMs: 1_000,
        inputTokens: 3_000_000_000,
        cachedInputTokens: 1_500_000_000,
        cacheWriteInputTokens: 0,
        outputTokens: 539_966_200,
        reasoningOutputTokens: 10_000,
        userMessages: 1,
      },
      today: {
        day: "2026-08-25",
        generatingMs: 1_000,
        inputTokens: 300_000,
        cachedInputTokens: 150_000,
        cacheWriteInputTokens: 0,
        outputTokens: 50_000,
        reasoningOutputTokens: 1_000,
        userMessages: 1,
      },
      activeSessionCount: 0,
      collectionEnabled: true,
      asOfMs: now,
      days: [
        {
          day: "2026-08-25",
          generatingMs: 1_000,
          inputTokens: 300_000,
          cachedInputTokens: 150_000,
          cacheWriteInputTokens: 0,
          outputTokens: 50_000,
          reasoningOutputTokens: 1_000,
          userMessages: 1,
        },
      ],
      tokenBreakdown: [
        {
          provider: "codex",
          model: "gpt-5.6-codex",
          inputTokens: 3_000_000_000,
          cachedInputTokens: 1_500_000_000,
          cacheWriteInputTokens: 0,
          outputTokens: 539_966_200,
          reasoningOutputTokens: 10_000,
        },
      ],
    },
  };
  return {
    theme,
    updateSettings,
    retainedDetails,
    retainThreadDetailSubscription,
    usage,
    loadedUsage,
    settings: {
      ambianceAtriumEnabled: true,
      continueBackgroundAnimations: true,
      ambianceAtriumColor: "",
      ambianceColor: "",
      appAccentColor: "",
      themeAccentColor: "",
      dismissedTaskAtriumErrors: [],
    },
    useStore,
    subagentDetailReads,
  };
});

// Desktop detection is a module-load constant, just as it is in Electron.
// The separate browser-only overlay test covers the absence of the bridge.
vi.mock("../../env", () => ({ isElectron: true }));

vi.mock("../../hooks/useSettings", () => ({
  useSettings: (selector: (settings: typeof atriumHarness.settings) => unknown) =>
    selector(atriumHarness.settings),
  useUpdateSettings: () => ({
    updateSettings: atriumHarness.updateSettings,
    resetSettings: vi.fn(),
  }),
}));

vi.mock("../../hooks/useTheme", () => ({
  useTheme: () => ({
    theme: atriumHarness.theme.value,
    resolvedTheme: atriumHarness.theme.value,
    setTheme: () => {},
  }),
}));

vi.mock("../../store", () => ({
  selectAnyThreadRunning: () => true,
  useStore: atriumHarness.useStore,
}));

vi.mock("../../environmentApi", () => ({
  readEnvironmentApi: (environmentId: string) =>
    environmentId === "env-1"
      ? { orchestration: { getThreadTurnSubagentDetail: atriumHarness.subagentDetailReads } }
      : undefined,
}));
vi.mock("../../localApi", () => ({ readLocalApi: () => undefined }));

vi.mock("../../environments/runtime/service", () => ({
  retainThreadDetailSubscription: atriumHarness.retainThreadDetailSubscription,
}));

vi.mock("../stats/useUsageCostSummary", () => ({
  useUsageCostSummary: () => atriumHarness.usage,
}));

const navigations: Array<Record<string, unknown>> = [];
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => (options: Record<string, unknown>) => {
    navigations.push(options);
    return Promise.resolve();
  },
}));

import { TaskAtriumBoard } from "./TaskAtrium";
import { TaskAtriumOverlay } from "./TaskAtriumOverlay";
import { useTaskAtriumStore } from "./taskAtriumStore";

async function renderInTheme(theme: "light" | "dark") {
  atriumHarness.theme.value = theme;
  document.documentElement.classList.toggle("dark", theme === "dark");
  const host = document.createElement("div");
  host.style.height = "100vh";
  host.style.display = "flex";
  host.style.flexDirection = "column";
  document.body.append(host);
  const screen = await render(<TaskAtriumBoard />, { container: host });
  return { host, screen };
}

function addRunningThreads(count: number): () => void {
  const environment = atriumHarness.useStore.getState().environmentStateById["env-1"]!;
  const previousThreadIds = [...environment.threadIds];
  const summaries = environment.sidebarThreadSummaryById as unknown as Record<
    string,
    (typeof environment.sidebarThreadSummaryById)["thread-2"]
  >;
  const base = summaries["thread-2"]!;
  const addedIds = Array.from({ length: count }, (_, index) => `thread-scroll-${index + 1}`);

  for (const [index, threadId] of addedIds.entries()) {
    summaries[threadId] = {
      ...base,
      id: threadId,
      title: `Scrollable task ${index + 1}`,
      session: { ...base.session },
      latestTurn: { ...base.latestTurn, turnId: `turn-scroll-${index + 1}` },
    };
  }
  environment.threadIds = [...previousThreadIds, ...addedIds];

  return () => {
    environment.threadIds = previousThreadIds;
    for (const threadId of addedIds) delete summaries[threadId];
  };
}

type FixtureSubagentStatus = "waiting" | "active" | "completed" | "failed" | "stopped";

function installStructuredSubagents(
  count: number,
  statusForIndex: (index: number) => FixtureSubagentStatus = () => "active",
): () => void {
  type HarnessActivity = {
    id: string;
    tone: string;
    kind: string;
    summary: string;
    payload: Record<string, unknown>;
    turnId: string | null;
    createdAt: string;
  };
  const environment = atriumHarness.useStore.getState().environmentStateById["env-1"]!;
  const activityIdsByThreadId = environment.activityIdsByThreadId as Record<string, string[]>;
  const activityByThreadId = environment.activityByThreadId as unknown as Record<
    string,
    Record<string, HarnessActivity>
  >;
  const previousIds = activityIdsByThreadId["thread-1"];
  const previousActivities = activityByThreadId["thread-1"];
  const ids: string[] = [];
  const activities: Record<string, HarnessActivity> = {};
  const fixtureNow = Date.now();

  for (let index = 0; index < count; index += 1) {
    const id = `subagent-${index + 1}`;
    const status = statusForIndex(index);
    const terminal = status === "completed" || status === "failed" || status === "stopped";
    const createdAt = new Date(fixtureNow - (count - index) * 1_000).toISOString();
    ids.push(id);
    activities[id] = {
      id,
      tone: "info",
      kind: terminal ? "task.completed" : "task.progress",
      summary: terminal ? "Subagent completed" : "Subagent update",
      payload: {
        taskId: `claude-task-${index + 1}`,
        ...(terminal ? { status } : {}),
        detail:
          index === count - 1
            ? `Visible task description ${index + 1} stays completely readable even when the bounded provider text wraps across several narrow card lines without an inner clip.`
            : `Visible task description ${index + 1}`,
        subagent: {
          threadId: `claude-task-${index + 1}`,
          runtimeId: "native-runtime-a",
          label: `Claude worker ${index + 1}`,
          objective: `Original task objective ${index + 1}`,
          status,
          startedAt: new Date(fixtureNow - (count - index) * 1_000 - 60_000).toISOString(),
        },
      },
      turnId: "turn-1",
      createdAt,
    };
  }
  activityIdsByThreadId["thread-1"] = ids;
  activityByThreadId["thread-1"] = activities;

  return () => {
    if (previousIds) activityIdsByThreadId["thread-1"] = previousIds;
    else delete activityIdsByThreadId["thread-1"];
    if (previousActivities) activityByThreadId["thread-1"] = previousActivities;
    else delete activityByThreadId["thread-1"];
  };
}

type TurnConfigurationFixture = {
  activityId: string;
  threadId: string;
  turnId: string;
  configuration: ProviderTurnConfiguration;
};

type TurnConfigurationHarnessActivity = {
  id: string;
  tone: string;
  kind: string;
  summary: string;
  payload: Record<string, unknown>;
  turnId: string | null;
  createdAt: string;
};

/**
 * Install the same durable activity shape the server projects for an accepted
 * turn. Keeping the activity on the exact provider turn is important: the
 * Atrium must never borrow a newer or older card's model/account settings just
 * because that activity happens to be latest in the thread's retained log.
 */
function installTurnConfigurationActivities(
  fixtures: readonly TurnConfigurationFixture[],
): () => void {
  const environment = atriumHarness.useStore.getState().environmentStateById["env-1"]!;
  const activityIdsByThreadId = environment.activityIdsByThreadId as Record<string, string[]>;
  const activityByThreadId = environment.activityByThreadId as unknown as Record<
    string,
    Record<string, TurnConfigurationHarnessActivity>
  >;
  const previousByThread = new Map<
    string,
    {
      ids: string[] | undefined;
      activities: Record<string, TurnConfigurationHarnessActivity> | undefined;
    }
  >();

  for (const [index, fixture] of fixtures.entries()) {
    if (!previousByThread.has(fixture.threadId)) {
      previousByThread.set(fixture.threadId, {
        ids: activityIdsByThreadId[fixture.threadId],
        activities: activityByThreadId[fixture.threadId],
      });
    }
    const createdAt = new Date(Date.now() + index).toISOString();
    activityIdsByThreadId[fixture.threadId] = [
      ...(activityIdsByThreadId[fixture.threadId] ?? []).filter(
        (activityId) => activityId !== fixture.activityId,
      ),
      fixture.activityId,
    ];
    activityByThreadId[fixture.threadId] = {
      ...(activityByThreadId[fixture.threadId] ?? {}),
      [fixture.activityId]: {
        id: fixture.activityId,
        tone: "info",
        kind: "provider.turn.configuration",
        summary: "Turn settings",
        payload: { turnConfiguration: fixture.configuration },
        turnId: fixture.turnId,
        createdAt,
      },
    };
  }

  return () => {
    for (const [threadId, previous] of previousByThread) {
      if (previous.ids) activityIdsByThreadId[threadId] = previous.ids;
      else delete activityIdsByThreadId[threadId];
      if (previous.activities) activityByThreadId[threadId] = previous.activities;
      else delete activityByThreadId[threadId];
    }
  };
}

/**
 * Replace only one immutable configuration activity while retaining the
 * surrounding activity collections. This models a projection correcting the
 * decoded metadata for an existing activity and deliberately keeps every
 * other card prop stable, including the memoized empty subagent rows.
 */
function replaceTurnConfigurationActivity(fixture: TurnConfigurationFixture): () => void {
  const environment = atriumHarness.useStore.getState().environmentStateById["env-1"]!;
  const activityIds = (environment.activityIdsByThreadId as Record<string, string[]>)[
    fixture.threadId
  ];
  const activityById = (
    environment.activityByThreadId as unknown as Record<
      string,
      Record<string, TurnConfigurationHarnessActivity>
    >
  )[fixture.threadId];
  const previous = activityById?.[fixture.activityId];
  if (
    !activityIds?.includes(fixture.activityId) ||
    !previous ||
    previous.kind !== "provider.turn.configuration" ||
    previous.summary !== "Turn settings" ||
    previous.turnId !== fixture.turnId
  ) {
    throw new Error(`Turn configuration activity cannot be replaced: ${fixture.activityId}`);
  }

  const replacement: TurnConfigurationHarnessActivity = {
    ...previous,
    payload: { turnConfiguration: fixture.configuration },
  };
  activityById[fixture.activityId] = replacement;
  return () => {
    activityById[fixture.activityId] = previous;
  };
}

function taskCard(host: HTMLElement, title: string): HTMLElement {
  const openButton = host.querySelector<HTMLButtonElement>(
    `button[aria-label=${JSON.stringify(`Open ${title}`)}]`,
  );
  const card = openButton?.closest<HTMLElement>('[data-cafe-atrium-task-card="true"]');
  if (!card) throw new Error(`Atrium card did not mount: ${title}`);
  return card;
}

describe("TaskAtriumBoard", () => {
  for (const theme of ["dark", "light"] as const) {
    it(`renders running work, its subagents and legible text in ${theme} mode`, async () => {
      const { host, screen } = await renderInTheme(theme);
      try {
        await vi.waitFor(
          () => {
            expect(host.textContent).toContain("Port the ambiance engine to WebGL");
            // The subagent row proves Claude Task items are represented.
            expect(host.textContent).toContain("explore");
            expect(host.textContent).toContain("mapping canvas call sites");
            // Latest non-subagent activity is the card's current-action line.
            expect(host.textContent).toContain("Command run");
            expect(host.textContent).toContain("cafe-code");
          },
          { timeout: 3_000 },
        );

        const card = host.querySelector('[data-cafe-atrium-task-card="true"]');
        expect(card).toBeInstanceOf(HTMLElement);
        if (!(card instanceof HTMLElement)) throw new Error("Atrium card did not mount");

        // Both themes must produce a painted surface and readable contrast
        // rather than transparent-on-transparent.
        const styles = getComputedStyle(card);
        expect(styles.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
        expect(styles.color).not.toBe(styles.backgroundColor);
      } finally {
        await screen.unmount();
        host.remove();
        document.documentElement.classList.remove("dark");
      }
    });
  }

  it("shows each card's frozen accepted-turn model, account, modes, and source", async () => {
    const restoreConfigurations = installTurnConfigurationActivities([
      {
        activityId: "turn-settings-claude",
        threadId: "thread-1",
        turnId: "turn-1",
        configuration: CLAUDE_TURN_CONFIGURATION,
      },
      {
        activityId: "turn-settings-codex",
        threadId: "thread-2",
        turnId: "t2",
        configuration: CODEX_TURN_CONFIGURATION,
      },
    ]);
    const { host, screen } = await renderInTheme("dark");
    try {
      await vi.waitFor(() => {
        expect(host.textContent).toContain("GPT-6.1 Sol · Effort: Ultra · Fast on");
        expect(host.textContent).toContain("Opus 5.5 · Effort: Max · Fast off");
      });

      const codexCard = taskCard(host, "Fix flaky provider reconnect test");
      const codexConfiguration = codexCard.querySelector<HTMLElement>(
        '[data-cafe-atrium-turn-configuration="true"]',
      );
      expect(codexConfiguration?.textContent).toContain("GPT-6.1 Sol · Effort: Ultra · Fast on");
      expect(codexConfiguration?.textContent).toContain(
        "Account: Codex Personal · Build · Full access",
      );
      expect(codexConfiguration?.title).toBe(SUBMITTED_SETTINGS_DESCRIPTION);

      const claudeCard = taskCard(host, "Port the ambiance engine to WebGL");
      const claudeConfiguration = claudeCard.querySelector<HTMLElement>(
        '[data-cafe-atrium-turn-configuration="true"]',
      );
      expect(claudeConfiguration?.textContent).toContain("Opus 5.5 · Effort: Max · Fast off");
      expect(claudeConfiguration?.textContent).toContain(
        "Account: Claude Work · Plan · Auto-accept edits",
      );
      expect(claudeConfiguration?.title).toBe(SESSION_SETTINGS_DESCRIPTION);

      // A cold detail projection or a thread persisted before configuration
      // snapshots existed must be explicit instead of borrowing today's
      // composer defaults from either provider card above.
      const legacyCard = taskCard(host, "Recover failed provider session");
      expect(
        legacyCard.querySelector<HTMLElement>('[data-cafe-atrium-turn-configuration="true"]')
          ?.textContent,
      ).toContain("Turn settings unavailable");
    } finally {
      restoreConfigurations();
      await screen.unmount();
      host.remove();
      document.documentElement.classList.remove("dark");
    }
  });

  it("repaints corrected accepted-turn metadata on a terminal card", async () => {
    const correctedConfiguration: ProviderTurnConfiguration = {
      ...CLAUDE_TURN_CONFIGURATION,
      model: "claude-sonnet-5-5",
      modelDisplayName: "Sonnet 5.5",
      effort: "high",
    };
    const restoreInitial = installTurnConfigurationActivities([
      {
        activityId: "turn-settings-error",
        threadId: "thread-error",
        turnId: "turn-error",
        configuration: CLAUDE_TURN_CONFIGURATION,
      },
    ]);
    let restoreCorrection: () => void = () => undefined;
    const { host, screen } = await renderInTheme("dark");
    try {
      await vi.waitFor(() => {
        expect(host.textContent).toContain("Opus 5.5 · Effort: Max · Fast off");
      });

      const terminalCard = taskCard(host, "Recover failed provider session");
      const configuration = terminalCard.querySelector<HTMLElement>(
        '[data-cafe-atrium-turn-configuration="true"]',
      );
      const openButton = terminalCard.querySelector<HTMLButtonElement>(
        'button[aria-label="Open Recover failed provider session"]',
      );
      expect(terminalCard.querySelector('[data-cafe-atrium-subagent-row="true"]')).toBeNull();
      expect(terminalCard.textContent).toContain("Turn settings");
      expect(configuration?.id).not.toBe("");
      expect(openButton?.getAttribute("aria-describedby")).toBe(configuration?.id);
      expect(openButton?.title).toBe(SESSION_SETTINGS_DESCRIPTION);

      // Keep this terminal card's frozen clock, activity label, empty child
      // rows and every other prop stable. Only a new immutable activity object
      // at the same durable id carries the corrected accepted-turn metadata.
      restoreCorrection = replaceTurnConfigurationActivity({
        activityId: "turn-settings-error",
        threadId: "thread-error",
        turnId: "turn-error",
        configuration: correctedConfiguration,
      });
      await vi.waitFor(
        () => {
          const correctedCard = taskCard(host, "Recover failed provider session");
          expect(correctedCard.textContent).toContain("Sonnet 5.5 · Effort: High · Fast off");
          expect(correctedCard.textContent).not.toContain("Opus 5.5 · Effort: Max");
        },
        { timeout: 3_000 },
      );
    } finally {
      restoreCorrection();
      restoreInitial();
      await screen.unmount();
      host.remove();
      document.documentElement.classList.remove("dark");
    }
  });

  it("keeps a frozen turn snapshot across rerenders and switches only with the exact next turn", async () => {
    const environment = atriumHarness.useStore.getState().environmentStateById["env-1"]!;
    const summary = environment.sidebarThreadSummaryById["thread-2"]!;
    const previousTitle = summary.title;
    const previousLatestTurn = summary.latestTurn;
    const nextConfiguration: ProviderTurnConfiguration = {
      ...CODEX_TURN_CONFIGURATION,
      providerDisplayName: "Codex Review",
      model: "gpt-6-astra",
      modelDisplayName: "GPT-6 Astra",
      effort: "max",
      fastMode: false,
      runtimeMode: "approval-required",
      interactionMode: "plan",
      settingsSource: "session",
    };
    const restoreCurrent = installTurnConfigurationActivities([
      {
        activityId: "turn-settings-current",
        threadId: "thread-2",
        turnId: "t2",
        configuration: CODEX_TURN_CONFIGURATION,
      },
    ]);
    let restoreNext: () => void = () => undefined;
    const { host, screen } = await renderInTheme("dark");
    try {
      await vi.waitFor(() => {
        expect(host.textContent).toContain("GPT-6.1 Sol · Effort: Ultra · Fast on");
      });

      // A normal React rerender does not re-read mutable provider inventory or
      // rewrite the accepted turn using today's account/model labels.
      await screen.rerender(<TaskAtriumBoard />);
      expect(taskCard(host, previousTitle).textContent).toContain(
        "Account: Codex Personal · Build · Full access",
      );

      restoreNext = installTurnConfigurationActivities([
        {
          activityId: "turn-settings-next",
          threadId: "thread-2",
          turnId: "t3",
          configuration: nextConfiguration,
        },
      ]);
      summary.title = "Fix flaky provider reconnect test (refreshed)";

      // The title change proves the one-second Atrium projection poll observed
      // the new activity. Its mismatched turn still cannot replace t2's frozen
      // configuration.
      await vi.waitFor(
        () => {
          const currentCard = taskCard(host, summary.title);
          expect(currentCard.textContent).toContain("GPT-6.1 Sol · Effort: Ultra · Fast on");
          expect(currentCard.textContent).not.toContain("GPT-6 Astra");
        },
        { timeout: 3_000 },
      );

      const nextStartedAt = new Date().toISOString();
      summary.latestTurn = {
        ...previousLatestTurn!,
        turnId: "t3",
        requestedAt: nextStartedAt,
        startedAt: nextStartedAt,
      };
      await vi.waitFor(
        () => {
          const nextCard = taskCard(host, summary.title);
          expect(nextCard.textContent).toContain("GPT-6 Astra · Effort: Max · Fast off");
          expect(nextCard.textContent).toContain(
            "Account: Codex Review · Plan · Approval required",
          );
          expect(nextCard.textContent).not.toContain("GPT-6.1 Sol");
        },
        { timeout: 3_000 },
      );
    } finally {
      summary.title = previousTitle;
      summary.latestTurn = previousLatestTurn;
      restoreNext();
      restoreCurrent();
      await screen.unmount();
      host.remove();
      document.documentElement.classList.remove("dark");
    }
  });

  it("wraps long accepted-turn labels without widening a narrow Atrium card", async () => {
    const originalViewport = { height: window.innerHeight, width: window.innerWidth };
    const longModel =
      "Codex investigation model with a deliberately long frozen display label for narrow task cards";
    const longAccount =
      "Codex account with a deliberately long safe display label that must remain inside the task card";
    const primaryText = `${longModel} · Effort: Ultra · Fast on`;
    const secondaryText = `Account: ${longAccount} · Build · Full access`;
    const restoreConfiguration = installTurnConfigurationActivities([
      {
        activityId: "turn-settings-long",
        threadId: "thread-2",
        turnId: "t2",
        configuration: {
          ...CODEX_TURN_CONFIGURATION,
          providerDisplayName: longAccount,
          modelDisplayName: longModel,
        },
      },
    ]);
    await page.viewport(320, 640);
    const { host, screen } = await renderInTheme("dark");
    try {
      await vi.waitFor(() => expect(host.textContent).toContain(primaryText));
      const card = taskCard(host, "Fix flaky provider reconnect test");
      const configuration = card.querySelector<HTMLElement>(
        '[data-cafe-atrium-turn-configuration="true"]',
      );
      const primary = Array.from(configuration?.children ?? []).find(
        (element) => element.textContent === primaryText,
      ) as HTMLElement | undefined;
      const secondary = Array.from(configuration?.children ?? []).find(
        (element) => element.textContent === secondaryText,
      ) as HTMLElement | undefined;
      const pane = host.querySelector<HTMLElement>('[data-cafe-atrium-pane-scroll="true"]');
      expect(configuration).not.toBeNull();
      expect(primary).not.toBeUndefined();
      expect(secondary).not.toBeUndefined();
      expect(pane).not.toBeNull();
      if (!configuration || !primary || !secondary || !pane) {
        throw new Error("Responsive accepted-turn settings surface did not mount");
      }

      const primaryStyle = getComputedStyle(primary);
      const secondaryStyle = getComputedStyle(secondary);
      expect(primary.getBoundingClientRect().height).toBeGreaterThan(
        Number.parseFloat(primaryStyle.fontSize) * 1.5,
      );
      expect(secondary.getBoundingClientRect().height).toBeGreaterThan(
        Number.parseFloat(secondaryStyle.fontSize) * 1.5,
      );
      for (const element of [primary, secondary, configuration, card, pane]) {
        expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
      }
      expect(card.getBoundingClientRect().right).toBeLessThanOrEqual(
        host.getBoundingClientRect().right + 1,
      );
    } finally {
      restoreConfiguration();
      await page.viewport(originalViewport.width, originalViewport.height);
      await screen.unmount();
      host.remove();
      document.documentElement.classList.remove("dark");
    }
  });

  it("keeps card details browseable beside a separate full-card navigation button", async () => {
    const { host, screen } = await renderInTheme("dark");
    try {
      await vi.waitFor(() => {
        expect(
          host.querySelector('button[aria-label="Open Port the ambiance engine to WebGL"]'),
        ).not.toBeNull();
      });

      const openButton = host.querySelector<HTMLButtonElement>(
        'button[aria-label="Open Port the ambiance engine to WebGL"]',
      );
      const article = openButton?.closest<HTMLElement>(
        '[data-cafe-atrium-task-card="true"][aria-labelledby]',
      );
      const subagentList = article?.querySelector<HTMLElement>(
        '[data-cafe-atrium-subagent-list="true"]',
      );
      const subagentRow = subagentList?.querySelector<HTMLElement>(
        '[data-cafe-atrium-subagent-row="true"]',
      );

      expect(article?.tagName).toBe("ARTICLE");
      expect(openButton).not.toBeNull();
      expect(subagentList?.tagName).toBe("UL");
      expect(subagentList?.getAttribute("aria-label")).toBe(
        "Subagents for Port the ambiance engine to WebGL",
      );
      expect(subagentRow?.tagName).toBe("LI");
      expect(subagentList?.textContent).toContain("mapping canvas call sites");
      // The labelled button is a sibling of the descriptive content, so its
      // accessible name cannot replace the provider/status/subagent text.
      expect(openButton?.contains(subagentList ?? null)).toBe(false);

      openButton?.focus();
      expect(document.activeElement).toBe(openButton);
    } finally {
      await screen.unmount();
      host.remove();
      document.documentElement.classList.remove("dark");
    }
  });

  it("says so plainly when nothing is running", async () => {
    const environments = atriumHarness.useStore.getState().environmentStateById as Record<
      string,
      { threadIds: string[] }
    >;
    const previous = environments["env-1"]!.threadIds;
    environments["env-1"]!.threadIds = [];
    const { host, screen } = await renderInTheme("dark");
    try {
      await vi.waitFor(() => {
        expect(host.textContent).toContain("The garden is quiet");
      });
    } finally {
      environments["env-1"]!.threadIds = previous;
      await screen.unmount();
      host.remove();
    }
  });

  it("restores the narrative work overview and keeps its metrics responsive", async () => {
    const originalViewport = { height: window.innerHeight, width: window.innerWidth };
    const environment = atriumHarness.useStore.getState().environmentStateById["env-1"]!;
    const previousThreadIds = environment.threadIds;
    const previousUsage = { ...atriumHarness.usage };
    const restoreSubagents = installStructuredSubagents(3);
    environment.threadIds = ["thread-1", "thread-2"];
    Object.assign(atriumHarness.usage, atriumHarness.loadedUsage);
    await page.viewport(390, 720);
    const { host, screen } = await renderInTheme("dark");
    try {
      await vi.waitFor(() => {
        expect(host.querySelector('[data-cafe-atrium-overview="true"]')).not.toBeNull();
        expect(host.textContent).toContain("Nothing here asks for you");
      });

      const overview = host.querySelector<HTMLElement>('[data-cafe-atrium-overview="true"]');
      const headline = host.querySelector<HTMLElement>(
        '[data-cafe-atrium-overview-headline="true"]',
      );
      const metrics = host.querySelector<HTMLElement>('[data-cafe-atrium-overview-metrics="true"]');
      expect(overview).not.toBeNull();
      expect(headline).not.toBeNull();
      expect(metrics).not.toBeNull();
      if (!overview || !headline || !metrics) throw new Error("Atrium overview did not mount");

      expect(Array.from(headline.children, (line) => line.textContent)).toEqual([
        "2 threads,",
        "3 subagents,",
        "all working.",
      ]);
      expect(overview.textContent).toContain(
        "Nothing here asks for you. The garden keeps its own hours.",
      );
      expect(overview.textContent).not.toContain("Live work");
      expect(overview.textContent).not.toContain("in motion");
      expect(metrics.textContent).toContain("Cache hits");
      expect(metrics.textContent).toContain("50.0%");
      expect(metrics.textContent).toContain("Cache saved (USD)");
      expect(metrics.textContent).toContain("Output");
      expect(metrics.textContent).toContain("539,966,200");
      expect(metrics.textContent).toContain("540M");

      // The restored large type remains part of the pane on phone-sized
      // layouts instead of being hidden or forcing a horizontal page scroll.
      expect(overview.scrollWidth).toBeLessThanOrEqual(overview.clientWidth + 1);
      expect(overview.getBoundingClientRect().right).toBeLessThanOrEqual(
        host.getBoundingClientRect().right + 1,
      );
    } finally {
      environment.threadIds = previousThreadIds;
      Object.assign(atriumHarness.usage, previousUsage);
      restoreSubagents();
      await page.viewport(originalViewport.width, originalViewport.height);
      await screen.unmount();
      host.remove();
    }
  });

  it("expands a task card for every subagent and delegates scrolling to the Atrium pane", async () => {
    const restoreSubagents = installStructuredSubagents(8);
    const { host, screen } = await renderInTheme("dark");
    host.style.width = "390px";
    host.style.height = "420px";
    try {
      await vi.waitFor(() => {
        expect(host.querySelectorAll('[data-cafe-atrium-subagent-row="true"]')).toHaveLength(8);
      });
      expect(host.textContent).toContain("Visible task description 1");
      expect(host.textContent).toContain("Visible task description 8");
      expect(host.textContent).not.toContain("and more");
      expect(host.querySelectorAll('[data-cafe-subagent-avatar="true"]')).toHaveLength(8);

      const subagentContainer = host.querySelector<HTMLElement>(
        '[data-cafe-atrium-subagent-list="true"]',
      );
      expect(subagentContainer).not.toBeNull();
      if (!subagentContainer) throw new Error("Subagent container did not mount");
      expect(getComputedStyle(subagentContainer).overflowY).toBe("visible");
      expect(subagentContainer.scrollHeight).toBeLessThanOrEqual(
        subagentContainer.clientHeight + 1,
      );

      const rows = subagentContainer.querySelectorAll<HTMLElement>(
        '[data-cafe-atrium-subagent-row="true"]',
      );
      const lastRow = rows.item(rows.length - 1);
      const wrappedDetail = Array.from(
        subagentContainer.querySelectorAll<HTMLElement>(
          '[data-cafe-atrium-subagent-detail="true"]',
        ),
      ).find((detail) => detail.textContent?.includes("without an inner clip"));
      expect(wrappedDetail).not.toBeUndefined();
      if (!wrappedDetail) throw new Error("Wrapped subagent description did not mount");
      expect(wrappedDetail.scrollHeight).toBeLessThanOrEqual(wrappedDetail.clientHeight + 1);
      expect(lastRow.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        subagentContainer.getBoundingClientRect().bottom + 1,
      );

      const card = subagentContainer.closest<HTMLElement>('[data-cafe-atrium-task-card="true"]');
      expect(card).not.toBeNull();
      if (!card) throw new Error("Task card containing subagents did not mount");
      expect(card.scrollHeight).toBeLessThanOrEqual(card.clientHeight + 1);
      expect(lastRow.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        card.getBoundingClientRect().bottom + 1,
      );

      const taskScroller = host.querySelector<HTMLElement>('[data-cafe-atrium-task-scroll="true"]');
      expect(taskScroller).not.toBeNull();
      if (!taskScroller) throw new Error("Task scroll region did not mount");
      expect(getComputedStyle(taskScroller).overflowY).toBe("auto");
      expect(taskScroller.scrollHeight).toBeGreaterThan(taskScroller.clientHeight);

      card.scrollIntoView({ block: "end" });
      expect(card.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        taskScroller.getBoundingClientRect().bottom + 1,
      );
      expect(card.getBoundingClientRect().bottom).toBeGreaterThanOrEqual(
        taskScroller.getBoundingClientRect().top - 1,
      );
    } finally {
      restoreSubagents();
      await screen.unmount();
      host.remove();
    }
  });

  it("opens exact worker activity and refreshes terminal names without resurrecting stale work", async () => {
    const restore = installStructuredSubagents(1);
    atriumHarness.subagentDetailReads.mockClear();
    const { host, screen } = await renderInTheme("dark");
    try {
      await page
        .getByRole("button", { name: "View Claude worker 1 activity", exact: true })
        .click();
      await expect
        .element(page.getByRole("region", { name: "Subagent detail: Claude worker 1" }))
        .toBeVisible();
      await expect.element(page.getByText("Latest worker report", { exact: true })).toBeVisible();
      expect(atriumHarness.subagentDetailReads).toHaveBeenCalledExactlyOnceWith({
        threadId: "thread-1",
        turnId: "turn-1",
        subagentId: "claude-task-1",
      });
      const environment = atriumHarness.useStore.getState().environmentStateById["env-1"]!;
      const previous = environment.activityByThreadId["thread-1"] as unknown as Record<
        string,
        Record<string, unknown>
      >;
      const previousIds = environment.activityIdsByThreadId["thread-1"]!;
      const terminal = {
        ...previous["subagent-1"]!,
        id: "terminal-worker",
        kind: "task.completed",
        createdAt: new Date().toISOString(),
        payload: {
          taskId: "claude-task-1",
          status: "completed",
          subagent: {
            threadId: "claude-task-1",
            runtimeId: "native-runtime-a",
            label: "Finished audit",
            status: "completed",
          },
        },
      };
      environment.activityByThreadId["thread-1"] = {
        ...previous,
        "terminal-worker": terminal,
      } as unknown as (typeof environment.activityByThreadId)["thread-1"];
      environment.activityIdsByThreadId["thread-1"] = [...previousIds, "terminal-worker"];
      await expect
        .element(page.getByRole("region", { name: "Subagent detail: Finished audit" }))
        .toBeVisible();
      await vi.waitFor(() => expect(atriumHarness.subagentDetailReads).toHaveBeenCalledTimes(2));
      await page.getByRole("button", { name: "Back to conversation", exact: true }).click();
      await expect
        .element(page.getByRole("button", { name: "View Finished audit activity", exact: true }))
        .toBeVisible();
      const row = host.querySelector('[data-cafe-atrium-subagent-row="true"]');
      expect(row?.textContent).toContain("Done");
      expect(row?.textContent).not.toContain("Working");
    } finally {
      restore();
      await screen.unmount();
      host.remove();
    }
  });

  it("stops old worker clocks after native replacement while keeping exact history inspectable", async () => {
    const restore = installStructuredSubagents(1);
    const environment = atriumHarness.useStore.getState().environmentStateById["env-1"]!;
    const summary = environment.sidebarThreadSummaryById["thread-1"]!;
    const previousSession = summary.session;
    atriumHarness.subagentDetailReads.mockClear();
    const { host, screen } = await renderInTheme("dark");
    try {
      const worker = page.getByRole("button", {
        name: "View Claude worker 1 activity",
        exact: true,
      });
      await expect.element(worker).toBeVisible();
      await expect.element(worker).toMatchTextContent("Working");
      summary.session = { ...previousSession, subagentRuntimeId: "native-runtime-replacement" };
      await expect.element(worker).toMatchTextContent("Status unavailable");
      const row = host.querySelector('[data-cafe-atrium-subagent-row="true"]');
      expect(row?.querySelector(".font-mono")).toBeNull();
      await worker.click();
      await expect.element(page.getByText("Latest worker report", { exact: true })).toBeVisible();
      await expect
        .element(
          page
            .getByRole("region", { name: "Subagent detail: Claude worker 1" })
            .getByText("Status unavailable", { exact: true }),
        )
        .toBeVisible();
      expect(atriumHarness.subagentDetailReads).toHaveBeenCalledWith({
        threadId: "thread-1",
        turnId: "turn-1",
        subagentId: "claude-task-1",
      });
      expect(host.querySelector('[data-subagent-live-elapsed="true"]')).toBeNull();
      await page.getByRole("button", { name: "Back to conversation", exact: true }).click();
      summary.session = previousSession;
      await expect.element(worker).toMatchTextContent("Working");
    } finally {
      summary.session = previousSession;
      restore();
      await screen.unmount();
      host.remove();
    }
  });

  it("collapses only completed subagents and expands them without navigating", async () => {
    const statuses: readonly FixtureSubagentStatus[] = [
      "active",
      "waiting",
      "failed",
      "stopped",
      "completed",
      "completed",
      "completed",
      "completed",
      "completed",
      "completed",
    ];
    const restoreSubagents = installStructuredSubagents(
      statuses.length,
      (index) => statuses[index] ?? "active",
    );
    navigations.length = 0;
    useTaskAtriumStore.getState().setOpen(true);
    const { host, screen } = await renderInTheme("dark");
    host.style.width = "390px";
    host.style.height = "420px";
    try {
      await vi.waitFor(() => {
        expect(host.querySelectorAll('[data-cafe-atrium-subagent-row="true"]')).toHaveLength(7);
      });

      // Every actionable or abnormal row remains present. Of the six
      // successful completions, only the three newest are previewed.
      for (const worker of [1, 2, 3, 4, 8, 9, 10]) {
        expect(host.textContent).toContain(`Claude worker ${worker}`);
      }
      for (const worker of [5, 6, 7]) {
        expect(host.textContent).not.toContain(`Claude worker ${worker}`);
      }
      expect(host.querySelectorAll('[data-cafe-subagent-avatar="true"]')).toHaveLength(7);

      const expand = page.getByRole("button", {
        name: "Show 3 more completed subagents for Port the ambiance engine to WebGL",
      });
      expect(expand.element().textContent).toContain("Show 3 more completed");
      expect(expand.element().getAttribute("aria-expanded")).toBe("false");
      const controlledId = expand.element().getAttribute("aria-controls");
      expect(controlledId).toBeTruthy();
      expect(host.querySelector(`#${CSS.escape(controlledId ?? "")}`)).not.toBeNull();

      await expand.click();
      await vi.waitFor(() => {
        expect(host.querySelectorAll('[data-cafe-atrium-subagent-row="true"]')).toHaveLength(10);
        expect(host.querySelectorAll('[data-cafe-subagent-avatar="true"]')).toHaveLength(10);
        expect(navigations).toHaveLength(0);
        expect(useTaskAtriumStore.getState().open).toBe(true);
      });

      const collapse = page.getByRole("button", {
        name: "Show fewer completed subagents for Port the ambiance engine to WebGL",
      });
      expect(collapse.element().textContent).toContain("Show less");
      expect(collapse.element().getAttribute("aria-expanded")).toBe("true");
      await collapse.click();
      await vi.waitFor(() => {
        expect(host.querySelectorAll('[data-cafe-atrium-subagent-row="true"]')).toHaveLength(7);
      });

      const list = host.querySelector<HTMLElement>('[data-cafe-atrium-subagent-list="true"]');
      const card = list?.closest<HTMLElement>('[data-cafe-atrium-task-card="true"]');
      const pane = host.querySelector<HTMLElement>('[data-cafe-atrium-pane-scroll="true"]');
      expect(list).not.toBeNull();
      expect(card).not.toBeNull();
      expect(pane).not.toBeNull();
      if (!list || !card || !pane) throw new Error("Responsive Atrium surface did not mount");
      expect(getComputedStyle(list).overflowY).toBe("visible");
      expect(list.scrollHeight).toBeLessThanOrEqual(list.clientHeight + 1);
      expect(card.scrollHeight).toBeLessThanOrEqual(card.clientHeight + 1);
      expect(getComputedStyle(pane).overflowY).toBe("auto");
      expect(pane.scrollWidth).toBeLessThanOrEqual(pane.clientWidth + 1);
    } finally {
      useTaskAtriumStore.getState().setOpen(false);
      restoreSubagents();
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps every tiled task reachable in a short responsive viewport", async () => {
    const restoreThreads = addRunningThreads(9);
    const { host, screen } = await renderInTheme("dark");
    host.style.width = "390px";
    host.style.height = "420px";
    try {
      await vi.waitFor(() => {
        expect(host.querySelectorAll('[data-cafe-atrium-task-card="true"]')).toHaveLength(12);
      });
      const scroller = host.querySelector<HTMLElement>('[data-cafe-atrium-task-scroll="true"]');
      expect(scroller).not.toBeNull();
      if (!scroller) throw new Error("Task scroll region did not mount");
      expect(getComputedStyle(scroller).overflowY).toBe("auto");
      expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);

      const hostRight = host.getBoundingClientRect().right;
      expect(scroller.getBoundingClientRect().right).toBeLessThanOrEqual(hostRight + 1);
      scroller.scrollTop = scroller.scrollHeight;
      const cards = scroller.querySelectorAll<HTMLElement>('[data-cafe-atrium-task-card="true"]');
      const lastCard = cards.item(cards.length - 1);
      expect(lastCard.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        scroller.getBoundingClientRect().bottom + 1,
      );
    } finally {
      restoreThreads();
      await screen.unmount();
      host.remove();
    }
  });

  it("tiles cards across one, two, and three responsive columns", async () => {
    const originalViewport = { height: window.innerHeight, width: window.innerWidth };
    await page.viewport(390, 720);
    const { host, screen } = await renderInTheme("dark");
    try {
      await vi.waitFor(() => {
        expect(host.querySelectorAll('[data-cafe-atrium-task-card="true"]')).toHaveLength(3);
      });
      expect(host.textContent).toContain("3 threads,");
      expect(host.textContent).toContain("0 subagents,");
      expect(host.textContent).toContain("all working.");
      expect(host.textContent).toContain(
        "Nothing here asks for you. The garden keeps its own hours.",
      );
      expect(host.textContent).toContain("mapping canvas call sites");
      const cardBounds = () =>
        Array.from(
          host.querySelectorAll<HTMLElement>('[data-cafe-atrium-task-card="true"]'),
          (card) => card.getBoundingClientRect(),
        );

      let bounds = cardBounds();
      expect(bounds[1]!.top).toBeGreaterThan(bounds[0]!.top + 1);

      await page.viewport(900, 720);
      await vi.waitFor(() => {
        const next = cardBounds();
        expect(Math.abs(next[0]!.top - next[1]!.top)).toBeLessThanOrEqual(1);
        expect(next[2]!.top).toBeGreaterThan(next[0]!.top + 1);
      });

      await page.viewport(1_700, 900);
      await vi.waitFor(() => {
        const next = cardBounds();
        expect(Math.abs(next[0]!.top - next[1]!.top)).toBeLessThanOrEqual(1);
        expect(Math.abs(next[0]!.top - next[2]!.top)).toBeLessThanOrEqual(1);
      });
      expect(host.textContent).toContain("3 threads,");
      expect(host.textContent).toContain("all working.");
      expect(host.textContent).toContain("mapping canvas call sites");
    } finally {
      await page.viewport(originalViewport.width, originalViewport.height);
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps quiet work and the complete usage graph in one scrollable pane", async () => {
    const originalViewport = { height: window.innerHeight, width: window.innerWidth };
    const environments = atriumHarness.useStore.getState().environmentStateById as Record<
      string,
      { threadIds: string[] }
    >;
    const previousThreadIds = environments["env-1"]!.threadIds;
    const previousUsage = { ...atriumHarness.usage };
    environments["env-1"]!.threadIds = [];
    Object.assign(atriumHarness.usage, atriumHarness.loadedUsage);
    await page.viewport(390, 420);
    const { host, screen } = await renderInTheme("dark");
    try {
      await vi.waitFor(() => {
        expect(host.querySelector('[data-cafe-atrium-usage-panel="true"]')).not.toBeNull();
      });
      const pane = host.querySelector<HTMLElement>('[data-cafe-atrium-pane-scroll="true"]');
      const usagePanel = host.querySelector<HTMLElement>('[data-cafe-atrium-usage-panel="true"]');
      const chart = usagePanel?.querySelector<SVGElement>('svg[aria-label^="Daily usage"]');
      expect(pane).not.toBeNull();
      expect(usagePanel).not.toBeNull();
      expect(chart).not.toBeNull();
      if (!pane || !usagePanel || !chart) throw new Error("Complete Atrium usage layout missing");

      expect(getComputedStyle(pane).overflowY).toBe("auto");
      expect(["auto", "scroll"]).not.toContain(getComputedStyle(usagePanel).overflowY);
      expect(usagePanel.scrollHeight).toBeLessThanOrEqual(usagePanel.clientHeight + 1);
      expect(pane.scrollHeight).toBeGreaterThan(pane.clientHeight);

      chart.scrollIntoView({ block: "center" });
      expect(chart.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        pane.getBoundingClientRect().top - 1,
      );
      expect(chart.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        pane.getBoundingClientRect().bottom + 1,
      );
    } finally {
      environments["env-1"]!.threadIds = previousThreadIds;
      Object.assign(atriumHarness.usage, previousUsage);
      await page.viewport(originalViewport.width, originalViewport.height);
      await screen.unmount();
      host.remove();
    }
  });

  it("retains detail for the visible card window and releases every subscription on unmount", async () => {
    atriumHarness.retainThreadDetailSubscription.mockClear();
    atriumHarness.retainedDetails.length = 0;
    const { host, screen } = await renderInTheme("dark");
    let mounted = true;
    try {
      await vi.waitFor(() => {
        expect(atriumHarness.retainThreadDetailSubscription).toHaveBeenCalled();
      });
      expect(atriumHarness.retainThreadDetailSubscription.mock.calls.length).toBeLessThanOrEqual(
        24,
      );
      const releases = atriumHarness.retainedDetails.map((entry) => entry.release);
      await screen.unmount();
      mounted = false;
      expect(releases.every((release) => release.mock.calls.length === 1)).toBe(true);
    } finally {
      if (mounted) await screen.unmount();
      host.remove();
    }
  });

  it("keeps every card reachable while bounding and rotating detail hydration", async () => {
    atriumHarness.retainThreadDetailSubscription.mockClear();
    atriumHarness.retainedDetails.length = 0;
    const restoreThreads = addRunningThreads(40);
    const { host, screen } = await renderInTheme("dark");
    host.style.width = "390px";
    host.style.height = "420px";
    try {
      await vi.waitFor(() => {
        expect(host.querySelectorAll('[data-cafe-atrium-task-card="true"]')).toHaveLength(43);
        expect(atriumHarness.retainThreadDetailSubscription).toHaveBeenCalled();
      });
      expect(host.textContent).not.toContain("and more");
      const activeSubscriptionCount = () =>
        atriumHarness.retainedDetails.filter((entry) => entry.release.mock.calls.length === 0)
          .length;
      expect(activeSubscriptionCount()).toBeLessThanOrEqual(24);

      const scroller = host.querySelector<HTMLElement>('[data-cafe-atrium-task-scroll="true"]');
      const cards = scroller?.querySelectorAll<HTMLElement>('[data-cafe-atrium-task-card="true"]');
      expect(scroller).not.toBeNull();
      expect(cards).toHaveLength(43);
      if (!scroller || !cards) throw new Error("Expected complete Atrium card stack");
      const lastCard = cards.item(cards.length - 1);
      const lastCardKey = JSON.parse(lastCard.dataset.cafeAtriumCardKey ?? "null") as
        | [string, string]
        | null;
      expect(lastCardKey).not.toBeNull();
      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new Event("scroll"));

      await vi.waitFor(() => {
        expect(atriumHarness.retainThreadDetailSubscription).toHaveBeenCalledWith(
          "env-1",
          lastCardKey?.[1],
        );
        expect(activeSubscriptionCount()).toBeLessThanOrEqual(24);
      });
    } finally {
      restoreThreads();
      await screen.unmount();
      host.remove();
    }
  });
});

async function mountOverlay() {
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(<TaskAtriumOverlay />, { container: host });
  return { host, screen };
}

const overlay = () => document.querySelector('[data-cafe-task-atrium-overlay="true"]');
const subagentPopup = () =>
  document.querySelector<HTMLElement>('[data-cafe-atrium-subagent-popup="true"]');

describe("TaskAtriumOverlay", () => {
  it.each([
    { platform: "Win32", scale: 0.8, inset: 40 },
    { platform: "Win32", scale: 1.3, inset: 40 },
    { platform: "MacIntel", scale: 1, inset: 0 },
    { platform: "Linux x86_64", scale: 1, inset: 0 },
  ])(
    "fits portalled worker detail into the usable short window ($platform, scale=$scale)",
    async ({ platform, scale, inset }) => {
      const root = document.documentElement;
      const originalFontSize = root.style.fontSize;
      const originalWco = root.classList.contains("wco");
      const originalViewport = { width: window.innerWidth, height: window.innerHeight };
      const platformSpy = vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      const restoreSubagents = installStructuredSubagents(1);
      root.style.fontSize = `${16 * scale}px`;
      root.classList.add("wco");
      await page.viewport(640, 720);
      useTaskAtriumStore.getState().setOpen(true);
      const { host, screen } = await mountOverlay();
      try {
        await page
          .getByRole("button", { name: "View Claude worker 1 activity", exact: true })
          .click();
        await vi.waitFor(() => {
          expect(
            page.getByRole("button", { name: "Back to conversation" }).element(),
          ).toBeVisible();
        });
        await page.viewport(640, 220);
        await vi.waitFor(() => {
          const detail = subagentPopup();
          expect(detail).not.toBeNull();
          if (!detail) throw new Error("Portalled worker detail did not mount");
          const bounds = detail.getBoundingClientRect();
          const usableHeight = window.innerHeight - inset;
          const expectedHeight = Math.min(
            window.innerHeight * 0.85,
            60 * 16 * scale,
            inset > 0 ? usableHeight - 2 * 16 * scale : Infinity,
          );
          expect(detail.className.includes("wco:[--cafe-atrium-detail-titlebar-inset")).toBe(
            inset > 0,
          );
          expect(bounds.height).toBeCloseTo(expectedHeight, 1);
          expect(bounds.top + bounds.height / 2).toBeCloseTo(inset + usableHeight / 2, 1);
          expect(bounds.left + bounds.width / 2).toBeCloseTo(window.innerWidth / 2, 1);
          expect(bounds.top).toBeGreaterThanOrEqual(inset);
          expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
          expect(bounds.width).toBeLessThanOrEqual(window.innerWidth);
          expect(detail.getAttribute("data-cafe-window-no-drag")).toBe("true");
          expect(getComputedStyle(detail).getPropertyValue("-webkit-app-region")).toBe("no-drag");
          const back = page.getByRole("button", { name: "Back to conversation" }).element();
          expect(back.getBoundingClientRect().top).toBeGreaterThanOrEqual(inset);
          expect(back.getBoundingClientRect().bottom).toBeLessThanOrEqual(bounds.bottom);
          // App-region is not inherited as a computed CSS value. Bind the
          // interactive child to the exact explicitly non-draggable surface.
          expect(back.closest('[data-cafe-window-no-drag="true"]')).toBe(detail);
        });

        // Fullscreen changes native-controls visibility without remounting
        // either dialog. The child must immediately regain the base geometry.
        const samePopup = subagentPopup();
        root.classList.remove("wco");
        await vi.waitFor(() => {
          expect(subagentPopup()).toBe(samePopup);
          const bounds = subagentPopup()!.getBoundingClientRect();
          expect(bounds.height).toBeCloseTo(window.innerHeight * 0.85, 1);
          expect(bounds.top + bounds.height / 2).toBeCloseTo(window.innerHeight / 2, 1);
        });
        root.classList.add("wco");
        await vi.waitFor(() => {
          const bounds = subagentPopup()!.getBoundingClientRect();
          expect(bounds.top + bounds.height / 2).toBeCloseTo((window.innerHeight + inset) / 2, 1);
        });
        await page.getByRole("button", { name: "Back to conversation" }).click();
        await vi.waitFor(() => expect(subagentPopup()).toBeNull());
        expect(useTaskAtriumStore.getState().open).toBe(true);
      } finally {
        useTaskAtriumStore.getState().setOpen(false);
        restoreSubagents();
        await screen.unmount();
        host.remove();
        root.style.fontSize = originalFontSize;
        root.classList.toggle("wco", originalWco);
        platformSpy.mockRestore();
        await page.viewport(originalViewport.width, originalViewport.height);
      }
    },
  );

  it.each([
    { platform: "Win32", scale: 0.8, inset: 40 },
    { platform: "Win32", scale: 1.3, inset: 40 },
    { platform: "MacIntel", scale: 1, inset: 0 },
    { platform: "Linux x86_64", scale: 1, inset: 0 },
  ])(
    "keeps caption controls clear only on Windows desktop ($platform, scale=$scale)",
    async ({ platform, scale, inset }) => {
      const root = document.documentElement;
      const originalFontSize = root.style.fontSize;
      const originalWco = root.classList.contains("wco");
      const platformSpy = vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      root.style.fontSize = `${16 * scale}px`;
      // Chromium's browser runner has no native caption overlay. Enabling its
      // production visibility class exercises the real CSS with the desktop's
      // 40px fallback, including non-target hosts where it must do nothing.
      root.classList.add("wco");
      useTaskAtriumStore.getState().setOpen(true);
      const { host, screen } = await mountOverlay();
      try {
        await vi.waitFor(() => {
          expect(overlay()?.className.includes("wco:[--cafe-atrium-titlebar-inset")).toBe(
            inset > 0,
          );
          const close = page.getByRole("button", { name: "Close Task Atrium" }).element();
          const closeBox = close.getBoundingClientRect();
          const filters = page.getByRole("group", { name: "Filter by provider" }).element();
          const filterBox = filters.getBoundingClientRect();
          expect(closeBox.top).toBeCloseTo(inset + 16 * scale, 1);
          expect(window.innerWidth - closeBox.right).toBeCloseTo(16 * scale, 1);
          expect(filterBox.top).toBeGreaterThanOrEqual(inset + 16 * scale - 1);
          expect(filterBox.right).toBeLessThanOrEqual(closeBox.left);
          expect(overlay()?.getBoundingClientRect().top).toBe(0);
          expect(getComputedStyle(overlay()!).getPropertyValue("-webkit-app-region")).toBe(
            "no-drag",
          );
        });

        // Native geometry/visibility changes must update layout without a
        // React remount, e.g. when entering fullscreen and restoring it.
        root.classList.remove("wco");
        await vi.waitFor(() => {
          const close = page.getByRole("button", { name: "Close Task Atrium" }).element();
          expect(close.getBoundingClientRect().top).toBeCloseTo(16 * scale, 1);
        });
        root.classList.add("wco");
        await page.getByRole("button", { name: "Close Task Atrium" }).click();
        await vi.waitFor(() => expect(overlay()).toBeNull());
      } finally {
        useTaskAtriumStore.getState().setOpen(false);
        await screen.unmount();
        host.remove();
        root.style.fontSize = originalFontSize;
        root.classList.toggle("wco", originalWco);
        platformSpy.mockRestore();
      }
    },
  );

  it("stays closed until it is opened", async () => {
    useTaskAtriumStore.getState().setOpen(false);
    const { host, screen } = await mountOverlay();
    try {
      expect(overlay()).toBeNull();
      useTaskAtriumStore.getState().setOpen(true);
      await vi.waitFor(() => expect(overlay()).not.toBeNull());
    } finally {
      useTaskAtriumStore.getState().setOpen(false);
      await screen.unmount();
      host.remove();
    }
  });

  it("closes on Escape without reselecting the Atrium opener", async () => {
    useTaskAtriumStore.getState().setOpen(false);
    const opener = document.createElement("button");
    opener.textContent = "Open Atrium";
    document.body.append(opener);
    opener.focus();
    const { host, screen } = await mountOverlay();
    try {
      useTaskAtriumStore.getState().setOpen(true);
      await vi.waitFor(() => expect(overlay()).not.toBeNull());
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      await vi.waitFor(() => {
        expect(overlay()).toBeNull();
        expect(useTaskAtriumStore.getState().open).toBe(false);
        expect(document.activeElement).not.toBe(opener);
      });
    } finally {
      useTaskAtriumStore.getState().setOpen(false);
      await screen.unmount();
      host.remove();
      opener.remove();
    }
  });

  it("keeps titlebar controls clickable and does not reselect the opener after pointer close", async () => {
    useTaskAtriumStore.getState().setOpen(false);
    const opener = document.createElement("button");
    opener.textContent = "Open Atrium";
    document.body.append(opener);
    opener.focus();
    const { host, screen } = await mountOverlay();
    try {
      useTaskAtriumStore.getState().setOpen(true);
      await vi.waitFor(() => {
        expect(overlay()).not.toBeNull();
        expect(overlay()?.getAttribute("data-cafe-window-no-drag")).toBe("true");
        expect(overlay()?.className).toContain("[-webkit-app-region:no-drag]");
        expect(getComputedStyle(overlay()!).getPropertyValue("-webkit-app-region")).toBe("no-drag");
      });

      await page.getByRole("button", { name: /^Codex / }).click();
      await vi.waitFor(() => {
        expect(page.getByRole("button", { name: /^Codex / }).element().ariaPressed).toBe("true");
      });
      await page.getByRole("button", { name: /^All work / }).click();
      await vi.waitFor(() => {
        expect(page.getByRole("button", { name: /^All work / }).element().ariaPressed).toBe("true");
      });
      await page.getByRole("button", { name: "Close Task Atrium" }).click();
      await vi.waitFor(() => {
        expect(overlay()).toBeNull();
        expect(useTaskAtriumStore.getState().open).toBe(false);
        expect(document.activeElement).not.toBe(opener);
      });
    } finally {
      useTaskAtriumStore.getState().setOpen(false);
      await screen.unmount();
      host.remove();
      opener.remove();
    }
  });

  it("opens as a modal dialog and moves focus into the full-screen surface", async () => {
    useTaskAtriumStore.getState().setOpen(false);
    const opener = document.createElement("button");
    opener.textContent = "Open Atrium";
    document.body.append(opener);
    opener.focus();
    const { host, screen } = await mountOverlay();
    try {
      useTaskAtriumStore.getState().setOpen(true);
      await vi.waitFor(() => {
        expect(overlay()?.getAttribute("role")).toBe("dialog");
        expect(overlay()?.getAttribute("aria-modal")).toBe("true");
        expect(overlay()?.contains(document.activeElement)).toBe(true);
        expect(Number(getComputedStyle(overlay()!).zIndex)).toBeGreaterThan(40);
      });
    } finally {
      useTaskAtriumStore.getState().setOpen(false);
      await screen.unmount();
      host.remove();
      opener.remove();
    }
  });

  it("never renders while the feature is switched off", async () => {
    atriumHarness.settings.ambianceAtriumEnabled = false;
    useTaskAtriumStore.getState().setOpen(true);
    const { host, screen } = await mountOverlay();
    try {
      await vi.waitFor(() => expect(overlay()).toBeNull());
    } finally {
      atriumHarness.settings.ambianceAtriumEnabled = true;
      useTaskAtriumStore.getState().setOpen(false);
      await screen.unmount();
      host.remove();
    }
  });
});

describe("TaskAtriumBoard interaction", () => {
  it("persists exact historical error occurrences when errors are cleared", async () => {
    atriumHarness.updateSettings.mockClear();
    const { host, screen } = await renderInTheme("dark");
    try {
      const clearButtonSelector = "button[aria-label='Clear Task Atrium errors']";
      await vi.waitFor(() => {
        expect(host.querySelector(clearButtonSelector)).not.toBeNull();
      });
      host.querySelector<HTMLElement>(clearButtonSelector)?.click();

      await vi.waitFor(() => {
        expect(atriumHarness.updateSettings).toHaveBeenCalledOnce();
      });
      expect(atriumHarness.updateSettings).toHaveBeenCalledWith({
        dismissedTaskAtriumErrors: [
          expect.objectContaining({
            environmentId: "env-1",
            threadId: "thread-error",
            turnId: "turn-error",
          }),
        ],
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("opens the thread and closes the panel when a card is clicked", async () => {
    navigations.length = 0;
    useTaskAtriumStore.getState().setOpen(true);
    const { host, screen } = await renderInTheme("dark");
    try {
      const cardSelector = "button[aria-label='Open Port the ambiance engine to WebGL']";
      await vi.waitFor(() => {
        expect(host.querySelector(cardSelector)).not.toBeNull();
      });
      host.querySelector<HTMLElement>(cardSelector)?.click();

      await vi.waitFor(() => {
        expect(navigations).toHaveLength(1);
        expect(navigations[0]?.to).toBe("/$environmentId/$threadId");
        expect((navigations[0]?.params as { threadId?: string })?.threadId).toBe("thread-1");
        // The overlay covers the whole window, so navigating without closing
        // would change the route behind a panel that still hides it.
        expect(useTaskAtriumStore.getState().open).toBe(false);
      });
    } finally {
      useTaskAtriumStore.getState().setOpen(false);
      await screen.unmount();
      host.remove();
    }
  });

  it("restricts the board to one provider when its pill is pressed", async () => {
    const { host, screen } = await renderInTheme("dark");
    try {
      await vi.waitFor(() => {
        expect(host.textContent).toContain("Port the ambiance engine to WebGL");
        expect(host.textContent).toContain("Fix flaky provider reconnect test");
      });

      const codexPill = [...host.querySelectorAll("button")].find((button) =>
        button.textContent?.startsWith("Codex"),
      );
      expect(codexPill).toBeDefined();
      codexPill?.click();

      await vi.waitFor(() => {
        expect(host.textContent).toContain("Fix flaky provider reconnect test");
        expect(host.textContent).not.toContain("Port the ambiance engine to WebGL");
        expect(codexPill?.getAttribute("aria-pressed")).toBe("true");
      });

      // Pressing it again clears the filter rather than stranding the board.
      codexPill?.click();
      await vi.waitFor(() => {
        expect(host.textContent).toContain("Port the ambiance engine to WebGL");
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
