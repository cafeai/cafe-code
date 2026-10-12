import "../../index.css";

import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  type EnvironmentId,
  type ThreadId,
  type TurnId,
} from "@cafecode/contracts";
import { CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE } from "@cafecode/shared/codexHistorySafety";
import { CLAUDE_RESPONSE_LIMIT_MESSAGE } from "@cafecode/shared/claudeResponseLimits";

vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({
    persistence: {
      getClientSettings: async () => null,
      setClientSettings: async () => {},
    },
  }),
  readLocalApi: () => undefined,
}));

import { __resetClientSettingsPersistenceForTests } from "../../hooks/useSettings";
import { getClientSettingsSnapshot } from "../../hooks/clientSettingsState";
import { resetServerStateForTests } from "../../rpc/serverState";
import { selectEnvironmentState, useStore } from "../../store";
import type { SidebarThreadSummary } from "../../types";

import { ThreadErrorBanner } from "./ThreadErrorBanner";
import { selectAtriumSnapshot } from "../atrium/taskAtriumData";

const ENV = "local" as EnvironmentId;
const THREAD = "thread-1" as ThreadId;
const REMOTE = "remote" as EnvironmentId;
const FIRST_FAILURE = "2026-10-06T12:00:00.000Z";
const LATER_FAILURE = "2026-10-06T13:00:00.000Z";

beforeEach(() => {
  resetServerStateForTests();
  __resetClientSettingsPersistenceForTests();
  useStore.setState({ environmentStateById: {} });
});

