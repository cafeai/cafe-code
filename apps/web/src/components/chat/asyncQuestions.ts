import type { OrchestrationThreadActivity } from "@cafecode/contracts";
import { normalizeCodexAsyncQuestions } from "@cafecode/shared/codexAsyncQuestions";
import { sha256 } from "@noble/hashes/sha2.js";
import type { FollowUpQueuePersistenceResult } from "./followUpQueuePersistence";

export const ASYNC_QUESTION_HANDLED_STORAGE_KEY = "cafe-code:async-question-handled:v1";
export const MAX_HANDLED_ASYNC_QUESTIONS = 4096;
export const MAX_ASYNC_QUESTION_DRAFTS = 64;
export const MAX_ASYNC_QUESTION_DRAFT_CHARS = 262_144;
const MAX_QUESTION_ITEMS = 64;
const HANDLED_ID = /^async-question:[a-f0-9]{64}:\d{1,3}$/u;
const ACTIVITY_ID = /^codex-async-questions:[a-f0-9]{64}$/u;
const identityHashes = new Map<string, string>();

function questionScopeHash(scope: string): string {
  const existing = identityHashes.get(scope);
  if (existing) return existing;
  // Optional remote HTTP clients do not expose SubtleCrypto. Use the pinned
  // browser-safe SHA-256 implementation consistently so identity is identical
  // on Electron, HTTPS, localhost, and an explicitly enabled HTTP endpoint.
  const digest = Array.from(sha256(new TextEncoder().encode(scope)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  identityHashes.set(scope, digest);
  // Only identity digests are cached, never provider text or draft answers.
  // This avoids hashing the same visible items again on every tool activity.
  if (identityHashes.size > 256) identityHashes.delete(identityHashes.keys().next().value!);
  return digest;
}

// Defer access to localStorage until inside the guarded read/write methods.
// Some private/embedded browser contexts throw even when reading its getter.
export const asyncQuestionStorage = {
  getItem: (key: string) => localStorage.getItem(key),
  setItem: (key: string, value: string) => localStorage.setItem(key, value),
};

/** Serialize short acceptance/skip transactions across tabs. The one global
 * handled ledger needs one global lock, including when different questions
 * settle concurrently. Durable queue identity and exact-intent validation
 * remain the delivery backstop where Web Locks is unavailable. */
export async function withAsyncQuestionLock<T>(work: () => Promise<T>): Promise<T> {
  return typeof navigator !== "undefined" && navigator.locks
    ? await navigator.locks.request("cafe:async-question-handling:v1", work)
    : await work();
}

/**
 * A concurrent view may claim its answer while our async save is suspended.
 * Queue saves deliberately preserve existing claims, so `save.ok` alone is
 * not proof that this exact answer was accepted. Re-read the durable intent
 * after saving before allowing the editor to consume its draft. This also
 * protects browser contexts that do not offer cross-tab Web Locks.
 */
export async function persistExactAsyncQuestionAnswer(input: {
  readonly id: string;
  readonly threadId: string;
  readonly text: string;
  readonly save: () => Promise<FollowUpQueuePersistenceResult>;
  readonly read: () => FollowUpQueuePersistenceResult<{
    readonly pending: readonly {
      readonly id: string;
      readonly threadId: string;
      readonly promptText: string;
    }[];
    readonly claimed: readonly {
      readonly id: string;
      readonly threadId: string;
      readonly promptText: string;
    }[];
  }>;
}): Promise<FollowUpQueuePersistenceResult<"pending" | "claimed">> {
  const saved = await input.save();
  if (!saved.ok) return saved;
  const observed = input.read();
  if (!observed.ok) return observed;
  for (const state of ["pending", "claimed"] as const) {
    const row = observed.value[state].find(
      (entry) => entry.id === input.id && entry.threadId === input.threadId,
    );
    if (row?.promptText === input.text) return { ok: true, value: state };
  }
  return {
    ok: false,
    error:
      "This question's answer changed in another view. Review the follow-up queue before trying again.",
  };
}

export interface AsyncQuestion {
  readonly id: string;
  readonly title: string;
  readonly options: readonly string[];
}

export interface AsyncQuestionDraft {
  readonly question: AsyncQuestion;
  readonly text: string;
}

/** Preserve an edited question if its activity leaves the bounded live window. */
export function retainAsyncQuestionDrafts(
  questions: readonly AsyncQuestion[],
  drafts: Readonly<Record<string, AsyncQuestionDraft>>,
): readonly AsyncQuestion[] {
  const ids = new Set(questions.map((question) => question.id));
  return [
    ...questions,
    ...Object.values(drafts)
      .filter((draft) => !ids.has(draft.question.id))
      .map((draft) => draft.question),
  ];
}

/** Refuse additional draft memory explicitly instead of evicting unsent input. */
export function updateAsyncQuestionDraft(
  drafts: Readonly<Record<string, AsyncQuestionDraft>>,
  question: AsyncQuestion,
  text: string,
): Record<string, AsyncQuestionDraft> | null {
  const entries = Object.values(drafts);
  if (!drafts[question.id] && text.length > 0 && entries.length >= MAX_ASYNC_QUESTION_DRAFTS)
    return null;
  const retainedChars = entries.reduce(
    (count, draft) => count + (draft.question.id === question.id ? 0 : draft.text.length),
    0,
  );
  if (retainedChars + text.length > MAX_ASYNC_QUESTION_DRAFT_CHARS) return null;
  const next = { ...drafts };
  if (text.length === 0) delete next[question.id];
  else next[question.id] = { question, text };
  return next;
}

/**
 * Questions are ordinary follow-up drafts, not ephemeral provider callbacks.
 * Identity binds the environment, Cafe thread, immutable canonical activity,
 * and question index. The server's activity digest additionally binds the
 * provider instance and native thread/turn/item, since native item IDs may be
 * reused after a turn or account switch. Hashing keeps identifiers out of browser
 * storage; neither question text nor answers are retained by this ledger.
 */
export async function deriveAsyncQuestions(
  environmentId: string,
  threadId: string,
  activities: readonly OrchestrationThreadActivity[],
): Promise<AsyncQuestion[]> {
  const items = new Map<string, ReturnType<typeof normalizeCodexAsyncQuestions>>();
  // Detail snapshots already carry ordered activities. Work only on the newest
  // bounded question window so a multi-day transcript cannot flood the editor.
  for (let index = activities.length - 1; index >= 0 && items.size < MAX_QUESTION_ITEMS; index--) {
    const activity = activities[index]!;
    if (activity.kind !== "provider.async-questions") continue;
    if (!ACTIVITY_ID.test(activity.id)) continue;
    if (
      !activity.payload ||
      typeof activity.payload !== "object" ||
      Array.isArray(activity.payload)
    )
      continue;
    const payload = activity.payload as Record<string, unknown>;
    const itemId = payload.itemId;
    if (typeof itemId !== "string" || itemId.length === 0 || itemId.length > 512) continue;
    if (items.has(activity.id)) continue;
    const questions = normalizeCodexAsyncQuestions(payload.questions);
    if (questions.length) items.set(activity.id, questions);
  }
  const groups = await Promise.all(
    [...items].toReversed().map(async ([activityId, questions]) => {
      const hash = questionScopeHash(JSON.stringify([environmentId, threadId, activityId]));
      return questions.map((question, index) => ({
        id: `async-question:${hash}:${index}`,
        title: question.title,
        options: question.options,
      }));
    }),
  );
  return groups.flat();
}

export function readHandledAsyncQuestions(storage: Pick<Storage, "getItem">): Set<string> {
  try {
    const text = storage.getItem(ASYNC_QUESTION_HANDLED_STORAGE_KEY);
    if (!text || text.length > MAX_HANDLED_ASYNC_QUESTIONS * 100) return new Set();
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value) || value.length > MAX_HANDLED_ASYNC_QUESTIONS) return new Set();
    return new Set(
      value.filter((id): id is string => typeof id === "string" && HANDLED_ID.test(id)),
    );
  } catch {
    return new Set();
  }
}

/** Merge before writing so another view's handled questions remain handled. */
export function rememberHandledAsyncQuestion(
  storage: Pick<Storage, "getItem" | "setItem">,
  id: string,
): boolean {
  if (!HANDLED_ID.test(id)) return false;
  try {
    const handled = readHandledAsyncQuestions(storage);
    handled.delete(id);
    handled.add(id);
    storage.setItem(
      ASYNC_QUESTION_HANDLED_STORAGE_KEY,
      JSON.stringify([...handled].slice(-MAX_HANDLED_ASYNC_QUESTIONS)),
    );
    return true;
  } catch {
    return false;
  }
}
