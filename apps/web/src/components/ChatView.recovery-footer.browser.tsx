// This file owns only its feature journeys; the shared module owns fixture lifecycle.
import {
  registerChatViewBrowserHooks,
  THREAD_ID,
  THREAD_REF,
  wsRequests,
  WIDE_FOOTER_VIEWPORT,
  isoAt,
  SUBAGENT_RUNTIME_ID,
  waitForElement,
  waitForComposerEditor,
  waitForSendButton,
  mountChatView,
  createSnapshotWithActiveSubagent,
} from "./ChatViewBrowser.shared";
import {
  EventId,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationReadModel,
  ProviderInstanceId,
} from "@cafecode/contracts";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { type NormalizedWsRpcRequestBody } from "../../test/wsRpcHarness";
import { useComposerDraftStore } from "../composerDraftStore";
import { selectThreadByRef, useStore } from "../store";
import { toastManager } from "./ui/toast";

describe("ChatView full app (recovery-footer)", () => {
  registerChatViewBrowserHooks();

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

  it("keeps a persisted provider failure discoverable in the Work Log without clearing canonical error state", async () => {
    const base = snapshotWithTerminalRoot("agents");
    const source = base.threads[0]!;
    const failure = source.session!.lastError!;
    const hash = async (value: string) =>
      Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
    const providerErrorHash = await hash(failure);
    const providerErrorOwnerHash = await hash(
      JSON.stringify([
        source.id,
        source.latestTurn!.turnId,
        source.session!.providerInstanceId,
        source.session!.subagentRuntimeId,
      ]),
    );
    const activityId = EventId.make("persisted-provider-error-exact-occurrence");
    const privateMessage = "Private synthetic received error details";
    const privateJson = JSON.stringify({
      error: { message: privateMessage, code: "synthetic_503" },
    });
    const snapshot: OrchestrationReadModel = {
      ...base,
      threads: [
        {
          ...source,
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
          ],
        },
      ],
    };
    const detailRequests: NormalizedWsRpcRequestBody[] = [];
    const toastSpy = vi.spyOn(toastManager, "add");
    const mounted = await mountChatView({
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
      await waitForComposerEditor();
      await vi.waitFor(() => {
        expect(errorBanner()).toBeNull();
        expect(document.querySelector('[data-work-log-provider-errors="true"]')?.textContent).toBe(
          "Provider error · 1",
        );
      });
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
      await expect.element(inspect).toHaveAttribute("aria-expanded", "false");
      await inspect.click();
      await expect.element(page.getByText(privateMessage, { exact: true })).toBeVisible();
      expect(detailRequests).toHaveLength(1);
      expect(detailRequests[0]).toMatchObject({
        threadId: THREAD_ID,
        turnId: source.latestTurn!.turnId,
        activityId,
      });
      // Raw JSON stays behind the explicit Technical details disclosure.
      expect(document.querySelector("[data-provider-diagnostic-json]")).toBeNull();
      await page.getByRole("button", { name: "Technical details", exact: true }).click();
      await vi.waitFor(() => {
        expect(document.querySelector("[data-provider-diagnostic-json]")?.textContent).toBe(
          privateJson,
        );
      });
      await inspect.click();
      expect(document.querySelector("[data-provider-diagnostic-json]")).toBeNull();
      expect(document.body.textContent).not.toContain(privateMessage);
      expect(selectThreadByRef(useStore.getState(), THREAD_REF)?.error).toBe(failure);
      expect(selectThreadByRef(useStore.getState(), THREAD_REF)?.latestTurn).toEqual(
        source.latestTurn,
      );
    } finally {
      await mounted.cleanup();
      toastSpy.mockRestore();
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