function seedFailure(
  environmentId: EnvironmentId,
  observedAt: string,
  turnId?: TurnId,
  threadId: ThreadId = THREAD,
  diagnostic?: string,
) {
  const summary: SidebarThreadSummary = {
    id: threadId,
    environmentId,
    projectId: null,
    title: "Synthetic provider failure",
    interactionMode: "default",
    session: {
      provider: ProviderDriverKind.make("codex"),
      status: "error",
      orchestrationStatus: "error",
      activeTurnId: turnId,
      createdAt: FIRST_FAILURE,
      updatedAt: observedAt,
      ...(diagnostic !== undefined ? { lastError: diagnostic } : {}),
    },
    createdAt: FIRST_FAILURE,
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
  useStore.setState((state) => ({
    environmentStateById: {
      ...state.environmentStateById,
      [environmentId]: {
        ...selectEnvironmentState(state, environmentId),
        threadIds: [
          ...new Set([...selectEnvironmentState(state, environmentId).threadIds, threadId]),
        ],
        sidebarThreadSummaryById: {
          ...selectEnvironmentState(state, environmentId).sidebarThreadSummaryById,
          [threadId]: summary,
        },
        threadSessionById: {
          ...selectEnvironmentState(state, environmentId).threadSessionById,
          [threadId]: summary.session,
        },
        threadShellById: {
          ...selectEnvironmentState(state, environmentId).threadShellById,
          [threadId]: {
            id: threadId,
            environmentId,
            codexThreadId: null,
            projectId: null,
            title: summary.title,
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
            runtimeMode: "approval-required",
            interactionMode: "default",
            error: diagnostic ?? null,
            errorOrigin: "provider",
            createdAt: FIRST_FAILURE,
            archivedAt: null,
            branch: null,
            worktreePath: null,
          },
        },
      },
    },
  }));
}

function StoreThreadErrorBanner({ mountKey }: { mountKey: string }) {
  const error = useStore(
    (state) => state.environmentStateById[ENV]?.threadShellById[THREAD]?.error ?? null,
  );
  const errorOrigin = useStore(
    (state) => state.environmentStateById[ENV]?.threadShellById[THREAD]?.errorOrigin,
  );
  return (
    <ThreadErrorBanner
      key={mountKey}
      error={error}
      errorOrigin={errorOrigin}
      scopeKey={`${ENV}/${THREAD}`}
      environmentId={ENV}
      threadId={THREAD}
    />
  );
}

function seedClaudeResponseLimitFailure() {
  seedFailure(ENV, FIRST_FAILURE, undefined, THREAD, CLAUDE_RESPONSE_LIMIT_MESSAGE);
  useStore.setState((state) => {
    const environment = selectEnvironmentState(state, ENV);
    const summary = environment.sidebarThreadSummaryById[THREAD]!;
    const session = {
      ...summary.session!,
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    };
    return {
      environmentStateById: {
        ...state.environmentStateById,
        [ENV]: {
          ...environment,
          threadSessionById: { ...environment.threadSessionById, [THREAD]: session },
          sidebarThreadSummaryById: {
            ...environment.sidebarThreadSummaryById,
            [THREAD]: {
              ...summary,
              session,
              latestTurn: {
                turnId: "claude-failed-turn" as TurnId,
                state: "error",
                requestedAt: FIRST_FAILURE,
                startedAt: FIRST_FAILURE,
                completedAt: FIRST_FAILURE,
                assistantMessageId: null,
              },
            },
          },
        },
      },
    };
  });
}

describe("ThreadErrorBanner", () => {
  it.each(["provider", "unknown"] as const)(
    "keeps private provider prose out of the DOM through late hydration and remounts for %s origin",
    async (origin) => {
      const requestId = "synthetic-private-request-id-0d64c4e2";
      const error =
        "stream disconnected before completion: An error occurred while processing your request. " +
        "You can retry your request, or contact us through our help center at help.openai.com " +
        `if the error persists. Please include the request ID ${requestId} in your message.`;
      const banner = (key: string, duplicateLocalCatch = false) => (
        <ThreadErrorBanner
          key={key}
          error={error}
          errorOrigin={
            duplicateLocalCatch ? "local" : origin === "provider" ? "provider" : undefined
          }
          scopeKey={`${ENV}/${THREAD}`}
          environmentId={ENV}
          threadId={THREAD}
        />
      );
      const screen = await render(banner("before-hydration"));
      try {
        await expect.element(page.getByText(error)).not.toBeInTheDocument();
        await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
        expect(document.body.textContent).not.toContain(requestId);
        expect(
          [...document.querySelectorAll("[title]")].map((element) => element.getAttribute("title")),
        ).not.toContain(error);
        expect(getClientSettingsSnapshot().dismissedTaskAtriumErrors).toEqual([]);

        // This fixture deliberately has no runtime id, latest turn or Work Log
        // witness. Privacy cannot depend on those independently hydrated slices.
        seedFailure(ENV, FIRST_FAILURE, undefined, THREAD, error);
        await screen.rerender(banner("after-hydration"));
        await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
        await expect.element(page.getByLabelText("Dismiss error")).not.toBeInTheDocument();
        expect(document.body.textContent).not.toContain(requestId);
        const environment = useStore.getState().environmentStateById[ENV]!;
        expect(environment.threadShellById[THREAD]?.error).toBe(error);
        expect(environment.threadSessionById[THREAD]?.lastError).toBe(error);
        expect(environment.sidebarThreadSummaryById[THREAD]?.latestTurn).toBeNull();
        expect(environment.threadSessionById[THREAD]?.subagentRuntimeId).toBeUndefined();
        expect(
          selectAtriumSnapshot(useStore.getState(), Date.parse(FIRST_FAILURE), [], ENV).errorCount,
        ).toBe(1);

        await screen.rerender(banner("duplicate-local-catch", true));
        await expect.element(page.getByText(error)).not.toBeInTheDocument();
        await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
        seedFailure(ENV, LATER_FAILURE, "later-native-turn" as TurnId, THREAD, error);
        await screen.rerender(banner("later-failure-remount"));
        await expect.element(page.getByText(error)).not.toBeInTheDocument();
        await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
        expect(getClientSettingsSnapshot().dismissedTaskAtriumErrors).toEqual([]);
        expect(
          useStore.getState().environmentStateById[ENV]!.threadSessionById[THREAD]?.lastError,
        ).toBe(error);
        expect(
          selectAtriumSnapshot(useStore.getState(), Date.parse(LATER_FAILURE), [], ENV).errorCount,
        ).toBe(1);
      } finally {
        await screen.unmount();
      }
    },
  );

  it("offers classified Claude draft preparation with explicit review guidance and no dismissal", async () => {
    seedClaudeResponseLimitFailure();
    const prepare = vi.fn();
    const props = {
      error: CLAUDE_RESPONSE_LIMIT_MESSAGE,
      scopeKey: "local/thread-1",
      environmentId: ENV,
      threadId: THREAD,
      onPrepareShorterResponse: prepare,
    };
    const screen = await render(<ThreadErrorBanner {...props} canPrepareShorterResponse />);
    try {
      await expect
        .element(page.getByText("Review effort, then send from the composer."))
        .toBeVisible();
      expect(prepare).not.toHaveBeenCalled();
      await page.getByRole("button", { name: "Prepare shorter response" }).click();
      expect(prepare).toHaveBeenCalledOnce();
      await expect.element(page.getByText(CLAUDE_RESPONSE_LIMIT_MESSAGE)).toBeVisible();
      expect(getClientSettingsSnapshot().dismissedTaskAtriumErrors).toEqual([]);
      await screen.rerender(<ThreadErrorBanner {...props} canPrepareShorterResponse={false} />);
      await expect
        .element(page.getByRole("button", { name: "Prepare shorter response" }))
        .toBeDisabled();
      expect(prepare).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });

  it("does not expose Claude preparation for lookalike, local or different-provider errors", async () => {
    seedClaudeResponseLimitFailure();
    const prepare = vi.fn();
    const props = {
      scopeKey: "local/thread-1",
      environmentId: ENV,
      threadId: THREAD,
      onPrepareShorterResponse: prepare,
      canPrepareShorterResponse: true,
    };
    const screen = await render(
      <ThreadErrorBanner {...props} error="Response exceeded 64000 tokens" />,
    );
    try {
      await expect
        .element(page.getByRole("button", { name: "Prepare shorter response" }))
        .not.toBeInTheDocument();
      await screen.rerender(
        <ThreadErrorBanner {...props} error={`${CLAUDE_RESPONSE_LIMIT_MESSAGE} extra`} />,
      );
      await expect
        .element(page.getByRole("button", { name: "Prepare shorter response" }))
        .not.toBeInTheDocument();
      seedFailure(ENV, LATER_FAILURE, undefined, THREAD, CLAUDE_RESPONSE_LIMIT_MESSAGE);
      await screen.rerender(<ThreadErrorBanner {...props} error={CLAUDE_RESPONSE_LIMIT_MESSAGE} />);
      await expect
        .element(page.getByRole("button", { name: "Prepare shorter response" }))
        .not.toBeInTheDocument();
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
  it.each([{ turnId: undefined }, { turnId: "turn-1" as TurnId }])(
    "shows explicit local errors after remounting an acknowledged history failure on $turnId",
    async ({ turnId }) => {
      const error = CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE;
      seedFailure(ENV, FIRST_FAILURE, turnId, THREAD, error);
      const screen = await render(<StoreThreadErrorBanner mountKey="first" />);
      const threadRef = { environmentId: ENV, threadId: THREAD };
      try {
        await page.getByLabelText("Dismiss error").click();
        const savedDismissals = getClientSettingsSnapshot().dismissedTaskAtriumErrors;
        expect(savedDismissals).toHaveLength(1);
        await screen.rerender(<StoreThreadErrorBanner mountKey="remounted" />);
        await expect.element(page.getByText(error)).not.toBeInTheDocument();
        const session = useStore.getState().environmentStateById[ENV]!.threadSessionById[THREAD];
        useStore.getState().setError(threadRef, "The command was rejected.");
        await expect.element(page.getByText("The command was rejected.")).toBeVisible();
        expect(useStore.getState().environmentStateById[ENV]!.threadSessionById[THREAD]).toBe(
          session,
        );
        await page.getByLabelText("Dismiss error").click();
        expect(getClientSettingsSnapshot().dismissedTaskAtriumErrors).toEqual(savedDismissals);
        useStore.getState().setError(threadRef, "Another command failed.");
        await expect.element(page.getByText("Another command failed.")).toBeVisible();
        await screen.rerender(<StoreThreadErrorBanner mountKey="remounted-again" />);
        await expect.element(page.getByText("Another command failed.")).toBeVisible();
        useStore.getState().setError(threadRef, error);
        await expect.element(page.getByText(error)).not.toBeInTheDocument();
      } finally {
        await screen.unmount();
      }
    },
  );

  it("does not acknowledge a hidden provider failure when dismissing a local command rejection", async () => {
    const providerError = "Synthetic provider error";
    const threadRef = { environmentId: ENV, threadId: THREAD };
    seedFailure(ENV, FIRST_FAILURE, "turn-1" as TurnId, THREAD, providerError);
    useStore.getState().setError(threadRef, "The command was rejected.");
    const screen = await render(<StoreThreadErrorBanner mountKey="local" />);
    try {
      await page.getByLabelText("Dismiss error").click();
      expect(getClientSettingsSnapshot().dismissedTaskAtriumErrors).toEqual([]);
      useStore.getState().setError(threadRef, providerError);
      // A duplicate local catch cannot publish native provider prose when the
      // canonical session still identifies it as the provider's failure.
      await expect.element(page.getByText(providerError)).not.toBeInTheDocument();
      await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
      expect(getClientSettingsSnapshot().dismissedTaskAtriumErrors).toEqual([]);
      await screen.rerender(<StoreThreadErrorBanner mountKey="provider-remounted" />);
      await expect.element(page.getByText(providerError)).not.toBeInTheDocument();
      expect(
        selectAtriumSnapshot(useStore.getState(), Date.parse(FIRST_FAILURE), [], ENV).errorCount,
      ).toBe(1);
      expect(
        useStore.getState().environmentStateById[ENV]!.threadSessionById[THREAD]?.lastError,
      ).toBe(providerError);
    } finally {
      await screen.unmount();
    }
  });

  it("never displays Codex exit warnings or acknowledges current, later or other-server failures", async () => {
    const error = "Codex App Server exited unexpectedly.";
    const peer = "thread-2" as ThreadId;
    const unrelated = "thread-unrelated" as ThreadId;
    seedFailure(ENV, FIRST_FAILURE, undefined, THREAD, error);
    seedFailure(ENV, "2026-10-06T12:00:00.500Z", undefined, peer, error);
    seedFailure(ENV, FIRST_FAILURE, undefined, unrelated, "An unrelated authentication failure");
    seedFailure(REMOTE, FIRST_FAILURE, undefined, THREAD, error);
    const banner = (threadId: ThreadId, key: string, environmentId = ENV) => (
      <ThreadErrorBanner
        key={key}
        error={error}
        scopeKey={`${environmentId}/${threadId}`}
        environmentId={environmentId}
        threadId={threadId}
      />
    );
    const screen = await render(
      <>
        {banner(THREAD, "first")}
        {banner(peer, "peer")}
      </>,
    );
    try {
      await expect.element(page.getByText(error)).not.toBeInTheDocument();
      await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
      await expect.element(page.getByLabelText("Dismiss error")).not.toBeInTheDocument();
      const dismissed = getClientSettingsSnapshot().dismissedTaskAtriumErrors;
      expect(dismissed).toEqual([]);
      expect(
        selectAtriumSnapshot(useStore.getState(), Date.parse(FIRST_FAILURE), dismissed, ENV)
          .errorCount,
      ).toBe(3);
      await screen.rerender(banner(peer, "peer-remounted"));
      await expect.element(page.getByText(error)).not.toBeInTheDocument();
      seedFailure(ENV, LATER_FAILURE, undefined, peer, error);
      await expect.element(page.getByText(error)).not.toBeInTheDocument();
      await screen.rerender(banner(THREAD, "remote", REMOTE));
      await expect.element(page.getByText(error)).not.toBeInTheDocument();
      expect(
        selectAtriumSnapshot(useStore.getState(), Date.parse(LATER_FAILURE), [], REMOTE).errorCount,
      ).toBe(1);
      await screen.rerender(banner(THREAD, "local-return"));
      await expect.element(page.getByText(error)).not.toBeInTheDocument();
      expect(getClientSettingsSnapshot().dismissedTaskAtriumErrors).toEqual([]);
      expect(
        selectAtriumSnapshot(useStore.getState(), Date.parse(LATER_FAILURE), [], ENV).errorCount,
      ).toBe(3);
    } finally {
      await screen.unmount();
    }
  });

  it("retains ordinary failures shared by different chats without publishing or dismissing either", async () => {
    const error = "An ordinary provider failure";
    const peer = "thread-2" as ThreadId;
    seedFailure(ENV, FIRST_FAILURE, undefined, THREAD, error);
    seedFailure(ENV, FIRST_FAILURE, undefined, peer, error);
    const screen = await render(
      <ThreadErrorBanner
        error={error}
        scopeKey={`${ENV}/${THREAD}`}
        environmentId={ENV}
        threadId={THREAD}
      />,
    );
    try {
      await expect.element(page.getByText(error)).not.toBeInTheDocument();
      await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
      expect(getClientSettingsSnapshot().dismissedTaskAtriumErrors).toEqual([]);
      await screen.rerender(
        <ThreadErrorBanner
          key="peer"
          error={error}
          scopeKey={`${ENV}/${peer}`}
          environmentId={ENV}
          threadId={peer}
        />,
      );
      await expect.element(page.getByText(error)).not.toBeInTheDocument();
      expect(getClientSettingsSnapshot().dismissedTaskAtriumErrors).toEqual([]);
      expect(
        selectAtriumSnapshot(useStore.getState(), Date.parse(FIRST_FAILURE), [], ENV).errorCount,
      ).toBe(2);
    } finally {
      await screen.unmount();
    }
  });
  it("reads the saved dismissal after switching servers and remounting, without hiding another server's error", async () => {
    const error = CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE;
    seedFailure(ENV, FIRST_FAILURE, undefined, THREAD, error);
    seedFailure(REMOTE, FIRST_FAILURE, undefined, THREAD, error);
    const banner = (environmentId: EnvironmentId, key: string, diagnostic = error) => (
      <ThreadErrorBanner
        key={key}
        error={diagnostic}
        scopeKey={`${environmentId}/${THREAD}`}
        environmentId={environmentId}
        threadId={THREAD}
      />
    );
    const screen = await render(banner(ENV, "local-first"));
    try {
      await page.getByLabelText("Dismiss error").click();
      await expect.element(page.getByText(error)).not.toBeInTheDocument();
      expect(getClientSettingsSnapshot().dismissedTaskAtriumErrors).toEqual([
        { environmentId: ENV, threadId: THREAD, turnId: null, observedAt: FIRST_FAILURE },
      ]);
      await screen.rerender(banner(ENV, "local-first", "A different provider failure"));
      await expect.element(page.getByText("A different provider failure")).not.toBeInTheDocument();
      await screen.rerender(banner(ENV, "local-first"));
      await expect.element(page.getByText(error)).not.toBeInTheDocument();
      await screen.rerender(banner(REMOTE, "remote"));
      await expect.element(page.getByText(error)).toBeVisible();
      await screen.rerender(banner(ENV, "local-remounted"));
      await expect.element(page.getByText(error)).not.toBeInTheDocument();
      seedFailure(ENV, LATER_FAILURE, undefined, THREAD, error);
      await expect.element(page.getByText(error)).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("offers an explicit recovery action only for the fixed classified error", async () => {
    const recover = vi.fn(async () => {});
    const props = {
      scopeKey: "local/thread-1",
      environmentId: ENV,
      threadId: THREAD,
      canContinueInNewChat: true,
      onContinueInNewChat: recover,
    };
    const screen = await render(<ThreadErrorBanner {...props} error="Bad Request" />);
    try {
      await expect
        .element(page.getByRole("button", { name: "Continue in new chat" }))
        .not.toBeInTheDocument();
      await screen.rerender(
        <ThreadErrorBanner {...props} error={CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE} />,
      );
      await expect
        .element(page.getByRole("button", { name: "Continue in new chat" }))
        .toBeVisible();
      expect(recover).not.toHaveBeenCalled();
      await page.getByRole("button", { name: "Continue in new chat" }).click();
      expect(recover).toHaveBeenCalledOnce();
      await screen.rerender(
        <ThreadErrorBanner
          {...props}
          error={`${CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE} extra text`}
        />,
      );
      await expect
        .element(page.getByRole("button", { name: "Continue in new chat" }))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps a turn-bound dismissal stable through projection settling and shows the same error on a new turn", async () => {
    const error = CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE;
    seedFailure(ENV, FIRST_FAILURE, "turn-1" as TurnId, THREAD, error);
    const banner = (key: string) => (
      <ThreadErrorBanner
        key={key}
        error={error}
        scopeKey={`${ENV}/${THREAD}`}
        environmentId={ENV}
        threadId={THREAD}
      />
    );
    const screen = await render(banner("first"));
    try {
      await page.getByLabelText("Dismiss error").click();
      seedFailure(ENV, LATER_FAILURE, "turn-1" as TurnId, THREAD, error);
      await screen.rerender(banner("remounted"));
      await expect.element(page.getByText(error)).not.toBeInTheDocument();
      seedFailure(ENV, LATER_FAILURE, "turn-2" as TurnId, THREAD, error);
      await expect.element(page.getByText(error)).toBeVisible();
      await page.getByLabelText("Dismiss error").click();
      seedFailure(ENV, LATER_FAILURE, "turn-3" as TurnId, THREAD, error);
      await expect.element(page.getByText(error)).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("disables unavailable recovery and reports uncertainty without raw provider diagnostics", async () => {
    const recover = vi.fn(async () => {
      throw new Error("private native path and provider token");
    });
    const props = {
      scopeKey: "local/thread-1",
      environmentId: ENV,
      threadId: THREAD,
      error: CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE,
      onContinueInNewChat: recover,
    };
    const screen = await render(<ThreadErrorBanner {...props} canContinueInNewChat={false} />);
    try {
      await expect
        .element(page.getByRole("button", { name: "Continue in new chat" }))
        .toBeDisabled();
      expect(recover).not.toHaveBeenCalled();
      await screen.rerender(<ThreadErrorBanner {...props} canContinueInNewChat />);
      await page.getByRole("button", { name: "Continue in new chat" }).click();
      await expect
        .element(page.getByRole("status"))
        .toHaveTextContent(
          "Couldn't confirm the new chat. No prompt was sent — check your chat list before trying again.",
        );
      await expect
        .element(page.getByText("private native path and provider token"))
        .not.toBeInTheDocument();
      expect(recover).toHaveBeenCalledOnce();
      await screen.rerender(
        <ThreadErrorBanner {...props} scopeKey="remote/thread-2" canContinueInNewChat />,
      );
      await expect.element(page.getByRole("status")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps an explicit local validation error dismissed across snapshot-style rerenders", async () => {
    const staleError = "The requested attachment could not be added.";
    const screen = await render(
      <ThreadErrorBanner
        error={staleError}
        errorOrigin="local"
        scopeKey="local/thread-1"
        environmentId={ENV}
        threadId={THREAD}
      />,
    );

    try {
      await expect.element(page.getByText(staleError)).toBeVisible();
      await page.getByLabelText("Dismiss error").click();
      await expect.element(page.getByText(staleError)).not.toBeInTheDocument();

      await screen.rerender(
        <ThreadErrorBanner
          error={staleError}
          errorOrigin="local"
          scopeKey="local/thread-1"
          environmentId={ENV}
          threadId={THREAD}
        />,
      );
      await expect.element(page.getByText(staleError)).not.toBeInTheDocument();

      await screen.rerender(
        <ThreadErrorBanner
          error="Another local command was rejected."
          errorOrigin="local"
          scopeKey="local/thread-1"
          environmentId={ENV}
          threadId={THREAD}
        />,
      );
      await expect.element(page.getByText("Another local command was rejected.")).toBeVisible();

      await screen.rerender(
        <ThreadErrorBanner
          error={staleError}
          errorOrigin="local"
          scopeKey="remote/thread-1"
          environmentId={ENV}
          threadId={THREAD}
        />,
      );
      await expect.element(page.getByText(staleError)).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});
