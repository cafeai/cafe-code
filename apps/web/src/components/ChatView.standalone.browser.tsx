// This file owns only its feature journeys; the shared module owns fixture lifecycle.
import {
  registerChatViewBrowserHooks,
  chatViewFixture,
  THREAD_ID,
  PROJECT_ID,
  LOCAL_ENVIRONMENT_ID,
  THREAD_REF,
  UUID_ROUTE_RE,
  NOW_ISO,
  type TestFixture,
  rpcHarness,
  wsRequests,
  encodeServerConfig,
  DEFAULT_VIEWPORT,
  WIDE_FOOTER_VIEWPORT,
  isoAt,
  createSnapshotForTargetUser,
  addThreadToSnapshot,
  toShellThread,
  threadRefFor,
  draftIdFromPath,
  draftThreadIdFor,
  serverThreadPath,
  startPromotedServerThreadViaDomainEvent,
  createProjectlessSnapshot,
  SUBAGENT_RUNTIME_ID,
  waitForLayout,
  waitForElement,
  waitForComposerEditor,
  waitForSendButton,
  findSessionRail,
  waitForButtonByText,
  waitForServerConfigToApply,
  mountChatView,
  createSnapshotWithActiveSubagent,
  createSnapshotWithPlanFollowUpPrompt,
} from "./ChatViewBrowser.shared";
import { scopeThreadRef } from "@cafecode/client-runtime";
import {
  CheckpointRef,
  EnvironmentId,
  EventId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationReadModel,
  type ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  WS_METHODS,
} from "@cafecode/contracts";
import { createModelCapabilities, createModelSelection } from "@cafecode/shared/model";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { deskTabKey } from "../deskModel";
import { useDeskStore } from "../deskStore";
import { applySettingsUpdated, getServerConfig } from "../rpc/serverState";
import { selectThreadByRef, useStore } from "../store";
import { useUiStateStore } from "../uiStateStore";
import { buildSubagentConcurrencyEditorKey } from "./chat/ChatComposer";
import { createFollowUpQueuePersistence } from "./chat/followUpQueuePersistence";
import { createChatViewCallerOwner } from "./chatViewCallerOwner.test.fixture";

