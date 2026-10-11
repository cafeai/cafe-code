import { act, useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { EnvironmentId, ThreadId, TurnId, type ScopedThreadRef } from "@cafecode/contracts";
import { getUiLocale, setUiLocale, uiText } from "@cafecode/shared/i18n";

type FixtureThread = {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly title: string;
  readonly session: {
    readonly status: "running" | "ready";
    readonly activeTurnId: TurnId | null;
  };
};

const fixture = vi.hoisted(() => ({
  threads: [] as readonly FixtureThread[],
  settings: { notificationsEnabled: true },
  routeTarget: null as { readonly kind: "server"; readonly threadRef: ScopedThreadRef } | null,
  listeners: new Set<() => void>(),
  router: { navigate: vi.fn() },
  readApi: vi.fn(),
  policy:
    vi.fn<
      (input: {
        readonly threadId: ThreadId;
        readonly turnId: TurnId | null;
      }) => Promise<{ readonly notify: boolean }>
    >(),
  notify: vi.fn(),
  notificationListener: vi.fn(),
}));

function useFixtureSnapshot<A>(read: () => A): A {
  return useSyncExternalStore((listener) => {
    fixture.listeners.add(listener);
    return () => fixture.listeners.delete(listener);
  }, read);
}

// The component runs unchanged against synthetic shell/settings/router inputs.
// Its real scheduled policy helper sees only this in-memory deferred API; the
// browser Notification constructor is replaced before mount, never OS delivery.
vi.mock("../environments/workspaceData", () => ({
  useWorkspaceSidebarThreads: () => useFixtureSnapshot(() => fixture.threads),
}));
vi.mock("../environments/workspace", () => ({
  useWorkspaceEnvironmentId: () => "notification-locale-owner",
}));
vi.mock("../hooks/useSettings", () => ({
  useSettings: () => useFixtureSnapshot(() => fixture.settings),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => fixture.router,
  useParams: () => useFixtureSnapshot(() => fixture.routeTarget),
}));
vi.mock("../env", () => ({ isElectron: true }));
vi.mock("../environmentApi", () => ({ readEnvironmentApi: fixture.readApi }));

import { DesktopNotificationWatcher } from "./DesktopNotificationWatcher";

const environmentId = EnvironmentId.make("notification-locale-owner");
const threadId = ThreadId.make("notification-thread");
const turnId = TurnId.make("notification-turn-one");
const laterTurnId = TurnId.make("notification-turn-two");
const originalLocale = getUiLocale();
let mounted: Awaited<ReturnType<typeof render>> | undefined;

function runningThread(activeTurnId: TurnId = turnId): FixtureThread {
  return {
    environmentId,
    id: threadId,
    title: "Opaque thread 日本語 한국어 /{title}",
    session: { status: "running", activeTurnId },
  };
}

function settledThread(): FixtureThread {
  return { ...runningThread(), session: { status: "ready", activeTurnId: null } };
}

async function publish(change: () => void) {
  await act(async () => {
    change();
    for (const listener of fixture.listeners) listener();
  });
}

function pendingDecision() {
  let resolve: (result: { readonly notify: boolean }) => void = () => {
    throw new Error("Synthetic decision was not initialized.");
  };
  const promise = new Promise<{ readonly notify: boolean }>((complete) => {
    resolve = complete;
  });
  fixture.policy.mockReturnValueOnce(promise);
  return {
    async finish(notify = true) {
      // Real promise resolution and React's settled commit boundary, not fake
      // clocks or a polling delay that could hide another notification.
      await act(async () => {
        resolve({ notify });
        await promise;
      });
    },
  };
}

beforeEach(() => {
  setUiLocale("en");
  fixture.threads = [runningThread()];
  fixture.settings = { notificationsEnabled: true };
  fixture.routeTarget = null;
  fixture.listeners.clear();
  fixture.router.navigate.mockReset();
  fixture.policy.mockReset().mockResolvedValue({ notify: true });
  fixture.readApi
    .mockReset()
    .mockReturnValue({ scheduledFollowups: { notification: fixture.policy } });
  fixture.notify.mockReset();
  fixture.notificationListener.mockReset();
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  vi.stubGlobal(
    "Notification",
    class {
      constructor(title: string, options?: NotificationOptions) {
        fixture.notify(title, options);
      }
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        fixture.notificationListener(type, listener);
      }
    },
  );
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  expect(fixture.listeners.size).toBe(0);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setUiLocale(originalLocale);
});

