import "../index.css";

import { useSyncExternalStore } from "react";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_CLIENT_SETTINGS,
  type ServerConfig,
} from "@cafecode/contracts";
import { beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
const fixture = vi.hoisted(() => ({
  params: {} as { environmentId?: string; threadId?: string; draftId?: string },
  listeners: new Set<() => void>(),
  navigate: vi.fn(),
  pathname: "/",
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useParams: () =>
    useSyncExternalStore(
      (listener) => {
        fixture.listeners.add(listener);
        return () => fixture.listeners.delete(listener);
      },
      () => fixture.params,
    ),
  useNavigate: () => fixture.navigate,
  useCanGoBack: () => true,
  useLocation: ({ select }: { select: (location: { pathname: string }) => unknown }) =>
    select({ pathname: fixture.pathname }),
}));
vi.mock("../localApi", () => ({
  ensureLocalApi: () => ({
    persistence: {
      getClientSettings: async () => null,
      getSavedEnvironmentSecret: async () => "synthetic-image-session",
    },
  }),
  readLocalApi: () => undefined,
}));
import { writePrimaryEnvironmentDescriptor } from "../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime/catalog";
import { useWorkspaceProjects, useWorkspaceSidebarThreads } from "../environments/workspaceData";
import { selectEnvironmentState, selectAnyThreadRunning, useStore } from "../store";
import { useSettings } from "../hooks/useSettings";
import { useHasUnseenThreadCompletions } from "./sidebar/unseenCompletions";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { resetServerStateForTests, setServerConfigSnapshot } from "../rpc/serverState";
import {
  resetWorkspaceEnvironmentForTests,
  selectWorkspaceEnvironment,
  useWorkspaceEnvironmentId,
  useIsSavedRemoteEnvironment,
  WorkspaceEnvironmentProvider,
} from "../environments/workspace";
import { useComposerDraftStore } from "../composerDraftStore";
import { WorkspaceEnvironmentSelector } from "./WorkspaceEnvironmentSelector";
import { useTheme } from "../hooks/useTheme";
import { useSettingsBackNavigation } from "../hooks/useSettingsBackNavigation";
import { useSidebarBrandImageSrc } from "../brandingImages";
const local = EnvironmentId.make("local"),
  remote = EnvironmentId.make("remote");
function Current() {
  const environmentId = useWorkspaceEnvironmentId();
  const savedRemote = useIsSavedRemoteEnvironment(environmentId);
  return (
    <output data-testid="workspace" data-remote={savedRemote}>
      {environmentId}
    </output>
  );
}
beforeEach(() => {
  fixture.params = {};
  fixture.pathname = "/";
  fixture.navigate.mockReset();
  useStore.setState({ environmentStateById: {} });
  useSavedEnvironmentRuntimeStore.setState({ byId: {} });
  resetServerStateForTests();
  resetWorkspaceEnvironmentForTests();
  writePrimaryEnvironmentDescriptor({ environmentId: local } as never);
  useSavedEnvironmentRegistryStore.setState({
    byId: {
      [remote]: {
        environmentId: remote,
        label: "PC",
        httpBaseUrl: "https://pc",
        wsBaseUrl: "wss://pc",
        createdAt: "fixture",
        lastConnectedAt: null,
      },
    },
  });
  useComposerDraftStore.setState({ draftThreadsByThreadKey: {} });
});

function Catalog() {
  const projects = useWorkspaceProjects();
  const threads = useWorkspaceSidebarThreads();
  const settings = useSettings();
  const unseen = useHasUnseenThreadCompletions();
  const id = useWorkspaceEnvironmentId();
  const running = useStore((state) => selectAnyThreadRunning(state, id));
  return (
    <>
      <output data-testid="projects">{projects.map((p) => p.name).join(",")}</output>
      <output data-testid="chats">{threads.map((t) => t.title).join(",")}</output>
      <output data-testid="accent">{settings.themeAccentColor}</output>
      <output data-testid="activity">{`${unseen}:${running}`}</output>
    </>
  );
}

it("steps between servers with arrows, respects list bounds and preserves Settings", async () => {
  fixture.pathname = "/settings/appearance";
  const screen = await render(
    <WorkspaceEnvironmentProvider>
      <WorkspaceEnvironmentSelector />
      <Current />
    </WorkspaceEnvironmentProvider>,
  );
  try {
    await expect.element(screen.getByRole("button", { name: "Previous server" })).toBeDisabled();
    await screen.getByRole("button", { name: "Next server" }).click();
    await expect.element(screen.getByTestId("workspace")).toHaveTextContent(remote);
    await expect.element(screen.getByRole("button", { name: "Next server" })).toBeDisabled();
    expect(fixture.navigate).not.toHaveBeenCalled();
    fixture.pathname = "/remote/chat";
    await screen.rerender(
      <WorkspaceEnvironmentProvider>
        <WorkspaceEnvironmentSelector />
        <Current />
      </WorkspaceEnvironmentProvider>,
    );
    await screen.getByRole("button", { name: "Previous server" }).click();
    await expect.element(screen.getByTestId("workspace")).toHaveTextContent(local);
    expect(fixture.navigate).toHaveBeenCalledWith({ to: "/" });
  } finally {
    await screen.unmount();
  }
});

function ThemeAndBack() {
  const { theme, setTheme } = useTheme();
  const back = useSettingsBackNavigation();
  return (
    <>
      <output data-testid="theme">{theme}</output>
      <button onClick={() => setTheme("light")}>Use light</button>
      <button onClick={() => setTheme("dark")}>Use dark</button>
      <button onClick={back}>Back</button>
    </>
  );
}

it("loads branding with the selected server's session and discards late image responses after switching", async () => {
  const asset = {
    id: `sha256-${"a".repeat(64)}.png`,
    url: `/api/branding/sidebar-image/sha256-${"a".repeat(64)}.png`,
    mimeType: "image/png" as const,
    width: 1,
    height: 1,
    sizeBytes: 1,
  };
  function Branding() {
    return <img alt="Server branding" src={useSidebarBrandImageSrc(asset)} />;
  }
  const localImageSrc = new URL(asset.url, window.location.origin).toString();
  let finishRequest!: (response: Response) => void;
  const fetchMock = vi.fn<typeof fetch>(() => new Promise((resolve) => (finishRequest = resolve)));
  const fetchSpy = vi.spyOn(window, "fetch").mockImplementation(fetchMock);
  const revokeSpy = vi.spyOn(URL, "revokeObjectURL");
  useSavedEnvironmentRuntimeStore.getState().patch(remote, { connectionState: "connected" });
  selectWorkspaceEnvironment(remote);
  const screen = await render(
    <WorkspaceEnvironmentProvider>
      <Branding />
    </WorkspaceEnvironmentProvider>,
  );
  try {
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://pc${asset.url}`);
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-image-session");

    selectWorkspaceEnvironment(local);
    await expect
      .element(screen.getByRole("img", { name: "Server branding" }))
      .toHaveAttribute("src", localImageSrc);
    finishRequest(new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } }));
    await vi.waitFor(() => expect(init?.signal?.aborted).toBe(true));
    await expect
      .element(screen.getByRole("img", { name: "Server branding" }))
      .toHaveAttribute("src", localImageSrc);

    fetchMock.mockImplementation(
      async () => new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } }),
    );
    selectWorkspaceEnvironment(remote);
    await vi.waitFor(() =>
      expect(
        screen.getByRole("img", { name: "Server branding" }).element().getAttribute("src"),
      ).toMatch(/^blob:/),
    );
    const blobUrl = screen
      .getByRole("img", { name: "Server branding" })
      .element()
      .getAttribute("src");
    selectWorkspaceEnvironment(local);
    await vi.waitFor(() => expect(revokeSpy).toHaveBeenCalledWith(blobUrl));
    await expect
      .element(screen.getByRole("img", { name: "Server branding" }))
      .toHaveAttribute("src", localImageSrc);
  } finally {
    await screen.unmount();
    fetchSpy.mockRestore();
    revokeSpy.mockRestore();
  }
});

