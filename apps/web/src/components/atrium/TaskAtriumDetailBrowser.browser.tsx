import "../../index.css";

import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

// Desktop detection is a module-load constant. Use an independent graph with
// no bridge rather than changing a desktop mock while a dialog is mounted.
vi.mock("../../env", () => ({ isElectron: false }));

const harness = vi.hoisted(() => {
  const startedAt = "2026-10-03T09:00:00.000Z";
  const state = {
    activeEnvironmentId: "browser-env",
    environmentStateById: {
      "browser-env": {
        projectIds: [],
        projectById: {},
        threadIds: ["browser-thread"],
        threadSessionById: {},
        threadTurnStateById: {},
        activityIdsByThreadId: { "browser-thread": ["worker-progress"] },
        activityByThreadId: {
          "browser-thread": {
            "worker-progress": {
              id: "worker-progress",
              tone: "info",
              kind: "task.progress",
              summary: "Subagent update",
              payload: {
                taskId: "browser-worker",
                subagent: {
                  threadId: "browser-worker",
                  label: "Browser worker",
                  objective: "Synthetic layout fixture",
                  status: "active",
                  startedAt,
                },
              },
              turnId: "browser-turn",
              createdAt: startedAt,
            },
          },
        },
        sidebarThreadSummaryById: {
          "browser-thread": {
            id: "browser-thread",
            environmentId: "browser-env",
            projectId: null,
            title: "Synthetic browser chat",
            session: { provider: "claudeAgent", orchestrationStatus: "running" },
            createdAt: startedAt,
            archivedAt: null,
            latestTurn: {
              turnId: "browser-turn",
              state: "running",
              requestedAt: startedAt,
              startedAt,
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
  return {
    state,
    settings: {
      ambianceAtriumEnabled: true,
      continueBackgroundAnimations: false,
      ambianceAtriumColor: "",
      ambianceColor: "",
      appAccentColor: "",
      themeAccentColor: "",
      dismissedTaskAtriumErrors: [],
    },
  };
});

vi.mock("../../hooks/useSettings", () => ({
  useSettings: (selector: (settings: typeof harness.settings) => unknown) =>
    selector(harness.settings),
  useUpdateSettings: () => ({ updateSettings: vi.fn() }),
}));
vi.mock("../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../../store", () => ({
  selectAnyThreadRunning: () => true,
  useStore: Object.assign(
    (selector: (state: typeof harness.state) => unknown) => selector(harness.state),
    {
      getState: () => harness.state,
    },
  ),
}));
vi.mock("../../environments/runtime/service", () => ({
  retainThreadDetailSubscription: () => () => {},
}));
vi.mock("../stats/useUsageCostSummary", () => ({
  useUsageCostSummary: () => ({ loaded: false, raw: null }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

// The real popup/portal owns the layout under test. Keep its read-only child
// synthetic so this browser-boundary fixture never acquires a transport.
vi.mock("../chat/SubagentDetailView", () => ({
  SubagentDetailView: ({ onBack }: { onBack: () => void }) => (
    <button type="button" onClick={onBack}>
      Back to conversation
    </button>
  ),
}));

import { TaskAtriumBoard } from "./TaskAtrium";

it("preserves browser worker-popup geometry on Windows even with native-controls visibility", async () => {
  const root = document.documentElement;
  const originalWco = root.classList.contains("wco");
  const originalViewport = { width: window.innerWidth, height: window.innerHeight };
  const platformSpy = vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  root.classList.add("wco");
  await page.viewport(640, 720);
  const screen = await render(<TaskAtriumBoard />);
  try {
    await page.getByRole("button", { name: "View Browser worker activity", exact: true }).click();
    await vi.waitFor(() => {
      expect(page.getByRole("button", { name: "Back to conversation" }).element()).toBeVisible();
    });
    await page.viewport(640, 220);
    await vi.waitFor(() => {
      const popup = document.querySelector<HTMLElement>('[data-cafe-atrium-subagent-popup="true"]');
      expect(popup).not.toBeNull();
      if (!popup) throw new Error("Browser worker popup did not mount");
      const bounds = popup.getBoundingClientRect();
      expect(popup.className).not.toContain("wco:[--cafe-atrium-detail-titlebar-inset");
      expect(bounds.height).toBeCloseTo(window.innerHeight * 0.85, 1);
      expect(bounds.top + bounds.height / 2).toBeCloseTo(window.innerHeight / 2, 1);
      expect(bounds.left + bounds.width / 2).toBeCloseTo(window.innerWidth / 2, 1);
      expect(getComputedStyle(popup).getPropertyValue("-webkit-app-region")).toBe("no-drag");
    });
    await page.getByRole("button", { name: "Back to conversation" }).click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-cafe-atrium-subagent-popup="true"]')).toBeNull();
    });
  } finally {
    await screen.unmount();
    root.classList.toggle("wco", originalWco);
    platformSpy.mockRestore();
    await page.viewport(originalViewport.width, originalViewport.height);
  }
});
