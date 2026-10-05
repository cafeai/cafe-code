import "../../index.css";
import {
  EnvironmentId,
  ThreadId,
  type LocalApi,
  type OrchestrationShellSnapshot,
} from "@cafecode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { ArchivedThreadsPanel, RecentlyDeletedThreadsPanel } from "./SettingsPanels";
import { useStore } from "../../store";
import { writePrimaryEnvironmentDescriptor } from "../../environments/primary";
import {
  resetWorkspaceEnvironmentForTests,
  selectWorkspaceEnvironment,
} from "../../environments/workspace";
import { __resetLocalApiForTests } from "../../localApi";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime/catalog";

const mocks = vi.hoisted(() => ({
  archived: [] as Array<{ environmentId: EnvironmentId; snapshot: OrchestrationShellSnapshot }>,
  deleted: [] as Array<{ environmentId: EnvironmentId; snapshot: OrchestrationShellSnapshot }>,
  archivedEnvironmentIds: [] as EnvironmentId[][],
  deletedEnvironmentIds: [] as EnvironmentId[][],
  unarchive: vi.fn(),
  restore: vi.fn(),
  hardDelete: vi.fn(),
  confirmDelete: vi.fn(),
  refreshArchived: vi.fn(),
  refreshDeleted: vi.fn(),
  contextMenu: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock("../../environments/workspaceApi", () => ({
  readWorkspaceApi: () => window.nativeApi,
  ensureWorkspaceApi: () => window.nativeApi,
  getWorkspaceServerConfig: () => null,
  patchWorkspaceServerConfig: vi.fn(),
}));
vi.mock("../../hooks/useThreadActions", () => ({
  useThreadActions: () => ({
    unarchiveThread: mocks.unarchive,
    confirmAndDeleteThread: mocks.confirmDelete,
    restoreThread: mocks.restore,
    hardDeleteThread: mocks.hardDelete,
  }),
}));
vi.mock("../../lib/archivedThreadsState", () => ({
  useArchivedThreadSnapshots: (environmentIds: EnvironmentId[]) => {
    mocks.archivedEnvironmentIds.push([...environmentIds]);
    return {
      // The fixture must honor the requested environment set; returning every
      // snapshot unconditionally would hide a missing standalone-only server.
      snapshots: mocks.archived.filter((entry) => environmentIds.includes(entry.environmentId)),
      error: null,
      isLoading: false,
      refresh: mocks.refreshArchived,
    };
  },
}));
vi.mock("../../lib/deletedThreadsState", () => ({
  useDeletedThreadSnapshots: (environmentIds: EnvironmentId[]) => {
    mocks.deletedEnvironmentIds.push([...environmentIds]);
    return {
      snapshots: mocks.deleted.filter((entry) => environmentIds.includes(entry.environmentId)),
      error: null,
      isLoading: false,
      refresh: mocks.refreshDeleted,
    };
  },
}));
const primary = EnvironmentId.make("history-primary-fixture");
const remote = EnvironmentId.make("history-remote-fixture");
const threadId = ThreadId.make("standalone-history");
function registerSecondaryEnvironment(environmentId: EnvironmentId, connected: boolean) {
  useSavedEnvironmentRegistryStore.setState({
    byId: {
      ...useSavedEnvironmentRegistryStore.getState().byId,
      [environmentId]: {
        environmentId,
        label: "Fixture secondary",
        httpBaseUrl: "http://fixture.invalid",
        wsBaseUrl: "ws://fixture.invalid",
        createdAt: "2026-09-01T00:00:00Z",
        lastConnectedAt: null,
      },
    },
  });
  useSavedEnvironmentRuntimeStore
    .getState()
    .patch(environmentId, { connectionState: connected ? "connected" : "disconnected" });
}
function snapshot(title: string): OrchestrationShellSnapshot {
  // Shell-only history fixture: there is deliberately no project or detail.
  return {
    projects: [],
    threads: [
      {
        id: threadId,
        projectId: null,
        title,
        createdAt: "2026-09-01T00:00:00Z",
        updatedAt: "2026-09-04T00:00:00Z",
        archivedAt: "2026-09-02T00:00:00Z",
        deletedAt: "2026-09-03T00:00:00Z",
      },
    ],
  } as unknown as OrchestrationShellSnapshot;
}
beforeEach(async () => {
  await page.viewport(1100, 800);
  await __resetLocalApiForTests();
  resetWorkspaceEnvironmentForTests();
  useSavedEnvironmentRegistryStore.setState({ byId: {} });
  useSavedEnvironmentRuntimeStore.setState({ byId: {} });
  writePrimaryEnvironmentDescriptor({
    environmentId: primary,
    label: "Fixture primary",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "fixture",
    capabilities: { repositoryIdentity: true, standaloneChats: true },
  });
  window.nativeApi = {
    contextMenu: { show: mocks.contextMenu },
    dialogs: { confirm: mocks.confirm },
  } as unknown as LocalApi;
  useStore.setState({ environmentStateById: {} });
  mocks.archived = [{ environmentId: primary, snapshot: snapshot("Archived standalone") }];
  mocks.deleted = [{ environmentId: primary, snapshot: snapshot("Deleted standalone") }];
  mocks.archivedEnvironmentIds = [];
  mocks.deletedEnvironmentIds = [];
  for (const mock of [
    mocks.unarchive,
    mocks.restore,
    mocks.hardDelete,
    mocks.confirmDelete,
    mocks.refreshArchived,
    mocks.refreshDeleted,
    mocks.contextMenu,
    mocks.confirm,
  ])
    mock.mockReset();
  mocks.unarchive.mockResolvedValue(undefined);
  mocks.restore.mockResolvedValue(undefined);
  mocks.hardDelete.mockResolvedValue(undefined);
  mocks.confirmDelete.mockResolvedValue(undefined);
  mocks.confirm.mockResolvedValue(true);
});
afterEach(async () => {
  delete window.nativeApi;
  useStore.setState({ environmentStateById: {} });
  writePrimaryEnvironmentDescriptor(null);
  await __resetLocalApiForTests();
});

describe("standalone history settings", () => {
  it("changes history immediately with the selected server and keeps bulk deletion scoped after a delayed confirmation", async () => {
    registerSecondaryEnvironment(remote, true);
    mocks.deleted.push({ environmentId: remote, snapshot: snapshot("Remote deleted standalone") });
    let confirm!: (answer: boolean) => void;
    mocks.confirm.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          confirm = resolve;
        }),
    );
    const screen = await render(<RecentlyDeletedThreadsPanel />);
    try {
      await expect
        .element(screen.getByRole("heading", { name: "Deleted standalone", exact: true }))
        .toBeVisible();
      await expect
        .element(screen.getByRole("heading", { name: "Remote deleted standalone", exact: true }))
        .not.toBeInTheDocument();
      await screen.getByRole("button", { name: "Empty Recycle Bin", exact: true }).click();
      selectWorkspaceEnvironment(remote);
      await expect
        .element(screen.getByRole("heading", { name: "Remote deleted standalone", exact: true }))
        .toBeVisible();
      await expect
        .element(screen.getByRole("heading", { name: "Deleted standalone", exact: true }))
        .not.toBeInTheDocument();
      expect(mocks.deletedEnvironmentIds.at(-1)).toEqual([remote]);
      confirm(true);
      await vi.waitFor(() =>
        expect(mocks.hardDelete).toHaveBeenCalledExactlyOnceWith(
          { environmentId: primary, threadId },
          { confirm: false, refresh: false },
        ),
      );
    } finally {
      await screen.unmount();
    }
  });
  it("queries and unarchives only the selected standalone-only server", async () => {
    registerSecondaryEnvironment(remote, true);
    mocks.archived = [
      { environmentId: remote, snapshot: snapshot("Secondary archived standalone") },
    ];
    selectWorkspaceEnvironment(remote);
    const screen = await render(<ArchivedThreadsPanel />);
    try {
      expect(mocks.archivedEnvironmentIds.at(-1)).toEqual([remote]);
      await expect
        .element(
          screen.getByRole("heading", { name: "Secondary archived standalone", exact: true }),
        )
        .toBeVisible();
      await screen.getByRole("button", { name: "Unarchive", exact: true }).click();
      expect(mocks.unarchive).toHaveBeenCalledExactlyOnceWith({ environmentId: remote, threadId });
      expect(mocks.hardDelete).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
  it("queries and restores only the selected server without including other connected or offline servers", async () => {
    const disconnected = EnvironmentId.make("history-disconnected-fixture");
    const unknown = EnvironmentId.make("history-unknown-fixture");
    registerSecondaryEnvironment(remote, true);
    registerSecondaryEnvironment(disconnected, false);
    useSavedEnvironmentRuntimeStore.getState().patch(unknown, { connectionState: "connected" });
    mocks.deleted = [
      { environmentId: remote, snapshot: snapshot("Secondary deleted standalone") },
      { environmentId: disconnected, snapshot: snapshot("Disconnected history") },
      { environmentId: unknown, snapshot: snapshot("Unknown history") },
    ];
    mocks.contextMenu.mockResolvedValue("restore");
    selectWorkspaceEnvironment(remote);
    const screen = await render(<RecentlyDeletedThreadsPanel />);
    try {
      expect(mocks.deletedEnvironmentIds.at(-1)).toEqual([remote]);
      await expect
        .element(screen.getByRole("heading", { name: "Disconnected history", exact: true }))
        .not.toBeInTheDocument();
      await expect
        .element(screen.getByRole("heading", { name: "Unknown history", exact: true }))
        .not.toBeInTheDocument();
      screen
        .getByRole("heading", { name: "Secondary deleted standalone", exact: true })
        .element()
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 50 }));
      await vi.waitFor(() =>
        expect(mocks.restore).toHaveBeenCalledExactlyOnceWith({ environmentId: remote, threadId }),
      );
      expect(mocks.hardDelete).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
  it("queries primary with zero projects and unarchives a projectless saved chat using its exact scope", async () => {
    const screen = await render(<ArchivedThreadsPanel />);
    try {
      await expect
        .element(screen.getByRole("heading", { name: "Chats", exact: true }))
        .toBeVisible();
      await expect
        .element(screen.getByRole("heading", { name: "Archived standalone", exact: true }))
        .toBeVisible();
      expect(mocks.archivedEnvironmentIds.at(-1)).toEqual([primary]);
      await screen.getByRole("button", { name: "Unarchive", exact: true }).click();
      expect(mocks.unarchive).toHaveBeenCalledExactlyOnceWith({ environmentId: primary, threadId });
      await vi.waitFor(() => expect(mocks.refreshArchived).toHaveBeenCalledOnce());
    } finally {
      await screen.unmount();
    }
  });
  it("restores standalone recycle-bin rows without a project lookup", async () => {
    mocks.contextMenu.mockResolvedValue("restore");
    const screen = await render(<RecentlyDeletedThreadsPanel />);
    try {
      await expect
        .element(screen.getByRole("heading", { name: "Chats", exact: true }))
        .toBeVisible();
      expect(mocks.deletedEnvironmentIds.at(-1)).toEqual([primary]);
      const heading = screen.getByRole("heading", { name: "Deleted standalone", exact: true });
      heading
        .element()
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 50, clientY: 60 }));
      await vi.waitFor(() =>
        expect(mocks.restore).toHaveBeenCalledExactlyOnceWith({ environmentId: primary, threadId }),
      );
      expect(mocks.refreshDeleted).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });
  it("empties only the selected server Recycle Bin even when other servers reuse its thread ids", async () => {
    registerSecondaryEnvironment(remote, true);
    mocks.deleted.push({ environmentId: remote, snapshot: snapshot("Remote deleted standalone") });
    const screen = await render(<RecentlyDeletedThreadsPanel />);
    try {
      await screen.getByRole("button", { name: "Empty Recycle Bin", exact: true }).click();
      await vi.waitFor(() => expect(mocks.hardDelete).toHaveBeenCalledTimes(1));
      expect(mocks.confirm).toHaveBeenCalledOnce();
      expect(mocks.hardDelete).toHaveBeenNthCalledWith(
        1,
        { environmentId: primary, threadId },
        { confirm: false, refresh: false },
      );
      expect(mocks.refreshDeleted).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });
  it("does not permanently delete any history if the existing confirmation is declined", async () => {
    mocks.confirm.mockResolvedValue(false);
    const screen = await render(<RecentlyDeletedThreadsPanel />);
    try {
      await screen.getByRole("button", { name: "Empty Recycle Bin", exact: true }).click();
      expect(mocks.hardDelete).not.toHaveBeenCalled();
      expect(mocks.refreshDeleted).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
});
