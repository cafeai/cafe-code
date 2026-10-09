import "../index.css";
import "./desk/desk.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

const fixture = vi.hoisted(() => ({ unread: true }));

// Host identity is fixed at module load, matching the real preload bridge.
// Ordinary Mac browser coverage lives in the separate fixed-false fixture.
vi.mock("../env", () => ({ isElectron: true }));
// Only projected activity and native-host identity are controlled. The real
// titlebar hook, sidebar state, trigger, unread presenter, and CSS stay intact.
vi.mock("../environments/workspaceData", () => ({
  useWorkspaceSidebarThreads: () =>
    fixture.unread
      ? [
          {
            environmentId: "mac-titlebar-fixture",
            id: "completed-chat",
            latestTurn: { completedAt: "2026-10-09T00:00:00.000Z" },
          },
        ]
      : [],
}));
vi.mock("../uiStateStore", () => ({
  useUiStateStore: (
    select: (state: { threadLastVisitedAtById: Record<string, string> }) => unknown,
  ) => select({ threadLastVisitedAtById: {} }),
}));
vi.mock("../hooks/useHandleNewThread", () => ({
  useNewThreadHandler: () => ({ handleNewStandaloneChat: vi.fn(async () => {}) }),
}));

import { useMacDesktopTitlebar } from "../hooks/useMacDesktopTitlebar";
import { applyInterfaceScalePercent } from "../interfaceScale";
import { NoActiveThreadState } from "./NoActiveThreadState";
import { ContentSidebarTriggerWithUnreadDot } from "./sidebar/unseenCompletions";
import { SidebarProvider, useSidebar } from "./ui/sidebar";

type HeaderShape = "chat" | "settings" | "empty" | "desk";

function SidebarStateProbe() {
  const { isMobile, open, openMobile } = useSidebar();
  return (
    <output className="sr-only" data-testid="sidebar-state">
      {(isMobile ? openMobile : open) ? "open" : "closed"}
    </output>
  );
}

/**
 * Empty state is the actual product component. Chat/Settings shapes preserve
 * their ordinary padded 52px rows; Desk preserves its unpadded display:contents
 * controls. Those three deliberately avoid mounting chats, routing, transports,
 * and providers: Desk's own integration fixture verifies the actual marker.
 */
function HeaderShapeFixture({
  shape,
  top = true,
  left = true,
}: {
  shape: HeaderShape;
  top?: boolean;
  left?: boolean;
}) {
  const macTitlebar = useMacDesktopTitlebar();
  if (shape === "empty") return <NoActiveThreadState />;
  if (shape === "desk") {
    return (
      <header
        className="desk-group-bar drag-region"
        data-desktop-titlebar={top}
        data-mac-titlebar={macTitlebar && top}
        data-window-left={left}
        data-window-top={top}
      >
        <div className="desk-header-controls">
          <ContentSidebarTriggerWithUnreadDot />
        </div>
        <div className="desk-group-identity">Chat group</div>
      </header>
    );
  }
  return (
    <header
      className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5"
      data-mac-titlebar={macTitlebar}
    >
      <div className="flex min-w-0 items-center gap-2">
        <ContentSidebarTriggerWithUnreadDot />
        <span>{shape === "settings" ? "Settings" : "Chat"}</span>
      </div>
    </header>
  );
}

function titlebarFixture(shape: HeaderShape, edges?: { top?: boolean; left?: boolean }) {
  return (
    <SidebarProvider defaultOpen={false}>
      <div className="relative w-full bg-background text-foreground">
        <HeaderShapeFixture shape={shape} {...edges} />
        <SidebarStateProbe />
      </div>
    </SidebarProvider>
  );
}

async function setup(shape: HeaderShape, edges?: { top?: boolean; left?: boolean }) {
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(titlebarFixture(shape, edges), { container: host });
  return {
    host,
    screen,
    async cleanup() {
      await screen.unmount();
      host.remove();
    },
  };
}

function assertMacGeometry(host: HTMLElement) {
  const header = host.querySelector<HTMLElement>("header")!;
  const toggle = header.querySelector<HTMLButtonElement>('[data-sidebar="trigger"]')!;
  const headerBounds = header.getBoundingClientRect();
  const toggleBounds = toggle.getBoundingClientRect();
  expect(header.dataset.macTitlebar).toBe("true");
  expect(headerBounds.height).toBe(50);
  expect(toggleBounds.left - headerBounds.left).toBeCloseTo(90, 1);
  expect(toggleBounds.top + toggleBounds.height / 2 - headerBounds.top).toBeCloseTo(25, 1);
  // Three pixels also leave room for the keyboard focus ring and its offset
  // at the largest permitted interface size, rather than testing glyphs only.
  expect(toggleBounds.top).toBeGreaterThan(headerBounds.top + 3);
  expect(toggleBounds.bottom).toBeLessThan(headerBounds.bottom - 3);
  expect(getComputedStyle(toggle).getPropertyValue("-webkit-app-region")).toBe("no-drag");
  const dot = header.querySelector<HTMLElement>('[data-testid="unseen-completions-dot"]')!;
  const dotBounds = dot.getBoundingClientRect();
  expect(dot.getAttribute("aria-hidden")).toBe("true");
  expect(dotBounds.left).toBeGreaterThanOrEqual(toggleBounds.left);
  expect(dotBounds.right).toBeLessThanOrEqual(toggleBounds.right);
  expect(dotBounds.top).toBeGreaterThanOrEqual(toggleBounds.top);
  expect(dotBounds.bottom).toBeLessThanOrEqual(toggleBounds.bottom);
}

