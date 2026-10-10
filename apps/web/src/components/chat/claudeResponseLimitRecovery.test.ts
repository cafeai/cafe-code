import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@cafecode/contracts";
import { CLAUDE_RESPONSE_LIMIT_MESSAGE } from "@cafecode/shared/claudeResponseLimits";
import { describe, expect, it } from "vitest";

import type { ComposerThreadDraftState } from "../../composerDraftStore";
import {
  captureClaudeResponseLimitFailure,
  isClaudeContinuationDraftEmpty,
  isClaudeResponseLimitFailureCurrent,
} from "./claudeResponseLimitRecovery";

const ACCOUNT = ProviderInstanceId.make("claude_personal");
const failure = {
  id: ThreadId.make("response-limit-chat"),
  environmentId: EnvironmentId.make("local"),
  archivedAt: null,
  error: CLAUDE_RESPONSE_LIMIT_MESSAGE,
  modelSelection: { instanceId: ACCOUNT, model: "claude-opus-5-5" },
  session: {
    provider: ProviderDriverKind.make("claudeAgent"),
    providerInstanceId: ACCOUNT,
    status: "error",
    orchestrationStatus: "error",
    lastError: CLAUDE_RESPONSE_LIMIT_MESSAGE,
    createdAt: "2026-10-09T00:00:00.000Z",
    updatedAt: "2026-10-09T00:53:00.000Z",
    subagentRuntimeId: "synthetic-runtime",
  },
  latestTurn: {
    turnId: TurnId.make("failed-response"),
    state: "error",
    requestedAt: "2026-10-09T00:00:00.000Z",
    startedAt: "2026-10-09T00:00:01.000Z",
    completedAt: "2026-10-09T00:53:00.000Z",
    assistantMessageId: null,
  },
} satisfies Parameters<typeof captureClaudeResponseLimitFailure>[0];

const emptyDraft: ComposerThreadDraftState = {
  prompt: "",
  images: [],
  files: [],
  nonPersistedImageIds: [],
  persistedAttachments: [],
  modelSelectionByProvider: {},
  activeProvider: ACCOUNT,
  runtimeMode: "approval-required",
  interactionMode: "default",
};

describe("Claude response-limit continuation admission", () => {
  it("binds preparation to a classified terminal failure in the exact selected account", () => {
    const witness = captureClaudeResponseLimitFailure(failure, ACCOUNT)!;
    expect(witness).toMatchObject({
      instanceId: ACCOUNT,
      turnId: failure.latestTurn.turnId,
      runtimeId: "synthetic-runtime",
    });
    expect(isClaudeResponseLimitFailureCurrent(witness, failure, ACCOUNT)).toBe(true);
    expect(captureClaudeResponseLimitFailure(failure, ProviderInstanceId.make("other"))).toBeNull();
    expect(captureClaudeResponseLimitFailure(undefined, ACCOUNT)).toBeNull();
  });

  it("rejects prose/lookalike errors and local errors unrelated to the provider failure", () => {
    for (const error of [
      "response exceeded 64000 output tokens",
      `${CLAUDE_RESPONSE_LIMIT_MESSAGE} extra`,
    ]) {
      expect(captureClaudeResponseLimitFailure({ ...failure, error }, ACCOUNT)).toBeNull();
    }
    expect(
      captureClaudeResponseLimitFailure(
        { ...failure, session: { ...failure.session, lastError: "another failure" } },
        ACCOUNT,
      ),
    ).toBeNull();
  });

  it("rejects replacement route, account, runtime, session, turn and failure occurrences", () => {
    const witness = captureClaudeResponseLimitFailure(failure, ACCOUNT)!;
    const replacements: Array<Parameters<typeof captureClaudeResponseLimitFailure>[0]> = [
      { ...failure, id: ThreadId.make("another-chat") },
      { ...failure, environmentId: EnvironmentId.make("another-server") },
      { ...failure, archivedAt: "2026-10-09T01:00:00.000Z" },
      { ...failure, session: { ...failure.session, subagentRuntimeId: "replacement" } },
      { ...failure, session: { ...failure.session, createdAt: "2026-10-09T01:00:00.000Z" } },
      { ...failure, session: { ...failure.session, updatedAt: "2026-10-09T01:00:00.000Z" } },
      { ...failure, session: { ...failure.session, providerInstanceId: undefined } },
      { ...failure, session: { ...failure.session, provider: ProviderDriverKind.make("codex") } },
      { ...failure, session: { ...failure.session, activeTurnId: TurnId.make("new-work") } },
      {
        ...failure,
        session: { ...failure.session, status: "running", orchestrationStatus: "running" },
      },
      { ...failure, latestTurn: { ...failure.latestTurn, state: "completed" } },
      { ...failure, latestTurn: { ...failure.latestTurn, turnId: TurnId.make("another-turn") } },
      {
        ...failure,
        latestTurn: { ...failure.latestTurn, completedAt: "2026-10-09T01:00:00.000Z" },
      },
      { ...failure, latestTurn: { ...failure.latestTurn, completedAt: null } },
    ];
    for (const replacement of replacements) {
      expect(isClaudeResponseLimitFailureCurrent(witness, replacement, ACCOUNT)).toBe(false);
    }
  });

  it("preserves every unsent content channel and queue editing, including whitespace", () => {
    expect(isClaudeContinuationDraftEmpty(undefined)).toBe(true);
    expect(isClaudeContinuationDraftEmpty(emptyDraft)).toBe(true);
    const occupied: ComposerThreadDraftState[] = [
      { ...emptyDraft, prompt: " " },
      { ...emptyDraft, queueEditingItemId: "queued-message" },
      { ...emptyDraft, nonPersistedImageIds: ["pending-image"] },
      {
        ...emptyDraft,
        images: [
          {
            id: "image",
            type: "image",
            name: "image.png",
            mimeType: "image/png",
            sizeBytes: 1,
            previewUrl: "blob:synthetic-image",
            file: new File(["x"], "image.png", { type: "image/png" }),
          },
        ],
      },
      {
        ...emptyDraft,
        files: [
          {
            id: "pending-file",
            environmentId: failure.environmentId,
            targetThreadId: failure.id,
            name: "draft.txt",
            mimeType: "text/plain",
            sizeBytes: 1,
            status: "uploading",
          },
        ],
      },
      {
        ...emptyDraft,
        persistedAttachments: [
          {
            id: "restored-image",
            name: "image.png",
            mimeType: "image/png",
            sizeBytes: 1,
            dataUrl: "data:image/png;base64,eA==",
          },
        ],
      },
    ];
    for (const draft of occupied) expect(isClaudeContinuationDraftEmpty(draft)).toBe(false);
  });
});