it("keeps Settings on its section when switching, isolates themes and returns to the selected server's Desk", async () => {
  fixture.pathname = "/settings/appearance";
  const themeKey = "cafe-code:theme";
  const remoteThemeKey = `${themeKey}:server:remote`;
  const localTheme = localStorage.getItem(themeKey);
  const remoteTheme = localStorage.getItem(remoteThemeKey);
  localStorage.setItem(themeKey, "light");
  localStorage.removeItem(remoteThemeKey);
  const historyBack = vi.spyOn(window.history, "back").mockImplementation(() => {});
  const screen = await render(
    <WorkspaceEnvironmentProvider>
      <WorkspaceEnvironmentSelector />
      <ThemeAndBack />
    </WorkspaceEnvironmentProvider>,
  );
  try {
    await expect.element(screen.getByTestId("theme")).toHaveTextContent("light");
    await screen.getByRole("combobox", { name: "Workspace server" }).click();
    await page.getByRole("option", { name: "PC (offline)", exact: true }).click();
    expect(fixture.navigate).not.toHaveBeenCalled();
    await expect.element(screen.getByTestId("theme")).toHaveTextContent("dark");
    await screen.getByRole("button", { name: "Use light" }).click();
    await screen.getByRole("button", { name: "Use dark" }).click();
    expect(localStorage.getItem(themeKey)).toBe("light");
    expect(localStorage.getItem(remoteThemeKey)).toBe("dark");
    await screen.getByRole("button", { name: "Back", exact: true }).click();
    expect(fixture.navigate).toHaveBeenCalledWith({ to: "/" });
    expect(historyBack).not.toHaveBeenCalled();
    await screen.getByRole("combobox", { name: "Workspace server" }).click();
    await page.getByRole("option", { name: "Local server", exact: true }).click();
    await expect.element(screen.getByTestId("theme")).toHaveTextContent("light");
    fixture.navigate.mockClear();
    await screen.getByRole("button", { name: "Back", exact: true }).click();
    expect(historyBack).toHaveBeenCalledOnce();
    expect(fixture.navigate).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
    historyBack.mockRestore();
    if (localTheme === null) localStorage.removeItem(themeKey);
    else localStorage.setItem(themeKey, localTheme);
    if (remoteTheme === null) localStorage.removeItem(remoteThemeKey);
    else localStorage.setItem(remoteThemeKey, remoteTheme);
  }
});