beforeEach(async () => {
  fixture.unread = true;
  applyInterfaceScalePercent(100);
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  await page.viewport(1100, 800);
});
afterEach(() => {
  applyInterfaceScalePercent(100);
  document.documentElement.classList.remove("dark");
  vi.restoreAllMocks();
});

describe("macOS Electron titlebar clearance", () => {
  it.each(
    ([80, 100, 130] as const).flatMap((scale) =>
      (["chat", "settings", "empty", "desk"] as const).map((shape) => ({ scale, shape })),
    ),
  )("keeps the hidden-sidebar toggle clear in $shape at $scale%", async ({ scale, shape }) => {
    applyInterfaceScalePercent(scale);
    const { host, cleanup } = await setup(shape);
    try {
      await vi.waitFor(() => assertMacGeometry(host));
    } finally {
      await cleanup();
    }
  });

  it("opens navigation through the accessible non-draggable toggle and hides its unread dot", async () => {
    const { host, screen, cleanup } = await setup("settings");
    try {
      assertMacGeometry(host);
      await expect.element(screen.getByTestId("sidebar-state")).toHaveTextContent("closed");
      await screen.getByRole("button", { name: "Toggle Sidebar", exact: true }).click();
      await expect.element(screen.getByTestId("sidebar-state")).toHaveTextContent("open");
      expect(host.querySelector('[data-sidebar="trigger"]')).toBeNull();
      expect(host.querySelector('[data-testid="unseen-completions-dot"]')).toBeNull();
      expect(parseFloat(getComputedStyle(host.querySelector("header")!).paddingLeft)).toBe(20);
    } finally {
      await cleanup();
    }
  });

  it.each([
    { platform: "Win32", width: 1100 },
    { platform: "Linux x86_64", width: 1100 },
    { platform: "MacIntel", width: 390 },
  ])("leaves ordinary geometry on $platform with width=$width", async ({ platform, width }) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    await page.viewport(width, 800);
    const { host, cleanup } = await setup("settings");
    try {
      const header = host.querySelector<HTMLElement>("header")!;
      const toggle = header.querySelector('[data-sidebar="trigger"]')!;
      expect(header.dataset.macTitlebar).not.toBe("true");
      expect(header.getBoundingClientRect().height).toBe(52);
      expect(toggle.getBoundingClientRect().left - header.getBoundingClientRect().left).toBe(20);
    } finally {
      await cleanup();
    }
  });

  it.each([
    { top: false, left: true },
    { top: true, left: false },
  ])(
    "does not reserve traffic-light space in a Desk pane with top=$top and left=$left",
    async (edges) => {
      const { host, cleanup } = await setup("desk", edges);
      try {
        const header = host.querySelector<HTMLElement>("header")!;
        const toggle = header.querySelector('[data-sidebar="trigger"]')!;
        expect(parseFloat(getComputedStyle(header).paddingLeft)).toBe(0);
        expect(getComputedStyle(toggle).display).toBe("none");
        expect(header.getBoundingClientRect().height).toBe(edges.top ? 50 : 44);
      } finally {
        await cleanup();
      }
    },
  );

  it.each(([80, 130] as const).flatMap((scale) => [true, false].map((dark) => ({ scale, dark }))))(
    "captures illustrative native clearance at $scale%, dark=$dark",
    async ({ scale, dark }) => {
      applyInterfaceScalePercent(scale);
      document.documentElement.classList.toggle("dark", dark);
      const { host, cleanup } = await setup("settings");
      try {
        assertMacGeometry(host);
        // These rectangles illustrate the unchanged native x=16/y=18 margin
        // with 14px buttons. Chromium cannot qualify actual AppKit hit bounds,
        // fullscreen transitions, or system-controlled traffic-light appearance.
        const controls = document.createElement("div");
        controls.setAttribute("aria-hidden", "true");
        controls.style.cssText =
          "position:absolute;left:16px;top:18px;display:flex;gap:6px;pointer-events:none";
        for (const color of ["#ff5f57", "#febc2e", "#28c840"]) {
          const light = document.createElement("span");
          light.style.cssText = `width:14px;height:14px;border-radius:50%;background:${color}`;
          controls.append(light);
        }
        host.querySelector("header")!.append(controls);
        const bounds = controls.getBoundingClientRect();
        const toggleBounds = host
          .querySelector('[data-sidebar="trigger"]')!
          .getBoundingClientRect();
        expect(toggleBounds.left - bounds.right).toBeCloseTo(20, 1);
        await page.screenshot({
          element: host.querySelector("header")!,
          path: `../../../../.explorations/mac-titlebar-regression/illustrative-${scale}-${dark ? "dark" : "light"}.png`,
        });
      } finally {
        await cleanup();
      }
    },
  );
});
