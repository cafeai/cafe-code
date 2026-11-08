import { act, useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { render } from "vitest-browser-react";
import { ownNotificationFixture } from "./notificationFixture.test.fixture";
import { EnvironmentId, ThreadId, TurnId, type ScopedThreadRef } from "@cafecode/contracts";
import { getUiLocale, setUiLocale, uiText } from "@cafecode/shared/i18n";

type FixtureThread = {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly title: string;
  readonly hasPendingUserInput: boolean;
  readonly session: {
    readonly status: "running" | "ready";
    readonly activeTurnId: TurnId | null;
  };
};

const fixture = vi.hoisted(() => ({
  threads: [] as readonly FixtureThread[],
  settings: { notificationsEnabled: true, userInputNotificationsEnabled: false },
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
  clicks: new Set<(tag: string) => void>(),
}));

function useFixtureSnapshot<A>(read: () => A): A {
  return useSyncExternalStore((listener) => {
    fixture.listeners.add(listener);
    return () => fixture.listeners.delete(listener);
  }, read);
}

// The component runs unchanged against synthetic shell/settings/router inputs.
// Its real scheduled policy helper sees only this in-memory deferred API; the
// native notification bridge is replaced before mount, never OS delivery.
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
let owner: ReturnType<typeof ownNotificationFixture>;

function runningThread(activeTurnId: TurnId = turnId): FixtureThread {
  return {
    environmentId,
    id: threadId,
    title: "Opaque thread 日本語 한국어 /{title}",
    hasPendingUserInput: false,
    session: { status: "running", activeTurnId },
  };
}

function settledThread(): FixtureThread {
  return { ...runningThread(), session: { status: "ready", activeTurnId: null } };
}

async function publish(change: () => void) {
  await owner.run(() =>
    act(async () => {
      change();
      for (const listener of fixture.listeners) listener();
    }),
  );
}

function pendingDecision() {
  let resolve: (result: { readonly notify: boolean }) => void = () => {
    throw new Error("Synthetic decision was not initialized.");
  };
  const promise = new Promise<{ readonly notify: boolean }>((complete) => {
    resolve = complete;
  });
  fixture.policy.mockReturnValueOnce(promise);
  owner.onRetire(() => resolve({ notify: false }));
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

beforeEach((context) => {
  owner = ownNotificationFixture(context);
  setUiLocale("en");
  fixture.threads = [runningThread()];
  fixture.settings = { notificationsEnabled: true, userInputNotificationsEnabled: false };
  fixture.routeTarget = null;
  fixture.listeners.clear();
  fixture.router.navigate.mockReset();
  fixture.policy.mockReset().mockResolvedValue({ notify: true });
  fixture.readApi
    .mockReset()
    .mockReturnValue({ scheduledFollowups: { notification: fixture.policy } });
  fixture.notify.mockReset().mockResolvedValue("sent");
  fixture.notificationListener.mockReset();
  fixture.clicks.clear();
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  vi.stubGlobal("desktopBridge", {
    showNotification: fixture.notify,
    onNotificationClick: (listener: (tag: string) => void) => {
      fixture.notificationListener(listener);
      fixture.clicks.add(listener);
      return () => fixture.clicks.delete(listener);
    },
  });
});

afterEach(async () => {
  await owner.cleanup();
  mounted = undefined;
  expect(fixture.listeners.size).toBe(0);
  expect(fixture.clicks.size).toBe(0);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setUiLocale(originalLocale);
});

describe("desktop completion notification language lifetime", () => {
  it.each(["ja", "ko"] as const)(
    "uses current %s when a delayed exact-turn policy resolves without re-admission",
    async (locale) => {
      const pending = pendingDecision();
      mounted = await owner.mount(<DesktopNotificationWatcher />);
      expect(fixture.policy).not.toHaveBeenCalled();
      await publish(() => {
        fixture.threads = [settledThread()];
      });
      expect(fixture.readApi).toHaveBeenCalledExactlyOnceWith(environmentId);
      expect(fixture.policy).toHaveBeenCalledExactlyOnceWith({ threadId, turnId });
      expect(fixture.notify).not.toHaveBeenCalled();

      setUiLocale(locale);
      await pending.finish();
      expect(fixture.notify).toHaveBeenCalledExactlyOnceWith({
        title: runningThread().title,
        body: uiText("Finished running", undefined, undefined, locale),
        tag: `cafe-code-thread:${environmentId.length}:${environmentId}:${threadId}`,
      });
      expect(fixture.clicks.size).toBe(1);
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
    mounted = await owner.mount(<DesktopNotificationWatcher />);
    await publish(() => {
      fixture.threads = [settledThread()];
    });
    expect(fixture.policy).toHaveBeenCalledTimes(1);
    await mounted.unmount();
    mounted = await owner.mount(<DesktopNotificationWatcher />);
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
      mounted = await owner.mount(<DesktopNotificationWatcher />);
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
      if (when === "before-candidate")
        fixture.settings = { ...fixture.settings, notificationsEnabled: false };
      mounted = await owner.mount(<DesktopNotificationWatcher />);
      await publish(() => {
        fixture.threads = [settledThread()];
      });
      if (when === "before-delivery") {
        expect(fixture.policy).toHaveBeenCalledTimes(1);
        await publish(() => {
          fixture.settings = { ...fixture.settings, notificationsEnabled: false };
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
    mounted = await owner.mount(<DesktopNotificationWatcher />);
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

describe("desktop input notifications", () => {
  it("notifies once with completion disabled and opens the exact chat on click", async () => {
    fixture.settings = { notificationsEnabled: false, userInputNotificationsEnabled: true };
    const pending = pendingDecision();
    mounted = await owner.mount(<DesktopNotificationWatcher />);
    await publish(() => {
      fixture.threads = [{ ...runningThread(), hasPendingUserInput: true }];
    });
    expect(fixture.policy).toHaveBeenCalledExactlyOnceWith({ threadId, turnId });
    setUiLocale("ko");
    await pending.finish();
    expect(fixture.notify).toHaveBeenCalledExactlyOnceWith({
      title: runningThread().title,
      body: uiText("Waiting for your input", undefined, undefined, "ko"),
      tag: `cafe-code-thread:${environmentId.length}:${environmentId}:${threadId}`,
    });
    await publish(() => {
      fixture.threads = [{ ...runningThread(), hasPendingUserInput: true }];
    });
    expect(fixture.notify).toHaveBeenCalledOnce();
    for (const onClick of fixture.clicks) onClick("foreign-tag");
    expect(fixture.router.navigate).not.toHaveBeenCalled();
    for (const onClick of fixture.clicks)
      onClick(`cafe-code-thread:${environmentId.length}:${environmentId}:${threadId}`);
    expect(fixture.router.navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId },
    });
  });

  it("retires a question answered before its policy read finishes", async () => {
    fixture.settings = { notificationsEnabled: false, userInputNotificationsEnabled: true };
    const pending = pendingDecision();
    mounted = await owner.mount(<DesktopNotificationWatcher />);
    await publish(() => {
      fixture.threads = [{ ...runningThread(), hasPendingUserInput: true }];
    });
    expect(fixture.policy).toHaveBeenCalledOnce();
    await publish(() => {
      fixture.threads = [runningThread()];
    });
    await pending.finish();
    expect(fixture.notify).not.toHaveBeenCalled();
  });

  it("honors input opt-out during a pending policy read", async () => {
    fixture.settings = { notificationsEnabled: false, userInputNotificationsEnabled: true };
    const pending = pendingDecision();
    mounted = await owner.mount(<DesktopNotificationWatcher />);
    await publish(() => {
      fixture.threads = [{ ...runningThread(), hasPendingUserInput: true }];
    });
    expect(fixture.policy).toHaveBeenCalledOnce();
    await publish(() => {
      fixture.settings = { ...fixture.settings, userInputNotificationsEnabled: false };
    });
    await pending.finish();
    expect(fixture.notify).not.toHaveBeenCalled();
  });
});
