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
  return (
    <ThreadErrorBanner
      key={mountKey}
      error={error}
      scopeKey={`${ENV}/${THREAD}`}
      environmentId={ENV}
      threadId={THREAD}
    />
  );
}

describe("ThreadErrorBanner", () => {
  it.each([
    { error: "Codex App Server exited unexpectedly.", turnId: undefined },
    { error: "Synthetic provider error", turnId: "turn-1" as TurnId },
  ])(
    "shows different local errors after remounting an acknowledged $error",
    async ({ error, turnId }) => {
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

  it("does not acknowledge a provider failure when dismissing a local command rejection", async () => {
    const providerError = "Synthetic provider error";
    const threadRef = { environmentId: ENV, threadId: THREAD };
    seedFailure(ENV, FIRST_FAILURE, "turn-1" as TurnId, THREAD, providerError);
    useStore.getState().setError(threadRef, "The command was rejected.");
    const screen = await render(<StoreThreadErrorBanner mountKey="local" />);
    try {
      await page.getByLabelText("Dismiss error").click();
      expect(getClientSettingsSnapshot().dismissedTaskAtriumErrors).toEqual([]);
      useStore.getState().setError(threadRef, providerError);
      await expect.element(page.getByText(providerError)).toBeVisible();
      await page.getByLabelText("Dismiss error").click();
      expect(getClientSettingsSnapshot().dismissedTaskAtriumErrors).toHaveLength(1);
      await screen.rerender(<StoreThreadErrorBanner mountKey="provider-remounted" />);
      await expect.element(page.getByText(providerError)).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("dismisses all current copies of the Codex exit warning on this server and retains later failures", async () => {
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
      await expect.element(page.getByText(error).nth(0)).toBeVisible();
      await expect.element(page.getByText(error).nth(1)).toBeVisible();
      await page.getByLabelText("Dismiss error").nth(0).click();
      await expect.element(page.getByText(error)).not.toBeInTheDocument();
      const dismissed = getClientSettingsSnapshot().dismissedTaskAtriumErrors;
      expect(dismissed).toHaveLength(2);
      expect(dismissed).toEqual(
        expect.arrayContaining([
          { environmentId: ENV, threadId: THREAD, turnId: null, observedAt: FIRST_FAILURE },
          {
            environmentId: ENV,
            threadId: peer,
            turnId: null,
            observedAt: "2026-10-06T12:00:00.500Z",
          },
        ]),
      );
      expect(JSON.stringify(dismissed)).not.toContain(error);
      expect(
        selectAtriumSnapshot(useStore.getState(), Date.parse(FIRST_FAILURE), dismissed, ENV)
          .errorCount,
      ).toBe(1);
      await screen.rerender(banner(peer, "peer-remounted"));
      await expect.element(page.getByText(error)).not.toBeInTheDocument();
      seedFailure(ENV, LATER_FAILURE, undefined, peer, error);
      await expect.element(page.getByText(error)).toBeVisible();
      await screen.rerender(banner(THREAD, "remote", REMOTE));
      await expect.element(page.getByText(error)).toBeVisible();
      await screen.rerender(banner(THREAD, "local-return"));
      await expect.element(page.getByText(error)).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("does not batch-dismiss ordinary diagnostic text shared by different chats", async () => {
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
      await page.getByLabelText("Dismiss error").click();
      expect(getClientSettingsSnapshot().dismissedTaskAtriumErrors).toHaveLength(1);
      await screen.rerender(
        <ThreadErrorBanner
          key="peer"
          error={error}
          scopeKey={`${ENV}/${peer}`}
          environmentId={ENV}
          threadId={peer}
        />,
      );
      await expect.element(page.getByText(error)).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
  it("reads the saved dismissal after switching servers and remounting, without hiding another server's error", async () => {
    const error = "Codex App Server exited unexpectedly.";
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
      await expect.element(page.getByText("A different provider failure")).toBeVisible();
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

  it("keeps a turn-bound dismissal stable through projection settling and shows the same error on a new turn", async () => {
    const error = "Synthetic provider error";
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

  it("keeps an exact thread error dismissed across snapshot-style rerenders", async () => {
    const staleError = "Recovered provider failure request-id-1";
    const screen = await render(
      <ThreadErrorBanner
        error={staleError}
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
          scopeKey="local/thread-1"
          environmentId={ENV}
          threadId={THREAD}
        />,
      );
      await expect.element(page.getByText(staleError)).not.toBeInTheDocument();

      await screen.rerender(
        <ThreadErrorBanner
          error="A different provider failure"
          scopeKey="local/thread-1"
          environmentId={ENV}
          threadId={THREAD}
        />,
      );
      await expect.element(page.getByText("A different provider failure")).toBeVisible();

      await screen.rerender(
        <ThreadErrorBanner
          error={staleError}
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
