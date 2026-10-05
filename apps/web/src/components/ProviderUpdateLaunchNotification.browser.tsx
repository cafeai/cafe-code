import { useSyncExternalStore } from "react";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@cafecode/contracts";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const fixture = vi.hoisted(() => ({
  selected: "remote",
  listeners: new Set<() => void>(),
  providers: [] as ServerProvider[],
  remoteUpdate: vi.fn(),
  localUpdate: vi.fn(),
  add: vi.fn(),
  update: vi.fn(),
  close: vi.fn(),
  dismissed: new Set<string>(),
}));
vi.mock("../environments/workspace", () => ({
  readWorkspaceEnvironmentId: () => fixture.selected,
  useWorkspaceEnvironmentId: () =>
    useSyncExternalStore(
      (listener) => {
        fixture.listeners.add(listener);
        return () => fixture.listeners.delete(listener);
      },
      () => fixture.selected,
    ),
}));
vi.mock("../environments/primary", () => ({ usePrimaryEnvironmentId: () => "local" }));
vi.mock("../environments/workspaceApi", () => ({
  ensureWorkspaceApi: (environmentId: string) => ({
    server: {
      updateProvider: environmentId === "remote" ? fixture.remoteUpdate : fixture.localUpdate,
    },
  }),
}));
vi.mock("../rpc/serverState", () => ({ useServerProviders: () => fixture.providers }));
vi.mock("../providerUpdateDismissal", () => ({
  useDismissedProviderUpdateNotificationKeys: () => ({
    dismissedNotificationKeys: fixture.dismissed,
    dismissNotificationKey: vi.fn(),
  }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("./ui/toast", () => ({
  stackedThreadToast: (input: unknown) => input,
  toastManager: { add: fixture.add, update: fixture.update, close: fixture.close },
}));
import { ProviderUpdateLaunchNotification } from "./ProviderUpdateLaunchNotification";

it("updates only the selected server and discards its pending toast when switching to an identical provider on another server", async () => {
  fixture.providers = [
    {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-09-01T00:00:00Z",
      models: [],
      slashCommands: [],
      skills: [],
      versionAdvisory: {
        status: "behind_latest",
        currentVersion: "1.0.0",
        latestVersion: "scope-fixture-2.0.0",
        updateCommand: "codex update",
        canUpdate: true,
        checkedAt: "2026-09-01T00:00:00Z",
        message: "Update available",
      },
    },
  ];
  let resolve!: (result: unknown) => void;
  fixture.remoteUpdate.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  fixture.add.mockImplementation(() => `toast-${fixture.add.mock.calls.length}`);
  const screen = await render(<ProviderUpdateLaunchNotification />);
  try {
    await vi.waitFor(() => expect(fixture.add).toHaveBeenCalledOnce());
    const remotePrompt = fixture.add.mock.calls[0]![0];
    remotePrompt.actionProps.onClick();
    expect(fixture.remoteUpdate).toHaveBeenCalledExactlyOnceWith({
      provider: "codex",
      instanceId: "codex",
    });
    expect(fixture.localUpdate).not.toHaveBeenCalled();
    fixture.selected = "local";
    for (const listener of fixture.listeners) listener();
    await vi.waitFor(() => expect(fixture.add).toHaveBeenCalledTimes(2));
    expect(fixture.close).toHaveBeenCalledWith("toast-1");
    const updatesBeforeCompletion = fixture.update.mock.calls.length;
    resolve(fixture.providers[0]);
    await new Promise((done) => setTimeout(done, 0));
    expect(fixture.update).toHaveBeenCalledTimes(updatesBeforeCompletion);
    expect(fixture.localUpdate).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
  }
});
