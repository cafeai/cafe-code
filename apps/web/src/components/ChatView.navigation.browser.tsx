// This file owns only its feature journeys; the shared module owns fixture lifecycle.
import {
  registerChatViewBrowserHooks,
  chatViewFixture,
  THREAD_ID,
  THREAD_TITLE,
  SECOND_PROJECT_ID,
  THREAD_KEY,
  UUID_ROUTE_RE,
  ADD_PROJECT_SUBMENU_PLACEHOLDER,
  wsRequests,
  DEFAULT_VIEWPORT,
  WIDE_FOOTER_VIEWPORT,
  createSnapshotForTargetUser,
  threadRefFor,
  composerDraftFor,
  draftIdFromPath,
  draftThreadIdFor,
  serverThreadPath,
  materializePromotedDraftThreadViaDomainEvent,
  startPromotedServerThreadViaDomainEvent,
  promoteDraftThreadViaDomainEvent,
  createDraftOnlySnapshot,
  createProjectlessSnapshot,
  setDraftThreadWithoutWorktree,
  waitForLayout,
  waitForElement,
  waitForURL,
  waitForComposerEditor,
  waitForMenuRadioItemContainingText,
  waitForServerConfigToApply,
  dispatchChatNewShortcut,
  triggerChatNewShortcutUntilPath,
  openCommandPaletteFromTrigger,
  waitForNewThreadShortcutLabel,
  revealProjectThreadAction,
  waitForCommandPaletteShortcutLabel,
  waitForCommandPaletteInput,
  getCommandPaletteLegendEntries,
  dispatchInputKey,
  createDesktopBridgeForChatViewTests,
  mountChatView,
  createSnapshotWithActiveSubagent,
  createSnapshotWithSecondaryProject,
} from "./ChatViewBrowser.shared";
import {
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ProviderInstanceId,
  SourceControlRepositoryError,
  ThreadId,
  WS_METHODS,
} from "@cafecode/contracts";
import { createModelSelection } from "@cafecode/shared/model";
import * as Option from "effect/Option";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { failBrowserWsRpc } from "../../test/wsRpcHarness";
import { useComposerDraftStore } from "../composerDraftStore";
import { isMacPlatform } from "../lib/utils";
import { useTaskAtriumStore } from "./atrium/taskAtriumStore";
import { toastManager } from "./ui/toast";

