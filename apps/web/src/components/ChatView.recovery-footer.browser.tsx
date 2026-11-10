// This file owns only its feature journeys; the shared module owns fixture lifecycle.
import {
  registerChatViewBrowserHooks,
  chatViewFixture,
  rpcHarness,
  THREAD_ID,
  THREAD_REF,
  wsRequests,
  WIDE_FOOTER_VIEWPORT,
  COMPACT_FOOTER_VIEWPORT,
  isoAt,
  SUBAGENT_RUNTIME_ID,
  waitForElement,
  waitForComposerEditor,
  waitForSendButton,
  mountChatView,
  createSnapshotWithActiveSubagent,
  toShellThread,
} from "./ChatViewBrowser.shared";
import {
  EventId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationReadModel,
  ProviderInstanceId,
  SubagentRuntimeId,
} from "@cafecode/contracts";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { type NormalizedWsRpcRequestBody } from "../../test/wsRpcHarness";
import { useComposerDraftStore } from "../composerDraftStore";
import { selectSidebarThreadSummaryByRef, selectThreadByRef, useStore } from "../store";
import { toastManager } from "./ui/toast";
import { createChatViewCallerOwner } from "./chatViewCallerOwner.test.fixture";

describe("ChatView full app (recovery-footer)", () => {
  registerChatViewBrowserHooks();

  const snapshotWithClaudeBackgroundWork = (withTool = true): OrchestrationReadModel => {
    const base = createSnapshotWithActiveSubagent();
    return {
      ...base,
      threads: base.threads.map((thread) => ({
        ...thread,
        latestTurn: { ...thread.latestTurn!, state: "completed", completedAt: isoAt(1_010) },
        // The selected model may already be Sol while this native Claude
        // owner still has work. Stop follows the owner, not the model picker.
        session: {
          ...thread.session!,
          providerName: "claudeAgent",
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          status: "interrupted",
          activeTurnId: null,
          updatedAt: isoAt(1_010),
        },
        activities: withTool
          ? [
              {
                id: EventId.make("claude-background-only-command"),
                kind: "tool.started",
                tone: "tool",
                summary: "Shell command",
                turnId: thread.latestTurn!.turnId,
                createdAt: isoAt(1_005),
                sequence: 1,
                payload: {
                  itemId: "native-tool-without-task-id",
                  itemType: "command_execution",
                  detail: "Bash: inspect the project",
                  individualTaskControl: {
                    taskId: "server-background-reference",
                    runtimeId: SUBAGENT_RUNTIME_ID,
                    capability: {
                      providerInstanceId: "claudeAgent",
                      taskGeneration: "00000000-0000-4000-8000-000000000002",
                      canStop: false,
                      canBackground: true,
                    },
                  },
                },
              },
            ]
          : [],
      })),
    };
  };

  it.for([WIDE_FOOTER_VIEWPORT, COMPACT_FOOTER_VIEWPORT])(
    "keeps whole-chat Stop usable after Claude's root ends in the $name composer",
    async (viewport, context) => {
      const owner = createChatViewCallerOwner(context, mountChatView, {
        label: "composer-opening-stop",
      });
      await owner.run(async () => {
        const snapshot = snapshotWithClaudeBackgroundWork();
        await owner.mount({
          viewport,
          snapshot,
          resolveRpc: (body) =>
            body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand
              ? { sequence: snapshot.snapshotSequence + 1 }
              : undefined,
        });
        await owner.own("editor", () => waitForComposerEditor());
        const stop = page.getByRole("button", { name: "Stop", exact: true });
        await owner.own("controls", () => expect.element(stop).toBeEnabled());
        await owner.own("prompt", () =>
          expect
            .element(page.getByText("Background work running · 1 task", { exact: true }))
            .toBeVisible(),
        );
        owner.assertActive();
        useComposerDraftStore.getState().setPrompt(THREAD_REF, "Keep this unsent instruction");
        await owner.own("prompt", () =>
          expect
            .element(page.getByTestId("composer-editor"))
            .toHaveTextContent("Keep this unsent instruction"),
        );
        await owner.own("controls", () => expect.element(stop).toBeEnabled());
        await owner.own("controls", () =>
          expect
            .element(page.getByRole("button", { name: "Send message", exact: true }))
            .toBeEnabled(),
        );
        expect(document.querySelector('button[aria-label="Queue message"]')).toBeNull();
        await owner.own("input", () => stop.click());
        await owner.own("request", () =>
          vi.waitFor(() => {
            const actions = wsRequests.filter(
              (request) => request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand,
            );
            expect(actions.filter((request) => request.type === "thread.session.stop")).toEqual([
              expect.objectContaining({ threadId: THREAD_ID }),
            ]);
            expect(
              actions.some(
                (request) =>
                  request.type === "thread.turn.start" || request.type === "thread.turn.interrupt",
              ),
            ).toBe(false);
          }),
        );
        // A command ACK cannot complete the root's remaining work, discard the
        // draft, or invent a new turn. Native session retirement clears it.
        expect(selectThreadByRef(useStore.getState(), THREAD_REF)?.latestTurn).toEqual(
          snapshot.threads[0]!.latestTurn,
        );
        expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(
          "Keep this unsent instruction",
        );
        await owner.own("prompt", () =>
          expect
            .element(page.getByText("Background work running · 1 task", { exact: true }))
            .toBeVisible(),
        );
      });
    },
  );

  it("offers Stop from current shell-only work and retracts it on a zero or foreign-runtime observation", async (context) => {
    const owner = createChatViewCallerOwner(context, mountChatView, {
      label: "composer-opening-stop",
    });
    await owner.run(async () => {
      const snapshot = snapshotWithClaudeBackgroundWork(false);
      await owner.mount({ viewport: WIDE_FOOTER_VIEWPORT, snapshot });
      await owner.own("editor", () => waitForComposerEditor());
      const stop = page.getByRole("button", { name: "Stop", exact: true });
      await owner.own("controls", () => expect.element(stop).not.toBeInTheDocument());
      let sequence = snapshot.snapshotSequence;
      for (const [runtimeId, taskCount, visible] of [
        [SUBAGENT_RUNTIME_ID, 1, true],
        [SUBAGENT_RUNTIME_ID, 0, false],
        ["b73284bf-01be-4dbf-94c8-b54e54f17802", 1, false],
      ] as const) {
        owner.assertActive();
        const liveWork = { runtimeId: SubagentRuntimeId.make(runtimeId), taskCount, agentCount: 0 };
        rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeShell, {
          kind: "thread-upserted",
          sequence: ++sequence,
          thread: { ...toShellThread(snapshot.threads[0]!), liveWork },
        });
        await owner.own("snapshot", () =>
          vi.waitFor(() => {
            expect(
              selectSidebarThreadSummaryByRef(useStore.getState(), THREAD_REF)?.liveWork,
            ).toEqual(liveWork);
          }),
        );
        await owner.own("controls", () =>
          visible
            ? expect.element(stop).toBeEnabled()
            : expect.element(stop).not.toBeInTheDocument(),
        );
      }
      expect(wsRequests.some((request) => request.type === "thread.session.stop")).toBe(false);
    });
  });

  it("keeps the native Tasks roster and warning aligned with exact-runtime source hints", async (context) => {
    const owner = createChatViewCallerOwner(context, mountChatView, {
      label: "subagent-owner-release",
    });
    await owner.run(async () => {
      const base = createSnapshotWithActiveSubagent();
      const source = base.threads.find((thread) => thread.id === THREAD_ID)!;
      const first = source.activities[0]!;
      const firstPayload = first.payload as Record<string, unknown>;
      const firstChild = firstPayload.subagent as Record<string, unknown>;
      if (typeof firstPayload.taskId !== "string")
        throw new Error("Synthetic native task identity missing");
      const firstId = firstPayload.taskId;
      const secondId = "provider-child-independent-audit";
      const snapshot: OrchestrationReadModel = {
        ...base,
        threads: base.threads.map((thread) =>
          thread.id !== THREAD_ID
            ? thread
            : {
                ...thread,
                activities: [
                  ...thread.activities,
                  {
                    ...first,
                    id: EventId.make("activity-independent-subagent"),
                    sequence: 2,
                    payload: {
                      ...firstPayload,
                      taskId: secondId,
                      subagent: {
                        ...firstChild,
                        threadId: secondId,
                        label: "Independent lifecycle audit",
                      },
                    },
                  },
                ],
              },
        ),
      };
      await owner.mount({ viewport: WIDE_FOOTER_VIEWPORT, snapshot });
      await owner.own("editor", () => waitForComposerEditor());
      let sequence = snapshot.snapshotSequence;
      const publish = async (
        runtimeId: string,
        agentCount: number,
        unconfirmedAgentIds: string[],
      ) => {
        owner.assertActive();
        const liveWork = {
          runtimeId: SubagentRuntimeId.make(runtimeId),
          taskCount: agentCount,
          agentCount,
          unconfirmedAgentIds,
          unconfirmedAgentIdsTruncated: false,
        };
        rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeShell, {
          kind: "thread-upserted",
          sequence: ++sequence,
          thread: { ...toShellThread(source), liveWork },
        });
        await owner.own("snapshot", () =>
          vi.waitFor(() => {
            owner.assertActive();
            expect(
              selectSidebarThreadSummaryByRef(useStore.getState(), THREAD_REF)?.liveWork,
            ).toEqual(liveWork);
          }),
        );
      };
      const counter = (count: number) =>
        page.getByRole("button", {
          name: `${count} active subagent${count === 1 ? "" : "s"}. Show task list`,
          exact: true,
        });
      const roster = page.getByRole("region", { name: "Active subagents" });
      const firstRow = roster.getByRole("button", { name: /^Browser lifecycle audit, Working\./ });
      const secondRow = roster.getByRole("button", {
        name: /^Independent lifecycle audit, Working\./,
      });
      const warning = page.getByText("Some agent status information is unavailable.", {
        exact: true,
      });
      await publish(SUBAGENT_RUNTIME_ID, 2, []);
      await owner.own("controls", () => counter(2).click());
      await owner.own("rail", () => expect.element(firstRow).toBeVisible());
      await owner.own("rail", () => expect.element(secondRow).toBeVisible());

      // A shell observation from another native runtime has no authority over
      // the current worker roster or its uncertainty warning.
      await publish("b73284bf-01be-4dbf-94c8-b54e54f17802", 1, [firstId]);
      await owner.own("rail", () => expect.element(counter(2)).toBeVisible());
      await owner.own("rail", () => expect.element(firstRow).toBeVisible());
      await owner.own("prompt", () => expect.element(warning).not.toBeInTheDocument());

      await publish(SUBAGENT_RUNTIME_ID, 1, [firstId]);
      await owner.own("rail", () => expect.element(counter(1)).toBeVisible());
      await owner.own("rail", () => expect.element(firstRow).not.toBeInTheDocument());
      await owner.own("rail", () => expect.element(secondRow).toBeVisible());
      await owner.own("prompt", () => expect.element(warning).toBeVisible());

      await publish(SUBAGENT_RUNTIME_ID, 2, []);
      await owner.own("rail", () => expect.element(counter(2)).toBeVisible());
      await owner.own("rail", () => expect.element(firstRow).toBeVisible());
      await owner.own("rail", () => expect.element(secondRow).toBeVisible());
      await owner.own("prompt", () => expect.element(warning).not.toBeInTheDocument());
    });
  });

  it("shows pending-request omission only while the authoritative detail remains incomplete", async (context) => {
    const owner = createChatViewCallerOwner(context, mountChatView, {
      label: "composer-unanswered",
    });
    await owner.run(async () => {
      const base = createSnapshotWithActiveSubagent();
      await owner.mount({
        viewport: WIDE_FOOTER_VIEWPORT,
        snapshot: {
          ...base,
          threads: base.threads.map((thread) => ({
            ...thread,
            pendingRequestRetentionTruncated: false,
          })),
        },
      });
      await owner.own("editor", () => waitForComposerEditor());
      const warning = page.getByText("Some pending requests are not shown.", { exact: true });
      await owner.own("prompt", () => expect.element(warning).not.toBeInTheDocument());

      for (const incomplete of [true, false]) {
        owner.assertActive();
        const current = chatViewFixture.fixture.snapshot;
        const snapshotSequence = current.snapshotSequence + 1;
        const thread = {
          ...current.threads.find((candidate) => candidate.id === THREAD_ID)!,
          pendingRequestRetentionTruncated: incomplete,
        };
        chatViewFixture.fixture.snapshot = {
          ...current,
          snapshotSequence,
          threads: current.threads.map((candidate) =>
            candidate.id === THREAD_ID ? thread : candidate,
          ),
        };
        // Use the ordinary authoritative detail stream, rather than writing
        // the store or component state that owns the warning directly.
        rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
          kind: "snapshot",
          snapshot: { snapshotSequence, thread },
        });
        await owner.own("snapshot", () =>
          vi.waitFor(() => {
            owner.assertActive();
            expect(
              selectThreadByRef(useStore.getState(), THREAD_REF)?.pendingRequestRetentionTruncated,
            ).toBe(incomplete);
          }),
        );
        await owner.own("prompt", () =>
          incomplete
            ? expect.element(warning).toBeVisible()
            : expect.element(warning).not.toBeInTheDocument(),
        );
      }
    });
  });

  const snapshotWithTerminalRoot = (
    mode: "retry" | "agents" | "uncertain" | "foreign" | "cancelled",
  ): OrchestrationReadModel => {
    const base = createSnapshotWithActiveSubagent();
    const failedAt = isoAt(1_010);
    return {
      ...base,
      threads: base.threads.map((thread) => {
        if (thread.id !== THREAD_ID) return thread;
        const turnId = thread.latestTurn!.turnId;
        const childRows =
          mode === "uncertain" || mode === "cancelled"
            ? []
            : thread.activities.map((row) =>
                mode !== "foreign"
                  ? row
                  : {
                      ...row,
                      payload: {
                        ...(row.payload as Record<string, unknown>),
                        subagent: {
                          ...((row.payload as Record<string, unknown>).subagent as object),
                          runtimeId: "b73284bf-01be-4dbf-94c8-b54e54f17802",
                        },
                      },
                    },
              );
        return {
          ...thread,
          latestTurn: { ...thread.latestTurn!, state: "error", completedAt: failedAt },
          session: {
            ...thread.session!,
            status: "ready",
            activeTurnId: null,
            providerInstanceId: ProviderInstanceId.make("codex"),
            updatedAt: failedAt,
            lastError: "Synthetic transient root failure",
          },
          activities: [
            ...childRows,
            {
              id: EventId.make("root-footer-command"),
              kind: "tool.completed",
              tone: "tool",
              summary: "Ran command",
              turnId,
              sequence: 2,
              createdAt: isoAt(1_009),
              payload: {
                itemId: "finished-command",
                itemType: "command_execution",
                status: "completed",
              },
            },
            ...(mode === "agents"
              ? []
              : [
                  {
                    id: EventId.make("root-footer-recovery"),
                    kind: "runtime.warning",
                    tone: "info" as const,
                    summary: "Recovery metadata",
                    turnId,
                    sequence: 3,
                    createdAt: failedAt,
                    payload: {
                      recovery:
                        mode === "uncertain"
                          ? "codex-transient-recovery-uncertain"
                          : mode === "cancelled"
                            ? "codex-transient-recovery-cancelled"
                            : "codex-transient-recovery-waiting",
                      providerInstanceId: mode === "foreign" ? "foreign-account" : "codex",
                      subagentRuntimeId: SUBAGENT_RUNTIME_ID,
                      sessionUpdatedAt: failedAt,
                      ...(mode === "uncertain" || mode === "cancelled"
                        ? {}
                        : {
                            stage: "backoff",
                            retryAttempt: 3,
                            continuationOrdinal: 37,
                            retryAt: isoAt(1_055),
                          }),
                    },
                  },
                ]),
          ],
        };
      }),
    };
  };

  it("keeps a persisted provider failure discoverable in the Work Log without clearing canonical error state", async (context) => {
    let restoreToastSpy: (() => void) | undefined;
    const owner = createChatViewCallerOwner(context, mountChatView, {
      label: "recovery-diagnostic-visibility",
      afterUnmount: () => restoreToastSpy?.(),
    });
    const base = snapshotWithTerminalRoot("agents");
    const source = base.threads[0]!;
    const failure = source.session!.lastError!;
    const hash = async (value: string) =>
      Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
    const providerErrorHash = await owner.own("config", () => hash(failure));
    const providerErrorOwnerHash = await owner.own("config", () =>
      hash(
        JSON.stringify([
          source.id,
          source.latestTurn!.turnId,
          source.session!.providerInstanceId,
          source.session!.subagentRuntimeId,
        ]),
      ),
    );
    const activityId = EventId.make("persisted-provider-error-exact-occurrence");
    const privateMessage = "Private synthetic received error details";
    const privateJson = JSON.stringify({
      error: { message: privateMessage, code: "synthetic_503" },
    });
    const unstartedAt = isoAt(1_011);
    const privateStartFailure = "Private synthetic legacy start failure";
    const snapshot: OrchestrationReadModel = {
      ...base,
      threads: [
        {
          ...source,
          messages: [
            ...source.messages,
            {
              id: MessageId.make("accepted-unstarted-recovery-message"),
              role: "user",
              text: "Keep this accepted message visible",
              turnId: null,
              streaming: false,
              createdAt: unstartedAt,
              updatedAt: unstartedAt,
            },
          ],
          activities: [
            ...source.activities,
            {
              id: activityId,
              kind: "runtime.error",
              tone: "error",
              summary: "Provider error",
              turnId: source.latestTurn!.turnId,
              sequence: 3,
              createdAt: source.session!.updatedAt,
              payload: {
                providerDiagnostic: { version: 1, status: "error", subject: { kind: "root" } },
                providerErrorHash,
                providerErrorOwnerHash,
              },
            },
            {
              id: EventId.make("legacy-unstarted-recovery-failure"),
              kind: "provider.turn.start.failed",
              tone: "error",
              summary: "Provider turn start failed",
              turnId: null,
              sequence: 4,
              createdAt: unstartedAt,
              payload: { detail: privateStartFailure },
            },
          ],
        },
      ],
    };
    const detailRequests: NormalizedWsRpcRequestBody[] = [];
    const toastSpy = vi.spyOn(toastManager, "add");
    restoreToastSpy = () => toastSpy.mockRestore();
    await owner.mount({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot,
      resolveRpc: (body) => {
        if (body._tag !== ORCHESTRATION_WS_METHODS.getThreadActivityDiagnostic) return undefined;
        detailRequests.push(body);
        return {
          threadId: body.threadId,
          turnId: body.turnId,
          activityId: body.activityId,
          diagnostic: {
            version: 1,
            observedAt: source.session!.updatedAt,
            source: "codex.error",
            native: { eventId: "synthetic-private-receipt" },
            message: privateMessage,
            json: privateJson,
            redacted: false,
            truncated: false,
            omittedFields: false,
          },
        };
      },
    });
    const errorBanner = () =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-slot="alert"]')).find((element) =>
        element.textContent?.includes(failure),
      ) ?? null;
    try {
      await owner.own("editor", () => waitForComposerEditor());
      await owner.own("work-log", () =>
        vi.waitFor(() => {
          expect(errorBanner()).toBeNull();
          expect(
            document.querySelector('[data-work-log-provider-errors="true"]')?.textContent,
          ).toBe("Provider error · 1");
        }),
      );
      // Exercise ChatView's real main-work-log memo and ordinary row renderer:
      // the accepted message and its failed start have no provider TurnId.
      await owner.own("work-log", () =>
        expect
          .element(page.getByRole("button", { name: "Provider turn start failed", exact: true }))
          .toBeVisible(),
      );
      expect(document.body.textContent).not.toContain(privateStartFailure);
      expect(detailRequests).toHaveLength(0);
      expect(document.body.textContent).not.toContain(privateMessage);
      expect(document.querySelector("[data-provider-diagnostic-json]")).toBeNull();
      expect(toastSpy.mock.calls.some(([options]) => options.description === failure)).toBe(false);
      expect(selectThreadByRef(useStore.getState(), THREAD_REF)?.error).toBe(failure);
      expect(selectThreadByRef(useStore.getState(), THREAD_REF)?.latestTurn).toEqual(
        source.latestTurn,
      );
      const inspect = page.getByRole("button", {
        name: "Inspect provider diagnostic: Root · Provider error",
        exact: true,
      });
      await owner.own("work-log", () =>
        expect.element(inspect).toHaveAttribute("aria-expanded", "false"),
      );
      await owner.own("controls", () => inspect.click());
      await owner.own("receipt", () =>
        expect.element(page.getByText(privateMessage, { exact: true })).toBeVisible(),
      );
      expect(detailRequests).toHaveLength(1);
      expect(detailRequests[0]).toMatchObject({
        threadId: THREAD_ID,
        turnId: source.latestTurn!.turnId,
        activityId,
      });
      // Raw JSON stays behind the explicit Technical details disclosure.
      expect(document.querySelector("[data-provider-diagnostic-json]")).toBeNull();
      await owner.own("controls", () =>
        page.getByRole("button", { name: "Technical details", exact: true }).click(),
      );
      await owner.own("receipt", () =>
        vi.waitFor(() => {
          expect(document.querySelector("[data-provider-diagnostic-json]")?.textContent).toBe(
            privateJson,
          );
        }),
      );
      await owner.own("controls", () => inspect.click());
      expect(document.querySelector("[data-provider-diagnostic-json]")).toBeNull();
      expect(document.body.textContent).not.toContain(privateMessage);
      expect(selectThreadByRef(useStore.getState(), THREAD_REF)?.error).toBe(failure);
      expect(selectThreadByRef(useStore.getState(), THREAD_REF)?.latestTurn).toEqual(
        source.latestTurn,
      );
    } finally {
      await owner.cleanup();
    }
  });

  it("reveals elapsed time from the exact running root through the real composer", async () => {
    const base = createSnapshotWithActiveSubagent();
    const startedAt = new Date(Date.now() - 125_000).toISOString();
    const snapshot: OrchestrationReadModel = {
      ...base,
      threads: base.threads.map((thread) => ({
        ...thread,
        latestTurn: { ...thread.latestTurn!, startedAt },
      })),
    };
    const mounted = await mountChatView({ viewport: WIDE_FOOTER_VIEWPORT, snapshot });
    try {
      await waitForComposerEditor();
      const timer = await waitForElement(
        () => document.querySelector<HTMLElement>('[role="timer"][aria-label="Elapsed turn time"]'),
        "Running root elapsed timer missing",
      );
      const disclosure = timer.closest<HTMLElement>("[data-activity-elapsed-revealed]")!;
      expect(disclosure.getAttribute("data-activity-elapsed-revealed")).toBe("false");
      const status = timer.closest<HTMLButtonElement>("button")!;
      await page
        .getByRole("button", { name: status.getAttribute("aria-label")!, exact: true })
        .hover();
      await vi.waitFor(() => {
        expect(disclosure.getAttribute("data-activity-elapsed-revealed")).toBe("true");
        expect(timer.textContent).toMatch(/2m \d+s/);
      });
      expect(document.querySelector('button[aria-label="Stop generation"]')).not.toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it.each([
    ["retry", "Reconnecting · root 9s"],
    ["agents", "Agents running · root 9s"],
    ["uncertain", "Needs reconciliation · root 9s"],
  ] as const)(
    "keeps %s context visibly active and exposes the red composer Stop without reopening the root",
    async (mode, label) => {
      const snapshot = snapshotWithTerminalRoot(mode);
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
        // Independent agents and failed-root recovery are visible live work,
        // but cannot borrow the finished root's start for a running counter.
        expect(document.querySelector('[role="timer"][aria-label="Elapsed turn time"]')).toBeNull();
        await vi.waitFor(() =>
          expect(document.querySelector('[data-completion-divider="true"]')?.textContent).toContain(
            label,
          ),
        );
        const stop = page.getByRole("button", { name: "Stop recovery", exact: true });
        await expect.element(stop).toBeVisible();
        expect(stop.element().className).toContain("bg-destructive/90");
        await stop.click();
        await vi.waitFor(() => {
          const commands = wsRequests.filter(
            (request) => request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand,
          );
          expect(commands.filter((request) => request.type === "thread.session.stop")).toHaveLength(
            1,
          );
          expect(
            commands.some(
              (request) =>
                request.type === "thread.turn.start" || request.type === "thread.turn.interrupt",
            ),
          ).toBe(false);
        });
        expect(selectThreadByRef(useStore.getState(), THREAD_REF)?.latestTurn).toEqual(
          snapshot.threads[0]!.latestTurn,
        );
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it.each(["foreign", "cancelled"] as const)(
    "does not revive Stop or active footer from %s recovery evidence",
    async (mode) => {
      const snapshot = snapshotWithTerminalRoot(mode);
      const mounted = await mountChatView({ viewport: WIDE_FOOTER_VIEWPORT, snapshot });
      try {
        await waitForComposerEditor();
        await vi.waitFor(() =>
          expect(document.querySelector('[data-completion-divider="true"]')?.textContent).toContain(
            "Worked for 9s",
          ),
        );
        expect(document.querySelector('button[aria-label="Stop recovery"]')).toBeNull();
        expect((await waitForSendButton()).disabled).toBe(true);
        expect(
          wsRequests.some(
            (request) =>
              request.type === "thread.session.stop" || request.type === "thread.turn.start",
          ),
        ).toBe(false);
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("keeps a terminal-root draft sendable as a new turn and never labels it a running-turn queue", async () => {
    const snapshot = snapshotWithTerminalRoot("retry");
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
      await expect
        .element(page.getByRole("button", { name: "Stop recovery", exact: true }))
        .toBeVisible();
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Take a new direction");
      const send = await waitForSendButton();
      expect(send.disabled).toBe(false);
      expect(document.querySelector('button[aria-label="Queue message"]')).toBeNull();
      send.click();
      await vi.waitFor(() => {
        const command = wsRequests.find((request) => request.type === "thread.turn.start");
        expect(command?.message).toMatchObject({ text: "Take a new direction" });
        expect(wsRequests.some((request) => request.type === "thread.session.stop")).toBe(false);
      });
    } finally {
      await mounted.cleanup();
    }
  });
});
