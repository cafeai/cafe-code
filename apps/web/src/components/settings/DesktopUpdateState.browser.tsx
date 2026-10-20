import type {
  DesktopBridge,
  DesktopSourceUpdateState,
  DesktopUpdateState,
} from "@cafecode/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi, type TestContext } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import {
  desktopUpdateQueryKeys,
  setDesktopUpdateStateQueryData,
  useDesktopUpdateState,
} from "../../lib/desktopUpdateReactQuery";
import {
  desktopSourceUpdateQueryKeys,
  setDesktopSourceUpdateStateQueryData,
  useDesktopSourceUpdateState,
} from "../../lib/desktopSourceUpdateReactQuery";

const releaseIdle: DesktopUpdateState = {
  runtimeKind: "packaged",
  enabled: true,
  status: "idle",
  channel: "latest",
  installMode: "in-app",
  currentVersion: "1.0.0",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};
const releaseAvailable: DesktopUpdateState = {
  ...releaseIdle,
  status: "available",
  availableVersion: "1.1.0",
};
const sourceCurrent: DesktopSourceUpdateState = {
  status: "current",
  branch: "dev",
  trackedBranch: "dev",
  runtimeHash: "aaa",
  localHash: "aaa",
  remoteHash: "aaa",
  mergeBaseHash: "aaa",
  dirty: false,
  checkedAt: null,
  message: null,
};
const sourceBehind: DesktopSourceUpdateState = {
  ...sourceCurrent,
  status: "behind",
  remoteHash: "bbb",
};
type Kind = "release" | "source";
function ReleaseHarness() {
  const state = useDesktopUpdateState().data;
  return <output data-testid="update-status">{state?.status ?? "none"}</output>;
}
function SourceHarness() {
  const state = useDesktopSourceUpdateState().data;
  return <output data-testid="update-status">{state?.status ?? "none"}</output>;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

// These inert methods are the complete native read/event boundary used by the
// two actual hooks. No provider, updater check, download or installer runs.
function fixture(kind: Kind, context: TestContext) {
  const previousBridge = window.desktopBridge;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const release = deferred<DesktopUpdateState>();
  const source = deferred<DesktopSourceUpdateState>();
  const activeRelease = new Set<(state: DesktopUpdateState) => void>();
  const activeSource = new Set<(state: DesktopSourceUpdateState) => void>();
  const oldRelease: Array<(state: DesktopUpdateState) => void> = [];
  const oldSource: Array<(state: DesktopSourceUpdateState) => void> = [];
  const unsubscribe = vi.fn();
  // Supply the full bridge contract without pretending this read/event fixture
  // implements other capabilities. An accidental check, download, installation,
  // settings write or unrelated native call must fail rather than run silently.
  const unexpectedBridgeCall = () => {
    throw new Error("Unexpected native capability in the update-state fixture.");
  };
  const bridge = {
    getAppBranding: unexpectedBridgeCall,
    getLocalEnvironmentBootstrap: unexpectedBridgeCall,
    getDebugEndpointState: unexpectedBridgeCall,
    publishDebugSnapshot: unexpectedBridgeCall,
    getClientSettings: unexpectedBridgeCall,
    setClientSettings: unexpectedBridgeCall,
    setPowerSaveBlockerState: unexpectedBridgeCall,
    getSavedEnvironmentRegistry: unexpectedBridgeCall,
    setSavedEnvironmentRegistry: unexpectedBridgeCall,
    getSavedEnvironmentSecret: unexpectedBridgeCall,
    setSavedEnvironmentSecret: unexpectedBridgeCall,
    removeSavedEnvironmentSecret: unexpectedBridgeCall,
    getServerExposureState: unexpectedBridgeCall,
    setServerExposureMode: unexpectedBridgeCall,
    setServerHttpsEnabled: unexpectedBridgeCall,
    getGlobalDictationSettings: unexpectedBridgeCall,
    setGlobalDictationEnabled: unexpectedBridgeCall,
    setGlobalDictationShortcut: unexpectedBridgeCall,
    onGlobalDictationEvent: unexpectedBridgeCall,
    globalDictationAction: unexpectedBridgeCall,
    claimComposerDictationCapture: unexpectedBridgeCall,
    releaseComposerDictationCapture: unexpectedBridgeCall,
    getAdvertisedEndpoints: unexpectedBridgeCall,
    pickFolder: unexpectedBridgeCall,
    confirm: unexpectedBridgeCall,
    setTheme: unexpectedBridgeCall,
    showContextMenu: unexpectedBridgeCall,
    openExternal: unexpectedBridgeCall,
    openPath: unexpectedBridgeCall,
    revealPath: unexpectedBridgeCall,
    copyText: unexpectedBridgeCall,
    copyPng: unexpectedBridgeCall,
    savePng: unexpectedBridgeCall,
    onMenuAction: unexpectedBridgeCall,
    setUpdateChannel: unexpectedBridgeCall,
    checkForUpdate: unexpectedBridgeCall,
    downloadUpdate: unexpectedBridgeCall,
    installUpdate: unexpectedBridgeCall,
    checkSourceUpdate: unexpectedBridgeCall,
    getUpdateState: vi.fn<DesktopBridge["getUpdateState"]>(() => release.promise),
    getSourceUpdateState: vi.fn<DesktopBridge["getSourceUpdateState"]>(() => source.promise),
    onUpdateState: (listener: (state: DesktopUpdateState) => void) => {
      activeRelease.add(listener);
      oldRelease.push(listener);
      return () => {
        activeRelease.delete(listener);
        unsubscribe();
      };
    },
    onSourceUpdateState: (listener: (state: DesktopSourceUpdateState) => void) => {
      activeSource.add(listener);
      oldSource.push(listener);
      return () => {
        activeSource.delete(listener);
        unsubscribe();
      };
    },
  } satisfies DesktopBridge;
  const replacement = { ...bridge };
  const key =
    kind === "release" ? desktopUpdateQueryKeys.state() : desktopSourceUpdateQueryKeys.state();
  const initial = kind === "release" ? release.promise : source.promise;
  const expected = kind === "release" ? releaseIdle : sourceCurrent;
  const newer = kind === "release" ? releaseAvailable : sourceBehind;
  let retired = false;
  let absentOwned = false;
  let pendingRender: ReturnType<typeof render> | null = null;
  let view: Awaited<ReturnType<typeof render>> | null = null;
  let pendingUnmount: Promise<void> | null = null;
  const unmount = () =>
    (pendingUnmount ??= (async () => {
      const current = view ?? (pendingRender ? await pendingRender.catch(() => null) : null);
      if (current) await current.unmount();
      view = null;
      pendingRender = null;
    })());
  let unsubscribeCache: (() => void) | undefined;
  context.onTestFinished(async () => {
    retired = true;
    unsubscribeCache?.();
    const closed = client
      .getQueryCache()
      .find({ queryKey: key, exact: true })
      ?.promise?.then(
        () => undefined,
        () => undefined,
      );
    await unmount();
    release.resolve(releaseIdle);
    source.resolve(sourceCurrent);
    await Promise.all([closed, release.promise, source.promise]);
    client.clear();
    if (
      window.desktopBridge === bridge ||
      window.desktopBridge === replacement ||
      (absentOwned && window.desktopBridge === undefined)
    ) {
      if (previousBridge) window.desktopBridge = previousBridge;
      else delete window.desktopBridge;
    }
  });
  const publish = () => {
    if (kind === "release") for (const listener of activeRelease) listener(releaseAvailable);
    else for (const listener of activeSource) listener(sourceBehind);
  };
  return {
    client,
    key,
    expected,
    newer,
    initial,
    unsubscribe,
    retired: () => retired,
    read: () => client.getQueryData(key),
    fetchCompletion: () => {
      const pending = client.getQueryCache().find({ queryKey: key, exact: true })?.promise;
      if (!pending) throw new Error("Expected the fixture-owned native read to remain pending.");
      // Query.fetch installed its cache-commit await before this observer. In
      // the pinned TanStack implementation that commit runs before this exact
      // receipt's reaction; no arbitrary timer/microtask drain is substituted.
      return pending.then(
        () => "fulfilled" as const,
        () => "rejected" as const,
      );
    },
    resolve: () => {
      if (kind === "release") release.resolve(releaseIdle);
      else source.resolve(sourceCurrent);
    },
    publish,
    oldPublish: () => {
      if (kind === "release") for (const listener of oldRelease) listener(releaseAvailable);
      else for (const listener of oldSource) listener(sourceBehind);
    },
    publishDirect: () => {
      if (kind === "release") setDesktopUpdateStateQueryData(client, releaseAvailable);
      else setDesktopSourceUpdateStateQueryData(client, sourceBehind);
    },
    replaceBridge: () => {
      window.desktopBridge = replacement;
    },
    onFetch: (callback: () => void) => {
      unsubscribeCache = client.getQueryCache().subscribe((event) => {
        if (event.type === "updated" && event.action.type === "fetch") callback();
      });
    },
    unmount,
    mount: async (withBridge = true) => {
      if (retired) return false;
      if (withBridge) window.desktopBridge = bridge;
      else {
        absentOwned = true;
        delete window.desktopBridge;
      }
      pendingRender = render(
        <QueryClientProvider client={client}>
          {kind === "release" ? <ReleaseHarness /> : <SourceHarness />}
        </QueryClientProvider>,
      );
      view = await pendingRender;
      return !retired;
    },
    ready: () => (kind === "release" ? bridge.getUpdateState : bridge.getSourceUpdateState),
  };
}

it.for(["release", "source"] as const)(
  "accepts the fresh %s initial native state",
  async (kind, context) => {
    const owned = fixture(kind, context);
    if (!(await owned.mount())) return;
    await vi.waitFor(() => {
      expect(owned.ready()).toHaveBeenCalledTimes(1);
    });
    if (owned.retired()) return;
    const completion = owned.fetchCompletion();
    owned.resolve();
    const completed = await completion;
    if (owned.retired()) return;
    expect(completed).toBe("fulfilled");
    await expect
      .element(page.getByTestId("update-status"))
      .toHaveTextContent(owned.expected.status);
    expect(owned.read()).toEqual(owned.expected);
  },
);

it.for(["release", "source"] as const)(
  "keeps a %s event received after initial-read resolution but before cache commit",
  async (kind, context) => {
    const owned = fixture(kind, context);
    if (!(await owned.mount())) return;
    await vi.waitFor(() => {
      expect(owned.ready()).toHaveBeenCalledTimes(1);
    });
    if (owned.retired()) return;
    const emitted = deferred<boolean>();
    const completion = owned.fetchCompletion();
    owned.resolve();
    // The query's await is registered before this one. It returns its cloned
    // result first; this job schedules the event after the retryer resolves but
    // before Query.fetch's pending setData continuation. No clock/poll delay.
    await owned.initial;
    if (owned.retired()) return;
    queueMicrotask(() => {
      if (owned.retired()) {
        emitted.resolve(false);
        return;
      }
      const stillUncommitted = owned.read() === undefined;
      owned.publish();
      emitted.resolve(stillUncommitted);
    });
    const observedBeforeCommit = await emitted.promise;
    if (owned.retired()) return;
    expect(observedBeforeCommit).toBe(true);
    const completed = await completion;
    if (owned.retired()) return;
    expect(completed).toBe("fulfilled");
    await expect.element(page.getByTestId("update-status")).toHaveTextContent(owned.newer.status);
    expect(owned.read()).toEqual(owned.newer);
  },
);

it.for(["release", "source"] as const)(
  "rejects retired %s bridge callbacks and initial replies",
  async (kind, context) => {
    const owned = fixture(kind, context);
    if (!(await owned.mount())) return;
    await vi.waitFor(() => {
      expect(owned.ready()).toHaveBeenCalledTimes(1);
    });
    if (owned.retired()) return;
    const completion = owned.fetchCompletion();
    owned.replaceBridge();
    owned.oldPublish();
    expect(owned.read()).toBeUndefined();
    owned.resolve();
    const completed = await completion;
    if (owned.retired()) return;
    expect(completed).toBe("fulfilled");
    expect(owned.read()).toBeNull();
    await expect.element(page.getByTestId("update-status")).toHaveTextContent("none");
  },
);

it.for(["release", "source"] as const)(
  "does not publish late %s reads or callbacks after the last observer unmounts",
  async (kind, context) => {
    const owned = fixture(kind, context);
    if (!(await owned.mount())) return;
    await vi.waitFor(() => {
      expect(owned.ready()).toHaveBeenCalledTimes(1);
    });
    if (owned.retired()) return;
    const closed = owned.fetchCompletion();
    await owned.unmount();
    if (owned.retired()) return;
    expect(owned.unsubscribe).toHaveBeenCalledTimes(1);
    owned.oldPublish();
    owned.resolve();
    const [completed] = await Promise.all([closed, owned.initial]);
    if (owned.retired()) return;
    expect(completed).toBe("rejected");
    expect(owned.read()).toBeUndefined();
    expect(owned.unsubscribe).toHaveBeenCalledTimes(1);
  },
);

it.for(["release", "source"] as const)(
  "does not let an old no-bridge null erase a newly published %s state",
  async (kind, context) => {
    const owned = fixture(kind, context);
    const emitted = deferred<"fulfilled" | "rejected">();
    owned.onFetch(() =>
      queueMicrotask(() => {
        if (owned.retired()) {
          emitted.resolve("rejected");
          return;
        }
        try {
          const completion = owned.fetchCompletion();
          owned.replaceBridge();
          owned.publishDirect();
          void completion.then(emitted.resolve);
        } catch {
          // A missing owned phase is a finite failure of this exact test, not an
          // unhandled error from a microtask that can outlive its invocation.
          emitted.resolve("rejected");
        }
      }),
    );
    if (!(await owned.mount(false))) return;
    const completed = await emitted.promise;
    if (owned.retired()) return;
    expect(completed).toBe("fulfilled");
    await expect.element(page.getByTestId("update-status")).toHaveTextContent(owned.newer.status);
    expect(owned.read()).toEqual(owned.newer);
    expect(owned.ready()).not.toHaveBeenCalled();
  },
);