describe("desktop completion notification language lifetime", () => {
  it.each(["ja", "ko"] as const)(
    "uses current %s when a delayed exact-turn policy resolves without re-admission",
    async (locale) => {
      const pending = pendingDecision();
      mounted = await render(<DesktopNotificationWatcher />);
      expect(fixture.policy).not.toHaveBeenCalled();
      await publish(() => {
        fixture.threads = [settledThread()];
      });
      expect(fixture.readApi).toHaveBeenCalledExactlyOnceWith(environmentId);
      expect(fixture.policy).toHaveBeenCalledExactlyOnceWith({ threadId, turnId });
      expect(fixture.notify).not.toHaveBeenCalled();

      setUiLocale(locale);
      await pending.finish();
      expect(fixture.notify).toHaveBeenCalledExactlyOnceWith(runningThread().title, {
        body: uiText("Finished running", undefined, undefined, locale),
        tag: `cafe-code-thread-${environmentId}-${threadId}`,
      });
      expect(fixture.notificationListener).toHaveBeenCalledTimes(1);
      expect(fixture.policy).toHaveBeenCalledTimes(1);
      setUiLocale(locale === "ja" ? "ko" : "ja");
      await publish(() => {
        fixture.threads = [settledThread()];
      });
      expect(fixture.notify).toHaveBeenCalledTimes(1);
      expect(fixture.policy).toHaveBeenCalledTimes(1);
      expect(fixture.router.navigate).not.toHaveBeenCalled();
    },
  );

  it("does not deliver an unmounted candidate or notify an already settled baseline after remount", async () => {
    const pending = pendingDecision();
    mounted = await render(<DesktopNotificationWatcher />);
    await publish(() => {
      fixture.threads = [settledThread()];
    });
    expect(fixture.policy).toHaveBeenCalledTimes(1);
    await mounted.unmount();
    mounted = await render(<DesktopNotificationWatcher />);
    setUiLocale("ja");
    await pending.finish();
    expect(fixture.notify).not.toHaveBeenCalled();
    expect(fixture.policy).toHaveBeenCalledTimes(1);
  });

  it.each(["before-candidate", "before-delivery"] as const)(
    "suppresses a focused current thread %s",
    async (when) => {
      const pending = pendingDecision();
      if (when === "before-candidate") {
        fixture.routeTarget = { kind: "server", threadRef: { environmentId, threadId } };
        vi.mocked(document.hasFocus).mockReturnValue(true);
      }
      mounted = await render(<DesktopNotificationWatcher />);
      await publish(() => {
        fixture.threads = [settledThread()];
      });
      if (when === "before-delivery") {
        expect(fixture.policy).toHaveBeenCalledTimes(1);
        await publish(() => {
          fixture.routeTarget = { kind: "server", threadRef: { environmentId, threadId } };
        });
        vi.mocked(document.hasFocus).mockReturnValue(true);
        setUiLocale("ko");
        await pending.finish();
      } else {
        expect(fixture.policy).not.toHaveBeenCalled();
      }
      expect(fixture.notify).not.toHaveBeenCalled();
    },
  );

  it.each(["before-candidate", "before-delivery"] as const)(
    "honors disabled notifications %s",
    async (when) => {
      const pending = pendingDecision();
      if (when === "before-candidate") fixture.settings = { notificationsEnabled: false };
      mounted = await render(<DesktopNotificationWatcher />);
      await publish(() => {
        fixture.threads = [settledThread()];
      });
      if (when === "before-delivery") {
        expect(fixture.policy).toHaveBeenCalledTimes(1);
        await publish(() => {
          fixture.settings = { notificationsEnabled: false };
        });
        setUiLocale("ja");
        await pending.finish();
      } else {
        expect(fixture.policy).not.toHaveBeenCalled();
      }
      expect(fixture.notify).not.toHaveBeenCalled();
    },
  );

  it("retires the old exact-turn candidate when a later turn is running", async () => {
    const pending = pendingDecision();
    mounted = await render(<DesktopNotificationWatcher />);
    await publish(() => {
      fixture.threads = [settledThread()];
    });
    expect(fixture.policy).toHaveBeenCalledExactlyOnceWith({ threadId, turnId });
    await publish(() => {
      fixture.threads = [runningThread(laterTurnId)];
    });
    setUiLocale("ko");
    await pending.finish();
    expect(fixture.notify).not.toHaveBeenCalled();
    expect(fixture.policy).toHaveBeenCalledTimes(1);
    expect(fixture.router.navigate).not.toHaveBeenCalled();
  });
});
