import { selectWorkspaceEnvironment } from "../../environments/workspace";
import "../../index.css";
import type { CDPSession } from "@vitest/browser-playwright";

import { EnvironmentId, ThreadId, type ContextMenuItem } from "@cafecode/contracts";
import { DraftId } from "../../composerDraftStore";
import { cdp, page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  createDeskState,
  deskGroupIds,
  deskTabKey,
  hydrateDesk,
  serializeDesk,
} from "../../deskModel";
import { useDeskStore } from "../../deskStore";
import { applyInterfaceScalePercent } from "../../interfaceScale";
import type { ThreadRouteTarget } from "../../threadRoutes";
import { resolveThreadStatusPill, type ThreadStatusPill } from "../Sidebar.logic";
import { ThreadStatusLabel } from "../ThreadStatusLabel";
import DeskWorkspace from "./DeskWorkspace";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn<(options: { to: string; params?: Record<string, string> }) => Promise<void>>(),
  showMenu: vi.fn<(items: ContextMenuItem[]) => Promise<string | undefined>>(),
  rename: vi.fn(async () => undefined),
  archive: vi.fn(async () => undefined),
  recycle: vi.fn(async () => undefined),
  delete: vi.fn(async () => undefined),
  hardDelete: vi.fn(async () => undefined),
  confirm: vi.fn(async () => true),
  palette: vi.fn(),
  macPlatform: false,
  openInEditor: vi.fn(async () => undefined),
  openTerminal: vi.fn(async () => undefined),
  // Status rendered by every tab's metadata; null keeps the fixture idle.
  tabStatus: null as ThreadStatusPill | null,
  // Synthetic authoritative inventory and reactive route parameters exercise
  // route echo reconciliation without providers, transports or user profiles.
  params: {} as Record<string, string>,
  primaryEnvironmentId: "workspace-fixture",
  routeListeners: new Set<() => void>(),
  environment: {
    bootstrapComplete: true,
    threadShellById: Object.fromEntries(
      ["one", "two", "three"].map((id) => [id, { id, archivedAt: null }]),
    ) as Record<string, { id: string; archivedAt: string | null }>,
  },
  composer: {
    draftThreadsByThreadKey: {} as Record<
      string,
      {
        environmentId: string;
        threadId: string;
        projectId?: string | null;
        promotedTo?: { environmentId: string; threadId: string };
      }
    >,
  },
}));
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await importOriginal<typeof import("@tanstack/react-router")>()),
    useNavigate: () => mocks.navigate,
    useParams: ({ select }: { select: (params: Record<string, string>) => unknown }) => {
      const params = useSyncExternalStore(
        (listener) => {
          mocks.routeListeners.add(listener);
          return () => {
            mocks.routeListeners.delete(listener);
          };
        },
        () => mocks.params,
      );
      return select(params);
    },
  };
});
vi.mock("../../environments/primary", () => ({
  usePrimaryEnvironmentId: () => mocks.primaryEnvironmentId,
  readPrimaryEnvironmentDescriptor: () => ({ environmentId: mocks.primaryEnvironmentId }),
  getPrimaryKnownEnvironment: () => null,
}));
vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("../../store", () => ({
  useStore: (selector: (state: object) => unknown) => selector({}),
  selectEnvironmentState: () => mocks.environment,
  selectThreadByRef: () => undefined,
}));
vi.mock("../../composerDraftStore", () => ({
  DraftId: { make: (value: string) => value },
  finalizePromotedDraftThreadByRef: vi.fn(),
  useComposerDraftStore: (selector: (state: typeof mocks.composer) => unknown) =>
    selector(mocks.composer),
}));
vi.mock("../ChatView.logic", () => ({ threadHasStarted: () => false }));
vi.mock("../../uiStateStore", () => ({
  useUiStateStore: (selector: (state: { sessionRailDocked: boolean }) => unknown) =>
    selector({ sessionRailDocked: true }),
}));
vi.mock("../../commandPaletteStore", () => ({
  useCommandPaletteStore: { getState: () => ({ setOpen: mocks.palette }) },
}));
vi.mock("../../localApi", () => ({
  readLocalApi: () => ({
    contextMenu: { show: mocks.showMenu },
    dialogs: { confirm: mocks.confirm },
    shell: { openInEditor: mocks.openInEditor, openTerminal: mocks.openTerminal },
  }),
  ensureLocalApi: () => ({
    contextMenu: { show: mocks.showMenu },
    dialogs: { confirm: mocks.confirm },
    persistence: {},
  }),
}));
vi.mock("../../hooks/useThreadActions", () => ({
  useThreadActions: () => ({
    archiveThread: mocks.archive,
    confirmAndDeleteThread: mocks.recycle,
    deleteThread: mocks.delete,
    hardDeleteThread: mocks.hardDelete,
  }),
}));
vi.mock("../../hooks/useSettings", async () => {
  const { DEFAULT_UNIFIED_SETTINGS } = await import("@cafecode/contracts/settings");
  return {
    getClientSettings: () => DEFAULT_UNIFIED_SETTINGS,
    useSettings: (select: (settings: typeof DEFAULT_UNIFIED_SETTINGS) => unknown) =>
      select(DEFAULT_UNIFIED_SETTINGS),
  };
});
vi.mock("../../threadRename", () => ({ renameThread: mocks.rename }));
vi.mock("../ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: (value: unknown) => value,
}));
vi.mock("../../lib/utils", () => ({
  cn: (...values: unknown[]) => values.flat().filter(Boolean).join(" "),
  newCommandId: () => "fixture-command",
  isMacPlatform: () => mocks.macPlatform,
}));
vi.mock("./useDeskTabMetadata", () => {
  const projectName = "Fixture project";
  const metadata = (target: ThreadRouteTarget) => ({
    title: target.kind === "server" ? `Chat ${target.threadRef.threadId}` : "New chat",
    projectName,
    threadRef: target.kind === "server" ? target.threadRef : null,
    working: false,
    attention: false,
    exists: true,
    status: mocks.tabStatus,
  });
  return {
    useDeskTabMetadata: metadata,
    readDeskTabMetadata: metadata,
    readDeskTabOpenContext: (target: ThreadRouteTarget) => ({
      environmentId:
        target.kind === "server" ? target.threadRef.environmentId : mocks.primaryEnvironmentId,
      cwd: target.kind === "server" ? `/fixture/${target.threadRef.threadId}` : null,
    }),
  };
});
vi.mock("../../rpc/serverState", () => ({
  useServerAvailableEditors: () => ["vscode", "file-manager"],
  useServerTerminal: () => ({ available: true, label: "Terminal" }),
}));
vi.mock("../../localCapabilities", () => ({
  getLocalShellCapabilities: () => ({ canOpenLocalEditor: true, canOpenLocalTerminal: true }),
}));
vi.mock("../../editorOpenOptions", () => ({
  resolveEditorOpenOptions: () => [{ value: "vscode", label: "VS Code" }],
}));
vi.mock("../../editorPreferences", () => ({
  usePreferredEditor: () => ["vscode", vi.fn()],
}));
vi.mock("../NoActiveThreadState", () => ({
  // Render the Desk-supplied actions so the empty-state controls stay testable.
  NoActiveThreadState: (props: { secondaryActions?: import("react").ReactNode }) => (
    <div>
      <p>No active chat</p>
      {props.secondaryActions}
    </div>
  ),
}));
vi.mock("../ChatView", async () => {
  const { useChatPane } = await import("../../chatPaneContext");
  return {
    default: function FixtureChatView({
      threadId,
      draftId,
      navigationSlot,
    }: {
      threadId: string;
      draftId?: string;
      navigationSlot?: (controls: import("react").ReactNode) => import("react").ReactNode;
    }) {
      const pane = useChatPane();
      return (
        <div
          className="flex min-h-0 flex-1 flex-col"
          data-mock-chat={threadId}
          data-mock-draft={draftId}
          data-pane-active={pane.active}
          data-pane-visible={pane.visible}
        >
          {navigationSlot?.(null)}
          <div className="p-3">
            <p>Existing chat {threadId}</p>
            <button
              type="button"
              aria-label={`Toggle rail ${threadId}`}
              aria-pressed={pane.sessionRailDocked === true}
              onClick={() => pane.onSessionRailDockedChange?.(!pane.sessionRailDocked)}
            >
              Rail
            </button>
            <label>
              Existing composer {threadId}
              <textarea aria-label={`Existing composer ${threadId}`} />
            </label>
          </div>
        </div>
      );
    },
  };
});

const environmentId = EnvironmentId.make("workspace-fixture");
const target = (id: string): ThreadRouteTarget => ({
  kind: "server",
  threadRef: { environmentId, threadId: ThreadId.make(id) },
});
const key = (id: string) => deskTabKey(target(id));
beforeEach(async () => {
  selectWorkspaceEnvironment(null);
  await page.viewport(1440, 900);
  useDeskStore.setState({
    desk: createDeskState(environmentId),
    draftEditors: {},
    activeDraftId: null,
  });
  mocks.params = {};
  mocks.primaryEnvironmentId = environmentId;
  mocks.macPlatform = false;
  mocks.openInEditor.mockClear();
  mocks.openTerminal.mockClear();
  mocks.composer.draftThreadsByThreadKey = {};
  mocks.environment = {
    bootstrapComplete: true,
    threadShellById: Object.fromEntries(
      ["one", "two", "three"].map((id) => [id, { id, archivedAt: null }]),
    ),
  };
  mocks.showMenu.mockReset();
  mocks.showMenu.mockResolvedValue(undefined);
  mocks.navigate.mockReset();
  mocks.navigate.mockImplementation(async (options) => {
    mocks.params = options.params ?? {};
    for (const notify of mocks.routeListeners) notify();
  });
  mocks.rename.mockClear();
  mocks.archive.mockClear();
  mocks.recycle.mockClear();
  mocks.delete.mockClear();
  mocks.hardDelete.mockClear();
  mocks.confirm.mockClear();
  mocks.palette.mockClear();
});
afterEach(() => {
  selectWorkspaceEnvironment(null);
  localStorage.removeItem("cafe-code:desk:v1:remote-workspace-fixture");
  useDeskStore.setState({ desk: createDeskState(), draftEditors: {}, activeDraftId: null });
  localStorage.removeItem(`cafe-code:desk:v1:${environmentId}`);
});

async function setup(ids = ["one", "two", "three"]) {
  ids.forEach((id) => useDeskStore.getState().dispatch({ type: "open", target: target(id) }));
  const host = document.createElement("div");
  host.style.width = "100%";
  document.body.append(host);
  const screen = await render(<DeskWorkspace />, { container: host });
  return {
    screen,
    host,
    async cleanup() {
      await screen.unmount();
      host.remove();
    },
  };
}

