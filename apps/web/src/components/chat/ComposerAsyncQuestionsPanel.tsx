import { useEffect, useMemo, useRef, useState } from "react";
import {
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type OrchestrationThreadActivity,
} from "@cafecode/contracts";
import { formatCodexAsyncQuestionAnswer } from "@cafecode/shared/codexAsyncQuestions";
import {
  ASYNC_QUESTION_HANDLED_STORAGE_KEY,
  asyncQuestionStorage,
  deriveAsyncQuestions,
  readHandledAsyncQuestions,
  rememberHandledAsyncQuestion,
  withAsyncQuestionLock,
  MAX_HANDLED_ASYNC_QUESTIONS,
  retainAsyncQuestionDrafts,
  updateAsyncQuestionDraft,
  type AsyncQuestionDraft,
  type AsyncQuestion,
} from "./asyncQuestions";

export interface ComposerAsyncQuestionsPanelProps {
  readonly environmentId: string;
  readonly threadId: string;
  readonly activities: readonly OrchestrationThreadActivity[];
  readonly deliveryDisabled: boolean;
  /** True only after Cafe has durably accepted the ordinary follow-up. */
  readonly onAnswer: (text: string, messageId: string) => Promise<boolean>;
}

/**
 * Codex 0.154's inline questions accompany completed assistant items while the
 * turn may keep running. A separate editor preserves the main composer and its
 * attachments. No callback, approval, slash-command, or turn-state mutation is
 * involved: explicit answers enter Cafe's existing durable follow-up queue.
 */
export function ComposerAsyncQuestionsPanel(props: ComposerAsyncQuestionsPanelProps) {
  const scope = JSON.stringify([props.environmentId, props.threadId]);
  // A scope-keyed inner component cannot carry one environment's answer draft
  // into a same-named thread in another environment during route transitions.
  return <ScopedAsyncQuestionsPanel key={scope} {...props} />;
}