it("switches catalogs, settings and unread activity together without letting an old chat route reclaim the server", async () => {
  const projectId = ProjectId.make("imported-project");
  const threadId = ThreadId.make("imported-chat");
  const seed = (environmentId: EnvironmentId, label: string, running: boolean) => ({
    ...selectEnvironmentState(useStore.getState(), null),
    projectIds: [projectId],
    projectById: { [projectId]: { id: projectId, environmentId, name: `${label} project` } },
    threadIds: [threadId],
    sidebarThreadSummaryById: {
      [threadId]: {
        id: threadId,
        environmentId,
        title: `${label} chat`,
        projectId: null,
        archivedAt: null,
        createdAt: "2026-01-01T00:00:00Z",
        latestTurn: running ? null : { state: "completed", completedAt: "2026-09-01T00:00:00Z" },
        session: running ? { status: "running" } : null,
      },
    },
  });
  useStore.setState({
    environmentStateById: {
      [local]: seed(local, "Mac", false),
      [remote]: seed(remote, "PC", true),
    } as never,
  });
  const config = (environmentId: EnvironmentId, accent: string) =>
    ({
      environment: { environmentId },
      settings: DEFAULT_SERVER_SETTINGS,
      clientSettings: { ...DEFAULT_CLIENT_SETTINGS, themeAccentColor: accent },
      providers: [],
      issues: [],
    }) as unknown as ServerConfig;
  setServerConfigSnapshot(config(local, "#ff0000"));
  useSavedEnvironmentRuntimeStore.getState().patch(remote, {
    connectionState: "connected",
    serverConfig: config(remote, "#00ff00"),
  });
  fixture.params = { environmentId: remote, threadId };
  const screen = await render(
    <AppAtomRegistryProvider>
      <WorkspaceEnvironmentProvider>
        <WorkspaceEnvironmentSelector />
        <Current />
        <Catalog />
      </WorkspaceEnvironmentProvider>
    </AppAtomRegistryProvider>,
  );
  await expect.element(screen.getByTestId("chats")).toHaveTextContent("PC chat");
  await expect.element(screen.getByTestId("projects")).toHaveTextContent("PC project");
  await expect.element(screen.getByTestId("accent")).toHaveTextContent("#00ff00");
  await expect.element(screen.getByTestId("activity")).toHaveTextContent("false:true");
  // Navigation deliberately remains pending: the existing PC route must not
  // overwrite the explicit Mac selection before it commits.
  await screen.getByRole("combobox", { name: "Workspace server" }).click();
  await page.getByRole("option", { name: "Local server", exact: true }).click();
  await expect.element(screen.getByTestId("workspace")).toHaveTextContent(local);
  await expect.element(screen.getByTestId("chats")).toHaveTextContent("Mac chat");
  await expect.element(screen.getByTestId("projects")).toHaveTextContent("Mac project");
  await expect.element(screen.getByTestId("accent")).toHaveTextContent("#ff0000");
  await expect.element(screen.getByTestId("activity")).toHaveTextContent("true:false");
  expect(fixture.navigate).toHaveBeenCalledWith({ to: "/" });
  fixture.params = {};
  for (const listener of fixture.listeners) listener();
  await expect.element(screen.getByTestId("workspace")).toHaveTextContent(local);
  selectWorkspaceEnvironment(remote);
  await expect.element(screen.getByTestId("chats")).toHaveTextContent("PC chat");
  // A missing remote config must never display the Mac's preferences.
  useSavedEnvironmentRuntimeStore
    .getState()
    .patch(remote, { serverConfig: null, connectionState: "disconnected" });
  await expect.element(screen.getByTestId("accent")).not.toHaveTextContent("#ff0000");
  expect(useStore.getState().environmentStateById[local]?.threadIds).toEqual([threadId]);
});

