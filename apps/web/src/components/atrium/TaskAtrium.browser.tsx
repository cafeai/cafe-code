import "../../index.css";

import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

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
            session: { provider: "claudeAgent", orchestrationStatus: "running" },
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
  };
});

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

function installStructuredSubagents(count: number): () => void {
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

  for (let index = 0; index < count; index += 1) {
    const id = `subagent-${index + 1}`;
    ids.push(id);
    activities[id] = {
      id,
      tone: "info",
      kind: "task.progress",
      summary: "Subagent update",
      payload: {
        taskId: `claude-task-${index + 1}`,
        detail:
          index === count - 1
            ? `Visible task description ${index + 1} stays completely readable even when the bounded provider text wraps across several narrow card lines without an inner clip.`
            : `Visible task description ${index + 1}`,
        subagent: {
          threadId: `claude-task-${index + 1}`,
          label: `Claude worker ${index + 1}`,
          objective: `Original task objective ${index + 1}`,
          status: "active",
          startedAt: new Date(Date.now() - (index + 1) * 1_000).toISOString(),
        },
      },
      turnId: "turn-1",
      createdAt: new Date(Date.now() - (count - index) * 1_000).toISOString(),
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
      expect(host.textContent).toContain("3 threads in motion");
      expect(host.textContent).toMatch(
        /\d+ subagents? (?:is|are) working across the active threads\./,
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
      expect(host.textContent).toContain("3 threads in motion");
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

describe("TaskAtriumOverlay", () => {
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

  it("closes on Escape", async () => {
    useTaskAtriumStore.getState().setOpen(true);
    const { host, screen } = await mountOverlay();
    try {
      await vi.waitFor(() => expect(overlay()).not.toBeNull());
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      await vi.waitFor(() => {
        expect(overlay()).toBeNull();
        expect(useTaskAtriumStore.getState().open).toBe(false);
      });
    } finally {
      useTaskAtriumStore.getState().setOpen(false);
      await screen.unmount();
      host.remove();
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