function ScopedAsyncQuestionsPanel({
  environmentId,
  threadId,
  activities,
  deliveryDisabled,
  onAnswer,
}: ComposerAsyncQuestionsPanelProps) {
  const [questions, setQuestions] = useState<readonly AsyncQuestion[]>([]);
  const [handled, setHandled] = useState(() => readHandledAsyncQuestions(asyncQuestionStorage));
  const [drafts, setDrafts] = useState<Record<string, AsyncQuestionDraft>>({});
  const draftsRef = useRef(drafts);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // React may not paint disabled controls before a second click. Admission is
  // synchronous and remains tied to the original question through async save.
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let current = true;
    void deriveAsyncQuestions(environmentId, threadId, activities).then(
      (next) => {
        if (current) setQuestions(next);
      },
      () => {
        if (current) setError("Could not prepare these questions. Reload to try again.");
      },
    );
    return () => {
      current = false;
    };
  }, [activities, environmentId, threadId]);

  useEffect(() => {
    const refresh = (event: StorageEvent) => {
      if (event.key === ASYNC_QUESTION_HANDLED_STORAGE_KEY || event.key === null) {
        setHandled(readHandledAsyncQuestions(asyncQuestionStorage));
      }
    };
    window.addEventListener("storage", refresh);
    return () => window.removeEventListener("storage", refresh);
  }, []);

  const pending = useMemo(
    () =>
      retainAsyncQuestionDrafts(questions, drafts).filter(
        (question) => !handled.has(question.id) || drafts[question.id] !== undefined,
      ),
    [questions, drafts, handled],
  );
  const question = pending.find((entry) => entry.id === selectedId) ?? pending[0];
  const answer = question ? (drafts[question.id]?.text ?? "") : "";
  const handledElsewhere = question !== undefined && handled.has(question.id);

  const editAnswer = (question: AsyncQuestion, text: string) => {
    const next = updateAsyncQuestionDraft(draftsRef.current, question, text);
    if (next === null) {
      setError(
        "The answer draft limit is reached. Queue or skip an existing answer before adding more.",
      );
      return;
    }
    draftsRef.current = next;
    setDrafts(next);
    setSelectedId(question.id);
    setError(null);
  };

  const complete = (id: string) => {
    const persisted = rememberHandledAsyncQuestion(asyncQuestionStorage, id);
    if (!mounted.current) return;
    setHandled((current) => new Set([...current, id].slice(-MAX_HANDLED_ASYNC_QUESTIONS)));
    const next = { ...draftsRef.current };
    delete next[id];
    draftsRef.current = next;
    setDrafts(next);
    if (!persisted)
      setError("This question is handled, but browser storage could not remember it after reload.");
  };

  const submit = async () => {
    if (!question || deliveryDisabled || inFlight.current) return;
    const text = formatCodexAsyncQuestionAnswer(question.title, answer);
    if (text === null) return;
    const id = question.id;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      // Re-read immediately before admission in case another tab handled it.
      await withAsyncQuestionLock(async () => {
        if (readHandledAsyncQuestions(asyncQuestionStorage).has(id)) {
          // An ID-only receipt cannot prove that another view accepted this
          // draft's exact text. Keep it available to copy or explicitly skip.
          if (mounted.current)
            setHandled((current) => new Set([...current, id].slice(-MAX_HANDLED_ASYNC_QUESTIONS)));
        } else if (await onAnswer(text, id)) {
          complete(id);
        } else if (mounted.current) {
          setError("The answer was not queued. Your draft is still here; try again.");
        }
      });
    } catch {
      if (mounted.current)
        setError("The answer was not queued. Your draft is still here; try again.");
    } finally {
      inFlight.current = false;
      if (mounted.current) setSubmitting(false);
    }
  };

  const skip = async () => {
    if (!question || deliveryDisabled || inFlight.current) return;
    const id = question.id;
    inFlight.current = true;
    setSubmitting(true);
    try {
      await withAsyncQuestionLock(async () => {
        complete(id);
      });
    } catch {
      if (mounted.current) setError("Could not skip this question. Try again.");
    } finally {
      inFlight.current = false;
      if (mounted.current) setSubmitting(false);
    }
  };

  if (!question)
    return error ? (
      <p role="status" className="mb-2 text-xs text-muted-foreground">
        {error}
      </p>
    ) : null;

  return (
    <details className="mb-2 rounded-lg border border-border/60 bg-card text-sm">
      <summary className="cursor-pointer px-3 py-2 text-muted-foreground">
        {pending.length} {pending.length === 1 ? "question" : "questions"} from Codex
      </summary>
      <div className="max-h-[40vh] space-y-3 overflow-y-auto overscroll-contain px-3 pb-3">
        <p className="text-xs text-muted-foreground">
          You can answer while Codex continues. Your main draft stays below.
        </p>
        {handledElsewhere && (
          <p role="status" className="text-xs text-muted-foreground">
            Handled in another view. Your draft is kept here; copy it or Skip to dismiss.
          </p>
        )}
        {pending.length > 1 && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Question
            <select
              aria-label="Choose question"
              value={question.id}
              disabled={submitting}
              onChange={(event) => {
                setSelectedId(event.target.value);
                setError(null);
              }}
              className="rounded border border-border bg-background p-1 text-foreground"
            >
              {pending.map((entry, index) => (
                <option key={entry.id} value={entry.id}>
                  {index + 1} of {pending.length}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="whitespace-pre-wrap break-words font-medium">{question.title}</p>
        {question.options.length > 0 && (
          <div role="group" aria-label="Suggested answers" className="space-y-1.5">
            {question.options.map((option) => (
              <button
                type="button"
                key={option}
                aria-pressed={answer === option}
                disabled={submitting}
                onClick={() => editAnswer(question, option)}
                className="block w-full whitespace-pre-wrap break-words rounded-md border border-border px-3 py-2 text-left hover:bg-accent aria-pressed:bg-accent"
              >
                {option}
              </button>
            ))}
          </div>
        )}
        <label className="block space-y-1 text-xs text-muted-foreground">
          Your answer
          <textarea
            aria-label="Your answer"
            value={answer}
            disabled={submitting}
            maxLength={PROVIDER_SEND_TURN_MAX_INPUT_CHARS}
            onChange={(event) => editAnswer(question, event.target.value)}
            rows={3}
            className="block w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          />
        </label>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={
              deliveryDisabled ||
              submitting ||
              handledElsewhere ||
              formatCodexAsyncQuestionAnswer(question.title, answer) === null
            }
            onClick={() => {
              void submit();
            }}
            className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
          >
            {submitting ? "Queueing…" : "Queue answer"}
          </button>
          <button
            type="button"
            disabled={deliveryDisabled || submitting}
            onClick={() => {
              void skip();
            }}
            className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
          >
            Skip
          </button>
        </div>
      </div>
    </details>
  );
}