it("lets a new chat deep link select its server after an explicit switch", async () => {
  fixture.params = { environmentId: remote, threadId: "old" };
  const screen = await render(
    <WorkspaceEnvironmentProvider>
      <Current />
    </WorkspaceEnvironmentProvider>,
  );
  selectWorkspaceEnvironment(local);
  await expect.element(screen.getByTestId("workspace")).toHaveTextContent(local);
  fixture.params = { environmentId: remote, threadId: "new" };
  for (const listener of fixture.listeners) listener();
  await expect.element(screen.getByTestId("workspace")).toHaveTextContent(remote);
});
it("admits a remote deep link before rendering children and keeps workspace selection separate from local bootstrap", async () => {
  fixture.params = { environmentId: remote };
  const screen = await render(
    <WorkspaceEnvironmentProvider>
      <Current />
    </WorkspaceEnvironmentProvider>,
  );
  expect(screen.getByTestId("workspace")).toHaveTextContent(remote);
  expect(screen.getByTestId("workspace")).toHaveAttribute("data-remote", "true");
  fixture.params = {};
  for (const listener of fixture.listeners) listener();
  await expect.element(screen.getByTestId("workspace")).toHaveTextContent(remote);
  selectWorkspaceEnvironment(local);
  await expect.element(screen.getByTestId("workspace")).toHaveTextContent(local);
  await expect.element(screen.getByTestId("workspace")).toHaveAttribute("data-remote", "false");
});
it("selects the draft's server and falls back to local after the selected saved server is removed", async () => {
  useComposerDraftStore.setState({
    draftThreadsByThreadKey: { draft: { environmentId: remote } as never },
  });
  fixture.params = { draftId: "draft" };
  const screen = await render(
    <WorkspaceEnvironmentProvider>
      <Current />
    </WorkspaceEnvironmentProvider>,
  );
  await expect.element(screen.getByTestId("workspace")).toHaveTextContent(remote);
  fixture.params = {};
  for (const listener of fixture.listeners) listener();
  useSavedEnvironmentRegistryStore.setState({ byId: {} });
  await expect.element(screen.getByTestId("workspace")).toHaveTextContent(local);
  await expect.element(screen.getByTestId("workspace")).toHaveAttribute("data-remote", "false");
});
it("keeps the workspace selector absent until a remote connection is saved", async () => {
  const saved = useSavedEnvironmentRegistryStore.getState().byId;
  useSavedEnvironmentRegistryStore.setState({ byId: {} });
  const screen = await render(
    <WorkspaceEnvironmentProvider>
      <WorkspaceEnvironmentSelector />
    </WorkspaceEnvironmentProvider>,
  );
  await expect
    .element(screen.getByRole("combobox", { name: "Workspace server" }))
    .not.toBeInTheDocument();
  useSavedEnvironmentRegistryStore.setState({ byId: saved });
  await expect.element(screen.getByRole("combobox", { name: "Workspace server" })).toBeVisible();
  useSavedEnvironmentRegistryStore.setState({ byId: {} });
  await expect
    .element(screen.getByRole("combobox", { name: "Workspace server" }))
    .not.toBeInTheDocument();
});

