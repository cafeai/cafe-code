// This file owns only its feature journeys; the shared module owns fixture lifecycle.
import {
  registerChatViewBrowserHooks,
  chatViewFixture,
  THREAD_ID,
  THREAD_TITLE,
  LOCAL_ENVIRONMENT_ID,
  THREAD_REF,
  rpcHarness,
  wsRequests,
  DEFAULT_VIEWPORT,
  WIDE_FOOTER_VIEWPORT,
  COMPACT_FOOTER_VIEWPORT,
  isoAt,
  createSnapshotForTargetUser,
  serverThreadPath,
  waitForLayout,
  waitForElement,
  waitForComposerEditor,
  mountChatView,
  createSnapshotWithRuntimeTaskProgress,
} from "./ChatViewBrowser.shared";
import { scopeThreadRef } from "@cafecode/client-runtime";
import {
  MessageId,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationReadModel,
  ProviderDriverKind,
  ProviderInstanceId,
  type RuntimeMode,
  ThreadId,
  TurnId,
} from "@cafecode/contracts";
import { createModelSelection } from "@cafecode/shared/model";
import { describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { useComposerDraftStore } from "../composerDraftStore";
import { deskTabKey, hydrateDesk } from "../deskModel";
import { deskStorageKey, useDeskStore } from "../deskStore";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
  readEnvironmentApi,
} from "../environmentApi";
import { applyClientSettingsUpdated, getServerConfig } from "../rpc/serverState";
import { useUiStateStore } from "../uiStateStore";
import { createFollowUpQueuePersistence } from "./chat/followUpQueuePersistence";

