// This file owns only its feature journeys; the shared module owns fixture lifecycle.
import {
  registerChatViewBrowserHooks,
  chatViewFixture,
  THREAD_ID,
  PROJECT_ID,
  LOCAL_ENVIRONMENT_ID,
  THREAD_REF,
  THREAD_KEY,
  PROJECT_DRAFT_KEY,
  PROJECT_LOGICAL_KEY,
  NOW_ISO,
  type TestFixture,
  rpcHarness,
  wsRequests,
  DEFAULT_VIEWPORT,
  WIDE_FOOTER_VIEWPORT,
  COMPACT_FOOTER_VIEWPORT,
  isoAt,
  createUserMessage,
  createAssistantMessage,
  createSnapshotForTargetUser,
  addThreadToSnapshot,
  draftIdFromPath,
  serverThreadPath,
  createDraftOnlySnapshot,
  withProjectScripts,
  setDraftThreadWithoutWorktree,
  RUNTIME_TASK_DESCRIPTIONS,
  SUBAGENT_RUNTIME_ID,
  worker,
  waitForLayout,
  editButton,
  buttonWithText,
  queuedSendButtons,
  waitForElement,
  waitForURL,
  waitForComposerEditor,
  pressComposerKey,
  pressComposerUndo,
  waitForComposerText,
  setComposerSelectionByTextOffsets,
  selectAllComposerContent,
  forceOnScreenKeyboardMediaQuery,
  waitForSendButton,
  findSendFailureToastTitle,
  findComposerTaskProgressTrigger,
  findComposerTaskProgressPopup,
  findComposerTaskProgressList,
  findComposerTaskProgressScroller,
  findSessionRail,
  expectEmptyScheduledSessionRailTasks,
  findButtonByText,
  waitForButtonByText,
  waitForMenuRadioItemContainingText,
  expectComposerInteractionMode,
  waitForServerConfigToApply,
  createDesktopBridgeForChatViewTests,
  mountChatView,
  createSnapshotWithRuntimeTaskProgress,
  createSnapshotWithActiveSubagent,
  createSnapshotWithCrossTurnActiveSubagent,
  createSnapshotWithPlanFollowUpPrompt,
} from "./ChatViewBrowser.shared";
import { scopeThreadRef } from "@cafecode/client-runtime";
import {
  CommandId,
  type DesktopSourceUpdateState,
  EventId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  type OrchestrationReadModel,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  WS_METHODS,
} from "@cafecode/contracts";
import {
  CLAUDE_RESPONSE_LIMIT_MESSAGE,
  CLAUDE_SHORTER_CONTINUATION_PROMPT,
} from "@cafecode/shared/claudeResponseLimits";
import { createModelCapabilities, createModelSelection } from "@cafecode/shared/model";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { failBrowserWsRpc } from "../../test/wsRpcHarness";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { useDeskStore } from "../deskStore";
import { __setEnvironmentApiOverrideForTests, readEnvironmentApi } from "../environmentApi";
import { selectThreadByRef, useStore } from "../store";
import { useUiStateStore } from "../uiStateStore";
import { useTaskAtriumStore } from "./atrium/taskAtriumStore";
import { createChatViewCallerOwner } from "./chatViewCallerOwner.test.fixture";
import { createFollowUpQueuePersistence } from "./chat/followUpQueuePersistence";
import { toastManager } from "./ui/toast";

