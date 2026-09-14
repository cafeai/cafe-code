vi.mock("~/store", () => ({
  useStore: (selector: (value: unknown) => unknown) => selector({ environmentStateById: {} }),
}));
import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ThreadId,
  type DesktopBridge,
  type ServerSettings,
  type VirtualDesktopState,
  VirtualDesktopError,
} from "@cafecode/contracts";
import { DesktopPicker, VirtualDesktopList } from "./VirtualDesktops";
import { ThreadGoalFooterButton } from "../chat/ThreadGoalControl";
import { VirtualDesktopSettings } from "./VirtualDesktopSettings";

const harness = vi.hoisted(() => ({
  status: vi.fn(),
  update: vi.fn(),
  apply: vi.fn(),
  settings: null as ServerSettings | null,
  url: "http://127.0.0.1:3774/",
}));
vi.mock("~/environments/primary", () => ({ usePrimaryEnvironmentId: () => "local" }));
vi.mock("~/environments/runtime", () => ({
  getEnvironmentHttpBaseUrl: () => harness.url,
  requireEnvironmentConnection: () => ({
    client: { server: { virtualDesktop: harness.status, updateSettings: harness.update } },
  }),
}));
vi.mock("~/rpc/serverState", async () => {
  const { DEFAULT_SERVER_SETTINGS } = await import("@cafecode/contracts");
  return {
    useServerSettings: () => harness.settings ?? DEFAULT_SERVER_SETTINGS,
    applySettingsUpdated: harness.apply,
  };
});
vi.mock("../../attachments/fileAttachments", () => ({
  fileRequest: vi.fn(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 480;
    canvas.height = 300;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#17242f";
    context.fillRect(0, 0, 480, 300);
    context.fillStyle = "#293b4d";
    context.fillRect(18, 18, 444, 264);
    context.fillStyle = "#40566b";
    context.fillRect(18, 18, 444, 28);
    context.fillStyle = "#d9e6ed";
    context.font = "12px sans-serif";
    context.fillText("Test application", 32, 37);
    context.fillStyle = "#82b7a7";
    context.fillRect(36, 66, 120, 92);
    context.fillStyle = "#94aecb";
    context.fillRect(174, 66, 260, 12);
    context.fillRect(174, 91, 200, 8);
    context.fillRect(174, 111, 232, 8);
    context.fillStyle = "#8293a4";
    context.fillRect(36, 183, 398, 6);
    context.fillRect(36, 205, 310, 6);
    context.fillRect(36, 227, 360, 6);
    const bytes = Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]!), (c) =>
      c.charCodeAt(0),
    );
    return new Response(bytes, { headers: { "content-type": "image/png" } });
  }),
  readBounded: async (response: Response) => new Uint8Array(await response.arrayBuffer()),
}));
const id = "68a669ad-0443-45b9-b2c6-8b04920b337f";
const initial: VirtualDesktopState = {
  supported: true,
  enabled: true,
  controlEnabled: true,
  available: true,
  defaultResolution: { width: 1280, height: 800 },
  prerequisites: {
    sway: "installed",
    xwayland: "installed",
    dbus: "installed",
    helper: "installed",
  },
  reason: null,
  desktops: [
    {
      id,
      name: "Research",
      resolution: { width: 1280, height: 800 },
      canResize: true,
      state: "ready",
      reason: null,
      humanControl: false,
      viewerOpen: false,
      renderer: "gles2",
      transfer: "shared-memory",
      controllingThreadId: null,
    },
  ],
  selectedDesktopId: null,
  activeDesktopId: null,
  selectionPending: false,
};
let state = initial;
let mounted: Awaited<ReturnType<typeof render>> | undefined;
const originalBridge = window.desktopBridge;
const environmentId = EnvironmentId.make("local"),
  threadId = ThreadId.make("future-draft");