it("centers the server caret and fits the themed menu in a narrow sidebar at every interface scale", async () => {
  const root = document.documentElement;
  const originalFontSize = root.style.fontSize;
  const originallyDark = root.classList.contains("dark");
  writePrimaryEnvironmentDescriptor({
    environmentId: local,
    label: "Salt's MacBook Pro with a very long server name",
  } as never);
  const host = document.createElement("div");
  host.style.width = "208px";
  document.body.append(host);
  const screen = await render(
    <WorkspaceEnvironmentProvider>
      <WorkspaceEnvironmentSelector />
      <span data-testid="popover-color" style={{ background: "var(--popover)" }} />
    </WorkspaceEnvironmentProvider>,
    { container: host },
  );
  try {
    for (const dark of [false, true]) {
      root.classList.toggle("dark", dark);
      for (const scale of [80, 100, 130]) {
        root.style.fontSize = `${scale}%`;
        const trigger = screen.getByRole("combobox", { name: "Workspace server" });
        const triggerBounds = trigger.element().getBoundingClientRect();
        const caretBounds = trigger.element().querySelector("svg")!.getBoundingClientRect();
        expect(
          Math.abs(
            caretBounds.top +
              caretBounds.height / 2 -
              (triggerBounds.top + triggerBounds.height / 2),
          ),
        ).toBeLessThan(1);
        expect(triggerBounds.right).toBeLessThanOrEqual(host.getBoundingClientRect().right);
        await trigger.click();
        await expect.element(page.getByRole("listbox")).toBeVisible();
        const list = page.getByRole("listbox").element();
        const surface = list.parentElement!;
        await vi.waitFor(() => {
          expect(
            Math.abs(surface.getBoundingClientRect().width - triggerBounds.width),
          ).toBeLessThan(1);
          expect(surface.getBoundingClientRect().top).toBeGreaterThanOrEqual(triggerBounds.bottom);
        });
        expect(getComputedStyle(surface).backgroundColor).toBe(
          getComputedStyle(screen.getByTestId("popover-color").element()).backgroundColor,
        );
        expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth);
        await userEvent.keyboard("{Escape}");
        await expect.element(page.getByRole("listbox")).not.toBeInTheDocument();
        expect(document.activeElement).toBe(trigger.element());
      }
    }
  } finally {
    await screen.unmount();
    root.style.fontSize = originalFontSize;
    root.classList.toggle("dark", originallyDark);
    host.remove();
  }
});

it("supports keyboard server selection and canceling without switching, while retaining offline recovery", async () => {
  const screen = await render(
    <WorkspaceEnvironmentProvider>
      <WorkspaceEnvironmentSelector />
      <Current />
    </WorkspaceEnvironmentProvider>,
  );
  try {
    const trigger = screen.getByRole("combobox", { name: "Workspace server" });
    trigger.element().focus();
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(page.getByRole("listbox")).toBeVisible();
    await userEvent.keyboard("{End}");
    await expect
      .element(page.getByRole("option", { name: "PC (offline)", exact: true }))
      .toHaveAttribute("data-highlighted");
    await userEvent.keyboard("{Escape}");
    await expect.element(screen.getByTestId("workspace")).toHaveTextContent(local);
    expect(fixture.navigate).not.toHaveBeenCalled();
    // Base UI returns focus to the trigger once the popup's exit transition
    // has finished and it unmounts, so wait for that rather than sampling once.
    await expect.element(trigger).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(page.getByRole("listbox")).toBeVisible();
    await userEvent.keyboard("{End}");
    await expect
      .element(page.getByRole("option", { name: "PC (offline)", exact: true }))
      .toHaveAttribute("data-highlighted");
    await userEvent.keyboard("{Enter}");
    await expect.element(screen.getByTestId("workspace")).toHaveTextContent(remote);
    await expect.element(trigger).toHaveTextContent("PC (offline)");
    await expect
      .element(screen.getByRole("button", { name: "Reconnect selected server" }))
      .toBeVisible();
    expect(fixture.navigate).toHaveBeenCalledWith({ to: "/" });
    useSavedEnvironmentRuntimeStore.getState().patch(remote, { connectionState: "connected" });
    await expect.element(trigger).toHaveTextContent("PC");
    await expect.element(trigger).not.toHaveTextContent("offline");
    await expect
      .element(screen.getByRole("button", { name: "Reconnect selected server" }))
      .not.toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});