describe("ChatView full app (desk)", () => {
  registerChatViewBrowserHooks();

  const secondId = "thread-desk-secondary" as ThreadId;
  const secondRef = scopeThreadRef(LOCAL_ENVIRONMENT_ID, secondId);
  const firstTarget = { kind: "server" as const, threadRef: THREAD_REF };
  const secondTarget = { kind: "server" as const, threadRef: secondRef };
  const firstKey = deskTabKey(firstTarget);
  const secondKey = deskTabKey(secondTarget);
  const withSecondThread = (snapshot: OrchestrationReadModel): OrchestrationReadModel => ({
    ...snapshot,
    threads: [
      ...snapshot.threads,
      { ...snapshot.threads[0]!, id: secondId, title: "Second Desk chat" },
    ],
  });
  const splitChats = async () => {
    const dispatch = useDeskStore.getState().dispatch;
    dispatch({ type: "keepOpen", tabKey: firstKey });
    dispatch({ type: "open", target: secondTarget });
    dispatch({ type: "split", tabKey: secondKey, targetGroupId: "g1", edge: "right" });
    await vi.waitFor(() =>
      expect(document.querySelectorAll('[data-testid="composer-editor"]')).toHaveLength(2),
    );
  };
  it.for([80, 100, 130] as const)(
    "uses sidebar navigation without tabs on narrow web clients at %i percent",
    async (interfaceScalePercent, { signal, onTestFinished }) => {
      let retired = false;
      let mounting: ReturnType<typeof mountChatView> | undefined;
      let mountCleanup: (() => Promise<void>) | undefined;
      let cleanupPromise: Promise<void> | undefined;
      const pendingOperations = new Set<Promise<unknown>>();
      const captured: { sheet: HTMLElement | null } = { sheet: null };
      const assertActive = () => {
        if (retired || signal.aborted)
          throw new Error("The exact mobile Desk navigation fixture was retired.");
      };
      const captureOpenedSheet = (event: PointerEvent) => {
        if (retired || captured.sheet || !event.isTrusted || !(event.target instanceof Node))
          return;
        const sheet = document.querySelector<HTMLElement>(
          '[data-sidebar="sidebar"][data-mobile="true"][data-open]',
        );
        // Capture the actual open sheet from the original thread-selection
        // press, not from a later animation/physical-unmount schedule.
        if (sheet?.contains(event.target)) captured.sheet = sheet;
      };
      const cleanup = () => {
        retired = true;
        signal.removeEventListener("abort", onAbort);
        window.removeEventListener("pointerdown", captureOpenedSheet, true);
        return (cleanupPromise ??= (async () => {
          try {
            try {
              await mounting;
            } catch {
              // The original mount await still rejects the test. This await
              // only joins that same owned promise during retirement.
            }
            // No next fixture may provide replacement matching controls to an
            // already-admitted native operation. Its original caller retains
            // the result/error; this settlement is cleanup, never a pass.
            await Promise.allSettled([...pendingOperations]);
          } finally {
            // The caller's synchronous retirement already fences the shared
            // mount's continuations. Keep its controls alive until admitted
            // native actions settle; destructive disposal before that drain
            // could remove an exact locator's target while it is resolving.
            await mountCleanup?.();
          }
        })());
      };
      const onAbort = () => {
        void cleanup().catch(() => undefined);
      };
      const owned = async <T,>(operation: () => PromiseLike<T>): Promise<T> => {
        assertActive();
        const pending = Promise.resolve(operation());
        pendingOperations.add(pending);
        try {
          const result = await pending;
          assertActive();
          return result;
        } finally {
          pendingOperations.delete(pending);
        }
      };
      // Capture cleanup before the first mount await. The public signal fences
      // late input immediately; the finalizer joins disposal and admitted work.
      onTestFinished(cleanup);
      signal.addEventListener("abort", onAbort, { once: true });
      window.addEventListener("pointerdown", captureOpenedSheet, { capture: true, passive: true });
      if (signal.aborted) onAbort();
      try {
        assertActive();
        localStorage.setItem("cafe-code:theme", interfaceScalePercent === 80 ? "light" : "dark");
        const mounted = await owned(
          () =>
            (mounting = mountChatView({
              viewport: WIDE_FOOTER_VIEWPORT,
              snapshot: withSecondThread(
                createSnapshotForTargetUser({
                  targetMessageId: MessageId.make(`mobile-desk-${interfaceScalePercent}`),
                  targetText: "Mobile navigation fixture",
                }),
              ),
              lifecycle: {
                assertActive,
                retire: cleanup,
                ownCleanup: (cleanupMount) => {
                  mountCleanup = cleanupMount;
                },
                observePhase: assertActive,
              },
              configureFixture: (next) => {
                next.serverConfig = {
                  ...next.serverConfig,
                  clientSettings: { ...next.serverConfig.clientSettings, interfaceScalePercent },
                };
              },
            })),
        );
        await owned(splitChats);
        useDeskStore.getState().dispatch({ type: "sidebarMode", mode: "desk" });
        useComposerDraftStore.getState().setPrompt(secondRef, "Keep my mobile draft");
        const editor = await owned(() =>
          waitForElement(
            () =>
              document.querySelector<HTMLElement>(
                '.desk-pane[data-active="true"] [data-testid="composer-editor"]',
              ),
            "active split composer",
          ),
        );
        const layout = useDeskStore.getState().desk.layout;
        const groups = useDeskStore.getState().desk.groups;
        await owned(() => mounted.setViewport(COMPACT_FOOTER_VIEWPORT));
        await owned(() =>
          vi.waitFor(() => {
            expect(document.querySelectorAll(".desk-pane")).toHaveLength(1);
            expect(document.querySelector(".desk-group-bar")).toBeNull();
            expect(document.querySelector('[role="tablist"]')).toBeNull();
            expect(document.querySelector(".desk-group-switcher")).toBeNull();
            const heading = document.querySelector<HTMLElement>("[data-chat-header-title]")!;
            expect(heading.textContent).toBe("Second Desk chat");
            expect(heading.getBoundingClientRect().width).toBeGreaterThan(50);
            expect(getComputedStyle(heading).clipPath).toBe("none");
          }),
        );
        await owned(() =>
          expect
            .element(page.getByTestId("composer-editor"))
            .toHaveTextContent("Keep my mobile draft"),
        );
        expect(page.getByTestId("composer-editor").element()).toBe(editor);
        expect(useDeskStore.getState().desk.layout).toBe(layout);
        expect(useDeskStore.getState().desk.groups).toBe(groups);
        await owned(() =>
          page.screenshot({
            path: `../../../../.explorations/mobile-tabs/mobile-${interfaceScalePercent}.png`,
          }),
        );

        if (interfaceScalePercent === 100) {
          await owned(() => mounted.setViewport({ ...COMPACT_FOOTER_VIEWPORT, width: 767 }));
          await owned(() =>
            vi.waitFor(() => expect(document.querySelector(".desk-group-bar")).toBeNull()),
          );
          await owned(() => mounted.setViewport({ ...COMPACT_FOOTER_VIEWPORT, width: 768 }));
          await owned(() => expect.element(page.getByRole("tablist")).toBeVisible());
          await owned(() => mounted.setViewport(COMPACT_FOOTER_VIEWPORT));
          await owned(() =>
            vi.waitFor(() => expect(document.querySelector(".desk-group-bar")).toBeNull()),
          );
          expect(page.getByTestId("composer-editor").element()).toBe(editor);
        }

        await owned(() =>
          page.getByRole("button", { name: "Toggle Sidebar", exact: true }).click(),
        );
        await owned(() => page.getByRole("button", { name: THREAD_TITLE, exact: true }).click());
        await owned(() =>
          expect
            .element(page.getByRole("heading", { name: THREAD_TITLE, exact: true }))
            .toBeVisible(),
        );
        const openedSheet = captured.sheet;
        expect(openedSheet).not.toBeNull();
        if (!openedSheet)
          throw new Error("The native thread press had no exact open mobile sheet.");
        const selectedComposer = page.getByTestId("composer-editor");
        // Physical exit-paint retention is not the user-facing close contract.
        // Replace only that DOM-null schedule with actual nonblocking input:
        // one additional native click and one printable character, no replay,
        // forced focus/fill, Enter, submission or changed animation policy.
        await owned(() =>
          vi.waitFor(() => {
            expect(
              document.querySelector('[data-sidebar="sidebar"][data-mobile="true"][data-open]'),
            ).toBeNull();
            expect(
              useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt ?? "",
            ).toBe("");
            expect(selectedComposer.element().textContent).toBe("");
          }),
        );
        const selectedEditor = selectedComposer.element();
        await owned(() => selectedComposer.click());
        await owned(() => expect.element(selectedComposer).toHaveFocus());
        expect(openedSheet.contains(document.activeElement)).toBe(false);
        await owned(() => userEvent.keyboard("x"));
        await owned(() =>
          vi.waitFor(() => {
            expect(selectedComposer.element()).toBe(selectedEditor);
            expect(document.activeElement).toBe(selectedEditor);
            expect(openedSheet.contains(document.activeElement)).toBe(false);
            expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe("x");
            expect(selectedEditor.textContent).toBe("x");
          }),
        );
        expect(useComposerDraftStore.getState().getComposerDraft(secondRef)?.prompt).toBe(
          "Keep my mobile draft",
        );
        expect(document.querySelectorAll(".desk-pane")).toHaveLength(1);

        await owned(() => mounted.setViewport(WIDE_FOOTER_VIEWPORT));
        await owned(() =>
          vi.waitFor(() => {
            expect(document.querySelectorAll(".desk-pane")).toHaveLength(2);
            expect(document.querySelectorAll('[role="tablist"]')).toHaveLength(2);
          }),
        );
        expect(useDeskStore.getState().desk.layout).toBe(layout);
        expect(useDeskStore.getState().desk.groups.g1?.tabs).toEqual([firstKey]);
        expect(useDeskStore.getState().desk.groups.g2?.tabs).toEqual([secondKey]);
        expect(wsRequests.some((body) => body.type === "thread.turn.interrupt")).toBe(false);
      } finally {
        await cleanup();
      }
    },
  );
  it("shows each split chat's title in the top bar when Chat tabs is off", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: withSecondThread(
        createSnapshotForTargetUser({
          targetMessageId: MessageId.make("hidden-desk-tabs"),
          targetText: "Hidden tabs fixture",
        }),
      ),
    });
    try {
      await splitChats();
      const layout = useDeskStore.getState().desk.layout;
      const groups = useDeskStore.getState().desk.groups;
      applyClientSettingsUpdated({
        ...getServerConfig()!.clientSettings,
        showDeskTabs: false,
      });
      await vi.waitFor(() => {
        expect(document.querySelector('[role="tablist"]')).toBeNull();
        const bars = [...document.querySelectorAll<HTMLElement>(".desk-group-bar")];
        expect(bars).toHaveLength(2);
        const headings = bars.map((bar) =>
          bar.querySelector<HTMLElement>("[data-chat-header-title]")!,
        );
        expect(headings.map((heading) => heading.textContent).toSorted()).toEqual(
          [THREAD_TITLE, "Second Desk chat"].toSorted(),
        );
        for (const heading of headings) {
          // Visible text, not the screen-reader-only title used beside tabs.
          expect(heading.getBoundingClientRect().width).toBeGreaterThan(50);
          expect(getComputedStyle(heading).clipPath).toBe("none");
        }
      });
      expect(document.querySelectorAll(".desk-pane")).toHaveLength(2);
      expect(useDeskStore.getState().desk.layout).toBe(layout);
      expect(useDeskStore.getState().desk.groups).toBe(groups);

      applyClientSettingsUpdated({
        ...getServerConfig()!.clientSettings,
        showDeskTabs: true,
      });
      await vi.waitFor(() => expect(document.querySelectorAll('[role="tablist"]')).toHaveLength(2));
    } finally {
      await mounted.cleanup();
    }
  });

  it.each(["project", "standalone"] as const)(
    "previews %s chat rows, keeps them on double-click and retains input when dismissed",
    async (kind) => {
      const initial = createSnapshotForTargetUser({
        targetMessageId: MessageId.make("preview-chat-navigation"),
        targetText: "Preview navigation fixture",
      });
      const snapshot = withSecondThread(initial);
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot:
          kind === "project"
            ? snapshot
            : {
                ...snapshot,
                threads: snapshot.threads.map((thread) => ({ ...thread, projectId: null })),
              },
      });
      try {
        const firstRow = page.getByTestId(`thread-row-${THREAD_ID}`);
        const secondRow = page.getByTestId(`thread-row-${secondId}`);
        // Explicitly keep the first chat before browsing another one.
        await firstRow.dblClick();
        await secondRow.click();
        await vi.waitFor(() =>
          expect(useDeskStore.getState().desk.groups.g1?.previewTabKey).toBe(secondKey),
        );
        const tab = page.getByRole("tab", { name: "Second Desk chat", exact: true });
        await expect.element(tab).toHaveAttribute("data-preview", "true");
        useComposerDraftStore.getState().setPrompt(secondRef, "Keep this unsent preview input");
        await expect
          .element(page.getByTestId("composer-editor"))
          .toHaveTextContent("Keep this unsent preview input");
        await firstRow.click();
        await expect.element(tab).not.toBeInTheDocument();
        expect(useComposerDraftStore.getState().getComposerDraft(secondRef)?.prompt).toBe(
          "Keep this unsent preview input",
        );
        expect(useDeskStore.getState().desk.closed).toEqual([]);
        await secondRow.dblClick();
        await expect.element(tab).toHaveAttribute("data-preview", "false");
        await expect
          .element(page.getByTestId("composer-editor"))
          .toHaveTextContent("Keep this unsent preview input");
        await firstRow.click();
        await expect.element(tab).toBeVisible();
        expect(useDeskStore.getState().desk.groups.g1?.tabs).toEqual([firstKey, secondKey]);
        expect(
          wsRequests.some(
            (request) =>
              request.type === "thread.turn.start" ||
              request.type === "thread.turn.interrupt" ||
              request.type === "thread.archived" ||
              request.type === "thread.deleted",
          ),
        ).toBe(false);
      } finally {
        await mounted.cleanup();
      }
    },
  );
  it.for([
    ["project", "send"],
    ["standalone", "send"],
    ["project", "queue"],
    ["project", "steer"],
  ] as const)(
    "keeps a %s preview immediately when submitting a %s message",
    async ([kind, delivery], { signal, onTestFinished, onTestFailed }) => {
      type Step =
        | "mount"
        | "keep-first-row"
        | "open-second-row"
        | "preview-ready"
        | "prompt-ready"
        | "composer-ready"
        | "submit"
        | "preview-kept"
        | "delivery-observed"
        | "leave-preview"
        | "retained-tab";
      type Phase =
        | `${Step}:${"start" | "complete"}`
        | `mount:${"viewport" | "styles" | "render" | "websocket" | "bootstrap" | "layout"}`
        | "ack-held"
        | "cleanup-start"
        | "cleanup-complete";
      const startedAt = performance.now();
      const phases: { readonly phase: Phase; readonly elapsedMs: number }[] = [];
      let recording = true;
      let retired = false;
      let mounting: ReturnType<typeof mountChatView> | undefined;
      let mountCleanup: (() => Promise<void>) | undefined;
      let cleanupPromise: Promise<void> | undefined;
      const pendingOperations = new Set<Promise<unknown>>();
      let release!: (value: { sequence: number }) => void;
      let ackReleased = false;
      const pending = new Promise<{ sequence: number }>((resolve) => {
        release = resolve;
      });
      const recordPhase = (phase: Phase) => {
        if (recording && phases.length < 32)
          phases.push({ phase, elapsedMs: Math.round(performance.now() - startedAt) });
      };
      const assertActive = () => {
        if (retired || signal.aborted)
          throw new Error("The exact preview-submit fixture was retired.");
      };
      const cleanup = () => {
        // Vitest aborts this exact public signal synchronously on a hard
        // timeout. Fence continuation before any cleanup await or later input.
        retired = true;
        signal.removeEventListener("abort", onAbort);
        return (cleanupPromise ??= (async () => {
          recordPhase("cleanup-start");
          // Retire continuation admission above, then release only this case's
          // held response before joining work which may need that response.
          // Receipt of the RPC is not completion of its original native click:
          // keep the exact mounted controls alive until that action settles.
          if (!ackReleased) {
            ackReleased = true;
            release({ sequence: 2 });
          }
          try {
            try {
              await mounting;
            } catch {
              // The body retains its original mount/retirement failure. Join
              // that owned promise without replacing the original assertion.
            }
            // An already-admitted native locator action must settle before a
            // later test can supply matching controls. Join only this case's
            // original promises, under their unchanged native/assertion budgets.
            await Promise.allSettled([...pendingOperations]);
          } finally {
            try {
              // The caller's synchronous retirement fences mount continuations.
              // Destructive unmount must follow the native-action drain, not
              // remove an exact locator target while it is still resolving.
              // This also clears only this mount's resolver before another case.
              await mountCleanup?.();
            } finally {
              recordPhase("cleanup-complete");
              recording = false;
            }
          }
        })());
      };
      const onAbort = () => {
        // The registered finalizer joins this same promise and reports cleanup
        // failures; this reaction alone must not create an unhandled rejection.
        void cleanup().catch(() => undefined);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      onTestFinished(cleanup);
      onTestFailed(() => {
        console.error("Synthetic preview-submit phases", { kind, delivery, phases });
      });
      const observe = async <T,>(step: Step, operation: () => PromiseLike<T>): Promise<T> => {
        assertActive();
        recordPhase(`${step}:start`);
        const owned = Promise.resolve(operation());
        pendingOperations.add(owned);
        try {
          const result = await owned;
          assertActive();
          recordPhase(`${step}:complete`);
          return result;
        } finally {
          pendingOperations.delete(owned);
        }
      };
      const base = withSecondThread(
        createSnapshotForTargetUser({
          targetMessageId: MessageId.make("preview-send"),
          targetText: "Preview send fixture",
        }),
      );
      const activeTurnId = TurnId.make("preview-send-active-turn");
      const snapshot = {
        ...base,
        threads: base.threads.map((thread) => ({
          ...thread,
          ...(kind === "standalone" ? { projectId: null } : {}),
          ...(thread.id === secondId && delivery !== "send"
            ? {
                latestTurn: {
                  turnId: activeTurnId,
                  state: "running" as const,
                  requestedAt: isoAt(1000),
                  startedAt: isoAt(1001),
                  completedAt: null,
                  assistantMessageId: null,
                },
                session: { ...thread.session!, status: "running" as const, activeTurnId },
              }
            : {}),
        })),
      };
      const prompt = `Keep this ${delivery} tab`;
      try {
        await observe(
          "mount",
          () =>
            (mounting = mountChatView({
              viewport: DEFAULT_VIEWPORT,
              snapshot,
              lifecycle: {
                assertActive,
                retire: cleanup,
                ownCleanup: (ownedCleanup) => {
                  mountCleanup = ownedCleanup;
                },
                observePhase: (phase) => recordPhase(`mount:${phase}`),
              },
              configureFixture: (next) => {
                next.serverConfig = {
                  ...next.serverConfig,
                  ...(delivery === "steer"
                    ? {
                        keybindings: [
                          {
                            command: "composer.steer",
                            shortcut: {
                              key: "enter",
                              modKey: false,
                              ctrlKey: true,
                              metaKey: false,
                              altKey: false,
                              shiftKey: false,
                            },
                          },
                        ],
                      }
                    : {}),
                  providers: next.serverConfig.providers.map((provider) => ({
                    ...provider,
                    runtimeCapabilities: {
                      liveSteer: delivery === "steer" ? "supported" : "unsupported",
                      threadGoals: "unsupported",
                    },
                  })),
                };
              },
              resolveRpc: (body) => {
                if (body._tag !== ORCHESTRATION_WS_METHODS.dispatchCommand) return undefined;
                if (
                  body.threadId === secondId &&
                  (body.type === "thread.turn.start" || body.type === "thread.turn.steer")
                ) {
                  if (!retired) recordPhase("ack-held");
                  return pending;
                }
                return { sequence: 2 };
              },
            })),
        );
        const firstRow = page.getByTestId(`thread-row-${THREAD_ID}`);
        await observe("keep-first-row", () => firstRow.dblClick());
        await observe("open-second-row", () => page.getByTestId(`thread-row-${secondId}`).click());
        // Running tabs include their status in the accessible name.
        const tab = page.getByRole("tab", { name: /Second Desk chat$/ });
        await observe("preview-ready", () =>
          expect.element(tab).toHaveAttribute("data-preview", "true"),
        );
        assertActive();
        useComposerDraftStore.getState().setPrompt(secondRef, prompt);
        await observe("prompt-ready", () =>
          expect.element(page.getByTestId("composer-editor")).toHaveTextContent(prompt),
        );
        if (delivery === "steer") {
          const editor = await observe("composer-ready", waitForComposerEditor);
          assertActive();
          editor.focus();
          await observe("submit", () => userEvent.keyboard("{Control>}{Enter}{/Control}"));
        } else if (delivery === "queue") {
          await observe("submit", () =>
            page.getByRole("button", { name: "Queue message", exact: true }).click(),
          );
        } else {
          await observe("submit", () =>
            page.getByRole("button", { name: "Send message", exact: true }).click(),
          );
        }
        await observe("preview-kept", () =>
          expect.element(tab).toHaveAttribute("data-preview", "false"),
        );
        assertActive();
        expect(getComputedStyle(tab.element().querySelector(".desk-tab-title")!).fontStyle).toBe(
          "normal",
        );
        // The source request remains unacknowledged, but the tab is already
        // durable and selecting a different chat must no longer dismiss it.
        const restored = hydrateDesk(
          window.localStorage.getItem(deskStorageKey(LOCAL_ENVIRONMENT_ID)),
          LOCAL_ENVIRONMENT_ID,
        );
        expect(restored.groups.g1?.tabs).toContain(secondKey);
        expect(restored.groups.g1?.previewTabKey).toBeUndefined();
        if (delivery === "queue") {
          await observe("delivery-observed", () =>
            vi.waitFor(() =>
              expect(
                document.querySelector('[data-cafe-followup-queue="true"]')?.textContent,
              ).toContain(prompt),
            ),
          );
        } else {
          await observe("delivery-observed", () =>
            vi.waitFor(() =>
              expect(
                wsRequests.some(
                  (body) =>
                    body.threadId === secondId &&
                    body.type ===
                      (delivery === "steer" ? "thread.turn.steer" : "thread.turn.start"),
                ),
              ).toBe(true),
            ),
          );
        }
        await observe("leave-preview", () => firstRow.click());
        await observe("retained-tab", () => expect.element(tab).toBeVisible());
        assertActive();
        expect(useDeskStore.getState().desk.groups.g1?.tabs).toEqual([firstKey, secondKey]);
        expect(wsRequests.some((body) => body.type === "thread.turn.interrupt")).toBe(false);
      } finally {
        await cleanup();
      }
    },
  );

  it("keeps typing and control-only commands temporary until a message is sent", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withSecondThread(
        createSnapshotForTargetUser({
          targetMessageId: MessageId.make("preview-mode-only"),
          targetText: "Preview mode fixture",
        }),
      ),
    });
    try {
      await page.getByTestId(`thread-row-${THREAD_ID}`).dblClick();
      await page.getByTestId(`thread-row-${secondId}`).click();
      const tab = page.getByRole("tab", { name: "Second Desk chat", exact: true });
      useComposerDraftStore.getState().setPrompt(secondRef, "/plan");
      await expect.element(page.getByTestId("composer-editor")).toHaveTextContent("/plan");
      await expect.element(tab).toHaveAttribute("data-preview", "true");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await vi.waitFor(() =>
        expect(useComposerDraftStore.getState().getComposerDraft(secondRef)?.interactionMode).toBe(
          "plan",
        ),
      );
      await expect.element(tab).toHaveAttribute("data-preview", "true");
      expect(
        wsRequests.some(
          (body) => body.type === "thread.turn.start" || body.type === "thread.turn.steer",
        ),
      ).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });

  it.each(["project", "standalone"] as const)(
    "keeps single-clicked %s chats open when the default behavior is Open",
    async (kind) => {
      const snapshot = withSecondThread(
        createSnapshotForTargetUser({
          targetMessageId: MessageId.make("open-click-navigation"),
          targetText: "Open navigation fixture",
        }),
      );
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot:
          kind === "project"
            ? snapshot
            : {
                ...snapshot,
                threads: snapshot.threads.map((thread) => ({ ...thread, projectId: null })),
              },
        configureFixture: (next) => {
          next.serverConfig = {
            ...next.serverConfig,
            clientSettings: {
              ...next.serverConfig.clientSettings,
              chatClickBehavior: "open",
            },
          };
        },
      });
      try {
        await page.getByTestId(`thread-row-${secondId}`).click();
        await expect
          .element(page.getByRole("tab", { name: "Second Desk chat", exact: true }))
          .toHaveAttribute("data-preview", "false");
        await page.getByTestId(`thread-row-${THREAD_ID}`).click();
        await expect
          .element(page.getByRole("tab", { name: "Second Desk chat", exact: true }))
          .toBeVisible();
        expect(useDeskStore.getState().desk.groups.g1?.tabs).toEqual([firstKey, secondKey]);
        expect(useDeskStore.getState().desk.groups.g1?.previewTabKey).toBeUndefined();
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it.each(["project", "standalone"] as const)(
    "applies Open to the already selected %s preview on the next click",
    async (kind) => {
      const initial = createSnapshotForTargetUser({
        targetMessageId: MessageId.make("updated-click-navigation"),
        targetText: "Updated click preference fixture",
      });
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot:
          kind === "project"
            ? initial
            : {
                ...initial,
                threads: initial.threads.map((thread) => ({ ...thread, projectId: null })),
              },
      });
      try {
        await expect.element(page.getByRole("tab")).toHaveAttribute("data-preview", "true");
        applyClientSettingsUpdated({
          ...getServerConfig()!.clientSettings,
          chatClickBehavior: "open",
        });
        await page.getByTestId(`thread-row-${THREAD_ID}`).click();
        await expect.element(page.getByRole("tab")).toHaveAttribute("data-preview", "false");
        expect(useDeskStore.getState().desk.groups.g1?.tabs).toEqual([firstKey]);
      } finally {
        await mounted.cleanup();
      }
    },
  );

  const seedDeskQueue = async (runtimeMode: RuntimeMode = "full-access") => {
    const queue = createFollowUpQueuePersistence();
    expect(
      (
        await queue.save(LOCAL_ENVIRONMENT_ID, [
          {
            id: "desk-single-queue",
            environmentId: LOCAL_ENVIRONMENT_ID,
            threadId: THREAD_ID,
            promptText: "Run this once",
            images: [],
            files: [],
            provider: ProviderDriverKind.make("codex"),
            model: "gpt-5",
            promptEffort: null,
            modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5"),
            runtimeMode,
            interactionMode: "default",
            queuedAt: isoAt(1000),
            blockedReason: null,
          },
        ])
      ).ok,
    ).toBe(true);
    useDeskStore.getState().bindEnvironment(LOCAL_ENVIRONMENT_ID);
    const dispatch = useDeskStore.getState().dispatch;
    dispatch({ type: "open", target: firstTarget });
    dispatch({ type: "open", target: secondTarget });
    dispatch({ type: "split", tabKey: secondKey, targetGroupId: "g1", edge: "right" });
    return queue;
  };

  it.each(["stopped", "running", "missing account", "wrong account"] as const)(
    "hides selected Claude fork actions for a %s source session",
    async (state) => {
      const initial = createSnapshotForTargetUser({
        targetMessageId: MessageId.make("desk-unavailable-fork-source"),
        targetText: "Unavailable fork source",
        provider: "claudeAgent",
      });
      const snapshot: OrchestrationReadModel = {
        ...initial,
        threads: initial.threads.map((source) => ({
          ...source,
          session: {
            ...source.session!,
            status: state === "running" || state === "stopped" ? state : "ready",
            ...(state === "missing account"
              ? {}
              : {
                  providerInstanceId: ProviderInstanceId.make(
                    state === "wrong account" ? "other-claude" : "claudeAgent",
                  ),
                }),
          },
          latestTurn: {
            turnId: "desk-unavailable-fork-completed" as TurnId,
            state: "completed",
            requestedAt: isoAt(1),
            startedAt: isoAt(2),
            completedAt: isoAt(130),
            assistantMessageId: source.messages.at(-1)!.id,
          },
        })),
      };
      const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
      try {
        await waitForComposerEditor();
        await expect
          .element(page.getByRole("button", { name: "Fork from this message", exact: true }))
          .not.toBeInTheDocument();
        expect(wsRequests.filter((request) => request.type === "thread.fork")).toHaveLength(0);
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("does not let a late message-fork acknowledgement navigate an inactive mounted pane", async () => {
    const initial = createSnapshotForTargetUser({
      targetMessageId: MessageId.make("desk-fork-source"),
      targetText: "Fork source",
      provider: "claudeAgent",
    });
    const snapshot = withSecondThread({
      ...initial,
      threads: initial.threads.map((thread) => ({
        ...thread,
        session: {
          ...thread.session!,
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        },
        latestTurn: {
          turnId: "desk-fork-completed" as TurnId,
          state: "completed" as const,
          requestedAt: isoAt(1),
          startedAt: isoAt(2),
          completedAt: isoAt(130),
          assistantMessageId: thread.messages.at(-1)!.id,
        },
      })),
    });
    let release!: (value: { sequence: number }) => void;
    const pending = new Promise<{ sequence: number }>((resolve) => {
      release = resolve;
    });
    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 1800 },
      snapshot,
      resolveRpc: (body) =>
        body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand
          ? body.type === "thread.fork"
            ? pending
            : { sequence: 2 }
          : undefined,
    });
    const forks = () => wsRequests.filter((request) => request.type === "thread.fork");
    const api = readEnvironmentApi(LOCAL_ENVIRONMENT_ID)!;
    const dispatchCommand = api.orchestration.dispatchCommand;
    let forkAcknowledged = false;
    const dispatchSpy = vi
      .spyOn(api.orchestration, "dispatchCommand")
      .mockImplementation(async (command) => {
        const result = await dispatchCommand(command);
        if (command.type === "thread.fork") forkAcknowledged = true;
        return result;
      });
    // Observe completion of the actual wire call, not just release of the
    // server fixture promise, before asserting that navigation stayed put.
    __setEnvironmentApiOverrideForTests(LOCAL_ENVIRONMENT_ID, api);
    try {
      await splitChats();
      useDeskStore.getState().dispatch({ type: "select", tabKey: firstKey });
      const sourcePane = page.getByRole("region", { name: "Main chat group", exact: true });
      const sourceEditor = sourcePane.getByTestId("composer-editor").element();
      // Initial follow-tail layout can replace the last mounted row between
      // reading a live `.last()` locator and clicking it. Select one known
      // fixture message instead so the request identity assertion checks the
      // same message that the browser was actually asked to fork.
      const selectedMessageId = initial.threads[0]!.messages.at(-1)!.id;
      const action = sourcePane
        .getByTimelineMessageId(selectedMessageId)
        .getByRole("button", { name: "Fork from this message", exact: true });
      await sourcePane.getByTimelineMessageId(selectedMessageId).hover();
      await expect.element(action).toBeVisible();
      expect(action.element().closest("[data-message-id]")?.getAttribute("data-message-id")).toBe(
        selectedMessageId,
      );
      await action.click();
      const confirm = page.getByRole("button", { name: "Create fork", exact: true });
      await expect.element(confirm).toBeEnabled();
      await confirm.click();
      await vi.waitFor(() => expect(forks()).toHaveLength(1));
      expect(forks()[0]).toMatchObject({
        sourceThreadId: THREAD_ID,
        sourceMessageId: selectedMessageId,
      });
      // External navigation can activate another group while the modal is
      // pending; the source ChatView remains mounted in the split layout.
      useDeskStore.getState().dispatch({ type: "select", tabKey: secondKey });
      await vi.waitFor(() =>
        expect(mounted.router.state.location.pathname).toBe(serverThreadPath(secondId)),
      );
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
      expect(sourceEditor.isConnected).toBe(true);
      // Returning to the same mounted source must not reset its in-flight
      // guard just because the foreground-only confirmation was remounted.
      useDeskStore.getState().dispatch({ type: "select", tabKey: firstKey });
      await vi.waitFor(() =>
        expect(mounted.router.state.location.pathname).toBe(serverThreadPath(THREAD_ID)),
      );
      await expect
        .element(page.getByRole("button", { name: "Create fork", exact: true }))
        .toBeDisabled();
      await expect
        .element(page.getByRole("button", { name: "Cancel", exact: true }))
        .toBeDisabled();
      expect(forks()).toHaveLength(1);
      useDeskStore.getState().dispatch({ type: "select", tabKey: secondKey });
      await vi.waitFor(() =>
        expect(mounted.router.state.location.pathname).toBe(serverThreadPath(secondId)),
      );
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
      const ownerBeforeAck = useDeskStore.getState().desk.activeGroupId;
      release({ sequence: 2 });
      await vi.waitFor(() => expect(forkAcknowledged).toBe(true));
      await waitForLayout();
      await waitForLayout();
      expect(mounted.router.state.location.pathname).toBe(serverThreadPath(secondId));
      expect(useDeskStore.getState().desk.activeGroupId).toBe(ownerBeforeAck);
      expect(sourceEditor.isConnected).toBe(true);
      expect(forks()).toHaveLength(1);
    } finally {
      release({ sequence: 2 });
      dispatchSpy.mockRestore();
      await mounted.cleanup();
      __resetEnvironmentApiOverridesForTests();
    }
  });

  it("retains pending fork admission after closing and reopening the source pane", async () => {
    const initial = createSnapshotForTargetUser({
      targetMessageId: MessageId.make("desk-reopened-fork-source"),
      targetText: "Reopened fork source",
      provider: "claudeAgent",
    });
    const snapshot = withSecondThread({
      ...initial,
      threads: initial.threads.map((thread) => ({
        ...thread,
        session: {
          ...thread.session!,
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        },
        latestTurn: {
          turnId: "desk-reopened-fork-completed" as TurnId,
          state: "completed" as const,
          requestedAt: isoAt(1),
          startedAt: isoAt(2),
          completedAt: isoAt(130),
          assistantMessageId: thread.messages.at(-1)!.id,
        },
      })),
    });
    let release!: (value: { sequence: number }) => void;
    const pending = new Promise<{ sequence: number }>((resolve) => {
      release = resolve;
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
      resolveRpc: (body) =>
        body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand
          ? body.type === "thread.fork"
            ? pending
            : { sequence: 2 }
          : undefined,
    });
    const api = readEnvironmentApi(LOCAL_ENVIRONMENT_ID)!;
    const dispatchCommand = api.orchestration.dispatchCommand;
    let acknowledged = false;
    const dispatchSpy = vi
      .spyOn(api.orchestration, "dispatchCommand")
      .mockImplementation(async (command) => {
        const result = await dispatchCommand(command);
        if (command.type === "thread.fork") acknowledged = true;
        return result;
      });
    __setEnvironmentApiOverrideForTests(LOCAL_ENVIRONMENT_ID, api);
    const forks = () => wsRequests.filter((request) => request.type === "thread.fork");
    try {
      useDeskStore.getState().dispatch({ type: "keepOpen", tabKey: firstKey });
      useDeskStore.getState().dispatch({ type: "open", target: secondTarget });
      useDeskStore.getState().dispatch({ type: "select", tabKey: firstKey });
      const originalEditor = await waitForComposerEditor();
      await page
        .getByRole("button", { name: "Fork from this message", exact: true })
        .last()
        .click();
      await page.getByRole("button", { name: "Create fork", exact: true }).click();
      await vi.waitFor(() => expect(forks()).toHaveLength(1));
      useDeskStore.getState().dispatch({ type: "close", tabKey: firstKey });
      await vi.waitFor(() => expect(originalEditor.isConnected).toBe(false));
      await vi.waitFor(() =>
        expect(mounted.router.state.location.pathname).toBe(serverThreadPath(secondId)),
      );
      useDeskStore.getState().dispatch({ type: "open", target: firstTarget });
      await vi.waitFor(() =>
        expect(mounted.router.state.location.pathname).toBe(serverThreadPath(THREAD_ID)),
      );
      const reopenedEditor = await waitForComposerEditor();
      expect(reopenedEditor).not.toBe(originalEditor);
      await expect
        .element(page.getByRole("button", { name: "Fork from this message", exact: true }))
        .not.toBeInTheDocument();
      await waitForLayout();
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
      expect(forks()).toHaveLength(1);
      release({ sequence: 2 });
      await vi.waitFor(() => expect(acknowledged).toBe(true));
      await waitForLayout();
      expect(mounted.router.state.location.pathname).toBe(serverThreadPath(THREAD_ID));
      expect(reopenedEditor.isConnected).toBe(true);
      expect(forks()).toHaveLength(1);
    } finally {
      release({ sequence: 2 });
      dispatchSpy.mockRestore();
      await mounted.cleanup();
      __resetEnvironmentApiOverridesForTests();
    }
  });

  it("restores a detached timeline review position after selecting another tab", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withSecondThread(
        createSnapshotForTargetUser({
          targetMessageId: MessageId.make("desk-review"),
          targetText: "Desk review fixture",
        }),
      ),
    });
    try {
      useDeskStore.getState().dispatch({ type: "keepOpen", tabKey: firstKey });
      const scroller = await waitForElement(
        () =>
          document
            .querySelector<HTMLElement>('[data-timeline-root="true"]')
            ?.closest<HTMLElement>(".overscroll-y-contain") ?? null,
        "Timeline scroller missing",
      );
      await vi.waitFor(() => expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight));
      await vi.waitFor(() => expect(scroller.scrollTop).toBeGreaterThan(1000));
      await waitForLayout();
      // Synthetic wheel events have no native scrolling default action, so
      // deliver the physical movement in the same gesture. Yielding frames
      // between them can let ChatView correctly settle the unmoved wheel as
      // a no-op at the tail, leaving the later programmatic scroll without
      // any user review intent under a busy browser's frame scheduling.
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -600, bubbles: true }));
      scroller.scrollTop = 300;
      scroller.dispatchEvent(new Event("scroll"));
      await waitForLayout();
      await vi.waitFor(() => expect(document.body.textContent).toContain("Scroll to bottom"));
      const reviewOffset = scroller.scrollTop;
      expect(reviewOffset).toBeLessThan(scroller.scrollHeight - scroller.clientHeight - 100);
      const scrollControl = page.getByRole("button", { name: "Scroll to bottom", exact: true });
      await scrollControl.hover();
      const hideScrollControl = page.getByRole("button", {
        name: "Hide until bottom",
        exact: true,
      });
      await expect.element(hideScrollControl).toBeVisible();
      await hideScrollControl.click();
      await expect.element(scrollControl).not.toBeInTheDocument();
      expect(scroller.scrollTop).toBe(reviewOffset);
      useDeskStore.getState().dispatch({ type: "open", target: secondTarget });
      await vi.waitFor(() => expect(scroller.isConnected).toBe(false));
      const secondScroller = document
        .querySelector<HTMLElement>('[data-timeline-root="true"]')!
        .closest<HTMLElement>(".overscroll-y-contain")!;
      useDeskStore.getState().dispatch({ type: "select", tabKey: firstKey });
      await vi.waitFor(() => expect(secondScroller.isConnected).toBe(false));
      const restored = await waitForElement(
        () =>
          document
            .querySelector<HTMLElement>('[data-timeline-root="true"]')
            ?.closest<HTMLElement>(".overscroll-y-contain") ?? null,
        "Restored timeline missing",
      );
      await vi.waitFor(() => expect(Math.abs(restored.scrollTop - reviewOffset)).toBeLessThan(100));
      expect(restored.scrollTop).toBeLessThan(restored.scrollHeight - restored.clientHeight - 100);
      await expect.element(scrollControl).not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("preserves a reopened chat's newer draft when its previous direct steer ACK arrives", async () => {
    const base = createSnapshotForTargetUser({
      targetMessageId: MessageId.make("desk-ack"),
      targetText: "Desk ACK fixture",
      sessionStatus: "running",
    });
    const activeTurnId = "desk-ack-turn" as TurnId;
    const snapshot = withSecondThread({
      ...base,
      threads: base.threads.map((thread) => ({
        ...thread,
        latestTurn: {
          turnId: activeTurnId,
          state: "running" as const,
          requestedAt: isoAt(1000),
          startedAt: isoAt(1001),
          completedAt: null,
          assistantMessageId: null,
        },
        session: { ...thread.session!, status: "running" as const, activeTurnId },
      })),
    });
    let release!: (value: { sequence: number }) => void;
    const pending = new Promise<{ sequence: number }>((resolve) => {
      release = resolve;
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
      configureFixture: (next) => {
        next.serverConfig = {
          ...next.serverConfig,
          keybindings: [
            {
              command: "composer.steer",
              shortcut: {
                key: "enter",
                modKey: false,
                ctrlKey: true,
                metaKey: false,
                altKey: false,
                shiftKey: false,
              },
            },
          ],
          providers: next.serverConfig.providers.map((provider) => ({
            ...provider,
            runtimeCapabilities: { liveSteer: "supported", threadGoals: "unsupported" },
          })),
        };
      },
      resolveRpc: (body) =>
        body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand
          ? body.type === "thread.turn.steer"
            ? pending
            : { sequence: 2 }
          : undefined,
    });
    const steers = () => wsRequests.filter((request) => request.type === "thread.turn.steer");
    try {
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Older steer A");
      await waitForLayout();
      const oldEditor = await waitForComposerEditor();
      oldEditor.focus();
      await userEvent.keyboard("{Control>}{Enter}{/Control}");
      await vi.waitFor(() => expect(steers()).toHaveLength(1));
      useDeskStore.getState().dispatch({ type: "open", target: secondTarget });
      await vi.waitFor(() => expect(oldEditor.isConnected).toBe(false));
      useDeskStore.getState().dispatch({ type: "select", tabKey: firstKey });
      await vi.waitFor(() =>
        expect(document.querySelector('[data-testid="composer-editor"]')).not.toBe(oldEditor),
      );
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Newer draft B");
      await waitForLayout();
      (await waitForComposerEditor()).focus();
      await userEvent.keyboard("{Control>}{Enter}{/Control}");
      expect(steers()).toHaveLength(1);
      release({ sequence: 2 });
      await waitForLayout();
      await vi.waitFor(() =>
        expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(
          "Newer draft B",
        ),
      );
      expect(steers()).toHaveLength(1);
    } finally {
      release({ sequence: 2 });
      await mounted.cleanup();
    }
  });

  it("dispatches a saved follow-up only once with two real chat panes mounted", async () => {
    const snapshot = withSecondThread(
      createSnapshotForTargetUser({
        targetMessageId: MessageId.make("desk-queue"),
        targetText: "Desk queue fixture",
      }),
    );
    let release!: (value: { sequence: number }) => void;
    const pending = new Promise<{ sequence: number }>((resolve) => {
      release = resolve;
    });
    await seedDeskQueue();
    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 1800 },
      snapshot,
      resolveRpc: (body) =>
        body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand
          ? body.type === "thread.turn.start"
            ? pending
            : { sequence: 2 }
          : undefined,
    });
    try {
      await vi.waitFor(() =>
        expect(document.querySelectorAll('[data-testid="composer-editor"]')).toHaveLength(2),
      );
      await vi.waitFor(
        () =>
          expect(wsRequests.filter((request) => request.type === "thread.turn.start")).toHaveLength(
            1,
          ),
        { timeout: 8000 },
      );
      useDeskStore.getState().dispatch({ type: "close", tabKey: firstKey });
      await waitForLayout();
      useDeskStore.getState().dispatch({ type: "open", target: firstTarget });
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Do not race pending queue");
      await waitForLayout();
      document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.click();
      await waitForLayout();
      expect(wsRequests.filter((request) => request.type === "thread.turn.start")).toHaveLength(1);
    } finally {
      release({ sequence: 2 });
      await mounted.cleanup();
    }
  });

  it("keeps queued input unclaimed when Stop arrives during deferred preparation", async () => {
    const snapshot = withSecondThread(
      createSnapshotForTargetUser({
        targetMessageId: MessageId.make("desk-stop"),
        targetText: "Desk Stop fixture",
        runtimeMode: "full-access",
      }),
    );
    const queue = await seedDeskQueue("approval-required");
    let release!: (value: { sequence: number }) => void;
    const pending = new Promise<{ sequence: number }>((resolve) => {
      release = resolve;
    });
    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 1800 },
      snapshot,
      resolveRpc: (body) =>
        body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand
          ? body.type === "thread.runtime-mode.set"
            ? pending
            : { sequence: 2 }
          : undefined,
    });
    try {
      await vi.waitFor(() =>
        expect(wsRequests.some((request) => request.type === "thread.runtime-mode.set")).toBe(true),
      );
      // A provider projection can catch up during settings preparation.
      // Exercise the genuine Stop control once that active turn is visible,
      // while the older queued-start continuation is still awaiting its ACK.
      const thread = chatViewFixture.fixture.snapshot.threads[0]!;
      const turnId = "desk-stop-live-turn" as TurnId;
      rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
        kind: "snapshot",
        snapshot: {
          snapshotSequence: 20,
          thread: {
            ...thread,
            latestTurn: {
              turnId,
              state: "running",
              requestedAt: isoAt(2000),
              startedAt: isoAt(2001),
              completedAt: null,
              assistantMessageId: null,
            },
            session: {
              ...thread.session!,
              status: "running",
              activeTurnId: turnId,
              updatedAt: isoAt(2001),
            },
          },
        },
      });
      const stop = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            '[aria-label="Main chat group"] button[aria-label="Stop generation"]',
          ),
        "Queued preparation must expose Stop",
      );
      stop.click();
      await vi.waitFor(() =>
        expect(wsRequests.some((request) => request.type === "thread.turn.interrupt")).toBe(true),
      );
      release({ sequence: 2 });
      await vi.waitFor(() => expect(document.body.textContent).toContain("Stopped before sending"));
      expect(wsRequests.some((request) => request.type === "thread.turn.start")).toBe(false);
      const persisted = queue.load(LOCAL_ENVIRONMENT_ID);
      expect(persisted.ok).toBe(true);
      if (persisted.ok) {
        expect(persisted.value.pending).toHaveLength(1);
        expect(persisted.value.pending[0]?.blockedReason).not.toBeNull();
        expect(persisted.value.claimed).toHaveLength(0);
      }
    } finally {
      release({ sequence: 2 });
      await mounted.cleanup();
    }
  });

  it("pins the original context and task rail independently in each real pane", async () => {
    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 2100 },
      snapshot: withSecondThread(
        createSnapshotWithRuntimeTaskProgress({ withContextWindow: true }),
      ),
    });
    try {
      await splitChats();
      const group = () => document.querySelector<HTMLElement>('[aria-label="Main chat group"]')!;
      const trigger = group().querySelector<HTMLButtonElement>(
        'button[aria-label^="Task progress:"]',
      );
      expect(trigger).not.toBeNull();
      trigger!.click();
      await page.getByRole("button", { name: "Show on the side" }).click();
      await vi.waitFor(() =>
        expect(group().querySelector('[data-session-rail="true"]')).not.toBeNull(),
      );
      expect(useUiStateStore.getState().sessionRailDocked).toBe(false);
      expect(useDeskStore.getState().desk.groups.g1?.sessionRailDocked).toBe(true);
      expect(document.querySelectorAll('button[aria-label^="Context window"]')).toHaveLength(1);
      await page.getByRole("button", { name: "Show in composer" }).click();
      await vi.waitFor(() =>
        expect(document.querySelectorAll('button[aria-label^="Context window"]')).toHaveLength(2),
      );
    } finally {
      await mounted.cleanup();
    }
  });
});