function deferMenu() {
  let resolveMenu!: (choice: string | undefined) => void;
  const result = new Promise<string | undefined>((resolve) => {
    resolveMenu = resolve;
  });
  mocks.showMenu.mockImplementationOnce(() => result);
  return async (choice: string | undefined) => {
    resolveMenu(choice);
    // Observe the continuation and the React commit it can schedule. This is
    // a browser frame boundary, not a retry of the action under test.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  };
}

function browserPoint(point: { x: number; y: number }) {
  let { x, y } = point;
  let frame = window.frameElement;
  while (frame) {
    // The containing element belongs to another window's realm, so its
    // HTMLElement constructor is intentionally not this iframe's constructor.
    const frameElement = frame as HTMLElement;
    const rect = frameElement.getBoundingClientRect();
    // Vitest scales its test iframe to fit the runner's viewport. CDP uses
    // top-level coordinates, while DOM rectangles below use iframe CSS pixels.
    // Carry both offset and scale through every frame rather than landing a
    // nominal pane-center drag on a pane edge at a reduced runner scale.
    x = rect.left + (x + frameElement.clientLeft) * (rect.width / frameElement.offsetWidth);
    y = rect.top + (y + frameElement.clientTop) * (rect.height / frameElement.offsetHeight);
    frame = frame.ownerDocument.defaultView?.frameElement ?? null;
  }
  return { x, y };
}

/** PointerSensor needs an activation move and a subsequent measured move.
 * Playwright's generic HTML drag helper can jump directly to mouseup before
 * React publishes the activated droppable registry. Send real Chromium input
 * with frame boundaries, preserving the same pointer path as a user drag.
 */
async function dragPointer(
  source: Element,
  destination: { x: number; y: number },
  whileDragging?: (moveTo: (point: { x: number; y: number }) => Promise<void>) => Promise<void>,
) {
  const rect = source.getBoundingClientRect();
  const start = browserPoint({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  const end = browserPoint(destination);
  const input: CDPSession = cdp();
  let releasePoint = end;
  const moveTo = async (point: { x: number; y: number }) => {
    releasePoint = browserPoint(point);
    await input.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      ...releasePoint,
      button: "left",
      buttons: 1,
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  };
  await input.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...start });
  await input.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...start,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  // Pointer down can activate the source pane. Let that ordinary React update
  // settle before crossing the activation threshold, as a physical drag does.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  try {
    for (let step = 1; step <= 8; step += 1) {
      await input.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: start.x + ((end.x - start.x) * step) / 8,
        y: start.y + ((end.y - start.y) * step) / 8,
        button: "left",
        buttons: 1,
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    await whileDragging?.(moveTo);
  } finally {
    await input.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...releasePoint,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    // dnd-kit intentionally suppresses clicks for 50ms after pointer release.
    // Let that documented sensor teardown finish before the next interaction
    // or test, instead of falsely treating the suppressed click as a UI bug.
    await new Promise<void>((resolve) => setTimeout(resolve, 75));
  }
}

function expectInsertionSlot(host: HTMLElement, strip: Element, index: number) {
  const markers = host.querySelectorAll<HTMLElement>("[data-desk-insertion-index]");
  expect(markers).toHaveLength(1);
  const marker = markers[0]!;
  expect(strip.contains(marker)).toBe(true);
  expect(marker.dataset.deskInsertionIndex).toBe(String(index));
  // Reordering is distinct from moving/splitting a pane. Assert the feedback
  // before release: checking only final order missed the misleading rectangle.
  expect(host.querySelector(".desk-drop-hint")).toBeNull();
  const markerBounds = marker.getBoundingClientRect();
  const stripBounds = strip.getBoundingClientRect();
  expect(markerBounds.left).toBeGreaterThanOrEqual(stripBounds.left - 2);
  expect(markerBounds.right).toBeLessThanOrEqual(stripBounds.right + 2);
}

function rootDeskSplit() {
  const layout = useDeskStore.getState().desk.layout;
  if (layout.kind !== "split") throw new Error("Expected a split fixture layout");
  return layout;
}

function expectUsablePanes(host: HTMLElement, count: number) {
  const panes = host.querySelectorAll(".desk-pane");
  expect(panes).toHaveLength(count);
  for (const pane of panes) {
    const bounds = pane.getBoundingClientRect();
    // CSS layout rounds fractional percentages to physical layout units. The
    // tolerance is below one CSS pixel, not permission to hide a small pane.
    expect(bounds.width).toBeGreaterThanOrEqual(379.9);
    expect(bounds.height).toBeGreaterThanOrEqual(279.9);
  }
}

describe("Desk workspace navigation chrome", () => {
  it.each(["open-editor:vscode", "open-terminal"])(
    "opens %s for the clicked tab without selecting it",
    async (choice) => {
      const { screen, cleanup } = await setup(["one", "two"]);
      try {
        mocks.showMenu.mockResolvedValueOnce(choice);
        await screen.getByRole("tab", { name: "Chat one", exact: true }).click({ button: "right" });
        expect(mocks.showMenu.mock.lastCall?.[0]).toContainEqual({
          id: "open-project",
          label: "Open",
          children: [
            { id: "open-editor:vscode", label: "VS Code" },
            { id: "open-terminal", label: "Open Terminal here", disabled: false },
          ],
        });
        await vi.waitFor(() => {
          if (choice === "open-terminal")
            expect(mocks.openTerminal).toHaveBeenCalledWith("/fixture/one");
          else expect(mocks.openInEditor).toHaveBeenCalledWith("/fixture/one", "vscode");
        });
        expect(useDeskStore.getState().desk.groups.g1?.activeTabKey).toBe(key("two"));
      } finally {
        await cleanup();
      }
    },
  );

  it("rejects a pending Open choice after the original Desk is replaced", async () => {
    const { screen, cleanup } = await setup(["one", "two"]);
    try {
      const finish = deferMenu();
      await screen.getByRole("tab", { name: "Chat one", exact: true }).click({ button: "right" });
      useDeskStore.setState({ desk: createDeskState(environmentId) });
      await finish("open-editor:vscode");
      expect(mocks.openInEditor).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("reserves native control space only in the top right split pane", async () => {
    document.documentElement.classList.add("wco");
    const { host, cleanup } = await setup(["one", "two", "three"]);
    try {
      useDeskStore
        .getState()
        .dispatch({ type: "split", tabKey: key("two"), targetGroupId: "g1", edge: "right" });
      useDeskStore
        .getState()
        .dispatch({ type: "split", tabKey: key("three"), targetGroupId: "g1", edge: "bottom" });
      await vi.waitFor(() => {
        const bars = [...host.querySelectorAll<HTMLElement>(".desk-group-bar")];
        expect(bars).toHaveLength(3);
        const right = bars.find((bar) => bar.dataset.windowRight === "true")!;
        const lower = bars.find((bar) => bar.dataset.windowTop === "false")!;
        const left = bars.find((bar) => bar !== right && bar !== lower)!;
        expect(parseFloat(getComputedStyle(right).paddingRight)).toBeGreaterThan(130);
        expect(parseFloat(getComputedStyle(left).paddingRight)).toBe(0);
        expect(parseFloat(getComputedStyle(lower).paddingRight)).toBe(0);
        expect(lower.classList.contains("drag-region")).toBe(false);
        expect(lower.getBoundingClientRect().height).toBeCloseTo(44, 0);
      });
    } finally {
      await cleanup();
      document.documentElement.classList.remove("wco");
    }
  });

  it.each([
    { platform: "mac", scale: 100, x: 0, controls: 0, dark: true },
    { platform: "windows", scale: 80, x: 0, controls: 138, dark: true },
    { platform: "windows", scale: 130, x: 0, controls: 138, dark: false },
    { platform: "linux", scale: 100, x: 0, controls: 138, dark: true },
    { platform: "linux-left", scale: 130, x: 100, controls: 0, dark: false },
  ])(
    "keeps taller titlebar tabs clear of $platform controls at $scale%",
    async ({ platform, scale, x, controls, dark }) => {
      applyInterfaceScalePercent(scale);
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.classList.toggle("wco", platform !== "mac");
      document.documentElement.style.setProperty("--app-titlebar-area-x", `${x}px`);
      document.documentElement.style.setProperty(
        "--app-titlebar-area-width",
        `${1440 - x - controls}px`,
      );
      const { host, cleanup } = await setup(["one", "two"]);
      try {
        const bar = host.querySelector<HTMLElement>(".desk-group-bar")!;
        const box = bar.getBoundingClientRect();
        const style = getComputedStyle(bar);
        expect(box.height).toBeGreaterThanOrEqual(Math.max(44, (44 * scale) / 100) - 0.1);
        expect(bar.dataset.desktopTitlebar).toBe("true");
        expect(box.top).toBeLessThanOrEqual(1);
        expect(parseFloat(style.paddingLeft)).toBeCloseTo(Math.max(0, x - box.left), 0);
        expect(parseFloat(style.paddingRight)).toBeCloseTo(
          Math.max(0, controls - (1440 - box.right)),
          0,
        );
        for (const button of bar.querySelectorAll("button")) {
          const bounds = button.getBoundingClientRect();
          expect(bounds.left).toBeGreaterThanOrEqual(x);
          expect(bounds.right).toBeLessThanOrEqual(1440 - controls);
        }
        await page.screenshot({
          element: host,
          path: `../../../../../.explorations/titlebar-visual/${platform}-${scale}-${dark ? "dark" : "light"}.png`,
        });
      } finally {
        await cleanup();
        document.documentElement.classList.remove("wco");
        document.documentElement.style.removeProperty("--app-titlebar-area-x");
        document.documentElement.style.removeProperty("--app-titlebar-area-width");
        applyInterfaceScalePercent(100);
      }
    },
  );
  it("keeps the chat selected through Focus group when a hidden editor's first send completes", async () => {
    const draftId = DraftId.make("sending-editor");
    const draft = {
      environmentId,
      threadId: "three",
      projectId: null,
      promotedTo: { environmentId, threadId: "three" },
    };
    mocks.composer.draftThreadsByThreadKey = { [draftId]: draft };
    for (const id of ["one", "two"])
      useDeskStore.getState().dispatch({ type: "open", target: target(id) });
    useDeskStore.getState().dispatch({
      type: "split",
      tabKey: key("two"),
      targetGroupId: "g1",
      edge: "right",
    });
    useDeskStore.getState().showDraftEditor(draftId, "g2");
    mocks.params = { draftId };
    const { screen, host, cleanup } = await setup([]);
    try {
      await expect
        .element(screen.getByRole("textbox", { name: "Existing composer three" }))
        .toBeVisible();
      const editor = useDeskStore.getState().draftEditors[draftId];
      mocks.showMenu.mockResolvedValueOnce("focus");
      await screen.getByRole("tab", { name: "Chat one", exact: true }).click({ button: "right" });
      expect(mocks.showMenu.mock.lastCall?.[0]).toContainEqual({
        id: "focus",
        label: "Focus group",
        disabled: false,
      });
      await vi.waitFor(() => {
        expect(useDeskStore.getState().activeDraftId).toBeNull();
        expect(useDeskStore.getState().desk.activeGroupId).toBe("g1");
        expect(useDeskStore.getState().desk.focusedGroupId).toBe("g1");
        expect(mocks.params).toEqual({ environmentId, threadId: "one" });
      });
      expect(useDeskStore.getState().draftEditors[draftId]).toBe(editor);
      const hiddenComposer = host.querySelector<HTMLTextAreaElement>(
        '[data-mock-draft="sending-editor"] textarea',
      );
      expect(hiddenComposer).not.toBeNull();
      expect(hiddenComposer?.closest("[hidden][inert]")).not.toBeNull();
      expect(mocks.composer.draftThreadsByThreadKey[draftId]).toBe(draft);
      const navigations = mocks.navigate.mock.calls.length;
      // Model the first-send ownership handoff to the canonical saved chat.
      mocks.composer.draftThreadsByThreadKey = {};
      expect(
        useDeskStore.getState().promoteDraftEditor(draftId, {
          environmentId,
          threadId: ThreadId.make("three"),
        }),
      ).toBe(true);
      await vi.waitFor(() => {
        expect(useDeskStore.getState().desk.groups.g2?.tabs).toContain(key("three"));
        expect(useDeskStore.getState().desk.groups.g2?.activeTabKey).toBe(key("two"));
        expect(useDeskStore.getState().desk.groups.g1?.activeTabKey).toBe(key("one"));
        expect(useDeskStore.getState().desk.activeGroupId).toBe("g1");
        expect(useDeskStore.getState().desk.focusedGroupId).toBe("g1");
        expect(mocks.params).toEqual({ environmentId, threadId: "one" });
        expect(
          host.querySelector('[data-mock-chat="one"][data-pane-active="true"]'),
        ).not.toBeNull();
      });
      expect(mocks.navigate.mock.calls).toHaveLength(navigations);
      expect(useDeskStore.getState().draftEditors[draftId]).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it.each(["empty", "saved", "legacy-draft"] as const)(
    "renders the standalone editor without an open-chat tab from a %s Desk",
    async (mode) => {
      const draftId = DraftId.make("standalone-editor");
      const draft = { environmentId, threadId: "future-chat", projectId: null };
      mocks.composer.draftThreadsByThreadKey = { [draftId]: draft };
      mocks.params = { draftId };
      if (mode === "legacy-draft")
        useDeskStore.getState().dispatch({ type: "open", target: { kind: "draft", draftId } });
      const { host, cleanup } = await setup(mode === "empty" ? [] : ["one"]);
      try {
        await vi.waitFor(() => {
          expect(useDeskStore.getState().activeDraftId).toBe(draftId);
          expect(useDeskStore.getState().desk.sidebarMode).toBe("projects");
          expect(useDeskStore.getState().desk.groups.g1?.tabs).toEqual(
            mode === "empty" ? [] : [key("one")],
          );
          expect(
            host.querySelector('[data-mock-draft="standalone-editor"][data-pane-active="true"]'),
          ).not.toBeNull();
          expect(
            Array.from(host.querySelectorAll<HTMLElement>("[data-desk-tab-key]")).some(
              (tab) => tab.dataset.deskTabKey === deskTabKey({ kind: "draft", draftId }),
            ),
          ).toBe(false);
        });
        const composer = host.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Existing composer future-chat"]',
        );
        expect(composer).not.toBeNull();
        composer!.focus();
        expect(useDeskStore.getState().activeDraftId).toBe(draftId);
        expect(mocks.composer.draftThreadsByThreadKey[draftId]).toBe(draft);
        if (mode !== "empty") {
          const tab = Array.from(
            host.querySelectorAll<HTMLButtonElement>("[data-desk-tab-key]"),
          ).find((button) => button.dataset.deskTabKey === key("one"));
          await userEvent.click(tab!);
          await vi.waitFor(() => {
            expect(useDeskStore.getState().activeDraftId).toBeNull();
            expect(
              host.querySelector('[data-mock-chat="one"][data-pane-active="true"]'),
            ).not.toBeNull();
          });
          expect(mocks.composer.draftThreadsByThreadKey[draftId]).toBe(draft);
        }
      } finally {
        await cleanup();
      }
    },
  );

  it.each(["cold", "last-selected"] as const)(
    "keeps a hidden queue host when the %s server candidate still belongs to a pending draft",
    async (mode) => {
      const pendingDraft = {
        environmentId,
        threadId: "draft-local-one",
        promotedTo: { environmentId, threadId: "one" },
      };
      if (mode === "cold") mocks.composer.draftThreadsByThreadKey = { pending: pendingDraft };
      const { host, cleanup } = await setup(mode === "cold" ? [] : ["one"]);
      try {
        if (mode === "last-selected") {
          useDeskStore.getState().dispatch({ type: "closeAll" });
          await vi.waitFor(() =>
            expect(
              host.querySelector('[data-mock-chat="one"][data-pane-visible="false"]'),
            ).not.toBeNull(),
          );
          mocks.composer.draftThreadsByThreadKey = { pending: pendingDraft };
          // Synthetic catalog updates are observed on the next ordinary render.
          useDeskStore.getState().dispatch({ type: "sidebarMode", mode: "desk" });
        }
        await vi.waitFor(() => {
          expect(host.querySelectorAll("[data-mock-chat]")).toHaveLength(1);
          const owner = host.querySelector('[data-mock-draft="pending"]');
          expect(owner).not.toBeNull();
          expect(owner?.getAttribute("data-pane-visible")).toBe("false");
          expect(owner?.getAttribute("data-pane-active")).toBe("false");
          expect(owner?.closest("[hidden][inert]")).not.toBeNull();
          expect(useDeskStore.getState().desk.groups.g1?.tabs).toEqual([]);
        });
      } finally {
        await cleanup();
      }
    },
  );

  it("drags the first tab after the last tab through the real pointer sensor", async () => {
    const { screen, host, cleanup } = await setup();
    try {
      const source = screen.getByRole("tab", { name: "Chat one", exact: true });
      const cell = screen
        .getByRole("tab", { name: "Chat three", exact: true })
        .element()
        .closest(".desk-tab-cell")!;
      const box = cell.getBoundingClientRect();
      await dragPointer(
        source.element(),
        { x: box.left + box.width * 0.65, y: box.top + box.height / 2 },
        async () => {
          await vi.waitFor(() =>
            expectInsertionSlot(
              host,
              screen.getByRole("tablist", { name: "Main tabs" }).element(),
              3,
            ),
          );
        },
      );
      await vi.waitFor(() =>
        expect(useDeskStore.getState().desk.groups.g1?.tabs).toEqual([
          key("two"),
          key("three"),
          key("one"),
        ]),
      );
      expect(host.querySelector("[data-desk-insertion-index]")).toBeNull();
      expect(deskGroupIds(useDeskStore.getState().desk.layout)).toEqual(["g1"]);
    } finally {
      await cleanup();
    }
  });

  it.each([80, 100, 130])(
    "updates before/after slots within one hovered tab and reorders in the middle at %i percent scale",
    async (scale) => {
      const previous = document.documentElement.style.fontSize;
      applyInterfaceScalePercent(scale);
      const { screen, host, cleanup } = await setup();
      try {
        const strip = screen.getByRole("tablist", { name: "Main tabs" }).element();
        const cell = screen
          .getByRole("tab", { name: "Chat two", exact: true })
          .element()
          .closest(".desk-tab-cell")!;
        const box = cell.getBoundingClientRect();
        const before = { x: box.left + box.width * 0.25, y: box.top + box.height / 2 };
        const after = { x: box.left + box.width * 0.75, y: before.y };
        await dragPointer(
          screen.getByRole("tab", { name: "Chat one", exact: true }).element(),
          before,
          async (moveTo) => {
            await vi.waitFor(() => expectInsertionSlot(host, strip, 1));
            const firstBoundary = host
              .querySelector<HTMLElement>("[data-desk-insertion-index]")!
              .getBoundingClientRect().left;
            // The target ID does not change across its midpoint. Both the slot
            // and final move must follow the new side without an onDragOver.
            await moveTo(after);
            await vi.waitFor(() => {
              expectInsertionSlot(host, strip, 2);
              expect(
                host
                  .querySelector<HTMLElement>("[data-desk-insertion-index]")!
                  .getBoundingClientRect().left,
              ).toBeGreaterThan(firstBoundary);
            });
            await moveTo(before);
            await vi.waitFor(() => expectInsertionSlot(host, strip, 1));
            await moveTo(after);
            await vi.waitFor(() => expectInsertionSlot(host, strip, 2));
          },
        );
        expect(useDeskStore.getState().desk.groups.g1?.tabs).toEqual([
          key("two"),
          key("one"),
          key("three"),
        ]);
        expect(deskGroupIds(useDeskStore.getState().desk.layout)).toEqual(["g1"]);
        expect(host.querySelector("[data-desk-insertion-index]")).toBeNull();
        expect(host.querySelector(".desk-drop-hint")).toBeNull();
      } finally {
        await cleanup();
        document.documentElement.style.fontSize = previous;
      }
    },
  );

  it("shows a start slot and moves the last tab before the first without splitting", async () => {
    const { screen, host, cleanup } = await setup();
    try {
      const strip = screen.getByRole("tablist", { name: "Main tabs" }).element();
      const box = screen
        .getByRole("tab", { name: "Chat one", exact: true })
        .element()
        .closest(".desk-tab-cell")!
        .getBoundingClientRect();
      await dragPointer(
        screen.getByRole("tab", { name: "Chat three", exact: true }).element(),
        { x: box.left + box.width * 0.25, y: box.top + box.height / 2 },
        async () => {
          await vi.waitFor(() => expectInsertionSlot(host, strip, 0));
        },
      );
      expect(useDeskStore.getState().desk.groups.g1?.tabs).toEqual([
        key("three"),
        key("one"),
        key("two"),
      ]);
      expect(deskGroupIds(useDeskStore.getState().desk.layout)).toEqual(["g1"]);
    } finally {
      await cleanup();
    }
  });

  it("shows an append slot over unused strip space without a pane preview", async () => {
    const { screen, host, cleanup } = await setup();
    try {
      const strip = screen.getByRole("tablist", { name: "Main tabs" }).element();
      const stripBox = strip.getBoundingClientRect();
      const last = screen
        .getByRole("tab", { name: "Chat three", exact: true })
        .element()
        .closest(".desk-tab-cell")!
        .getBoundingClientRect();
      expect(stripBox.right - last.right).toBeGreaterThan(20);
      await dragPointer(
        screen.getByRole("tab", { name: "Chat one", exact: true }).element(),
        { x: last.right + 12, y: stripBox.top + stripBox.height / 2 },
        async () => {
          await vi.waitFor(() => expectInsertionSlot(host, strip, 3));
        },
      );
      expect(useDeskStore.getState().desk.groups.g1?.tabs).toEqual([
        key("two"),
        key("three"),
        key("one"),
      ]);
      expect(deskGroupIds(useDeskStore.getState().desk.layout)).toEqual(["g1"]);
    } finally {
      await cleanup();
    }
  });

  it("inserts into another group's tab strip without creating a split", async () => {
    const { screen, host, cleanup } = await setup();
    try {
      mocks.showMenu.mockResolvedValueOnce("split-right");
      await screen.getByRole("button", { name: "Main tab actions" }).click();
      const strip = screen.getByRole("tablist", { name: "Group 2 tabs" }).element();
      const box = screen
        .getByRole("tab", { name: "Chat three", exact: true })
        .element()
        .closest(".desk-tab-cell")!
        .getBoundingClientRect();
      await dragPointer(
        screen.getByRole("tab", { name: "Chat one", exact: true }).element(),
        { x: box.left + box.width * 0.25, y: box.top + box.height / 2 },
        async () => {
          await vi.waitFor(() => expectInsertionSlot(host, strip, 0));
        },
      );
      expect(useDeskStore.getState().desk.groups.g1?.tabs).toEqual([key("two")]);
      expect(useDeskStore.getState().desk.groups.g2?.tabs).toEqual([key("one"), key("three")]);
      expect(deskGroupIds(useDeskStore.getState().desk.layout)).toEqual(["g1", "g2"]);
      expect(host.querySelector("[data-desk-insertion-index]")).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it.each(["Escape", "outside"] as const)(
    "clears an insertion slot on %s without moving the tab",
    async (cancel) => {
      const { screen, host, cleanup } = await setup();
      try {
        host.style.width = "calc(100% - 180px)";
        const strip = screen.getByRole("tablist", { name: "Main tabs" }).element();
        const box = screen
          .getByRole("tab", { name: "Chat two", exact: true })
          .element()
          .closest(".desk-tab-cell")!
          .getBoundingClientRect();
        const before = useDeskStore.getState().desk.groups.g1?.tabs;
        await dragPointer(
          screen.getByRole("tab", { name: "Chat one", exact: true }).element(),
          { x: box.left + box.width * 0.75, y: box.top + box.height / 2 },
          async (moveTo) => {
            await vi.waitFor(() => expectInsertionSlot(host, strip, 2));
            if (cancel === "Escape") await userEvent.keyboard("{Escape}");
            else
              await moveTo({
                x: host.getBoundingClientRect().right + 8,
                y: box.top + box.height / 2,
              });
            await vi.waitFor(() => {
              expect(host.querySelector("[data-desk-insertion-index]")).toBeNull();
              expect(host.querySelector(".desk-drop-hint")).toBeNull();
            });
          },
        );
        expect(useDeskStore.getState().desk.groups.g1?.tabs).toEqual(before);
        expect(deskGroupIds(useDeskStore.getState().desk.layout)).toEqual(["g1"]);
      } finally {
        await cleanup();
      }
    },
  );

  it.each([80, 130])(
    "keeps insertion slots aligned after overflow scrolling at %i percent scale",
    async (scale) => {
      const previous = document.documentElement.style.fontSize;
      applyInterfaceScalePercent(scale);
      const ids = Array.from({ length: 12 }, (_, index) => `overflow-${index}`);
      mocks.environment.threadShellById = Object.fromEntries(
        ids.map((id) => [id, { id, archivedAt: null }]),
      );
      const { screen, host, cleanup } = await setup(ids);
      try {
        host.style.width = "680px";
        const strip = screen.getByRole("tablist", { name: "Main tabs" }).element() as HTMLElement;
        const source = screen.getByRole("tab", { name: "Chat overflow-11", exact: true }).element();
        // Resizing the fixture schedules the same selected-tab reveal as the
        // real UI. Wait for that observer before measuring a physical gesture;
        // a positive old scroll offset alone does not mean the source is visible.
        await vi.waitFor(() => {
          expect(strip.scrollLeft).toBeGreaterThan(0);
          const sourceBounds = source.getBoundingClientRect();
          const viewport = strip.getBoundingClientRect();
          expect(sourceBounds.left).toBeGreaterThanOrEqual(viewport.left);
          expect(sourceBounds.right).toBeLessThanOrEqual(viewport.right + 1);
        });
        const targetCell = screen
          .getByRole("tab", { name: "Chat overflow-10", exact: true })
          .element()
          .closest(".desk-tab-cell")!;
        const box = targetCell.getBoundingClientRect();
        await dragPointer(
          source,
          { x: box.left + box.width * 0.25, y: box.top + box.height / 2 },
          async (moveTo) => {
            await vi.waitFor(() => expectInsertionSlot(host, strip, 10));
            // Scroll during the active drag. dnd-kit's measured tab rectangles
            // follow the scroll; the raw pointer must not gain its scroll delta.
            strip.scrollLeft -= 40;
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            const shifted = targetCell.getBoundingClientRect();
            await moveTo({
              x: shifted.left + shifted.width * 0.25,
              y: shifted.top + shifted.height / 2,
            });
            await vi.waitFor(() => {
              expectInsertionSlot(host, strip, 10);
              const marker = host
                .querySelector<HTMLElement>("[data-desk-insertion-index]")!
                .getBoundingClientRect();
              expect(Math.abs(marker.left - targetCell.getBoundingClientRect().left)).toBeLessThan(
                3,
              );
            });
          },
        );
        expect(useDeskStore.getState().desk.groups.g1?.tabs).toEqual(
          [...ids.slice(0, 10), ids[11]!, ids[10]!].map(key),
        );
        expect(deskGroupIds(useDeskStore.getState().desk.layout)).toEqual(["g1"]);
        expect(host.querySelector("[data-desk-insertion-index]")).toBeNull();
      } finally {
        await cleanup();
        document.documentElement.style.fontSize = previous;
      }
    },
  );

  it.each(["left", "right"] as const)(
    "clamps a partially clipped %s insertion boundary inside the strip without shifting tabs",
    async (side) => {
      const ids = Array.from({ length: 12 }, (_, index) => `clipped-${index}`);
      mocks.environment.threadShellById = Object.fromEntries(
        ids.map((id) => [id, { id, archivedAt: null }]),
      );
      const { screen, host, cleanup } = await setup(ids);
      try {
        host.style.width = "680px";
        const strip = screen.getByRole("tablist", { name: "Main tabs" }).element() as HTMLElement;
        const source = screen.getByRole("tab", { name: "Chat clipped-10", exact: true }).element();
        await vi.waitFor(() => {
          const bounds = source.getBoundingClientRect();
          const viewport = strip.getBoundingClientRect();
          expect(bounds.left).toBeGreaterThanOrEqual(viewport.left);
          expect(bounds.right).toBeLessThanOrEqual(viewport.right);
        });
        const pane = screen
          .getByRole("region", { name: "Main chat group" })
          .element()
          .getBoundingClientRect();
        const before = useDeskStore.getState().desk.groups.g1?.tabs;
        await dragPointer(
          source,
          { x: pane.left + pane.width / 2, y: pane.top + pane.height / 2 },
          async (moveTo) => {
            // Choose an earlier tab on the left so the requested clipping is
            // reachable before the strip hits its maximum scroll offset.
            const targetIndex = side === "left" ? 7 : 8;
            const cell = screen
              .getByRole("tab", { name: `Chat clipped-${targetIndex}`, exact: true })
              .element()
              .closest(".desk-tab-cell")!;
            const viewport = strip.getBoundingClientRect();
            const original = cell.getBoundingClientRect();
            const desiredLeft =
              side === "left"
                ? viewport.left - original.width * 0.25
                : viewport.right - original.width * 0.75;
            strip.scrollLeft += original.left - desiredLeft;
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            const clipped = cell.getBoundingClientRect();
            if (side === "left") expect(clipped.left).toBeLessThan(viewport.left);
            else expect(clipped.right).toBeGreaterThan(viewport.right);
            const stablePosition = clipped.left - viewport.left + strip.scrollLeft;
            const expectedIndex = targetIndex + (side === "right" ? 1 : 0);
            await moveTo({
              x:
                side === "left"
                  ? viewport.left + clipped.width * 0.1
                  : viewport.right - clipped.width * 0.1,
              y: clipped.top + clipped.height / 2,
            });
            await vi.waitFor(() => expectInsertionSlot(host, strip, expectedIndex));
            // The sensor deliberately auto-scrolls near an edge. Restore the
            // exact partial clip after its target-change effects settle, then
            // inspect sticky CSS synchronously before the next scroll tick.
            // The pointer remains over the same visible half of this tab.
            strip.scrollLeft += cell.getBoundingClientRect().left - desiredLeft;
            {
              expectInsertionSlot(host, strip, expectedIndex);
              const marker = host.querySelector<HTMLElement>("[data-desk-insertion-index]")!;
              const bounds = marker.getBoundingClientRect();
              const currentViewport = strip.getBoundingClientRect();
              const currentCell = cell.getBoundingClientRect();
              const paintedWidth = Number.parseFloat(getComputedStyle(marker, "::before").width);
              expect(paintedWidth).toBe(2);
              expect(bounds.left).toBeGreaterThanOrEqual(currentViewport.left);
              expect(bounds.left + paintedWidth).toBeLessThanOrEqual(currentViewport.right + 0.5);
              if (side === "left") expect(currentCell.left).toBeLessThan(currentViewport.left);
              else expect(currentCell.right).toBeGreaterThan(currentViewport.right);
              // Auto-scroll may move the viewport, but introducing feedback must
              // not move or resize the underlying tab in strip-content space.
              expect(Math.abs(currentCell.width - clipped.width)).toBeLessThan(1);
              expect(
                Math.abs(
                  currentCell.left - currentViewport.left + strip.scrollLeft - stablePosition,
                ),
              ).toBeLessThan(1);
            }
            await userEvent.keyboard("{Escape}");
            await vi.waitFor(() =>
              expect(host.querySelector("[data-desk-insertion-index]")).toBeNull(),
            );
          },
        );
        expect(useDeskStore.getState().desk.groups.g1?.tabs).toEqual(before);
        expect(deskGroupIds(useDeskStore.getState().desk.layout)).toEqual(["g1"]);
      } finally {
        await cleanup();
      }
    },
  );

  it("moves a tab to another pane center without accidentally splitting", async () => {
    const { screen, cleanup } = await setup();
    try {
      mocks.showMenu.mockResolvedValueOnce("split-right");
      await screen.getByRole("button", { name: "Main tab actions" }).click();
      const pane = screen.getByRole("region", { name: "Group 2 chat group" });
      await expect.element(pane).toBeVisible();
      const box = pane.element().getBoundingClientRect();
      await dragPointer(screen.getByRole("tab", { name: "Chat one", exact: true }).element(), {
        x: box.left + box.width / 2,
        y: box.top + box.height / 2,
      });
      await vi.waitFor(() =>
        expect(useDeskStore.getState().desk.groups.g2?.tabs).toEqual([key("three"), key("one")]),
      );
      expect(deskGroupIds(useDeskStore.getState().desk.layout)).toEqual(["g1", "g2"]);
    } finally {
      await cleanup();
    }
  });

  it("splits at a pane edge through pointer dragging", async () => {
    const { screen, cleanup } = await setup();
    try {
      const pane = screen.getByRole("region", { name: "Main chat group" });
      const box = pane.element().getBoundingClientRect();
      await dragPointer(screen.getByRole("tab", { name: "Chat one", exact: true }).element(), {
        x: box.left + 5,
        y: box.top + box.height / 2,
      });
      await vi.waitFor(() =>
        expect(deskGroupIds(useDeskStore.getState().desk.layout)).toEqual(["g2", "g1"]),
      );
      expect(useDeskStore.getState().desk.groups.g2?.tabs).toEqual([key("one")]);
      expect(useDeskStore.getState().desk.groups.g1?.tabs).toEqual([key("two"), key("three")]);
    } finally {
      await cleanup();
    }
  });

  it.each([80, 100, 130])(
    "refreshes center/edge previews within the same pane before release at %i percent scale",
    async (scale) => {
      const previous = document.documentElement.style.fontSize;
      applyInterfaceScalePercent(scale);
      const { screen, cleanup } = await setup();
      try {
        mocks.showMenu.mockResolvedValueOnce("split-right");
        await screen.getByRole("button", { name: "Main tab actions" }).click();
        const pane = screen.getByRole("region", { name: "Group 2 chat group" });
        await expect.element(pane).toBeVisible();
        const box = pane.element().getBoundingClientRect();
        const center = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
        await dragPointer(
          screen.getByRole("tab", { name: "Chat one", exact: true }).element(),
          center,
          async (moveTo) => {
            const preview = () => pane.element().querySelector<HTMLElement>(".desk-drop-hint");
            await vi.waitFor(() => expect(preview()?.dataset.edge).toBe("center"));
            // Never leave this droppable pane: onDragOver alone cannot observe
            // these transitions. Test the visible preview before pointerup,
            // not just the reducer result that previously hid this regression.
            for (const [edge, point] of [
              ["left", { x: box.left + 5, y: center.y }],
              ["right", { x: box.right - 5, y: center.y }],
              ["top", { x: center.x, y: box.top + box.height * 0.12 }],
              ["bottom", { x: center.x, y: box.bottom - 5 }],
              ["center", center],
              ["left", { x: box.left + 5, y: center.y }],
            ] as const) {
              await moveTo(point);
              await vi.waitFor(() => expect(preview()?.dataset.edge).toBe(edge));
              const horizontal = edge === "left" || edge === "right";
              const vertical = edge === "top" || edge === "bottom";
              // The preview glides between edges with a short transform
              // transition, so assert the rectangle it settles on.
              await vi.waitFor(() => {
                const bounds = preview()!.getBoundingClientRect();
                expect(Math.abs(bounds.width - box.width / (horizontal ? 2 : 1))).toBeLessThan(2);
                expect(Math.abs(bounds.height - box.height / (vertical ? 2 : 1))).toBeLessThan(2);
                const expectedLeft = edge === "right" ? box.left + box.width / 2 : box.left;
                const expectedTop = edge === "bottom" ? box.top + box.height / 2 : box.top;
                expect(Math.abs(bounds.left - expectedLeft)).toBeLessThan(2);
                expect(Math.abs(bounds.top - expectedTop)).toBeLessThan(2);
              });
            }
          },
        );
        expect(deskGroupIds(useDeskStore.getState().desk.layout)).toEqual(["g1", "g3", "g2"]);
        expect(useDeskStore.getState().desk.groups.g3?.tabs).toEqual([key("one")]);
      } finally {
        await cleanup();
        document.documentElement.style.fontSize = previous;
      }
    },
  );

  it("clears the preview and does not move a tab when released outside the workspace", async () => {
    const { screen, host, cleanup } = await setup();
    try {
      // Leave room for a real pointer outside the pane but still in the page.
      // The dragged tab rectangle still overlaps the pane there, which must
      // never substitute for an actual pointer hit.
      host.style.width = "calc(100% - 180px)";
      const pane = screen.getByRole("region", { name: "Main chat group" });
      const box = pane.element().getBoundingClientRect();
      const before = useDeskStore.getState().desk.groups.g1?.tabs;
      await dragPointer(
        screen.getByRole("tab", { name: "Chat one", exact: true }).element(),
        { x: box.left + box.width / 2, y: box.top + box.height / 2 },
        async (moveTo) => {
          await vi.waitFor(() => expect(host.querySelector(".desk-drop-hint")).not.toBeNull());
          await moveTo({ x: box.right + 8, y: box.top + box.height / 2 });
          await vi.waitFor(() => expect(host.querySelector(".desk-drop-hint")).toBeNull());
        },
      );
      expect(useDeskStore.getState().desk.groups.g1?.tabs).toEqual(before);
      expect(deskGroupIds(useDeskStore.getState().desk.layout)).toEqual(["g1"]);
    } finally {
      await cleanup();
    }
  });

  it("keeps local chat overlays below the drag preview and clears it on Escape", async () => {
    const { screen, host, cleanup } = await setup();
    try {
      const chat = host.querySelector<HTMLElement>('[data-mock-chat="three"]')!;
      const overlay = document.createElement("div");
      // Model the existing subagent panel's full-pane, opaque z-40 surface.
      overlay.style.cssText = "position:absolute;inset:50px 0 0;z-index:40;background:black";
      chat.append(overlay);
      const box = chat.getBoundingClientRect();
      const before = useDeskStore.getState().desk.groups.g1?.tabs;
      await dragPointer(
        screen.getByRole("tab", { name: "Chat one", exact: true }).element(),
        { x: box.left + 5, y: box.top + box.height / 2 },
        async () => {
          await vi.waitFor(() =>
            expect(host.querySelector<HTMLElement>(".desk-drop-hint")?.dataset.edge).toBe("left"),
          );
          const hint = host.querySelector<HTMLElement>(".desk-drop-hint")!;
          expect(hint.parentElement).toBe(chat.parentElement);
          expect(getComputedStyle(chat).isolation).toBe("isolate");
          expect(getComputedStyle(chat).zIndex).toBe("auto");
          expect(Number(getComputedStyle(hint).zIndex)).toBeGreaterThan(0);
          await userEvent.keyboard("{Escape}");
          await vi.waitFor(() => expect(host.querySelector(".desk-drop-hint")).toBeNull());
        },
      );
      expect(useDeskStore.getState().desk.groups.g1?.tabs).toEqual(before);
    } finally {
      await cleanup();
    }
  });

  it.each([80, 130])("keeps navigation bounded at %i percent interface scale", async (scale) => {
    const previous = document.documentElement.style.fontSize;
    applyInterfaceScalePercent(scale);
    const { screen, host, cleanup } = await setup();
    try {
      mocks.showMenu.mockResolvedValueOnce("split-right");
      await screen.getByRole("button", { name: "Main tab actions" }).click();
      await expect
        .element(screen.getByRole("region", { name: "Group 2 chat group" }))
        .toBeVisible();
      for (const bar of host.querySelectorAll<HTMLElement>(".desk-group-bar")) {
        const bounds = bar.getBoundingClientRect();
        expect(bounds.height).toBeLessThanOrEqual(Math.max(44, (44 * scale) / 100) + 1);
        expect(bounds.width).toBeLessThanOrEqual(
          bar.closest(".desk-pane")!.getBoundingClientRect().width,
        );
      }
      expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
      // Screenshots are opt-in local evidence; CI/default runs do not create
      // private exploration artifacts or write outside their checkout.
      if (import.meta.env.VITE_DESK_CAPTURE_PRIVATE === "1") {
        await page.screenshot({
          path: `../../../../../.explorations/desk-implementation/desk-chrome-${scale}.png`,
        });
      }
    } finally {
      await cleanup();
      document.documentElement.style.fontSize = previous;
    }
  });

  it("retains the newest tab selection while an older route echo arrives", async () => {
    const { screen, cleanup } = await setup();
    const pending: Array<{ params: Record<string, string>; finish: () => void }> = [];
    try {
      await vi.waitFor(() => expect(mocks.params.threadId).toBe("three"));
      mocks.navigate.mockImplementation(
        (options) =>
          new Promise<void>((resolve) => {
            pending.push({ params: options.params ?? {}, finish: resolve });
          }),
      );
      await screen.getByRole("tab", { name: "Chat one", exact: true }).click();
      await screen.getByRole("tab", { name: "Chat two", exact: true }).click();
      // Route writes may be serialized; a second tab choice stays in Desk
      // state until the outstanding navigation echo is safely reconciled.
      await vi.waitFor(() => expect(pending.length).toBeGreaterThanOrEqual(1));
      expect(useDeskStore.getState().desk.groups.g1?.activeTabKey).toBe(key("two"));
      const old = pending.find((entry) => entry.params.threadId === "one")!;
      mocks.params = old.params;
      for (const notify of mocks.routeListeners) notify();
      old.finish();
      await vi.waitFor(() =>
        expect(pending.some((entry) => entry.params.threadId === "two")).toBe(true),
      );
      expect(useDeskStore.getState().desk.groups.g1?.activeTabKey).toBe(key("two"));
      const latest = pending.find((entry) => entry.params.threadId === "two")!;
      mocks.params = latest.params;
      for (const notify of mocks.routeListeners) notify();
      latest.finish();
      await expect
        .element(screen.getByRole("tab", { name: "Chat two", exact: true }))
        .toHaveAttribute("aria-selected", "true");
    } finally {
      for (const entry of pending) entry.finish();
      await cleanup();
    }
  });

  it("does not prune on reconnect uncertainty and retires archived views only from an authoritative inventory", async () => {
    const { screen, host, cleanup } = await setup();
    try {
      await vi.waitFor(() => expect(mocks.params.threadId).toBe("three"));
      const saved = mocks.environment.threadShellById;
      mocks.environment = { bootstrapComplete: false, threadShellById: {} };
      mocks.params = { ...mocks.params };
      for (const notify of mocks.routeListeners) notify();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expect(useDeskStore.getState().desk.groups.g1?.tabs).toEqual([
        key("one"),
        key("two"),
        key("three"),
      ]);
      mocks.environment = {
        bootstrapComplete: true,
        threadShellById: {
          ...saved,
          three: { id: "three", archivedAt: "2026-09-29T00:00:00.000Z" },
        },
      };
      mocks.params = { ...mocks.params };
      for (const notify of mocks.routeListeners) notify();
      await vi.waitFor(() =>
        expect(useDeskStore.getState().desk.groups.g1?.tabs).toEqual([key("one"), key("two")]),
      );
      await expect
        .element(screen.getByRole("textbox", { name: "Existing composer two" }))
        .toBeVisible();
      expect(host.querySelector('[data-mock-chat="three"]')).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("unmounts old-environment panes immediately when the authenticated environment changes", async () => {
    const { host, cleanup } = await setup();
    try {
      await vi.waitFor(() => expect(mocks.params.threadId).toBe("three"));
      mocks.primaryEnvironmentId = "other-fixture";
      mocks.environment = { bootstrapComplete: false, threadShellById: {} };
      mocks.params = {};
      for (const notify of mocks.routeListeners) notify();
      await vi.waitFor(() =>
        expect(useDeskStore.getState().desk.environmentId).toBe("other-fixture"),
      );
      expect(host.querySelectorAll("[data-mock-chat]")).toHaveLength(0);
      expect(Object.keys(useDeskStore.getState().desk.targets)).toHaveLength(0);
    } finally {
      await cleanup();
      localStorage.removeItem("cafe-code:desk:v1:other-fixture");
    }
  });

  it("does not reopen a closed tab from its route echo and admits an explicit later deep link", async () => {
    const { screen, cleanup } = await setup();
    try {
      await vi.waitFor(() => expect(mocks.params.threadId).toBe("three"));
      await screen.getByRole("tab", { name: "Chat one", exact: true }).click();
      await vi.waitFor(() => expect(mocks.params.threadId).toBe("one"));
      await screen.getByRole("button", { name: "Close tab Chat one" }).click();
      await vi.waitFor(() => expect(mocks.params.threadId).toBe("two"));
      expect(useDeskStore.getState().desk.groups.g1?.tabs).toEqual([key("two"), key("three")]);
      // A later independent history/deep-link change is different from the
      // expected navigation echo and is allowed to open that chat again.
      mocks.params = { environmentId, threadId: "one" };
      for (const notify of mocks.routeListeners) notify();
      await expect
        .element(screen.getByRole("tab", { name: "Chat one", exact: true }))
        .toBeVisible();
      expect(useDeskStore.getState().desk.groups.g1?.activeTabKey).toBe(key("one"));
      const tabs = useDeskStore.getState().desk.groups.g1?.tabs;
      mocks.params = { environmentId: "other-environment", threadId: "one" };
      for (const notify of mocks.routeListeners) notify();
      await vi.waitFor(() => expect(mocks.params.environmentId).toBe(environmentId));
      expect(useDeskStore.getState().desk.groups.g1?.tabs).toEqual(tabs);
    } finally {
      await cleanup();
    }
  });

  it("keeps taller tab chrome and existing chat content while selecting with click and keyboard", async () => {
    const { screen, host, cleanup } = await setup();
    try {
      expect(host.querySelector(".desk-group-bar")!.getBoundingClientRect().height).toBeCloseTo(
        44,
        0,
      );
      await screen.getByRole("tab", { name: "Chat one", exact: true }).click();
      await expect
        .element(screen.getByRole("textbox", { name: "Existing composer one" }))
        .toBeVisible();
      await expect
        .element(screen.getByRole("tab", { name: "Chat one", exact: true }))
        .toHaveFocus();
      await userEvent.keyboard("{ArrowRight}");
      expect(useDeskStore.getState().desk.groups.g1?.activeTabKey).toBe(key("two"));
      await expect
        .element(screen.getByRole("tab", { name: "Chat two", exact: true }))
        .toHaveAttribute("aria-selected", "true");
      await expect
        .element(screen.getByRole("tab", { name: "Chat two", exact: true }))
        .toHaveFocus();
      await userEvent.keyboard("{End}");
      expect(useDeskStore.getState().desk.groups.g1?.activeTabKey).toBe(key("three"));
      expect(host.querySelectorAll('[data-mock-chat][data-pane-active="true"]')).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it("keeps an italic preview by double-clicking its tab and dismisses another preview on selection", async () => {
    const { screen, host, cleanup } = await setup(["one"]);
    try {
      useDeskStore.getState().dispatch({ type: "open", target: target("two"), preview: true });
      const preview = screen.getByRole("tab", { name: "Chat two", exact: true });
      await expect.element(preview).toHaveAttribute("data-preview", "true");
      const title = host.querySelector('.desk-tab[data-preview="true"] .desk-tab-title')!;
      expect(getComputedStyle(title).fontStyle).toBe("italic");
      await preview.dblClick();
      await expect.element(preview).toHaveAttribute("data-preview", "false");
      expect(getComputedStyle(title).fontStyle).toBe("normal");
      useDeskStore.getState().dispatch({ type: "open", target: target("three"), preview: true });
      await expect
        .element(screen.getByRole("tab", { name: "Chat three", exact: true }))
        .toBeVisible();
      await screen.getByRole("tab", { name: "Chat one", exact: true }).click();
      expect(useDeskStore.getState().desk.groups.g1?.tabs).toEqual([key("one"), key("two")]);
      await expect
        .element(screen.getByRole("tab", { name: "Chat three", exact: true }))
        .not.toBeInTheDocument();
      expect(useDeskStore.getState().desk.closed).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("offers Keep open only for preview tabs and applies it without changing selection", async () => {
    const { screen, cleanup } = await setup(["one"]);
    try {
      useDeskStore.getState().dispatch({ type: "open", target: target("two"), preview: true });
      mocks.showMenu.mockResolvedValueOnce("keep-open");
      await screen.getByRole("tab", { name: "Chat two", exact: true }).click({ button: "right" });
      await vi.waitFor(() =>
        expect(useDeskStore.getState().desk.groups.g1?.previewTabKey).toBeUndefined(),
      );
      expect(mocks.showMenu.mock.calls[0]![0]).toContainEqual({
        id: "keep-open",
        label: "Keep open",
        disabled: false,
      });
      expect(useDeskStore.getState().desk.groups.g1?.activeTabKey).toBe(key("two"));
      await screen.getByRole("tab", { name: "Chat two", exact: true }).click({ button: "right" });
      expect(mocks.showMenu.mock.calls[1]![0].some((item) => item.id === "keep-open")).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("restores a current preview URL without making it a kept tab", async () => {
    const first = await setup(["one"]);
    useDeskStore.getState().dispatch({ type: "open", target: target("two"), preview: true });
    await expect
      .element(first.screen.getByRole("tab", { name: "Chat two", exact: true }))
      .toHaveAttribute("aria-selected", "true");
    await vi.waitFor(() => expect(mocks.params.threadId).toBe("two"));
    const saved = serializeDesk(useDeskStore.getState().desk);
    await first.cleanup();
    useDeskStore.setState({ desk: hydrateDesk(saved, environmentId) });
    const reopened = await setup([]);
    try {
      await expect
        .element(reopened.screen.getByRole("tab", { name: "Chat two", exact: true }))
        .toHaveAttribute("data-preview", "true");
      const persisted = hydrateDesk(serializeDesk(useDeskStore.getState().desk), environmentId);
      expect(persisted.groups.g1?.tabs).toEqual([key("one")]);
      expect(persisted.closed).toEqual([]);
    } finally {
      await reopened.cleanup();
    }
  });

  it("renders a tab's chat status with the same spinner used by sidebar rows", async () => {
    // A running chat, resolved by the same helper the sidebar row uses.
    const status = resolveThreadStatusPill({
      thread: {
        hasActionableProposedPlan: false,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        interactionMode: "default",
        latestTurn: null,
        session: {
          provider: "codex" as never,
          status: "running",
          createdAt: "2026-09-29T00:00:00.000Z",
          updatedAt: "2026-09-29T00:00:00.000Z",
          orchestrationStatus: "running",
        },
      },
    });
    expect(status?.label).toBe("Working");
    mocks.tabStatus = status;
    const { host, cleanup } = await setup(["one"]);
    const referenceHost = document.createElement("div");
    document.body.append(referenceHost);
    const reference = await render(<ThreadStatusLabel status={status} />, {
      container: referenceHost,
    });
    try {
      const tabShell = host.querySelector<HTMLElement>(
        "[data-desk-tab-key] .thread-status-dot-shell",
      );
      expect(tabShell).not.toBeNull();
      // Same component, same props: byte-identical markup to a sidebar row's label.
      expect(tabShell!.outerHTML).toBe(referenceHost.firstElementChild!.outerHTML);
      expect(tabShell!.dataset.status).toBe("Working");
      const dot = tabShell!.querySelector<SVGElement>('[data-slot="thread-status-dot"]')!;
      expect(dot.classList).toContain("text-status-running-foreground");
      expect(dot.classList).toContain("animate-spin");
      // The shared spinner is 0.75rem at 100% interface size.
      await vi.waitFor(() => {
        expect(parseFloat(getComputedStyle(dot).width)).toBe(12);
        expect(parseFloat(getComputedStyle(dot).height)).toBe(12);
      });
    } finally {
      mocks.tabStatus = null;
      await reference.unmount();
      referenceHost.remove();
      await cleanup();
    }
  });

  it("provides context close-right, close-others, close-all and reopen without chat mutations", async () => {
    const { screen, host, cleanup } = await setup();
    try {
      await screen.getByRole("tab", { name: "Chat two", exact: true }).click();
      mocks.showMenu.mockResolvedValueOnce("right");
      await screen.getByRole("tab", { name: "Chat two", exact: true }).click({ button: "right" });
      await vi.waitFor(() =>
        expect(useDeskStore.getState().desk.groups.g1?.tabs).toEqual([key("one"), key("two")]),
      );
      expect(mocks.showMenu.mock.calls[0]?.[0].map((item) => item.label)).toEqual(
        expect.arrayContaining([
          "Close tab",
          "Close other tabs",
          "Close tabs to the right",
          "Close all tabs in group",
          "Close all tabs",
          "Reopen closed tab",
        ]),
      );
      mocks.showMenu.mockResolvedValueOnce("others");
      await screen.getByRole("button", { name: "Main tab actions" }).click();
      await vi.waitFor(() =>
        expect(useDeskStore.getState().desk.groups.g1?.tabs).toEqual([key("two")]),
      );
      mocks.showMenu.mockResolvedValueOnce("close-all");
      await screen.getByRole("button", { name: "Main tab actions" }).click();
      await expect.element(screen.getByText("No active chat", { exact: true })).toBeVisible();
      expect(host.querySelectorAll('[data-mock-chat][data-pane-active="true"]')).toHaveLength(0);
      await screen.getByRole("button", { name: "Reopen closed tab", exact: true }).click();
      await expect
        .element(screen.getByRole("tab", { name: "Chat two", exact: true }))
        .toBeVisible();
      expect(mocks.rename).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it.each(["one", "two"])(
    "keeps active chat, route and composer focus when native right-click opens inactive tab %s",
    async (clickedChat) => {
      const { screen, host, cleanup } = await setup();
      try {
        useDeskStore.getState().dispatch({
          type: "split",
          tabKey: key("three"),
          targetGroupId: "g1",
          edge: "right",
        });
        const composer = screen.getByRole("textbox", { name: "Existing composer three" });
        await composer.fill("Keep this group's unsent input");
        await expect.element(composer).toHaveFocus();
        await vi.waitFor(() => expect(mocks.params.threadId).toBe("three"));
        const before = useDeskStore.getState().desk;
        const finish = deferMenu();
        // This includes native pointerdown/mousedown/focus/contextmenu/up.
        // Dispatching contextmenu alone cannot reproduce the focus regression.
        await screen
          .getByRole("tab", { name: `Chat ${clickedChat}`, exact: true })
          .click({ button: "right" });
        expect(mocks.showMenu).toHaveBeenCalledOnce();
        expect(useDeskStore.getState().desk).toBe(before);
        expect(mocks.params.threadId).toBe("three");
        await expect.element(composer).toHaveFocus();
        await expect.element(composer).toHaveValue("Keep this group's unsent input");
        expect(
          host.querySelector('[data-mock-chat="three"]')?.getAttribute("data-pane-active"),
        ).toBe("true");
        await finish(undefined);
        expect(useDeskStore.getState().desk).toBe(before);
        await expect.element(composer).toHaveFocus();
        // Ordinary pointer selection and keyboard pane focus still activate.
        await screen.getByRole("tab", { name: "Chat one", exact: true }).click();
        await vi.waitFor(() => expect(mocks.params.threadId).toBe("one"));
        (composer.element() as HTMLTextAreaElement).focus();
        await vi.waitFor(() => expect(mocks.params.threadId).toBe("three"));
      } finally {
        await cleanup();
      }
    },
  );

  it("preserves the native host's Control-click menu or primary selection semantics", async () => {
    const { screen, cleanup } = await setup();
    try {
      // Unlike a foreign-platform policy simulation, Chromium generates the
      // actual host's complete native input sequence here. macOS emits its
      // context menu; Windows/Linux retain their primary tab selection.
      mocks.macPlatform = /mac|iphone|ipad|ipod/i.test(navigator.platform);
      useDeskStore.getState().dispatch({
        type: "split",
        tabKey: key("three"),
        targetGroupId: "g1",
        edge: "right",
      });
      const composer = screen.getByRole("textbox", { name: "Existing composer three" });
      await composer.click();
      await vi.waitFor(() => expect(mocks.params.threadId).toBe("three"));
      const before = useDeskStore.getState().desk;
      await screen
        .getByRole("tab", { name: "Chat one", exact: true })
        .click({ modifiers: ["Control"] });
      if (mocks.macPlatform) {
        expect(mocks.showMenu).toHaveBeenCalledOnce();
        expect(useDeskStore.getState().desk).toBe(before);
        expect(mocks.params.threadId).toBe("three");
        await expect.element(composer).toHaveFocus();
      } else {
        expect(mocks.showMenu).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(mocks.params.threadId).toBe("one"));
        expect(useDeskStore.getState().desk.groups.g1?.activeTabKey).toBe(key("one"));
      }
    } finally {
      await cleanup();
    }
  });

  it.each([
    ["environment", "close"],
    ["environment", "close-group"],
    ["environment", "close-all"],
    ["environment", "session-rail"],
    ["environment", "rename-group"],
    ["same-environment", "close"],
    ["same-environment", "close-group"],
    ["same-environment", "close-all"],
    ["same-environment", "session-rail"],
    ["same-environment", "rename-group"],
  ] as const)(
    "rejects delayed %s replacement menu action %s even when group/chat IDs are reused",
    async (replacementKind, choice) => {
      const { screen, cleanup } = await setup();
      const replacementEnvironment = EnvironmentId.make("menu-replacement-fixture");
      try {
        const finish = deferMenu();
        await screen.getByRole("button", { name: "Main tab actions", exact: true }).click();
        expect(mocks.showMenu).toHaveBeenCalledOnce();
        const nextEnvironment =
          replacementKind === "environment" ? replacementEnvironment : environmentId;
        if (replacementKind === "environment") {
          mocks.primaryEnvironmentId = nextEnvironment;
          mocks.params = {};
          for (const notify of mocks.routeListeners) notify();
          await vi.waitFor(() =>
            expect(useDeskStore.getState().desk.environmentId).toBe(nextEnvironment),
          );
        } else {
          useDeskStore.setState({
            desk: createDeskState(nextEnvironment),
            draftEditors: {},
            activeDraftId: null,
          });
        }
        for (const id of ["one", "two", "three"]) {
          useDeskStore.getState().dispatch({
            type: "open",
            target: {
              kind: "server",
              threadRef: { environmentId: nextEnvironment, threadId: ThreadId.make(id) },
            },
          });
        }
        await vi.waitFor(() => {
          expect(mocks.params.environmentId).toBe(nextEnvironment);
          expect(mocks.params.threadId).toBe("three");
        });
        const replacement = useDeskStore.getState().desk;
        expect(replacement.groups.g1?.tabs).toHaveLength(3);
        await finish(choice);
        expect(useDeskStore.getState().desk).toBe(replacement);
        await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
        expect(mocks.rename).not.toHaveBeenCalled();
        expect(mocks.archive).not.toHaveBeenCalled();
        expect(mocks.delete).not.toHaveBeenCalled();
      } finally {
        await cleanup();
        localStorage.removeItem(`cafe-code:desk:v1:${replacementEnvironment}`);
      }
    },
  );

  it.each(["close-group", "others", "right", "split-right", "move-g2", "merge-g2", "swap-g2"])(
    "rejects delayed %s after the clicked tab changes group ownership",
    async (choice) => {
      const { screen, cleanup } = await setup();
      try {
        useDeskStore.getState().dispatch({
          type: "split",
          tabKey: key("three"),
          targetGroupId: "g1",
          edge: "right",
        });
        await expect
          .element(screen.getByRole("region", { name: "Group 2 chat group" }))
          .toBeVisible();
        const finish = deferMenu();
        await screen.getByRole("tab", { name: "Chat one", exact: true }).click({ button: "right" });
        useDeskStore
          .getState()
          .dispatch({ type: "move", tabKey: key("one"), groupId: "g2", index: 1 });
        await vi.waitFor(() => expect(mocks.params.threadId).toBe("one"));
        const moved = useDeskStore.getState().desk;
        await finish(choice);
        expect(useDeskStore.getState().desk).toBe(moved);
        expect(moved.groups.g1?.tabs).toEqual([key("two")]);
        expect(moved.groups.g2?.tabs).toEqual([key("three"), key("one")]);
      } finally {
        await cleanup();
      }
    },
  );

  it("retires an older menu while allowing its same-layout successor to act", async () => {
    const { screen, cleanup } = await setup();
    try {
      const first = deferMenu();
      await screen.getByRole("button", { name: "Main tab actions", exact: true }).click();
      const second = deferMenu();
      await screen.getByRole("button", { name: "Main tab actions", exact: true }).click();
      const before = useDeskStore.getState().desk;
      await first("close-all");
      expect(useDeskStore.getState().desk).toBe(before);
      await second("session-rail");
      expect(useDeskStore.getState().desk.groups.g1?.sessionRailDocked).toBe(false);
      expect(useDeskStore.getState().desk.groups.g1?.tabs).toEqual(before.groups.g1?.tabs);
    } finally {
      await cleanup();
    }
  });

  it("does not let an unmounted workspace's menu act on an identical remount", async () => {
    const first = await setup();
    const finish = deferMenu();
    await first.screen.getByRole("button", { name: "Main tab actions", exact: true }).click();
    await first.cleanup();
    const second = await setup([]);
    try {
      const before = useDeskStore.getState().desk;
      await finish("close-all");
      expect(useDeskStore.getState().desk).toBe(before);
      await expect
        .element(second.screen.getByRole("tab", { name: "Chat three", exact: true }))
        .toBeVisible();
    } finally {
      await second.cleanup();
    }
  });

  it.each(["archive", "delete", "delete-forever"])(
    "retains the captured chat target for delayed %s after a different chat is selected",
    async (choice) => {
      const { screen, cleanup } = await setup();
      try {
        const finish = deferMenu();
        await screen.getByRole("tab", { name: "Chat one", exact: true }).click({ button: "right" });
        await screen.getByRole("tab", { name: "Chat two", exact: true }).click();
        await finish(choice);
        const expectedRef = { environmentId, threadId: ThreadId.make("one") };
        const action =
          choice === "archive" ? mocks.archive : choice === "delete" ? mocks.recycle : mocks.delete;
        expect(action).toHaveBeenCalledExactlyOnceWith(expectedRef);
        if (choice === "delete-forever") {
          expect(mocks.confirm).toHaveBeenCalledOnce();
          expect(mocks.hardDelete).toHaveBeenCalledExactlyOnceWith(expectedRef, { confirm: false });
        }
        expect(useDeskStore.getState().desk.groups.g1?.activeTabKey).toBe(key("two"));
      } finally {
        await cleanup();
      }
    },
  );

  it("rejects a group rename form after a same-environment layout reset", async () => {
    const { screen, cleanup } = await setup();
    try {
      mocks.showMenu.mockResolvedValueOnce("rename-group");
      await screen.getByRole("button", { name: "Main tab actions", exact: true }).click();
      const input = screen.getByRole("textbox", { name: "Group name" });
      await input.fill("Stale group name");
      // Equal persisted values do not prove the same owner incarnation.
      useDeskStore.setState({ desk: structuredClone(useDeskStore.getState().desk) });
      const replacement = useDeskStore.getState().desk;
      await screen.getByRole("button", { name: "Save", exact: true }).click();
      expect(useDeskStore.getState().desk).toBe(replacement);
      expect(replacement.groups.g1?.name).toBe("Main");
      await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
    } finally {
      await cleanup();
    }
  });

  it("splits existing tabs, keeps rail pinning independent, moves tabs and merges groups", async () => {
    const { screen, host, cleanup } = await setup();
    try {
      mocks.showMenu.mockResolvedValueOnce("split-right");
      await screen.getByRole("button", { name: "Main tab actions" }).click();
      await expect
        .element(screen.getByRole("region", { name: "Group 2 chat group" }))
        .toBeVisible();
      expect(deskGroupIds(useDeskStore.getState().desk.layout)).toEqual(["g1", "g2"]);
      await screen.getByRole("button", { name: "Toggle rail three" }).click();
      expect(useDeskStore.getState().desk.groups.g2?.sessionRailDocked).toBe(false);
      expect(useDeskStore.getState().desk.groups.g1?.sessionRailDocked).toBeNull();
      await expect
        .element(screen.getByRole("button", { name: "Toggle rail two" }))
        .toHaveAttribute("aria-pressed", "true");
      mocks.showMenu.mockResolvedValueOnce("session-rail");
      await screen.getByRole("button", { name: "Group 2 tab actions" }).click();
      await vi.waitFor(() =>
        expect(useDeskStore.getState().desk.groups.g2?.sessionRailDocked).toBe(true),
      );
      expect(useDeskStore.getState().desk.groups.g1?.sessionRailDocked).toBeNull();
      expect(host.querySelectorAll('[data-mock-chat][data-pane-active="true"]')).toHaveLength(1);
      mocks.showMenu.mockResolvedValueOnce("move-g2");
      await screen.getByRole("button", { name: "Main tab actions" }).click();
      await vi.waitFor(() =>
        expect(useDeskStore.getState().desk.groups.g2?.tabs).toEqual([key("three"), key("two")]),
      );
      mocks.showMenu.mockResolvedValueOnce("merge-g1");
      await screen.getByRole("button", { name: "Group 2 tab actions" }).click();
      await vi.waitFor(() =>
        expect(deskGroupIds(useDeskStore.getState().desk.layout)).toEqual(["g1"]),
      );
      expect(useDeskStore.getState().desk.groups.g1?.tabs).toEqual([
        key("one"),
        key("three"),
        key("two"),
      ]);
    } finally {
      await cleanup();
    }
  });

  it.each([
    { axis: "x", edge: "split-right", previous: "ArrowLeft", next: "ArrowRight", minimum: 380 },
    { axis: "y", edge: "split-bottom", previous: "ArrowUp", next: "ArrowDown", minimum: 280 },
  ] as const)(
    "keeps the $axis divider mounted across pointer and keyboard limits and permits reversing",
    async ({ axis, edge, previous, next, minimum }) => {
      const { screen, host, cleanup } = await setup();
      try {
        host.style.width = "1000px";
        mocks.showMenu.mockResolvedValueOnce(edge);
        await screen.getByRole("button", { name: "Main tab actions" }).click();
        await screen.getByRole("button", { name: "Toggle rail three" }).click();
        await vi.waitFor(() => expectUsablePanes(host, 2));
        const separator = screen.getByRole("separator", { name: "Resize chat groups" });
        const divider = separator.element();
        const workspace = host.querySelector(".desk-workspace")!.getBoundingClientRect();
        const extent = axis === "x" ? workspace.width : workspace.height;
        const min = Math.max(0.2, minimum / extent);
        const max = Math.min(0.8, 1 - minimum / extent);
        const point = (ratio: number) => ({
          x: workspace.left + workspace.width * (axis === "x" ? ratio : 0.5),
          y: workspace.top + workspace.height * (axis === "y" ? ratio : 0.5),
        });
        const groups = useDeskStore.getState().desk.groups;
        const targets = useDeskStore.getState().desk.targets;
        const composer = screen.getByRole("textbox", { name: "Existing composer three" });
        await composer.fill("Keep this unsent draft while resizing");
        const composerElement = composer.element();

        // One continuous captured drag crosses both limits, then comes back.
        // A disappearing separator would silently lose pointer capture and
        // make the return movement ineffective even if the final pane fit.
        await dragPointer(divider, point(0.01), async (moveTo) => {
          expect(rootDeskSplit().ratio).toBeCloseTo(min, 5);
          expectUsablePanes(host, 2);
          expect(separator.element()).toBe(divider);
          await moveTo(point(0.99));
          expect(rootDeskSplit().ratio).toBeCloseTo(max, 5);
          expectUsablePanes(host, 2);
          expect(separator.element()).toBe(divider);
          await moveTo(point(0.5));
          expect(rootDeskSplit().ratio).toBeCloseTo(0.5, 5);
        });
        await expect
          .element(separator)
          .toHaveAttribute("aria-valuemin", String(Math.round(min * 100)));
        await expect
          .element(separator)
          .toHaveAttribute("aria-valuemax", String(Math.round(max * 100)));

        (divider as HTMLElement).focus();
        await userEvent.keyboard(`{${previous}}`.repeat(16));
        expect(rootDeskSplit().ratio).toBeCloseTo(min, 5);
        await expect.element(separator).toHaveFocus();
        await userEvent.keyboard(`{${next}}`);
        expect(rootDeskSplit().ratio).toBeCloseTo(min + 0.05, 5);
        await userEvent.keyboard(`{${next}}`.repeat(16));
        expect(rootDeskSplit().ratio).toBeCloseTo(max, 5);
        await userEvent.keyboard(`{${previous}}`);
        expect(rootDeskSplit().ratio).toBeCloseTo(max - 0.05, 5);
        expectUsablePanes(host, 2);
        expect(separator.element()).toBe(divider);
        expect(composer.element()).toBe(composerElement);
        await expect.element(composer).toHaveValue("Keep this unsent draft while resizing");
        expect(useDeskStore.getState().desk.groups).toBe(groups);
        expect(useDeskStore.getState().desk.targets).toBe(targets);
        expect(useDeskStore.getState().desk.groups.g2?.sessionRailDocked).toBe(false);
        expect(useDeskStore.getState().desk.focusedGroupId).toBeNull();
        expect(mocks.rename).not.toHaveBeenCalled();
      } finally {
        useDeskStore.getState().flushPersistence();
        await cleanup();
      }
    },
  );

  it.each([
    { axis: "x", edge: "split-right", minimum: 380 },
    { axis: "y", edge: "split-bottom", minimum: 280 },
  ] as const)(
    "reserves both nested $axis panes when clamping the parent and child dividers",
    async ({ axis, edge, minimum }) => {
      await page.viewport(1440, 1080);
      const { screen, host, cleanup } = await setup();
      try {
        mocks.showMenu.mockResolvedValueOnce(edge);
        await screen.getByRole("button", { name: "Main tab actions" }).click();
        mocks.showMenu.mockResolvedValueOnce(edge);
        await screen.getByRole("button", { name: "Main tab actions" }).click();
        await vi.waitFor(() => expectUsablePanes(host, 3));
        const dividers = host.querySelectorAll<HTMLElement>(`.desk-divider[data-axis="${axis}"]`);
        expect(dividers).toHaveLength(2);
        const outer = dividers[0]!;
        const inner = dividers[1]!;
        const workspace = host.querySelector(".desk-workspace")!.getBoundingClientRect();
        const extent = axis === "x" ? workspace.width : workspace.height;
        const point = (ratio: number) => ({
          x: workspace.left + workspace.width * (axis === "x" ? ratio : 0.5),
          y: workspace.top + workspace.height * (axis === "y" ? ratio : 0.5),
        });
        const groupIds = deskGroupIds(useDeskStore.getState().desk.layout);
        const groups = useDeskStore.getState().desk.groups;
        const targets = useDeskStore.getState().desk.targets;
        await dragPointer(outer, point(0.01), async (moveTo) => {
          // The first subtree contains two panes, not one. A leaf-only bound
          // would make its child divider vanish during this same gesture.
          expect(rootDeskSplit().ratio).toBeCloseTo((2 * minimum) / extent, 5);
          expectUsablePanes(host, 3);
          expect(outer.isConnected && inner.isConnected).toBe(true);
          await moveTo(point(0.99));
          expect(rootDeskSplit().ratio).toBeCloseTo(1 - minimum / extent, 5);
          expectUsablePanes(host, 3);
        });
        const parentRatio = rootDeskSplit().ratio;
        await dragPointer(inner, point(0.01), async (moveTo) => {
          expectUsablePanes(host, 3);
          expect(outer.isConnected && inner.isConnected).toBe(true);
          await moveTo(point(parentRatio - 0.01));
          expectUsablePanes(host, 3);
          await moveTo(point(parentRatio / 2));
          const child = rootDeskSplit().children[0];
          expect(child.kind === "split" && child.ratio).toBeCloseTo(0.5, 5);
        });
        expect(deskGroupIds(useDeskStore.getState().desk.layout)).toEqual(groupIds);
        expect(useDeskStore.getState().desk.groups).toBe(groups);
        expect(useDeskStore.getState().desk.targets).toBe(targets);
        expect(useDeskStore.getState().desk.focusedGroupId).toBeNull();
      } finally {
        await cleanup();
      }
    },
  );

  it.each([0.2, 0.8])(
    "fits a hydrated %s ratio without rewriting saved layout or group preferences",
    async (ratio) => {
      for (const id of ["one", "two", "three"])
        useDeskStore.getState().dispatch({ type: "open", target: target(id) });
      useDeskStore.getState().dispatch({
        type: "split",
        tabKey: key("three"),
        targetGroupId: "g1",
        edge: "right",
      });
      useDeskStore.getState().dispatch({ type: "resize", splitId: rootDeskSplit().id, ratio });
      useDeskStore.getState().dispatch({ type: "sessionRail", groupId: "g1", docked: true });
      useDeskStore.getState().dispatch({ type: "sessionRail", groupId: "g2", docked: false });
      const saved = localStorage.getItem(`cafe-code:desk:v1:${environmentId}`);
      useDeskStore.setState({ desk: createDeskState(), draftEditors: {}, activeDraftId: null });
      useDeskStore.getState().bindEnvironment(environmentId);
      const hydrated = useDeskStore.getState().desk;
      const { screen, host, cleanup } = await setup([]);
      try {
        host.style.width = "1000px";
        await vi.waitFor(() => expectUsablePanes(host, 2));
        const separator = screen.getByRole("separator", { name: "Resize chat groups" });
        await expect
          .element(separator)
          .toHaveAttribute("aria-valuenow", ratio === 0.2 ? "38" : "62");
        expect(useDeskStore.getState().desk.layout).toBe(hydrated.layout);
        expect(rootDeskSplit().ratio).toBe(ratio);
        expect(useDeskStore.getState().desk.groups).toBe(hydrated.groups);
        expect(useDeskStore.getState().desk.targets).toBe(hydrated.targets);
        expect(localStorage.getItem(`cafe-code:desk:v1:${environmentId}`)).toBe(saved);
        await expect
          .element(screen.getByRole("button", { name: "Toggle rail two" }))
          .toHaveAttribute("aria-pressed", "true");
        await expect
          .element(screen.getByRole("button", { name: "Toggle rail three" }))
          .toHaveAttribute("aria-pressed", "false");
        expect(mocks.rename).not.toHaveBeenCalled();
      } finally {
        await cleanup();
      }
    },
  );

  it.each(["button", "switcher", "menu"] as const)(
    "restores a focused saved extreme ratio through the %s without resetting preferences",
    async (entry) => {
      const { screen, host, cleanup } = await setup();
      try {
        host.style.width = "1000px";
        mocks.showMenu.mockResolvedValueOnce("split-right");
        await screen.getByRole("button", { name: "Main tab actions" }).click();
        useDeskStore
          .getState()
          .dispatch({ type: "resize", splitId: rootDeskSplit().id, ratio: 0.2 });
        await screen.getByRole("button", { name: "Toggle rail three" }).click();
        await vi.waitFor(() => expectUsablePanes(host, 2));
        const groups = useDeskStore.getState().desk.groups;
        const targets = useDeskStore.getState().desk.targets;
        const layout = useDeskStore.getState().desk.layout;
        const composer = screen.getByRole("textbox", { name: "Existing composer three" });
        await composer.fill("Keep the focused group's draft");
        const composerElement = composer.element();
        await screen.getByRole("button", { name: "Focus Group 2", exact: true }).click();
        expect(useDeskStore.getState().desk.focusedGroupId).toBe("g2");
        expect(host.querySelectorAll(".desk-pane")).toHaveLength(1);
        if (entry === "menu") {
          mocks.showMenu.mockResolvedValueOnce("focus");
          await screen.getByRole("button", { name: "Group 2 tab actions" }).click();
          expect(mocks.showMenu.mock.lastCall?.[0]).toContainEqual({
            id: "focus",
            label: "Restore all groups",
            disabled: false,
          });
        } else {
          await screen
            .getByRole("button", {
              name: entry === "button" ? "Restore all groups" : "Restore layout",
              exact: true,
            })
            .click();
        }
        await vi.waitFor(() => expectUsablePanes(host, 2));
        expect(useDeskStore.getState().desk.focusedGroupId).toBeNull();
        expect(useDeskStore.getState().desk.layout).toBe(layout);
        expect(rootDeskSplit().ratio).toBe(0.2);
        expect(useDeskStore.getState().desk.groups).toBe(groups);
        expect(useDeskStore.getState().desk.targets).toBe(targets);
        expect(composer.element()).toBe(composerElement);
        await expect.element(composer).toHaveValue("Keep the focused group's draft");
        expect(mocks.rename).not.toHaveBeenCalled();
      } finally {
        await cleanup();
      }
    },
  );

  it("disables impossible restores and recovers automatically when the window expands", async () => {
    const { screen, host, cleanup } = await setup();
    try {
      mocks.showMenu.mockResolvedValueOnce("split-right");
      await screen.getByRole("button", { name: "Main tab actions" }).click();
      useDeskStore.getState().dispatch({ type: "resize", splitId: rootDeskSplit().id, ratio: 0.2 });
      await screen.getByRole("button", { name: "Toggle rail three" }).click();
      const groups = useDeskStore.getState().desk.groups;
      const targets = useDeskStore.getState().desk.targets;
      const layout = useDeskStore.getState().desk.layout;
      const composer = screen.getByRole("textbox", { name: "Existing composer three" });
      await composer.fill("Keep this draft through a narrow window");
      const composerElement = composer.element();
      await page.viewport(650, 850);
      const restore = screen.getByRole("button", { name: "Restore all groups", exact: true });
      await expect.element(restore).toBeDisabled();
      await expect
        .element(restore)
        .toHaveAttribute("title", "Enlarge the window to restore all groups");
      expect(host.querySelectorAll(".desk-pane")).toHaveLength(1);
      expect(host.querySelector(".desk-divider")).toBeNull();
      expect(useDeskStore.getState().desk.focusedGroupId).toBeNull();
      await expect
        .element(screen.getByRole("button", { name: "Restore layout", exact: true }))
        .not.toBeInTheDocument();
      await screen.getByRole("button", { name: "Group 2 tab actions" }).click();
      expect(mocks.showMenu.mock.lastCall?.[0]).toContainEqual({
        id: "focus",
        label: "Restore all groups",
        disabled: true,
      });
      await page.viewport(1000, 850);
      await vi.waitFor(() => expectUsablePanes(host, 2));
      await expect
        .element(screen.getByRole("button", { name: "Focus Group 2", exact: true }))
        .toBeEnabled();

      // Explicit focus survives the same narrow interval; restoring becomes
      // possible on expansion without rewriting the preferred 20/80 ratio.
      await screen.getByRole("button", { name: "Focus Group 2", exact: true }).click();
      await page.viewport(650, 850);
      await expect.element(restore).toBeDisabled();
      const restoreLayout = screen.getByRole("button", { name: "Restore layout", exact: true });
      await expect.element(restoreLayout).toBeDisabled();
      await expect
        .element(restoreLayout)
        .toHaveAttribute("title", "Enlarge the window to restore all groups");
      expect(useDeskStore.getState().desk.focusedGroupId).toBe("g2");
      await page.viewport(1000, 850);
      await expect.element(restore).toBeEnabled();
      await expect.element(restoreLayout).toBeEnabled();
      await restore.click();
      await vi.waitFor(() => expectUsablePanes(host, 2));
      expect(useDeskStore.getState().desk.focusedGroupId).toBeNull();
      expect(useDeskStore.getState().desk.layout).toBe(layout);
      expect(useDeskStore.getState().desk.groups).toBe(groups);
      expect(useDeskStore.getState().desk.targets).toBe(targets);
      expect(composer.element()).toBe(composerElement);
      await expect.element(composer).toHaveValue("Keep this draft through a narrow window");
      expect(mocks.rename).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("supports group rename, overflow selection, focus restore and keyboard resize", async () => {
    const { screen, cleanup } = await setup();
    try {
      await screen.getByRole("button", { name: "Main", exact: true }).click();
      await screen.getByRole("textbox", { name: "Group name" }).fill("Proof pipeline");
      await screen.getByRole("button", { name: "Save", exact: true }).click();
      mocks.showMenu.mockResolvedValueOnce("all-tabs");
      await screen.getByRole("button", { name: "Proof pipeline tab actions" }).click();
      await screen.getByRole("searchbox", { name: "Search open tabs" }).fill("one");
      await screen.getByRole("button", { name: "Chat one Fixture project" }).click();
      expect(useDeskStore.getState().desk.groups.g1?.activeTabKey).toBe(key("one"));
      mocks.showMenu.mockResolvedValueOnce("split-bottom");
      await screen.getByRole("button", { name: "Proof pipeline tab actions" }).click();
      const separator = screen.getByRole("separator", { name: "Resize chat groups" });
      await expect.element(separator).toHaveAttribute("aria-valuenow", "50");
      separator
        .element()
        .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      await expect.element(separator).toHaveAttribute("aria-valuenow", "55");
      await screen.getByRole("button", { name: "Focus Group 2", exact: true }).click();
      expect(useDeskStore.getState().desk.focusedGroupId).toBe("g2");
      await screen.getByRole("button", { name: "Restore layout", exact: true }).click();
      await expect.element(separator).toBeVisible();
      expect(useDeskStore.getState().desk.focusedGroupId).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("keeps F2 rename available without a pencil on the tab strip", async () => {
    const { screen, cleanup } = await setup(["one"]);
    try {
      await expect
        .element(screen.getByRole("button", { name: "Rename Chat one" }))
        .not.toBeInTheDocument();
      await screen.getByRole("tab", { name: "Chat one", exact: true }).click();
      await userEvent.keyboard("{F2}");
      await screen.getByRole("textbox", { name: "Chat title" }).fill("Renamed chat");
      await screen.getByRole("button", { name: "Save", exact: true }).click();
      await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
      expect(mocks.rename).toHaveBeenCalledExactlyOnceWith(
        { environmentId, threadId: "one" },
        "Renamed chat",
        "Chat one",
      );
      expect(mocks.showMenu).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("shows only an always-visible close action on both selected and unselected tabs", async () => {
    const { screen, host, cleanup } = await setup();
    try {
      // Put the pointer outside the strip: visibility cannot depend on hover
      // or on the tab being selected. Sidebar pencil controls are unaffected.
      await screen.getByRole("textbox", { name: "Existing composer three" }).hover();
      expect(host.querySelectorAll('.desk-tab-cell button[aria-label^="Rename "]')).toHaveLength(0);
      expect(host.querySelectorAll(".desk-tab-action")).toHaveLength(3);
      for (const id of ["one", "two", "three"]) {
        const close = screen.getByRole("button", { name: `Close tab Chat ${id}` });
        await expect.element(close).toBeVisible();
        const button = close.element();
        const cell = button.closest(".desk-tab-cell")!;
        expect(getComputedStyle(button).opacity).toBe("1");
        expect(getComputedStyle(cell).opacity).toBe("1");
        const bounds = button.getBoundingClientRect();
        const cellBounds = cell.getBoundingClientRect();
        expect(bounds.left).toBeGreaterThanOrEqual(cellBounds.left);
        expect(bounds.right).toBeLessThanOrEqual(cellBounds.right);
      }
      await screen.getByRole("button", { name: "Close tab Chat one" }).click();
      expect(useDeskStore.getState().desk.groups.g1?.tabs).toEqual([key("two"), key("three")]);
      expect(mocks.rename).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("reveals the selected tab's X as well as its title in an overflowing strip", async () => {
    const ids = Array.from({ length: 12 }, (_, index) => `overflow-${index}`);
    mocks.environment.threadShellById = Object.fromEntries(
      ids.map((id) => [id, { id, archivedAt: null }]),
    );
    const { screen, host, cleanup } = await setup(ids);
    try {
      host.style.width = "560px";
      const strip = screen.getByRole("tablist", { name: "Main tabs" });
      await vi.waitFor(() =>
        expect(strip.element().scrollWidth).toBeGreaterThan(strip.element().clientWidth),
      );
      const lastTab = screen.getByRole("tab", { name: "Chat overflow-11", exact: true });
      await lastTab.click();
      await userEvent.keyboard("{Home}");
      await expect
        .element(screen.getByRole("tab", { name: "Chat overflow-0", exact: true }))
        .toHaveFocus();
      await userEvent.keyboard("{End}");
      await expect.element(lastTab).toHaveFocus();
      const close = screen.getByRole("button", { name: "Close tab Chat overflow-11" });
      await vi.waitFor(() => {
        const bounds = close.element().getBoundingClientRect();
        const viewport = strip.element().getBoundingClientRect();
        expect(bounds.left).toBeGreaterThanOrEqual(viewport.left);
        expect(bounds.right).toBeLessThanOrEqual(viewport.right + 1);
      });
    } finally {
      await cleanup();
    }
  });

  it("keeps one visible pane and a group switcher on narrow windows", async () => {
    const { screen, host, cleanup } = await setup();
    try {
      mocks.showMenu.mockResolvedValueOnce("split-right");
      await screen.getByRole("button", { name: "Main tab actions" }).click();
      await page.viewport(650, 850);
      await expect
        .element(screen.getByRole("group", { name: "Chat groups", exact: true }))
        .toBeVisible();
      expect(host.querySelectorAll(".desk-pane")).toHaveLength(1);
      await screen
        .getByRole("group", { name: "Chat groups", exact: true })
        .getByRole("button", { name: "Main", exact: true })
        .click();
      await expect
        .element(screen.getByRole("textbox", { name: "Existing composer two" }))
        .toBeVisible();
      expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
      expect(useDeskStore.getState().desk.focusedGroupId).toBeNull();
    } finally {
      await cleanup();
    }
  });
  it("keeps separate Desk layouts for local and remote servers with colliding thread IDs", async () => {
    const { screen, cleanup } = await setup();
    try {
      const remote = EnvironmentId.make("remote-workspace-fixture");
      mocks.params = {};
      for (const listener of mocks.routeListeners) listener();
      selectWorkspaceEnvironment(remote);
      await vi.waitFor(() => expect(useDeskStore.getState().desk.environmentId).toBe(remote));
      expect(
        Object.values(useDeskStore.getState().desk.groups).flatMap((group) => group.tabs),
      ).toEqual([]);
      const remoteTarget: ThreadRouteTarget = {
        kind: "server",
        threadRef: { environmentId: remote, threadId: ThreadId.make("one") },
      };
      useDeskStore.getState().dispatch({ type: "open", target: remoteTarget });
      await expect
        .element(screen.getByRole("tab", { name: "Chat one", exact: true }))
        .toBeVisible();
      expect(useDeskStore.getState().desk.groups.g1?.tabs).toEqual([deskTabKey(remoteTarget)]);
      mocks.params = {};
      for (const listener of mocks.routeListeners) listener();
      selectWorkspaceEnvironment(environmentId);
      await vi.waitFor(() =>
        expect(useDeskStore.getState().desk.environmentId).toBe(environmentId),
      );
      expect(useDeskStore.getState().desk.groups.g1?.tabs).toEqual([
        key("one"),
        key("two"),
        key("three"),
      ]);
      await expect
        .element(screen.getByRole("tab", { name: "Chat two", exact: true }))
        .toBeVisible();
    } finally {
      await cleanup();
    }
  });
});
