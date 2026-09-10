import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { EventId, type OrchestrationThreadActivity } from "@cafecode/contracts";
import { deriveWorkLogEntries } from "../../session-logic";
import {
  ASYNC_QUESTION_HANDLED_STORAGE_KEY,
  deriveAsyncQuestions,
  readHandledAsyncQuestions,
  rememberHandledAsyncQuestion,
  persistExactAsyncQuestionAnswer,
  retainAsyncQuestionDrafts,
  updateAsyncQuestionDraft,
  MAX_ASYNC_QUESTION_DRAFTS,
  MAX_ASYNC_QUESTION_DRAFT_CHARS,
  type AsyncQuestionDraft,
} from "./asyncQuestions";

function activity(itemId: string, digest = "a".repeat(64)): OrchestrationThreadActivity {
  return {
    id: EventId.make(`codex-async-questions:${digest}`),
    createdAt: "2026-09-10T00:00:00.000Z",
    tone: "info",
    kind: "provider.async-questions",
    summary: "Codex has questions",
    payload: {
      itemId,
      questions: [
        { title: "Which route?", options: ["A", "B"] },
        { title: "Additional context?", options: [] },
      ],
    },
    turnId: null,
  };
}

describe("inline async question identity", () => {
  it("retains SHA-256 identity on a plain HTTP client without SubtleCrypto", async () => {
    vi.stubGlobal("crypto", undefined);
    try {
      const row = activity("item");
      const [question] = await deriveAsyncQuestions("http-environment", "thread", [row]);
      const expected = createHash("sha256")
        .update(JSON.stringify(["http-environment", "thread", row.id]))
        .digest("hex");
      expect(question!.id).toBe(`async-question:${expected}:0`);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("deduplicates replay and binds identity to environment, thread, item, and question index", async () => {
    const row = activity("item");
    const questions = await deriveAsyncQuestions("local", "thread", [row, row]);
    expect(questions).toHaveLength(2);
    expect(questions[0]!.id).not.toBe(questions[1]!.id);
    expect(await deriveAsyncQuestions("local", "thread", [row])).toEqual(questions);
    for (const [environment, thread, item] of [
      ["remote", "thread", "item"],
      ["local", "other", "item"],
    ]) {
      const other = await deriveAsyncQuestions(environment!, thread!, [activity(item!)]);
      expect(other[0]!.id).not.toBe(questions[0]!.id);
    }
    const reused = await deriveAsyncQuestions("local", "thread", [
      row,
      activity("item", "b".repeat(64)),
    ]);
    expect(reused).toHaveLength(4);
    expect(reused[2]!.id).not.toBe(questions[0]!.id);
    expect(questions[0]!.id).toMatch(/^async-question:[a-f0-9]{64}:0$/u);
  });

  it("persists only bounded opaque handled identities and preserves replay suppression", async () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
    };
    const [question] = await deriveAsyncQuestions("private-environment", "private-thread", [
      activity("private-item"),
    ]);
    expect(rememberHandledAsyncQuestion(storage, question!.id)).toBe(true);
    expect(readHandledAsyncQuestions(storage).has(question!.id)).toBe(true);
    expect(data.get(ASYNC_QUESTION_HANDLED_STORAGE_KEY)).not.toMatch(
      /Which|route|private|Additional/u,
    );
    expect(rememberHandledAsyncQuestion(storage, "untrusted answer text")).toBe(false);
    const existing = Array.from(
      { length: 4096 },
      (_, index) => `async-question:${index.toString(16).padStart(64, "0")}:0`,
    );
    storage.setItem(ASYNC_QUESTION_HANDLED_STORAGE_KEY, JSON.stringify(existing));
    rememberHandledAsyncQuestion(storage, question!.id);
    expect(readHandledAsyncQuestions(storage).size).toBe(4096);
    expect(readHandledAsyncQuestions(storage).has(existing[0]!)).toBe(false);
  });

  it("handles unavailable storage and excludes dedicated questions from the generic work log", () => {
    const storage = {
      getItem: () => {
        throw new Error("Unavailable");
      },
      setItem: () => {
        throw new Error("Unavailable");
      },
    };
    expect(readHandledAsyncQuestions(storage).size).toBe(0);
    expect(rememberHandledAsyncQuestion(storage, `async-question:${"0".repeat(64)}:0`)).toBe(false);
    expect(deriveWorkLogEntries([activity("item")], undefined)).toEqual([]);
  });

  it("rejects a different answer claimed during the asynchronous save instead of consuming the draft", async () => {
    let resolve!: () => void;
    let claimedText = "original answer";
    const acceptance = persistExactAsyncQuestionAnswer({
      id: "question-id",
      threadId: "thread",
      text: "my answer",
      save: async () => {
        await new Promise<void>((ready) => {
          resolve = ready;
        });
        return { ok: true, value: undefined };
      },
      read: () => ({
        ok: true,
        value: {
          pending: [],
          claimed: [{ id: "question-id", threadId: "thread", promptText: claimedText }],
        },
      }),
    });
    // The competing view wins and claims a different immutable queue payload
    // while our save yields. Generic queue save preserves that claim and says
    // ok, which is insufficient acknowledgement for this answer editor.
    claimedText = "another view's accepted answer";
    resolve();
    expect((await acceptance).ok).toBe(false);
    expect(
      await persistExactAsyncQuestionAnswer({
        id: "question-id",
        threadId: "thread",
        text: claimedText,
        save: async () => ({ ok: true, value: undefined }),
        read: () => ({
          ok: true,
          value: {
            pending: [],
            claimed: [{ id: "question-id", threadId: "thread", promptText: claimedText }],
          },
        }),
      }),
    ).toEqual({ ok: true, value: "claimed" });
  });

  it("retains unsent questions across live-window rotation and refuses draft-budget overflow without eviction", () => {
    const question = { id: "draft-0", title: "Older question", options: [] };
    const drafts = updateAsyncQuestionDraft({}, question, "Do not lose this answer")!;
    expect(retainAsyncQuestionDrafts([], drafts)).toEqual([question]);
    expect(retainAsyncQuestionDrafts([question], drafts)).toEqual([question]);
    const full: Record<string, AsyncQuestionDraft> = Object.fromEntries(
      Array.from({ length: MAX_ASYNC_QUESTION_DRAFTS }, (_, index) => {
        const entry = { id: `draft-${index}`, title: "Question", options: [] };
        return [entry.id, { question: entry, text: "retained" }];
      }),
    );
    expect(updateAsyncQuestionDraft(full, { ...question, id: "new" }, "extra")).toBeNull();
    expect(Object.keys(full)).toHaveLength(MAX_ASYNC_QUESTION_DRAFTS);
    expect(
      updateAsyncQuestionDraft(drafts, question, "a".repeat(MAX_ASYNC_QUESTION_DRAFT_CHARS + 1)),
    ).toBeNull();
    expect(drafts[question.id]!.text).toBe("Do not lose this answer");
  });
});
