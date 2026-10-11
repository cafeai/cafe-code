import { useSyncExternalStore, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@cafecode/contracts";
import { getUiLocale, setUiLocale, uiText } from "@cafecode/shared/i18n";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

type FixtureToastPayload = {
  readonly type?: string;
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  readonly actionProps?: ComponentPropsWithoutRef<"button">;
  readonly data?: {
    readonly secondaryActionProps?: ComponentPropsWithoutRef<"button">;
    readonly dismissAfterVisibleMs?: number;
    readonly onClose?: () => void;
  };
};

const fixture = vi.hoisted(() => ({
  selected: "remote",
  listeners: new Set<() => void>(),
  providerListeners: new Set<() => void>(),
  providers: [] as ServerProvider[],
  remoteUpdate: vi.fn(),
  localUpdate: vi.fn(),
  add: vi.fn(),
  update: vi.fn(),
  close: vi.fn(),
  dismissed: new Set<string>(),
  dismiss: vi.fn(),
  navigate: vi.fn(),
  toastListeners: new Set<() => void>(),
  toastSnapshot: [] as readonly (readonly [string, FixtureToastPayload])[],
  toasts: new Map<string, FixtureToastPayload>(),
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
vi.mock("../rpc/serverState", () => ({
  useServerProviders: () =>
    useSyncExternalStore(
      (listener) => {
        fixture.providerListeners.add(listener);
        return () => fixture.providerListeners.delete(listener);
      },
      () => fixture.providers,
    ),
}));
vi.mock("../providerUpdateDismissal", () => ({
  useDismissedProviderUpdateNotificationKeys: () => ({
    dismissedNotificationKeys: fixture.dismissed,
    dismissNotificationKey: fixture.dismiss,
  }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => fixture.navigate }));
vi.mock("./ui/toast", () => ({
  stackedThreadToast: (input: unknown) => input,
  toastManager: { add: fixture.add, update: fixture.update, close: fixture.close },
}));
import { ProviderUpdateLaunchNotification } from "./ProviderUpdateLaunchNotification";
import {
  getProviderUpdateInitialToastView,
  getProviderUpdateProgressToastView,
  getProviderUpdateRunningToastView,
  type ProviderUpdateCandidate,
} from "./ProviderUpdateLaunchNotification.logic";

const originalLocale = getUiLocale();

function publishToastRevision() {
  // Real manager/provider stores publish immutable snapshots. Returning only a
  // revision while reading a mutable Map from JSX lets React Compiler cache
  // the unchanged Map-derived children, which would test an empty fixture.
  fixture.toastSnapshot = [...fixture.toasts];
  for (const listener of fixture.toastListeners) listener();
}

function ToastSurface() {
  const toasts = useSyncExternalStore(
    (listener) => {
      fixture.toastListeners.add(listener);
      return () => fixture.toastListeners.delete(listener);
    },
    () => fixture.toastSnapshot,
  );
  return (
    <>
      <ProviderUpdateLaunchNotification />
      {toasts.map(([id, toast]) => (
        <section key={id} data-testid="retained-provider-toast" data-toast-id={id}>
          <h2 data-testid="provider-toast-title">{toast.title}</h2>
          <p data-testid="provider-toast-description">{toast.description}</p>
          {toast.actionProps ? <button {...toast.actionProps} data-testid="toast-action" /> : null}
          {toast.data?.secondaryActionProps ? (
            <button {...toast.data.secondaryActionProps} data-testid="toast-secondary-action" />
          ) : null}
        </section>
      ))}
    </>
  );
}

function providerFixture(version: string, canUpdate = true): ProviderUpdateCandidate {
  return {
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
      latestVersion: version,
      updateCommand: canUpdate ? "codex update" : null,
      canUpdate,
      checkedAt: "2026-09-01T00:00:00Z",
      message: "Opaque advisory /{name} 日本語 한국어",
    },
  };
}

beforeEach(() => {
  setUiLocale("en");
  fixture.selected = "remote";
  fixture.providers = [];
  fixture.dismissed.clear();
  fixture.toasts.clear();
  fixture.toastSnapshot = [];
  for (const mock of [
    fixture.remoteUpdate,
    fixture.localUpdate,
    fixture.add,
    fixture.update,
    fixture.close,
    fixture.dismiss,
    fixture.navigate,
  ]) {
    mock.mockReset();
  }
  fixture.add.mockImplementation((payload: FixtureToastPayload) => {
    const id = `toast-${fixture.add.mock.calls.length}`;
    fixture.toasts.set(id, payload);
    publishToastRevision();
    return id;
  });
  fixture.update.mockImplementation((id: string, payload: FixtureToastPayload) => {
    fixture.toasts.set(id, { ...fixture.toasts.get(id), ...payload });
    publishToastRevision();
  });
  fixture.close.mockImplementation((id: string) => {
    fixture.toasts.delete(id);
    publishToastRevision();
  });
});

afterEach(() => {
  setUiLocale(originalLocale);
  expect(fixture.toastListeners.size).toBe(0);
  expect(fixture.listeners.size).toBe(0);
  expect(fixture.providerListeners.size).toBe(0);
});

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

it("changes retained prompt/running/success copy without recreating the notice or replaying the update", async () => {
  const provider = providerFixture("locale-phase-fixture-2.0.0");
  fixture.providers = [provider];
  let resolve!: (result: { providers: readonly ServerProvider[] }) => void;
  fixture.remoteUpdate.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const screen = await render(<ToastSurface />);
  try {
    await vi.waitFor(() => expect(fixture.add).toHaveBeenCalledOnce());
    const prompt = fixture.toasts.get("toast-1")!;
    const originalAction = prompt.actionProps!.onClick;
    const originalSettingsAction = prompt.data!.secondaryActionProps!.onClick;
    const originalDismiss = prompt.data!.onClose;
    const idElement = screen.getByTestId("retained-provider-toast").element();
    const actionElement = screen.getByTestId("toast-action").element();
    for (const locale of ["en", "ja", "ko", "en"] as const) {
      setUiLocale(locale);
      const expected = getProviderUpdateInitialToastView({
        updateProviders: [provider],
        oneClickProviders: [provider],
      });
      await expect
        .element(screen.getByTestId("provider-toast-title"))
        .toHaveTextContent(expected.title);
      await expect
        .element(screen.getByTestId("provider-toast-description"))
        .toHaveTextContent(expected.description);
      await expect
        .element(screen.getByTestId("toast-action"))
        .toHaveTextContent(uiText("Update", undefined, undefined, locale));
      await expect
        .element(screen.getByTestId("toast-secondary-action"))
        .toHaveTextContent(uiText("Settings", undefined, undefined, locale));
      expect(screen.getByTestId("retained-provider-toast").element()).toBe(idElement);
      expect(screen.getByTestId("toast-action").element()).toBe(actionElement);
      expect(fixture.toasts.get("toast-1")!.actionProps!.onClick).toBe(originalAction);
      expect(fixture.toasts.get("toast-1")!.data!.secondaryActionProps!.onClick).toBe(
        originalSettingsAction,
      );
      expect(fixture.toasts.get("toast-1")!.data!.onClose).toBe(originalDismiss);
      expect(fixture.add).toHaveBeenCalledOnce();
      expect(fixture.update).not.toHaveBeenCalled();
      expect(fixture.close).not.toHaveBeenCalled();
      expect(fixture.remoteUpdate).not.toHaveBeenCalled();
      expect(fixture.dismiss).not.toHaveBeenCalled();
    }
    await screen.getByTestId("toast-action").click();
    expect(fixture.remoteUpdate).toHaveBeenCalledExactlyOnceWith({
      provider: "codex",
      instanceId: "codex",
    });
    const updatesAfterStart = fixture.update.mock.calls.length;
    for (const locale of ["ja", "ko", "en"] as const) {
      setUiLocale(locale);
      const expected = getProviderUpdateRunningToastView(1);
      await expect
        .element(screen.getByTestId("provider-toast-title"))
        .toHaveTextContent(expected.title);
      await expect
        .element(screen.getByTestId("provider-toast-description"))
        .toHaveTextContent(expected.description);
      expect(screen.getByTestId("retained-provider-toast").element()).toBe(idElement);
      expect(fixture.toasts.get("toast-1")!.actionProps).toBeUndefined();
      expect(fixture.update).toHaveBeenCalledTimes(updatesAfterStart);
      expect(fixture.remoteUpdate).toHaveBeenCalledOnce();
      expect(fixture.localUpdate).not.toHaveBeenCalled();
    }
    const succeeded: ServerProvider = {
      ...provider,
      version: "2.0.0",
      updateState: {
        status: "succeeded",
        startedAt: "2026-09-01T00:00:00Z",
        finishedAt: "2026-09-01T00:00:01Z",
        message: null,
        output: null,
      },
    };
    resolve({ providers: [succeeded] });
    await vi.waitFor(() => expect(fixture.toasts.get("toast-1")!.type).toBe("success"));
    const updatesAfterCompletion = fixture.update.mock.calls.length;
    for (const locale of ["ko", "ja", "en"] as const) {
      setUiLocale(locale);
      const expected = getProviderUpdateProgressToastView({
        providers: [succeeded],
        providerCount: 1,
      });
      await expect
        .element(screen.getByTestId("provider-toast-title"))
        .toHaveTextContent(expected.title);
      await expect
        .element(screen.getByTestId("provider-toast-description"))
        .toHaveTextContent(expected.description);
      expect(fixture.toasts.get("toast-1")!.data!.dismissAfterVisibleMs).toBe(3000);
      expect(fixture.update).toHaveBeenCalledTimes(updatesAfterCompletion);
      expect(fixture.add).toHaveBeenCalledOnce();
      expect(fixture.remoteUpdate).toHaveBeenCalledOnce();
      expect(fixture.close).not.toHaveBeenCalled();
    }
  } finally {
    await screen.unmount();
  }
});

it("changes a settings-only prompt while keeping its exact action and admission receipt", async () => {
  const provider = providerFixture("locale-settings-fixture-2.0.0", false);
  fixture.providers = [provider];
  const screen = await render(<ToastSurface />);
  try {
    await vi.waitFor(() => expect(fixture.add).toHaveBeenCalledOnce());
    const originalAction = fixture.toasts.get("toast-1")!.actionProps!.onClick;
    for (const locale of ["ja", "ko", "en"] as const) {
      setUiLocale(locale);
      const expected = getProviderUpdateInitialToastView({
        updateProviders: [provider],
        oneClickProviders: [],
      });
      await expect
        .element(screen.getByTestId("provider-toast-description"))
        .toHaveTextContent(expected.description);
      await expect
        .element(screen.getByTestId("toast-action"))
        .toHaveTextContent(uiText("Settings", undefined, undefined, locale));
      expect(fixture.toasts.get("toast-1")!.actionProps!.onClick).toBe(originalAction);
      expect(fixture.add).toHaveBeenCalledOnce();
      expect(fixture.update).not.toHaveBeenCalled();
      expect(fixture.remoteUpdate).not.toHaveBeenCalled();
      expect(fixture.dismiss).not.toHaveBeenCalled();
    }
    await screen.getByTestId("toast-action").click();
    expect(fixture.close).toHaveBeenCalledExactlyOnceWith("toast-1");
    expect(fixture.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/settings/providers" });
    expect(fixture.localUpdate).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
  }
});

it.each(["opaque", "fallback"] as const)(
  "changes rejected update title/actions but keeps %s error provenance",
  async (kind) => {
    const provider = providerFixture(`locale-rejected-${kind}-fixture-2.0.0`);
    const rawMessage =
      '<script data-opaque="provider">unexecuted()</script> /{name} 日本語 한국어 '.repeat(4);
    fixture.providers = [provider];
    fixture.remoteUpdate.mockRejectedValue(
      kind === "opaque" ? new Error(rawMessage) : { message: "Opaque non-Error provider object" },
    );
    const screen = await render(<ToastSurface />);
    try {
      await vi.waitFor(() => expect(fixture.add).toHaveBeenCalledOnce());
      await screen.getByTestId("toast-action").click();
      await vi.waitFor(() => expect(fixture.toasts.get("toast-1")!.type).toBe("error"));
      const originalAction = fixture.toasts.get("toast-1")!.actionProps!.onClick;
      const updatesAfterFailure = fixture.update.mock.calls.length;
      for (const locale of ["ja", "ko", "en"] as const) {
        setUiLocale(locale);
        await expect
          .element(screen.getByTestId("provider-toast-title"))
          .toHaveTextContent(
            uiText(
              "Provider {count, plural, one {update} other {updates}} failed",
              { count: 1 },
              undefined,
              locale,
            ),
          );
        if (kind === "opaque") {
          // The browser matcher normally trims whitespace. Received data must
          // instead remain byte-for-byte text, including this trailing space.
          await vi.waitFor(() => {
            expect(screen.getByTestId("provider-toast-description").element().textContent).toBe(
              rawMessage,
            );
          });
        } else {
          await expect
            .element(screen.getByTestId("provider-toast-description"))
            .toHaveTextContent(uiText("Provider update failed.", undefined, undefined, locale));
        }
        await expect
          .element(screen.getByTestId("toast-action"))
          .toHaveTextContent(uiText("Settings", undefined, undefined, locale));
        expect(fixture.toasts.get("toast-1")!.actionProps!.onClick).toBe(originalAction);
        expect(fixture.remoteUpdate).toHaveBeenCalledOnce();
        expect(fixture.update).toHaveBeenCalledTimes(updatesAfterFailure);
        expect(fixture.add).toHaveBeenCalledOnce();
        expect(fixture.dismiss).not.toHaveBeenCalled();
        expect(
          screen.getByTestId("provider-toast-description").element().querySelector("script"),
        ).toBeNull();
        expect(
          screen
            .getByTestId("provider-toast-description")
            .element()
            .querySelector(".line-clamp-4") !== null,
        ).toBe(kind === "opaque");
      }
    } finally {
      await screen.unmount();
    }
  },
);

it("retains received progress-failure text while updating its Cafe title and settings action", async () => {
  const provider = providerFixture("locale-progress-failed-fixture-2.0.0");
  fixture.providers = [provider];
  fixture.remoteUpdate.mockImplementation(() => new Promise(() => {}));
  const screen = await render(<ToastSurface />);
  try {
    await vi.waitFor(() => expect(fixture.add).toHaveBeenCalledOnce());
    await screen.getByTestId("toast-action").click();
    const rawMessage = "Opaque received update failure /{name} 日本語 한국어";
    const failed: ServerProvider = {
      ...provider,
      updateState: {
        status: "failed",
        startedAt: "2026-09-01T00:00:00Z",
        finishedAt: "2026-09-01T00:00:01Z",
        message: rawMessage,
        output: null,
      },
    };
    fixture.providers = [failed];
    for (const listener of fixture.providerListeners) listener();
    await vi.waitFor(() => expect(fixture.toasts.get("toast-1")!.type).toBe("error"));
    const updatesAfterFailure = fixture.update.mock.calls.length;
    for (const locale of ["ja", "ko", "en"] as const) {
      setUiLocale(locale);
      const expected = getProviderUpdateProgressToastView({
        providers: [failed],
        providerCount: 1,
      });
      await expect
        .element(screen.getByTestId("provider-toast-title"))
        .toHaveTextContent(expected.title);
      await expect
        .element(screen.getByTestId("provider-toast-description"))
        .toHaveTextContent(rawMessage);
      await expect
        .element(screen.getByTestId("toast-action"))
        .toHaveTextContent(uiText("Settings", undefined, undefined, locale));
      expect(fixture.update).toHaveBeenCalledTimes(updatesAfterFailure);
      expect(fixture.remoteUpdate).toHaveBeenCalledOnce();
      expect(fixture.localUpdate).not.toHaveBeenCalled();
    }
  } finally {
    await screen.unmount();
  }
});