describe("ChatView full app (navigation)", () => {
  registerChatViewBrowserHooks();

  it("replaces an open subagent detail with Atrium and does not restore it on close", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithActiveSubagent(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          clientSettings: {
            ...nextFixture.serverConfig.clientSettings,
            ambianceAtriumEnabled: true,
          },
        };
      },
    });

    try {
      await page.getByRole("button", { name: /^1 active subagent\. Show task list$/i }).click();
      const subagentRow = page
        .getByRole("region", { name: "Active subagents" })
        .getByRole("button", {
          name: /Browser lifecycle audit, Working\. Verify Atrium navigation\. Open details/i,
        });
      await expect.element(subagentRow).toBeInTheDocument();
      await subagentRow.click();
      await vi.waitFor(() => {
        expect(document.querySelector('[data-subagent-detail-view="true"]')).not.toBeNull();
      });

      useTaskAtriumStore.getState().setOpen(true);
      await vi.waitFor(() => {
        expect(document.querySelector('[data-cafe-task-atrium-overlay="true"]')).not.toBeNull();
        expect(document.querySelector('[data-subagent-detail-view="true"]')).toBeNull();
      });

      useTaskAtriumStore.getState().setOpen(false);
      await vi.waitFor(() => {
        expect(document.querySelector('[data-cafe-task-atrium-overlay="true"]')).toBeNull();
        expect(document.querySelector('[data-subagent-detail-view="true"]')).toBeNull();
      });
    } finally {
      useTaskAtriumStore.getState().setOpen(false);
      await mounted.cleanup();
    }
  });

  it("keeps runtime access in the desktop options menu without a footer mode label", async () => {
    setDraftThreadWithoutWorktree();

    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
    });

    try {
      const footer = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]'),
        "Unable to find composer footer.",
      );
      const optionsButton = await waitForElement(
        () =>
          footer.querySelector<HTMLButtonElement>('button[aria-label="More composer controls"]'),
        "Unable to find the combined composer options button.",
      );
      const footerShowsAccessMode = () =>
        Array.from(footer.querySelectorAll("button")).some((button) =>
          ["Supervised", "Auto-accept edits", "Full access"].includes(
            button.textContent?.trim() ?? "",
          ),
        );

      // The provider fixture intentionally has no option descriptors. Access
      // still needs a fallback options trigger, but the selected access label
      // must not consume permanent footer space.
      expect(optionsButton.textContent?.trim()).toBe("");
      expect(footerShowsAccessMode()).toBe(false);
      optionsButton.click();

      await waitForMenuRadioItemContainingText("Supervised");

      const autoAcceptItem = await waitForMenuRadioItemContainingText("Auto-accept edits");
      await waitForMenuRadioItemContainingText("Full access");

      autoAcceptItem.click();
      await vi.waitFor(() => {
        expect(useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]?.runtimeMode).toBe(
          "auto-accept-edits",
        );
        expect(
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="menu-radio-item"]')).find(
            (item) => item.textContent?.includes("Auto-accept edits"),
          ),
        ).toHaveAttribute("aria-checked", "true");
      });
      expect(footerShowsAccessMode()).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides the archive action when the pointer leaves a thread row", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-archive-hover-test" as MessageId,
        targetText: "archive hover target",
      }),
    });

    try {
      const threadRow = page.getByTestId(`thread-row-${THREAD_ID}`);

      await expect.element(threadRow).toBeInTheDocument();
      const archiveButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(`[data-testid="thread-archive-${THREAD_ID}"]`),
        "Unable to find archive button.",
      );
      // The optional tooltip wrapper is deliberately separate from the
      // shared action cluster; opacity is applied to that common ancestor.
      const archiveAction = archiveButton.closest('[class~="transition-opacity"]');
      expect(
        archiveAction,
        "Archive button should render inside a visibility wrapper.",
      ).not.toBeNull();
      await vi.waitFor(
        () => {
          expect(getComputedStyle(archiveAction!).opacity).toBe("0");
        },
        { timeout: 4_000, interval: 16 },
      );

      await threadRow.hover();
      await vi.waitFor(
        () => {
          expect(getComputedStyle(archiveAction!).opacity).toBe("1");
        },
        { timeout: 4_000, interval: 16 },
      );

      await page.getByTestId("composer-editor").hover();
      await vi.waitFor(
        () => {
          expect(getComputedStyle(archiveAction!).opacity).toBe("0");
        },
        { timeout: 4_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("exposes the full thread title on the sidebar row tooltip", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-thread-tooltip-target" as MessageId,
        targetText: "thread tooltip target",
      }),
    });

    try {
      const threadTitle = page.getByTestId(`thread-title-${THREAD_ID}`);

      await expect.element(threadTitle).toBeInTheDocument();
      await threadTitle.hover();

      await vi.waitFor(
        () => {
          const tooltip = document.querySelector<HTMLElement>('[data-slot="tooltip-popup"]');
          expect(tooltip).not.toBeNull();
          expect(tooltip?.textContent).toContain(THREAD_TITLE);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the confirm archive action after clicking the archive button", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-archive-confirm-test" as MessageId,
        targetText: "archive confirm target",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          clientSettings: {
            ...nextFixture.serverConfig.clientSettings,
            confirmThreadArchive: true,
          },
        };
      },
    });

    try {
      const threadRow = page.getByTestId(`thread-row-${THREAD_ID}`);

      await expect.element(threadRow).toBeInTheDocument();
      await threadRow.hover();

      const archiveButton = page.getByTestId(`thread-archive-${THREAD_ID}`);
      await expect.element(archiveButton).toBeInTheDocument();
      await archiveButton.click();

      const confirmButton = page.getByTestId(`thread-archive-confirm-${THREAD_ID}`);
      await expect.element(confirmButton).toBeInTheDocument();
      await expect.element(confirmButton).toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("canonicalizes promoted draft threads to the server thread route", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-new-thread-test" as MessageId,
        targetText: "new thread selection test",
      }),
    });

    try {
      // Wait for the sidebar to render with the project.
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();

      await revealProjectThreadAction();
      await newThreadButton.click();

      // The route should change to a new draft thread ID.
      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newDraftId = draftIdFromPath(newThreadPath);
      const newThreadId = draftThreadIdFor(newDraftId);

      // The composer editor should be present for the new draft thread.
      await waitForComposerEditor();

      // `thread.created` should only mark the draft as promoting; it should
      // not navigate away until the server thread has actual runtime state.
      await materializePromotedDraftThreadViaDomainEvent(newThreadId);
      expect(mounted.router.state.location.pathname).toBe(newThreadPath);
      await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();

      // Once the server thread starts, the route should canonicalize.
      await startPromotedServerThreadViaDomainEvent(newThreadId);
      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().draftThreadsByThreadKey[newDraftId]).toBe(
            undefined,
          );
        },
        { timeout: 8_000, interval: 16 },
      );

      // The route should switch to the canonical server thread path.
      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(newThreadId),
        "Promoted drafts should canonicalize to the server thread route.",
      );

      // The composer should remain usable after canonicalization, regardless of
      // whether the promoted thread is still visibly empty or has already
      // entered the running state.
      await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("canonicalizes stale promoted draft routes to the server thread route", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-draft-hydration-race-test" as MessageId,
        targetText: "draft hydration race test",
      }),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();

      await revealProjectThreadAction();
      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newDraftId = draftIdFromPath(newThreadPath);
      const newThreadId = draftThreadIdFor(newDraftId);

      await promoteDraftThreadViaDomainEvent(newThreadId);

      await mounted.router.navigate({
        to: "/draft/$draftId",
        params: { draftId: newDraftId },
      });

      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(newThreadId),
        "Stale promoted draft routes should canonicalize to the server thread path.",
      );

      await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a fresh worktree draft from an existing worktree thread when the default mode is worktree", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...createSnapshotForTargetUser({
          targetMessageId: "msg-user-new-thread-worktree-default-test" as MessageId,
          targetText: "new thread worktree default test",
        }),
        threads: createSnapshotForTargetUser({
          targetMessageId: "msg-user-new-thread-worktree-default-test" as MessageId,
          targetText: "new thread worktree default test",
        }).threads.map((thread) =>
          thread.id === THREAD_ID
            ? Object.assign({}, thread, {
                branch: "feature/existing",
                worktreePath: "/repo/.t3/worktrees/existing",
              })
            : thread,
        ),
      },
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          settings: {
            ...nextFixture.serverConfig.settings,
            defaultThreadEnvMode: "worktree",
          },
        };
      },
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();

      await revealProjectThreadAction();
      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should change to a new draft thread.",
      );
      const newDraftId = draftIdFromPath(newThreadPath);

      expect(useComposerDraftStore.getState().getDraftSession(newDraftId)).toMatchObject({
        envMode: "worktree",
        worktreePath: null,
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a new draft instead of reusing a promoting draft thread", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-promoting-draft-new-thread-test" as MessageId,
        targetText: "promoting draft new thread test",
      }),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();

      await revealProjectThreadAction();
      await newThreadButton.click();

      const firstDraftPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should change to the first draft thread.",
      );
      const firstDraftId = draftIdFromPath(firstDraftPath);
      const firstThreadId = draftThreadIdFor(firstDraftId);

      await materializePromotedDraftThreadViaDomainEvent(firstThreadId);
      expect(mounted.router.state.location.pathname).toBe(firstDraftPath);

      await revealProjectThreadAction();
      await newThreadButton.click();

      const secondDraftPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path) && path !== firstDraftPath,
        "Route should change to a second draft thread instead of reusing the promoting draft.",
      );
      expect(draftIdFromPath(secondDraftPath)).not.toBe(firstDraftId);
    } finally {
      await mounted.cleanup();
    }
  });

  it("snapshots sticky codex settings into a new draft thread", async () => {
    useComposerDraftStore.setState({
      stickyModelSelectionByProvider: {
        [ProviderInstanceId.make("codex")]: createModelSelection(
          ProviderInstanceId.make("codex"),
          "gpt-5.3-codex",
          [
            { id: "reasoningEffort", value: "medium" },
            { id: "fastMode", value: true },
          ],
        ),
      },
      stickyActiveProvider: ProviderInstanceId.make("codex"),
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sticky-codex-traits-test" as MessageId,
        targetText: "sticky codex traits test",
      }),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();

      await revealProjectThreadAction();
      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newDraftId = draftIdFromPath(newThreadPath);

      // `toMatchObject` matches objects loosely (extras ignored) but compares
      // arrays strictly, so wrap `options` in `arrayContaining` to keep the
      // assertion focused on sticky `fastMode` carrying over without asserting
      // on exactly which other options are preserved.
      expect(composerDraftFor(newDraftId)).toMatchObject({
        modelSelectionByProvider: {
          codex: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.3-codex",
            options: expect.arrayContaining([{ id: "fastMode", value: true }]),
          },
        },
        activeProvider: "codex",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("hydrates the provider alongside a sticky claude model", async ({
    signal,
    onTestFinished,
    onTestFailed,
  }) => {
    type Step =
      | "mount"
      | "button-ready"
      | "header-ready"
      | "header-hover"
      | "button-click"
      | "route";
    type Phase =
      | `${Step}:${"start" | "complete"}`
      | `mount:${"viewport" | "styles" | "render" | "websocket" | "bootstrap" | "layout"}`
      | "sticky-assert:start"
      | "sticky-assert:complete"
      | "cleanup:start"
      | "cleanup:complete";
    const startedAt = performance.now();
    const phases: { readonly phase: Phase; readonly elapsedMs: number }[] = [];
    let recording = true;
    let retired = false;
    let mounting: ReturnType<typeof mountChatView> | undefined;
    let mountCleanup: (() => Promise<void>) | undefined;
    let cleanupPromise: Promise<void> | undefined;
    const pendingOperations = new Set<Promise<unknown>>();
    const recordPhase = (phase: Phase) => {
      if (!recording || phases.length >= 32) return;
      const elapsed = performance.now() - startedAt;
      phases.push({
        phase,
        elapsedMs: Number.isFinite(elapsed)
          ? Math.min(3_600_000, Math.max(0, Math.round(elapsed)))
          : 0,
      });
    };
    const assertActive = () => {
      if (retired || signal.aborted)
        throw new Error("The exact sticky-Claude navigation fixture was retired.");
    };
    const cleanup = () => {
      // The public signal retires future actions synchronously, even when a
      // native action or mount outlives the test body's unchanged deadline.
      retired = true;
      signal.removeEventListener("abort", onAbort);
      return (cleanupPromise ??= (async () => {
        recordPhase("cleanup:start");
        try {
          try {
            await mounting;
          } catch {
            // The original mount await still owns its failure. Join it here
            // without treating rejected rendering/bootstrap as readiness.
          }
          // Keep this exact fixture's controls alive until already-admitted
          // native operations settle; a later fixture must not satisfy them.
          await Promise.allSettled([...pendingOperations]);
        } finally {
          try {
            await mountCleanup?.();
          } finally {
            recordPhase("cleanup:complete");
            recording = false;
          }
        }
      })());
    };
    const onAbort = () => {
      // The registered finalizer joins and reports this same cleanup promise;
      // the synchronous abort reaction must not create an unhandled tail.
      void cleanup().catch(() => undefined);
    };
    const observe = async <T,>(step: Step, operation: () => PromiseLike<T>): Promise<T> => {
      assertActive();
      recordPhase(`${step}:start`);
      const pending = Promise.resolve(operation());
      pendingOperations.add(pending);
      try {
        const result = await pending;
        assertActive();
        recordPhase(`${step}:complete`);
        return result;
      } finally {
        pendingOperations.delete(pending);
      }
    };
    // Own retirement before the first mount/native await. Failure diagnostics
    // contain only fixed phases and elapsed time, never DOM, URLs or errors.
    onTestFinished(cleanup);
    onTestFailed(() => {
      console.error("Synthetic sticky-Claude navigation phases", { phases });
    });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();

    try {
      assertActive();
      useComposerDraftStore.setState({
        stickyModelSelectionByProvider: {
          [ProviderInstanceId.make("claudeAgent")]: createModelSelection(
            ProviderInstanceId.make("claudeAgent"),
            "claude-opus-4-6",
            [
              { id: "effort", value: "max" },
              { id: "fastMode", value: true },
            ],
          ),
        },
        stickyActiveProvider: ProviderInstanceId.make("claudeAgent"),
      });

      const mounted = await observe(
        "mount",
        () =>
          (mounting = mountChatView({
            viewport: DEFAULT_VIEWPORT,
            snapshot: createSnapshotForTargetUser({
              targetMessageId: "msg-user-sticky-claude-model-test" as MessageId,
              targetText: "sticky claude model test",
            }),
            lifecycle: {
              assertActive,
              retire: cleanup,
              ownCleanup: (cleanupMount) => {
                mountCleanup = cleanupMount;
              },
              observePhase: (phase) => recordPhase(`mount:${phase}`),
            },
          })),
      );

      const newThreadButton = page.getByTestId("new-thread-button");
      await observe("button-ready", () => expect.element(newThreadButton).toBeInTheDocument());

      // Preserve revealProjectThreadAction's exact original assertion and
      // native hover locally so its intermediate await also has this case's
      // retirement fence, without changing the helper's other consumers.
      const hoverButton = page.getByTestId("new-thread-button");
      await observe("header-ready", () => expect.element(hoverButton).toBeInTheDocument());
      const header = hoverButton
        .element()
        .closest('[class~="group/project-header"]')
        ?.querySelector('[data-sidebar="menu-button"]');
      expect(header).not.toBeNull();
      expect(header).not.toBeUndefined();
      await observe("header-hover", () => page.elementLocator(header!).hover());
      await observe("button-click", () => newThreadButton.click());

      const newThreadPath = await observe("route", () =>
        waitForURL(
          mounted.router,
          (path) => UUID_ROUTE_RE.test(path),
          "Route should have changed to a new sticky claude draft thread UUID.",
        ),
      );
      const newDraftId = draftIdFromPath(newThreadPath);

      recordPhase("sticky-assert:start");
      expect(composerDraftFor(newDraftId)).toMatchObject({
        modelSelectionByProvider: {
          claudeAgent: createModelSelection(
            ProviderInstanceId.make("claudeAgent"),
            "claude-opus-4-6",
            [
              { id: "effort", value: "max" },
              { id: "fastMode", value: true },
            ],
          ),
        },
        activeProvider: "claudeAgent",
      });
      recordPhase("sticky-assert:complete");
    } finally {
      await cleanup();
    }
  });

  it("falls back to defaults when no sticky composer settings exist", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-default-codex-traits-test" as MessageId,
        targetText: "default codex traits test",
      }),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();

      await revealProjectThreadAction();
      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newDraftId = draftIdFromPath(newThreadPath);

      expect(composerDraftFor(newDraftId)).toBe(undefined);
    } finally {
      await mounted.cleanup();
    }
  });

  it("prefers draft state over sticky composer settings and defaults", async () => {
    useComposerDraftStore.setState({
      stickyModelSelectionByProvider: {
        [ProviderInstanceId.make("codex")]: createModelSelection(
          ProviderInstanceId.make("codex"),
          "gpt-5.3-codex",
          [
            { id: "reasoningEffort", value: "medium" },
            { id: "fastMode", value: true },
          ],
        ),
      },
      stickyActiveProvider: ProviderInstanceId.make("codex"),
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-draft-codex-traits-precedence-test" as MessageId,
        targetText: "draft codex traits precedence test",
      }),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();

      await revealProjectThreadAction();
      await newThreadButton.click();

      const threadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a sticky draft thread UUID.",
      );
      const draftId = draftIdFromPath(threadPath);

      // See the note on the sibling sticky-codex test: arrays match strictly
      // under `toMatchObject`, so use `arrayContaining` to keep the assertion
      // scoped to the sticky trait (`fastMode`) that must carry over.
      expect(composerDraftFor(draftId)).toMatchObject({
        modelSelectionByProvider: {
          codex: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.3-codex",
            options: expect.arrayContaining([{ id: "fastMode", value: true }]),
          },
        },
        activeProvider: "codex",
      });

      useComposerDraftStore.getState().setModelSelection(
        draftId,
        createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
          { id: "reasoningEffort", value: "low" },
          { id: "fastMode", value: true },
        ]),
      );

      await revealProjectThreadAction();
      await newThreadButton.click();

      await waitForURL(
        mounted.router,
        (path) => path === threadPath,
        "New-thread should reuse the existing project draft thread.",
      );
      expect(composerDraftFor(draftId)).toMatchObject({
        modelSelectionByProvider: {
          codex: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
            { id: "reasoningEffort", value: "low" },
            { id: "fastMode", value: true },
          ]),
        },
        activeProvider: "codex",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a new thread from the global chat.new shortcut", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-chat-shortcut-test" as MessageId,
        targetText: "chat shortcut test",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "chat.new",
              shortcut: {
                key: "o",
                metaKey: false,
                ctrlKey: false,
                shiftKey: true,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "modelPickerOpen" },
              },
            },
            {
              command: "thread.jump.1",
              shortcut: {
                key: "1",
                metaKey: true,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: false,
              },
            },
            {
              command: "modelPicker.jump.1",
              shortcut: {
                key: "1",
                metaKey: true,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: false,
              },
              whenAst: { type: "identifier", name: "modelPickerOpen" },
            },
          ],
        };
      },
    });

    try {
      await waitForNewThreadShortcutLabel();
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      await waitForLayout();
      await triggerChatNewShortcutUntilPath(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID from the shortcut.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a standalone chat from chat.new without project context", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createProjectlessSnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "chat.new",
              shortcut: {
                key: "o",
                metaKey: false,
                ctrlKey: false,
                shiftKey: true,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "modelPickerOpen" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      dispatchChatNewShortcut();
      await vi.waitFor(() => expect(mounted.router.state.location.pathname).toMatch(UUID_ROUTE_RE));
      const draftId = draftIdFromPath(mounted.router.state.location.pathname);
      expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject({
        projectId: null,
        runtimeMode: "full-access",
      });
      expect(Object.keys(useComposerDraftStore.getState().draftThreadsByThreadKey)).toHaveLength(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders the configurable shortcut and runs a command from the sidebar trigger", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-shortcut-test" as MessageId,
        targetText: "command palette shortcut test",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "modelPickerOpen" },
              },
            },
          ],
        };
      },
    });

    try {
      await Promise.all([waitForServerConfigToApply(), waitForCommandPaletteShortcutLabel()]);
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await expect
        .element(palette.getByText("New chat in Project", { exact: true }))
        .toBeInTheDocument();
      await palette.getByText("New chat in Project", { exact: true }).click();

      await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID from the command palette.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("filters command palette results as the user types", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-search-test" as MessageId,
        targetText: "command palette search test",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "modelPickerOpen" },
              },
            },
          ],
        };
      },
    });

    try {
      await Promise.all([waitForServerConfigToApply(), waitForCommandPaletteShortcutLabel()]);
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await page.getByPlaceholder("Search commands, projects and chats…").fill("settings");
      await expect.element(palette.getByText("Open settings", { exact: true })).toBeInTheDocument();
      await expect
        .element(palette.getByText("New chat in Project", { exact: true }))
        .not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("adds a project from browse mode with Enter when no directory is highlighted", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-add-project-enter" as MessageId,
        targetText: "command palette add project enter",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "modelPickerOpen" },
              },
            },
          ],
        };
      },
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          if (body.partialPath === "~/Development/") {
            return {
              parentPath: "~/Development/",
              entries: [
                { name: "alpha", fullPath: "~/Development/alpha" },
                { name: "beta", fullPath: "~/Development/beta" },
              ],
            };
          }

          return {
            parentPath: "~/",
            entries: [{ name: "Development", fullPath: "~/Development" }],
          };
        }

        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: chatViewFixture.fixture.snapshot.snapshotSequence + 1,
          };
        }

        return undefined;
      },
    });

    try {
      await Promise.all([waitForServerConfigToApply(), waitForCommandPaletteShortcutLabel()]);
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await palette.getByText("Add project", { exact: true }).click();
      await palette.getByText("Local folder", { exact: true }).click();

      const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await page.getByPlaceholder(ADD_PROJECT_SUBMENU_PLACEHOLDER).fill("~/Development/");
      await expect.element(palette.getByText("alpha", { exact: true })).toBeInTheDocument();

      await expect
        .element(palette.getByRole("button", { name: "Add (Enter)" }))
        .toBeInTheDocument();

      await dispatchInputKey(browseInput, { key: "Enter" });

      await vi.waitFor(
        () => {
          const dispatchRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "project.create",
          ) as
            | {
                _tag: string;
                type?: string;
                workspaceRoot?: string;
                title?: string;
              }
            | undefined;

          expect(dispatchRequest).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "project.create",
            workspaceRoot: "~/Development",
            title: "Development",
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread after adding a project with Enter.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides unavailable source control providers in the add project source picker", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-add-project-source-filter" as MessageId,
        targetText: "command palette add project source filter",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "modelPickerOpen" },
              },
            },
          ],
        };
      },
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.serverDiscoverSourceControl) {
          return {
            versionControlSystems: [],
            sourceControlProviders: [
              {
                kind: "github",
                label: "GitHub",
                executable: "gh",
                status: "available",
                version: Option.some("gh version 2.0.0"),
                installHint: "Install GitHub CLI.",
                detail: Option.none(),
                auth: {
                  status: "authenticated",
                  account: Option.some("cafe"),
                  host: Option.some("github.com"),
                  detail: Option.none(),
                },
              },
              {
                kind: "gitlab",
                label: "GitLab",
                executable: "glab",
                status: "missing",
                version: Option.none(),
                installHint: "Install GitLab CLI.",
                detail: Option.none(),
                auth: {
                  status: "unknown",
                  account: Option.none(),
                  host: Option.none(),
                  detail: Option.none(),
                },
              },
              {
                kind: "bitbucket",
                label: "Bitbucket",
                executable: "Bitbucket REST API",
                status: "available",
                version: Option.none(),
                installHint: "Set Bitbucket API token environment variables.",
                detail: Option.none(),
                auth: {
                  status: "unauthenticated",
                  account: Option.none(),
                  host: Option.some("bitbucket.org"),
                  detail: Option.some("Bitbucket token is not configured."),
                },
              },
              {
                kind: "azure-devops",
                label: "Azure DevOps",
                executable: "az",
                status: "missing",
                version: Option.none(),
                installHint: "Install Azure CLI.",
                detail: Option.none(),
                auth: {
                  status: "unknown",
                  account: Option.none(),
                  host: Option.none(),
                  detail: Option.none(),
                },
              },
            ],
          };
        }

        return undefined;
      },
    });

    try {
      await Promise.all([waitForServerConfigToApply(), waitForCommandPaletteShortcutLabel()]);
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await palette.getByText("Add project", { exact: true }).click();
      await expect.element(palette.getByText("Local folder", { exact: true })).toBeInTheDocument();
      await expect.element(palette.getByText("Git URL", { exact: true })).toBeInTheDocument();
      await expect
        .element(palette.getByText("GitHub repository", { exact: true }))
        .toBeInTheDocument();
      await expect
        .element(palette.getByText("GitLab repository", { exact: true }))
        .not.toBeInTheDocument();
      await expect
        .element(palette.getByText("Bitbucket repository", { exact: true }))
        .not.toBeInTheDocument();
      await expect
        .element(palette.getByText("Azure DevOps repository", { exact: true }))
        .not.toBeInTheDocument();
      await expect
        .element(palette.getByText("Setup Required", { exact: true }))
        .not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it.each([
    {
      label: "a repository name over HTTPS",
      repositoryInput: "t3-oss/t3-env",
      source: "GitHub repository",
      remoteUrl: "https://github.com/t3-oss/t3-env",
      fails: false,
    },
    {
      label: "an HTTPS repository URL over HTTPS",
      repositoryInput: "https://github.com/t3-oss/t3-env.git",
      source: "GitHub repository",
      remoteUrl: "https://github.com/t3-oss/t3-env",
      fails: false,
    },
    {
      label: "an explicit SSH repository reference over SSH",
      repositoryInput: "git@github.com:t3-oss/t3-env.git",
      source: "GitHub repository",
      remoteUrl: "git@github.com:t3-oss/t3-env.git",
      fails: false,
    },
    {
      label: "a direct SSH clone URL without rewriting it",
      repositoryInput: "ssh://git@github.com/t3-oss/t3-env.git",
      source: "Git URL",
      remoteUrl: "ssh://git@github.com/t3-oss/t3-env.git",
      fails: false,
    },
    {
      label: "an SSH failure with a visible explanation",
      repositoryInput: "git@github.com:t3-oss/t3-env.git",
      source: "GitHub repository",
      remoteUrl: "git@github.com:t3-oss/t3-env.git",
      fails: true,
    },
  ])(
    "clones $label through the add project flow",
    async ({ repositoryInput, source, remoteUrl, fails }) => {
      const failureDetail =
        "SSH host key verification failed. Use an HTTPS clone URL, or verify the server's SSH host key in your terminal before retrying.";
      const addToastSpy = vi.spyOn(toastManager, "add");
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-command-palette-add-project-remote" as MessageId,
          targetText: "command palette add project remote",
        }),
        configureFixture: (nextFixture) => {
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            keybindings: [
              {
                command: "commandPalette.toggle",
                shortcut: {
                  key: "k",
                  metaKey: false,
                  ctrlKey: false,
                  shiftKey: false,
                  altKey: false,
                  modKey: true,
                },
                whenAst: {
                  type: "not",
                  node: { type: "identifier", name: "modelPickerOpen" },
                },
              },
            ],
          };
        },
        resolveRpc: (body) => {
          if (body._tag === WS_METHODS.filesystemBrowse) {
            if (body.partialPath === "~/Development/") {
              return {
                parentPath: "~/Development",
                entries: [],
              };
            }

            return {
              parentPath: "~/",
              entries: [{ name: "Development", fullPath: "~/Development" }],
            };
          }

          if (body._tag === WS_METHODS.sourceControlLookupRepository) {
            return {
              provider: "github",
              nameWithOwner: "t3-oss/t3-env",
              url: "https://github.com/t3-oss/t3-env",
              sshUrl: "git@github.com:t3-oss/t3-env.git",
            };
          }

          if (body._tag === WS_METHODS.sourceControlCloneRepository) {
            if (fails) {
              return failBrowserWsRpc(
                new SourceControlRepositoryError({
                  provider: "github",
                  operation: "cloneRepository",
                  detail: failureDetail,
                }),
              );
            }
            return {
              cwd: body.destinationPath,
              remoteUrl: body.remoteUrl,
              repository: null,
            };
          }

          if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
            return {
              sequence: chatViewFixture.fixture.snapshot.snapshotSequence + 1,
            };
          }

          return undefined;
        },
      });

      try {
        await Promise.all([waitForServerConfigToApply(), waitForCommandPaletteShortcutLabel()]);
        const palette = page.getByTestId("command-palette");
        await openCommandPaletteFromTrigger();

        await expect.element(palette).toBeInTheDocument();
        await palette.getByText("Add project", { exact: true }).click();
        await palette.getByText(source, { exact: true }).click();

        const placeholder =
          source === "Git URL" ? "Enter Git clone URL" : "Enter GitHub repository (owner/repo)";
        const repositoryInputElement = await waitForCommandPaletteInput(placeholder);
        await page.getByPlaceholder(placeholder).fill(repositoryInput);
        await dispatchInputKey(repositoryInputElement, { key: "Enter" });

        await vi.waitFor(
          () => {
            const clonePathInput = document.querySelector<HTMLInputElement>(
              'input[placeholder="Enter path (e.g. ~/projects/my-app)"]',
            );
            expect(clonePathInput?.value).toBe("~/t3-env");
            expect(document.body.textContent).toContain("Repository");
            expect(document.body.textContent).toContain(
              source === "Git URL" ? repositoryInput : "t3-oss/t3-env",
            );
            expect(document.body.textContent).toContain("Select parent folder");
            expect(document.body.textContent).toContain("Clone");
          },
          { timeout: 8_000, interval: 16 },
        );

        await page.getByPlaceholder("Enter path (e.g. ~/projects/my-app)").fill("~/Development/");
        const clonePathInput = await waitForCommandPaletteInput(
          "Enter path (e.g. ~/projects/my-app)",
        );
        await dispatchInputKey(clonePathInput, { key: "Enter" });

        await vi.waitFor(
          () => {
            const cloneRequest = wsRequests.find(
              (request) => request._tag === WS_METHODS.sourceControlCloneRepository,
            ) as { destinationPath?: string; remoteUrl?: string; provider?: string } | undefined;
            expect(cloneRequest).toMatchObject({
              remoteUrl,
              destinationPath: "~/Development/t3-env",
            });
            expect(cloneRequest?.provider).toBe(source === "Git URL" ? undefined : "github");
            expect(
              wsRequests.filter(
                (request) => request._tag === WS_METHODS.sourceControlCloneRepository,
              ),
            ).toHaveLength(1);
          },
          { timeout: 8_000, interval: 16 },
        );
        if (fails) {
          await vi.waitFor(
            () => {
              expect(addToastSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                  title: "Clone failed",
                  description: failureDetail,
                }),
              );
              expect(document.body.textContent).toContain(failureDetail);
              expect(document.body.textContent).not.toContain(
                "Source control repository operation cloneRepository failed",
              );
            },
            { timeout: 8_000, interval: 16 },
          );
          await expect.element(palette).toBeInTheDocument();
        }
      } finally {
        addToastSpy.mockRestore();
        await mounted.cleanup();
      }
    },
  );

  it("opens add project browse mode from the sidebar add button", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sidebar-add-project-trigger" as MessageId,
        targetText: "sidebar add project trigger",
      }),
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          return {
            parentPath: "~/",
            entries: [{ name: "Development", fullPath: "~/Development" }],
          };
        }

        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();

      await page.getByTestId("sidebar-add-project-trigger").click();

      const palette = page.getByTestId("command-palette");
      await expect.element(palette).toBeInTheDocument();
      await palette.getByText("Local folder", { exact: true }).click();

      const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await expect.element(browseInput).toHaveValue("~/");

      await vi.waitFor(
        () => {
          expect(
            wsRequests.some(
              (request) =>
                request._tag === WS_METHODS.filesystemBrowse && request.partialPath === "~/",
            ),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("starts add project browse mode from the configured base directory", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sidebar-add-project-custom-base-dir" as MessageId,
        targetText: "sidebar add project custom base directory",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          settings: {
            ...nextFixture.serverConfig.settings,
            addProjectBaseDirectory: "~/Development",
          },
        };
      },
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          if (body.partialPath === "~/Development/") {
            return {
              parentPath: "~/Development/",
              entries: [{ name: "codething", fullPath: "~/Development/codething" }],
            };
          }

          return {
            parentPath: "~/",
            entries: [{ name: "Development", fullPath: "~/Development" }],
          };
        }

        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();

      await page.getByTestId("sidebar-add-project-trigger").click();

      const palette = page.getByTestId("command-palette");
      await expect.element(palette).toBeInTheDocument();
      await palette.getByText("Local folder", { exact: true }).click();

      const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await expect.element(browseInput).toHaveValue("~/Development/");

      await vi.waitFor(
        () => {
          expect(
            wsRequests.some(
              (request) =>
                request._tag === WS_METHODS.filesystemBrowse &&
                request.partialPath === "~/Development/",
            ),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows create-folder affordances for missing project paths", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-create-missing-project" as MessageId,
        targetText: "command palette create missing project",
      }),
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          if (body.partialPath === "~/Desktop/") {
            return {
              parentPath: "~/Desktop/",
              entries: [{ name: "existing", fullPath: "~/Desktop/existing" }],
            };
          }

          return {
            parentPath: "~/",
            entries: [{ name: "Desktop", fullPath: "~/Desktop" }],
          };
        }

        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: chatViewFixture.fixture.snapshot.snapshotSequence + 1,
          };
        }

        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();
      const palette = page.getByTestId("command-palette");
      await page.getByTestId("sidebar-add-project-trigger").click();

      await expect.element(palette).toBeInTheDocument();
      await palette.getByText("Local folder", { exact: true }).click();
      const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await page.getByPlaceholder(ADD_PROJECT_SUBMENU_PLACEHOLDER).fill("~/Desktop/fresh-project");

      await expect
        .element(palette.getByRole("button", { name: "Create & Add (Enter)" }))
        .toBeInTheDocument();
      await expect.element(palette.getByText("Will create this folder")).not.toBeInTheDocument();

      await dispatchInputKey(browseInput, { key: "Enter" });

      await vi.waitFor(
        () => {
          const dispatchRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "project.create",
          ) as
            | {
                _tag: string;
                type?: string;
                workspaceRoot?: string;
                title?: string;
                createWorkspaceRootIfMissing?: boolean;
              }
            | undefined;

          expect(dispatchRequest).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "project.create",
            workspaceRoot: "~/Desktop/fresh-project",
            title: "fresh-project",
            createWorkspaceRootIfMissing: true,
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not show create affordances for an existing directory with a trailing slash", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-existing-trailing-directory" as MessageId,
        targetText: "command palette existing trailing directory",
      }),
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          if (body.partialPath === "~/Development/codex/") {
            return {
              parentPath: "~/Development/codex/",
              entries: [{ name: "Codex.app", fullPath: "~/Development/codex/Codex.app" }],
            };
          }

          return {
            parentPath: "~/",
            entries: [{ name: "Development", fullPath: "~/Development" }],
          };
        }

        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: chatViewFixture.fixture.snapshot.snapshotSequence + 1,
          };
        }

        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();
      const palette = page.getByTestId("command-palette");
      await page.getByTestId("sidebar-add-project-trigger").click();

      await expect.element(palette).toBeInTheDocument();
      await palette.getByText("Local folder", { exact: true }).click();
      const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await page.getByPlaceholder(ADD_PROJECT_SUBMENU_PLACEHOLDER).fill("~/Development/codex/");

      await vi.waitFor(
        () => {
          expect(
            wsRequests.some(
              (request) =>
                request._tag === WS_METHODS.filesystemBrowse &&
                request.partialPath === "~/Development/codex/",
            ),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );

      await expect
        .element(palette.getByRole("button", { name: "Add (Enter)" }))
        .toBeInTheDocument();
      await expect
        .element(palette.getByRole("button", { name: "Create & Add (Enter)" }))
        .not.toBeInTheDocument();

      await dispatchInputKey(browseInput, { key: "Enter" });

      await vi.waitFor(
        () => {
          const dispatchRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "project.create",
          ) as
            | {
                _tag: string;
                type?: string;
                workspaceRoot?: string;
                title?: string;
              }
            | undefined;

          expect(dispatchRequest).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "project.create",
            workspaceRoot: "~/Development/codex",
            title: "codex",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("picks a local project from the native file manager", async () => {
    const pickFolder = vi.fn().mockResolvedValue("/Users/julius/Projects/finder-picked");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-add-project-file-manager" as MessageId,
        targetText: "command palette add project file manager",
      }),
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          if (body.partialPath === "~/Applications/") {
            return {
              parentPath: "~/Applications/",
              entries: [{ name: "Utilities", fullPath: "~/Applications/Utilities" }],
            };
          }

          return {
            parentPath: "~/",
            entries: [{ name: "Applications", fullPath: "~/Applications" }],
          };
        }

        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: chatViewFixture.fixture.snapshot.snapshotSequence + 1,
          };
        }

        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();
      // The full app also reads bootstrap and other desktop capabilities on
      // rerender. Keep this fixture checked against the complete bridge
      // contract so newly mounted desktop controls cannot call missing methods.
      window.desktopBridge = {
        ...createDesktopBridgeForChatViewTests(),
        pickFolder,
      };

      await page.getByTestId("sidebar-add-project-trigger").click();

      const palette = page.getByTestId("command-palette");
      await expect.element(palette).toBeInTheDocument();
      await palette.getByText("Local folder", { exact: true }).click();
      const browseInput = palette.getByPlaceholder(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await browseInput.fill("~/Applications/access");

      const fileManagerLabel = isMacPlatform(navigator.platform)
        ? "Open in Finder"
        : navigator.platform.toLowerCase().startsWith("win")
          ? "Open in Explorer"
          : "Open in Files";
      await palette.getByRole("button", { name: fileManagerLabel }).click();

      await vi.waitFor(
        () => {
          expect(pickFolder).toHaveBeenCalledWith({ initialPath: "~/Applications" });
        },
        { timeout: 8_000, interval: 16 },
      );

      await vi.waitFor(
        () => {
          const dispatchRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "project.create",
          ) as
            | {
                _tag: string;
                type?: string;
                workspaceRoot?: string;
                title?: string;
              }
            | undefined;

          expect(dispatchRequest).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "project.create",
            workspaceRoot: "/Users/julius/Projects/finder-picked",
            title: "finder-picked",
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread after adding a project from the native file manager.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("adds a project from browse mode with Mod+Enter when a directory is highlighted", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-add-project-mod-enter" as MessageId,
        targetText: "command palette add project mod enter",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "modelPickerOpen" },
              },
            },
          ],
        };
      },
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          if (body.partialPath === "~/Development/") {
            return {
              parentPath: "~/Development/",
              entries: [
                { name: "alpha", fullPath: "~/Development/alpha" },
                { name: "beta", fullPath: "~/Development/beta" },
              ],
            };
          }

          return {
            parentPath: "~/",
            entries: [{ name: "Development", fullPath: "~/Development" }],
          };
        }

        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: chatViewFixture.fixture.snapshot.snapshotSequence + 1,
          };
        }

        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();
      await waitForCommandPaletteShortcutLabel();
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await palette.getByText("Add project", { exact: true }).click();
      await palette.getByText("Local folder", { exact: true }).click();

      const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await page.getByPlaceholder(ADD_PROJECT_SUBMENU_PLACEHOLDER).fill("~/Development/");
      await expect.element(palette.getByText("alpha", { exact: true })).toBeInTheDocument();

      await dispatchInputKey(browseInput, { key: "ArrowDown" });

      const addButtonLabel = isMacPlatform(navigator.platform)
        ? "Add (\u2318 Enter)"
        : "Add (Ctrl Enter)";
      await vi.waitFor(
        () => {
          const legendEntries = getCommandPaletteLegendEntries();
          expect(legendEntries).toContain("Enter Select");
        },
        { timeout: 8_000, interval: 16 },
      );
      await expect
        .element(palette.getByRole("button", { name: addButtonLabel }))
        .toBeInTheDocument();

      await dispatchInputKey(browseInput, {
        key: "Enter",
        metaKey: isMacPlatform(navigator.platform),
        ctrlKey: !isMacPlatform(navigator.platform),
      });

      await vi.waitFor(
        () => {
          const dispatchRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "project.create",
          ) as
            | {
                _tag: string;
                type?: string;
                workspaceRoot?: string;
                title?: string;
              }
            | undefined;

          expect(dispatchRequest).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "project.create",
            workspaceRoot: "~/Development",
            title: "Development",
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread after adding a project with Mod+Enter.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps project-context thread matches available when searching by project name", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithSecondaryProject(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "modelPickerOpen" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      await waitForCommandPaletteShortcutLabel();
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await page.getByPlaceholder("Search commands, projects and chats…").fill("docs");
      await expect.element(palette.getByText("Docs Portal", { exact: true })).toBeInTheDocument();
      await expect
        .element(palette.getByText("Release checklist", { exact: true }))
        .toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("searches projects by path and opens the latest thread for that project", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithSecondaryProject(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          settings: {
            ...nextFixture.serverConfig.settings,
            defaultThreadEnvMode: "worktree",
          },
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "modelPickerOpen" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      await waitForCommandPaletteShortcutLabel();
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await page.getByPlaceholder("Search commands, projects and chats…").fill("clients/docs");
      await expect.element(palette.getByText("Docs Portal", { exact: true })).toBeInTheDocument();
      await expect
        .element(palette.getByText("/repo/clients/docs-portal", { exact: true }))
        .toBeInTheDocument();
      await palette.getByText("Docs Portal", { exact: true }).click();

      const nextPath = await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath("thread-secondary-project" as ThreadId),
        "Route should have changed to the latest thread for the selected project.",
      );
      expect(nextPath).toBe(serverThreadPath("thread-secondary-project" as ThreadId));
      expect(
        useComposerDraftStore
          .getState()
          .getDraftThread(threadRefFor("thread-secondary-project" as ThreadId)),
      ).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a new thread from project search when no active project thread exists", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithSecondaryProject({ includeSecondaryThread: false }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          settings: {
            ...nextFixture.serverConfig.settings,
            defaultThreadEnvMode: "worktree",
          },
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "modelPickerOpen" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      await waitForCommandPaletteShortcutLabel();
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await page.getByPlaceholder("Search commands, projects and chats…").fill("clients/docs");
      await expect.element(palette.getByText("Docs Portal", { exact: true })).toBeInTheDocument();
      await expect
        .element(palette.getByText("/repo/clients/docs-portal", { exact: true }))
        .toBeInTheDocument();
      await palette.getByText("Docs Portal", { exact: true }).click();

      const nextPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID from the project search result.",
      );
      const nextDraftId = draftIdFromPath(nextPath);
      const draftThread = useComposerDraftStore.getState().getDraftSession(nextDraftId);
      expect(draftThread?.projectId).toBe(SECOND_PROJECT_ID);
      expect(draftThread?.envMode).toBe("worktree");
    } finally {
      await mounted.cleanup();
    }
  });

  it("filters archived threads out of command palette search results", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithSecondaryProject(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "modelPickerOpen" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      await waitForCommandPaletteShortcutLabel();
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await page.getByPlaceholder("Search commands, projects and chats…").fill("docs-archive");
      await expect
        .element(palette.getByText("Archived Docs Notes", { exact: true }))
        .not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a fresh draft after the previous draft thread is promoted", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-promoted-draft-shortcut-test" as MessageId,
        targetText: "promoted draft shortcut test",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "chat.new",
              shortcut: {
                key: "o",
                metaKey: false,
                ctrlKey: false,
                shiftKey: true,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "modelPickerOpen" },
              },
            },
          ],
        };
      },
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();
      await waitForServerConfigToApply();
      await revealProjectThreadAction();
      await newThreadButton.click();

      const promotedThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a promoted draft thread UUID.",
      );
      const promotedDraftId = draftIdFromPath(promotedThreadPath);
      const promotedThreadId = draftThreadIdFor(promotedDraftId);

      await promoteDraftThreadViaDomainEvent(promotedThreadId);
      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(promotedThreadId),
        "Promoted drafts should canonicalize to the server thread route before a fresh draft is created.",
      );
      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftThread(promotedDraftId)).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      await waitForLayout();

      const freshThreadPath = await triggerChatNewShortcutUntilPath(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path) && path !== promotedThreadPath,
        "Shortcut should create a fresh draft instead of reusing the promoted thread.",
      );
      expect(freshThreadPath).not.toBe(promotedThreadPath);
    } finally {
      await mounted.cleanup();
    }
  });
});