const open = vi.fn();
async function mount(element: React.ReactNode) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {element}
    </QueryClientProvider>,
  );
}
describe("virtual desktops", () => {
  it.each([80, 100, 130])(
    "matches Goal typography and keeps next-turn status visible at %s percent",
    async (scale) => {
      state = { ...state, selectedDesktopId: id, activeDesktopId: id, selectionPending: true };
      document.documentElement.style.fontSize = scale + "%";
      try {
        mounted = await mount(
          <div className="flex items-center">
            <ThreadGoalFooterButton
              goal={null}
              activeTurnStartedAt={null}
              isTurnRunning={false}
              onClick={() => {}}
            />
            <DesktopPicker
              environmentId={environmentId}
              threadId={threadId}
              provider="codex"
              compact={false}
            />
          </div>,
        );
        const desktop = await page
          .getByRole("button", { name: "Desktop: Research", exact: true })
          .findElement();
        const goal = page.getByRole("button", { name: "Create goal" }).element();
        expect(getComputedStyle(desktop).fontSize).toBe(getComputedStyle(goal).fontSize);
        expect(desktop.getBoundingClientRect().height).toBe(goal.getBoundingClientRect().height);
        expect(desktop.getBoundingClientRect().left).toBeGreaterThanOrEqual(
          goal.getBoundingClientRect().right,
        );
        await expect.element(page.getByText("Next turn", { exact: true })).toBeVisible();
      } finally {
        document.documentElement.style.removeProperty("font-size");
      }
    },
  );
  it("shows a private image for every running desktop card", async () => {
    state = {
      ...state,
      desktops: [
        ...state.desktops,
        {
          ...state.desktops[0]!,
          id: "f4a7b99c-fae9-4867-9135-c33f3b271d96",
          name: "Testing",
          humanControl: true,
        },
      ],
    };
    await page.viewport(1100, 800);
    mounted = await mount(
      <div className="mx-auto max-w-4xl p-6">
        <VirtualDesktopList environmentId={environmentId} live={false} />
      </div>,
    );
    await expect.element(page.getByRole("img", { name: "Preview of Research" })).toBeVisible();
    await expect.element(page.getByRole("img", { name: "Preview of Testing" })).toBeVisible();
    await page.screenshot({ path: "../../../../../build/desktop-ui/cards.png" });
    document.documentElement.classList.add("dark");
    await page.screenshot({ path: "../../../../../build/desktop-ui/cards-dark.png" });
    document.documentElement.classList.remove("dark");
  });

  beforeEach(() => {
    state = initial;
    vi.clearAllMocks();
    harness.settings = {
      ...DEFAULT_SERVER_SETTINGS,
      virtualDesktopsEnabled: true,
      desktopControlMcpEnabled: true,
    };
    harness.url = "http://127.0.0.1:3774/";
    harness.status.mockImplementation(async (request) => {
      if (request.operation === "attach") state = { ...state, selectedDesktopId: request.id };
      if (request.operation === "end")
        state = {
          ...state,
          desktops: state.desktops.filter((d) => d.id !== request.id),
          selectedDesktopId:
            state.selectedDesktopId === request.id ? null : state.selectedDesktopId,
        };
      if (request.operation === "set-display")
        state = {
          ...state,
          desktops: state.desktops.map((d) =>
            d.id === request.id ? { ...d, resolution: request.resolution } : d,
          ),
        };
      return state;
    });
    harness.update.mockImplementation(async (patch) => {
      harness.settings = { ...harness.settings!, ...patch };
      state = {
        ...state,
        enabled: harness.settings!.virtualDesktopsEnabled,
        controlEnabled: harness.settings!.desktopControlMcpEnabled,
        defaultResolution: harness.settings!.desktopDefaultResolution,
      };
      return harness.settings;
    });
    window.desktopBridge = {
      getLocalEnvironmentBootstrap: () => ({
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
        label: "Local",
      }),
      openVirtualDesktop: open,
    } as unknown as DesktopBridge;
  });
  afterEach(async () => {
    await mounted?.unmount();
    mounted = undefined;
    if (originalBridge) window.desktopBridge = originalBridge;
    else delete window.desktopBridge;
  });
  it.each([false, true])(
    "attaches a future draft from the shared picker, compact=%s",
    async (compact) => {
      mounted = await mount(
        <DesktopPicker
          environmentId={environmentId}
          threadId={threadId}
          provider="codex"
          compact={compact}
        />,
      );
      await page.getByRole("button", { name: "Desktop", exact: true }).click();
      await page.getByRole("menuitemradio", { name: "Research Ready" }).click();
      expect(harness.status).toHaveBeenCalledWith({ operation: "attach", id, threadId });
      await page.getByRole("button", { name: "Desktop: Research", exact: true }).click();
      await page.getByRole("menuitemradio", { name: "None", exact: true }).click();
      expect(harness.status).toHaveBeenCalledWith({ operation: "attach", id: null, threadId });
    },
  );
  it.each([false, true])(
    "disables desktops controlled by another chat, compact=%s",
    async (compact) => {
      state = {
        ...state,
        desktops: state.desktops.map((d) => ({
          ...d,
          controllingThreadId: ThreadId.make("other"),
        })),
      };
      mounted = await mount(
        <DesktopPicker
          environmentId={environmentId}
          threadId={threadId}
          provider="codex"
          compact={compact}
        />,
      );
      await page.getByRole("button", { name: "Desktop", exact: true }).click();
      await expect
        .element(page.getByRole("menuitemradio", { name: "Research Busy in another chat" }))
        .toBeDisabled();
      await expect
        .element(page.getByRole("menuitemradio", { name: "None", exact: true }))
        .toBeEnabled();
      expect(harness.status.mock.calls.some(([request]) => request.operation === "attach")).toBe(
        false,
      );
    },
  );

  it("allows the owning chat to reselect its desktop after a pending removal", async () => {
    state = {
      ...state,
      activeDesktopId: id,
      selectionPending: true,
      desktops: state.desktops.map((d) => ({ ...d, controllingThreadId: threadId })),
    };
    mounted = await mount(
      <DesktopPicker
        environmentId={environmentId}
        threadId={threadId}
        provider="codex"
        compact={false}
      />,
    );
    await page.getByRole("button", { name: "Desktop", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Research Codex working" }).click();
    expect(harness.status).toHaveBeenCalledWith({ operation: "attach", id, threadId });
  });

  it("shows a selection race error and refreshes the busy desktop without retrying", async () => {
    const message =
      "Another conversation controls this desktop. Wait for its turn to finish or select another desktop.";
    harness.status.mockImplementation(async (request) => {
      if (request.operation === "attach") {
        state = {
          ...state,
          desktops: state.desktops.map((d) => ({
            ...d,
            controllingThreadId: ThreadId.make("other"),
          })),
        };
        throw new VirtualDesktopError({ code: "busy", message });
      }
      return state;
    });
    mounted = await mount(
      <DesktopPicker
        environmentId={environmentId}
        threadId={threadId}
        provider="codex"
        compact={false}
      />,
    );
    await page.getByRole("button", { name: "Desktop", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Research Ready" }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent(message);
    await expect.element(page.getByRole("alert")).toBeVisible();
    await expect
      .element(page.getByRole("menuitemradio", { name: "Research Busy in another chat" }))
      .toBeDisabled();
    expect(state.selectedDesktopId).toBeNull();
    expect(
      harness.status.mock.calls.filter(([request]) => request.operation === "attach"),
    ).toHaveLength(1);
  });

  it("creates a desktop with the same future thread identity and shows next-turn state", async () => {
    state = { ...state, selectionPending: true, activeDesktopId: id, controlEnabled: false };
    mounted = await mount(
      <DesktopPicker
        environmentId={environmentId}
        threadId={threadId}
        provider="codex"
        compact={false}
      />,
    );
    await page.getByRole("button", { name: "Desktop", exact: true }).click();
    await expect
      .element(page.getByText("Next turn: None. The current turn keeps Research."))
      .toBeVisible();
    await expect
      .element(
        page.getByText(
          "Enable Desktop control in Settings → Desktop control to give Codex access.",
        ),
      )
      .toBeVisible();
    await page.getByRole("menuitem", { name: "New desktop" }).click();
    expect(harness.status.mock.calls.some(([request]) => request.operation === "create")).toBe(
      false,
    );
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Browser testing");
    await page.getByRole("combobox", { name: "Resolution" }).selectOptions("1920x1080");
    await page.getByRole("button", { name: "Create desktop", exact: true }).click();
    expect(harness.status).toHaveBeenCalledWith({
      operation: "create",
      threadId,
      name: "Browser testing",
      resolution: { width: 1920, height: 1080 },
    });
  });
  it("renames, connects and ends a desktop in one action", async () => {
    mounted = await mount(<VirtualDesktopList environmentId={environmentId} live={false} />);
    await page.getByRole("button", { name: "Open desktop", exact: true }).click();
    expect(open).toHaveBeenCalledWith({
      id,
      environmentUrl: harness.url,
      appearance: { dark: false, scale: 1 },
    });
    await page.getByRole("button", { name: "Actions for Research" }).click();
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
    await page.getByRole("textbox", { name: "Desktop name" }).fill("Game testing");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    expect(harness.status).toHaveBeenCalledWith({ operation: "rename", id, name: "Game testing" });
    await page.getByRole("button", { name: "Actions for Research" }).click();
    await page.getByRole("menuitem", { name: /End desktop/ }).click();
    expect(harness.status).toHaveBeenCalledWith({ operation: "end", id });
    await expect.element(page.getByText("Research", { exact: true })).not.toBeInTheDocument();
  });
  it("retries cleanup while keeping another desktop and allowing off-state cleanup", async () => {
    const stoppedId = "f4a7b99c-fae9-4867-9135-c33f3b271d96";
    state = {
      ...state,
      enabled: false,
      controlEnabled: false,
      desktops: [
        ...state.desktops,
        { ...state.desktops[0]!, id: stoppedId, name: "Old desktop", state: "stopped" },
      ],
    };
    mounted = await mount(<VirtualDesktopList environmentId={environmentId} live={false} />);
    await page.getByRole("button", { name: "Actions for Old desktop" }).click();
    await expect.element(page.getByRole("menuitem", { name: /End desktop/ })).toBeEnabled();
    await page.getByRole("menuitem", { name: /End desktop/ }).click();
    expect(harness.status).toHaveBeenCalledWith({ operation: "end", id: stoppedId });
    await expect.element(page.getByText("Old desktop", { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByText("Research", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("menuitem", { name: /End desktop/ }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "Actions for Research" }).click();
    await expect.element(page.getByRole("menuitem", { name: /End desktop/ })).toBeEnabled();
  });
  it("keeps the entry visible when ending fails", async () => {
    state = { ...state, desktops: state.desktops.map((d) => ({ ...d, state: "stopped" })) };
    harness.status.mockImplementation(async (request) => {
      if (request.operation === "end") throw new Error("private storage details");
      return state;
    });
    mounted = await mount(<VirtualDesktopList environmentId={environmentId} live={false} />);
    await page.getByRole("button", { name: "Actions for Research" }).click();
    await page.getByRole("menuitem", { name: /End desktop/ }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("The desktop operation did not complete.");
    await expect.element(page.getByText("Research", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Actions for Research" }).click();
    await expect.element(page.getByRole("menuitem", { name: /End desktop/ })).toBeEnabled();
  });
  it("keeps host viewer launch unavailable in browsers and other environments", async () => {
    harness.url = "https://other.example/";
    mounted = await mount(<VirtualDesktopList environmentId={environmentId} live={false} />);
    await expect
      .element(page.getByRole("button", { name: "Open desktop", exact: true }))
      .toBeDisabled();
    expect(open).not.toHaveBeenCalled();
  });
  it("enables the picker and desktop tools together, preserving off-state cleanup", async () => {
    harness.settings = DEFAULT_SERVER_SETTINGS;
    state = { ...state, enabled: false, controlEnabled: false };
    mounted = await mount(
      <>
        <VirtualDesktopSettings />
        <DesktopPicker
          environmentId={environmentId}
          threadId={threadId}
          provider="codex"
          compact={false}
        />
      </>,
    );
    await expect
      .element(page.getByRole("button", { name: "Desktop", exact: true }))
      .not.toBeInTheDocument();
    await page.getByRole("switch", { name: "Enable desktop control" }).click();
    expect(harness.update).toHaveBeenLastCalledWith({
      virtualDesktopsEnabled: true,
      desktopControlMcpEnabled: true,
    });
    await expect.element(page.getByRole("button", { name: "Desktop", exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("switch", { name: "Enable desktop control" }))
      .toBeChecked();
    await page.getByRole("switch", { name: "Enable desktop control" }).click();
    expect(harness.update).toHaveBeenLastCalledWith({
      virtualDesktopsEnabled: false,
      desktopControlMcpEnabled: false,
    });
    await expect
      .element(page.getByRole("button", { name: "Desktop", exact: true }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "Manage desktops", exact: true }).click();
    await page.getByRole("button", { name: "Actions for Research" }).click();
    await expect.element(page.getByRole("menuitem", { name: /End desktop/ })).toBeEnabled();
    expect(harness.update.mock.calls.every(([patch]) => !("mcpEnabled" in patch))).toBe(true);
  });
  it.each([
    [true, false],
    [false, true],
  ])("repairs partial legacy state explicitly: feature=%s, MCP=%s", async (feature, control) => {
    harness.settings = {
      ...DEFAULT_SERVER_SETTINGS,
      virtualDesktopsEnabled: feature!,
      desktopControlMcpEnabled: control!,
    };
    mounted = await mount(<VirtualDesktopSettings />);
    await expect
      .element(page.getByRole("switch", { name: "Enable desktop control" }))
      .not.toBeChecked();
    expect(harness.update).not.toHaveBeenCalled();
    await page.getByRole("switch", { name: "Enable desktop control" }).click();
    expect(harness.update).toHaveBeenCalledWith({
      virtualDesktopsEnabled: true,
      desktopControlMcpEnabled: true,
    });
  });
  it("keeps failed enablement off and does not display private errors", async () => {
    harness.settings = DEFAULT_SERVER_SETTINGS;
    state = { ...state, enabled: false, controlEnabled: false };
    harness.update.mockRejectedValue(new Error("private error contents"));
    mounted = await mount(<VirtualDesktopSettings />);
    await page.getByRole("switch", { name: "Enable desktop control" }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Could not save desktop settings");
    await expect
      .element(page.getByRole("switch", { name: "Enable desktop control" }))
      .not.toBeChecked();
    expect(harness.apply).not.toHaveBeenCalled();
  });
  it("saves any whole-number observation limit, including zero, without changing desktop access", async () => {
    mounted = await mount(<VirtualDesktopSettings />);
    const field = page.getByRole("spinbutton", { name: "Saved screenshots" });
    await expect.element(field).toHaveValue(50);
    await field.fill("1250");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await vi.waitFor(() =>
      expect(harness.update).toHaveBeenLastCalledWith({ desktopObservationRetention: 1250 }),
    );
    await field.fill("0");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await vi.waitFor(() =>
      expect(harness.update).toHaveBeenLastCalledWith({ desktopObservationRetention: 0 }),
    );
    await field.fill("-1");
    await expect.element(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await field.fill("1.5");
    await expect.element(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await field.fill("");
    await expect.element(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  });
  it("lists missing dependencies without install commands and refreshes after setup", async () => {
    state = {
      ...state,
      available: false,
      prerequisites: { ...initial.prerequisites!, sway: "missing", xwayland: "missing" },
    };
    mounted = await mount(<VirtualDesktopSettings />);
    await expect
      .element(page.getByRole("heading", { name: "Desktop control", level: 1 }))
      .toBeVisible();
    await expect.element(page.getByText("Sway", { exact: true })).toBeVisible();
    expect(page.getByText("Sway", { exact: true }).element().closest("li")?.textContent).toContain(
      "Missing",
    );
    expect(page.getByText("D-Bus", { exact: true }).element().closest("li")?.textContent).toContain(
      "Installed",
    );
    await expect.element(page.getByText(/Package names vary between distributions/)).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: /copy|install/i }))
      .not.toBeInTheDocument();
    await page.viewport(1000, 1050);
    await page.screenshot({ path: "../../../../../build/desktop-ui/setup.png" });
    let resolveRecheck!: (value: VirtualDesktopState) => void;
    const recheck = new Promise<VirtualDesktopState>((resolve) => {
      resolveRecheck = resolve;
    });
    harness.status.mockImplementation((request) =>
      request.operation === "recheck" ? recheck : Promise.resolve(state),
    );
    await page.getByRole("button", { name: "Check again" }).click();
    await expect.element(page.getByRole("button", { name: "Checking…" })).toBeDisabled();
    state = initial;
    resolveRecheck(state);
    await expect.element(page.getByText("Required components installed")).toBeVisible();
    expect(harness.status).toHaveBeenCalledWith({ operation: "recheck" });
    expect(harness.update).not.toHaveBeenCalled();
  });

  it.each(["missing", "unavailable"] as const)(
    "explains how to repair a %s bundled component",
    async (helper) => {
      state = { ...state, available: false, prerequisites: { ...initial.prerequisites!, helper } };
      mounted = await mount(<VirtualDesktopSettings />);
      await expect.element(page.getByText("Cafe desktop component", { exact: true })).toBeVisible();
      const item = page
        .getByText("Cafe desktop component", { exact: true })
        .element()
        .closest("li")!;
      expect(item.textContent).toContain(helper === "missing" ? "Missing" : "Unable to run");
      expect(item.textContent?.toLowerCase()).toContain("update or reinstall cafe");
      await expect
        .element(page.getByText(/Install the missing system components/))
        .not.toBeInTheDocument();
    },
  );

  it("preserves setup guidance after a failed recheck without exposing transport errors", async () => {
    state = {
      ...state,
      available: false,
      prerequisites: { ...initial.prerequisites!, sway: "missing" },
    };
    harness.status.mockImplementation(async (request) => {
      if (request.operation === "recheck") throw new Error("private transport details");
      return state;
    });
    mounted = await mount(<VirtualDesktopSettings />);
    await page.getByRole("button", { name: "Check again" }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("The desktop operation did not complete.");
    await expect.element(page.getByRole("button", { name: "Check again" })).toBeEnabled();
    expect(page.getByText("Sway", { exact: true }).element().closest("li")?.textContent).toContain(
      "Missing",
    );
    await expect.element(page.getByText("private transport details")).not.toBeInTheDocument();
  });

  it("offers setup from the picker and checks the selected environment", async () => {
    state = {
      ...state,
      available: false,
      prerequisites: { ...initial.prerequisites!, sway: "missing" },
    };
    harness.url = "https://other.example/";
    mounted = await mount(
      <DesktopPicker
        environmentId={environmentId}
        threadId={threadId}
        provider="codex"
        compact={false}
      />,
    );
    await page.getByRole("button", { name: "Desktop", exact: true }).click();
    await page.getByRole("menuitem", { name: "Set up desktops", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "New desktop", exact: true }))
      .toBeDisabled();
    await expect
      .element(page.getByText(/Linux computer running this Cafe environment/))
      .toBeVisible();
    await page.getByRole("button", { name: "Check again" }).click();
    expect(harness.status).toHaveBeenCalledWith({ operation: "recheck" });
    expect(open).not.toHaveBeenCalled();
  });

  it("does not infer component status for an older runtime", async () => {
    const { prerequisites: _prerequisites, ...legacy } = initial;
    state = legacy;
    mounted = await mount(<VirtualDesktopSettings />);
    await expect.element(page.getByText(/Component details are unavailable/)).toBeVisible();
    await expect.element(page.getByText("Required components installed")).not.toBeInTheDocument();
  });

  it("creates from the manager with defaults, custom dimensions and aspect locking", async () => {
    state = { ...state, defaultResolution: { width: 1600, height: 1200 } };
    mounted = await mount(<VirtualDesktopList environmentId={environmentId} live={false} />);
    await page.getByRole("button", { name: "New desktop", exact: true }).click();
    await expect
      .element(page.getByRole("spinbutton", { name: "Width (pixels)" }))
      .toHaveValue(1600);
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Portrait review");
    await page.getByRole("combobox", { name: "Resolution" }).selectOptions("1080x1920");
    await page.getByRole("checkbox", { name: "Lock aspect ratio" }).click();
    await page.getByRole("spinbutton", { name: "Width (pixels)" }).fill("720");
    await expect
      .element(page.getByRole("spinbutton", { name: "Height (pixels)" }))
      .toHaveValue(1280);
    await page.viewport(1100, 900);
    await page.screenshot({ path: "../../../../../build/desktop-ui/create-desktop.png" });
    await page.getByRole("button", { name: "Create desktop", exact: true }).click();
    expect(harness.status).toHaveBeenCalledWith({
      operation: "create",
      name: "Portrait review",
      resolution: { width: 720, height: 1280 },
    });
    expect(harness.update).not.toHaveBeenCalled();
  });
  it("does not create on cancel or with invalid dimensions, and preserves input after failure", async () => {
    mounted = await mount(<VirtualDesktopList environmentId={environmentId} live={false} />);
    await page.getByRole("button", { name: "New desktop", exact: true }).click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(harness.status.mock.calls.some(([request]) => request.operation === "create")).toBe(
      false,
    );
    await page.getByRole("button", { name: "New desktop", exact: true }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Failure retry");
    for (const width of ["0", "2049", "123.5", ""]) {
      await page.getByRole("spinbutton", { name: "Width (pixels)" }).fill(width);
      await expect
        .element(page.getByRole("button", { name: "Create desktop", exact: true }))
        .toBeDisabled();
    }
    await page.getByRole("spinbutton", { name: "Width (pixels)" }).fill("1440");
    harness.status.mockImplementation(async (request) => {
      if (request.operation === "create") throw new Error("private details");
      return state;
    });
    await page.getByRole("button", { name: "Create desktop", exact: true }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("The desktop operation did not complete.");
    await expect
      .element(page.getByRole("textbox", { name: "Name", exact: true }))
      .toHaveValue("Failure retry");
    await expect
      .element(page.getByRole("spinbutton", { name: "Width (pixels)" }))
      .toHaveValue(1440);
  });
  it("changes a running session's resolution without saving defaults", async () => {
    mounted = await mount(<VirtualDesktopList environmentId={environmentId} live={false} />);
    await page.getByRole("button", { name: "Actions for Research" }).click();
    await page.getByRole("menuitem", { name: "Display settings", exact: true }).click();
    await page.getByRole("combobox", { name: "Resolution" }).selectOptions("1920x1080");
    await page.getByRole("button", { name: "Apply resolution", exact: true }).click();
    expect(harness.status).toHaveBeenCalledWith({
      operation: "set-display",
      id,
      resolution: { width: 1920, height: 1080 },
    });
    await expect.element(page.getByText("1920 × 1080", { exact: true })).toBeVisible();
    expect(harness.update).not.toHaveBeenCalled();
  });
  it("saves new-desktop defaults without changing any running session or access flags", async () => {
    mounted = await mount(<VirtualDesktopSettings />);
    await page.getByRole("combobox", { name: "Resolution" }).selectOptions("1080x1920");
    await page.getByRole("button", { name: "Save default resolution", exact: true }).click();
    expect(harness.update).toHaveBeenCalledExactlyOnceWith({
      desktopDefaultResolution: { width: 1080, height: 1920 },
    });
    expect(harness.status.mock.calls.some(([request]) => request.operation === "set-display")).toBe(
      false,
    );
    await expect
      .element(page.getByRole("button", { name: "Save default resolution", exact: true }))
      .toBeDisabled();
  });
  it("hides desktop controls on unsupported hosts", async () => {
    state = { ...state, supported: false };
    mounted = await mount(
      <>
        <VirtualDesktopSettings />
        <DesktopPicker
          environmentId={environmentId}
          threadId={threadId}
          provider="codex"
          compact={false}
        />
      </>,
    );
    await vi.waitFor(() => expect(harness.status).toHaveBeenCalled());
    await expect
      .element(page.getByRole("switch", { name: "Enable desktop control" }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Desktop", exact: true }))
      .not.toBeInTheDocument();
  });
});