describe("ChatView full app (standalone)", () => {
  registerChatViewBrowserHooks();

  const waitForStandaloneComposerText = async (text: string) => {
    await vi.waitFor(
      () =>
        expect(
          document.querySelector('.desk-pane[data-active="true"] [data-testid="composer-editor"]')
            ?.textContent,
        ).toBe(text),
      { timeout: 8_000, interval: 16 },
    );
  };
  const newChatShortcut = () =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "n",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  const configureStandaloneShortcut = (next: TestFixture) => {
    next.serverConfig = {
      ...next.serverConfig,
      keybindings: [
        {
          command: "chat.new",
          shortcut: {
            key: "n",
            modKey: false,
            ctrlKey: true,
            metaKey: false,
            altKey: false,
            shiftKey: false,
          },
        },
      ],
    };
  };

  it("hides historical checkpoint restore controls after detach while preserving linked controls", async () => {
    const userMessageId = MessageId.make("checkpoint-history-user");
    const assistantMessageId = MessageId.make("msg-assistant-3");
    const turnId = "checkpoint-history-turn" as TurnId;
    const base = createSnapshotForTargetUser({
      targetMessageId: userMessageId,
      targetText: "Historical linked work",
    });
    const thread = base.threads[0]!;
    const snapshot: OrchestrationReadModel = {
      ...base,
      threads: [
        {
          ...thread,
          messages: thread.messages
            .filter((message) => message.id === userMessageId || message.id === assistantMessageId)
            .map((message) => ({ ...message, turnId })),
          checkpoints: [
            {
              turnId,
              checkpointTurnCount: 1,
              checkpointRef: CheckpointRef.make("refs/cafe/checkpoints/historical/turn/1"),
              status: "ready",
              files: [],
              assistantMessageId,
              completedAt: NOW_ISO,
            },
          ],
        },
      ],
    };
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    const restoreControl = () =>
      document.querySelector<HTMLButtonElement>('button[title="Revert to this message"]');
    const publishAssociation = (projectId: ProjectId | null) => {
      const snapshotSequence = chatViewFixture.fixture.snapshot.snapshotSequence + 1;
      const nextThread = {
        ...chatViewFixture.fixture.snapshot.threads[0]!,
        projectId,
        branch: null,
        worktreePath: null,
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
    try {
      await vi.waitFor(() => expect(restoreControl()).not.toBeNull());
      publishAssociation(null);
      await vi.waitFor(() => {
        const detached = selectThreadByRef(useStore.getState(), THREAD_REF);
        expect(detached?.projectId).toBeNull();
        expect(detached?.turnDiffSummaries).toHaveLength(1);
        expect(restoreControl()).toBeNull();
      });
      expect(
        wsRequests.some(
          (body) =>
            body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            body.type === "thread.checkpoint.revert",
        ),
      ).toBe(false);
      publishAssociation(PROJECT_ID);
      await vi.waitFor(() => expect(restoreControl()).not.toBeNull());
    } finally {
      await mounted.cleanup();
    }
  });

  describe("live account subagent defaults", () => {
    const account = ProviderInstanceId.make("codex");
    const peer = ProviderInstanceId.make("codex-live-peer");
    function configureLiveDefaults(next: TestFixture) {
      const own = next.serverConfig.providers.find((provider) => provider.instanceId === account)!;
      next.serverConfig = {
        ...next.serverConfig,
        providers: [
          ...next.serverConfig.providers,
          { ...own, instanceId: peer, displayName: "Live peer account" },
        ].map((provider) => ({
          ...provider,
          runtimeCapabilities: {
            liveSteer: "unsupported",
            threadGoals: "unsupported",
            ...provider.runtimeCapabilities,
            subagentConcurrency: true,
          },
        })),
        settings: {
          ...next.serverConfig.settings,
          providerInstances: {
            ...next.serverConfig.settings.providerInstances,
            [account]: {
              driver: ProviderDriverKind.make("codex"),
              defaultMaxConcurrentSubagents: 12,
            },
            [peer]: {
              driver: ProviderDriverKind.make("codex"),
              defaultMaxConcurrentSubagents: 64,
            },
          },
        },
      };
    }
    function updateAccountDefault(value: number | undefined) {
      chatViewFixture.fixture.serverConfig = {
        ...chatViewFixture.fixture.serverConfig,
        settings: {
          ...chatViewFixture.fixture.serverConfig.settings,
          providerInstances: {
            ...chatViewFixture.fixture.serverConfig.settings.providerInstances,
            [account]: {
              driver: ProviderDriverKind.make("codex"),
              ...(value !== undefined ? { defaultMaxConcurrentSubagents: value } : {}),
            },
          },
        },
      };
      applySettingsUpdated(chatViewFixture.fixture.serverConfig.settings);
    }
    async function revokeLiveAccountCapability() {
      updateAccountDefault(24);
      chatViewFixture.fixture.serverConfig = {
        ...chatViewFixture.fixture.serverConfig,
        providers: chatViewFixture.fixture.serverConfig.providers.map((provider) =>
          provider.instanceId === account
            ? {
                ...provider,
                runtimeCapabilities: {
                  liveSteer: "supported",
                  threadGoals: "unsupported",
                  ...provider.runtimeCapabilities,
                  subagentConcurrency: false,
                },
              }
            : provider,
        ),
      };
      rpcHarness.emitStreamValue(WS_METHODS.subscribeServerConfig, {
        version: 1,
        type: "snapshot",
        config: encodeServerConfig(chatViewFixture.fixture.serverConfig),
      });
      await vi.waitFor(() =>
        expect(
          getServerConfig()?.providers.find((provider) => provider.instanceId === account)
            ?.runtimeCapabilities?.subagentConcurrency,
        ).toBe(false),
      );
    }
    function publishPolicy(limits: { codex?: number; claude?: number }, configured: number | null) {
      const original = chatViewFixture.fixture.snapshot.threads[0]!;
      const nextThread = {
        ...original,
        subagentLimits: limits,
        session: original.session
          ? { ...original.session, maxConcurrentSubagents: configured }
          : null,
      };
      const snapshotSequence = chatViewFixture.fixture.snapshot.snapshotSequence + 10;
      chatViewFixture.fixture.snapshot = {
        ...chatViewFixture.fixture.snapshot,
        snapshotSequence,
        threads: [nextThread],
      };
      rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
        kind: "snapshot",
        snapshot: { snapshotSequence, thread: nextThread },
      });
    }
    function policySnapshot(override: number | undefined, configured: number) {
      const base = createSnapshotForTargetUser({
        targetMessageId: MessageId.make("live-account-policy"),
        targetText: "Existing chat uses account policy",
        history: "essential",
      });
      return {
        ...base,
        threads: base.threads.map((thread) => ({
          ...thread,
          subagentLimits: override === undefined ? {} : { codex: override },
          session: thread.session
            ? {
                ...thread.session,
                providerInstanceId: account,
                maxConcurrentSubagents: configured,
              }
            : null,
        })),
      };
    }
    function continuationSnapshot(running: boolean) {
      const original = running ? createSnapshotWithActiveSubagent() : policySnapshot(undefined, 12);
      return {
        ...original,
        threads: original.threads.map((thread) => ({
          ...thread,
          subagentLimits: {},
          session: thread.session
            ? {
                ...thread.session,
                providerInstanceId: account,
                maxConcurrentSubagents: 12,
                subagentRuntimeId: SUBAGENT_RUNTIME_ID,
              }
            : null,
        })),
      };
    }
    function configureExistingContinuation(next: TestFixture) {
      configureLiveDefaults(next);
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
        providers: next.serverConfig.providers.map((provider) =>
          provider.instanceId === account
            ? {
                ...provider,
                // Bind the fixture's exact saved model/options explicitly;
                // fallback catalogues evolve independently of this policy.
                models: [
                  {
                    slug: "gpt-5",
                    name: "GPT-5",
                    isCustom: false,
                    capabilities: createModelCapabilities({ optionDescriptors: [] }),
                  },
                ],
                runtimeCapabilities: {
                  threadGoals: "unsupported",
                  ...provider.runtimeCapabilities,
                  liveSteer: "supported",
                  subagentConcurrency: false,
                  subagentPolicyContinuation: true,
                },
              }
            : provider,
        ),
      };
    }
    it.each(["send", "steer"] as const)(
      "admits exact existing-process %s while the native version capability is unknown",
      async (action) => {
        const mounted = await mountChatView({
          viewport: WIDE_FOOTER_VIEWPORT,
          snapshot: continuationSnapshot(action === "steer"),
          configureFixture: configureExistingContinuation,
          resolveRpc: (body) =>
            body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand ? { sequence: 2 } : undefined,
        });
        const prompt = "Continue this exact owned process with its applied limit";
        try {
          await waitForServerConfigToApply();
          expect(
            getServerConfig()?.providers.find((provider) => provider.instanceId === account)
              ?.runtimeCapabilities?.subagentConcurrency,
          ).toBe(false);
          useComposerDraftStore.getState().setPrompt(THREAD_REF, prompt);
          await vi.waitFor(() =>
            expect(document.querySelector('[contenteditable="true"]')?.textContent).toContain(
              prompt,
            ),
          );
          if (action === "steer") {
            (await waitForComposerEditor()).focus();
            await userEvent.keyboard("{Control>}{Enter}{/Control}");
          } else (await waitForSendButton()).click();
          await vi.waitFor(() =>
            expect(
              wsRequests.filter(
                (body) =>
                  body.type === (action === "steer" ? "thread.turn.steer" : "thread.turn.start"),
              ),
            ).toHaveLength(1),
          );
          expect(wsRequests.some((body) => body.type === "thread.create")).toBe(false);
          expect(
            getServerConfig()?.providers.find((provider) => provider.instanceId === account)
              ?.runtimeCapabilities?.subagentConcurrency,
          ).toBe(false);
        } finally {
          await mounted.cleanup();
        }
      },
    );
    it("does not lend an applied numeric session limit without Cafe continuation availability", async () => {
      const mounted = await mountChatView({
        viewport: WIDE_FOOTER_VIEWPORT,
        snapshot: continuationSnapshot(false),
        configureFixture: (next) => {
          configureExistingContinuation(next);
          next.serverConfig = {
            ...next.serverConfig,
            providers: next.serverConfig.providers.map((provider) =>
              provider.instanceId === account
                ? {
                    ...provider,
                    runtimeCapabilities: {
                      liveSteer: "supported",
                      threadGoals: "unsupported",
                      subagentConcurrency: false,
                    },
                  }
                : provider,
            ),
          };
        },
      });
      const prompt = "Do not consume this unsupported fresh-start policy";
      try {
        await waitForServerConfigToApply();
        useComposerDraftStore.getState().setPrompt(THREAD_REF, prompt);
        await vi.waitFor(() =>
          expect(document.querySelector('[contenteditable="true"]')?.textContent).toContain(prompt),
        );
        (await waitForSendButton()).click();
        await vi.waitFor(() =>
          expect(document.body.textContent).toContain(
            "This provider runtime does not support the account subagent limit.",
          ),
        );
        expect(wsRequests.some((body) => body.type === "thread.turn.start")).toBe(false);
        expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(prompt);
      } finally {
        await mounted.cleanup();
      }
    });
    it("delivers a queued follow-up only through the exact existing-process continuation guarantee", async () => {
      const queue = createFollowUpQueuePersistence();
      const snapshot = continuationSnapshot(false);
      const thread = snapshot.threads[0]!;
      expect(
        (
          await queue.save(LOCAL_ENVIRONMENT_ID, [
            {
              id: "exact-continuation-queued",
              environmentId: LOCAL_ENVIRONMENT_ID,
              threadId: THREAD_ID,
              promptText: "Continue the already-materialized exact queued process",
              images: [],
              files: [],
              provider: ProviderDriverKind.make("codex"),
              model: thread.modelSelection.model,
              promptEffort: null,
              modelSelection: thread.modelSelection,
              runtimeMode: thread.runtimeMode,
              interactionMode: "default",
              queuedAt: isoAt(1000),
              blockedReason: null,
            },
          ])
        ).ok,
      ).toBe(true);
      const mounted = await mountChatView({
        viewport: WIDE_FOOTER_VIEWPORT,
        snapshot,
        configureFixture: configureExistingContinuation,
        resolveRpc: (body) =>
          body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand ? { sequence: 2 } : undefined,
      });
      try {
        await waitForServerConfigToApply();
        await vi.waitFor(() =>
          expect(wsRequests.filter((body) => body.type === "thread.turn.start")).toHaveLength(1),
        );
        const submitted = wsRequests.find((body) => body.type === "thread.turn.start")!;
        expect(submitted).toMatchObject({
          threadId: THREAD_ID,
          message: { text: "Continue the already-materialized exact queued process" },
        });
        expect(submitted).not.toHaveProperty("subagentLimits");
        await vi.waitFor(() => {
          const persisted = queue.load(LOCAL_ENVIRONMENT_ID);
          expect(persisted.ok).toBe(true);
          if (persisted.ok) {
            expect(persisted.value.pending).toHaveLength(0);
            expect(persisted.value.claimed).toHaveLength(0);
          }
        });
        expect(
          getServerConfig()?.providers.find((provider) => provider.instanceId === account)
            ?.runtimeCapabilities?.subagentConcurrency,
        ).toBe(false);
      } finally {
        await mounted.cleanup();
      }
    });
    it.each(["send", "steer"] as const)(
      "rechecks exact continuation authority after deferred %s attachment preparation",
      async (action) => {
        const mounted = await mountChatView({
          viewport: WIDE_FOOTER_VIEWPORT,
          snapshot: continuationSnapshot(action === "steer"),
          configureFixture: configureExistingContinuation,
        });
        const prompt = "Preserve this exact continuation-race draft";
        const originalRead = FileReader.prototype.readAsDataURL;
        const prepared: { reader: FileReader; blob: Blob }[] = [];
        let restoreReadSpy: (() => void) | undefined;
        let restorePersistenceSpy: (() => void) | undefined;
        let retirePersistenceRead: () => void = () => undefined;
        let retired = false;
        const releaseReaders = () => {
          for (const { reader, blob } of prepared.splice(0)) originalRead.call(reader, blob);
        };
        const cleanup = async () => {
          if (retired) return;
          retired = true;
          retirePersistenceRead();
          restorePersistenceSpy?.();
          restoreReadSpy?.();
          // Retire the owning UI before releasing any held submission bytes.
          // The same one-shot cleanup also owns hard-timeout retirement.
          try {
            await mounted.cleanup();
          } finally {
            releaseReaders();
          }
        };
        onTestFinished(cleanup);
        try {
          await waitForServerConfigToApply();
          useComposerDraftStore.getState().setPrompt(THREAD_REF, prompt);
          await vi.waitFor(() =>
            expect(document.querySelector('[contenteditable="true"]')?.textContent).toContain(
              prompt,
            ),
          );
          const imageFile = new File(["x"], "draft.png", { type: "image/png" });
          let resolvePersistenceRead!: () => void;
          let rejectPersistenceRead!: (error: Error) => void;
          const persistenceRead = new Promise<void>((resolve, reject) => {
            resolvePersistenceRead = resolve;
            rejectPersistenceRead = reject;
          });
          // Setup/timeout cleanup can retire this receipt before its await;
          // retain rejection for that await without an unhandled tail.
          void persistenceRead.catch(() => undefined);
          let persistenceStarted = false;
          let persistenceSettled = false;
          let detachPersistenceRead: () => void = () => undefined;
          retirePersistenceRead = () => {
            detachPersistenceRead();
            if (persistenceSettled) return;
            persistenceSettled = true;
            rejectPersistenceRead(new Error("The exact fixture image read was retired."));
          };
          const persistenceSpy = vi
            .spyOn(FileReader.prototype, "readAsDataURL")
            .mockImplementation(function (this: FileReader, blob: Blob) {
              if (blob === imageFile && !persistenceStarted) {
                persistenceStarted = true;
                const reader = this;
                const complete = () => {
                  if (persistenceSettled) return;
                  persistenceSettled = true;
                  detachPersistenceRead();
                  if (typeof reader.result === "string") resolvePersistenceRead();
                  else
                    rejectPersistenceRead(
                      new Error("The exact fixture image read returned no data."),
                    );
                };
                const fail = () => {
                  if (persistenceSettled) return;
                  persistenceSettled = true;
                  detachPersistenceRead();
                  rejectPersistenceRead(
                    new Error("The exact fixture image read failed or was aborted."),
                  );
                };
                detachPersistenceRead = () => {
                  reader.removeEventListener("load", complete);
                  reader.removeEventListener("error", fail);
                  reader.removeEventListener("abort", fail);
                };
                reader.addEventListener("load", complete, { once: true });
                reader.addEventListener("error", fail, { once: true });
                reader.addEventListener("abort", fail, { once: true });
              }
              // Observe the real effect-owned native read; do not replace its
              // result, force storage, or borrow a later submission read.
              try {
                return originalRead.call(this, blob);
              } catch (error) {
                if (blob === imageFile && !persistenceSettled) {
                  persistenceSettled = true;
                  detachPersistenceRead();
                  rejectPersistenceRead(new Error("The exact fixture image read could not start."));
                }
                throw error;
              }
            });
          restorePersistenceSpy = () => persistenceSpy.mockRestore();
          useComposerDraftStore.getState().addImages(THREAD_REF, [
            {
              id: "continuation-race-image",
              type: "image",
              name: "draft.png",
              mimeType: "image/png",
              sizeBytes: 1,
              previewUrl: "data:image/png;base64,eA==",
              file: imageFile,
            },
          ]);
          await persistenceRead;
          if (retired) throw new Error("The exact continuation fixture was retired.");
          restorePersistenceSpy();
          restorePersistenceSpy = undefined;
          // The original state observer now starts after the exact native
          // persistence read, not before the image effect's React admission.
          await vi.waitFor(() =>
            expect(
              useComposerDraftStore
                .getState()
                .getComposerDraft(THREAD_REF)
                ?.persistedAttachments.map((image) => image.id),
            ).toEqual(["continuation-race-image"]),
          );
          const readSpy = vi
            .spyOn(FileReader.prototype, "readAsDataURL")
            .mockImplementation(function (this: FileReader, blob: Blob) {
              prepared.push({ reader: this, blob });
            });
          restoreReadSpy = () => readSpy.mockRestore();
          if (action === "steer") {
            (await waitForComposerEditor()).focus();
            await userEvent.keyboard("{Control>}{Enter}{/Control}");
          } else (await waitForSendButton()).click();
          await vi.waitFor(() => expect(prepared).toHaveLength(1));
          // The fleet revokes Cafe continuation availability while bytes
          // are being prepared. Numeric history is insufficient at this
          // advisory boundary, even though the policy remains unchanged;
          // actual owner qualification is additionally required server-side.
          chatViewFixture.fixture.serverConfig = {
            ...chatViewFixture.fixture.serverConfig,
            providers: chatViewFixture.fixture.serverConfig.providers.map((provider) =>
              provider.instanceId === account
                ? {
                    ...provider,
                    runtimeCapabilities: {
                      ...provider.runtimeCapabilities!,
                      subagentPolicyContinuation: false,
                    },
                  }
                : provider,
            ),
          };
          rpcHarness.emitStreamValue(WS_METHODS.subscribeServerConfig, {
            version: 1,
            type: "snapshot",
            config: encodeServerConfig(chatViewFixture.fixture.serverConfig),
          });
          await vi.waitFor(() =>
            expect(
              getServerConfig()?.providers.find((provider) => provider.instanceId === account)
                ?.runtimeCapabilities?.subagentPolicyContinuation,
            ).toBe(false),
          );
          releaseReaders();
          await vi.waitFor(() =>
            expect(document.body.textContent).toContain(
              "This provider runtime does not support the account subagent limit.",
            ),
          );
          expect(
            wsRequests.some(
              (body) => body.type === "thread.turn.start" || body.type === "thread.turn.steer",
            ),
          ).toBe(false);
          expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(
            prompt,
          );
          expect(
            useComposerDraftStore
              .getState()
              .getComposerDraft(THREAD_REF)
              ?.images.map((image) => image.id),
          ).toEqual(["continuation-race-image"]);
          const persisted = createFollowUpQueuePersistence().load(LOCAL_ENVIRONMENT_ID);
          expect(persisted.ok).toBe(true);
          if (persisted.ok) expect(persisted.value.claimed).toHaveLength(0);
        } finally {
          await cleanup();
        }
      },
    );
    it.each(["plan follow-up", "native review"] as const)(
      "refuses unsupported inherited account policy in direct %s actions before dispatch or consuming work",
      async (action) => {
        const original = createSnapshotWithPlanFollowUpPrompt();
        const base = {
          ...original,
          threads: original.threads.map((thread) => ({
            ...thread,
            session: thread.session ? { ...thread.session, providerInstanceId: account } : null,
          })),
        };
        const mounted = await mountChatView({
          viewport: WIDE_FOOTER_VIEWPORT,
          snapshot: base,
          configureFixture: (next) => {
            configureLiveDefaults(next);
            next.serverConfig = {
              ...next.serverConfig,
              providers: next.serverConfig.providers.map((provider) => ({
                ...provider,
                runtimeCapabilities: {
                  liveSteer: "unsupported",
                  threadGoals: "unsupported",
                  ...provider.runtimeCapabilities,
                  subagentConcurrency: false,
                },
              })),
            };
          },
        });
        try {
          await waitForServerConfigToApply();
          const originalPlan = selectThreadByRef(useStore.getState(), THREAD_REF)?.proposedPlans;
          if (action === "plan follow-up") {
            (await waitForButtonByText("Implement")).click();
          } else {
            const prompt = "Keep this unsent review draft";
            useComposerDraftStore.getState().setPrompt(THREAD_REF, prompt);
            await page.getByRole("button", { name: "Code review", exact: true }).click();
            await page.getByRole("button", { name: "Start review", exact: true }).click();
            await expect
              .element(page.getByRole("dialog", { name: "Start a Codex review" }))
              .toBeVisible();
            expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(
              prompt,
            );
          }
          await vi.waitFor(() =>
            expect(document.body.textContent).toContain(
              "This provider runtime does not support the account subagent limit.",
            ),
          );
          expect(
            wsRequests.some(
              (body) =>
                body.type === "thread.turn.start" ||
                body.type === "thread.create" ||
                body.type === "thread.meta.update",
            ),
          ).toBe(false);
          expect(selectThreadByRef(useStore.getState(), THREAD_REF)?.proposedPlans).toEqual(
            originalPlan,
          );
        } finally {
          await mounted.cleanup();
        }
      },
    );
    it.each(["ordinary send", "plan follow-up", "plan new chat"] as const)(
      "rechecks live account policy after deferred preparation for %s and preserves unsent work",
      async (action) => {
        const original =
          action === "ordinary send"
            ? policySnapshot(undefined, 12)
            : createSnapshotWithPlanFollowUpPrompt();
        const base = {
          ...original,
          threads: original.threads.map((thread) => ({
            ...thread,
            subagentLimits: {},
            session: thread.session
              ? { ...thread.session, providerInstanceId: account, maxConcurrentSubagents: 12 }
              : null,
          })),
        };
        const blockedType =
          action === "ordinary send"
            ? "thread.runtime-mode.set"
            : action === "plan follow-up"
              ? "thread.interaction-mode.set"
              : "thread.create";
        let release!: (value: { sequence: number }) => void;
        const pending = new Promise<{ sequence: number }>((resolve) => {
          release = resolve;
        });
        const mounted = await mountChatView({
          viewport: WIDE_FOOTER_VIEWPORT,
          snapshot: base,
          configureFixture: configureLiveDefaults,
          resolveRpc: (body) =>
            body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand
              ? body.type === blockedType
                ? pending
                : { sequence: 2 }
              : undefined,
        });
        const prompt = "Keep this exact unsent policy-race draft";
        try {
          await waitForServerConfigToApply();
          const originalPlan = selectThreadByRef(useStore.getState(), THREAD_REF)?.proposedPlans;
          if (action === "ordinary send") {
            useComposerDraftStore
              .getState()
              .setRuntimeMode(
                THREAD_REF,
                base.threads[0]!.runtimeMode === "approval-required"
                  ? "full-access"
                  : "approval-required",
              );
            useComposerDraftStore.getState().setPrompt(THREAD_REF, prompt);
            await vi.waitFor(() =>
              expect(document.querySelector('[contenteditable="true"]')?.textContent).toContain(
                prompt,
              ),
            );
            (await waitForSendButton()).click();
          } else if (action === "plan follow-up") {
            (await waitForButtonByText("Implement")).click();
          } else {
            await page.getByRole("button", { name: "Implementation actions", exact: true }).click();
            await page
              .getByRole("menuitem", { name: "Implement in a new chat", exact: true })
              .click();
          }
          await vi.waitFor(() =>
            expect(wsRequests.some((body) => body.type === blockedType)).toBe(true),
          );
          expect(wsRequests.some((body) => body.type === "thread.turn.start")).toBe(false);
          await revokeLiveAccountCapability();
          release({ sequence: 2 });
          await vi.waitFor(() =>
            expect(document.body.textContent).toContain(
              "This provider runtime does not support the account subagent limit.",
            ),
          );
          expect(wsRequests.some((body) => body.type === "thread.turn.start")).toBe(false);
          expect(selectThreadByRef(useStore.getState(), THREAD_REF)?.proposedPlans).toEqual(
            originalPlan,
          );
          if (action === "ordinary send") {
            expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(
              prompt,
            );
            await vi.waitFor(() =>
              expect(document.querySelector('[contenteditable="true"]')?.textContent).toContain(
                prompt,
              ),
            );
          } else if (action === "plan follow-up") {
            await expect
              .element(page.getByRole("button", { name: "Implement", exact: true }))
              .toBeEnabled();
          } else {
            await vi.waitFor(() =>
              expect(wsRequests.some((body) => body.type === "thread.delete")).toBe(true),
            );
            expect(mounted.router.state.location.pathname).toBe(serverThreadPath(THREAD_ID));
          }
        } finally {
          release({ sequence: 2 });
          await mounted.cleanup();
        }
      },
    );
    it("leaves a deferred queued send definitely unclaimed when the live account policy becomes unsupported", async () => {
      const queue = createFollowUpQueuePersistence();
      const base = policySnapshot(undefined, 12);
      const queuedRuntime =
        base.threads[0]!.runtimeMode === "approval-required" ? "full-access" : "approval-required";
      expect(
        (
          await queue.save(LOCAL_ENVIRONMENT_ID, [
            {
              id: "live-policy-queued",
              environmentId: LOCAL_ENVIRONMENT_ID,
              threadId: THREAD_ID,
              promptText: "Preserve this exact queued input",
              images: [],
              files: [],
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5",
              promptEffort: null,
              modelSelection: createModelSelection(account, "gpt-5"),
              runtimeMode: queuedRuntime,
              interactionMode: "default",
              queuedAt: isoAt(1000),
              blockedReason: null,
            },
          ])
        ).ok,
      ).toBe(true);
      let release!: (value: { sequence: number }) => void;
      const pending = new Promise<{ sequence: number }>((resolve) => {
        release = resolve;
      });
      const mounted = await mountChatView({
        viewport: WIDE_FOOTER_VIEWPORT,
        snapshot: base,
        configureFixture: configureLiveDefaults,
        resolveRpc: (body) =>
          body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand
            ? body.type === "thread.runtime-mode.set"
              ? pending
              : { sequence: 2 }
            : undefined,
      });
      try {
        await vi.waitFor(() =>
          expect(wsRequests.some((body) => body.type === "thread.runtime-mode.set")).toBe(true),
        );
        await revokeLiveAccountCapability();
        release({ sequence: 2 });
        await vi.waitFor(() =>
          expect(document.body.textContent).toContain(
            "This provider runtime does not support the account subagent limit.",
          ),
        );
        expect(wsRequests.some((body) => body.type === "thread.turn.start")).toBe(false);
        const persisted = queue.load(LOCAL_ENVIRONMENT_ID);
        expect(persisted.ok).toBe(true);
        if (persisted.ok) {
          expect(persisted.value.claimed).toHaveLength(0);
          expect(persisted.value.pending).toHaveLength(1);
          // Durable storage intentionally records only a blocked bit, not
          // arbitrary error text; hydration uses this exact review label.
          expect(persisted.value.pending[0]).toMatchObject({
            promptText: "Preserve this exact queued input",
            blockedReason: "Review this queued follow-up before sending.",
          });
        }
      } finally {
        release({ sequence: 2 });
        await mounted.cleanup();
      }
    });
    it("rechecks the actual steer session's account after deferred image preparation without claiming or consuming input", async () => {
      const original = createSnapshotForTargetUser({
        targetMessageId: MessageId.make("live-steer-policy"),
        targetText: "Active steer policy fixture",
        history: "essential",
        sessionStatus: "running",
      });
      const activeTurnId = "live-steer-policy-active-turn" as TurnId;
      const base = {
        ...original,
        threads: original.threads.map((thread) => ({
          ...thread,
          subagentLimits: {},
          latestTurn: {
            turnId: activeTurnId,
            state: "running" as const,
            requestedAt: isoAt(1000),
            startedAt: isoAt(1001),
            completedAt: null,
            assistantMessageId: null,
          },
          session: thread.session
            ? {
                ...thread.session,
                providerInstanceId: account,
                maxConcurrentSubagents: 12,
                activeTurnId,
              }
            : null,
        })),
      };
      const mounted = await mountChatView({
        viewport: WIDE_FOOTER_VIEWPORT,
        snapshot: base,
        configureFixture: (next) => {
          configureLiveDefaults(next);
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
              runtimeCapabilities: {
                threadGoals: "unsupported",
                ...provider.runtimeCapabilities,
                liveSteer: "supported",
              },
            })),
          };
        },
      });
      const originalRead = FileReader.prototype.readAsDataURL;
      const prepared: { reader: FileReader; blob: Blob }[] = [];
      let restoreReadSpy: (() => void) | undefined;
      const releaseReaders = () => {
        for (const { reader, blob } of prepared.splice(0)) originalRead.call(reader, blob);
      };
      const prompt = "Keep this exact unsent steer input";
      try {
        await waitForServerConfigToApply();
        useComposerDraftStore.getState().setPrompt(THREAD_REF, prompt);
        useComposerDraftStore.getState().addImages(THREAD_REF, [
          {
            id: "live-steer-image",
            type: "image",
            name: "draft.png",
            mimeType: "image/png",
            sizeBytes: 1,
            previewUrl: "data:image/png;base64,eA==",
            file: new File(["x"], "draft.png", { type: "image/png" }),
          },
        ]);
        // Let the independent composer image-persistence effect finish its
        // own read first. The only deferred read below is turn preparation,
        // not an arbitrary earlier image/storage operation.
        await vi.waitFor(() =>
          expect(
            useComposerDraftStore
              .getState()
              .getComposerDraft(THREAD_REF)
              ?.persistedAttachments.map((image) => image.id),
          ).toEqual(["live-steer-image"]),
        );
        const readSpy = vi
          .spyOn(FileReader.prototype, "readAsDataURL")
          .mockImplementation(function (this: FileReader, blob: Blob) {
            prepared.push({ reader: this, blob });
          });
        restoreReadSpy = () => readSpy.mockRestore();
        await vi.waitFor(() =>
          expect(document.querySelector('[contenteditable="true"]')?.textContent).toContain(prompt),
        );
        // Direct steering is the dedicated keyboard action; the visible
        // primary running-turn button intentionally queues instead.
        (await waitForComposerEditor()).focus();
        await userEvent.keyboard("{Control>}{Enter}{/Control}");
        await vi.waitFor(() => expect(prepared).toHaveLength(1));
        await revokeLiveAccountCapability();
        releaseReaders();
        await vi.waitFor(() =>
          expect(document.body.textContent).toContain(
            "This provider runtime does not support the account subagent limit.",
          ),
        );
        expect(
          wsRequests.some(
            (body) => body.type === "thread.turn.steer" || body.type === "thread.turn.start",
          ),
        ).toBe(false);
        expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(prompt);
        expect(
          useComposerDraftStore
            .getState()
            .getComposerDraft(THREAD_REF)
            ?.images.map((image) => image.id),
        ).toEqual(["live-steer-image"]);
        const persisted = createFollowUpQueuePersistence().load(LOCAL_ENVIRONMENT_ID);
        expect(persisted.ok).toBe(true);
        if (persisted.ok) expect(persisted.value.claimed).toHaveLength(0);
      } finally {
        restoreReadSpy?.();
        releaseReaders();
        await mounted.cleanup();
      }
    });
    it("does not borrow an unsent supported account's capability when the active steer owner is unrecorded", async () => {
      const original = createSnapshotForTargetUser({
        targetMessageId: MessageId.make("legacy-steer-owner"),
        targetText: "Legacy session owner fixture",
        history: "essential",
        sessionStatus: "running",
      });
      const activeTurnId = "legacy-steer-owner-active-turn" as TurnId;
      // Deliberately retain the older snapshot shape without instance ID.
      // The canonical chat account and newly selected peer both advertise
      // support, but neither proves which process receives native steer.
      const base = {
        ...original,
        threads: original.threads.map((thread) => ({
          ...thread,
          subagentLimits: {},
          latestTurn: {
            turnId: activeTurnId,
            state: "running" as const,
            requestedAt: isoAt(1000),
            startedAt: isoAt(1001),
            completedAt: null,
            assistantMessageId: null,
          },
          session: thread.session
            ? { ...thread.session, maxConcurrentSubagents: 12, activeTurnId }
            : null,
        })),
      };
      const mounted = await mountChatView({
        viewport: WIDE_FOOTER_VIEWPORT,
        snapshot: base,
        configureFixture: (next) => {
          configureLiveDefaults(next);
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
              runtimeCapabilities: {
                threadGoals: "unsupported",
                ...provider.runtimeCapabilities,
                liveSteer: "supported",
              },
            })),
          };
        },
      });
      const prompt = "Preserve my unsent owner-bound steer";
      try {
        await waitForServerConfigToApply();
        useComposerDraftStore
          .getState()
          .setModelSelection(THREAD_REF, createModelSelection(peer, "gpt-5"));
        useComposerDraftStore.getState().setPrompt(THREAD_REF, prompt);
        await vi.waitFor(() =>
          expect(
            useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.activeProvider,
          ).toBe(peer),
        );
        await vi.waitFor(() =>
          expect(document.querySelector('[contenteditable="true"]')?.textContent).toContain(prompt),
        );
        (await waitForComposerEditor()).focus();
        await userEvent.keyboard("{Control>}{Enter}{/Control}");
        await vi.waitFor(() =>
          expect(document.body.textContent).toContain(
            "The active session’s account is not recorded.",
          ),
        );
        expect(
          wsRequests.some(
            (body) => body.type === "thread.turn.steer" || body.type === "thread.turn.start",
          ),
        ).toBe(false);
        expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(prompt);
        const persisted = createFollowUpQueuePersistence().load(LOCAL_ENVIRONMENT_ID);
        expect(persisted.ok).toBe(true);
        if (persisted.ok) expect(persisted.value.claimed).toHaveLength(0);
      } finally {
        await mounted.cleanup();
      }
    });
    it("updates an existing inherited chat and shows live current-to-requested account transitions without dispatch", async () => {
      const mounted = await mountChatView({
        viewport: WIDE_FOOTER_VIEWPORT,
        snapshot: policySnapshot(undefined, 12),
        configureFixture: configureLiveDefaults,
      });
      try {
        await waitForServerConfigToApply();
        useUiStateStore.getState().setSessionRailDocked(true);
        await vi.waitFor(() =>
          expect(findSessionRail()?.textContent).toContain("Subagent limit: 12"),
        );
        updateAccountDefault(24);
        await vi.waitFor(() =>
          expect(findSessionRail()?.textContent).toContain("Subagent limit: 12 → 24 when idle"),
        );
        expect(selectThreadByRef(useStore.getState(), THREAD_REF)?.subagentLimits).toEqual({});
        expect(
          wsRequests.some(
            (body) =>
              body.type === "thread.turn.start" ||
              body.type === "thread.meta.update" ||
              body.type === "thread.session.stop",
          ),
        ).toBe(false);
        publishPolicy({}, 24);
        await vi.waitFor(() => {
          expect(findSessionRail()?.textContent).toContain("Subagent limit: 24");
          expect(findSessionRail()?.textContent).not.toContain("→");
        });
        updateAccountDefault(undefined);
        await vi.waitFor(() =>
          expect(findSessionRail()?.textContent).toContain(
            "Subagent limit: 24 → Provider default when idle",
          ),
        );
        publishPolicy({}, null);
        await vi.waitFor(() =>
          expect(findSessionRail()?.textContent).not.toContain("Subagent limit:"),
        );
        expect(
          wsRequests.some(
            (body) =>
              body.type === "thread.turn.start" ||
              body.type === "thread.meta.update" ||
              body.type === "thread.session.stop",
          ),
        ).toBe(false);
      } finally {
        await mounted.cleanup();
      }
    });
    it.for(["no draft account", "disabled draft account", "missing draft account"] as const)(
      "uses the retained session account consistently in the rail, editor and send when durable selection differs (%s)",
      async (selection, { signal, onTestFinished, onTestFailed }) => {
        type Phase =
          | "mount"
          | "viewport"
          | "styles"
          | "render"
          | "websocket"
          | "bootstrap"
          | "layout"
          | "config"
          | "draft"
          | "rail"
          | "more"
          | "editor"
          | "dialog"
          | "close"
          | "closed"
          | "prompt"
          | "send-target"
          | "send"
          | "command"
          | "retired"
          | "unmount";
        const started = performance.now();
        const phases: {
          phase: Phase;
          state: "entered" | "settled";
          count: number;
          elapsedMs: number;
        }[] = [];
        const pendingOperations = new Set<Promise<unknown>>();
        let mounting: ReturnType<typeof mountChatView> | undefined;
        let mountCleanup: (() => Promise<void>) | undefined;
        let cleanupPromise: Promise<void> | undefined;
        let retired = false;
        let nativeStarts = 0;
        const mark = (phase: Phase, state: "entered" | "settled") => {
          try {
            if (retired) return;
            if (phases.length === 16) phases.shift();
            const elapsed = performance.now() - started;
            phases.push({
              phase,
              state,
              count: Math.min(3, nativeStarts),
              elapsedMs: Number.isFinite(elapsed)
                ? Math.max(0, Math.min(60_000, Math.floor(elapsed)))
                : 0,
            });
          } catch {
            /* Passive fixed diagnostics cannot replace the original failure. */
          }
        };
        const assertActive = () => {
          if (retired || signal.aborted)
            throw new Error("The exact retained-account fixture was retired.");
        };
        const retire = () => {
          if (retired) return;
          mark("retired", "entered");
          retired = true;
          signal.removeEventListener("abort", retire);
        };
        const cleanup = (): Promise<void> => {
          retire();
          // Publish one completion before cleanup begins. The body and this
          // finalizer are never pending operations, so neither can self-join.
          return (cleanupPromise ??= Promise.resolve().then(async () => {
            try {
              try {
                await mounting;
              } catch {
                // Only this duplicate join observes failure: the original
                // mount await still rejects the test with its exact error.
              }
              await Promise.allSettled([...pendingOperations]);
            } finally {
              // The existing scoped mount owns late render acquisition and
              // clears only its exact resolver/host after admitted input joins.
              await mountCleanup?.();
            }
          }));
        };
        const owned = async <T,>(
          phase: Phase,
          operation: () => PromiseLike<T>,
          native = false,
        ): Promise<T> => {
          assertActive();
          if (native) nativeStarts += 1;
          mark(phase, "entered");
          const original = Promise.resolve(operation());
          pendingOperations.add(original);
          try {
            const result = await original;
            assertActive();
            mark(phase, "settled");
            return result;
          } finally {
            pendingOperations.delete(original);
          }
        };
        // Own retirement before mount can mutate shared fixture state or yield.
        // No extra input, readiness poll or allowance is introduced here.
        onTestFinished(cleanup);
        onTestFailed(() => {
          try {
            console.error("retained-account-fixture-diagnostic", { phases });
          } catch {
            /* Diagnostic delivery must preserve the original failure. */
          }
        });
        signal.addEventListener("abort", retire, { once: true });
        if (signal.aborted) retire();
        let bodyFailed = false;
        try {
          assertActive();
          const original = policySnapshot(undefined, 12);
          const base = {
            ...original,
            threads: original.threads.map((thread) => ({
              ...thread,
              modelSelection: createModelSelection(peer, "gpt-5"),
            })),
          };
          await owned(
            "mount",
            () =>
              (mounting = mountChatView({
                viewport: WIDE_FOOTER_VIEWPORT,
                snapshot: base,
                configureFixture: (next) => {
                  configureLiveDefaults(next);
                  if (selection === "disabled draft account")
                    next.serverConfig = {
                      ...next.serverConfig,
                      providers: next.serverConfig.providers.map((provider) =>
                        provider.instanceId === peer ? { ...provider, enabled: false } : provider,
                      ),
                    };
                },
                resolveRpc: (body) =>
                  body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand
                    ? { sequence: 2 }
                    : undefined,
                lifecycle: {
                  assertActive,
                  retire: cleanup,
                  ownCleanup: (cleanupMount) => {
                    mountCleanup = cleanupMount;
                  },
                  observePhase: (phase) => {
                    assertActive();
                    mark(phase, "entered");
                  },
                },
              })),
          );
          await owned("config", () => waitForServerConfigToApply());
          if (selection === "no draft account") {
            expect(
              useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.activeProvider,
            ).toBeUndefined();
          } else {
            const stale =
              selection === "disabled draft account"
                ? peer
                : ProviderInstanceId.make("missing-draft-account");
            useComposerDraftStore
              .getState()
              .setModelSelection(THREAD_REF, createModelSelection(stale, "gpt-5"));
            await owned("draft", () =>
              vi.waitFor(() =>
                expect(
                  useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.activeProvider,
                ).toBe(stale),
              ),
            );
          }
          useUiStateStore.getState().setSessionRailDocked(true);
          await owned("rail", () =>
            vi.waitFor(() => {
              expect(findSessionRail()?.textContent).toContain("Subagent limit: 12");
              expect(findSessionRail()?.textContent).not.toContain("64");
              expect(findSessionRail()?.textContent).not.toContain("→");
            }),
          );
          await owned(
            "more",
            () => page.getByRole("button", { name: "More composer controls", exact: true }).click(),
            true,
          );
          await owned(
            "editor",
            () => page.getByRole("menuitem", { name: "Subagent limit…", exact: true }).click(),
            true,
          );
          const dialog = page.getByRole("dialog", { name: "Subagent limit", exact: true });
          await owned("dialog", () => expect.element(dialog).toBeVisible());
          expect(dialog.element().textContent).toContain("Subagent limit: 12");
          expect(dialog.element().textContent).not.toContain("Subagent limit: 64");
          await owned(
            "close",
            () => page.getByRole("button", { name: "Close", exact: true }).click(),
            true,
          );
          await owned("closed", () => expect.element(dialog).not.toBeInTheDocument());
          const prompt = "Send with the exact retained session account";
          useComposerDraftStore.getState().setPrompt(THREAD_REF, prompt);
          await owned("prompt", () =>
            vi.waitFor(() =>
              expect(document.querySelector('[contenteditable="true"]')?.textContent).toContain(
                prompt,
              ),
            ),
          );
          const sendButton = await owned("send-target", () => waitForSendButton());
          assertActive();
          mark("send", "entered");
          // Preserve the original synchronous DOM send; do not replay it or
          // substitute another native command to manufacture a dispatch receipt.
          sendButton.click();
          mark("send", "settled");
          await owned("command", () =>
            vi.waitFor(() =>
              expect(wsRequests.find((body) => body.type === "thread.turn.start")).toMatchObject({
                threadId: THREAD_ID,
                modelSelection: { instanceId: account },
                message: { text: prompt },
              }),
            ),
          );
          const start = wsRequests.find((body) => body.type === "thread.turn.start");
          expect(start?.subagentLimits).not.toMatchObject({ codex: 12 });
          expect(start?.subagentLimits).not.toMatchObject({ codex: 64 });
        } catch (failure) {
          bodyFailed = true;
          throw failure;
        } finally {
          try {
            await cleanup();
          } catch (failure) {
            if (!bodyFailed) throw failure;
          }
        }
      },
    );
    it("preserves explicit overrides, resets to the live account default and isolates another selected account's session evidence", async () => {
      const mounted = await mountChatView({
        viewport: WIDE_FOOTER_VIEWPORT,
        snapshot: policySnapshot(5, 5),
        configureFixture: configureLiveDefaults,
        resolveRpc: (body) =>
          body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand ? { sequence: 2 } : undefined,
      });
      try {
        await waitForServerConfigToApply();
        useUiStateStore.getState().setSessionRailDocked(true);
        await vi.waitFor(() =>
          expect(findSessionRail()?.textContent).toContain("Subagent limit: 5"),
        );
        updateAccountDefault(24);
        await vi.waitFor(() => {
          expect(findSessionRail()?.textContent).toContain("Subagent limit: 5");
          expect(findSessionRail()?.textContent).not.toContain("→");
        });
        await page.getByRole("button", { name: "More composer controls", exact: true }).click();
        await page.getByRole("menuitem", { name: "Subagent limit…", exact: true }).click();
        await page.getByRole("button", { name: "Reset", exact: true }).click();
        await vi.waitFor(() =>
          expect(wsRequests.find((body) => body.type === "thread.meta.update")).toMatchObject({
            threadId: THREAD_ID,
            subagentLimits: {},
          }),
        );
        await vi.waitFor(() =>
          expect(findSessionRail()?.textContent).toContain("Subagent limit: 5 → 24 when idle"),
        );
        publishPolicy({}, 5);
        await vi.waitFor(() =>
          expect(selectThreadByRef(useStore.getState(), THREAD_REF)?.subagentLimits).toEqual({}),
        );
        useComposerDraftStore
          .getState()
          .setModelSelection(THREAD_REF, createModelSelection(peer, "gpt-5"));
        await vi.waitFor(() => {
          expect(findSessionRail()?.textContent).toContain("Subagent limit: 64 · saved");
          expect(findSessionRail()?.textContent).not.toContain("5 → 64");
        });
        expect(
          wsRequests.some(
            (body) => body.type === "thread.turn.start" || body.type === "thread.session.stop",
          ),
        ).toBe(false);
      } finally {
        await mounted.cleanup();
      }
    });
  });

  describe("Codex context-window ownership", () => {
    const account = ProviderInstanceId.make("codex");
    const peer = ProviderInstanceId.make("codex-context-peer");
    function contextSnapshot(
      requested: number | null = 500_000,
      configured: number | null = 500_000,
    ) {
      const base = createSnapshotForTargetUser({
        targetMessageId: MessageId.make("context-ownership"),
        targetText: "Synthetic context history",
        history: "essential",
      });
      return {
        ...base,
        threads: base.threads.map((thread) => ({
          ...thread,
          codexContextWindowOverride: requested,
          session: thread.session
            ? {
                ...thread.session,
                providerInstanceId: account,
                codexContextWindowOverride: configured,
                // This existing synthetic snapshot represents a successful
                // paired opening; a separate regression below removes proof.
                codexAutoCompactTokenLimit: configured,
              }
            : null,
        })),
      };
    }
    function configureContext(next: TestFixture) {
      const baseProvider = next.serverConfig.providers.find(
        (provider) => provider.instanceId === account,
      )!;
      next.serverConfig = {
        ...next.serverConfig,
        providers: [
          ...next.serverConfig.providers,
          { ...baseProvider, instanceId: peer, displayName: "Context peer" },
        ].map((provider) => ({
          ...provider,
          runtimeCapabilities: {
            liveSteer: "unsupported",
            threadGoals: "unsupported",
            ...provider.runtimeCapabilities,
            codexContextWindow: true,
            codexContextCompaction: true,
          },
          models: [
            {
              slug: "gpt-5",
              name: "Fixture GPT5",
              isCustom: false,
              capabilities: createModelCapabilities({ optionDescriptors: [] }),
            },
            {
              slug: "gpt-5.6-sol",
              name: "Fixture Sol",
              isCustom: false,
              capabilities: createModelCapabilities({ optionDescriptors: [] }),
            },
          ],
        })),
        settings: {
          ...next.serverConfig.settings,
          providerInstances: {
            ...next.serverConfig.settings.providerInstances,
            [account]: {
              driver: ProviderDriverKind.make("codex"),
              defaultModel: "gpt-5",
              defaultCodexContextWindowOverride: 600_000,
            },
            [peer]: {
              driver: ProviderDriverKind.make("codex"),
              defaultModel: "gpt-5",
              defaultCodexContextWindowOverride: 900_000,
            },
          },
        },
      };
    }
    function publishContext(
      requested: number | null,
      configured: number | null = 500_000,
      sequence = chatViewFixture.fixture.snapshot.snapshotSequence + 1,
    ) {
      const thread = {
        ...chatViewFixture.fixture.snapshot.threads[0]!,
        codexContextWindowOverride: requested,
        session: chatViewFixture.fixture.snapshot.threads[0]!.session
          ? {
              ...chatViewFixture.fixture.snapshot.threads[0]!.session!,
              codexContextWindowOverride: configured,
              codexAutoCompactTokenLimit: configured,
            }
          : null,
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
    }
    async function openContextEditor() {
      await page.getByRole("button", { name: "More composer controls", exact: true }).click();
      await page.getByRole("menuitem", { name: "Context window…", exact: true }).click();
      await expect
        .element(page.getByRole("dialog", { name: "Context window", exact: true }))
        .toBeVisible();
    }
    const contextInput = () =>
      page.getByRole("spinbutton", { name: "Context window (tokens)", exact: true });
    function updateContextDefault(value: number | undefined) {
      const { defaultCodexContextWindowOverride: _previous, ...instance } =
        chatViewFixture.fixture.serverConfig.settings.providerInstances[account]!;
      chatViewFixture.fixture.serverConfig = {
        ...chatViewFixture.fixture.serverConfig,
        settings: {
          ...chatViewFixture.fixture.serverConfig.settings,
          providerInstances: {
            ...chatViewFixture.fixture.serverConfig.settings.providerInstances,
            [account]: {
              ...instance,
              ...(value === undefined ? {} : { defaultCodexContextWindowOverride: value }),
            },
          },
        },
      };
      applySettingsUpdated(chatViewFixture.fixture.serverConfig.settings);
    }

    it.each([true, false])(
      "keeps same800K legacy companion proof pending with paired runtime support=%s without launching providers",
      async (paired) => {
        const snapshot = contextSnapshot(800_000, 800_000);
        const mounted = await mountChatView({
          viewport: WIDE_FOOTER_VIEWPORT,
          snapshot: {
            ...snapshot,
            threads: snapshot.threads.map((thread) => {
              if (!thread.session) return thread;
              const { codexAutoCompactTokenLimit: _oldProof, ...session } = thread.session;
              return { ...thread, session };
            }),
          },
          configureFixture: (next) => {
            configureContext(next);
            next.serverConfig = {
              ...next.serverConfig,
              providers: next.serverConfig.providers.map((provider) => ({
                ...provider,
                runtimeCapabilities: {
                  ...provider.runtimeCapabilities!,
                  // Omission simulates the authenticated older context-only
                  // owner rather than a synthesized negative numeric policy.
                  codexContextCompaction: paired ? true : undefined,
                },
              })),
            };
          },
        });
        try {
          await waitForServerConfigToApply();
          useUiStateStore.getState().setSessionRailDocked(true);
          await vi.waitFor(() =>
            expect(findSessionRail()?.textContent).toContain(
              paired
                ? "Context override: 800K · compaction when idle"
                : "Context override: 800K · saved",
            ),
          );
          expect(findSessionRail()?.textContent).toContain("(~720K compaction)");
          expect(
            selectThreadByRef(useStore.getState(), THREAD_REF)?.session?.codexAutoCompactTokenLimit,
          ).toBeUndefined();
          await openContextEditor();
          const save = page.getByRole("button", { name: "Save", exact: true });
          if (paired) {
            await contextInput().fill("900000");
            await expect.element(save).toBeEnabled();
          } else {
            await expect.element(contextInput()).toBeDisabled();
            await expect.element(contextInput()).toHaveValue(800_000);
            await expect.element(save).toBeDisabled();
          }
          expect(
            wsRequests.some(
              (body) =>
                body.type === "thread.meta.update" ||
                body.type === "thread.session.stop" ||
                body.type === "thread.turn.start",
            ),
          ).toBe(false);
        } finally {
          await mounted.cleanup();
        }
      },
    );

    it("reflects live exact-account defaults, chat precedence, pending Reset and clear in Tasks without provider calls", async () => {
      const mounted = await mountChatView({
        viewport: WIDE_FOOTER_VIEWPORT,
        snapshot: contextSnapshot(),
        configureFixture: configureContext,
      });
      try {
        await waitForServerConfigToApply();
        useUiStateStore.getState().setSessionRailDocked(true);
        await vi.waitFor(() =>
          expect(findSessionRail()?.textContent).toContain("Context override: 500K"),
        );
        updateContextDefault(700_000);
        await waitForLayout();
        expect(findSessionRail()?.textContent).not.toContain("700K");
        publishContext(null);
        await vi.waitFor(() =>
          expect(findSessionRail()?.textContent).toContain(
            "Context override: 500K → 700K when idle",
          ),
        );
        await openContextEditor();
        await expect.element(contextInput()).toHaveValue(null);
        await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
        publishContext(null, 700_000);
        await vi.waitFor(() =>
          expect(findSessionRail()?.textContent).toContain("Context override: 700K"),
        );
        updateContextDefault(undefined);
        await vi.waitFor(() =>
          expect(findSessionRail()?.textContent).toContain(
            "Context override: 700K → Codex default when idle",
          ),
        );
        publishContext(null, null);
        await vi.waitFor(() =>
          expect(
            findSessionRail()?.querySelector("[data-codex-context-window-details]"),
          ).toBeNull(),
        );
        expect(
          useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.codexContextWindowOverride,
        ).toBeUndefined();
        expect(
          wsRequests.some(
            (body) =>
              body.type === "thread.turn.start" ||
              body.type === "thread.meta.update" ||
              body.type === "thread.session.stop",
          ),
        ).toBe(false);
      } finally {
        await mounted.cleanup();
      }
    });

    it("binds metadata ACK to this context field, never another chat or omission, and leaves next sends canonical", async () => {
      const mounted = await mountChatView({
        viewport: WIDE_FOOTER_VIEWPORT,
        snapshot: contextSnapshot(),
        configureFixture: configureContext,
        resolveRpc: (body) =>
          body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand ? { sequence: 3 } : undefined,
      });
      try {
        await waitForServerConfigToApply();
        useUiStateStore.getState().setSessionRailDocked(true);
        await page.getByRole("button", { name: "More composer controls", exact: true }).click();
        // A completed native click is not the queued popup's render receipt.
        // Observe this exact menu and its expected entries before the
        // synchronous ordering read; never replay input to obtain readiness.
        const controls = page.getByRole("menu");
        await expect.element(controls).toBeVisible();
        await expect
          .element(controls.getByRole("menuitem", { name: "Subagent limit…", exact: true }))
          .toBeVisible();
        await expect
          .element(controls.getByRole("menuitem", { name: "Context window…", exact: true }))
          .toBeVisible();
        await expect.element(controls.getByText("Mode", { exact: true })).toBeVisible();
        const labels = page.getByRole("menu").element().textContent!;
        expect(labels.indexOf("Subagent limit…")).toBeLessThan(labels.indexOf("Context window…"));
        expect(labels.indexOf("Context window…")).toBeLessThan(labels.indexOf("Mode"));
        await page.getByRole("menuitem", { name: "Context window…", exact: true }).click();
        await contextInput().fill("1000000");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await vi.waitFor(() =>
          expect(
            useComposerDraftStore.getState().getComposerDraft(THREAD_REF)
              ?.codexContextWindowOverride,
          ).toBe(1_000_000),
        );
        const saved = wsRequests.find((body) => body.type === "thread.meta.update")!;
        expect(saved).toMatchObject({
          threadId: THREAD_ID,
          codexContextWindowOverride: 1_000_000,
        });
        expect(saved).not.toHaveProperty("subagentLimits");
        rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
          kind: "event",
          event: {
            type: "thread.meta-updated",
            sequence: 4,
            eventId: EventId.make("context-omission"),
            aggregateKind: "thread",
            aggregateId: THREAD_ID,
            occurredAt: NOW_ISO,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            payload: {
              threadId: THREAD_ID,
              title: "Context omission title",
              updatedAt: NOW_ISO,
              subagentLimits: { codex: 5 },
            },
          },
        });
        const unrelated = addThreadToSnapshot(
          chatViewFixture.fixture.snapshot,
          ThreadId.make("other-context-chat"),
        ).threads[1]!;
        rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeShell, {
          kind: "thread-upserted",
          sequence: 5,
          thread: { ...toShellThread(unrelated), codexContextWindowOverride: 800_000 },
        });
        await vi.waitFor(() =>
          expect(selectThreadByRef(useStore.getState(), THREAD_REF)?.title).toBe(
            "Context omission title",
          ),
        );
        expect(
          useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.codexContextWindowOverride,
        ).toBe(1_000_000);
        expect(
          useStore.getState().environmentStateById[LOCAL_ENVIRONMENT_ID]
            ?.codexContextPolicySequenceByThreadId?.[THREAD_ID],
        ).toBe(1);
        publishContext(900_000, 500_000, 6);
        await vi.waitFor(() =>
          expect(
            useComposerDraftStore.getState().getComposerDraft(THREAD_REF)
              ?.codexContextWindowOverride,
          ).toBeUndefined(),
        );
        useComposerDraftStore.getState().setPrompt(THREAD_REF, "Use durable context intent");
        (await waitForSendButton()).click();
        await vi.waitFor(() =>
          expect(wsRequests.some((body) => body.type === "thread.turn.start")).toBe(true),
        );
        expect(wsRequests.find((body) => body.type === "thread.turn.start")).not.toHaveProperty(
          "codexContextWindowOverride",
        );
        expect(selectThreadByRef(useStore.getState(), THREAD_REF)?.codexContextWindowOverride).toBe(
          900_000,
        );
        expect(wsRequests.some((body) => body.type === "thread.session.stop")).toBe(false);
      } finally {
        await mounted.cleanup();
      }
    });

    it.for([
      { before: true, reset: false },
      { before: false, reset: true },
    ])(
      "does not resurrect obsolete ACK intent over newer canonical metadata (before=$before reset=$reset)",
      async ({ before, reset }, { signal, onTestFinished }) => {
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
        const requested = reset ? null : 700_000;
        const assertActive = () => {
          if (retired || signal.aborted)
            throw new Error("The exact context ACK fixture was retired.");
        };
        const releaseAck = () => {
          if (ackReleased) return;
          ackReleased = true;
          release({ sequence: 2 });
        };
        const cleanup = () => {
          retired = true;
          signal.removeEventListener("abort", onAbort);
          return (cleanupPromise ??= (async () => {
            // The caller's retirement fences mount/input continuations. Release
            // only this held reply before joining work that may await it, while
            // retaining native targets until their original actions settle.
            releaseAck();
            try {
              try {
                await mounting;
              } catch {
                // The original mount await retains its failure. Cleanup only
                // joins that same owned promise, never substitutes readiness.
              }
              await Promise.allSettled([...pendingOperations]);
            } finally {
              // Scoped disposal clears only this exact mount's RPC resolver.
              await mountCleanup?.();
            }
          })());
        };
        const onAbort = () => {
          void cleanup().catch(() => undefined);
        };
        const owned = async <T,>(operation: () => PromiseLike<T>): Promise<T> => {
          assertActive();
          const operationPromise = Promise.resolve(operation());
          pendingOperations.add(operationPromise);
          try {
            const result = await operationPromise;
            assertActive();
            return result;
          } finally {
            pendingOperations.delete(operationPromise);
          }
        };
        // Keep the original native opening actions, with a retirement fence
        // between them rather than allowing a late helper to open another menu.
        const openOwnedContextEditor = async () => {
          await owned(() =>
            page.getByRole("button", { name: "More composer controls", exact: true }).click(),
          );
          await owned(() =>
            page.getByRole("menuitem", { name: "Context window…", exact: true }).click(),
          );
          await owned(() =>
            expect
              .element(page.getByRole("dialog", { name: "Context window", exact: true }))
              .toBeVisible(),
          );
        };
        onTestFinished(cleanup);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
        try {
          await owned(
            () =>
              (mounting = mountChatView({
                viewport: DEFAULT_VIEWPORT,
                snapshot: contextSnapshot(),
                configureFixture: configureContext,
                lifecycle: {
                  assertActive,
                  retire: cleanup,
                  ownCleanup: (cleanupMount) => {
                    mountCleanup = cleanupMount;
                  },
                  observePhase: assertActive,
                },
                resolveRpc: (body) => {
                  if (body._tag !== ORCHESTRATION_WS_METHODS.dispatchCommand) return undefined;
                  return body.type === "thread.meta.update" &&
                    body.threadId === THREAD_ID &&
                    body.codexContextWindowOverride === requested
                    ? pending
                    : { sequence: 2 };
                },
              })),
          );
          await openOwnedContextEditor();
          const popup = page.getByRole("dialog", { name: "Context window", exact: true }).element();
          expect(popup.isConnected).toBe(true);
          expect(popup.hasAttribute("data-open")).toBe(true);
          if (!reset) await owned(() => contextInput().fill("700000"));
          await owned(() =>
            page.getByRole("button", { name: reset ? "Reset" : "Save", exact: true }).click(),
          );
          await owned(() =>
            vi.waitFor(() =>
              expect(wsRequests.some((body) => body.type === "thread.meta.update")).toBe(true),
            ),
          );
          expect(wsRequests.find((body) => body.type === "thread.meta.update")).toMatchObject({
            threadId: THREAD_ID,
            codexContextWindowOverride: requested,
          });
          if (!before) {
            releaseAck();
            await owned(() =>
              vi.waitFor(() =>
                expect(
                  useComposerDraftStore.getState().getComposerDraft(THREAD_REF)
                    ?.codexContextWindowOverride,
                ).toBe(reset ? null : 700_000),
              ),
            );
          }
          assertActive();
          publishContext(900_000, 500_000, 3);
          await owned(() =>
            vi.waitFor(() =>
              expect(
                selectThreadByRef(useStore.getState(), THREAD_REF)?.codexContextWindowOverride,
              ).toBe(900_000),
            ),
          );
          if (before) releaseAck();
          await owned(() =>
            vi.waitFor(() => {
              // A closed Base UI popup may retain its exit painting. Require
              // semantic closure of this exact originally-open popup instead
              // of a cosmetic physical-unmount schedule; reopening below still
              // proves ordinary native access to the current canonical value.
              if (popup.isConnected) {
                expect(popup.hasAttribute("data-closed")).toBe(true);
                expect(popup.hasAttribute("data-open")).toBe(false);
              }
              expect(
                useComposerDraftStore.getState().getComposerDraft(THREAD_REF)
                  ?.codexContextWindowOverride,
              ).toBeUndefined();
              expect(
                selectThreadByRef(useStore.getState(), THREAD_REF)?.codexContextWindowOverride,
              ).toBe(900_000);
            }),
          );
          await openOwnedContextEditor();
          await owned(() => expect.element(contextInput()).toHaveValue(900_000));
        } finally {
          await cleanup();
        }
      },
    );

    it.each(["account", "model"] as const)(
      "fences a late ACK across %s away-and-back without closing the replacement editor",
      async (transition) => {
        let release!: (value: { sequence: number }) => void;
        const pending = new Promise<{ sequence: number }>((resolve) => {
          release = resolve;
        });
        const mounted = await mountChatView({
          viewport: WIDE_FOOTER_VIEWPORT,
          snapshot: contextSnapshot(),
          configureFixture: configureContext,
          resolveRpc: (body) =>
            body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand ? pending : undefined,
        });
        try {
          await openContextEditor();
          await contextInput().fill("700000");
          await page.getByRole("button", { name: "Save", exact: true }).click();
          await vi.waitFor(() =>
            expect(wsRequests.some((body) => body.type === "thread.meta.update")).toBe(true),
          );
          useComposerDraftStore
            .getState()
            .setModelSelection(
              THREAD_REF,
              createModelSelection(
                transition === "account" ? peer : account,
                transition === "model" ? "gpt-5.6-sol" : "gpt-5",
              ),
            );
          await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
          useUiStateStore.getState().setSessionRailDocked(true);
          await vi.waitFor(() =>
            expect(findSessionRail()?.textContent).toContain(
              transition === "account"
                ? "Context override: 500K · saved"
                : "Context override: 500K",
            ),
          );
          expect(findSessionRail()?.textContent).not.toContain("→");
          useComposerDraftStore
            .getState()
            .setModelSelection(THREAD_REF, createModelSelection(account, "gpt-5"));
          await openContextEditor();
          await contextInput().fill("800000");
          release({ sequence: 2 });
          await waitForLayout();
          await expect
            .element(page.getByRole("dialog", { name: "Context window", exact: true }))
            .toBeVisible();
          await expect.element(contextInput()).toHaveValue(800_000);
          expect(
            useComposerDraftStore.getState().getComposerDraft(THREAD_REF)
              ?.codexContextWindowOverride,
          ).toBeUndefined();
          expect(wsRequests.filter((body) => body.type === "thread.meta.update")).toHaveLength(1);
        } finally {
          release({ sequence: 2 });
          await mounted.cleanup();
        }
      },
    );

    it("captures only a local chat's explicit context choice in first-send bootstrap without seeding account or future drafts", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createProjectlessSnapshot(),
        initialPath: "/",
        configureFixture: (next) => {
          configureContext(next);
          configureStandaloneShortcut(next);
        },
        resolveRpc: (body) =>
          body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand ? { sequence: 2 } : undefined,
      });
      try {
        newChatShortcut();
        await vi.waitFor(() =>
          expect(mounted.router.state.location.pathname).toMatch(UUID_ROUTE_RE),
        );
        const draftId = draftIdFromPath(mounted.router.state.location.pathname);
        expect(
          useComposerDraftStore.getState().getComposerDraft(draftId)?.codexContextWindowOverride,
        ).toBeUndefined();
        await openContextEditor();
        await expect.element(contextInput()).toHaveValue(null);
        await contextInput().fill("1000000");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        expect(wsRequests.some((body) => body.type === "thread.meta.update")).toBe(false);
        expect(
          useComposerDraftStore.getState().getComposerDraft(draftId)?.codexContextWindowOverride,
        ).toBe(1_000_000);
        useComposerDraftStore.getState().setPrompt(draftId, "First context-bound message");
        await waitForStandaloneComposerText("First context-bound message");
        (await waitForSendButton()).click();
        await vi.waitFor(() =>
          expect(wsRequests.find((body) => body.type === "thread.turn.start")).toMatchObject({
            threadId: draftThreadIdFor(draftId),
            codexContextWindowOverride: 1_000_000,
            bootstrap: { createThread: { codexContextWindowOverride: 1_000_000 } },
          }),
        );
        const submittedId = draftThreadIdFor(draftId);
        chatViewFixture.fixture.snapshot = addThreadToSnapshot(
          chatViewFixture.fixture.snapshot,
          submittedId,
        );
        chatViewFixture.fixture.snapshot = {
          ...chatViewFixture.fixture.snapshot,
          threads: chatViewFixture.fixture.snapshot.threads.map((thread) =>
            thread.id === submittedId
              ? {
                  ...thread,
                  projectId: null,
                  branch: null,
                  session: null,
                  codexContextWindowOverride: 1_000_000,
                }
              : thread,
          ),
        };
        // Match the established draft promotion boundary: received started
        // session evidence, not a bare create shell or elapsed time, owns
        // navigation from the editable draft to its canonical server chat.
        await startPromotedServerThreadViaDomainEvent(submittedId);
        await vi.waitFor(() =>
          expect(mounted.router.state.location.pathname).toBe(serverThreadPath(submittedId)),
        );
        expect(
          selectThreadByRef(useStore.getState(), scopeThreadRef(LOCAL_ENVIRONMENT_ID, submittedId))
            ?.codexContextWindowOverride,
        ).toBe(1_000_000);
        newChatShortcut();
        await vi.waitFor(() =>
          expect(draftIdFromPath(mounted.router.state.location.pathname)).not.toBe(draftId),
        );
        const fresh = draftIdFromPath(mounted.router.state.location.pathname);
        expect(
          useComposerDraftStore.getState().getComposerDraft(fresh)?.codexContextWindowOverride,
        ).toBeUndefined();
        expect(
          JSON.stringify(useComposerDraftStore.getState().stickyModelSelectionByProvider),
        ).not.toContain("codexContextWindowOverride");
      } finally {
        await mounted.cleanup();
      }
    });

    it.each([
      { driver: "claudeAgent", model: "claude-opus-4-8", reset: false },
      { driver: "claudeAgent", model: "claude-opus-4-8", reset: true },
      { driver: "grok", model: "grok-4.6", reset: false },
      { driver: "grok", model: "grok-4.6", reset: true },
    ] as const)(
      "preserves latent Codex chat metadata during first $driver bootstrap without a non-Codex turn override (reset=$reset)",
      async ({ driver, model, reset }) => {
        const otherAccount = ProviderInstanceId.make(`context-bootstrap-${driver}`);
        const requested = reset ? null : 1_000_000;
        const mounted = await mountChatView({
          viewport: DEFAULT_VIEWPORT,
          snapshot: createProjectlessSnapshot(),
          initialPath: "/",
          configureFixture: (next) => {
            configureContext(next);
            configureStandaloneShortcut(next);
            next.serverConfig = {
              ...next.serverConfig,
              providers: [
                ...next.serverConfig.providers,
                {
                  driver: ProviderDriverKind.make(driver),
                  instanceId: otherAccount,
                  enabled: true,
                  installed: true,
                  version: "synthetic-context-bootstrap",
                  status: "ready",
                  auth: { status: "authenticated" },
                  checkedAt: NOW_ISO,
                  models: [
                    {
                      slug: model,
                      name: `Synthetic ${driver}`,
                      isCustom: false,
                      capabilities: createModelCapabilities({ optionDescriptors: [] }),
                    },
                  ],
                  slashCommands: [],
                  skills: [],
                },
              ],
              settings: {
                ...next.serverConfig.settings,
                providerInstances: {
                  ...next.serverConfig.settings.providerInstances,
                  [otherAccount]: {
                    driver: ProviderDriverKind.make(driver),
                    defaultModel: model,
                  },
                },
              },
            };
          },
          resolveRpc: (body) =>
            body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand ? { sequence: 2 } : undefined,
        });
        try {
          newChatShortcut();
          await vi.waitFor(() =>
            expect(mounted.router.state.location.pathname).toMatch(UUID_ROUTE_RE),
          );
          const draftId = draftIdFromPath(mounted.router.state.location.pathname);
          expect(
            useComposerDraftStore.getState().getComposerDraft(draftId)?.codexContextWindowOverride,
          ).toBeUndefined();
          await openContextEditor();
          await expect.element(contextInput()).toHaveValue(null);
          if (!reset) await contextInput().fill("1000000");
          await page.getByRole("button", { name: reset ? "Reset" : "Save", exact: true }).click();
          expect(
            useComposerDraftStore.getState().getComposerDraft(draftId)?.codexContextWindowOverride,
          ).toBe(requested);
          useComposerDraftStore
            .getState()
            .setModelSelection(draftId, createModelSelection(otherAccount, model));
          await page.getByRole("button", { name: "More composer controls", exact: true }).click();
          await expect
            .element(page.getByRole("menuitem", { name: "Context window…", exact: true }))
            .not.toBeInTheDocument();
          await userEvent.keyboard("{Escape}");
          expect(
            useComposerDraftStore.getState().getComposerDraft(draftId)?.codexContextWindowOverride,
          ).toBe(requested);
          useComposerDraftStore
            .getState()
            .setPrompt(draftId, "First message after changing the draft provider");
          await waitForStandaloneComposerText("First message after changing the draft provider");
          (await waitForSendButton()).click();
          await vi.waitFor(() =>
            expect(wsRequests.find((body) => body.type === "thread.turn.start")).toMatchObject({
              threadId: draftThreadIdFor(draftId),
              modelSelection: { instanceId: otherAccount, model },
              bootstrap: {
                createThread: {
                  modelSelection: { instanceId: otherAccount, model },
                  codexContextWindowOverride: requested,
                },
              },
            }),
          );
          const sent = wsRequests.find((body) => body.type === "thread.turn.start")!;
          expect(sent).not.toHaveProperty("codexContextWindowOverride");
          expect(sent.modelSelection).not.toHaveProperty("options.codexContextWindowOverride");
          expect(
            JSON.stringify(useComposerDraftStore.getState().stickyModelSelectionByProvider),
          ).not.toContain("codexContextWindowOverride");
          expect(
            wsRequests.some(
              (body) => body.type === "thread.meta.update" || body.type === "thread.session.stop",
            ),
          ).toBe(false);
        } finally {
          await mounted.cleanup();
        }
      },
    );
  });

  it("edits the exact standalone chat policy, preserves the other driver and sends its captured override", async () => {
    const base = createSnapshotForTargetUser({
      targetMessageId: MessageId.make("limit-integration"),
      targetText: "History",
      history: "essential",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...base,
        projects: [],
        threads: base.threads.map((thread) => ({
          ...thread,
          projectId: null,
          branch: null,
          worktreePath: null,
          subagentLimits: { codex: 3, claude: 8 },
          session: thread.session ? { ...thread.session, maxConcurrentSubagents: 3 } : null,
        })),
      },
      configureFixture: (next) => {
        next.serverConfig = {
          ...next.serverConfig,
          providers: next.serverConfig.providers.map((provider) => ({
            ...provider,
            runtimeCapabilities: {
              liveSteer: "unsupported",
              threadGoals: "unsupported",
              ...provider.runtimeCapabilities,
              subagentConcurrency: true,
            },
          })),
        };
      },
      resolveRpc: (body) =>
        body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand ? { sequence: 2 } : undefined,
    });
    try {
      await waitForServerConfigToApply();
      await page.getByRole("button", { name: "More composer controls", exact: true }).click();
      await page.getByRole("menuitem", { name: "Subagent limit…", exact: true }).click();
      await page
        .getByRole("spinbutton", { name: "Maximum concurrent subagents", exact: true })
        .fill("4");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await vi.waitFor(() =>
        expect(
          wsRequests.find(
            (body) =>
              body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              body.type === "thread.meta.update",
          ),
        ).toMatchObject({ threadId: THREAD_ID, subagentLimits: { codex: 4, claude: 8 } }),
      );
      expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.subagentLimits).toEqual(
        { codex: 4, claude: 8 },
      );
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Use this saved policy");
      await vi.waitFor(() =>
        expect(document.querySelector('[contenteditable="true"]')?.textContent).toContain(
          "Use this saved policy",
        ),
      );
      (await waitForSendButton()).click();
      await vi.waitFor(() =>
        expect(
          wsRequests.find(
            (body) =>
              body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              body.type === "thread.turn.start",
          ),
        ).toMatchObject({ threadId: THREAD_ID, subagentLimits: { codex: 4, claude: 8 } }),
      );
    } finally {
      await mounted.cleanup();
    }
  });

  describe("acknowledged subagent-policy ownership", () => {
    const alternateAccount = ProviderInstanceId.make("codex_limit_alternate");
    function policySnapshot() {
      const base = createSnapshotForTargetUser({
        targetMessageId: MessageId.make("limit-ownership"),
        targetText: "Synthetic policy history",
        history: "essential",
      });
      return {
        ...base,
        threads: base.threads.map((thread) => ({
          ...thread,
          subagentLimits: { codex: 3, claude: 8 },
          session: thread.session ? { ...thread.session, maxConcurrentSubagents: 3 } : null,
        })),
      };
    }
    function configureLimitFixture(next: TestFixture) {
      const baseProvider = next.serverConfig.providers[0]!;
      next.serverConfig = {
        ...next.serverConfig,
        providers: [
          ...next.serverConfig.providers,
          {
            ...baseProvider,
            instanceId: alternateAccount,
            displayName: "Alternate policy account",
          },
        ].map((provider) => ({
          ...provider,
          runtimeCapabilities: {
            liveSteer: "unsupported",
            threadGoals: "unsupported",
            ...provider.runtimeCapabilities,
            subagentConcurrency: true,
          },
        })),
        settings: {
          ...next.serverConfig.settings,
          providerInstances: {
            ...next.serverConfig.settings.providerInstances,
            [alternateAccount]: { driver: ProviderDriverKind.make("codex"), enabled: true },
          },
        },
      };
    }
    function publishPolicy(limits: { codex?: number; claude?: number }) {
      const snapshotSequence = chatViewFixture.fixture.snapshot.snapshotSequence + 1;
      const thread = { ...chatViewFixture.fixture.snapshot.threads[0]!, subagentLimits: limits };
      chatViewFixture.fixture.snapshot = {
        ...chatViewFixture.fixture.snapshot,
        snapshotSequence,
        threads: [thread],
      };
      rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
        kind: "snapshot",
        snapshot: { snapshotSequence, thread },
      });
    }
    async function openPolicyEditor() {
      await page.getByRole("button", { name: "More composer controls", exact: true }).click();
      await page.getByRole("menuitem", { name: /^Subagent limit…/ }).click();
      await expect.element(page.getByRole("dialog", { name: "Subagent limit" })).toBeVisible();
    }
    async function waitForPolicy(limits: { codex?: number; claude?: number }) {
      await vi.waitFor(() =>
        expect(selectThreadByRef(useStore.getState(), THREAD_REF)?.subagentLimits).toEqual(limits),
      );
    }
    async function revokeRuntimeCapability() {
      chatViewFixture.fixture.serverConfig = {
        ...chatViewFixture.fixture.serverConfig,
        providers: chatViewFixture.fixture.serverConfig.providers.map((provider) => ({
          ...provider,
          runtimeCapabilities: { liveSteer: "unsupported", threadGoals: "unsupported" },
        })),
      };
      rpcHarness.emitStreamValue(WS_METHODS.subscribeServerConfig, {
        version: 1,
        type: "snapshot",
        config: encodeServerConfig(chatViewFixture.fixture.serverConfig),
      });
      await vi.waitFor(() =>
        expect(getServerConfig()?.providers[0]?.runtimeCapabilities?.subagentConcurrency).toBe(
          undefined,
        ),
      );
    }
    it("keeps delimiter-bearing targets and draft/server ownership distinct", () => {
      const first = {
        environmentId: EnvironmentId.make("environment:a"),
        threadId: "b" as ThreadId,
        instanceId: ProviderInstanceId.make("codex"),
        draftId: null,
        isServerThread: true,
      };
      const second = {
        ...first,
        environmentId: EnvironmentId.make("environment"),
        threadId: "a:b" as ThreadId,
      };
      // These are legal imported ids and collide under colon concatenation.
      expect(`${first.environmentId}:${first.threadId}:${first.instanceId}`).toBe(
        `${second.environmentId}:${second.threadId}:${second.instanceId}`,
      );
      expect(buildSubagentConcurrencyEditorKey(first)).not.toBe(
        buildSubagentConcurrencyEditorKey(second),
      );
      expect(buildSubagentConcurrencyEditorKey(first)).not.toBe(
        buildSubagentConcurrencyEditorKey({
          ...first,
          draftId: DraftId.make("draft-a"),
          isServerThread: false,
        }),
      );
      expect(buildSubagentConcurrencyEditorKey(first)).not.toBe(
        buildSubagentConcurrencyEditorKey({
          ...first,
          instanceId: alternateAccount,
        }),
      );
    });
    it.for([
      { timing: "before ACK", reset: false },
      { timing: "after ACK", reset: true },
    ])(
      "never restores an obsolete limit over a newer canonical policy ($timing, reset=$reset)",
      async ({ timing, reset }, context) => {
        let resolveAck!: (result: { sequence: number }) => void;
        const acknowledgement = new Promise<{ sequence: number }>((resolve) => {
          resolveAck = resolve;
        });
        let ackReleased = false;
        const releaseAck = () => {
          if (ackReleased) return;
          ackReleased = true;
          resolveAck({ sequence: 2 });
        };
        const owner = createChatViewCallerOwner(context, mountChatView, {
          label: "subagent-obsolete-ack",
          beforeDrain: releaseAck,
        });
        const openOwnedEditor = async () => {
          // The same original native controls, fenced between their awaits.
          await owner.own("controls", () =>
            page.getByRole("button", { name: "More composer controls", exact: true }).click(),
          );
          await owner.own("editor", () =>
            page.getByRole("menuitem", { name: /^Subagent limit…/ }).click(),
          );
          await owner.own("editor", () =>
            expect.element(page.getByRole("dialog", { name: "Subagent limit" })).toBeVisible(),
          );
        };
        const requested = reset ? { claude: 8 } : { codex: 6, claude: 8 };
        await owner.run(async () => {
          await owner.mount({
            viewport: DEFAULT_VIEWPORT,
            snapshot: policySnapshot(),
            configureFixture: configureLimitFixture,
            resolveRpc: (body) =>
              body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand
                ? body.type === "thread.meta.update"
                  ? acknowledgement
                  : { sequence: 20 }
                : undefined,
          });
          await openOwnedEditor();
          const popup = page.getByRole("dialog", { name: "Subagent limit" }).element();
          expect(popup.isConnected).toBe(true);
          expect(popup.hasAttribute("data-open")).toBe(true);
          if (!reset)
            await owner.own("input", () =>
              page.getByRole("spinbutton", { name: "Maximum concurrent subagents" }).fill("6"),
            );
          await owner.own(reset ? "reset" : "save", () =>
            page.getByRole("button", { name: reset ? "Reset" : "Save", exact: true }).click(),
          );
          await owner.own("request", () =>
            vi.waitFor(() =>
              expect(
                wsRequests.find(
                  (body) =>
                    body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                    body.type === "thread.meta.update",
                ),
              ).toMatchObject({ threadId: THREAD_ID, subagentLimits: requested }),
            ),
          );
          if (timing === "before ACK") {
            owner.assertActive();
            publishPolicy(requested);
            await owner.own("canonical", () => waitForPolicy(requested));
          } else {
            owner.assertActive();
            releaseAck();
            owner.mark("ack");
            await owner.own("overlay", () =>
              vi.waitFor(() =>
                expect(
                  useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.subagentLimits,
                ).toEqual(requested),
              ),
            );
          }
          const newer = { codex: 9, claude: 8 };
          owner.assertActive();
          publishPolicy(newer);
          await owner.own("canonical", () => waitForPolicy(newer));
          if (timing === "before ACK") {
            releaseAck();
            owner.mark("ack");
          }
          await owner.own("closed", () =>
            vi.waitFor(() => {
              // Retain this exact popup's semantic closure, not the duration of
              // its exit painting. The original reopen/value/send below remain
              // the real continuation proof; a closed attribute alone is not it.
              if (popup.isConnected) {
                expect(popup.hasAttribute("data-closed")).toBe(true);
                expect(popup.hasAttribute("data-open")).toBe(false);
              }
              expect(document.querySelector('[role="dialog"][data-open]')).toBeNull();
              expect(
                useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.subagentLimits,
              ).toBeUndefined();
              expect(selectThreadByRef(useStore.getState(), THREAD_REF)?.subagentLimits).toEqual(
                newer,
              );
            }),
          );
          await openOwnedEditor();
          await owner.own("value", () =>
            expect
              .element(page.getByRole("spinbutton", { name: "Maximum concurrent subagents" }))
              .toHaveValue(9),
          );
          await owner.own("close", () =>
            page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click(),
          );
          owner.assertActive();
          useComposerDraftStore.getState().setPrompt(THREAD_REF, "Use the latest durable policy");
          const sendButton = await owner.own("send-target", () => waitForSendButton());
          owner.assertActive();
          sendButton.click();
          owner.mark("send");
          await owner.own("receipt", () =>
            vi.waitFor(() =>
              expect(
                wsRequests.find(
                  (body) =>
                    body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                    body.type === "thread.turn.start",
                ),
              ).toMatchObject({ threadId: THREAD_ID, subagentLimits: newer }),
            ),
          );
        });
      },
    );
    it("does not install an overlay when the acknowledged policy already arrived", async (context) => {
      let resolveAck!: (result: { sequence: number }) => void;
      const acknowledgement = new Promise<{ sequence: number }>((resolve) => {
        resolveAck = resolve;
      });
      let ackReleased = false;
      const releaseAck = () => {
        if (ackReleased) return;
        ackReleased = true;
        resolveAck({ sequence: 2 });
      };
      const owner = createChatViewCallerOwner(context, mountChatView, {
        label: "subagent-already-canonical",
        beforeDrain: releaseAck,
      });
      await owner.run(async () => {
        await owner.mount({
          viewport: DEFAULT_VIEWPORT,
          snapshot: policySnapshot(),
          configureFixture: configureLimitFixture,
          resolveRpc: (body) =>
            body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand ? acknowledgement : undefined,
        });
        await owner.own("controls", () =>
          page.getByRole("button", { name: "More composer controls", exact: true }).click(),
        );
        await owner.own("editor", () =>
          page.getByRole("menuitem", { name: /^Subagent limit…/ }).click(),
        );
        await owner.own("editor", () =>
          expect.element(page.getByRole("dialog", { name: "Subagent limit" })).toBeVisible(),
        );
        const popup = page.getByRole("dialog", { name: "Subagent limit" }).element();
        expect(popup.isConnected).toBe(true);
        expect(popup.hasAttribute("data-open")).toBe(true);
        await owner.own("input", () =>
          page.getByRole("spinbutton", { name: "Maximum concurrent subagents" }).fill("6"),
        );
        await owner.own("save", () =>
          page.getByRole("button", { name: "Save", exact: true }).click(),
        );
        await owner.own("request", () =>
          vi.waitFor(() =>
            expect(wsRequests.some((body) => body.type === "thread.meta.update")).toBe(true),
          ),
        );
        owner.assertActive();
        publishPolicy({ codex: 6, claude: 8 });
        await owner.own("canonical", () => waitForPolicy({ codex: 6, claude: 8 }));
        releaseAck();
        owner.mark("ack");
        await owner.own("closed", () =>
          vi.waitFor(() => {
            // This case has no reopen action: prove only the exact acknowledged
            // popup closed and no open replacement, not physical exit retirement.
            if (popup.isConnected) {
              expect(popup.hasAttribute("data-closed")).toBe(true);
              expect(popup.hasAttribute("data-open")).toBe(false);
            }
            expect(document.querySelector('[role="dialog"][data-open]')).toBeNull();
            expect(
              useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.subagentLimits,
            ).toBeUndefined();
            expect(selectThreadByRef(useStore.getState(), THREAD_REF)?.subagentLimits).toEqual({
              codex: 6,
              claude: 8,
            });
          }),
        );
      });
    });
    it.for([false, true])(
      "preserves our newer ACK over earlier external projection until exact policy catches up (reset=%s)",
      async (reset, context) => {
        let resolveAck!: (result: { sequence: number }) => void;
        const acknowledgement = new Promise<{ sequence: number }>((resolve) => {
          resolveAck = resolve;
        });
        let ackReleased = false;
        const releaseAck = () => {
          if (ackReleased) return;
          ackReleased = true;
          resolveAck({ sequence: 3 });
        };
        const owner = createChatViewCallerOwner(context, mountChatView, {
          label: "subagent-newer-ack",
          beforeDrain: releaseAck,
        });
        const requested = reset ? { claude: 8 } : { codex: 6, claude: 8 };
        await owner.run(async () => {
          await owner.mount({
            viewport: DEFAULT_VIEWPORT,
            snapshot: policySnapshot(),
            configureFixture: configureLimitFixture,
            resolveRpc: (body) =>
              body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand
                ? body.type === "thread.meta.update"
                  ? acknowledgement
                  : { sequence: 4 }
                : undefined,
          });
          await owner.own("controls", () =>
            page.getByRole("button", { name: "More composer controls", exact: true }).click(),
          );
          await owner.own("editor", () =>
            page.getByRole("menuitem", { name: /^Subagent limit…/ }).click(),
          );
          await owner.own("editor", () =>
            expect.element(page.getByRole("dialog", { name: "Subagent limit" })).toBeVisible(),
          );
          if (!reset)
            await owner.own("input", () =>
              page.getByRole("spinbutton", { name: "Maximum concurrent subagents" }).fill("6"),
            );
          await owner.own(reset ? "reset" : "save", () =>
            page.getByRole("button", { name: reset ? "Reset" : "Save", exact: true }).click(),
          );
          await owner.own("request", () =>
            vi.waitFor(() =>
              expect(wsRequests.some((body) => body.type === "thread.meta.update")).toBe(true),
            ),
          );
          owner.assertActive();
          publishPolicy({ codex: 9, claude: 8 }); // External commit at sequence2.
          await owner.own("canonical", () => waitForPolicy({ codex: 9, claude: 8 }));
          releaseAck(); // Our save committed after that external update.
          owner.mark("ack");
          await owner.own("overlay", () =>
            vi.waitFor(() =>
              expect(
                useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.subagentLimits,
              ).toEqual(requested),
            ),
          );
          owner.assertActive();
          useComposerDraftStore
            .getState()
            .setPrompt(THREAD_REF, "Use the acknowledged newer policy");
          const sendButton = await owner.own("send-target", () => waitForSendButton());
          owner.assertActive();
          sendButton.click();
          owner.mark("send");
          await owner.own("receipt", () =>
            vi.waitFor(() =>
              expect(wsRequests.find((body) => body.type === "thread.turn.start")).toMatchObject({
                subagentLimits: requested,
              }),
            ),
          );
          owner.assertActive();
          publishPolicy(requested); // Exact thread snapshot reaches ACK sequence3.
          await owner.own("canonical", () => waitForPolicy(requested));
          await owner.own("overlay", () =>
            vi.waitFor(() =>
              expect(
                useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.subagentLimits,
              ).toBeUndefined(),
            ),
          );
          // The other channel may still deliver its older policy. It must
          // not replace either the canonical value or its exact authority.
          owner.assertActive();
          rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeShell, {
            kind: "thread-upserted",
            sequence: 2,
            thread: {
              ...toShellThread(chatViewFixture.fixture.snapshot.threads[0]!),
              subagentLimits: { codex: 9, claude: 8 },
            },
          });
          await owner.own("layout", () => waitForLayout());
          expect(selectThreadByRef(useStore.getState(), THREAD_REF)?.subagentLimits).toEqual(
            requested,
          );
          expect(
            useStore.getState().environmentStateById[LOCAL_ENVIRONMENT_ID]
              ?.subagentPolicySequenceByThreadId?.[THREAD_ID],
          ).toBe(3);
        });
      },
    );
    it("does not retire an ACK bridge through another chat or an omission-only metadata event", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: policySnapshot(),
        configureFixture: configureLimitFixture,
        resolveRpc: (body) =>
          body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand ? { sequence: 3 } : undefined,
      });
      try {
        await openPolicyEditor();
        await page.getByRole("spinbutton", { name: "Maximum concurrent subagents" }).fill("6");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await vi.waitFor(() =>
          expect(
            useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.subagentLimits,
          ).toEqual({ codex: 6, claude: 8 }),
        );
        const unrelatedId = "unrelated-policy-chat" as ThreadId;
        const unrelated = addThreadToSnapshot(
          chatViewFixture.fixture.snapshot,
          unrelatedId,
        ).threads.find((thread) => thread.id === unrelatedId)!;
        rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeShell, {
          kind: "thread-upserted",
          sequence: 20,
          thread: { ...toShellThread(unrelated), subagentLimits: { codex: 20 } },
        });
        rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
          kind: "event",
          event: {
            type: "thread.meta-updated",
            sequence: 2,
            eventId: EventId.make("omitted-policy-meta"),
            aggregateKind: "thread",
            aggregateId: THREAD_ID,
            occurredAt: NOW_ISO,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            payload: { threadId: THREAD_ID, title: "Unrelated title update", updatedAt: NOW_ISO },
          },
        });
        await vi.waitFor(() =>
          expect(selectThreadByRef(useStore.getState(), THREAD_REF)?.title).toBe(
            "Unrelated title update",
          ),
        );
        expect(
          useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.subagentLimits,
        ).toEqual({ codex: 6, claude: 8 });
        expect(
          useStore.getState().environmentStateById[LOCAL_ENVIRONMENT_ID]
            ?.subagentPolicySequenceByThreadId?.[THREAD_ID],
        ).toBe(1);
        // A full exact-thread witness does certify policy, including when
        // its scalar value is unchanged from the earlier canonical value.
        chatViewFixture.fixture.snapshot = {
          ...chatViewFixture.fixture.snapshot,
          snapshotSequence: 2,
        };
        publishPolicy({ codex: 3, claude: 8 });
        await vi.waitFor(() =>
          expect(
            useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.subagentLimits,
          ).toBeUndefined(),
        );
        expect(selectThreadByRef(useStore.getState(), THREAD_REF)?.subagentLimits).toEqual({
          codex: 3,
          claude: 8,
        });
      } finally {
        await mounted.cleanup();
      }
    });
    it("keeps control-only compaction available with an unsupported remembered numeric policy", async () => {
      const base = policySnapshot();
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: {
          ...base,
          threads: base.threads.map((thread) => ({
            ...thread,
            subagentLimits: { codex: 6 },
            session: thread.session
              ? { ...thread.session, providerInstanceId: ProviderInstanceId.make("codex") }
              : null,
          })),
        },
        resolveRpc: (body) =>
          body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand ? { sequence: 2 } : undefined,
      });
      try {
        useComposerDraftStore.getState().setPrompt(THREAD_REF, "/compact");
        (await waitForSendButton()).click();
        await vi.waitFor(() =>
          expect(wsRequests.find((body) => body.type === "thread.compact")).toMatchObject({
            threadId: THREAD_ID,
            providerInstanceId: "codex",
          }),
        );
        expect(
          wsRequests.some(
            (body) => body.type === "thread.turn.start" || body.type === "thread.create",
          ),
        ).toBe(false);
        expect(selectThreadByRef(useStore.getState(), THREAD_REF)?.subagentLimits).toEqual({
          codex: 6,
        });
        expect(document.body.textContent).not.toContain(
          "does not support the saved subagent limit",
        );
      } finally {
        await mounted.cleanup();
      }
    });
    it("discards a restored orphan server overlay without losing unsent content", async () => {
      const base = policySnapshot();
      const canonical = { codex: 9, claude: 8 };
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: {
          ...base,
          threads: base.threads.map((thread) => ({ ...thread, subagentLimits: canonical })),
        },
        configureFixture: (next) => {
          configureLimitFixture(next);
          // A browser reload can restore persistent storage without running
          // the old pane's cleanup. No ACK scope survives to own this value.
          useComposerDraftStore.getState().setSubagentLimits(THREAD_REF, { codex: 6, claude: 8 });
          useComposerDraftStore.getState().setPrompt(THREAD_REF, "Unsent content survives reload");
        },
        resolveRpc: (body) =>
          body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand ? { sequence: 20 } : undefined,
      });
      try {
        await vi.waitFor(() => {
          const draft = useComposerDraftStore.getState().getComposerDraft(THREAD_REF);
          expect(draft?.subagentLimits).toBeUndefined();
          expect(draft?.prompt).toBe("Unsent content survives reload");
        });
        await openPolicyEditor();
        await expect
          .element(page.getByRole("spinbutton", { name: "Maximum concurrent subagents" }))
          .toHaveValue(9);
        await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
        (await waitForSendButton()).click();
        await vi.waitFor(() =>
          expect(wsRequests.find((body) => body.type === "thread.turn.start")).toMatchObject({
            threadId: THREAD_ID,
            subagentLimits: canonical,
          }),
        );
      } finally {
        await mounted.cleanup();
      }
    });
    it("preserves an inherited numeric draft on an unsupported runtime and requires clearing account intent before bootstrap", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createProjectlessSnapshot(),
        initialPath: "/",
        configureFixture: (next) => {
          configureStandaloneShortcut(next);
          next.serverConfig = {
            ...next.serverConfig,
            settings: {
              ...next.serverConfig.settings,
              defaultProviderInstanceId: ProviderInstanceId.make("codex"),
              providerInstances: {
                ...next.serverConfig.settings.providerInstances,
                [ProviderInstanceId.make("codex")]: {
                  driver: ProviderDriverKind.make("codex"),
                  defaultModel: "gpt-5",
                  defaultMaxConcurrentSubagents: 6,
                },
              },
            },
          };
        },
        resolveRpc: (body) =>
          body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand ? { sequence: 2 } : undefined,
      });
      try {
        newChatShortcut();
        await vi.waitFor(() =>
          expect(mounted.router.state.location.pathname).toMatch(UUID_ROUTE_RE),
        );
        const draftId = draftIdFromPath(mounted.router.state.location.pathname);
        const prompt = "Retain this prompt until the unsupported request is reset";
        expect(
          useComposerDraftStore.getState().getComposerDraft(draftId)?.subagentLimits,
        ).toBeUndefined();
        useComposerDraftStore.getState().setPrompt(draftId, prompt);
        await waitForStandaloneComposerText(prompt);
        (await waitForSendButton()).click();
        await vi.waitFor(() =>
          expect(document.body.textContent).toContain(
            "This provider runtime does not support the account subagent limit. Clear it in account settings or use a supported runtime before sending.",
          ),
        );
        expect(wsRequests.some((body) => body.type === "thread.turn.start")).toBe(false);
        expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(prompt);
        await openPolicyEditor();
        await expect
          .element(page.getByRole("spinbutton", { name: "Maximum concurrent subagents" }))
          .toBeDisabled();
        await expect.element(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
        await expect
          .element(page.getByRole("spinbutton", { name: "Maximum concurrent subagents" }))
          .toHaveValue(null);
        await page.getByRole("button", { name: "Reset", exact: true }).click();
        await vi.waitFor(() =>
          expect(
            useComposerDraftStore.getState().getComposerDraft(draftId)?.subagentLimits,
          ).toEqual({}),
        );
        (await waitForSendButton()).click();
        // Reset clears only chat intent. The same live account default must
        // still block an unsupported runtime without consuming this prompt.
        await vi.waitFor(() =>
          expect(document.body.textContent).toContain(
            "This provider runtime does not support the account subagent limit.",
          ),
        );
        expect(wsRequests.some((body) => body.type === "thread.turn.start")).toBe(false);
        expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(prompt);
        chatViewFixture.fixture.serverConfig = {
          ...chatViewFixture.fixture.serverConfig,
          settings: {
            ...chatViewFixture.fixture.serverConfig.settings,
            providerInstances: {
              ...chatViewFixture.fixture.serverConfig.settings.providerInstances,
              [ProviderInstanceId.make("codex")]: {
                driver: ProviderDriverKind.make("codex"),
                defaultModel: "gpt-5",
              },
            },
          },
        };
        applySettingsUpdated(chatViewFixture.fixture.serverConfig.settings);
        (await waitForSendButton()).click();
        await vi.waitFor(() =>
          expect(wsRequests.find((body) => body.type === "thread.turn.start")).toMatchObject({
            threadId: draftThreadIdFor(draftId),
            subagentLimits: {},
            bootstrap: { createThread: { projectId: null, subagentLimits: {} } },
          }),
        );
      } finally {
        await mounted.cleanup();
      }
    });
    it.each([
      { supported: false, projectId: PROJECT_ID },
      { supported: true, projectId: PROJECT_ID },
      { supported: true, projectId: null },
    ])(
      "admits plan implementation in a new chat only after supported policy or explicit reset (supported=$supported, projectId=$projectId)",
      async ({ supported, projectId }) => {
        const base = createSnapshotWithPlanFollowUpPrompt();
        const requested = { codex: 6, claude: 8 };
        const mounted = await mountChatView({
          viewport: WIDE_FOOTER_VIEWPORT,
          snapshot: {
            ...base,
            threads: base.threads.map((thread) => ({
              ...thread,
              projectId,
              ...(projectId === null ? { branch: null, worktreePath: null } : {}),
              subagentLimits: requested,
            })),
          },
          configureFixture: (next) => {
            configureLimitFixture(next);
            if (!supported) {
              next.serverConfig = {
                ...next.serverConfig,
                providers: next.serverConfig.providers.map((provider) => ({
                  ...provider,
                  runtimeCapabilities: { liveSteer: "unsupported", threadGoals: "unsupported" },
                })),
              };
            }
          },
          resolveRpc: (body) => {
            if (body._tag !== ORCHESTRATION_WS_METHODS.dispatchCommand) return undefined;
            if (body.type === "thread.create") {
              const nextId = body.threadId as ThreadId;
              const snapshotSequence = chatViewFixture.fixture.snapshot.snapshotSequence + 1;
              chatViewFixture.fixture.snapshot = {
                ...addThreadToSnapshot(chatViewFixture.fixture.snapshot, nextId),
                snapshotSequence,
              };
              const created = chatViewFixture.fixture.snapshot.threads.find(
                (thread) => thread.id === nextId,
              )!;
              const thread = {
                ...created,
                projectId,
                ...(projectId === null ? { branch: null, worktreePath: null } : {}),
                subagentLimits: supported ? requested : { claude: 8 },
              };
              chatViewFixture.fixture.snapshot = {
                ...chatViewFixture.fixture.snapshot,
                threads: chatViewFixture.fixture.snapshot.threads.map((entry) =>
                  entry.id === nextId ? thread : entry,
                ),
              };
              rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeShell, {
                kind: "thread-upserted",
                sequence: snapshotSequence,
                thread: { ...toShellThread(thread), subagentLimits: thread.subagentLimits },
              });
            }
            return { sequence: chatViewFixture.fixture.snapshot.snapshotSequence + 1 };
          },
        });
        const implementInNewChat = async () => {
          await waitForElement(
            () =>
              document.querySelector<HTMLButtonElement>(
                'button[aria-label="Implementation actions"]',
              ),
            "plan implementation actions",
          );
          await expect
            .element(page.getByRole("button", { name: "Implementation actions", exact: true }))
            .toBeVisible();
          await page.getByRole("button", { name: "Implementation actions", exact: true }).click();
          await page
            .getByRole("menuitem", { name: "Implement in a new chat", exact: true })
            .click();
        };
        try {
          await waitForButtonByText("Implement");
          await vi.waitFor(() =>
            expect(
              document.querySelector('[data-chat-composer-implement-actions="true"]'),
              `Expected composer plan actions; thread mode=${selectThreadByRef(useStore.getState(), THREAD_REF)?.interactionMode}, draft mode=${useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.interactionMode}, prompt=${JSON.stringify(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt)}`,
            ).not.toBeNull(),
          );
          if (!supported) {
            await implementInNewChat();
            await vi.waitFor(() =>
              expect(document.body.textContent).toContain(
                "This provider runtime does not support the saved subagent limit. Reset it in More composer controls before sending.",
              ),
            );
            // Admission precedes allocation and creation: there is neither
            // a new conversation to clean up nor a paid/native submission.
            expect(
              wsRequests.some(
                (body) => body.type === "thread.create" || body.type === "thread.turn.start",
              ),
            ).toBe(false);
            expect(mounted.router.state.location.pathname).toBe(
              `/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}`,
            );
            await openPolicyEditor();
            await page.getByRole("button", { name: "Reset", exact: true }).click();
            await vi.waitFor(() =>
              expect(
                useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.subagentLimits,
              ).toEqual({ claude: 8 }),
            );
          }
          await implementInNewChat();
          await vi.waitFor(() => {
            const create = wsRequests.find((body) => body.type === "thread.create");
            const turn = wsRequests.find((body) => body.type === "thread.turn.start");
            const expected = supported ? requested : { claude: 8 };
            expect(create).toMatchObject({
              projectId,
              runtimeMode: "full-access",
              subagentLimits: expected,
            });
            expect(turn).toMatchObject({
              threadId: create?.threadId,
              runtimeMode: "full-access",
              subagentLimits: expected,
              sourceProposedPlan: { threadId: THREAD_ID, planId: "plan-follow-up-browser-test" },
            });
          });
        } finally {
          await mounted.cleanup();
        }
      },
    );
    it.each([false, true])(
      "uses current durable policy for a parked queue, including runtime downgrade=%s",
      async (downgraded) => {
        const base = policySnapshot();
        const thread = base.threads[0]!;
        const running = {
          ...base,
          threads: [
            {
              ...thread,
              session: thread.session ? { ...thread.session, status: "running" as const } : null,
            },
          ],
        };
        const mounted = await mountChatView({
          viewport: DEFAULT_VIEWPORT,
          snapshot: running,
          configureFixture: configureLimitFixture,
          resolveRpc: (body) =>
            body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand ? { sequence: 2 } : undefined,
        });
        try {
          await openPolicyEditor();
          await page.getByRole("spinbutton", { name: "Maximum concurrent subagents" }).fill("6");
          await page.getByRole("button", { name: "Save", exact: true }).click();
          await vi.waitFor(() =>
            expect(
              useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.subagentLimits,
            ).toEqual({ codex: 6, claude: 8 }),
          );
          useComposerDraftStore
            .getState()
            .setPrompt(THREAD_REF, "Queue before the other client changes policy");
          await page.getByRole("button", { name: "Queue message", exact: true }).click();
          await vi.waitFor(() =>
            expect(
              document.querySelector('[data-cafe-followup-queue="true"]')?.textContent,
            ).toContain("Queue before the other client changes policy"),
          );
          publishPolicy({ codex: 9, claude: 8 });
          await waitForPolicy({ codex: 9, claude: 8 });
          if (downgraded) await revokeRuntimeCapability();
          const current = chatViewFixture.fixture.snapshot.threads[0]!;
          const snapshotSequence = chatViewFixture.fixture.snapshot.snapshotSequence + 1;
          const idle = {
            ...current,
            session: current.session ? { ...current.session, status: "ready" as const } : null,
          };
          chatViewFixture.fixture.snapshot = {
            ...chatViewFixture.fixture.snapshot,
            snapshotSequence,
            threads: [idle],
          };
          rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
            kind: "snapshot",
            snapshot: { snapshotSequence, thread: idle },
          });
          rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeShell, {
            kind: "thread-upserted",
            sequence: snapshotSequence,
            thread: { ...toShellThread(idle), subagentLimits: idle.subagentLimits },
          });
          if (downgraded) {
            await vi.waitFor(() =>
              expect(
                document.querySelector('[data-cafe-followup-queue="true"]')?.textContent,
              ).toContain(
                "This provider runtime does not support the saved subagent limit. Reset it in More composer controls before sending.",
              ),
            );
            expect(wsRequests.some((body) => body.type === "thread.turn.start")).toBe(false);
            expect(
              document.querySelector('[data-cafe-followup-queue="true"]')?.textContent,
            ).toContain("Queue before the other client changes policy");
          } else
            await vi.waitFor(() => {
              const queued = wsRequests.find(
                (body) =>
                  body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                  body.type === "thread.turn.start",
              );
              expect(queued).toMatchObject({ threadId: THREAD_ID });
              expect(queued).not.toHaveProperty("subagentLimits");
              expect(selectThreadByRef(useStore.getState(), THREAD_REF)?.subagentLimits).toEqual({
                codex: 9,
                claude: 8,
              });
            });
        } finally {
          await mounted.cleanup();
        }
      },
    );
    it.each([
      { change: "account", afterAck: false },
      { change: "thread", afterAck: false },
      { change: "unmount", afterAck: false },
      { change: "account", afterAck: true },
      { change: "thread", afterAck: true },
      { change: "unmount", afterAck: true },
    ])(
      "releases exact-owner ACK authority after $change changes (after ACK=$afterAck)",
      async ({ change, afterAck }) => {
        let resolveAck!: (result: { sequence: number }) => void;
        const acknowledgement = new Promise<{ sequence: number }>((resolve) => {
          resolveAck = resolve;
        });
        const base = policySnapshot();
        const secondId = "limit-other-thread" as ThreadId;
        const mounted = await mountChatView({
          viewport: DEFAULT_VIEWPORT,
          snapshot: addThreadToSnapshot(base, secondId),
          configureFixture: configureLimitFixture,
          resolveRpc: (body) =>
            body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand ? acknowledgement : undefined,
        });
        let cleaned = false;
        try {
          await openPolicyEditor();
          await page.getByRole("spinbutton", { name: "Maximum concurrent subagents" }).fill("6");
          await page.getByRole("button", { name: "Save", exact: true }).click();
          await vi.waitFor(() =>
            expect(wsRequests.some((body) => body.type === "thread.meta.update")).toBe(true),
          );
          if (afterAck) {
            resolveAck({ sequence: 3 });
            await vi.waitFor(() =>
              expect(
                useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.subagentLimits,
              ).toEqual({ codex: 6, claude: 8 }),
            );
          }
          if (change === "account")
            useComposerDraftStore
              .getState()
              .setModelSelection(THREAD_REF, createModelSelection(alternateAccount, "gpt-5"));
          else if (change === "thread")
            await mounted.router.navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId: LOCAL_ENVIRONMENT_ID, threadId: secondId },
            });
          else {
            await mounted.cleanup();
            cleaned = true;
          }
          await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
          resolveAck({ sequence: 3 });
          await waitForLayout();
          await vi.waitFor(() => {
            expect(
              useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.subagentLimits,
            ).toBeUndefined();
            expect(
              useComposerDraftStore.getState().getComposerDraft(threadRefFor(secondId))
                ?.subagentLimits,
            ).toBeUndefined();
          });
        } finally {
          resolveAck({ sequence: 3 });
          if (!cleaned) await mounted.cleanup();
        }
      },
    );
  });

  it("uses global account and model defaults while an unrelated project is active", async () => {
    const account = ProviderInstanceId.make("codex_standalone_default");
    const base = createSnapshotForTargetUser({
      targetMessageId: MessageId.make("standalone-defaults"),
      targetText: "Unrelated project",
      history: "essential",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...base,
        projects: base.projects.map((project) => ({
          ...project,
          defaultModelSelection: createModelSelection(
            ProviderInstanceId.make("codex"),
            "gpt-project-specific",
          ),
        })),
      },
      configureFixture: (next) => {
        configureStandaloneShortcut(next);
        next.serverConfig = {
          ...next.serverConfig,
          providers: [
            ...next.serverConfig.providers,
            {
              ...next.serverConfig.providers[0]!,
              instanceId: account,
              displayName: "Global chat account",
            },
          ],
          settings: {
            ...next.serverConfig.settings,
            defaultProviderInstanceId: account,
            providerInstances: {
              ...next.serverConfig.settings.providerInstances,
              [account]: {
                driver: ProviderDriverKind.make("codex"),
                displayName: "Global chat account",
                defaultModel: "gpt-5",
                defaultMaxConcurrentSubagents: 6,
              },
            },
          },
        };
      },
    });
    try {
      newChatShortcut();
      await vi.waitFor(() => expect(mounted.router.state.location.pathname).toMatch(UUID_ROUTE_RE));
      const draftId = draftIdFromPath(mounted.router.state.location.pathname);
      expect(useComposerDraftStore.getState().getDraftSession(draftId)?.projectId).toBeNull();
      expect(useComposerDraftStore.getState().getComposerDraft(draftId)).toMatchObject({
        activeProvider: account,
        modelSelectionByProvider: { [account]: { instanceId: account, model: "gpt-5" } },
      });
      expect(
        useComposerDraftStore.getState().getComposerDraft(draftId)?.subagentLimits,
      ).toBeUndefined();
      expect(
        useComposerDraftStore.getState().logicalProjectDraftThreadKeyByLogicalProjectKey,
      ).toEqual({});
    } finally {
      await mounted.cleanup();
    }
  });

  it("reuses the standalone editor, preserves sidebar mode, and adds a chat only on first send", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createProjectlessSnapshot(),
      initialPath: "/",
      configureFixture: (next) => {
        configureStandaloneShortcut(next);
        next.serverConfig = {
          ...next.serverConfig,
          providers: next.serverConfig.providers.map((provider) => ({
            ...provider,
            runtimeCapabilities: {
              liveSteer: "unsupported",
              threadGoals: "unsupported",
              subagentConcurrency: true,
            },
          })),
        };
      },
      resolveRpc: (body) =>
        body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand ? { sequence: 2 } : undefined,
    });
    try {
      // Exercise the Projects Chats heading action before the global shortcut.
      const newChat = page
        .getByLabelText("Standalone chats", { exact: true })
        .getByRole("button", { name: "New chat", exact: true });
      await newChat.click();
      await vi.waitFor(() => expect(mounted.router.state.location.pathname).toMatch(UUID_ROUTE_RE));
      const draftId = draftIdFromPath(mounted.router.state.location.pathname);
      const threadId = draftThreadIdFor(draftId);
      expect(useDeskStore.getState().desk.sidebarMode).toBe("projects");
      expect(useDeskStore.getState().desk.groups.g1?.tabs).toEqual([]);
      expect(useDeskStore.getState().activeDraftId).toBe(draftId);
      expect(document.querySelector("[data-desk-tab-key]")).toBeNull();
      expect(document.body.textContent).toContain("No chats yet");
      useComposerDraftStore.getState().setSubagentLimits(draftId, { codex: 5 });
      useComposerDraftStore.getState().setPrompt(draftId, "First standalone conversation");
      await waitForStandaloneComposerText("First standalone conversation");
      await newChat.click();
      await waitForLayout();
      expect(mounted.router.state.location.pathname).toBe(`/draft/${draftId}`);
      expect(Object.keys(useComposerDraftStore.getState().draftThreadsByThreadKey)).toEqual([
        draftId,
      ]);
      await waitForStandaloneComposerText("First standalone conversation");
      await page.getByRole("button", { name: "Desk", exact: true }).click();
      const deskNewChat = page.getByRole("button", {
        name: "New chat in active tab group",
        exact: true,
      });
      await expect.element(deskNewChat).toBeVisible();
      await deskNewChat.click();
      await waitForLayout();
      expect(mounted.router.state.location.pathname).toBe(`/draft/${draftId}`);
      expect(Object.keys(useComposerDraftStore.getState().draftThreadsByThreadKey)).toEqual([
        draftId,
      ]);
      await waitForStandaloneComposerText("First standalone conversation");
      expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.subagentLimits).toEqual({
        codex: 5,
      });
      newChatShortcut();
      await waitForLayout();
      expect(mounted.router.state.location.pathname).toBe(`/draft/${draftId}`);
      expect(useDeskStore.getState().desk.sidebarMode).toBe("desk");
      expect(document.querySelector("[data-desk-chat-row]")).toBeNull();
      expect(useDeskStore.getState().desk.groups.g1?.tabs).toEqual([]);
      // The collapsed header is another entrypoint to the exact same draft,
      // not a project-derived creation path or an implicit first submission.
      const closeSidebar = document.querySelector<HTMLButtonElement>(
        '[data-slot="sidebar-header"] [data-sidebar="trigger"]',
      )!;
      await page.elementLocator(closeSidebar).click();
      const headerNewChat = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            '[data-sidebar="content-controls"]:not([hidden]) button[aria-label="New chat"]',
          ),
        "Collapsed-header New chat action missing",
      );
      await expect.element(headerNewChat).toBeEnabled();
      await page.elementLocator(headerNewChat).click();
      await waitForStandaloneComposerText("First standalone conversation");
      expect(mounted.router.state.location.pathname).toBe(`/draft/${draftId}`);
      expect(Object.keys(useComposerDraftStore.getState().draftThreadsByThreadKey)).toEqual([
        draftId,
      ]);
      expect(useComposerDraftStore.getState().getDraftSession(draftId)?.environmentId).toBe(
        LOCAL_ENVIRONMENT_ID,
      );
      expect(useDeskStore.getState().draftEditors[draftId]?.groupId).toBe("g1");
      expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.subagentLimits).toEqual({
        codex: 5,
      });
      expect(useDeskStore.getState().desk.sidebarMode).toBe("desk");
      expect(useDeskStore.getState().desk.groups.g1?.tabs).toEqual([]);
      expect(
        wsRequests.some((body) => body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand),
      ).toBe(false);
      expect(document.querySelector('[aria-label="Open in"]')).toBeNull();
      expect(document.body.textContent).not.toContain("Current checkout");
      (await waitForSendButton()).click();
      await vi.waitFor(() => {
        const request = wsRequests.find(
          (body) =>
            body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            body.type === "thread.turn.start",
        );
        expect(request).toMatchObject({
          threadId,
          runtimeMode: "full-access",
          subagentLimits: { codex: 5 },
          bootstrap: {
            createThread: {
              projectId: null,
              branch: null,
              worktreePath: null,
              subagentLimits: { codex: 5 },
            },
          },
        });
        const bootstrap = (request as { bootstrap?: Record<string, unknown> } | undefined)
          ?.bootstrap;
        expect(bootstrap?.prepareWorktree).toBeUndefined();
        expect(bootstrap?.runSetupScript).toBeUndefined();
      });
      chatViewFixture.fixture.snapshot = addThreadToSnapshot(
        chatViewFixture.fixture.snapshot,
        threadId,
      );
      chatViewFixture.fixture.snapshot = {
        ...chatViewFixture.fixture.snapshot,
        threads: chatViewFixture.fixture.snapshot.threads.map((thread) =>
          thread.id === threadId
            ? { ...thread, projectId: null, branch: null, worktreePath: null }
            : thread,
        ),
      };
      await startPromotedServerThreadViaDomainEvent(threadId);
      await vi.waitFor(() => {
        expect(useDeskStore.getState().desk.groups.g1?.tabs).toEqual([
          deskTabKey({ kind: "server", threadRef: threadRefFor(threadId) }),
        ]);
        expect(document.querySelectorAll("[data-desk-chat-row]")).toHaveLength(1);
        expect(useDeskStore.getState().activeDraftId).toBeNull();
        expect(mounted.router.state.location.pathname).toBe(serverThreadPath(threadId));
      });
      expect(useDeskStore.getState().desk.sidebarMode).toBe("desk");
      const reopenSidebar = document.querySelector<HTMLButtonElement>(
        '[data-sidebar="content-controls"]:not([hidden]) [data-sidebar="trigger"]',
      )!;
      await page.elementLocator(reopenSidebar).click();
      await page.getByRole("button", { name: "Projects", exact: true }).click();
      await expect.element(page.getByTestId(`thread-row-${threadId}`)).toBeVisible();
      expect(document.querySelectorAll('[data-testid^="thread-row-"]')).toHaveLength(1);
      expect(
        useComposerDraftStore.getState().logicalProjectDraftThreadKeyByLogicalProjectKey,
      ).toEqual({});
      expect(wsRequests.some((body) => body._tag === WS_METHODS.vcsListRefs)).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });

  it("captures the editor's group and promotes its first send without stealing a newer editor", async (context) => {
    let release!: (value: { sequence: number }) => void;
    const pending = new Promise<{ sequence: number }>((resolve) => {
      release = resolve;
    });
    let startReleased = false;
    const releaseStart = () => {
      if (startReleased) return;
      startReleased = true;
      release({ sequence: 2 });
    };
    const owner = createChatViewCallerOwner(context, mountChatView, {
      label: "editor-promotion",
      beforeDrain: releaseStart,
    });
    const firstSavedId = ThreadId.make("standalone-saved-one");
    const secondSavedId = ThreadId.make("standalone-saved-two");
    const withSaved = addThreadToSnapshot(
      addThreadToSnapshot(createProjectlessSnapshot(), firstSavedId),
      secondSavedId,
    );
    await owner.run(async () => {
      const mounted = await owner.mount({
        viewport: { ...DEFAULT_VIEWPORT, width: 1800, height: 1000 },
        snapshot: {
          ...withSaved,
          threads: withSaved.threads.map((thread) => ({
            ...thread,
            projectId: null,
            branch: null,
            worktreePath: null,
          })),
        },
        initialPath: "/",
        configureFixture: configureStandaloneShortcut,
        resolveRpc: (body) =>
          body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
          body.type === "thread.turn.start"
            ? pending
            : undefined,
      });
      owner.assertActive();
      const desk = useDeskStore.getState();
      desk.dispatch({
        type: "open",
        target: { kind: "server", threadRef: threadRefFor(firstSavedId) },
      });
      desk.dispatch({
        type: "open",
        target: { kind: "server", threadRef: threadRefFor(secondSavedId) },
      });
      const secondKey = deskTabKey({ kind: "server", threadRef: threadRefFor(secondSavedId) });
      desk.dispatch({ type: "split", tabKey: secondKey, targetGroupId: "g1", edge: "right" });
      desk.dispatch({ type: "sidebarMode", mode: "desk" });
      const capturedGroup = useDeskStore.getState().desk.activeGroupId;
      await owner.own("layout", () => waitForLayout());
      // The Desk heading uses the same pending-editor flow and captures the
      // exact active group, not the saved chat visible in another pane.
      const deskNewChat = page.getByRole("button", {
        name: "New chat in active tab group",
        exact: true,
      });
      await owner.own("editor", () => expect.element(deskNewChat).toBeVisible());
      await owner.own("editor", () => deskNewChat.click());
      await owner.own("route", () =>
        vi.waitFor(() => expect(mounted.router.state.location.pathname).toMatch(UUID_ROUTE_RE)),
      );
      const first = draftIdFromPath(mounted.router.state.location.pathname);
      const firstThreadId = draftThreadIdFor(first);
      expect(useDeskStore.getState().draftEditors[first]?.groupId).toBe(capturedGroup);
      expect(useDeskStore.getState().desk.groups[capturedGroup]?.tabs).toEqual([secondKey]);
      expect(
        wsRequests.some((body) => body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand),
      ).toBe(false);
      owner.assertActive();
      useComposerDraftStore.getState().setPrompt(first, "Send the first chat");
      await owner.own("prompt", () => waitForStandaloneComposerText("Send the first chat"));
      const firstPane = await owner.own("send-target", () =>
        waitForElement(
          () => document.querySelector<HTMLElement>('.desk-pane[data-active="true"]'),
          "First Desk pane missing",
        ),
      );
      owner.assertActive();
      firstPane.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!.click();
      owner.mark("send");
      await owner.own("request", () =>
        vi.waitFor(() =>
          expect(
            wsRequests.some(
              (body) =>
                body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                body.type === "thread.turn.start",
            ),
          ).toBe(true),
        ),
      );
      const originalKey = deskTabKey({ kind: "server", threadRef: threadRefFor(firstSavedId) });
      const originalTab = await owner.own("tab", () =>
        waitForElement(
          () =>
            Array.from(document.querySelectorAll<HTMLButtonElement>("[data-desk-tab-key]")).find(
              (tab) => tab.dataset.deskTabKey === originalKey,
            ) ?? null,
          "Saved standalone tab missing",
        ),
      );
      await owner.own("tab", () => userEvent.click(originalTab));
      await owner.own("route", () =>
        vi.waitFor(() =>
          expect(mounted.router.state.location.pathname).toBe(serverThreadPath(firstSavedId)),
        ),
      );
      // The global shortcut observes the same exact first-send gate.
      owner.assertActive();
      newChatShortcut();
      owner.mark("draft");
      await owner.own("route", () =>
        vi.waitFor(() => expect(mounted.router.state.location.pathname).toMatch(UUID_ROUTE_RE)),
      );
      const newer = draftIdFromPath(mounted.router.state.location.pathname);
      expect(newer).not.toBe(first);
      expect(useDeskStore.getState().draftEditors[newer]?.groupId).toBe("g1");
      owner.assertActive();
      useComposerDraftStore.getState().setPrompt(newer, "Newer composer survives");
      await owner.own("prompt", () => waitForStandaloneComposerText("Newer composer survives"));
      releaseStart();
      owner.mark("ack");
      owner.assertActive();
      chatViewFixture.fixture.snapshot = addThreadToSnapshot(
        chatViewFixture.fixture.snapshot,
        firstThreadId,
      );
      chatViewFixture.fixture.snapshot = {
        ...chatViewFixture.fixture.snapshot,
        threads: chatViewFixture.fixture.snapshot.threads.map((thread) =>
          thread.id === firstThreadId
            ? { ...thread, projectId: null, branch: null, worktreePath: null }
            : thread,
        ),
      };
      await owner.own("snapshot", () => startPromotedServerThreadViaDomainEvent(firstThreadId));
      await owner.own("receipt", () =>
        vi.waitFor(() => {
          expect(useDeskStore.getState().desk.groups[capturedGroup]?.tabs).toContain(
            deskTabKey({ kind: "server", threadRef: threadRefFor(firstThreadId) }),
          );
          expect(useDeskStore.getState().desk.groups[capturedGroup]?.activeTabKey).toBe(secondKey);
          expect(useDeskStore.getState().desk.activeGroupId).toBe("g1");
          expect(useDeskStore.getState().activeDraftId).toBe(newer);
          expect(mounted.router.state.location.pathname).toBe(`/draft/${newer}`);
        }),
      );
      await owner.own("prompt", () => waitForStandaloneComposerText("Newer composer survives"));
      expect(useDeskStore.getState().desk.sidebarMode).toBe("desk");
      expect(
        wsRequests.filter(
          (body) =>
            body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            body.type === "thread.turn.start",
        ),
      ).toHaveLength(1);
    });
  });

  it("dispatches a persisted standalone follow-up with no project metadata", async () => {
    const base = createSnapshotForTargetUser({
      targetMessageId: MessageId.make("standalone-queue"),
      targetText: "Standalone history",
    });
    const snapshot = {
      ...base,
      projects: [],
      threads: base.threads.map((thread) => ({
        ...thread,
        projectId: null,
        runtimeMode: "approval-required" as const,
        branch: null,
        worktreePath: null,
      })),
    };
    const persistence = createFollowUpQueuePersistence();
    expect(
      (
        await persistence.save(LOCAL_ENVIRONMENT_ID, [
          {
            id: "standalone-persisted-followup",
            environmentId: LOCAL_ENVIRONMENT_ID,
            threadId: THREAD_ID,
            promptText: "Continue standalone history",
            images: [],
            files: [],
            provider: ProviderDriverKind.make("codex"),
            model: "gpt-5",
            promptEffort: null,
            modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5"),
            runtimeMode: "approval-required",
            interactionMode: "default",
            queuedAt: isoAt(1000),
            blockedReason: null,
          },
        ])
      ).ok,
    ).toBe(true);
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
      resolveRpc: (body) =>
        body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand ? { sequence: 2 } : undefined,
    });
    try {
      await vi.waitFor(
        () =>
          expect(
            wsRequests.find(
              (body) =>
                body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                body.type === "thread.turn.start",
            ),
          ).toMatchObject({
            threadId: THREAD_ID,
            message: { text: "Continue standalone history" },
          }),
        { timeout: 8_000, interval: 16 },
      );
      expect(document.body.textContent).not.toContain("Project metadata is not loaded yet");
    } finally {
      await mounted.cleanup();
    }
  });

  it("retains standalone content when an older owner server omits the capability", async () => {
    const draftId = DraftId.make("unsupported-server-draft");
    useComposerDraftStore
      .getState()
      .createStandaloneDraftSession(draftId, LOCAL_ENVIRONMENT_ID, THREAD_ID);
    useComposerDraftStore.getState().setPrompt(draftId, "Preserve until server update");
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createProjectlessSnapshot(),
      initialPath: `/draft/${draftId}`,
      configureFixture: (next) => {
        configureStandaloneShortcut(next);
        next.serverConfig = {
          ...next.serverConfig,
          environment: {
            ...next.serverConfig.environment,
            capabilities: { repositoryIdentity: true },
          },
        };
        next.welcome = {
          ...next.welcome,
          environment: {
            ...next.welcome.environment,
            capabilities: { repositoryIdentity: true },
          },
        };
      },
    });
    try {
      await waitForStandaloneComposerText("Preserve until server update");
      (await waitForSendButton()).click();
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain(
          "Update the server to send messages in standalone chats",
        ),
      );
      expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
        "Preserve until server update",
      );
      expect(
        wsRequests.some((body) => body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand),
      ).toBe(false);
      newChatShortcut();
      await waitForLayout();
      expect(Object.keys(useComposerDraftStore.getState().draftThreadsByThreadKey)).toEqual([
        draftId,
      ]);
    } finally {
      await mounted.cleanup();
    }
  });
});
