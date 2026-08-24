import "../../index.css";

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
        threadIds: [thread],
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
  return {
    theme,
    settings: {
      ambianceAtrium: "empty-state",
      continueBackgroundAnimations: true,
      ambianceAtriumIdleMinutes: 5,
      ambianceAtriumColor: "",
      ambianceColor: "",
      appAccentColor: "",
      themeAccentColor: "",
    },
    useStore,
  };
});

vi.mock("../../hooks/useSettings", () => ({
  useSettings: (selector: (settings: typeof atriumHarness.settings) => unknown) =>
    selector(atriumHarness.settings),
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

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => () => Promise.resolve(),
}));

import { TaskAtriumBoard } from "./TaskAtrium";

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

        const card = host.querySelector("button[aria-label^='Open ']");
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
});