describe("ChatView full app (composer)", () => {
  registerChatViewBrowserHooks();

  const createCodexRecoverySnapshot = (uncertain = false): OrchestrationReadModel => {
    const base = createSnapshotWithActiveSubagent();
    const failedAt = new Date().toISOString();
    return {
      ...base,
      threads: base.threads.map((thread) =>
        thread.id !== THREAD_ID
          ? thread
          : {
              ...thread,
              latestTurn: { ...thread.latestTurn!, state: "error", completedAt: failedAt },
              session: {
                ...thread.session!,
                status: "ready",
                activeTurnId: null,
                providerInstanceId: ProviderInstanceId.make("codex"),
                lastError: "Synthetic transient root failure",
                updatedAt: failedAt,
              },
              activities: [
                // Unknown ACK evidence must keep an explicit Stop path even
                // without any observed child. It is not a running-task fact
                // and cannot authorize an automatic resend or countdown.
                ...(uncertain ? [] : thread.activities),
                {
                  id: EventId.make("browser-codex-recovery-waiting"),
                  kind: "runtime.warning",
                  tone: "info",
                  summary: "Recovery waiting",
                  turnId: thread.latestTurn!.turnId,
                  createdAt: failedAt,
                  payload: {
                    recovery: uncertain
                      ? "codex-transient-recovery-uncertain"
                      : "codex-transient-recovery-waiting",
                    providerInstanceId: "codex",
                    subagentRuntimeId: SUBAGENT_RUNTIME_ID,
                    sessionUpdatedAt: failedAt,
                    ...(uncertain
                      ? {}
                      : {
                          retryAttempt: 3,
                          continuationOrdinal: 37,
                          stage: "backoff",
                          retryAt: new Date(Date.parse(failedAt) + 60_000).toISOString(),
                        }),
                  },
                },
              ],
            },
      ),
    };
  };
  it.each(["light", "dark"] as const)(
    "uses only a compact notice for exact pending recovery without dismissing failures in %s mode",
    async (theme) => {
      localStorage.setItem("cafe-code:theme", theme);
      const base = createCodexRecoverySnapshot();
      const source = base.threads[0]!;
      const failure = source.session!.lastError!;
      const snapshot: OrchestrationReadModel = {
        ...base,
        threads: [
          {
            ...source,
            activities: [
              {
                id: EventId.make("pending-recovery-root-error"),
                kind: "runtime.error",
                tone: "error",
                summary: "Runtime error",
                turnId: source.latestTurn!.turnId,
                payload: { message: failure },
                createdAt: source.session!.updatedAt,
              },
              ...source.activities,
            ],
          },
        ],
      };
      const toastSpy = vi.spyOn(toastManager, "add");
      const mounted = await mountChatView({
        viewport: WIDE_FOOTER_VIEWPORT,
        snapshot,
        resolveRpc: (body) =>
          body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
          body.type === "thread.turn.start"
            ? failBrowserWsRpc(
                new OrchestrationDispatchCommandError({ message: "Manual send rejected" }),
              )
            : undefined,
      });
      const errorBanner = () =>
        Array.from(document.querySelectorAll<HTMLElement>('[data-slot="alert"]')).find((element) =>
          element.textContent?.includes(failure),
        ) ?? null;
      const publish = (recovery: string, ownerPatch: Record<string, unknown> = {}) => {
        const previous = chatViewFixture.fixture.snapshot.threads[0]!;
        const sequence = chatViewFixture.fixture.snapshot.snapshotSequence + 1;
        const marker = source.activities.at(-1)!;
        const thread = {
          ...previous,
          activities: [
            ...previous.activities,
            {
              ...marker,
              id: EventId.make(`notification-${sequence}`),
              sequence,
              payload: { ...(marker.payload as object), recovery, ...ownerPatch },
            },
          ],
        };
        chatViewFixture.fixture.snapshot = {
          ...chatViewFixture.fixture.snapshot,
          snapshotSequence: sequence,
          threads: [thread],
        };
        rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
          kind: "snapshot",
          snapshot: { snapshotSequence: sequence, thread },
        });
        return `notification-${sequence}`;
      };
      try {
        await waitForComposerEditor();
        await vi.waitFor(() => {
          expect(
            document.querySelector('[data-codex-recovery-notice="true"]')?.textContent,
          ).toContain("Reconnecting");
          expect(errorBanner()).toBeNull();
          expect(
            [...document.querySelectorAll("[data-work-log]")]
              .map((node) => node.textContent)
              .join(" "),
          ).toContain("Provider error");
        });
        expect(toastSpy.mock.calls.some(([options]) => options.description === failure)).toBe(
          false,
        );
        expect(selectThreadByRef(useStore.getState(), THREAD_REF)?.error).toBe(failure);
        expect(selectThreadByRef(useStore.getState(), THREAD_REF)?.latestTurn).toEqual(
          source.latestTurn,
        );

        // A foreign marker must not retire the current owner's compact wait.
        publish("codex-transient-recovery-uncertain", { providerInstanceId: "foreign-account" });
        await waitForLayout();
        expect(errorBanner()).toBeNull();

        // Uncertain, cancelled and terminal recovery preserve the canonical
        // failure, but never restore its private prose as a popup.
        for (const recovery of [
          "codex-transient-recovery-uncertain",
          "codex-transient-recovery-cancelled",
          "codex-transient-root-failed",
        ]) {
          const markerId = publish(recovery);
          await vi.waitFor(() => {
            // Absence alone is immediate now. Bind each assertion to its
            // actual received snapshot before advancing to the next one.
            expect(
              selectThreadByRef(useStore.getState(), THREAD_REF)?.activities.some(
                (activity) => activity.id === markerId,
              ),
            ).toBe(true);
            expect(errorBanner()).toBeNull();
          });
          expect(selectThreadByRef(useStore.getState(), THREAD_REF)?.error).toBe(failure);
          const waitingMarkerId = publish("codex-transient-recovery-waiting");
          await vi.waitFor(() => {
            expect(
              selectThreadByRef(useStore.getState(), THREAD_REF)?.activities.some(
                (activity) => activity.id === waitingMarkerId,
              ),
            ).toBe(true);
            expect(errorBanner()).toBeNull();
          });
        }

        // A rejected new manual send remains a separate, visible occurrence
        // even while the failed provider root still has a pending recovery.
        useComposerDraftStore.getState().setPrompt(THREAD_REF, "A new manual direction");
        (await waitForSendButton()).click();
        await vi.waitFor(() => {
          expect(findSendFailureToastTitle()).not.toBeNull();
          expect(selectThreadByRef(useStore.getState(), THREAD_REF)?.error).toBe(
            "Failed to send message.",
          );
          expect(selectThreadByRef(useStore.getState(), THREAD_REF)?.errorOrigin).toBe("local");
          expect(document.querySelector('button[aria-label="Dismiss error"]')).not.toBeNull();
        });
        expect(
          selectThreadByRef(useStore.getState(), THREAD_REF)?.activities.some(
            (activity) => activity.id === "pending-recovery-root-error",
          ),
        ).toBe(true);
      } finally {
        toastSpy.mockRestore();
        await mounted.cleanup();
      }
    },
  );
  it.each([false, true])(
    "keeps terminal-root recovery Stop independent from input with rail docked=%s",
    async (docked) => {
      const snapshot = createCodexRecoverySnapshot();
      const mounted = await mountChatView({
        viewport: WIDE_FOOTER_VIEWPORT,
        snapshot,
        resolveRpc: (body) =>
          body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand
            ? { sequence: snapshot.snapshotSequence + 1 }
            : undefined,
      });
      try {
        await waitForComposerEditor();
        if (docked) {
          await page.getByRole("button", { name: /^1 active subagent\. Show task list$/i }).click();
          await page.getByRole("button", { name: "Show on the side", exact: true }).click();
        }
        useComposerDraftStore.getState().setPrompt(THREAD_REF, "Keep this unsent instruction");
        const stop = page.getByRole("button", {
          name: "Stop recovery and running agents",
          exact: true,
        });
        await expect.element(stop).toBeVisible();
        const notice = document.querySelector<HTMLElement>('[data-codex-recovery-notice="true"]')!;
        expect(document.querySelectorAll('[data-codex-recovery-notice="true"]')).toHaveLength(1);
        expect(notice.textContent).toContain("Reconnecting");
        expect(notice.textContent).toContain("1 agent active");
        expect(notice.textContent).toMatch(/Retry #37 in \d+s/u);
        if (docked) expect(findSessionRail()?.contains(notice)).toBe(true);
        await stop.click();
        await vi.waitFor(() => {
          const actions = wsRequests.filter(
            (request) => request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand,
          );
          expect(actions.filter((action) => action.type === "thread.session.stop")).toHaveLength(1);
          expect(
            actions.some(
              (action) =>
                action.type === "thread.turn.start" || action.type === "thread.turn.interrupt",
            ),
          ).toBe(false);
        });
        expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(
          "Keep this unsent instruction",
        );
        expect(selectThreadByRef(useStore.getState(), THREAD_REF)?.latestTurn).toEqual(
          snapshot.threads[0]!.latestTurn,
        );
      } finally {
        await mounted.cleanup();
      }
    },
  );
  it("allows a new manual turn while terminal-root recovery is waiting", async () => {
    const snapshot = createCodexRecoverySnapshot();
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot,
      resolveRpc: (body) =>
        body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand
          ? { sequence: snapshot.snapshotSequence + 1 }
          : undefined,
    });
    try {
      await waitForComposerEditor();
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Change direction instead");
      await expect
        .element(
          page.getByRole("button", { name: "Stop recovery and running agents", exact: true }),
        )
        .toBeVisible();
      const send = await waitForSendButton();
      expect(send.disabled).toBe(false);
      send.click();
      await vi.waitFor(() => {
        const turn = wsRequests.find(
          (request) =>
            request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            request.type === "thread.turn.start",
        );
        expect(turn?.message).toMatchObject({ text: "Change direction instead" });
        expect(wsRequests.some((request) => request.type === "thread.session.stop")).toBe(false);
      });
    } finally {
      await mounted.cleanup();
    }
  });
  it("keeps unknown continuation ACK stoppable without claiming an active task or retry", async () => {
    const snapshot = createCodexRecoverySnapshot(true);
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot,
      resolveRpc: (body) =>
        body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand
          ? { sequence: snapshot.snapshotSequence + 1 }
          : undefined,
    });
    try {
      await waitForComposerEditor();
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Keep this unsubmitted prompt");
      const stop = page.getByRole("button", {
        name: "Stop recovery and running agents",
        exact: true,
      });
      await expect.element(stop).toBeVisible();
      const notice = document.querySelector<HTMLElement>('[data-codex-recovery-notice="true"]')!;
      expect(notice.textContent).toContain("Needs reconciliation");
      expect(notice.textContent).not.toMatch(/Retry in|agent active|agents active/u);
      await stop.click();
      await vi.waitFor(() => {
        const actions = wsRequests.filter(
          (request) => request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand,
        );
        expect(actions.filter((action) => action.type === "thread.session.stop")).toHaveLength(1);
        expect(actions.some((action) => action.type === "thread.turn.start")).toBe(false);
      });
      expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(
        "Keep this unsubmitted prompt",
      );
      expect(selectThreadByRef(useStore.getState(), THREAD_REF)?.latestTurn).toEqual(
        snapshot.threads[0]!.latestTurn,
      );
    } finally {
      await mounted.cleanup();
    }
  });
  const responseLimitSelection = createModelSelection(
    ProviderInstanceId.make("claudeAgent"),
    "claude-opus-4-8",
    [{ id: "effort", value: "max" }],
  );
  const createResponseLimitSnapshot = (
    history: "full" | "essential" = "full",
  ): OrchestrationReadModel => {
    const base = createSnapshotForTargetUser({
      targetMessageId: MessageId.make("response-limit-request"),
      targetText: "Existing work",
      history,
      provider: "claudeAgent",
      runtimeMode: "approval-required",
      sessionStatus: "error",
    });
    return {
      ...base,
      threads: base.threads.map((thread) => ({
        ...thread,
        modelSelection: responseLimitSelection,
        latestTurn: {
          turnId: "response-limit-failed-turn" as TurnId,
          state: "error" as const,
          requestedAt: isoAt(1),
          startedAt: isoAt(2),
          completedAt: isoAt(3200),
          assistantMessageId: null,
        },
        session: {
          ...thread.session!,
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          subagentRuntimeId: "c5278b1d-70a1-4b9f-9741-0ed1d8dbe9f2",
          lastError: CLAUDE_RESPONSE_LIMIT_MESSAGE,
          updatedAt: isoAt(3200),
        },
      })),
    };
  };
  const configureResponseLimitFixture = (nextFixture: TestFixture) => {
    nextFixture.serverConfig = {
      ...nextFixture.serverConfig,
      providers: [
        ...nextFixture.serverConfig.providers,
        {
          driver: ProviderDriverKind.make("claudeAgent"),
          instanceId: ProviderInstanceId.make("claudeAgent"),
          enabled: true,
          installed: true,
          version: "2.1.288",
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: NOW_ISO,
          models: [
            {
              slug: responseLimitSelection.model,
              name: "Claude Opus 4.8",
              isCustom: false,
              capabilities: createModelCapabilities({
                optionDescriptors: [
                  {
                    id: "effort",
                    label: "Effort",
                    type: "select",
                    currentValue: "high",
                    options: [
                      { id: "high", label: "High", isDefault: true },
                      { id: "max", label: "Max" },
                    ],
                  },
                ],
              }),
            },
          ],
          slashCommands: [],
          skills: [],
        },
      ],
    };
  };

  const readResponseLimitCaretText = (editor: HTMLElement) => {
    const selection = editor.ownerDocument.getSelection();
    expect(editor.isConnected).toBe(true);
    expect(editor.ownerDocument.activeElement).toBe(editor);
    expect(selection?.rangeCount).toBe(1);
    const range = selection!.getRangeAt(0);
    expect(range.collapsed).toBe(true);
    expect(editor.contains(range.startContainer)).toBe(true);
    expect(editor.contains(range.endContainer)).toBe(true);

    // Cloning and adjusting these detached ranges only reads the native
    // caret's extent. Never rewrite the live Selection to manufacture the
    // preparation readiness that the ordinary replacement needs to observe.
    const beforeCaret = range.cloneRange();
    beforeCaret.selectNodeContents(editor);
    beforeCaret.setEnd(range.endContainer, range.endOffset);
    const afterCaret = range.cloneRange();
    afterCaret.selectNodeContents(editor);
    afterCaret.setStart(range.endContainer, range.endOffset);
    return { beforeCaret: beforeCaret.toString(), afterCaret: afterCaret.toString() };
  };

  const assertResponseLimitComposerReady = (editor: HTMLElement) => {
    expect(
      useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt ?? "",
      "Response-limit composer draft is not committed.",
    ).toBe(CLAUDE_SHORTER_CONTINUATION_PROMPT);
    expect(editor.textContent, "Response-limit composer DOM text is not committed.").toBe(
      CLAUDE_SHORTER_CONTINUATION_PROMPT,
    );
    expect(
      readResponseLimitCaretText(editor),
      "Response-limit composer caret has not committed at the prepared prompt's end.",
    ).toEqual({ beforeCaret: CLAUDE_SHORTER_CONTINUATION_PROMPT, afterCaret: "" });
  };

  it("rejects shorter-response replacement readiness before text and native end-caret commitment", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createResponseLimitSnapshot(),
      configureFixture: configureResponseLimitFixture,
    });
    try {
      const editor = await waitForComposerEditor();
      expect(() => assertResponseLimitComposerReady(editor)).toThrow(
        "Response-limit composer draft is not committed.",
      );
      const prepare = page.getByRole("button", { name: "Prepare shorter response" });
      await expect.element(prepare).toBeEnabled();
      await prepare.click();
      await waitForComposerText(CLAUDE_SHORTER_CONTINUATION_PROMPT);
      await vi.waitFor(() => assertResponseLimitComposerReady(editor));

      // One real navigation action leaves the committed text and focus
      // intact but moves the caret inside it. The readiness gate must refuse
      // that state rather than treating activeElement as selection evidence.
      await userEvent.keyboard("{ArrowLeft}");
      await vi.waitFor(() =>
        expect(readResponseLimitCaretText(editor)).toEqual({
          beforeCaret: CLAUDE_SHORTER_CONTINUATION_PROMPT.slice(0, -1),
          afterCaret: CLAUDE_SHORTER_CONTINUATION_PROMPT.slice(-1),
        }),
      );
      expect(editor.textContent).toBe(CLAUDE_SHORTER_CONTINUATION_PROMPT);
      expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(
        CLAUDE_SHORTER_CONTINUATION_PROMPT,
      );
      expect(() => assertResponseLimitComposerReady(editor)).toThrow(
        "Response-limit composer caret has not committed at the prepared prompt's end.",
      );
      expect(
        wsRequests.filter((request) => request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand),
      ).toHaveLength(0);
    } finally {
      await mounted.cleanup();
    }
  });

  it.each([DEFAULT_VIEWPORT, COMPACT_FOOTER_VIEWPORT])(
    "prepares an editable Claude shorter response at $name width and submits only through normal Send",
    async (viewport) => {
      const mounted = await mountChatView({
        viewport,
        snapshot: createResponseLimitSnapshot(),
        configureFixture: configureResponseLimitFixture,
        resolveRpc: (body) =>
          body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand ? { sequence: 2 } : undefined,
      });
      try {
        const editor = await waitForComposerEditor();
        const prepare = page.getByRole("button", { name: "Prepare shorter response" });
        await expect.element(prepare).toBeEnabled();
        const settingsBefore = useComposerDraftStore.getState().getComposerDraft(THREAD_REF);
        await prepare.click();
        await waitForComposerText(CLAUDE_SHORTER_CONTINUATION_PROMPT);
        // Preparation writes the store before its controlled Lexical text
        // and queued native caret commit. Playwright fill selects the DOM
        // contents before a separate native insertText call, so mere focus
        // cannot qualify the preceding preparation's selection ownership.
        await vi.waitFor(() => assertResponseLimitComposerReady(editor));
        await expect.element(prepare).toBeDisabled();
        // A second stale click cannot prepare or submit another copy.
        (prepare.element() as HTMLButtonElement).click();
        expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)).toMatchObject({
          prompt: CLAUDE_SHORTER_CONTINUATION_PROMPT,
          modelSelectionByProvider: settingsBefore?.modelSelectionByProvider ?? {},
          activeProvider: settingsBefore?.activeProvider ?? null,
          runtimeMode: settingsBefore?.runtimeMode ?? null,
          interactionMode: settingsBefore?.interactionMode ?? null,
        });
        expect(selectThreadByRef(useStore.getState(), THREAD_REF)?.error).toBe(
          CLAUDE_RESPONSE_LIMIT_MESSAGE,
        );
        expect(
          wsRequests.filter((request) => request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand),
        ).toHaveLength(0);
        const rect = prepare.element().getBoundingClientRect();
        expect(rect.left).toBeGreaterThanOrEqual(0);
        expect(rect.right).toBeLessThanOrEqual(viewport.width);
        await page
          .getByTestId("composer-editor")
          .fill("Give a concise answer from the existing work.");
        // Observe the exact replacement through both committed surfaces
        // before the original Send gesture. Concatenation must fail here;
        // never repair it with another fill, forced selection or store write.
        await vi.waitFor(() => {
          expect(editor.textContent).toBe("Give a concise answer from the existing work.");
          expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(
            "Give a concise answer from the existing work.",
          );
        });
        (await waitForSendButton()).click();
        await vi.waitFor(() => {
          const commands = wsRequests.filter(
            (request) => request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand,
          );
          expect(commands).toHaveLength(1);
          expect(commands[0]).toMatchObject({
            type: "thread.turn.start",
            threadId: THREAD_ID,
            message: { text: "Give a concise answer from the existing work.", attachments: [] },
            modelSelection: responseLimitSelection,
            runtimeMode: "approval-required",
            interactionMode: "default",
          });
        });
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it.each([
    "draft",
    "file",
    "image",
    "queue edit",
    "approval",
    "question",
    "account",
    "error",
    "new turn",
  ] as const)(
    "rejects a stale Claude shorter-response click after %s replacement",
    async (state) => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createResponseLimitSnapshot("essential"),
        configureFixture: configureResponseLimitFixture,
      });
      try {
        await waitForComposerEditor();
        const prepare = page.getByRole("button", { name: "Prepare shorter response" });
        await expect.element(prepare).toBeEnabled();
        const staleButton = prepare.element() as HTMLButtonElement;
        if (state === "draft") {
          useComposerDraftStore.getState().setPrompt(THREAD_REF, "My unsent draft");
        } else if (state === "file") {
          useComposerDraftStore.getState().setFiles(THREAD_REF, [
            {
              id: "unsent-file",
              environmentId: LOCAL_ENVIRONMENT_ID,
              targetThreadId: THREAD_ID,
              name: "draft.txt",
              mimeType: "text/plain",
              sizeBytes: 1,
              status: "failed",
              error: "Synthetic unavailable upload",
            },
          ]);
        } else if (state === "image") {
          useComposerDraftStore.getState().addImages(THREAD_REF, [
            {
              id: "unsent-image",
              type: "image",
              name: "draft.png",
              mimeType: "image/png",
              sizeBytes: 1,
              previewUrl: "data:image/png;base64,eA==",
              file: new File(["x"], "draft.png", { type: "image/png" }),
            },
          ]);
        } else if (state === "queue edit") {
          expect(
            useComposerDraftStore.getState().beginQueueEdit(THREAD_REF, "queued-edit", {
              prompt: "",
              images: [],
              files: [],
              modelSelection: responseLimitSelection,
              runtimeMode: "approval-required",
              interactionMode: "default",
            }),
          ).toBe(true);
        } else if (state === "approval" || state === "question") {
          const activity: OrchestrationReadModel["threads"][number]["activities"][number] = {
            id: EventId.make(`response-limit-new-${state}`),
            kind: state === "approval" ? "approval.requested" : "user-input.requested",
            tone: "info",
            summary: "Synthetic pending decision",
            turnId: "response-limit-failed-turn" as TurnId,
            createdAt: isoAt(3201),
            payload: {
              requestId: `response-limit-${state}`,
              ...(state === "approval"
                ? { requestKind: "command" }
                : {
                    isBlocking: true,
                    questions: [
                      {
                        id: "choice",
                        header: "Choice",
                        question: "Choose a direction",
                        options: [
                          { label: "First", description: "First direction" },
                          { label: "Second", description: "Second direction" },
                        ],
                      },
                    ],
                  }),
            },
          };
          useStore.setState((store) => {
            const environment = store.environmentStateById[LOCAL_ENVIRONMENT_ID]!;
            return {
              environmentStateById: {
                ...store.environmentStateById,
                [LOCAL_ENVIRONMENT_ID]: {
                  ...environment,
                  activityIdsByThreadId: {
                    ...environment.activityIdsByThreadId,
                    [THREAD_ID]: [activity.id],
                  },
                  activityByThreadId: {
                    ...environment.activityByThreadId,
                    [THREAD_ID]: { [activity.id]: activity },
                  },
                },
              },
            };
          });
        } else if (state === "account") {
          useComposerDraftStore
            .getState()
            .setModelSelection(
              THREAD_REF,
              createModelSelection(ProviderInstanceId.make("codex"), "gpt-5"),
            );
        } else if (state === "error") {
          useStore.getState().setError(THREAD_REF, "A newer command failed.");
        } else {
          useStore.setState((store) => {
            const environment = store.environmentStateById[LOCAL_ENVIRONMENT_ID]!;
            return {
              environmentStateById: {
                ...store.environmentStateById,
                [LOCAL_ENVIRONMENT_ID]: {
                  ...environment,
                  threadSessionById: {
                    ...environment.threadSessionById,
                    [THREAD_ID]: {
                      ...environment.threadSessionById[THREAD_ID]!,
                      status: "running",
                      orchestrationStatus: "running",
                      activeTurnId: "new-response" as TurnId,
                    },
                  },
                },
              },
            };
          });
        }
        // Invoke before React commits the replacement, exercising the live
        // store recheck rather than only the next render's disabled button.
        staleButton.click();
        await waitForLayout();
        expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt ?? "").toBe(
          state === "draft" ? "My unsent draft" : "",
        );
        expect(
          wsRequests.filter((request) => request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand),
        ).toHaveLength(0);
        if (["draft", "file", "image", "queue edit", "approval", "question"].includes(state))
          await expect.element(prepare).toBeDisabled();
        else await expect.element(prepare).not.toBeInTheDocument();
        const currentDraft = useComposerDraftStore.getState().getComposerDraft(THREAD_REF);
        if (state === "file") expect(currentDraft?.files[0]?.id).toBe("unsent-file");
        if (state === "image") expect(currentDraft?.images[0]?.id).toBe("unsent-image");
        if (state === "queue edit") expect(currentDraft?.queueEditingItemId).toBe("queued-edit");
        if (state === "error")
          await expect.element(page.getByText("A newer command failed.")).toBeVisible();
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("does not prepare Claude continuation after navigating away and back to the failed chat", async () => {
    const base = createResponseLimitSnapshot();
    const secondId = ThreadId.make("response-limit-second-chat");
    const source = base.threads[0]!;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...base,
        threads: [
          ...base.threads,
          {
            ...source,
            id: secondId,
            title: "Another chat",
            messages: [],
            latestTurn: null,
            session: { ...source.session!, threadId: secondId, status: "ready", lastError: null },
          },
        ],
      },
      configureFixture: configureResponseLimitFixture,
    });
    try {
      await waitForComposerEditor();
      const prepare = page.getByRole("button", { name: "Prepare shorter response" });
      await expect.element(prepare).toBeEnabled();
      const previousButton = prepare.element() as HTMLButtonElement;
      await mounted.router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: LOCAL_ENVIRONMENT_ID, threadId: secondId },
      });
      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(secondId),
        "Navigate to second chat.",
      );
      previousButton.click();
      expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt ?? "").toBe("");
      expect(
        useComposerDraftStore
          .getState()
          .getComposerDraft(scopeThreadRef(LOCAL_ENVIRONMENT_ID, secondId))?.prompt ?? "",
      ).toBe("");
      await mounted.router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: LOCAL_ENVIRONMENT_ID, threadId: THREAD_ID },
      });
      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(THREAD_ID),
        "Return to failed chat.",
      );
      await expect.element(prepare).toBeEnabled();
      expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt ?? "").toBe("");
      expect(
        wsRequests.filter((request) => request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand),
      ).toHaveLength(0);
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows manual compaction in the used-tools list without a user turn or composer notice", async ({
    signal,
    onTestFinished,
    onTestFailed,
  }) => {
    type Step =
      | "mount"
      | "layout"
      | "send-button"
      | "request"
      | "draft-cleared"
      | "work-log-requested"
      | "work-log-running"
      | "work-log-completed";
    type Phase =
      | `${Step}:${"entered" | "settled"}`
      | `mount:${"viewport" | "styles" | "render" | "websocket" | "bootstrap" | "layout"}`
      | "send-clicked"
      | "cleanup:entered"
      | "cleanup:settled";
    const startedAt = performance.now();
    const phases: { phase: Phase; elapsedMs: number }[] = [];
    let recording = true;
    let retired = false;
    let bodyFailed = false;
    let mounting: ReturnType<typeof mountChatView> | undefined;
    let mountCleanup: (() => Promise<void>) | undefined;
    let cleanupPromise: Promise<void> | undefined;
    const pendingOperations = new Set<Promise<unknown>>();
    const recordPhase = (phase: Phase) => {
      if (!recording) return;
      try {
        if (phases.length === 16) phases.shift();
        const elapsed = performance.now() - startedAt;
        phases.push({
          phase,
          elapsedMs: Number.isFinite(elapsed)
            ? Math.min(60_000, Math.max(0, Math.round(elapsed)))
            : 0,
        });
      } catch {
        /* Passive diagnostics cannot replace an original result. */
      }
    };
    const assertActive = () => {
      if (retired || signal.aborted)
        throw new Error("The exact manual-compaction fixture was retired.");
    };
    const cleanup = (): Promise<void> => {
      retired = true;
      signal.removeEventListener("abort", onAbort);
      // Publish one completion before invoking asynchronous disposal. Cleanup
      // itself and the test body never enter the set they must drain.
      return (cleanupPromise ??= Promise.resolve().then(async () => {
        recordPhase("cleanup:entered");
        try {
          try {
            await mounting;
          } catch {
            // Join the original mount without replacing its body rejection.
          }
          // Keep the exact controls alive until their admitted work settles;
          // a later fixture must not satisfy an old continuation or locator.
          await Promise.allSettled([...pendingOperations]);
        } finally {
          try {
            await mountCleanup?.();
          } finally {
            recordPhase("cleanup:settled");
            recording = false;
          }
        }
      }));
    };
    const onAbort = () => {
      void cleanup().catch(() => undefined);
    };
    const observe = async <T,>(step: Step, operation: () => PromiseLike<T>): Promise<T> => {
      assertActive();
      recordPhase(`${step}:entered`);
      const original = Promise.resolve(operation());
      pendingOperations.add(original);
      try {
        const result = await original;
        assertActive();
        recordPhase(`${step}:settled`);
        return result;
      } finally {
        pendingOperations.delete(original);
      }
    };
    // Public retirement is installed before mount can yield. The shared hook
    // joins this same callback before resetting the RPC harness or DOM.
    onTestFinished(cleanup);
    onTestFailed(() => {
      try {
        console.error("Synthetic manual-compaction phases", { phases });
      } catch {
        /* Preserve the original failure without payload or error text. */
      }
    });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    const base = createSnapshotForTargetUser({
      targetMessageId: "compact-history" as MessageId,
      targetText: "Existing conversation",
    });
    const snapshot = {
      ...base,
      threads: base.threads.map((thread) =>
        Object.assign({}, thread, {
          latestTurn: {
            turnId: "previous-turn" as TurnId,
            state: "completed" as const,
            requestedAt: isoAt(100),
            startedAt: isoAt(101),
            completedAt: isoAt(130),
            assistantMessageId: null,
          },
          session: thread.session
            ? { ...thread.session, providerInstanceId: ProviderInstanceId.make("codex") }
            : null,
        }),
      ),
    };
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
              observePhase: (phase) => {
                assertActive();
                recordPhase(`mount:${phase}`);
              },
            },
            resolveRpc: (body) =>
              body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand ? { sequence: 2 } : undefined,
          })),
      );
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "/compact");
      await observe("layout", () => waitForLayout());
      const sendButton = await observe("send-button", () => waitForSendButton());
      assertActive();
      // Preserve the original synchronous HTML activation, not another native
      // input or a new readiness condition.
      sendButton.click();
      recordPhase("send-clicked");
      await observe("request", () =>
        vi.waitFor(() =>
          expect(
            wsRequests.some(
              (request) =>
                request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                request.type === "thread.compact",
            ),
          ).toBe(true),
        ),
      );
      const request = wsRequests.find(
        (request) =>
          request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
          request.type === "thread.compact",
      );
      expect(request).toMatchObject({ threadId: THREAD_ID, providerInstanceId: "codex" });
      expect(document.querySelector("[data-compaction-status]")).toBeNull();
      const requested = {
        id: EventId.make("compact-requested"),
        kind: "provider.compaction.requested",
        tone: "info" as const,
        summary: "Compaction requested",
        createdAt: isoAt(180),
        turnId: null,
        payload: { operationId: request?.commandId },
      };
      const started = {
        id: EventId.make("compact-started"),
        kind: "tool.started",
        tone: "tool" as const,
        summary: "Context compaction started",
        createdAt: isoAt(181),
        turnId: "compact-turn" as TurnId,
        payload: {
          itemType: "context_compaction",
          itemId: "compact-item",
          title: "Context compaction",
          status: "inProgress",
        },
      };
      const completed = {
        ...started,
        id: EventId.make("compact-completed"),
        kind: "tool.completed",
        summary: "Context compacted",
        createdAt: isoAt(182),
        payload: { ...started.payload, status: "completed" },
      };
      for (const [sequence, activities, state, label] of [
        [3, [requested], "requested", "Compaction requested"],
        [4, [requested, started], "running", "Compacting context"],
        [5, [requested, started, completed], "completed", "Context compacted"],
      ] as const) {
        assertActive();
        const thread = {
          ...snapshot.threads[0]!,
          activities,
          latestTurn:
            state === "requested"
              ? snapshot.threads[0]!.latestTurn
              : {
                  turnId: started.turnId,
                  state,
                  requestedAt: requested.createdAt,
                  startedAt: started.createdAt,
                  completedAt: state === "completed" ? completed.createdAt : null,
                  assistantMessageId: null,
                },
        };
        chatViewFixture.fixture.snapshot = {
          ...snapshot,
          snapshotSequence: sequence,
          threads: [thread],
        };
        rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
          kind: "snapshot",
          snapshot: { snapshotSequence: sequence, thread },
        });
        await observe(`work-log-${state}`, () =>
          vi.waitFor(() =>
            expect(
              [...document.querySelectorAll("[data-work-log]")]
                .map((node) => node.textContent)
                .join(" "),
            ).toContain(label),
          ),
        );
      }
      expect(document.querySelector("[data-compaction-status]")).toBeNull();
      expect(document.body.textContent).not.toContain("Compacting context");
      expect(wsRequests.some((request) => request.type === "thread.turn.start")).toBe(false);
      await observe("draft-cleared", () =>
        vi.waitFor(() =>
          expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt ?? "").toBe(
            "",
          ),
        ),
      );
    } catch (error) {
      bodyFailed = true;
      throw error;
    } finally {
      if (bodyFailed) {
        try {
          await cleanup();
        } catch {
          // Preserve the primary body failure. Shared retirement still joins
          // and reports the same rejected cleanup under the existing policy.
        }
      } else {
        await cleanup();
      }
    }
  });

  it.for([
    ["completed", "Context compacted"],
    ["failed", "Context compaction failed"],
    ["declined", "Context compaction interrupted"],
  ] as const)(
    "restores %s manual compaction in the used-tools list without an assistant message",
    async ([status, title], testContext) => {
      const owner = createChatViewCallerOwner(testContext, mountChatView, {
        label: "restored-compaction",
      });
      await owner.run(async () => {
        const base = createSnapshotForTargetUser({
          targetMessageId: "compact-restored" as MessageId,
          targetText: "Existing conversation",
        });
        const snapshot = {
          ...base,
          threads: base.threads.map((thread) =>
            Object.assign({}, thread, {
              latestTurn: {
                turnId: "compact-turn" as TurnId,
                state:
                  status === "failed"
                    ? ("error" as const)
                    : status === "declined"
                      ? ("interrupted" as const)
                      : ("completed" as const),
                requestedAt: isoAt(178),
                startedAt: isoAt(179),
                completedAt: isoAt(180),
                assistantMessageId: null,
              },
              activities: [
                {
                  id: EventId.make("restored-compaction"),
                  kind: "tool.completed",
                  tone: "tool" as const,
                  summary: title,
                  createdAt: isoAt(180),
                  turnId: "compact-turn" as TurnId,
                  payload: {
                    itemType: "context_compaction",
                    itemId: "item",
                    title: "Context compaction",
                    status,
                  },
                },
              ],
            }),
          ),
        };
        await owner.mount({ viewport: DEFAULT_VIEWPORT, snapshot });
        await owner.own("work-log", () =>
          vi.waitFor(() =>
            expect(
              [...document.querySelectorAll("[data-work-log]")]
                .map((node) => node.textContent)
                .join(" "),
            ).toContain(title),
          ),
        );
        expect(document.querySelector("[data-compaction-status]")).toBeNull();
        expect(wsRequests.some((request) => request.type === "thread.compact")).toBe(false);
      });
    },
  );

  it("preserves invalid compaction arguments instead of sending them to the model", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "compact-args" as MessageId,
        targetText: "Existing conversation",
        history: "essential",
      }),
    });
    try {
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "/compact focus on tests");
      await waitForLayout();
      (await waitForSendButton()).click();
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain("Use /compact on its own"),
      );
      expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(
        "/compact focus on tests",
      );
      expect(
        wsRequests.some(
          (request) => request.type === "thread.turn.start" || request.type === "thread.compact",
        ),
      ).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });

  it("places configured dictation immediately before the send action", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-dictation-action" as MessageId,
        targetText: "dictation action target",
      }),
      resolveRpc: (body) =>
        body._tag === WS_METHODS.dictationGetStatus
          ? { configured: true, canManage: true }
          : undefined,
    });

    try {
      const dictationButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Start dictation"]'),
        "Unable to find configured dictation button.",
      );
      const sendButton = await waitForSendButton();
      const actionButtons = Array.from(
        dictationButton
          .closest<HTMLElement>('[data-chat-composer-actions="right"]')
          ?.querySelectorAll<HTMLButtonElement>("button") ?? [],
      );
      expect(actionButtons.indexOf(dictationButton)).toBe(actionButtons.indexOf(sendButton) - 1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the current runtime step and exposes every full task on hover without a side panel", async () => {
    // Even an old explicit "open" preference must not turn a runtime checklist
    // into authored plan content. This catches the former Tasks-sidebar path,
    // not just the default-closed presentation.
    useUiStateStore.setState({
      threadPlanSidebarOpenById: {
        [THREAD_KEY]: true,
      },
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithRuntimeTaskProgress({ withAuthoredPlan: true }),
    });

    try {
      const trigger = page.getByRole("button", {
        name: /^Task progress: step 5 of 12\b/i,
      });
      await expect.element(trigger).toHaveTextContent("Step 5 / 12");
      expect(findComposerTaskProgressTrigger()).not.toBeNull();

      expect(document.querySelector('button[aria-label="Close plan sidebar"]')).toBeNull();
      expect(
        document.querySelector(
          'button[title="Show plan sidebar"], button[title="Hide plan sidebar"]',
        ),
      ).toBeNull();
      expect(document.querySelector('[data-slot="sheet-popup"]:not([hidden])')).toBeNull();

      await trigger.hover();
      await vi.waitFor(
        () => {
          expect(findComposerTaskProgressPopup()).not.toBeNull();
          expect(findComposerTaskProgressList()).not.toBeNull();
          expect(findComposerTaskProgressScroller()).not.toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );

      const popup = findComposerTaskProgressPopup();
      const list = findComposerTaskProgressList();
      const scroller = findComposerTaskProgressScroller();
      expect(popup).not.toBeNull();
      expect(list).not.toBeNull();
      expect(scroller).not.toBeNull();
      if (!popup || !list || !scroller) {
        throw new Error("Task progress popup did not finish mounting.");
      }

      const rows = Array.from(
        list.querySelectorAll<HTMLElement>("[data-composer-task-progress-step]"),
      );
      expect(rows).toHaveLength(RUNTIME_TASK_DESCRIPTIONS.length);
      for (const description of RUNTIME_TASK_DESCRIPTIONS) {
        expect(popup.textContent).toContain(description);
      }
      expect(popup.textContent).not.toContain("and more");

      expect(getComputedStyle(scroller).overflowY).toBe("auto");
      expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
      scroller.scrollTop = scroller.scrollHeight;
      await waitForLayout();
      const lastRow = rows.at(-1);
      expect(lastRow).toBeTruthy();
      expect(lastRow!.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        scroller.getBoundingClientRect().bottom + 1,
      );

      // Opening the task popover must not opportunistically open the removed
      // runtime Tasks panel or make its authored-plan close control appear.
      expect(document.querySelector('button[aria-label="Close plan sidebar"]')).toBeNull();
      expect(document.querySelector('[data-slot="sheet-popup"]:not([hidden])')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens task progress with an ordinary press and restores trigger focus on Escape", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithRuntimeTaskProgress(),
    });

    try {
      const trigger = page.getByRole("button", {
        name: /^Task progress: step 5 of 12\b/i,
      });
      const triggerElement = await waitForElement(
        findComposerTaskProgressTrigger,
        "Unable to find task progress trigger.",
      );
      triggerElement.focus();

      // Base UI maps the same press interaction to mouse click, touch tap, and
      // keyboard activation. Exercising the semantic button keeps this an
      // integration test of that shared path rather than a hover-only check.
      await trigger.click();
      await vi.waitFor(() => {
        expect(findComposerTaskProgressPopup()).not.toBeNull();
        expect(triggerElement.getAttribute("aria-expanded")).toBe("true");
      });

      const scroller = findComposerTaskProgressScroller();
      expect(scroller).not.toBeNull();
      scroller?.focus();
      expect(document.activeElement).toBe(scroller);

      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => {
        expect(findComposerTaskProgressPopup()).toBeNull();
        expect(triggerElement.getAttribute("aria-expanded")).toBe("false");
        expect(document.activeElement).toBe(triggerElement);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps an older-turn active child in the task popover and docked rail until its canonical terminal event", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithCrossTurnActiveSubagent(),
    });

    try {
      // The current parent turn intentionally differs from the child's
      // spawning turn. This is the production boundary where reusing the
      // transcript's latest-turn filter would incorrectly hide the child.
      expect(selectThreadByRef(useStore.getState(), THREAD_REF)?.latestTurn?.turnId).toBe(
        "turn-after-cross-turn-subagent-spawn",
      );
      await page.getByRole("button", { name: /^1 active subagent\. Show task list$/i }).click();

      const subagentRow = page
        .getByRole("region", { name: "Active subagents" })
        .getByRole("button", {
          name: /Cross-turn roster audit, Working\. Verify the child survives latest-turn filtering\. Open details/i,
        });
      await expect.element(subagentRow).toBeVisible();

      await page.getByRole("button", { name: "Show on the side" }).click();
      await vi.waitFor(() => {
        expect(findSessionRail()).not.toBeNull();
        expect(findSessionRail()?.textContent).toContain("Cross-turn roster audit");
        expect(findComposerTaskProgressTrigger()).toBeNull();
      });
      await expect.element(subagentRow).toBeVisible();

      // Exercise the canonical stream reducer instead of replacing the
      // detail snapshot. The terminal edge belongs to the older spawning
      // turn and must remove the child while leaving the newer turn current.
      rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
        kind: "event",
        event: {
          type: "thread.activity-appended",
          sequence: chatViewFixture.fixture.snapshot.snapshotSequence + 1,
          eventId: EventId.make("event-cross-turn-active-subagent-completed"),
          aggregateKind: "thread",
          aggregateId: THREAD_ID,
          occurredAt: isoAt(1_020),
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            threadId: THREAD_ID,
            activity: {
              id: EventId.make("activity-cross-turn-active-subagent-completed"),
              tone: "info",
              kind: "task.completed",
              summary: "Subagent completed",
              payload: {
                taskId: "provider-child-cross-turn-roster",
                taskType: "subagent",
                status: "completed",
                detail: "Verified cross-turn roster behavior",
                subagent: {
                  threadId: "provider-child-cross-turn-roster",
                  runtimeId: SUBAGENT_RUNTIME_ID,
                  label: "Cross-turn roster audit",
                  path: "/root/cross_turn_roster_audit",
                  objective: "Verify the child survives latest-turn filtering",
                  status: "completed",
                  startedAt: isoAt(1_001),
                },
              },
              turnId: "turn-cross-turn-subagent-spawn" as TurnId,
              sequence: 2,
              createdAt: isoAt(1_020),
            },
          },
        },
      });

      await vi.waitFor(() => {
        expect(findSessionRail()?.textContent).not.toContain("Cross-turn roster audit");
        expectEmptyScheduledSessionRailTasks();
        expect(selectThreadByRef(useStore.getState(), THREAD_REF)?.latestTurn?.turnId).toBe(
          "turn-after-cross-turn-subagent-spawn",
        );
      });

      await page.getByRole("button", { name: "Show in composer" }).click();
      await vi.waitFor(() => {
        expect(findSessionRail()).toBeNull();
        expect(findComposerTaskProgressTrigger()?.getAttribute("aria-label")).toBe(
          "Tasks and scheduled follow-ups. Show task list",
        );
        expect(findComposerTaskProgressTrigger()?.textContent).not.toContain("agent");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("removes a child from active tasks when runtime evidence is cleared but keeps its history inspectable", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithCrossTurnActiveSubagent(),
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
      await page.getByRole("button", { name: "Show on the side" }).click();
      await vi.waitFor(() => {
        expect(findSessionRail()?.textContent).toContain("Cross-turn roster audit");
      });

      const session = chatViewFixture.fixture.snapshot.threads.find(
        (thread) => thread.id === THREAD_ID,
      )?.session;
      expect(session).toBeDefined();
      // This is an authoritative native-session clear, not a renderer socket
      // reconnect or a child completion. Leave the parent's running status,
      // latest turn, and original active child event unchanged: generation
      // evidence alone must invalidate the roster and its ticking clock.
      rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
        kind: "event",
        event: {
          type: "thread.session-set",
          sequence: chatViewFixture.fixture.snapshot.snapshotSequence + 1,
          eventId: EventId.make("event-cross-turn-subagent-runtime-cleared"),
          aggregateKind: "thread",
          aggregateId: THREAD_ID,
          occurredAt: isoAt(1_020),
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            threadId: THREAD_ID,
            session: {
              ...session,
              subagentRuntimeId: null,
              updatedAt: isoAt(1_020),
            },
          },
        },
      });

      await vi.waitFor(() => {
        const thread = selectThreadByRef(useStore.getState(), THREAD_REF);
        expect(thread?.session?.subagentRuntimeId).toBeNull();
        expect(thread?.session?.orchestrationStatus).toBe("running");
        expect(findSessionRail()?.textContent).not.toContain("Cross-turn roster audit");
        expectEmptyScheduledSessionRailTasks();
        expect(findSessionRail()?.textContent).not.toContain("1 active");
      });
      await page.getByRole("button", { name: "Show in composer" }).click();
      await vi.waitFor(() => {
        expect(findSessionRail()).toBeNull();
        expect(findComposerTaskProgressTrigger()?.getAttribute("aria-label")).toBe(
          "Tasks and scheduled follow-ups. Show task list",
        );
        expect(findComposerTaskProgressTrigger()?.textContent).not.toContain("agent");
      });

      useTaskAtriumStore.getState().setOpen(true);
      const historicalChild = page.getByRole("button", {
        name: "View Cross-turn roster audit activity",
        exact: true,
      });
      await expect.element(historicalChild).not.toBeInTheDocument();
      await page.getByRole("button", { name: "History (1)", exact: true }).click();
      await expect.element(historicalChild).toBeVisible();
      await expect.element(historicalChild).toMatchTextContent("Status unavailable");
      await historicalChild.click();
      const detail = page.getByRole("region", {
        name: "Subagent detail: Cross-turn roster audit",
      });
      await expect.element(detail.getByText("Status unavailable", { exact: true })).toBeVisible();
      expect(document.querySelector('[data-subagent-detail-elapsed="true"]')).toBeNull();
      expect(document.querySelector('[data-subagent-live-elapsed="true"]')).toBeNull();
    } finally {
      useTaskAtriumStore.getState().setOpen(false);
      await mounted.cleanup();
    }
  });

  it("keeps the pressed task popover contained at 430px and omits the compact plan-sidebar action", async () => {
    useUiStateStore.setState({
      threadPlanSidebarOpenById: {
        [THREAD_KEY]: true,
      },
    });
    const mounted = await mountChatView({
      viewport: COMPACT_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithRuntimeTaskProgress(),
    });

    try {
      const trigger = page.getByRole("button", {
        name: /^Task progress: step 5 of 12\b/i,
      });
      await trigger.click();
      await vi.waitFor(() => expect(findComposerTaskProgressPopup()).not.toBeNull());

      const popup = findComposerTaskProgressPopup();
      const scroller = findComposerTaskProgressScroller();
      const outerViewport = popup?.querySelector<HTMLElement>('[data-slot="popover-viewport"]');
      expect(popup).not.toBeNull();
      expect(scroller).not.toBeNull();
      expect(outerViewport).not.toBeNull();
      if (!popup || !scroller) {
        throw new Error("Compact task progress popup did not finish mounting.");
      }

      const popupBounds = popup.getBoundingClientRect();
      expect(popupBounds.left).toBeGreaterThanOrEqual(-1);
      expect(popupBounds.right).toBeLessThanOrEqual(window.innerWidth + 1);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
        document.documentElement.clientWidth,
      );
      expect(document.body.scrollWidth).toBeLessThanOrEqual(document.body.clientWidth);
      expect(getComputedStyle(outerViewport!).overflowY).toBe("hidden");
      expect(getComputedStyle(scroller).overflowY).toBe("auto");
      expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
      expect(scroller.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        outerViewport!.getBoundingClientRect().bottom + 1,
      );
      expect(outerViewport!.scrollTop).toBe(0);

      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => expect(findComposerTaskProgressPopup()).toBeNull());

      const moreControls = page.getByRole("button", { name: "More composer controls" });
      await moreControls.click();
      await vi.waitFor(() => {
        expect(document.querySelector('[data-slot="menu-popup"]')).not.toBeNull();
      });
      const compactSidebarAction = Array.from(
        document.querySelectorAll<HTMLElement>('[data-slot="menu-item"]'),
      ).find((item) => /^(?:Show|Hide) plan sidebar$/i.test(item.textContent?.trim() ?? ""));
      expect(compactSidebarAction).toBeUndefined();
      expect(document.querySelector('button[aria-label="Close plan sidebar"]')).toBeNull();
      expect(document.querySelector('[data-slot="sheet-popup"]:not([hidden])')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it.each([
    ["the latest provider checklist is explicitly empty", { steps: [] }],
    ["the latest turn is terminal", { terminal: true }],
  ] as const)(
    "retains scheduling without stale task progress when %s",
    async (_reason, options) => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotWithRuntimeTaskProgress(options),
      });

      try {
        await waitForLayout();
        expect(findComposerTaskProgressTrigger()?.getAttribute("aria-label")).toBe(
          "Tasks and scheduled follow-ups. Show task list",
        );
        expect(findComposerTaskProgressPopup()).toBeNull();
        expect(document.querySelector('button[aria-label^="Task progress: step"]')).toBeNull();
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("temporarily hides an authored plan during implementation without persisting a closed preference", async () => {
    useUiStateStore.setState({
      threadPlanSidebarOpenById: {},
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithPlanFollowUpPrompt(),
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return { sequence: chatViewFixture.fixture.snapshot.snapshotSequence + 1 };
        }
        return undefined;
      },
    });

    const publishThreadSnapshot = (nextSnapshot: OrchestrationReadModel): void => {
      const nextThread = nextSnapshot.threads.find((thread) => thread.id === THREAD_ID);
      if (!nextThread) {
        throw new Error("Sequential plan regression fixture is missing its active thread.");
      }
      const snapshotSequence = chatViewFixture.fixture.snapshot.snapshotSequence + 1;
      chatViewFixture.fixture.snapshot = {
        ...nextSnapshot,
        snapshotSequence,
      };
      rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
        kind: "snapshot",
        snapshot: {
          snapshotSequence,
          thread: nextThread,
        },
      });
    };

    try {
      // The completed authored plan still follows the normal auto-open path.
      await vi.waitFor(
        () => {
          expect(document.querySelector('button[aria-label="Close plan sidebar"]')).not.toBeNull();
          expect(document.body.textContent).toContain("Follow-up plan");
          expect(useUiStateStore.getState().threadPlanSidebarOpenById[THREAD_KEY]).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );

      const implementButton = await waitForButtonByText("Implement");
      implementButton.click();
      await vi.waitFor(
        () => {
          const implementationDispatch = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.turn.start" &&
              request.interactionMode === "default",
          );
          expect(implementationDispatch).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "thread.turn.start",
            sourceProposedPlan: {
              threadId: THREAD_ID,
              planId: "plan-follow-up-browser-test",
            },
          });
          // Local dispatch hides the panel immediately, but that suppression
          // is not a user preference and must never overwrite the stored true.
          expect(document.querySelector('button[aria-label="Close plan sidebar"]')).toBeNull();
          expect(useUiStateStore.getState().threadPlanSidebarOpenById[THREAD_KEY]).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );

      publishThreadSnapshot(createSnapshotWithRuntimeTaskProgress({ withAuthoredPlan: true }));
      await vi.waitFor(
        () => {
          expect(findComposerTaskProgressTrigger()).not.toBeNull();
          expect(document.querySelector('button[aria-label="Close plan sidebar"]')).toBeNull();
          expect(
            document.querySelector(
              'button[title="Show plan sidebar"], button[title="Hide plan sidebar"]',
            ),
          ).toBeNull();
          expect(useUiStateStore.getState().threadPlanSidebarOpenById[THREAD_KEY]).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );

      // Once there is no active runtime turn, the next authored plan is
      // visible again under the unchanged open preference.
      publishThreadSnapshot(
        createSnapshotWithPlanFollowUpPrompt({
          planMarkdown: "# Future authored plan\n\n- Preserve plan auto-open behavior.",
        }),
      );
      await vi.waitFor(
        () => {
          expect(document.querySelector('button[aria-label="Close plan sidebar"]')).not.toBeNull();
          expect(document.body.textContent).toContain("Future authored plan");
          expect(findComposerTaskProgressTrigger()?.getAttribute("aria-label")).toBe(
            "Tasks and scheduled follow-ups. Show task list",
          );
          expect(useUiStateStore.getState().threadPlanSidebarOpenById[THREAD_KEY]).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("docks the runtime checklist and context usage into the session rail on a wide viewport", async (context) => {
    const owner = createChatViewCallerOwner(context, mountChatView, {
      label: "composer-rail-docking",
    });
    await owner.run(async () => {
      await owner.mount({
        viewport: WIDE_FOOTER_VIEWPORT,
        snapshot: createSnapshotWithRuntimeTaskProgress({ withContextWindow: true }),
        configureFixture: (nextFixture) => {
          const [codexProvider] = nextFixture.serverConfig.providers;
          if (!codexProvider) return;
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            providers: [
              {
                ...codexProvider,
                accountRateLimits: {
                  checkedAt: NOW_ISO,
                  rateLimits: {
                    limitId: "codex",
                    primary: {
                      usedPercent: 1,
                      windowDurationMins: 10_080,
                      resetsAt: 1_788_278_880,
                    },
                  },
                },
              },
            ],
          };
        },
      });

      const trigger = page.getByRole("button", {
        name: /^Task progress: step 5 of 12\b/i,
      });
      await owner.own("controls", () => trigger.click());
      await owner.own("preview", () =>
        vi.waitFor(() => expect(findComposerTaskProgressPopup()).not.toBeNull()),
      );
      await owner.own("rail", () => page.getByRole("button", { name: "Show on the side" }).click());

      await owner.own("rail", () =>
        vi.waitFor(() => {
          expect(findSessionRail()).not.toBeNull();
          expect(useDeskStore.getState().desk.groups.g1?.sessionRailDocked).toBe(true);
          expect(useUiStateStore.getState().sessionRailDocked).toBe(false);
        }),
      );

      const rail = findSessionRail();
      expect(rail).not.toBeNull();
      if (!rail) {
        throw new Error("Session rail did not mount after docking.");
      }
      for (const description of RUNTIME_TASK_DESCRIPTIONS) {
        expect(rail.textContent).toContain(description);
      }
      expect(rail.textContent).toContain("213k");
      expect(rail.textContent).toContain("258k");
      expect(rail.textContent).toContain("6.6m");
      expect(rail.textContent).toContain("Primary window");
      expect(findComposerTaskProgressPopup()).toBeNull();
      expect(document.querySelector('button[aria-label^="Context window"]')).toBeNull();
      expect(findComposerTaskProgressTrigger()).toBeNull();

      await owner.own("controls", () =>
        page.getByRole("button", { name: "Show in composer" }).click(),
      );
      await owner.own("rail", () =>
        vi.waitFor(() => {
          expect(findSessionRail()).toBeNull();
          expect(useDeskStore.getState().desk.groups.g1?.sessionRailDocked).toBe(false);
          expect(useUiStateStore.getState().sessionRailDocked).toBe(false);
        }),
      );
      expect(document.querySelector('button[aria-label^="Context window"]')).not.toBeNull();
      await owner.own("reopen", () =>
        page.getByRole("button", { name: /^Task progress: step 5 of 12\b/i }).click(),
      );
      await owner.own("preview", () =>
        vi.waitFor(() => expect(findComposerTaskProgressPopup()).not.toBeNull()),
      );
    });
  });

  it("keeps the Tasks column aligned and full height while an Axiom provider warning is visible", async () => {
    const instanceId = ProviderInstanceId.make("axiom");
    const base = createSnapshotForTargetUser({
      targetMessageId: "warning-user" as MessageId,
      targetText: "Axiom warning layout",
    });
    const snapshot = {
      ...base,
      threads: base.threads.map((thread) => ({
        ...thread,
        modelSelection: { instanceId, model: "native-model" },
        session: thread.session
          ? {
              ...thread.session,
              provider: ProviderDriverKind.make("axiom"),
              providerInstanceId: instanceId,
            }
          : null,
      })),
    };
    useUiStateStore.setState({ sessionRailDocked: true });
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot,
      configureFixture: (next) => {
        next.serverConfig = {
          ...next.serverConfig,
          providers: [
            {
              ...next.serverConfig.providers[0]!,
              instanceId,
              driver: ProviderDriverKind.make("axiom"),
              displayName: "Axiom",
              status: "warning",
              auth: { status: "unknown" },
              message:
                "Axiom's account check is temporarily unavailable. Refresh this provider to try again.",
              models: [
                {
                  slug: "native-model",
                  name: "DeepSeek V4.1 Flash",
                  isCustom: false,
                  capabilities: null,
                },
              ],
            },
          ],
        };
      },
    });
    try {
      const banner = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-provider-status-banner="true"]'),
        "Provider warning did not appear",
      );
      const rail = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-right-column="true"]'),
        "Tasks column did not appear",
      );
      const header = document.querySelector<HTMLElement>('[data-chat-view-header="true"]')!;
      const before = rail.getBoundingClientRect();
      expect(banner.getBoundingClientRect().height).toBeGreaterThan(0);
      expect(Math.abs(before.top - header.getBoundingClientRect().bottom)).toBeLessThanOrEqual(1);
      expect(banner.getBoundingClientRect().right).toBeLessThanOrEqual(before.left + 1);
      await page.screenshot({
        path: "../../../../.explorations/axiom-health-layout/provider-warning-rail.png",
      });
      await page.getByRole("button", { name: "Dismiss provider status", exact: true }).click();
      await vi.waitFor(() =>
        expect(document.querySelector('[data-provider-status-banner="true"]')).toBeNull(),
      );
      const after = rail.getBoundingClientRect();
      expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(1);
      expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps composer popovers when the session rail is preferred on a narrow viewport", async () => {
    useUiStateStore.setState({ sessionRailDocked: true });
    const mounted = await mountChatView({
      viewport: COMPACT_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithRuntimeTaskProgress({ withContextWindow: true }),
    });

    try {
      expect(findSessionRail()).toBeNull();
      expect(document.querySelector('button[aria-label^="Context window"]')).not.toBeNull();
      const trigger = page.getByRole("button", {
        name: /^Task progress: step 5 of 12\b/i,
      });
      await trigger.click();
      await vi.waitFor(() => expect(findComposerTaskProgressPopup()).not.toBeNull());
      expect(document.querySelector('[data-session-rail-dock="true"]')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("stacks the session rail under an authored plan in the shared right column", async () => {
    useUiStateStore.setState({ sessionRailDocked: true });
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithPlanFollowUpPrompt(),
    });

    try {
      await vi.waitFor(() => {
        expect(document.querySelector('button[aria-label="Close plan sidebar"]')).not.toBeNull();
        expect(findSessionRail()).not.toBeNull();
      });
      expect(document.querySelector('[data-chat-right-column="true"]')).not.toBeNull();
      await vi.waitFor(expectEmptyScheduledSessionRailTasks);
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders locked single-environment mobile run context as a static workspace label", async () => {
    const mounted = await mountChatView({
      viewport: COMPACT_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-mobile-locked-workspace" as MessageId,
        targetText: "locked mobile workspace",
      }),
    });

    try {
      await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>("span")).find(
            (element) => element.textContent?.trim() === "Local checkout",
          ) ?? null,
        "Unable to find static mobile workspace label.",
      );

      expect(findButtonByText("Local checkout")).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps dismiss-only composer banners aligned on mobile", async () => {
    const mounted = await mountChatView({
      viewport: COMPACT_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-mobile-version-banner" as MessageId,
        targetText: "mobile version banner",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          environment: {
            ...nextFixture.serverConfig.environment,
            serverVersion: "9.9.9",
          },
        };
      },
    });

    try {
      const banner = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="alert"]')).find(
            (element) => element.textContent?.includes("Client and server versions differ"),
          ) ?? null,
        "Unable to find version mismatch banner.",
      );
      const title = banner.querySelector<HTMLElement>('[data-slot="alert-title"]');
      const description = banner.querySelector<HTMLElement>('[data-slot="alert-description"]');
      const dismissButton = banner.querySelector<HTMLButtonElement>(
        'button[aria-label="Dismiss version mismatch warning"]',
      );

      expect(title).toBeTruthy();
      expect(description).toBeTruthy();
      expect(dismissButton).toBeTruthy();
      expect(dismissButton!.getBoundingClientRect().top).toBeLessThan(
        description!.getBoundingClientRect().top,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("re-expands the bootstrap project using its logical key", async () => {
    useUiStateStore.setState({
      projectExpandedById: {
        [PROJECT_LOGICAL_KEY]: false,
      },
      projectOrder: [PROJECT_LOGICAL_KEY],
      threadLastVisitedAtById: {},
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-bootstrap-project-expand" as MessageId,
        targetText: "bootstrap project expand",
        history: "essential",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(useUiStateStore.getState().projectExpandedById[PROJECT_LOGICAL_KEY]).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows an explicit empty state for projects without threads in the sidebar", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
    });

    try {
      // The standalone Chats catalog can show the same short empty line, so
      // scope this to the project's own empty row.
      await expect
        .element(page.getByTestId("sidebar-project-empty-chats").getByText("No chats yet"))
        .toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not render local editor open controls for draft threads", async () => {
    setDraftThreadWithoutWorktree();

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode"],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const hasOpenButton = Array.from(document.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "Open",
      );
      const hasOpenPickerButton =
        document.querySelector('button[aria-label="Copy options"]') !== null;

      expect(hasOpenButton).toBe(false);
      expect(hasOpenPickerButton).toBe(false);
      expect(wsRequests.some((request) => request._tag === WS_METHODS.shellOpenInEditor)).toBe(
        false,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the source update badge beside Settings when the tracked branch is behind", async () => {
    const sourceUpdateState: DesktopSourceUpdateState = {
      status: "behind",
      branch: "dev",
      trackedBranch: "dev",
      runtimeHash: "1111111111111111111111111111111111111111",
      localHash: "1111111111111111111111111111111111111111",
      remoteHash: "2222222222222222222222222222222222222222",
      mergeBaseHash: "1111111111111111111111111111111111111111",
      dirty: false,
      checkedAt: "2026-06-02T00:00:00.000Z",
      message: null,
    };
    window.desktopBridge = createDesktopBridgeForChatViewTests(sourceUpdateState);

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.make("titlebar-preview"),
        targetText: "Move the tabs into the top window bar.",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode"],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const updateBadge = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("[data-slot='badge']")).find(
            (element) => element.textContent?.trim() === "Newer dev",
          ) as HTMLElement | null,
        "Unable to find passive source update badge.",
      );
      expect(updateBadge.getAttribute("title")).toContain("Newer origin/dev commit available");
      expect(updateBadge.closest('[data-sidebar="menu-item"]')?.textContent).toContain("Settings");
      expect(updateBadge.closest('[data-chat-view-header="true"]')).toBeNull();
      expect(
        document.querySelector('[data-chat-view-header="true"] button[aria-label="Copy options"]'),
      ).toBeNull();
      expect(
        document.querySelector('[data-chat-view-header="true"] .desk-group-bar'),
      ).not.toBeNull();
      await page.screenshot({
        path: "../../../../.explorations/titlebar-visual/source-badge-footer.png",
      });
      await page.getByRole("tab").first().click({ button: "right" });
      await expect.element(page.getByRole("menuitem", { name: "Open", exact: true })).toBeVisible();
      await page.getByRole("menuitem", { name: "Open", exact: true }).hover();
      await expect
        .element(page.getByRole("menuitem", { name: "VS Code", exact: true }))
        .toBeVisible();
      await page.screenshot({
        path: "../../../../.explorations/titlebar-visual/open-context-menu.png",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows a passive rebuild badge when the checkout hash differs from the running build", async () => {
    setDraftThreadWithoutWorktree();
    const sourceUpdateState: DesktopSourceUpdateState = {
      status: "current",
      branch: "dev",
      trackedBranch: "dev",
      runtimeHash: "1111111111111111111111111111111111111111",
      localHash: "2222222222222222222222222222222222222222",
      remoteHash: "2222222222222222222222222222222222222222",
      mergeBaseHash: "2222222222222222222222222222222222222222",
      dirty: false,
      checkedAt: "2026-06-02T00:00:00.000Z",
      message: "This checkout is current with origin.",
    };
    window.desktopBridge = createDesktopBridgeForChatViewTests(sourceUpdateState);

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode"],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const updateBadge = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("[data-slot='badge']")).find(
            (element) => element.textContent?.trim() === "Rebuild to apply (dev)",
          ) as HTMLElement | null,
        "Unable to find passive rebuild badge.",
      );
      expect(updateBadge.getAttribute("title")).toContain("Rebuild and restart to apply dev");
      expect(updateBadge.closest('[data-sidebar="menu-item"]')?.textContent).toContain("Settings");
    } finally {
      await mounted.cleanup();
    }
  });

  it("lets the server own setup after preparing a pull request worktree thread", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [THREAD_KEY]: {
          threadId: THREAD_ID,
          environmentId: LOCAL_ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          logicalProjectKey: PROJECT_DRAFT_KEY,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [PROJECT_DRAFT_KEY]: THREAD_KEY,
      },
    });

    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: withProjectScripts(createDraftOnlySnapshot(), [
        {
          id: "setup",
          name: "Setup",
          command: "yarn install --immutable",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ]),
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.gitResolvePullRequest) {
          return {
            pullRequest: {
              number: 1359,
              title: "Add thread archiving and settings navigation",
              url: "https://github.com/cafeai/cafe-code/pull/1359",
              baseBranch: "main",
              headBranch: "archive-settings-overhaul",
              state: "open",
            },
          };
        }
        if (body._tag === WS_METHODS.gitPreparePullRequestThread) {
          return {
            pullRequest: {
              number: 1359,
              title: "Add thread archiving and settings navigation",
              url: "https://github.com/cafeai/cafe-code/pull/1359",
              baseBranch: "main",
              headBranch: "archive-settings-overhaul",
              state: "open",
            },
            branch: "archive-settings-overhaul",
            worktreePath: "/repo/worktrees/pr-1359",
          };
        }
        return undefined;
      },
    });

    try {
      const branchButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "main",
          ) as HTMLButtonElement | null,
        "Unable to find branch selector button.",
      );
      branchButton.click();

      const branchInput = await waitForElement(
        () => document.querySelector<HTMLInputElement>('input[placeholder="Search refs..."]'),
        "Unable to find ref search input.",
      );
      branchInput.focus();
      await page.getByPlaceholder("Search refs...").fill("1359");

      const checkoutItem = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("span")).find(
            (element) => element.textContent?.trim() === "Checkout pull request",
          ) as HTMLSpanElement | null,
        "Unable to find checkout pull request option.",
      );
      checkoutItem.click();

      const worktreeButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Worktree",
          ) as HTMLButtonElement | null,
        "Unable to find Worktree button.",
      );
      worktreeButton.click();

      await vi.waitFor(
        () => {
          const prepareRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.gitPreparePullRequestThread,
          );
          expect(prepareRequest).toMatchObject({
            _tag: WS_METHODS.gitPreparePullRequestThread,
            cwd: "/repo/project",
            reference: "1359",
            mode: "worktree",
            threadId: THREAD_ID,
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("carries the computer-use switch through first-send worktree bootstrap before any separate turn", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [THREAD_KEY]: {
          threadId: THREAD_ID,
          environmentId: LOCAL_ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          logicalProjectKey: PROJECT_DRAFT_KEY,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          envMode: "worktree",
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [PROJECT_DRAFT_KEY]: THREAD_KEY,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withProjectScripts(createDraftOnlySnapshot(), [
        {
          id: "setup",
          name: "Setup",
          command: "yarn install --immutable",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ]),
      resolveRpc: (body) => {
        if (body._tag === "glide.control")
          return {
            available: true,
            connected: false,
            enabled: false,
            fullAccess: false,
            busy: false,
            paused: false,
            accessibility: true,
            screenRecording: true,
            apps: [],
            runningApps: [],
            message: "Background desktop control",
          };
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: chatViewFixture.fixture.snapshot.snapshotSequence + 1,
          };
        }
        return undefined;
      },
    });

    try {
      const computerUse = page.getByRole("button", { name: "Computer use", exact: true });
      await expect.element(computerUse).toBeEnabled();
      await computerUse.click();
      await expect.element(computerUse).toHaveAttribute("aria-pressed", "true");
      await page
        .elementLocator(document.querySelector('[data-chat-composer-form="true"]')!)
        .screenshot({ path: "../../../../.logs/computer-use-new-thread.png" });
      expect(
        wsRequests.some((request) => request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand),
      ).toBe(false);
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Ship it");
      await waitForLayout();

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          const dispatchRequest = wsRequests.find(
            (request) => request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand,
          ) as
            | {
                _tag: string;
                type?: string;
                bootstrap?: {
                  createThread?: { projectId?: string };
                  prepareWorktree?: { projectCwd?: string; baseBranch?: string; branch?: string };
                  runSetupScript?: boolean;
                };
              }
            | undefined;
          expect(dispatchRequest).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "thread.turn.start",
            bootstrap: {
              createThread: {
                computerUseEnabled: true,
                projectId: PROJECT_ID,
              },
              prepareWorktree: {
                projectCwd: "/repo/project",
                baseBranch: "main",
                branch: expect.stringMatching(/^cafecode\/[0-9a-f]{8}$/),
              },
              runSetupScript: true,
            },
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      expect(wsRequests.some((request) => request._tag === WS_METHODS.vcsCreateWorktree)).toBe(
        false,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps custom provider instance ids when bootstrapping a local draft thread", async () => {
    setDraftThreadWithoutWorktree();
    const openRouterInstanceId = ProviderInstanceId.make("claude_openrouter");
    const openRouterSelection = createModelSelection(openRouterInstanceId, "openai/gpt-5.5");
    useComposerDraftStore.getState().setModelSelection(THREAD_REF, openRouterSelection);

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          providers: [
            ...nextFixture.serverConfig.providers,
            {
              driver: ProviderDriverKind.make("claudeAgent"),
              instanceId: ProviderInstanceId.make("claudeAgent"),
              enabled: true,
              installed: true,
              version: "2.1.117",
              status: "ready",
              auth: { status: "authenticated" },
              checkedAt: NOW_ISO,
              models: [
                {
                  slug: "claude-opus-4-7",
                  name: "Claude Opus 4.7",
                  isCustom: false,
                  capabilities: createModelCapabilities({ optionDescriptors: [] }),
                },
              ],
              slashCommands: [],
              skills: [],
            },
            {
              driver: ProviderDriverKind.make("claudeAgent"),
              instanceId: openRouterInstanceId,
              displayName: "Claude OpenRouter",
              enabled: true,
              installed: true,
              version: "2.1.117",
              status: "ready",
              auth: { status: "authenticated" },
              checkedAt: NOW_ISO,
              models: [
                {
                  slug: "claude-opus-4-7",
                  name: "Claude Opus 4.7",
                  isCustom: false,
                  capabilities: createModelCapabilities({ optionDescriptors: [] }),
                },
              ],
              slashCommands: [],
              skills: [],
            },
          ],
          settings: {
            ...nextFixture.serverConfig.settings,
            providerInstances: {
              ...nextFixture.serverConfig.settings.providerInstances,
              [openRouterInstanceId]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                displayName: "Claude OpenRouter",
                config: { customModels: ["openai/gpt-5.5"] },
              },
            },
          },
        };
      },
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: chatViewFixture.fixture.snapshot.snapshotSequence + 1,
          };
        }
        return undefined;
      },
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Hello there");
      await waitForLayout();

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          const turnStartRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.turn.start",
          ) as
            | {
                modelSelection?: { instanceId?: string; model?: string };
                bootstrap?: {
                  createThread?: {
                    modelSelection?: { instanceId?: string; model?: string };
                  };
                };
              }
            | undefined;

          expect(turnStartRequest?.modelSelection).toMatchObject({
            instanceId: openRouterInstanceId,
            model: "openai/gpt-5.5",
          });
          expect(turnStartRequest?.bootstrap?.createThread?.modelSelection).toMatchObject({
            instanceId: openRouterInstanceId,
            model: "openai/gpt-5.5",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("dispatches Sol Ultra from the exact custom Codex instance", async () => {
    setDraftThreadWithoutWorktree();
    const zkmInstanceId = ProviderInstanceId.make("codex_codex_astrea_zkm");
    const solModel = {
      slug: "gpt-5.6-sol",
      name: "GPT-5.6-Sol",
      isCustom: false,
      capabilities: createModelCapabilities({
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select" as const,
            currentValue: "low",
            options: [
              { id: "low", label: "Low", isDefault: true },
              { id: "ultra", label: "Ultra" },
            ],
          },
        ],
      }),
    };

    // Reproduce the historical failure shape: the default Codex bucket has
    // Low while the selected custom account explicitly has Ultra. Reading
    // traits through the driver-kind key would send Low for the ZKM turn.
    useComposerDraftStore
      .getState()
      .setModelSelection(
        THREAD_REF,
        createModelSelection(ProviderInstanceId.make("codex"), solModel.slug, [
          { id: "reasoningEffort", value: "low" },
        ]),
      );
    useComposerDraftStore
      .getState()
      .setModelSelection(
        THREAD_REF,
        createModelSelection(zkmInstanceId, solModel.slug, [
          { id: "reasoningEffort", value: "ultra" },
        ]),
      );

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          providers: [
            ...nextFixture.serverConfig.providers,
            {
              driver: ProviderDriverKind.make("codex"),
              instanceId: zkmInstanceId,
              displayName: "Codex Astrea ZKM",
              enabled: true,
              installed: true,
              version: "0.144.6",
              status: "ready",
              auth: { status: "authenticated" },
              checkedAt: NOW_ISO,
              models: [solModel],
              slashCommands: [],
              skills: [],
            },
          ],
          settings: {
            ...nextFixture.serverConfig.settings,
            providerInstances: {
              ...nextFixture.serverConfig.settings.providerInstances,
              [zkmInstanceId]: {
                driver: ProviderDriverKind.make("codex"),
                displayName: "Codex Astrea ZKM",
              },
            },
          },
        };
      },
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: chatViewFixture.fixture.snapshot.snapshotSequence + 1,
          };
        }
        return undefined;
      },
    });

    try {
      await mounted.setContainerSize(WIDE_FOOTER_VIEWPORT);
      await vi.waitFor(() => {
        const footer = document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]');
        const optionsButton = footer?.querySelector<HTMLButtonElement>(
          'button[aria-label="More composer controls"]',
        );
        const traitsLabel = optionsButton?.querySelector<HTMLElement>(
          '[data-compact-composer-controls-label="true"]',
        );
        expect(footer?.dataset.chatComposerFooterCompact).toBe("false");
        expect(traitsLabel?.textContent).toBe("Ultra");
        expect(optionsButton?.textContent).not.toContain("Full access");
      });

      await mounted.setContainerSize(COMPACT_FOOTER_VIEWPORT);
      await vi.waitFor(() => {
        const footer = document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]');
        const traitsLabel = document.querySelector<HTMLElement>(
          '[data-compact-composer-controls-label="true"]',
        );
        expect(footer?.dataset.chatComposerFooterCompact).toBe("true");
        expect(traitsLabel?.textContent).toBe("Ultra");
      });

      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Keep this turn on Ultra");
      await waitForLayout();

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          const turnStartRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.turn.start",
          ) as
            | {
                modelSelection?: {
                  instanceId?: string;
                  model?: string;
                  options?: ReadonlyArray<{ id?: string; value?: string | boolean }>;
                };
              }
            | undefined;

          expect(turnStartRequest?.modelSelection).toMatchObject({
            instanceId: zkmInstanceId,
            model: "gpt-5.6-sol",
            options: expect.arrayContaining([{ id: "reasoningEffort", value: "ultra" }]),
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps new-worktree mode on empty server threads and bootstraps the first send", async () => {
    const snapshot = addThreadToSnapshot(createDraftOnlySnapshot(), THREAD_ID);
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        threads: snapshot.threads.map((thread) =>
          thread.id === THREAD_ID ? Object.assign({}, thread, { session: null }) : thread,
        ),
      },
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.vcsListRefs) {
          return {
            isRepo: true,
            hasPrimaryRemote: true,
            nextCursor: null,
            totalCount: 1,
            refs: [
              {
                name: "main",
                current: true,
                isDefault: true,
                worktreePath: null,
              },
            ],
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
      (await waitForButtonByText("Current checkout")).click();
      await page.getByText("New worktree", { exact: true }).click();

      await vi.waitFor(
        () => {
          expect(findButtonByText("New worktree")).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );

      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Ship it");
      await waitForLayout();

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          const turnStartRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.turn.start",
          ) as
            | {
                _tag: string;
                type?: string;
                bootstrap?: {
                  createThread?: { projectId?: string };
                  prepareWorktree?: { projectCwd?: string; baseBranch?: string; branch?: string };
                  runSetupScript?: boolean;
                };
              }
            | undefined;

          expect(turnStartRequest).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "thread.turn.start",
            bootstrap: {
              prepareWorktree: {
                projectCwd: "/repo/project",
                baseBranch: "main",
                branch: expect.stringMatching(/^cafecode\/[0-9a-f]{8}$/),
              },
              runSetupScript: true,
            },
          });
          expect(turnStartRequest?.bootstrap?.createThread).toBeUndefined();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("updates the selected worktree base branch on empty server threads", async () => {
    const snapshot = addThreadToSnapshot(createDraftOnlySnapshot(), THREAD_ID);
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        threads: snapshot.threads.map((thread) =>
          thread.id === THREAD_ID ? Object.assign({}, thread, { session: null }) : thread,
        ),
      },
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.vcsListRefs) {
          return {
            isRepo: true,
            hasPrimaryRemote: true,
            nextCursor: null,
            totalCount: 2,
            refs: [
              {
                name: "main",
                current: true,
                isDefault: true,
                worktreePath: null,
              },
              {
                name: "release/next",
                current: false,
                isDefault: false,
                worktreePath: null,
              },
            ],
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
      (await waitForButtonByText("Current checkout")).click();
      await page.getByText("New worktree", { exact: true }).click();
      await page.getByText("From main", { exact: true }).click();
      await page.getByText("release/next", { exact: true }).click();

      await vi.waitFor(
        () => {
          expect(findButtonByText("From release/next")).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );

      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Ship it");
      await waitForLayout();

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          const turnStartRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.turn.start",
          ) as
            | {
                _tag: string;
                type?: string;
                bootstrap?: {
                  prepareWorktree?: { baseBranch?: string };
                };
              }
            | undefined;

          expect(turnStartRequest?.bootstrap?.prepareWorktree?.baseBranch).toBe("release/next");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("clears pending worktree overrides when switching empty server threads", async (testContext) => {
    const owner = createChatViewCallerOwner(testContext, mountChatView, {
      label: "worktree-overrides",
    });
    await owner.run(async () => {
      const secondThreadId = "thread-browser-test-second" as ThreadId;
      const snapshot = addThreadToSnapshot(createDraftOnlySnapshot(), THREAD_ID);
      const snapshotWithSecondThread = addThreadToSnapshot(snapshot, secondThreadId);
      const snapshotWithTwoThreads = {
        ...snapshotWithSecondThread,
        threads: snapshotWithSecondThread.threads.map((thread) => {
          if (thread.id === THREAD_ID) {
            return Object.assign({}, thread, { session: null, title: "Thread alpha" });
          }
          if (thread.id === secondThreadId) {
            return Object.assign({}, thread, { session: null, title: "Thread beta" });
          }
          return thread;
        }),
      };
      const mounted = await owner.mount({
        viewport: DEFAULT_VIEWPORT,
        snapshot: snapshotWithTwoThreads,
        resolveRpc: (body) => {
          if (body._tag === WS_METHODS.vcsListRefs) {
            return {
              isRepo: true,
              hasPrimaryRemote: true,
              nextCursor: null,
              totalCount: 2,
              refs: [
                {
                  name: "main",
                  current: true,
                  isDefault: true,
                  worktreePath: null,
                },
                {
                  name: "release/next",
                  current: false,
                  isDefault: false,
                  worktreePath: null,
                },
              ],
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

      const currentCheckout = await owner.own("controls", () =>
        waitForButtonByText("Current checkout"),
      );
      owner.assertActive();
      currentCheckout.click();
      owner.mark("controls");
      await owner.own("controls", () => page.getByText("New worktree", { exact: true }).click());
      await owner.own("controls", () => page.getByText("From main", { exact: true }).click());
      await owner.own("controls", () => page.getByText("release/next", { exact: true }).click());

      await owner.own("value", () =>
        vi.waitFor(
          () => {
            expect(findButtonByText("From release/next")).toBeTruthy();
          },
          { timeout: 8_000, interval: 16 },
        ),
      );

      await owner.own("route", () =>
        mounted.router.navigate({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: LOCAL_ENVIRONMENT_ID,
            threadId: secondThreadId,
          },
        }),
      );

      await owner.own("route", () =>
        waitForURL(
          mounted.router,
          (path) => path === serverThreadPath(secondThreadId),
          "Route should switch to the second empty server thread.",
        ),
      );

      await owner.own("value", () =>
        vi.waitFor(
          () => {
            expect(findButtonByText("Current checkout")).toBeTruthy();
            expect(findButtonByText("From release/next")).toBeNull();
          },
          { timeout: 8_000, interval: 16 },
        ),
      );

      const nextCheckout = await owner.own("controls", () =>
        waitForButtonByText("Current checkout"),
      );
      owner.assertActive();
      nextCheckout.click();
      owner.mark("controls");
      await owner.own("controls", () => page.getByText("New worktree", { exact: true }).click());

      await owner.own("value", () =>
        vi.waitFor(
          () => {
            expect(findButtonByText("From main")).toBeTruthy();
            expect(findButtonByText("From release/next")).toBeNull();
          },
          { timeout: 8_000, interval: 16 },
        ),
      );
    });
  });

  it("shows the send state once bootstrap dispatch is in flight", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [THREAD_KEY]: {
          threadId: THREAD_ID,
          environmentId: LOCAL_ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          logicalProjectKey: PROJECT_DRAFT_KEY,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          envMode: "worktree",
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [PROJECT_DRAFT_KEY]: THREAD_KEY,
      },
    });

    let resolveDispatch!: (value: { sequence: number }) => void;
    const dispatchPromise = new Promise<{ sequence: number }>((resolve) => {
      resolveDispatch = resolve;
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withProjectScripts(createDraftOnlySnapshot(), [
        {
          id: "setup",
          name: "Setup",
          command: "yarn install --immutable",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ]),
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return dispatchPromise;
        }
        return undefined;
      },
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Ship it");
      await waitForLayout();

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          expect(
            wsRequests.some((request) => request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand),
          ).toBe(true);
          expect(document.querySelector('button[aria-label="Sending"]')).toBeTruthy();
          expect(document.querySelector('button[aria-label="Preparing worktree"]')).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      resolveDispatch({ sequence: chatViewFixture.fixture.snapshot.snapshotSequence + 1 });
      await mounted.cleanup();
    }
  });

  it("restores rejected direct sends and reports every delivery attempt before a successful retry", async () => {
    const messageText = "Retry this exact direct message";
    const privateRequestId = "synthetic-private-provider-receipt";
    const repeatedFailure = `stream disconnected before completion: request ID ${privateRequestId}`;
    let turnStartAttempts = 0;
    const dispatchedMessageTexts: string[] = [];
    const closeToastSpy = vi.spyOn(toastManager, "close");
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-direct-send-retry" as MessageId,
        targetText: "direct send retry target",
      }),
      resolveRpc: (body) => {
        if (
          body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
          body.type === "thread.turn.start"
        ) {
          turnStartAttempts += 1;
          const message = body.message as { text?: unknown } | undefined;
          if (typeof message?.text === "string") {
            dispatchedMessageTexts.push(message.text);
          }
          if (turnStartAttempts <= 2) {
            return failBrowserWsRpc(
              new OrchestrationDispatchCommandError({ message: repeatedFailure }),
            );
          }
        }
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: chatViewFixture.fixture.snapshot.snapshotSequence + turnStartAttempts + 1,
          };
        }
        return undefined;
      },
    });

    const findOptimisticMessage = () =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-message-role="user"]')).filter(
        (element) => element.textContent?.includes(messageText),
      );

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_REF, messageText);
      await waitForLayout();

      (await waitForSendButton()).click();
      await vi.waitFor(
        () => {
          expect(turnStartAttempts).toBe(1);
          expect(findOptimisticMessage()).toHaveLength(0);
          expect(
            document.querySelector<HTMLElement>('[data-testid="composer-editor"]')?.textContent,
          ).toBe(messageText);
          expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(
            messageText,
          );
          expect(document.body.textContent).toContain("Failed to send message.");
          expect(findSendFailureToastTitle()).not.toBeNull();
          expect(document.body.textContent).not.toContain(privateRequestId);
          expect(
            [...document.querySelectorAll("[title]")].some((element) =>
              element.getAttribute("title")?.includes(privateRequestId),
            ),
          ).toBe(false);
        },
        { timeout: 8_000, interval: 16 },
      );

      // Dismiss both presentations from the first occurrence. The stable
      // thread banner intentionally remembers this exact error, while the
      // notification is occurrence-based and must return for the next press.
      document.querySelector<HTMLButtonElement>('button[aria-label="Dismiss error"]')?.click();
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Dismiss notification"]')
        ?.click();
      await vi.waitFor(
        () => {
          expect(document.querySelector('button[aria-label="Dismiss error"]')).toBeNull();
          expect(findSendFailureToastTitle()).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );

      (await waitForSendButton()).click();
      await vi.waitFor(
        () => {
          expect(turnStartAttempts).toBe(2);
          expect(findSendFailureToastTitle()).not.toBeNull();
          // The dismissed banner remains suppressed, proving the new toast
          // is what makes an identical second rejection visible.
          expect(document.querySelector('button[aria-label="Dismiss error"]')).toBeNull();
          expect(findOptimisticMessage()).toHaveLength(0);
          expect(
            document.querySelector<HTMLElement>('[data-testid="composer-editor"]')?.textContent,
          ).toBe(messageText);
          expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(
            messageText,
          );
        },
        { timeout: 8_000, interval: 16 },
      );

      // A third press succeeds. The restored draft is consumed exactly once
      // and its optimistic row remains until the canonical snapshot arrives.
      const closeCountBeforeSuccessfulRetry = closeToastSpy.mock.calls.length;
      (await waitForSendButton()).click();
      await vi.waitFor(
        () => {
          expect(turnStartAttempts).toBe(3);
          expect(closeToastSpy.mock.calls).toHaveLength(closeCountBeforeSuccessfulRetry + 1);
          expect(findOptimisticMessage()).toHaveLength(1);
          expect(
            document.querySelector<HTMLElement>('[data-testid="composer-editor"]')?.textContent ??
              "",
          ).toBe("");
          expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt ?? "").toBe(
            "",
          );
          expect(dispatchedMessageTexts).toEqual([messageText, messageText, messageText]);
          expect(findSendFailureToastTitle()).toBeNull();
          expect(document.querySelector('button[aria-label="Dismiss error"]')).toBeNull();
          expect(document.body.textContent).not.toContain("Failed to send message.");
        },
        // The toast manager's normal auto-dismiss is much longer than this
        // bound. Passing here therefore proves the successful dispatch
        // closed the stale failure notification instead of merely waiting
        // for its timer to expire.
        { timeout: 2_000, interval: 16 },
      );
    } finally {
      closeToastSpy.mockRestore();
      await mounted.cleanup();
    }
  });

  it("restores composer focus after a send completes", async () => {
    let resolveDispatch!: (value: { sequence: number }) => void;
    let dispatchResolved = false;
    const dispatchPromise = new Promise<{ sequence: number }>((resolve) => {
      resolveDispatch = resolve;
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-focus-after-send" as MessageId,
        targetText: "focus after send target",
      }),
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return dispatchPromise;
        }
        return undefined;
      },
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Keep the composer focused");
      await waitForLayout();

      const editor = await waitForComposerEditor();
      editor.focus();
      await waitForLayout();
      expect(document.activeElement).toBe(editor);

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          expect(
            wsRequests.some((request) => request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand),
          ).toBe(true);
          expect(document.querySelector('button[aria-label="Sending"]')).toBeTruthy();
          const currentEditor = document.querySelector<HTMLElement>(
            '[data-testid="composer-editor"]',
          );
          expect(currentEditor?.getAttribute("contenteditable")).toBe("false");
        },
        { timeout: 8_000, interval: 16 },
      );

      const acknowledgedTurnId = "turn-focus-after-send" as TurnId;
      const baseThread = chatViewFixture.fixture.snapshot.threads[0]!;
      const baseSession = baseThread.session!;
      const acknowledgedThread: OrchestrationReadModel["threads"][number] = {
        ...baseThread,
        latestTurn: {
          turnId: acknowledgedTurnId,
          state: "running" as const,
          requestedAt: isoAt(1_000),
          startedAt: isoAt(1_001),
          completedAt: null,
          assistantMessageId: null,
        },
        session: {
          ...baseSession,
          status: "running" as const,
          activeTurnId: acknowledgedTurnId,
          updatedAt: isoAt(1_001),
        },
        updatedAt: isoAt(1_001),
      };
      chatViewFixture.fixture.snapshot = {
        ...chatViewFixture.fixture.snapshot,
        snapshotSequence: chatViewFixture.fixture.snapshot.snapshotSequence + 1,
        threads: [acknowledgedThread],
      };
      dispatchResolved = true;
      resolveDispatch({ sequence: chatViewFixture.fixture.snapshot.snapshotSequence });
      rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
        kind: "snapshot",
        snapshot: {
          snapshotSequence: chatViewFixture.fixture.snapshot.snapshotSequence,
          thread: acknowledgedThread,
        },
      });

      await vi.waitFor(
        () => {
          const currentEditor = document.querySelector<HTMLElement>(
            '[data-testid="composer-editor"]',
          );
          expect(currentEditor?.getAttribute("contenteditable")).toBe("true");
          expect(document.activeElement).toBe(currentEditor);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      if (!dispatchResolved) {
        resolveDispatch({ sequence: chatViewFixture.fixture.snapshot.snapshotSequence + 1 });
      }
      await mounted.cleanup();
    }
  });

  it.for([
    { provider: "codex", sessionStatus: "ready" },
    { provider: "claudeAgent", sessionStatus: "ready" },
    { provider: "codex", sessionStatus: "running" },
    { provider: "claudeAgent", sessionStatus: "running" },
  ] as const)(
    "sends an image without text to $provider in a $sessionStatus chat",
    async ({ provider, sessionStatus }, testContext) => {
      let restorePicker: (() => void) | undefined;
      const owner = createChatViewCallerOwner(testContext, mountChatView, {
        label: "image-only-send",
        afterUnmount: () => {
          restorePicker?.();
        },
      });
      await owner.run(async () => {
        await owner.mount({
          viewport: DEFAULT_VIEWPORT,
          snapshot: createSnapshotForTargetUser({
            targetMessageId: "msg-user-attach-image" as MessageId,
            targetText: "attach image target",
            provider,
            sessionStatus,
          }),
          resolveRpc: (body) =>
            body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand
              ? { sequence: chatViewFixture.fixture.snapshot.snapshotSequence + 1 }
              : undefined,
          configureFixture: (nextFixture) => {
            nextFixture.serverConfig = {
              ...nextFixture.serverConfig,
              providers: [
                {
                  ...nextFixture.serverConfig.providers[0]!,
                  driver: ProviderDriverKind.make(provider),
                  instanceId: ProviderInstanceId.make(provider),
                },
              ],
            };
          },
        });

        await owner.own("editor", () => waitForComposerEditor());

        const attachButton = await owner.own("picker", () =>
          waitForElement(
            () =>
              document.querySelector<HTMLButtonElement>(
                '[data-chat-composer-form="true"] button[aria-label="Attach files or images"]',
              ),
            "Unable to find composer attach-image button.",
          ),
        );

        const fileInput = document.querySelector<HTMLInputElement>(
          '[data-chat-composer-form="true"] input[type="file"]',
        );
        expect(fileInput).toBeTruthy();
        expect(fileInput!.accept).toBe("");
        expect(fileInput!.multiple).toBe(true);

        // Tapping the button forwards to the hidden file input's native picker.
        let pickerOpened = false;
        const originalClick = fileInput!.click.bind(fileInput!);
        const ownedPickerClick = () => {
          pickerOpened = true;
        };
        restorePicker = () => {
          // Restore only this exact fixture's override, after admitted actions
          // drain; the original normal-path restoration remains below.
          if (fileInput!.click === ownedPickerClick) fileInput!.click = originalClick;
        };
        owner.assertActive();
        fileInput!.click = ownedPickerClick;
        attachButton.click();
        owner.mark("picker");
        expect(pickerOpened).toBe(true);
        fileInput!.click = originalClick;

        // Simulate the user choosing a file from the native picker.
        const transfer = new DataTransfer();
        transfer.items.add(
          new File([new Uint8Array([1, 2, 3, 4])], "diagram.png", { type: "image/png" }),
        );
        fileInput!.files = transfer.files;
        fileInput!.dispatchEvent(new Event("change", { bubbles: true }));

        // The chosen image shows up in the composer preview strip.
        await owner.own("preview", () =>
          waitForElement(
            () =>
              document.querySelector<HTMLButtonElement>('button[aria-label="Preview diagram.png"]'),
            "Unable to find attached image preview.",
          ),
        );
        await owner.own("attachments", () =>
          waitForElement(
            () =>
              document.querySelector<HTMLButtonElement>('button[aria-label="Remove diagram.png"]'),
            "Unable to find attached image remove control.",
          ),
        );

        await owner.own("send", () =>
          page
            .getByRole("button", {
              name: sessionStatus === "running" ? "Queue message" : "Send message",
              exact: true,
            })
            .click(),
        );
        if (sessionStatus === "running") {
          await owner.own("draft", () =>
            vi.waitFor(() => {
              const saved = createFollowUpQueuePersistence().load(LOCAL_ENVIRONMENT_ID);
              expect(saved.ok && saved.value.pending[0]).toMatchObject({
                promptText: "",
                images: [{ name: "diagram.png" }],
              });
            }),
          );
          expect(wsRequests.some((request) => request.type === "thread.turn.start")).toBe(false);
          const readyThread = {
            ...chatViewFixture.fixture.snapshot.threads[0]!,
            session: {
              ...chatViewFixture.fixture.snapshot.threads[0]!.session!,
              status: "ready" as const,
            },
          };
          chatViewFixture.fixture.snapshot = {
            ...chatViewFixture.fixture.snapshot,
            snapshotSequence: chatViewFixture.fixture.snapshot.snapshotSequence + 1,
            threads: [readyThread],
          };
          rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
            kind: "snapshot",
            snapshot: {
              snapshotSequence: chatViewFixture.fixture.snapshot.snapshotSequence,
              thread: readyThread,
            },
          });
          owner.mark("snapshot");
        }
        await owner.own("request", () =>
          vi.waitFor(
            () => {
              const requests = wsRequests.filter((request) => request.type === "thread.turn.start");
              expect(requests).toHaveLength(1);
              expect(requests[0]).toMatchObject({
                message: {
                  text: "",
                  attachments: [
                    {
                      type: "image",
                      name: "diagram.png",
                      dataUrl: "data:image/png;base64,AQIDBA==",
                    },
                  ],
                },
                modelSelection: { instanceId: provider },
              });
            },
            { timeout: 8_000, interval: 16 },
          ),
        );
        expect(document.body.textContent).not.toContain("User attached one or more images");
      });
    },
  );

  it("exposes the attach-image button in the mobile keyboard overlay", async () => {
    // Headless Chromium reports a fine pointer, so force the touch media query
    // the composer uses to detect on-screen-keyboard devices.
    const restoreTouchMediaQuery = forceOnScreenKeyboardMediaQuery();
    const mounted = await mountChatView({
      viewport: COMPACT_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-mobile-attach-image" as MessageId,
        targetText: "mobile attach image target",
      }),
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "attach on mobile");
      await waitForLayout();

      const expandButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Expand composer"]'),
        "Unable to find compact composer expand button.",
      );
      expandButton.click();

      // Focusing opens the on-screen-keyboard overlay, which hides the footer
      // and surfaces the attach control alongside the primary action so touch
      // users can add an image without a paste/drag affordance.
      const overlayAttachButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            '[data-chat-composer-mobile-pending-actions="true"] button[aria-label="Attach files or images"]',
          ),
        "Unable to find mobile overlay attach-image button.",
      );

      const fileInput = document.querySelector<HTMLInputElement>(
        '[data-chat-composer-form="true"] input[type="file"]',
      );
      expect(fileInput).toBeTruthy();

      let pickerOpened = false;
      const originalClick = fileInput!.click.bind(fileInput!);
      fileInput!.click = () => {
        pickerOpened = true;
      };
      overlayAttachButton.click();
      expect(pickerOpened).toBe(true);
      fileInput!.click = originalClick;
    } finally {
      await mounted.cleanup();
      restoreTouchMediaQuery();
    }
  });

  it("shows an attachment count pill in the collapsed mobile composer", async () => {
    const restoreTouchMediaQuery = forceOnScreenKeyboardMediaQuery();
    const mounted = await mountChatView({
      viewport: COMPACT_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-mobile-attachment-pill" as MessageId,
        targetText: "mobile attachment pill target",
      }),
    });

    try {
      const file = new File([new Uint8Array([1, 2, 3, 4])], "diagram.png", { type: "image/png" });
      useComposerDraftStore.getState().addImage(THREAD_REF, {
        type: "image",
        id: "composer-image-pill",
        name: "diagram.png",
        mimeType: "image/png",
        sizeBytes: file.size,
        previewUrl: URL.createObjectURL(file),
        file,
      });
      await waitForLayout();

      // Collapsed (keyboard down) hides the preview strip, so the count pill is
      // the only signal the attachment is still there.
      const pill = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
            button.getAttribute("aria-label")?.includes("1 attachment attached"),
          ) ?? null,
        "Unable to find collapsed-composer attachment pill.",
      );
      expect(pill.textContent).toContain("1 attachment");

      // Tapping it expands the composer so the attachment can be managed.
      pill.click();
      await vi.waitFor(
        () => {
          const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]');
          expect(editor?.getAttribute("contenteditable")).toBe("true");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
      restoreTouchMediaQuery();
    }
  });

  it("locks the composer while the provider session is starting", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-provider-starting" as MessageId,
        targetText: "provider starting",
        history: "essential",
        sessionStatus: "starting",
      }),
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "follow-up while starting");
      await waitForLayout();

      await vi.waitFor(
        () => {
          const connectingButton = document.querySelector<HTMLButtonElement>(
            'button[aria-label="Connecting"]',
          );
          expect(connectingButton).toBeTruthy();
          expect(connectingButton?.disabled).toBe(true);
          expect(connectingButton?.querySelector(".animate-spin")).toBeTruthy();

          const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]');
          expect(editor).toBeTruthy();
          expect(editor?.getAttribute("contenteditable")).toBe("false");
        },
        { timeout: 8_000, interval: 16 },
      );
      await expect.element(page.getByText("Starting Codex...")).toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("toggles plan mode with Shift+Tab only while the composer is focused", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-target-hotkey" as MessageId,
        targetText: "hotkey target",
        history: "essential",
      }),
    });

    try {
      await expectComposerInteractionMode("Build");
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();

      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await waitForLayout();

      await expectComposerInteractionMode("Build");

      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await expectComposerInteractionMode("Plan");

      composerEditor.focus();
      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await expectComposerInteractionMode("Build");
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps Claude permission modes in options and cycles them with Shift+Tab", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-target-claude-mode-hotkey" as MessageId,
        targetText: "claude mode hotkey target",
        history: "essential",
        provider: "claudeAgent",
        runtimeMode: "approval-required",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          providers: [
            ...nextFixture.serverConfig.providers,
            {
              driver: ProviderDriverKind.make("claudeAgent"),
              instanceId: ProviderInstanceId.make("claudeAgent"),
              enabled: true,
              installed: true,
              version: "2.1.216",
              status: "ready",
              auth: { status: "authenticated" },
              checkedAt: NOW_ISO,
              models: [
                {
                  slug: "claude-opus-4-8",
                  name: "Claude Opus 4.8",
                  isCustom: false,
                  capabilities: createModelCapabilities({ optionDescriptors: [] }),
                },
              ],
              slashCommands: [],
              skills: [],
            },
          ],
        };
      },
    });

    try {
      const footer = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]'),
        "Unable to find composer footer.",
      );
      expect(
        Array.from(footer.querySelectorAll("button")).some((button) =>
          ["Ask permissions", "Accept edits", "Plan", "Auto", "Bypass permissions"].includes(
            button.textContent?.trim() ?? "",
          ),
        ),
      ).toBe(false);

      await page.getByRole("button", { name: "More composer controls", exact: true }).click();
      // Routine descriptions moved into tooltips; Bypass keeps its warning visible.
      await waitForMenuRadioItemContainingText("Ask permissions");
      await waitForMenuRadioItemContainingText("Accept edits");
      expect(
        (await waitForMenuRadioItemContainingText("Bypass permissions")).textContent,
      ).toContain("Run without permission checks");
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => {
        expect(document.querySelector('[data-slot="menu-popup"]')).toBeNull();
      });

      const composerEditor = await waitForComposerEditor();
      const expectedModes = [
        {
          runtimeMode: "auto-accept-edits",
          interactionMode: "default",
        },
        {
          runtimeMode: "auto-accept-edits",
          interactionMode: "plan",
        },
        {
          runtimeMode: "auto-accept-edits",
          interactionMode: "auto",
        },
        {
          runtimeMode: "approval-required",
          interactionMode: "default",
        },
      ] as const;

      for (const expected of expectedModes) {
        composerEditor.focus();
        composerEditor.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Tab",
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
        await vi.waitFor(() => {
          const draft = useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY];
          expect(draft?.runtimeMode ?? "approval-required").toBe(expected.runtimeMode);
          expect(draft?.interactionMode ?? "default").toBe(expected.interactionMode);
        });
      }
    } finally {
      await mounted.cleanup();
    }
  });

  it("uses the active draft route session when changing the base branch", async () => {
    const staleDraftId = draftIdFromPath("/draft/draft-stale-branch-session");
    const activeDraftId = draftIdFromPath("/draft/draft-active-branch-session");

    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [staleDraftId]: {
          threadId: THREAD_ID,
          environmentId: LOCAL_ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          logicalProjectKey: `${PROJECT_DRAFT_KEY}:stale`,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          envMode: "worktree",
        },
        [activeDraftId]: {
          threadId: THREAD_ID,
          environmentId: LOCAL_ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          logicalProjectKey: PROJECT_DRAFT_KEY,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          envMode: "worktree",
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [`${PROJECT_DRAFT_KEY}:stale`]: staleDraftId,
        [PROJECT_DRAFT_KEY]: activeDraftId,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      initialPath: `/draft/${activeDraftId}`,
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.vcsListRefs) {
          return {
            isRepo: true,
            hasPrimaryRemote: true,
            nextCursor: null,
            totalCount: 2,
            refs: [
              {
                name: "main",
                current: true,
                isDefault: true,
                worktreePath: null,
              },
              {
                name: "release/next",
                current: false,
                isDefault: false,
                worktreePath: null,
              },
            ],
          };
        }
        return undefined;
      },
    });

    try {
      const branchButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "From main",
          ) as HTMLButtonElement | null,
        'Unable to find branch selector button with "From main".',
      );
      branchButton.click();

      const branchOption = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("span")).find(
            (element) => element.textContent?.trim() === "release/next",
          ) as HTMLSpanElement | null,
        'Unable to find the "release/next" branch option.',
      );
      branchOption.click();

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftSession(activeDraftId)?.branch).toBe(
            "release/next",
          );
          expect(useComposerDraftStore.getState().getDraftSession(staleDraftId)?.branch).toBe(
            "main",
          );
        },
        { timeout: 8_000, interval: 16 },
      );

      await vi.waitFor(
        () => {
          const updatedButton = Array.from(document.querySelectorAll("button")).find((button) =>
            button.textContent?.trim().includes("From release/next"),
          );
          expect(updatedButton).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the new worktree branch picker anchored at the top when opening with a preselected branch", async () => {
    const draftId = DraftId.make("draft-branch-picker-scroll-regression");
    const branches = [
      {
        name: "feature/current",
        current: true,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "main",
        current: false,
        isDefault: true,
        worktreePath: null,
      },
      ...Array.from({ length: 48 }, (_, index) => ({
        name: `feature/${String(index).padStart(2, "0")}`,
        current: false,
        isDefault: false,
        worktreePath: null,
      })),
      {
        name: "feature/selected",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [draftId]: {
          threadId: THREAD_ID,
          environmentId: LOCAL_ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          logicalProjectKey: PROJECT_DRAFT_KEY,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "feature/selected",
          worktreePath: null,
          envMode: "worktree",
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [PROJECT_DRAFT_KEY]: draftId,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      initialPath: `/draft/${draftId}`,
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.vcsListRefs) {
          return {
            isRepo: true,
            hasPrimaryRemote: true,
            nextCursor: null,
            totalCount: branches.length,
            refs: branches,
          };
        }
        return undefined;
      },
    });

    try {
      const branchButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "From feature/selected",
          ) as HTMLButtonElement | null,
        'Unable to find branch selector button with "From feature/selected".',
      );
      branchButton.click();

      await waitForElement(
        () => document.querySelector<HTMLInputElement>('input[placeholder="Search refs..."]'),
        "Unable to find ref search input.",
      );

      const popup = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-slot="combobox-popup"]'),
        "Unable to find the branch picker popup.",
      );

      await vi.waitFor(
        () => {
          const popupSpans = Array.from(popup.querySelectorAll("span"));
          expect(
            popupSpans.some((element) => element.textContent?.trim() === "feature/current"),
          ).toBe(true);
          expect(popupSpans.some((element) => element.textContent?.trim() === "main")).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("surrounds selected plain text and preserves the inner selection for repeated wrapping", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-surround-basic" as MessageId,
        targetText: "surround basic",
        history: "essential",
      }),
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "selected");
      await waitForComposerText("selected");
      await setComposerSelectionByTextOffsets({ start: 0, end: "selected".length });
      await pressComposerKey("(");
      await waitForComposerText("(selected)");

      await pressComposerKey("[");
      await waitForComposerText("([selected])");
    } finally {
      await mounted.cleanup();
    }
  });

  it("leaves collapsed-caret typing unchanged for surround symbols", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "selected");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-surround-collapsed" as MessageId,
        targetText: "surround collapsed",
        history: "essential",
      }),
    });

    try {
      await waitForComposerText("selected");
      await setComposerSelectionByTextOffsets({
        start: "selected".length,
        end: "selected".length,
      });
      await pressComposerKey("(");
      await waitForComposerText("selected(");
    } finally {
      await mounted.cleanup();
    }
  });

  it("supports symmetric and backward-selection surrounds", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "backward");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-surround-backward" as MessageId,
        targetText: "surround backward",
        history: "essential",
      }),
    });

    try {
      await waitForComposerText("backward");
      await setComposerSelectionByTextOffsets({
        start: 0,
        end: "backward".length,
        direction: "backward",
      });
      await pressComposerKey("*");
      await waitForComposerText("*backward*");
    } finally {
      await mounted.cleanup();
    }
  });

  it("supports option-produced surround symbols like guillemets", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "quoted");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-surround-guillemet" as MessageId,
        targetText: "surround guillemet",
        history: "essential",
      }),
    });

    try {
      await waitForComposerText("quoted");
      await setComposerSelectionByTextOffsets({ start: 0, end: "quoted".length });
      await pressComposerKey("«");
      await waitForComposerText("«quoted»");
    } finally {
      await mounted.cleanup();
    }
  });

  it("supports dead-key composition that resolves to another surround symbol without an extra undo step", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "quoted");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-surround-dead-quote" as MessageId,
        targetText: "surround dead quote",
        history: "essential",
      }),
    });

    try {
      await waitForComposerText("quoted");
      await setComposerSelectionByTextOffsets({ start: 0, end: "quoted".length });
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Dead",
          bubbles: true,
          cancelable: true,
        }),
      );
      composerEditor.dispatchEvent(
        new InputEvent("beforeinput", {
          data: "'",
          inputType: "insertCompositionText",
          bubbles: true,
          cancelable: true,
        }),
      );
      const resolvedInputEvent = new InputEvent("beforeinput", {
        data: "'",
        inputType: "insertText",
        bubbles: true,
        cancelable: true,
      });
      composerEditor.dispatchEvent(resolvedInputEvent);
      expect(resolvedInputEvent.defaultPrevented).toBe(true);
      await waitForComposerText("'quoted'");
      await pressComposerUndo();
      await waitForComposerText("quoted");
    } finally {
      await mounted.cleanup();
    }
  });

  it("surrounds text after a mention using the correct expanded offsets", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "hi @package.json there");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-surround-after-mention" as MessageId,
        targetText: "surround after mention",
        history: "essential",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("package.json");
        },
        { timeout: 8_000, interval: 16 },
      );
      await waitForComposerText("hi @package.json there");
      await setComposerSelectionByTextOffsets({
        start: "hi package.json ".length,
        end: "hi package.json there".length,
      });
      await pressComposerKey("(");
      await waitForComposerText("hi @package.json (there)");
    } finally {
      await mounted.cleanup();
    }
  });

  it("falls back to normal replacement when the selection includes a mention token", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "hi @package.json there ");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-surround-token" as MessageId,
        targetText: "surround token",
        history: "essential",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("package.json");
        },
        { timeout: 8_000, interval: 16 },
      );
      await selectAllComposerContent();
      await pressComposerKey("(");
      await waitForComposerText("(");
    } finally {
      await mounted.cleanup();
    }
  });

  it("replaces Stop with Send while a running turn has a follow-up draft", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-running-follow-up-send" as MessageId,
        targetText: "running follow-up send target",
        sessionStatus: "running",
      }),
    });

    try {
      const initialStopButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
        "Unable to find the empty running composer Stop button.",
      );
      expect(initialStopButton.disabled).toBe(false);

      useComposerDraftStore
        .getState()
        .setPrompt(THREAD_REF, "Queue this without interrupting the active turn");

      const queueButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Queue message"]'),
        "Unable to find the running composer Send button.",
      );
      expect(queueButton.disabled).toBe(false);
      expect(
        document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
      ).toBeNull();

      queueButton.click();

      await vi.waitFor(
        () => {
          expect(document.querySelector('[data-cafe-followup-queue="true"]')).not.toBeNull();
          expect(useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]?.prompt ?? "").toBe(
            "",
          );
          const queuedGuardButton = document.querySelector<HTMLButtonElement>(
            'button[aria-label="Queue message"]',
          );
          expect(queuedGuardButton).not.toBeNull();
          expect(queuedGuardButton?.disabled).toBe(true);
          expect(
            document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
          ).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );

      // Exercise the control again during the double-click guard. A rapid
      // second activation must remain harmless instead of landing on Stop.
      document.querySelector<HTMLButtonElement>('button[aria-label="Queue message"]')?.click();
      await waitForLayout();
      expect(
        wsRequests.some(
          (request) =>
            request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            request.type === "thread.turn.interrupt",
        ),
      ).toBe(false);

      await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
        "Stop did not return after the post-send double-click guard elapsed.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps pending and failed document uploads visible and blocks sending until retry succeeds", async () => {
    let releaseFailure: (() => void) | undefined;
    const failureGate = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    const contents = "<html>source only</html>";
    const attachment = {
      type: "file" as const,
      id: "retry-upload-copy",
      name: "source.html",
      mimeType: "text/html",
      sizeBytes: contents.length,
    };
    let attempts = 0;
    worker.use(
      http.post("*/api/attachments", async () => {
        attempts += 1;
        if (attempts === 1) {
          await failureGate;
          return HttpResponse.json({}, { status: 500 });
        }
        return HttpResponse.json(attachment);
      }),
    );
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-upload-retry" as MessageId,
        targetText: "upload retry target",
      }),
      resolveRpc: (body) =>
        body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand
          ? { sequence: chatViewFixture.fixture.snapshot.snapshotSequence + 1 }
          : undefined,
    });
    const draft = () => useComposerDraftStore.getState().getComposerDraft(THREAD_REF);
    const turnRequests = () =>
      wsRequests.filter(
        (request) => request.type === "thread.turn.start" || request.type === "thread.turn.steer",
      );
    try {
      const input = await waitForElement(
        () =>
          document.querySelector<HTMLInputElement>(
            '[data-chat-composer-form="true"] input[type="file"]',
          ),
        "Attachment input was not available.",
      );
      const transfer = new DataTransfer();
      transfer.items.add(new File([contents], attachment.name, { type: attachment.mimeType }));
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Read the attached source");
      await vi.waitFor(() => {
        expect(attempts).toBe(1);
        expect(draft()?.files[0]?.status).toBe("uploading");
      });
      const form = document.querySelector<HTMLFormElement>('[data-chat-composer-form="true"]')!;
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await waitForLayout();
      expect(turnRequests()).toHaveLength(0);
      releaseFailure!();
      await vi.waitFor(() => {
        expect(draft()?.files[0]?.status).toBe("failed");
        expect(document.body.textContent).toContain("Upload failed.");
      });
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await waitForLayout();
      expect(turnRequests()).toHaveLength(0);
      buttonWithText("Retry upload")!.click();
      await vi.waitFor(() => {
        expect(draft()?.files[0]?.status).toBe("ready");
        expect(attempts).toBe(2);
      });
      await vi.waitFor(() =>
        expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(
          false,
        ),
      );
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await vi.waitFor(() => {
        expect(turnRequests()).toHaveLength(1);
        expect(turnRequests()[0]).toMatchObject({ message: { attachments: [attachment] } });
      });
    } finally {
      releaseFailure?.();
      worker.resetHandlers();
      await mounted.cleanup();
    }
  });

  it("uploads a document and saves or cancels queue edits without losing the prior draft", async () => {
    const activeTurnId = "turn-document-queue-edit" as TurnId;
    const baseSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-document-queue-edit" as MessageId,
      targetText: "document queue edit target",
      sessionStatus: "running",
    });
    const runningSnapshot: OrchestrationReadModel = {
      ...baseSnapshot,
      threads: baseSnapshot.threads.map((thread) =>
        Object.assign({}, thread, {
          latestTurn: {
            turnId: activeTurnId,
            state: "running" as const,
            requestedAt: isoAt(1000),
            startedAt: isoAt(1001),
            completedAt: null,
            assistantMessageId: null,
          },
          session: {
            ...thread.session!,
            activeTurnId,
            status: "running" as const,
            updatedAt: isoAt(1001),
          },
          updatedAt: isoAt(1001),
        }),
      ),
    };
    const contents = "\\section{Queued document}";
    const attachment = {
      type: "file" as const,
      id: "uploaded-queued-document",
      name: "report.tex",
      mimeType: "text/plain",
      sizeBytes: new TextEncoder().encode(contents).length,
    };
    const uploads: { threadId: string | null; name: string | null; text: string }[] = [];
    worker.use(
      http.post("*/api/attachments", async ({ request }) => {
        uploads.push({
          threadId: request.headers.get("x-cafe-thread-id"),
          name: request.headers.get("x-cafe-attachment-name"),
          text: await request.text(),
        });
        return HttpResponse.json(attachment);
      }),
    );
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: runningSnapshot,
      configureFixture: (testFixture) => {
        testFixture.serverConfig = {
          ...testFixture.serverConfig,
          providers: testFixture.serverConfig.providers.map((provider) => ({
            ...provider,
            runtimeCapabilities: { liveSteer: "supported", threadGoals: "unsupported" },
          })),
        };
      },
    });
    const draft = () => useComposerDraftStore.getState().getComposerDraft(THREAD_REF);
    const persisted = () => createFollowUpQueuePersistence().load(LOCAL_ENVIRONMENT_ID);

    try {
      const input = await waitForElement(
        () =>
          document.querySelector<HTMLInputElement>(
            '[data-chat-composer-form="true"] input[type="file"]',
          ),
        "Attachment input was not available.",
      );
      expect(input.accept).toBe("");
      const transfer = new DataTransfer();
      transfer.items.add(new File([contents], attachment.name, { type: attachment.mimeType }));
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await vi.waitFor(() => {
        expect(draft()?.files).toHaveLength(1);
        expect(draft()?.files[0]?.status).toBe("ready");
        expect(document.querySelector('[data-file-attachment="true"]')?.textContent).toContain(
          attachment.name,
        );
      });
      expect(uploads).toEqual([{ threadId: THREAD_ID, name: attachment.name, text: contents }]);
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Original queued instruction");
      const queueButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Queue message"]'),
        "Queue action was not available.",
      );
      await vi.waitFor(() => expect(queueButton.disabled).toBe(false));
      queueButton.click();
      await vi.waitFor(() => {
        expect(draft()?.prompt ?? "").toBe("");
        expect(editButton()).not.toBeNull();
      });
      const original = persisted();
      expect(original.ok).toBe(true);
      if (!original.ok) throw new Error("Queued fixture was not saved.");
      const queuedId = original.value.pending[0]!.id;
      expect(original.value.pending[0]?.files).toEqual([attachment]);
      expect(
        document.querySelector('[data-cafe-followup-queue="true"] [data-file-attachment="true"]')
          ?.textContent,
      ).toContain(attachment.name);

      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Keep my independent draft");
      editButton()!.click();
      await vi.waitFor(() => {
        expect(buttonWithText("Save to queue")).toBeDefined();
        expect(draft()?.prompt).toBe("Original queued instruction");
      });
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Discard this edit");
      buttonWithText("Cancel editing")!.click();
      await vi.waitFor(() => expect(draft()?.prompt).toBe("Keep my independent draft"));
      const afterCancel = persisted();
      expect(afterCancel.ok && afterCancel.value.pending[0]?.promptText).toBe(
        "Original queued instruction",
      );

      editButton()!.click();
      await vi.waitFor(() => expect(draft()?.prompt).toBe("Original queued instruction"));
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Saved queued revision");
      await vi.waitFor(() => expect(buttonWithText("Save to queue")?.disabled).toBe(false));
      buttonWithText("Save to queue")!.click();
      await vi.waitFor(() => expect(draft()?.prompt).toBe("Keep my independent draft"));
      const afterSave = persisted();
      expect(afterSave.ok && afterSave.value.pending[0]).toMatchObject({
        id: queuedId,
        promptText: "Saved queued revision",
        files: [attachment],
      });
      document.querySelector<HTMLButtonElement>(".cafe-followup-steer-button")!.click();
      await vi.waitFor(() => {
        const steers = wsRequests.filter((request) => request.type === "thread.turn.steer");
        expect(steers).toHaveLength(1);
        expect(steers[0]).toMatchObject({
          commandId: queuedId,
          message: {
            messageId: queuedId,
            text: "Saved queued revision",
            attachments: [attachment],
          },
        });
      });
      expect(draft()?.prompt).toBe("Keep my independent draft");
      expect(wsRequests.some((request) => request.type === "thread.turn.interrupt")).toBe(false);
    } finally {
      worker.resetHandlers();
      await mounted.cleanup();
    }
  });

  it.each(["ready", "running"] as const)(
    "places a queued prompt after intervening replies when sent in a %s chat",
    async (sessionStatus) => {
      const queuedId = "queued-send-order";
      const precedingMessageId = MessageId.make("reply-after-queueing");
      const activeTurnId = TurnId.make("queued-send-order-turn");
      const base = createSnapshotForTargetUser({
        targetMessageId: MessageId.make("queued-send-order-original"),
        targetText: "Original prompt",
        sessionStatus: "running",
      });
      const snapshot: OrchestrationReadModel = {
        ...base,
        threads: base.threads.map((thread) => ({
          ...thread,
          messages: [
            createUserMessage({
              id: MessageId.make("queued-send-order-original"),
              text: "Original prompt",
              offsetSeconds: 0,
            }),
            createAssistantMessage({
              id: precedingMessageId,
              text: "Reply received after the follow-up was queued",
              offsetSeconds: 2,
            }),
          ],
          latestTurn: {
            turnId: activeTurnId,
            state: "running" as const,
            requestedAt: NOW_ISO,
            startedAt: NOW_ISO,
            completedAt: null,
            assistantMessageId: null,
          },
          session: { ...thread.session!, activeTurnId },
        })),
      };
      const persistence = createFollowUpQueuePersistence();
      expect(
        (
          await persistence.save(LOCAL_ENVIRONMENT_ID, [
            {
              id: queuedId,
              environmentId: LOCAL_ENVIRONMENT_ID,
              threadId: THREAD_ID,
              promptText: "Send this after the reply",
              images: [],
              files: [],
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5",
              promptEffort: null,
              modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5"),
              runtimeMode: "full-access",
              interactionMode: "default",
              queuedAt: isoAt(1),
              blockedReason: null,
            },
          ])
        ).ok,
      ).toBe(true);
      const beforeSend = Date.now();
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot,
        configureFixture: (testFixture) => {
          testFixture.serverConfig = {
            ...testFixture.serverConfig,
            providers: testFixture.serverConfig.providers.map((provider) => ({
              ...provider,
              runtimeCapabilities: { liveSteer: "supported", threadGoals: "unsupported" },
            })),
          };
        },
        resolveRpc: (body) =>
          body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand ? { sequence: 3 } : undefined,
      });
      try {
        await expect.element(page.getByText("1 message queued", { exact: true })).toBeVisible();
        if (sessionStatus === "running") {
          await page.getByRole("button", { name: "Send", exact: true }).click();
        } else {
          // Complete the original turn after the view has loaded, as happens
          // when a waiting follow-up becomes eligible for automatic delivery.
          const current = chatViewFixture.fixture.snapshot.threads[0]!;
          const thread = {
            ...current,
            latestTurn: {
              ...current.latestTurn!,
              state: "completed" as const,
              completedAt: isoAt(3),
            },
            session: { ...current.session!, status: "ready" as const, activeTurnId: null },
          };
          chatViewFixture.fixture.snapshot = {
            ...chatViewFixture.fixture.snapshot,
            snapshotSequence: 2,
            threads: [thread],
          };
          rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
            kind: "snapshot",
            snapshot: { snapshotSequence: 2, thread },
          });
        }
        const commandType = sessionStatus === "running" ? "thread.turn.steer" : "thread.turn.start";
        await vi.waitFor(() =>
          expect(wsRequests.filter((request) => request.type === commandType)).toHaveLength(1),
        );
        const command = wsRequests.find((request) => request.type === commandType)!;
        expect(command.message).toMatchObject({
          messageId: queuedId,
          text: "Send this after the reply",
        });
        const sentAt = Date.parse(command.createdAt as string);
        expect(sentAt).toBeGreaterThanOrEqual(beforeSend);
        expect(sentAt).toBeLessThanOrEqual(Date.now());
        await vi.waitFor(() => {
          const preceding = document.querySelector(`[data-message-id="${precedingMessageId}"]`);
          const sent = document.querySelector(`[data-message-id="${queuedId}"]`);
          expect(preceding).not.toBeNull();
          expect(sent).not.toBeNull();
          expect(preceding!.compareDocumentPosition(sent!) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
            Node.DOCUMENT_POSITION_FOLLOWING,
          );
        });
        expect(wsRequests.some((request) => request.type === "thread.turn.interrupt")).toBe(false);
        await vi.waitFor(() =>
          expect(persistence.load(LOCAL_ENVIRONMENT_ID)).toEqual({
            ok: true,
            value: { pending: [], claimed: [] },
          }),
        );
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("restores an uncertain queued dispatch as manual-only and removes its exact claim", async () => {
    const persistence = createFollowUpQueuePersistence();
    const queuedId = "queued-uncertain-browser-fixture";
    const queued = {
      id: queuedId,
      environmentId: LOCAL_ENVIRONMENT_ID,
      threadId: THREAD_ID,
      promptText: "Do not resend this uncertain instruction",
      images: [],
      files: [
        {
          type: "file" as const,
          id: "uncertain-file",
          name: "notes.pdf",
          mimeType: "application/pdf",
          sizeBytes: 123,
        },
      ],
      provider: ProviderDriverKind.make("codex"),
      model: "gpt-5.4",
      promptEffort: null,
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4"),
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      queuedAt: isoAt(1000),
      blockedReason: null,
    };
    expect((await persistence.save(LOCAL_ENVIRONMENT_ID, [queued])).ok).toBe(true);
    expect(
      persistence.claim(
        {
          environmentId: LOCAL_ENVIRONMENT_ID,
          threadId: THREAD_ID,
          itemId: queuedId,
          commandId: CommandId.make(queuedId),
          messageId: MessageId.make(queuedId),
        },
        queued,
      ).ok,
    ).toBe(true);
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-uncertain-queue" as MessageId,
        targetText: "uncertain queued dispatch target",
        sessionStatus: "ready",
      }),
    });
    try {
      const shelf = await waitForElement(
        () => document.querySelector('[data-cafe-followup-queue="true"]'),
        "Uncertain queue row was not restored.",
      );
      expect(shelf.textContent).toContain("Delivery status is unknown");
      expect(shelf.textContent).toContain("notes.pdf");
      expect(queuedSendButtons()[0]?.disabled).toBe(true);
      expect(editButton()).toBeNull();
      queuedSendButtons()[0]!.click();
      // Cover the periodic queue watchdog as well as initial render and
      // direct activation. A saved claim is never an auto-send candidate.
      await new Promise((resolve) => window.setTimeout(resolve, 1_100));
      expect(
        wsRequests.some(
          (request) => request.type === "thread.turn.start" || request.type === "thread.turn.steer",
        ),
      ).toBe(false);
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Remove queued message"]')!
        .click();
      await vi.waitFor(() =>
        expect(document.querySelector('[data-cafe-followup-queue="true"]')).toBeNull(),
      );
      expect(createFollowUpQueuePersistence().load(LOCAL_ENVIRONMENT_ID)).toEqual({
        ok: true,
        value: { pending: [], claimed: [] },
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it.each(["running", "ready"] as const)(
    "immediately delivers an inline question answer in a %s chat without consuming the main draft",
    async (sessionStatus) => {
      const activeTurnId = "turn-inline-question-steer" as TurnId;
      const base = createSnapshotForTargetUser({
        targetMessageId: MessageId.make("inline-question-user"),
        targetText: "Inline question fixture",
        sessionStatus,
      });
      const activityId = EventId.make(`codex-async-questions:${"c".repeat(64)}`);
      const snapshot: OrchestrationReadModel = {
        ...base,
        threads: base.threads.map((thread) => ({
          ...thread,
          latestTurn:
            sessionStatus === "running"
              ? {
                  turnId: activeTurnId,
                  state: "running",
                  requestedAt: NOW_ISO,
                  startedAt: NOW_ISO,
                  completedAt: null,
                  assistantMessageId: null,
                }
              : null,
          session: {
            ...thread.session!,
            activeTurnId: sessionStatus === "running" ? activeTurnId : null,
            status: sessionStatus,
          },
          activities: [
            ...thread.activities,
            {
              id: activityId,
              createdAt: NOW_ISO,
              tone: "info",
              kind: "provider.async-questions",
              summary: "Codex has questions",
              turnId: activeTurnId,
              payload: {
                itemId: "inline-question-item",
                questions: [{ title: "Which route?", options: ["Suggested route"] }],
              },
            },
          ],
        })),
      };
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot,
        configureFixture: (testFixture) => {
          testFixture.serverConfig = {
            ...testFixture.serverConfig,
            providers: testFixture.serverConfig.providers.map((provider) => ({
              ...provider,
              runtimeCapabilities: { liveSteer: "supported", threadGoals: "unsupported" },
            })),
          };
        },
        resolveRpc: (body) =>
          body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand
            ? { sequence: snapshot.snapshotSequence + 1 }
            : undefined,
      });
      try {
        useComposerDraftStore.getState().setPrompt(THREAD_REF, "Keep this independent draft");
        await page.getByText("1 question from Codex").click();
        await page.getByRole("button", { name: "Suggested route" }).click();
        await page.getByRole("button", { name: "Send answer" }).click();
        const commandType = sessionStatus === "running" ? "thread.turn.steer" : "thread.turn.start";
        await vi.waitFor(() =>
          expect(wsRequests.filter((request) => request.type === commandType)).toHaveLength(1),
        );
        const answer = wsRequests.find((request) => request.type === commandType)!;
        expect(answer.message).toMatchObject({ text: "> Which route?\n\nSuggested route" });
        await vi.waitFor(() =>
          expect(
            wsRequests.find((request) => request.type === "thread.async-questions.resolve"),
          ).toMatchObject({ threadId: THREAD_ID, activityId, questionIndexes: [0] }),
        );
        expect(useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]?.prompt).toBe(
          "Keep this independent draft",
        );
        expect(
          wsRequests.some(
            (request) =>
              request.type ===
                (sessionStatus === "running" ? "thread.turn.start" : "thread.turn.steer") ||
              request.type === "thread.turn.interrupt",
          ),
        ).toBe(false);
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("sends a second queued steer while the first accepted steer is still processing", async () => {
    const activeTurnId = "turn-consecutive-queued-steers" as TurnId;
    const baseSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-consecutive-queued-steers" as MessageId,
      targetText: "consecutive queued steers target",
      sessionStatus: "running",
    });
    const runningSnapshot: OrchestrationReadModel = {
      ...baseSnapshot,
      threads: baseSnapshot.threads.map((thread) =>
        Object.assign({}, thread, {
          latestTurn: {
            turnId: activeTurnId,
            state: "running" as const,
            requestedAt: isoAt(1_000),
            startedAt: isoAt(1_001),
            completedAt: null,
            assistantMessageId: null,
          },
          session: { ...thread.session!, activeTurnId, status: "running" as const },
        }),
      ),
    };
    let releaseFirstRequest: (() => void) | undefined;
    const firstRequest = new Promise<{ sequence: number }>((resolve) => {
      releaseFirstRequest = () => resolve({ sequence: runningSnapshot.snapshotSequence + 1 });
    });
    let steerRequestCount = 0;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: runningSnapshot,
      configureFixture: (testFixture) => {
        testFixture.serverConfig = {
          ...testFixture.serverConfig,
          providers: testFixture.serverConfig.providers.map((provider) => ({
            ...provider,
            runtimeCapabilities: { liveSteer: "supported", threadGoals: "unsupported" },
          })),
        };
      },
      resolveRpc: (body) => {
        if (body._tag !== ORCHESTRATION_WS_METHODS.dispatchCommand) return undefined;
        if (body.type === "thread.turn.steer") {
          steerRequestCount += 1;
          if (steerRequestCount === 1) return firstRequest;
        }
        return { sequence: runningSnapshot.snapshotSequence + steerRequestCount };
      },
    });
    const steerRequests = () =>
      wsRequests.filter(
        (request) =>
          request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
          request.type === "thread.turn.steer",
      );

    try {
      // Queue both rows before sending either; the second remains available
      // throughout the first command's real transport and processing phases.
      for (const text of ["first queued correction", "second queued correction"]) {
        useComposerDraftStore.getState().setPrompt(THREAD_REF, text);
        await vi.waitFor(() => {
          const button = document.querySelector<HTMLButtonElement>(
            'button[aria-label="Queue message"]',
          );
          expect(button).not.toBeNull();
          expect(button?.disabled).toBe(false);
        });
        document.querySelector<HTMLButtonElement>('button[aria-label="Queue message"]')!.click();
        await vi.waitFor(() =>
          expect(useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]?.prompt ?? "").toBe(
            "",
          ),
        );
      }
      await vi.waitFor(() => expect(queuedSendButtons()).toHaveLength(2));
      queuedSendButtons()[0]!.click();
      await vi.waitFor(() => expect(steerRequests()).toHaveLength(1));
      await vi.waitFor(() => expect(queuedSendButtons()).toHaveLength(1));
      queuedSendButtons()[0]!.click();
      await waitForLayout();
      expect(steerRequests()).toHaveLength(1);

      releaseFirstRequest!();
      // No provider processing marker is published by this fixture. The
      // first non-cancelable steering row must not own the send lock anymore.
      await waitForLayout();
      expect(document.querySelectorAll('[data-cafe-followup-steering="true"]')).toHaveLength(1);
      const secondSendButton = queuedSendButtons()[0]!;
      secondSendButton.click();
      secondSendButton.click();
      await vi.waitFor(() => {
        expect(steerRequests()).toHaveLength(2);
        expect(document.querySelectorAll('[data-cafe-followup-steering="true"]')).toHaveLength(2);
      });
      const messages = steerRequests().map(
        (request) => request.message as { messageId: string; text: string },
      );
      expect(messages.map((message) => message.text)).toEqual([
        "first queued correction",
        "second queued correction",
      ]);
      expect(new Set(messages.map((message) => message.messageId)).size).toBe(2);
      expect(wsRequests.some((request) => request.type === "thread.turn.interrupt")).toBe(false);
    } finally {
      releaseFirstRequest?.();
      await mounted.cleanup();
    }
  });

  it("keeps a steer pending when another message starts processing on the same turn", async (testContext) => {
    let releaseSteerReceipt: (() => void) | undefined;
    let steerReceiptReleased = false;
    const owner = createChatViewCallerOwner(testContext, mountChatView, {
      label: "pending-steer",
      beforeDrain: () => {
        releaseSteerReceipt?.();
      },
    });
    await owner.run(async () => {
      const activeTurnId = "turn-correlated-steer-processing" as TurnId;
      const baseSnapshot = createSnapshotForTargetUser({
        targetMessageId: "msg-user-correlated-steer-processing" as MessageId,
        targetText: "correlated steer processing target",
        sessionStatus: "running",
      });
      const runningSnapshot: OrchestrationReadModel = {
        ...baseSnapshot,
        threads: baseSnapshot.threads.map((thread) =>
          Object.assign({}, thread, {
            latestTurn: {
              turnId: activeTurnId,
              state: "running" as const,
              requestedAt: isoAt(1_000),
              startedAt: isoAt(1_001),
              completedAt: null,
              assistantMessageId: null,
            },
            session: {
              ...thread.session!,
              status: "running" as const,
              activeTurnId,
              updatedAt: isoAt(1_001),
            },
            updatedAt: isoAt(1_001),
          }),
        ),
      };
      const steerReceipt = new Promise<{ sequence: number }>((resolve) => {
        releaseSteerReceipt = () => {
          if (steerReceiptReleased) return;
          steerReceiptReleased = true;
          resolve({ sequence: runningSnapshot.snapshotSequence + 1 });
        };
      });
      await owner.mount({
        viewport: DEFAULT_VIEWPORT,
        snapshot: runningSnapshot,
        configureFixture: (testFixture) => {
          testFixture.serverConfig = {
            ...testFixture.serverConfig,
            providers: testFixture.serverConfig.providers.map((provider) => ({
              ...provider,
              runtimeCapabilities: {
                liveSteer: "supported" as const,
                threadGoals: "unsupported" as const,
              },
            })),
          };
        },
        resolveRpc: (body) => {
          if (
            body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            body.type === "thread.turn.steer"
          ) {
            return steerReceipt;
          }
          return undefined;
        },
      });

      useComposerDraftStore
        .getState()
        .setPrompt(THREAD_REF, "Keep this steer pending until its own marker arrives");

      const queueButton = await owner.own("controls", () =>
        waitForElement(
          () => document.querySelector<HTMLButtonElement>('button[aria-label="Queue message"]'),
          "Unable to find the running composer Send button.",
        ),
      );
      owner.assertActive();
      queueButton.click();
      owner.mark("send");

      const steerButton = await owner.own("steer", () =>
        waitForElement(
          () =>
            document.querySelector<HTMLButtonElement>(
              '[data-cafe-followup-queue="true"] .cafe-followup-steer-button',
            ),
          "Unable to find the queued follow-up Send action.",
        ),
      );
      owner.assertActive();
      steerButton.click();
      owner.mark("steer");

      let dispatchedMessageId: MessageId | null = null;
      await owner.own("request", () =>
        vi.waitFor(
          () => {
            const request = wsRequests.find(
              (candidate) =>
                candidate._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                candidate.type === "thread.turn.steer",
            ) as
              | {
                  readonly type: "thread.turn.steer";
                  readonly message: { readonly messageId: MessageId };
                }
              | undefined;
            dispatchedMessageId = request?.message.messageId ?? null;
            expect(dispatchedMessageId).not.toBeNull();
            expect(
              document.querySelector('[aria-label="Follow-up steering into active turn"]'),
            ).not.toBeNull();
          },
          { timeout: 8_000, interval: 16 },
        ),
      );

      const emitSteeringActivity = (
        eventId: string,
        kind: string,
        payload: Record<string, unknown>,
        turnId: TurnId = activeTurnId,
      ) => {
        owner.assertActive();
        const currentThread = chatViewFixture.fixture.snapshot.threads[0]!;
        const snapshotSequence =
          Math.max(
            chatViewFixture.fixture.snapshot.snapshotSequence,
            runningSnapshot.snapshotSequence + 1,
          ) + 1;
        const nextThread: OrchestrationReadModel["threads"][number] = {
          ...currentThread,
          activities: [
            ...currentThread.activities,
            {
              id: EventId.make(eventId),
              tone: "info",
              kind,
              summary: "Reasoning update",
              payload,
              turnId,
              sequence: snapshotSequence,
              createdAt: new Date(Date.now() + snapshotSequence * 1_000).toISOString(),
            },
          ],
          updatedAt: new Date(Date.now() + snapshotSequence * 1_000).toISOString(),
        };
        chatViewFixture.fixture.snapshot = {
          ...chatViewFixture.fixture.snapshot,
          snapshotSequence,
          threads: [nextThread],
        };
        rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
          kind: "snapshot",
          snapshot: {
            snapshotSequence,
            thread: nextThread,
          },
        });
        owner.mark("snapshot");
      };

      const deliveryBadge = () => document.querySelector<HTMLElement>("[data-steering-status]");
      expect(deliveryBadge()?.dataset.steeringStatus).toBe("sending");
      emitSteeringActivity("exact-delivery-attempt", "provider.turn.steer.delivery-attempted", {
        provider: "codex",
        messageId: dispatchedMessageId!,
        intentSequence: runningSnapshot.snapshotSequence + 1,
        detail: "private native metadata must not enter the public row",
      });
      await owner.own("receipt", () =>
        vi.waitFor(() => expect(document.body.textContent).toContain("Steer delivery attempted")),
      );
      expect(document.body.textContent).not.toContain("private native metadata");
      emitSteeringActivity(
        "child-compaction-start",
        "tool.started",
        {
          itemType: "context_compaction",
          itemId: "child-compact",
        },
        TurnId.make("unrelated-child-turn"),
      );
      await owner.own("layout", () => waitForLayout());
      expect(deliveryBadge()?.dataset.steeringStatus).toBe("sending");
      emitSteeringActivity("exact-compaction-start", "tool.started", {
        itemType: "context_compaction",
        itemId: "exact-compact",
      });
      await owner.own("canonical", () =>
        vi.waitFor(() =>
          expect(deliveryBadge()?.dataset.steeringStatus).toBe("waiting-for-compaction"),
        ),
      );
      expect(deliveryBadge()?.textContent).toBe("Waiting for compaction");
      expect(document.querySelectorAll('[data-cafe-followup-steering="true"]')).toHaveLength(1);
      const terminalSequence = chatViewFixture.fixture.snapshot.snapshotSequence + 1;
      const terminalThread = {
        ...chatViewFixture.fixture.snapshot.threads[0]!,
        latestTurn: {
          ...chatViewFixture.fixture.snapshot.threads[0]!.latestTurn!,
          state: "completed" as const,
          completedAt: new Date().toISOString(),
        },
      };
      chatViewFixture.fixture.snapshot = {
        ...chatViewFixture.fixture.snapshot,
        snapshotSequence: terminalSequence,
        threads: [terminalThread],
      };
      rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
        kind: "snapshot",
        snapshot: { snapshotSequence: terminalSequence, thread: terminalThread },
      });
      await owner.own("layout", () => waitForLayout());
      expect(deliveryBadge()?.dataset.steeringStatus).toBe("waiting-for-compaction");
      expect(document.querySelectorAll('[data-cafe-followup-steering="true"]')).toHaveLength(1);
      emitSteeringActivity("exact-compaction-end", "tool.completed", {
        itemType: "context_compaction",
        itemId: "exact-compact",
        status: "completed",
      });
      await owner.own("canonical", () =>
        vi.waitFor(() => expect(deliveryBadge()?.dataset.steeringStatus).toBe("sending")),
      );
      releaseSteerReceipt!();
      owner.mark("ack");
      await owner.own("layout", () => waitForLayout());
      expect(deliveryBadge()?.dataset.steeringStatus).toBe("sending");
      const acceptancePayload = {
        provider: "codex",
        acceptedTurnId: activeTurnId,
        intentSequence: runningSnapshot.snapshotSequence + 1,
        clientCorrelationId: "browser-steer-correlation",
      };
      emitSteeringActivity("sibling-accepted", "provider.turn.steer.accepted", {
        ...acceptancePayload,
        messageId: "sibling-message",
      });
      await owner.own("layout", () => waitForLayout());
      expect(deliveryBadge()?.dataset.steeringStatus).toBe("sending");
      emitSteeringActivity("exact-accepted", "provider.turn.steer.accepted", {
        ...acceptancePayload,
        messageId: dispatchedMessageId!,
      });
      await owner.own("receipt", () =>
        vi.waitFor(() => expect(deliveryBadge()?.dataset.steeringStatus).toBe("received")),
      );
      expect(deliveryBadge()?.textContent).toBe("Accepted");
      expect(document.body.textContent).toContain("Steer accepted");
      emitSteeringActivity("accepted-compaction-start", "tool.started", {
        itemType: "context_compaction",
        itemId: "accepted-compact",
      });
      await owner.own("canonical", () =>
        vi.waitFor(() =>
          expect(deliveryBadge()?.dataset.steeringStatus).toBe("waiting-for-compaction"),
        ),
      );
      emitSteeringActivity("accepted-compaction-end", "tool.completed", {
        itemType: "context_compaction",
        itemId: "accepted-compact",
        status: "completed",
      });
      await owner.own("canonical", () =>
        vi.waitFor(() => expect(deliveryBadge()?.dataset.steeringStatus).toBe("received")),
      );
      const waitMessage =
        "Codex accepted turn/steer; it is queued until the active turn finishes current child-process work (4 live descendant processes).";
      emitSteeringActivity("sibling-waiting", "runtime.warning", {
        message: waitMessage,
        detail: { clientCorrelationId: "sibling-correlation" },
      });
      await owner.own("layout", () => waitForLayout());
      expect(deliveryBadge()?.dataset.steeringStatus).toBe("received");
      for (const delay of [15, 60, 120]) {
        emitSteeringActivity(`exact-waiting-${delay}`, "runtime.warning", {
          message: waitMessage,
          detail: {
            clientCorrelationId: "browser-steer-correlation",
            elapsedDelay: `${delay} seconds`,
          },
        });
        await owner.own("receipt", () =>
          vi.waitFor(() => expect(deliveryBadge()?.dataset.steeringStatus).toBe("waiting")),
        );
        expect(document.querySelectorAll('[data-cafe-followup-steering="true"]')).toHaveLength(1);
        expect(document.body.textContent).not.toContain(waitMessage);
        expect(document.body.textContent).toContain("Steer accepted");
      }
      const emitProcessingActivity = (
        messageId: MessageId,
        eventId: string,
        correlationLocation: "payload" | "usage",
      ) =>
        emitSteeringActivity(eventId, "task.progress", {
          taskId: `codex-turn-steer-processing:${activeTurnId}`,
          detail: "Codex app-server began processing turn/steer.",
          ...(correlationLocation === "payload" ? { messageId } : { usage: { messageId } }),
        });

      emitProcessingActivity(
        "different-steer-message" as MessageId,
        "activity-other-steer-processing",
        "usage",
      );
      await owner.own("layout", () => waitForLayout());
      expect(deliveryBadge()?.dataset.steeringStatus).toBe("waiting");
      expect(
        document.querySelector('[aria-label="Follow-up steering into active turn"]'),
      ).not.toBeNull();

      emitProcessingActivity(
        dispatchedMessageId!,
        "activity-correlated-steer-processing",
        "payload",
      );
      await owner.own("processing", () =>
        vi.waitFor(
          () => {
            expect(
              document.querySelector('[aria-label="Follow-up steering into active turn"]'),
            ).toBeNull();
          },
          { timeout: 8_000, interval: 16 },
        ),
      );
      expect(document.body.textContent).not.toContain(
        "Codex app-server began processing turn/steer.",
      );
      expect(
        wsRequests.filter(
          (request) =>
            request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            request.type === "thread.turn.steer",
        ),
      ).toHaveLength(1);
    });
  });

  it("retains a direct steer after the exact-command reconnect window exhausts without replay", async (testContext) => {
    let restoreDispatch: (() => void) | undefined;
    const owner = createChatViewCallerOwner(testContext, mountChatView, {
      label: "reconnect-exhaustion",
      afterUnmount: () => {
        restoreDispatch?.();
      },
    });
    await owner.run(async () => {
      const activeTurnId = TurnId.make("turn-direct-unknown");
      const baseSnapshot = createSnapshotForTargetUser({
        targetMessageId: MessageId.make("direct-unknown-original"),
        targetText: "Original running work",
        sessionStatus: "running",
      });
      const snapshot: OrchestrationReadModel = {
        ...baseSnapshot,
        threads: baseSnapshot.threads.map((thread) => ({
          ...thread,
          latestTurn: {
            turnId: activeTurnId,
            state: "running" as const,
            requestedAt: isoAt(1_000),
            startedAt: isoAt(1_001),
            completedAt: null,
            assistantMessageId: null,
          },
          session: {
            ...thread.session!,
            status: "running" as const,
            activeTurnId,
            updatedAt: isoAt(1_001),
          },
          updatedAt: isoAt(1_001),
        })),
      };
      const text = "Preserve the exact indeterminate direct steer";
      await owner.mount({
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
      });
      const api = readEnvironmentApi(LOCAL_ENVIRONMENT_ID)!;
      const originalDispatch = api.orchestration.dispatchCommand;
      // This API boundary models only the final rejection after wsRpcClient's
      // unchanged 90.75-second exact-command retry window. The separate RPC
      // tests qualify that real bounded window; no production delays change.
      const dispatchSpy = vi
        .spyOn(api.orchestration, "dispatchCommand")
        .mockImplementation(async (command) => {
          if (command.type === "thread.turn.steer") throw new Error("SocketCloseError: 1006");
          return originalDispatch(command);
        });
      // The original API remains installed until this exact mount/native drain
      // finishes. A late old handler must not observe a restored replacement.
      restoreDispatch = () => {
        dispatchSpy.mockRestore();
      };
      __setEnvironmentApiOverrideForTests(LOCAL_ENVIRONMENT_ID, api);
      useComposerDraftStore.getState().setPrompt(THREAD_REF, text);
      await owner.own("editor", () => page.getByTestId("composer-editor").click());
      await owner.own("input", () => userEvent.keyboard("{Control>}{Enter}{/Control}"));
      await owner.own("request", () =>
        vi.waitFor(() => {
          expect(
            dispatchSpy.mock.calls.filter(([command]) => command.type === "thread.turn.steer"),
          ).toHaveLength(1);
          expect(
            document.querySelector<HTMLElement>("[data-steering-status]")?.dataset.steeringStatus,
          ).toBe("sending");
          expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt ?? "").toBe(
            "",
          );
        }),
      );
      const command = dispatchSpy.mock.calls
        .map(([value]) => value)
        .find((value) => value.type === "thread.turn.steer")!;
      if (command.type !== "thread.turn.steer") throw new Error("Expected the exact steer command");
      expect(command.message.text).toBe(text);
      expect(
        [...document.querySelectorAll<HTMLElement>('[data-message-role="user"]')].filter((node) =>
          node.textContent?.includes(text),
        ),
      ).toHaveLength(1);
      expect(document.querySelector('button[aria-label="Retry delivery"]')).toBeNull();
      expect(document.body.textContent).not.toContain("Failed to steer turn.");
      await owner.own("layout", () => waitForLayout());
      expect(
        dispatchSpy.mock.calls.filter(([value]) => value.type === "thread.turn.steer"),
      ).toHaveLength(1);
      const emit = (kind: string, payload: Record<string, unknown>) => {
        owner.assertActive();
        const current = chatViewFixture.fixture.snapshot.threads[0]!;
        const sequence = chatViewFixture.fixture.snapshot.snapshotSequence + 1;
        const thread = {
          ...current,
          activities: [
            ...current.activities,
            {
              id: EventId.make(`direct-unknown-${sequence}`),
              kind,
              tone: "info" as const,
              summary: "Steer observation",
              payload,
              turnId: activeTurnId,
              sequence,
              createdAt: new Date().toISOString(),
            },
          ],
        };
        chatViewFixture.fixture.snapshot = {
          ...chatViewFixture.fixture.snapshot,
          snapshotSequence: sequence,
          threads: [thread],
        };
        rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
          kind: "snapshot",
          snapshot: { snapshotSequence: sequence, thread },
        });
        owner.mark("snapshot");
      };
      emit("provider.turn.steer.accepted", {
        provider: "codex",
        messageId: command.message.messageId,
        acceptedTurnId: activeTurnId,
      });
      await owner.own("receipt", () =>
        vi.waitFor(() =>
          expect(
            document.querySelector<HTMLElement>("[data-steering-status]")?.dataset.steeringStatus,
          ).toBe("received"),
        ),
      );
      emit("task.progress", {
        taskId: `codex-turn-steer-processing:${activeTurnId}`,
        messageId: command.message.messageId,
        detail: "Codex app-server began processing turn/steer.",
      });
      await owner.own("processing", () =>
        vi.waitFor(() =>
          expect(document.querySelector('[data-cafe-followup-steering="true"]')).toBeNull(),
        ),
      );
      expect(
        dispatchSpy.mock.calls.filter(([value]) => value.type === "thread.turn.steer"),
      ).toHaveLength(1);
    });
  });

  it.each(["unchanged", "newer-edited"] as const)(
    "consumes only the admitted direct draft after processing precedes final transport exhaustion (%s)",
    async (draftState) => {
      const activeTurnId = TurnId.make(`turn-processed-before-unknown-${draftState}`);
      const baseSnapshot = createSnapshotForTargetUser({
        targetMessageId: MessageId.make(`processed-before-unknown-original-${draftState}`),
        targetText: "Original running work",
        sessionStatus: "running",
      });
      const snapshot: OrchestrationReadModel = {
        ...baseSnapshot,
        threads: baseSnapshot.threads.map((thread) => ({
          ...thread,
          latestTurn: {
            turnId: activeTurnId,
            state: "running" as const,
            requestedAt: isoAt(1_000),
            startedAt: isoAt(1_001),
            completedAt: null,
            assistantMessageId: null,
          },
          session: {
            ...thread.session!,
            status: "running" as const,
            activeTurnId,
            updatedAt: isoAt(1_001),
          },
          updatedAt: isoAt(1_001),
        })),
      };
      const text = "Already processed exact direct steer";
      const newerDraft = "Keep this separately edited draft";
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
      });
      const api = readEnvironmentApi(LOCAL_ENVIRONMENT_ID)!;
      const originalDispatch = api.orchestration.dispatchCommand;
      let rejectSteerReceipt: ((error: Error) => void) | undefined;
      // Hold only the API boundary's final response. The real exact-command
      // reconnect window remains separately qualified and unchanged.
      const dispatchSpy = vi
        .spyOn(api.orchestration, "dispatchCommand")
        .mockImplementation(async (command) => {
          if (command.type === "thread.turn.steer") {
            return new Promise<{ sequence: number }>((_resolve, reject) => {
              rejectSteerReceipt = reject;
            });
          }
          return originalDispatch(command);
        });
      __setEnvironmentApiOverrideForTests(LOCAL_ENVIRONMENT_ID, api);
      try {
        useComposerDraftStore.getState().setPrompt(THREAD_REF, text);
        await page.getByTestId("composer-editor").click();
        await userEvent.keyboard("{Control>}{Enter}{/Control}");
        await vi.waitFor(() => {
          expect(
            dispatchSpy.mock.calls.filter(([command]) => command.type === "thread.turn.steer"),
          ).toHaveLength(1);
          expect(
            document.querySelector<HTMLElement>("[data-steering-status]")?.dataset.steeringStatus,
          ).toBe("sending");
          expect(rejectSteerReceipt).toBeDefined();
        });
        const command = dispatchSpy.mock.calls
          .map(([value]) => value)
          .find((value) => value.type === "thread.turn.steer")!;
        if (command.type !== "thread.turn.steer")
          throw new Error("Expected the exact steer command");
        expect(command.message.text).toBe(text);
        const emitProcessing = (messageId: MessageId) => {
          const current = chatViewFixture.fixture.snapshot.threads[0]!;
          const sequence = chatViewFixture.fixture.snapshot.snapshotSequence + 1;
          const thread = {
            ...current,
            activities: [
              ...current.activities,
              {
                id: EventId.make(`processed-before-unknown-${draftState}-${sequence}`),
                kind: "task.progress",
                tone: "info" as const,
                summary: "Steer processing",
                payload: {
                  taskId: `codex-turn-steer-processing:${activeTurnId}`,
                  messageId,
                  detail: "Codex app-server began processing turn/steer.",
                },
                turnId: activeTurnId,
                sequence,
                createdAt: new Date().toISOString(),
              },
            ],
          };
          chatViewFixture.fixture.snapshot = {
            ...chatViewFixture.fixture.snapshot,
            snapshotSequence: sequence,
            threads: [thread],
          };
          rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
            kind: "snapshot",
            snapshot: { snapshotSequence: sequence, thread },
          });
        };
        emitProcessing(MessageId.make(`processed-before-unknown-sibling-${draftState}`));
        await waitForLayout();
        expect(document.querySelector('[data-cafe-followup-steering="true"]')).not.toBeNull();
        expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(text);
        emitProcessing(command.message.messageId);
        await vi.waitFor(() =>
          expect(document.querySelector('[data-cafe-followup-steering="true"]')).toBeNull(),
        );
        // Provider processing is allowed to settle this brand-new exact
        // message before the orchestration command's transport response.
        expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(text);
        if (draftState === "newer-edited") {
          useComposerDraftStore.getState().setPrompt(THREAD_REF, newerDraft);
        }
        rejectSteerReceipt!(new Error("SocketCloseError: 1006"));
        await vi.waitFor(() => {
          expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt ?? "").toBe(
            draftState === "newer-edited" ? newerDraft : "",
          );
        });
        await waitForLayout();
        expect(document.querySelector('[data-cafe-followup-steering="true"]')).toBeNull();
        expect(document.querySelector('button[aria-label="Retry delivery"]')).toBeNull();
        expect(document.body.textContent).not.toContain("Failed to steer turn.");
        expect(
          [...document.querySelectorAll<HTMLElement>('[data-message-role="user"]')].filter((node) =>
            node.textContent?.includes(text),
          ),
        ).toHaveLength(1);
        expect(
          dispatchSpy.mock.calls.filter(([value]) => value.type === "thread.turn.steer"),
        ).toHaveLength(1);
      } finally {
        rejectSteerReceipt?.(new Error("SocketCloseError: 1006"));
        dispatchSpy.mockRestore();
        await mounted.cleanup();
      }
    },
  );

  it("settles a pending steer only from an exact successful delivery receipt", async () => {
    const activeTurnId = "turn-steer-delivery-receipt" as TurnId;
    const baseSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-steer-delivery-receipt" as MessageId,
      targetText: "delivery receipt target",
      sessionStatus: "running",
    });
    const runningSnapshot: OrchestrationReadModel = {
      ...baseSnapshot,
      threads: baseSnapshot.threads.map((thread) =>
        Object.assign({}, thread, {
          latestTurn: {
            turnId: activeTurnId,
            state: "running" as const,
            requestedAt: isoAt(1_000),
            startedAt: isoAt(1_001),
            completedAt: null,
            assistantMessageId: null,
          },
          session: {
            ...thread.session!,
            status: "running" as const,
            activeTurnId,
            updatedAt: isoAt(1_001),
          },
          updatedAt: isoAt(1_001),
        }),
      ),
    };
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: runningSnapshot,
      configureFixture: (testFixture) => {
        testFixture.serverConfig = {
          ...testFixture.serverConfig,
          providers: testFixture.serverConfig.providers.map((provider) => ({
            ...provider,
            runtimeCapabilities: {
              liveSteer: "supported" as const,
              threadGoals: "unsupported" as const,
            },
          })),
        };
      },
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return { sequence: chatViewFixture.fixture.snapshot.snapshotSequence + 1 };
        }
        return undefined;
      },
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Deliver this steer exactly once");
      const queueButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Queue message"]'),
        "Unable to find the running composer Send button.",
      );
      queueButton.click();
      const steerButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            '[data-cafe-followup-queue="true"] .cafe-followup-steer-button',
          ),
        "Unable to find the queued follow-up Send action.",
      );
      steerButton.click();

      let dispatchedMessageId: MessageId | null = null;
      await vi.waitFor(
        () => {
          const request = wsRequests.find(
            (candidate) =>
              candidate._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              candidate.type === "thread.turn.steer",
          ) as
            | {
                readonly type: "thread.turn.steer";
                readonly message: { readonly messageId: MessageId };
              }
            | undefined;
          dispatchedMessageId = request?.message.messageId ?? null;
          expect(dispatchedMessageId).not.toBeNull();
          expect(
            document.querySelector('[aria-label="Follow-up steering into active turn"]'),
          ).not.toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );

      const emitReceiptActivity = (input: {
        readonly id: string;
        readonly kind: string;
        readonly payload: unknown;
      }) => {
        const currentThread = chatViewFixture.fixture.snapshot.threads[0]!;
        const snapshotSequence = chatViewFixture.fixture.snapshot.snapshotSequence + 1;
        const nextThread: OrchestrationReadModel["threads"][number] = {
          ...currentThread,
          activities: [
            ...currentThread.activities,
            {
              id: EventId.make(input.id),
              tone: "info",
              kind: input.kind,
              summary: "Steer delivery state changed",
              payload: input.payload,
              turnId: activeTurnId,
              // The server and live store project the enclosing durable
              // event's sequence, never the count of retained activity rows.
              sequence: snapshotSequence,
              createdAt: isoAt(1_010 + snapshotSequence),
            },
          ],
          updatedAt: isoAt(1_010 + snapshotSequence),
        };
        chatViewFixture.fixture.snapshot = {
          ...chatViewFixture.fixture.snapshot,
          snapshotSequence,
          threads: [nextThread],
        };
        rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
          kind: "snapshot",
          snapshot: { snapshotSequence, thread: nextThread },
        });
      };

      emitReceiptActivity({
        id: "activity-pre-io-steer-warning",
        kind: "runtime.warning",
        payload: {
          provider: "codex",
          messageId: dispatchedMessageId!,
          delivery: "next-turn",
        },
      });
      await waitForLayout();
      expect(
        document.querySelector('[aria-label="Follow-up steering into active turn"]'),
      ).not.toBeNull();

      emitReceiptActivity({
        id: "activity-steer-delivered",
        kind: "provider.turn.steer.delivered",
        payload: {
          provider: "codex",
          messageId: dispatchedMessageId!,
          deliveredTurnId: "turn-delivered-next",
          delivery: "next-turn",
          reason: "active-turn-ended-before-steer",
        },
      });
      await vi.waitFor(
        () => {
          expect(
            document.querySelector('[aria-label="Follow-up steering into active turn"]'),
          ).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps a same-id retry pending until that retry generation fails", async () => {
    const activeTurnId = "turn-same-id-steer-retry" as TurnId;
    const messageId = "msg-same-id-steer-retry" as MessageId;
    const baseSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-same-id-steer-target" as MessageId,
      targetText: "same-id steer target",
      sessionStatus: "running",
    });
    const retryMessage = {
      ...createUserMessage({
        id: messageId,
        text: "Retry this exact message",
        offsetSeconds: 2_000,
      }),
      turnId: activeTurnId,
    };
    const oldFailure = {
      id: EventId.make("activity-old-same-id-steer-failure"),
      tone: "error" as const,
      kind: "provider.turn.steer.failed",
      summary: "Codex could not steer the compact turn",
      payload: {
        provider: "codex",
        messageId,
        intentSequence: 41,
        retryableFollowUp: true,
        codexNonSteerableTurnKind: "compact",
      },
      turnId: activeTurnId,
      sequence: 42,
      createdAt: isoAt(2_002),
    };
    const runningSnapshot: OrchestrationReadModel = {
      ...baseSnapshot,
      threads: baseSnapshot.threads.map((thread) =>
        Object.assign({}, thread, {
          messages: [...thread.messages, retryMessage],
          activities: [oldFailure],
          latestTurn: {
            turnId: activeTurnId,
            state: "running" as const,
            requestedAt: isoAt(1_900),
            startedAt: isoAt(1_901),
            completedAt: null,
            assistantMessageId: null,
          },
          session: {
            ...thread.session!,
            status: "running" as const,
            activeTurnId,
            updatedAt: isoAt(2_003),
          },
          updatedAt: isoAt(2_003),
        }),
      ),
    };
    const currentIntentSequence = 77;
    let releaseRetryReceipt: (() => void) | undefined;
    const retryReceipt = new Promise<{ sequence: number }>((resolve) => {
      releaseRetryReceipt = () => resolve({ sequence: currentIntentSequence });
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: runningSnapshot,
      configureFixture: (testFixture) => {
        testFixture.serverConfig = {
          ...testFixture.serverConfig,
          providers: testFixture.serverConfig.providers.map((provider) => ({
            ...provider,
            runtimeCapabilities: {
              liveSteer: "supported" as const,
              threadGoals: "unsupported" as const,
            },
          })),
        };
      },
      resolveRpc: (body) =>
        body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand ? retryReceipt : undefined,
    });

    try {
      await vi.waitFor(
        () => {
          const steerButton = document.querySelector<HTMLButtonElement>(
            '[data-cafe-followup-queue="true"] .cafe-followup-steer-button',
          );
          const automaticallyDispatched = wsRequests.some(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.turn.steer",
          );
          expect(steerButton !== null || automaticallyDispatched).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
      // Compact-blocked retries can become immediately eligible and be
      // auto-steered; click only when the visible shelf action won the race.
      document
        .querySelector<HTMLButtonElement>(
          '[data-cafe-followup-queue="true"] .cafe-followup-steer-button',
        )
        ?.click();

      await vi.waitFor(
        () => {
          expect(
            wsRequests.some(
              (request) =>
                request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                request.type === "thread.turn.steer" &&
                (
                  request as unknown as {
                    readonly message: { readonly messageId: MessageId };
                  }
                ).message.messageId === messageId,
            ),
          ).toBe(true);
          // The old generation-41 failure remains in the snapshot, but must
          // not settle the generation-77 retry that reused its MessageId.
          expect(
            document.querySelector('[aria-label="Follow-up steering into active turn"]'),
          ).not.toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );

      const emitRetryObservation = (input: {
        id: string;
        kind: string;
        payload: Record<string, unknown>;
        sequence: number;
      }) => {
        const currentThread = chatViewFixture.fixture.snapshot.threads[0]!;
        const snapshotSequence =
          Math.max(chatViewFixture.fixture.snapshot.snapshotSequence, input.sequence) + 1;
        const nextThread = {
          ...currentThread,
          activities: [
            ...currentThread.activities,
            {
              id: EventId.make(input.id),
              tone: "info" as const,
              kind: input.kind,
              summary: "private receipt payload must not be previewed",
              payload: input.payload,
              turnId: activeTurnId,
              sequence: input.sequence,
              createdAt: new Date().toISOString(),
            },
          ],
        };
        chatViewFixture.fixture.snapshot = {
          ...chatViewFixture.fixture.snapshot,
          snapshotSequence,
          threads: [nextThread],
        };
        rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
          kind: "snapshot",
          snapshot: { snapshotSequence, thread: nextThread },
        });
      };
      const badge = () => document.querySelector<HTMLElement>("[data-steering-status]");
      emitRetryObservation({
        id: "old-acceptance-before-current-ack",
        kind: "provider.turn.steer.accepted",
        payload: {
          provider: "codex",
          messageId,
          acceptedTurnId: activeTurnId,
          intentSequence: 41,
        },
        sequence: 78,
      });
      emitRetryObservation({
        id: "old-processing-before-current-ack",
        kind: "task.progress",
        payload: {
          taskId: `codex-turn-steer-processing:${activeTurnId}`,
          messageId,
          detail: "Codex app-server began processing turn/steer.",
        },
        sequence: 75,
      });
      await waitForLayout();
      expect(badge()?.dataset.steeringStatus).toBe("sending");
      expect(document.querySelectorAll('[data-cafe-followup-steering="true"]')).toHaveLength(1);
      releaseRetryReceipt!();
      await waitForLayout();
      expect(badge()?.dataset.steeringStatus).toBe("sending");
      emitRetryObservation({
        id: "old-recovery-after-current-ack",
        kind: "provider.turn.steer.delivered",
        payload: {
          provider: "codex",
          messageId,
          intentSequence: 41,
          deliveredTurnId: "old-recovered-turn",
          delivery: "next-turn",
          reason: "active-turn-ended-before-steer",
        },
        sequence: 79,
      });
      await waitForLayout();
      expect(badge()?.dataset.steeringStatus).toBe("sending");
      emitRetryObservation({
        id: "current-acceptance-after-current-ack",
        kind: "provider.turn.steer.accepted",
        payload: {
          provider: "codex",
          messageId,
          acceptedTurnId: activeTurnId,
          intentSequence: currentIntentSequence,
        },
        sequence: 80,
      });
      await vi.waitFor(() => expect(badge()?.dataset.steeringStatus).toBe("received"));
      expect(badge()?.textContent).toBe("Accepted");
      const currentThread = chatViewFixture.fixture.snapshot.threads[0]!;
      const snapshotSequence = chatViewFixture.fixture.snapshot.snapshotSequence + 1;
      const nextThread: OrchestrationReadModel["threads"][number] = {
        ...currentThread,
        activities: [
          ...currentThread.activities,
          {
            ...oldFailure,
            id: EventId.make("activity-current-same-id-steer-failure"),
            payload: { ...oldFailure.payload, intentSequence: currentIntentSequence },
            sequence: 81,
            createdAt: new Date().toISOString(),
          },
        ],
        updatedAt: new Date().toISOString(),
      };
      chatViewFixture.fixture.snapshot = {
        ...chatViewFixture.fixture.snapshot,
        snapshotSequence,
        threads: [nextThread],
      };
      rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
        kind: "snapshot",
        snapshot: { snapshotSequence, thread: nextThread },
      });
      await vi.waitFor(
        () => {
          expect(
            document.querySelector('[aria-label="Follow-up steering into active turn"]'),
          ).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      releaseRetryReceipt?.();
      await mounted.cleanup();
    }
  });

  it("parks a rejected automatic file steer and retries only the exact message on explicit request", async () => {
    const activeTurnId = "turn-rejected-automatic-steer" as TurnId;
    const messageId = MessageId.make("message-rejected-automatic-steer");
    const text = "Keep this exact prompt and attached source";
    const attachments = [
      {
        type: "file" as const,
        id: "durable-file",
        name: "source.tex",
        mimeType: "text/plain",
        sizeBytes: 42,
      },
    ];
    const baseSnapshot = createSnapshotForTargetUser({
      targetMessageId: MessageId.make("original-user"),
      targetText: "Original request",
      sessionStatus: "running",
    });
    const snapshot: OrchestrationReadModel = {
      ...baseSnapshot,
      threads: baseSnapshot.threads.map((thread) => ({
        ...thread,
        messages: [
          ...thread.messages,
          {
            ...createUserMessage({ id: messageId, text, offsetSeconds: 2_000 }),
            attachments,
            turnId: activeTurnId,
          },
        ],
        activities: [
          {
            id: EventId.make("compact-steer-failure"),
            tone: "error",
            kind: "provider.turn.steer.failed",
            summary: "Steer postponed during compaction",
            payload: {
              provider: "codex",
              messageId,
              retryableFollowUp: true,
              codexNonSteerableTurnKind: "compact",
            },
            turnId: activeTurnId,
            sequence: 1,
            createdAt: isoAt(2_001),
          },
        ],
        latestTurn: {
          turnId: activeTurnId,
          state: "running",
          requestedAt: isoAt(1_900),
          startedAt: isoAt(1_901),
          completedAt: null,
          assistantMessageId: null,
        },
        session: { ...thread.session!, status: "running", activeTurnId, updatedAt: isoAt(2_002) },
        updatedAt: isoAt(2_002),
      })),
    };
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
      configureFixture: (testFixture) => {
        testFixture.serverConfig = {
          ...testFixture.serverConfig,
          providers: testFixture.serverConfig.providers.map((provider) => ({
            ...provider,
            runtimeCapabilities: { liveSteer: "supported", threadGoals: "unsupported" },
          })),
        };
      },
      resolveRpc: (body) =>
        body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand && body.type === "thread.turn.steer"
          ? failBrowserWsRpc(
              new OrchestrationDispatchCommandError({
                message: "Message identity is already bound to different content in this thread.",
              }),
            )
          : undefined,
    });
    const steerRequests = () =>
      wsRequests.filter(
        (request) =>
          request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
          request.type === "thread.turn.steer",
      );
    try {
      await expect.element(page.getByRole("button", { name: "Retry delivery" })).toBeEnabled();
      expect(steerRequests()).toHaveLength(1);
      expect(document.body.textContent).toContain("1 steer needs attention");
      expect(document.body.textContent).not.toContain("1 steer waiting for compaction");
      // Repeated provider snapshots used to repeatedly remove/reinsert the
      // row and create a fresh command for the same permanent rejection.
      for (let revision = 1; revision <= 3; revision += 1) {
        const thread = chatViewFixture.fixture.snapshot.threads[0]!;
        const snapshotSequence = chatViewFixture.fixture.snapshot.snapshotSequence + 1;
        const nextThread = { ...thread, updatedAt: isoAt(2_010 + revision) };
        chatViewFixture.fixture.snapshot = {
          ...chatViewFixture.fixture.snapshot,
          snapshotSequence,
          threads: [nextThread],
        };
        rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
          kind: "snapshot",
          snapshot: { snapshotSequence, thread: nextThread },
        });
        await waitForLayout();
      }
      expect(steerRequests()).toHaveLength(1);
      await page.getByRole("button", { name: "Retry delivery" }).click();
      await expect.element(page.getByRole("button", { name: "Retry delivery" })).toBeEnabled();
      expect(steerRequests()).toHaveLength(2);
      for (const request of steerRequests()) {
        expect(request.message).toEqual({ messageId, role: "user", text, attachments });
      }
      await waitForLayout();
      expect(steerRequests()).toHaveLength(2);
    } finally {
      await mounted.cleanup();
    }
  });

  it("rechecks a legacy completed-root queue once and preserves a fresh rejection without looping", async () => {
    const activeTurnId = "turn-legacy-root-children-active" as TurnId;
    const messageId = MessageId.make("message-legacy-root-retry");
    const text = "Preserve this exact queued follow-up";
    const baseSnapshot = createSnapshotForTargetUser({
      targetMessageId: MessageId.make("original-root-user"),
      targetText: "Original root work",
      sessionStatus: "running",
    });
    const oldFailure = {
      id: EventId.make("legacy-root-failure"),
      tone: "error" as const,
      kind: "provider.turn.steer.failed",
      summary: "Provider steer queued",
      payload: {
        messageId,
        intentSequence: 41,
        retryableFollowUp: true,
        recoveryBarrier: "newer-turn-active",
      },
      turnId: activeTurnId,
      sequence: 42,
      createdAt: isoAt(2_002),
    };
    const snapshot: OrchestrationReadModel = {
      ...baseSnapshot,
      threads: baseSnapshot.threads.map((thread) => ({
        ...thread,
        messages: [
          ...thread.messages,
          {
            ...createUserMessage({ id: messageId, text, offsetSeconds: 2_000 }),
            turnId: activeTurnId,
          },
        ],
        activities: [
          {
            id: EventId.make("legacy-root-completion-deferred"),
            tone: "info",
            kind: "runtime.warning",
            summary: "Runtime warning",
            payload: {
              message: "Codex root turn completed; waiting for 3 routed subagent threads.",
              detail: { rootCompletedAt: isoAt(1_950), childThreadCount: 3 },
            },
            turnId: activeTurnId,
            sequence: 40,
            createdAt: isoAt(1_950),
          },
          oldFailure,
        ],
        latestTurn: {
          turnId: activeTurnId,
          state: "running",
          requestedAt: isoAt(1_900),
          startedAt: isoAt(1_901),
          completedAt: null,
          assistantMessageId: null,
        },
        session: { ...thread.session!, status: "running", activeTurnId, updatedAt: isoAt(2_003) },
        updatedAt: isoAt(2_003),
      })),
    };
    let releaseRootRecheckReceipt: (() => void) | undefined;
    const rootRecheckReceipt = new Promise<{ sequence: number }>((resolve) => {
      releaseRootRecheckReceipt = () => resolve({ sequence: 77 });
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
      configureFixture: (testFixture) => {
        testFixture.serverConfig = {
          ...testFixture.serverConfig,
          providers: testFixture.serverConfig.providers.map((provider) => ({
            ...provider,
            runtimeCapabilities: { liveSteer: "supported", threadGoals: "unsupported" },
          })),
        };
      },
      resolveRpc: (body) =>
        body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand ? rootRecheckReceipt : undefined,
    });
    const steerRequests = () =>
      wsRequests.filter(
        (request) =>
          request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
          request.type === "thread.turn.steer",
      );
    try {
      await vi.waitFor(() => expect(steerRequests()).toHaveLength(1));
      expect(steerRequests()[0]?.message).toEqual({
        messageId,
        role: "user",
        text,
        attachments: [],
      });
      await vi.waitFor(() =>
        expect(
          document.querySelector('[aria-label="Follow-up steering into active turn"]'),
        ).not.toBeNull(),
      );

      const staleRejectedAt = new Date().toISOString();
      const staleSequence = Math.max(chatViewFixture.fixture.snapshot.snapshotSequence, 43) + 1;
      const staleThread = {
        ...chatViewFixture.fixture.snapshot.threads[0]!,
        messages: chatViewFixture.fixture.snapshot.threads[0]!.messages.map((message) =>
          message.id === messageId ? { ...message, completedAt: staleRejectedAt } : message,
        ),
        activities: [
          ...chatViewFixture.fixture.snapshot.threads[0]!.activities,
          {
            ...oldFailure,
            id: EventId.make("old-blocked-root-recheck-before-new-ack"),
            payload: { ...oldFailure.payload, recoveryBarrier: "active-turn-not-idle" },
            sequence: 43,
            createdAt: staleRejectedAt,
          },
        ],
      };
      chatViewFixture.fixture.snapshot = {
        ...chatViewFixture.fixture.snapshot,
        snapshotSequence: staleSequence,
        threads: [staleThread],
      };
      rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
        kind: "snapshot",
        snapshot: { snapshotSequence: staleSequence, thread: staleThread },
      });
      await waitForLayout();
      expect(document.querySelector('[data-cafe-followup-steering="true"]')).not.toBeNull();
      expect(document.querySelector('button[aria-label="Remove queued message"]')).toBeNull();
      releaseRootRecheckReceipt!();
      await waitForLayout();
      expect(document.querySelector('[data-cafe-followup-steering="true"]')).not.toBeNull();
      expect(document.querySelector('button[aria-label="Remove queued message"]')).toBeNull();
      expect(steerRequests()).toHaveLength(1);

      // Native state can change before the server reads it. A fresh guard
      // rejection must restore the shelf once and never repeat the old
      // generation's eligibility merely because child output keeps arriving.
      const rejectedAt = new Date().toISOString();
      for (let revision = 0; revision < 4; revision += 1) {
        const thread = chatViewFixture.fixture.snapshot.threads[0]!;
        const snapshotSequence = chatViewFixture.fixture.snapshot.snapshotSequence + 1;
        const nextThread: OrchestrationReadModel["threads"][number] = {
          ...thread,
          messages: thread.messages.map((message) =>
            message.id === messageId ? { ...message, completedAt: rejectedAt } : message,
          ),
          activities:
            revision === 0
              ? [
                  ...thread.activities,
                  {
                    ...oldFailure,
                    id: EventId.make("current-root-idle-recheck-rejected"),
                    payload: {
                      ...oldFailure.payload,
                      intentSequence: 77,
                      recoveryBarrier: "active-turn-not-idle",
                    },
                    sequence: 78,
                    createdAt: rejectedAt,
                  },
                ]
              : thread.activities,
          updatedAt: rejectedAt,
        };
        chatViewFixture.fixture.snapshot = {
          ...chatViewFixture.fixture.snapshot,
          snapshotSequence,
          threads: [nextThread],
        };
        rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
          kind: "snapshot",
          snapshot: { snapshotSequence, thread: nextThread },
        });
        await waitForLayout();
      }
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("1 follow-up requeued");
        expect(
          document.querySelector('[aria-label="Follow-up steering into active turn"]'),
        ).toBeNull();
      });
      expect(steerRequests()).toHaveLength(1);
    } finally {
      releaseRootRecheckReceipt?.();
      await mounted.cleanup();
    }
  });

  it("reconstructs more than 64 durable steer retries once after a reload", async () => {
    const activeTurnId = "turn-reload-retry-review" as TurnId;
    const baseSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-reload-retry-target" as MessageId,
      targetText: "reload retry target",
      sessionStatus: "running",
    });
    const retryMessages = Array.from({ length: 65 }, (_, index) => ({
      ...createUserMessage({
        id: `msg-reload-retry-${index}` as MessageId,
        text: `Durable retry prompt ${index}`,
        offsetSeconds: 2_000 + index * 2,
      }),
      turnId: activeTurnId,
    }));
    const retryActivities = retryMessages.map((message, index) => ({
      id: EventId.make(`activity-reload-retry-${index}`),
      tone: "error" as const,
      kind: "provider.turn.steer.failed",
      summary: "Codex could not steer the review turn",
      payload: {
        provider: "codex",
        messageId: message.id,
        retryableFollowUp: true,
        codexNonSteerableTurnKind: "review",
      },
      turnId: activeTurnId,
      sequence: index + 1,
      createdAt: isoAt(2_001 + index * 2),
    }));
    const reloadSnapshot: OrchestrationReadModel = {
      ...baseSnapshot,
      threads: baseSnapshot.threads.map((thread) =>
        Object.assign({}, thread, {
          messages: [...thread.messages, ...retryMessages],
          activities: retryActivities,
          latestTurn: {
            turnId: activeTurnId,
            state: "running" as const,
            requestedAt: isoAt(1_900),
            startedAt: isoAt(1_901),
            completedAt: null,
            assistantMessageId: null,
          },
          session: {
            ...thread.session!,
            status: "running" as const,
            activeTurnId,
            updatedAt: isoAt(2_200),
          },
          updatedAt: isoAt(2_200),
        }),
      ),
    };
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: reloadSnapshot,
      configureFixture: (testFixture) => {
        testFixture.serverConfig = {
          ...testFixture.serverConfig,
          providers: testFixture.serverConfig.providers.map((provider) => ({
            ...provider,
            runtimeCapabilities: {
              liveSteer: "supported" as const,
              threadGoals: "unsupported" as const,
            },
          })),
        };
      },
    });

    try {
      await vi.waitFor(
        () => {
          expect(
            document.querySelectorAll('button[aria-label="Remove queued message"]').length,
          ).toBe(65);
          expect(document.body.textContent).toContain("65 steers waiting");
          expect(document.body.textContent).toContain("Durable retry prompt 0");
          expect(document.body.textContent).toContain("Durable retry prompt 64");
        },
        { timeout: 12_000, interval: 16 },
      );
      expect(
        wsRequests.some(
          (request) =>
            request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            (request.type === "thread.turn.steer" || request.type === "thread.turn.start"),
        ),
      ).toBe(false);

      // Replaying the same canonical snapshot models reconnect hydration.
      // Every source MessageId must remain represented exactly once.
      const currentThread = chatViewFixture.fixture.snapshot.threads[0]!;
      const snapshotSequence = chatViewFixture.fixture.snapshot.snapshotSequence + 1;
      chatViewFixture.fixture.snapshot = {
        ...chatViewFixture.fixture.snapshot,
        snapshotSequence,
        threads: [{ ...currentThread, updatedAt: isoAt(2_201) }],
      };
      rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
        kind: "snapshot",
        snapshot: {
          snapshotSequence,
          thread: chatViewFixture.fixture.snapshot.threads[0]!,
        },
      });
      await waitForLayout();
      expect(document.querySelectorAll('button[aria-label="Remove queued message"]').length).toBe(
        65,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps Send guarded when a mobile follow-up collapses the keyboard overlay", async () => {
    const restoreTouchMediaQuery = forceOnScreenKeyboardMediaQuery();
    const mounted = await mountChatView({
      viewport: COMPACT_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-mobile-running-follow-up-send" as MessageId,
        targetText: "mobile running follow-up send target",
        sessionStatus: "running",
      }),
    });

    try {
      useComposerDraftStore
        .getState()
        .setPrompt(THREAD_REF, "Queue this mobile follow-up without interrupting");

      const expandButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Expand composer"]'),
        "Unable to find the compact running composer expand button.",
      );
      expandButton.click();

      const overlayQueueButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            '[data-chat-composer-mobile-pending-actions="true"] button[aria-label="Queue message"]',
          ),
        "Unable to find the mobile keyboard overlay Send button.",
      );
      expect(
        document.querySelector<HTMLButtonElement>(
          '[data-chat-composer-mobile-pending-actions="true"] button[aria-label="Stop generation"]',
        ),
      ).toBeNull();

      // Let the synchronous expand gesture release before exercising the
      // next touch gesture, matching a real user tap after the keyboard has
      // opened rather than compressing both gestures into one animation frame.
      await waitForLayout();
      overlayQueueButton.click();

      const guardedFooterQueueButton = await waitForElement(() => {
        const button = document.querySelector<HTMLButtonElement>(
          '[data-chat-composer-actions="right"] button[aria-label="Queue message"]',
        );
        return button?.disabled ? button : null;
      }, "The mobile footer did not preserve the guarded Send action after hiding the keyboard.");
      expect(document.querySelector('[data-cafe-followup-queue="true"]')).not.toBeNull();
      expect(useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]?.prompt ?? "").toBe("");
      expect(
        document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
      ).toBeNull();

      // A second activation at the same coordinates remains inert after the
      // overlay-to-footer transition instead of interrupting the provider.
      guardedFooterQueueButton.click();
      await waitForLayout();
      expect(
        wsRequests.some(
          (request) =>
            request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            request.type === "thread.turn.interrupt",
        ),
      ).toBe(false);

      await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
        "Stop did not return after the mobile post-send guard elapsed.",
      );
    } finally {
      await mounted.cleanup();
      restoreTouchMediaQuery();
    }
  });
});
