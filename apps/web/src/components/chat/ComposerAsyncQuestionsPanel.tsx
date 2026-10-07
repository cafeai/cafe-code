import { ChevronRightIcon } from "lucide-react";
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
  rememberHandledAsyncQuestions,
  withAsyncQuestionLock,
  MAX_HANDLED_ASYNC_QUESTIONS,
  retainAsyncQuestionDrafts,
  updateAsyncQuestionDraft,
  type AsyncQuestionDraft,
  type AsyncQuestion,
} from "./asyncQuestions";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export interface ComposerAsyncQuestionsPanelProps {
  readonly environmentId: string;
  readonly threadId: string;
  readonly activities: readonly OrchestrationThreadActivity[];
  readonly deliveryDisabled: boolean;
  /** True only after Cafe has durably accepted the ordinary follow-up. */
  readonly onAnswer: (text: string, messageId: string) => Promise<boolean>;
  readonly onResolve: (questions: readonly AsyncQuestion[]) => Promise<boolean>;
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
  onResolve,
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
  const acceptedAnswers = useRef(new Map<string, string>());
  const migratedReceipts = useRef(new Set<string>());
  const resolveRef = useRef(onResolve);
  resolveRef.current = onResolve;
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
        if (current) {
          setQuestions(next);
          // Remember a remote resolution when its activity later leaves the
          // bounded live window, without consuming an edited draft.
          const resolved = next.filter((question) => question.handled);
          if (resolved.length)
            setHandled(
              (existing) =>
                new Set(
                  [...existing, ...resolved.map((question) => question.id)].slice(
                    -MAX_HANDLED_ASYNC_QUESTIONS,
                  ),
                ),
            );
        }
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

  // Older versions remembered skips only in this browser. Publish those
  // receipts to the owning server without resending any answer, so other
  // clients and future launches see the same handled state.
  useEffect(() => {
    if (deliveryDisabled) return;
    const receipts = questions.filter(
      (question) =>
        handled.has(question.id) && !question.handled && !migratedReceipts.current.has(question.id),
    );
    if (!receipts.length) return;
    for (const question of receipts) migratedReceipts.current.add(question.id);
    void withAsyncQuestionLock(() => resolveRef.current(receipts)).catch(() => {
      // The receipt remains local when the server is unavailable; another
      // launch can retry migration without creating provider input.
    });
  }, [questions, handled, deliveryDisabled]);

  const pending = useMemo(
    () =>
      retainAsyncQuestionDrafts(questions, drafts).filter(
        (question) =>
          (!handled.has(question.id) && !question.handled) || drafts[question.id] !== undefined,
      ),
    [questions, drafts, handled],
  );
  const question = pending.find((entry) => entry.id === selectedId) ?? pending[0];
  const answer = question ? (drafts[question.id]?.text ?? "") : "";
  const handledElsewhere =
    question !== undefined && (handled.has(question.id) || question.handled === true);

  const editAnswer = (question: AsyncQuestion, text: string) => {
    const next = updateAsyncQuestionDraft(draftsRef.current, question, text);
    if (next === null) {
      setError(
        "The answer draft limit is reached. Send or skip an existing answer before adding more.",
      );
      return;
    }
    draftsRef.current = next;
    setDrafts(next);
    setSelectedId(question.id);
    setError(null);
  };

  const complete = (ids: readonly string[]) => {
    rememberHandledAsyncQuestions(asyncQuestionStorage, ids);
    if (!mounted.current) return;
    setHandled((current) => {
      const next = new Set(current);
      for (const id of ids) {
        next.delete(id);
        next.add(id);
      }
      return new Set([...next].slice(-MAX_HANDLED_ASYNC_QUESTIONS));
    });
    const next = { ...draftsRef.current };
    for (const id of ids) {
      delete next[id];
      acceptedAnswers.current.delete(id);
    }
    draftsRef.current = next;
    setDrafts(next);
    setQuestions((current) =>
      current.map((entry) => (ids.includes(entry.id) ? { ...entry, handled: true } : entry)),
    );
  };

  const submit = async () => {
    if (!question || deliveryDisabled || handledElsewhere || inFlight.current) return;
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
        } else if (acceptedAnswers.current.get(id) === text || (await onAnswer(text, id))) {
          acceptedAnswers.current.set(id, text);
          if (await onResolve([question])) complete([id]);
          else if (mounted.current)
            setError(
              "Your answer was accepted, but its question state could not be saved. Try again.",
            );
        } else if (mounted.current) {
          setError("The answer was not queued. Your draft is still here; try again.");
        }
      });
    } catch {
      if (mounted.current)
        setError(
          acceptedAnswers.current.get(id) === text
            ? "Your answer was accepted, but its question state could not be saved. Try again."
            : "The answer was not queued. Your draft is still here; try again.",
        );
    } finally {
      inFlight.current = false;
      if (mounted.current) setSubmitting(false);
    }
  };

  const skip = async (all = false) => {
    if (!question || deliveryDisabled || inFlight.current) return;
    // Capture the visible pending set at the click. Questions arriving while
    // another tab owns the handling lock must not be silently dismissed.
    const selection = all ? pending : [question];
    const ids = selection.map((entry) => entry.id);
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await withAsyncQuestionLock(async () => {
        if (await onResolve(selection)) complete(ids);
        else if (mounted.current) setError("Could not save the skipped questions. Try again.");
      });
    } catch {
      if (mounted.current)
        setError(
          all
            ? "Could not skip these questions. Try again."
            : "Could not skip this question. Try again.",
        );
    } finally {
      inFlight.current = false;
      if (mounted.current) setSubmitting(false);
    }
  };

  if (!question)
    return error ? (
      <p
        role="status"
        className="mx-auto mb-2 w-full min-w-0 max-w-208 text-xs text-muted-foreground"
      >
        {error}
      </p>
    ) : null;

  return (
    <details className="group/async-questions mx-auto mb-2 w-full min-w-0 max-w-208 animate-enter-rise rounded-xl border border-border bg-card text-sm">
      <summary className="focus-ring flex cursor-pointer list-none items-center gap-1.5 rounded-xl px-3 py-2 text-muted-foreground transition-colors duration-(--duration-fast) hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 transition-transform duration-(--duration-fast) ease-out group-open/async-questions:rotate-90"
        />
        {pending.length} {pending.length === 1 ? "question" : "questions"} from Codex
      </summary>
      <div className="max-h-[40vh] animate-enter-rise space-y-3 overflow-y-auto overscroll-contain px-3 pb-3">
        {handledElsewhere && (
          <p role="status" className="text-xs text-muted-foreground">
            Handled in another view. Your draft is kept here; copy it or Skip to dismiss.
          </p>
        )}
        {pending.length > 1 && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span aria-hidden="true">Question</span>
            <Select
              value={question.id}
              disabled={submitting}
              onValueChange={(next) => {
                if (typeof next !== "string") return;
                setSelectedId(next);
                setError(null);
              }}
            >
              <SelectTrigger size="xs" className="w-auto min-w-24" aria-label="Choose question">
                <SelectValue>
                  {pending.findIndex((entry) => entry.id === question.id) + 1} of {pending.length}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {pending.map((entry, index) => (
                  <SelectItem hideIndicator key={entry.id} value={entry.id}>
                    {index + 1} of {pending.length}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
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
                className="focus-ring block w-full whitespace-pre-wrap break-words rounded-lg border border-border px-3 py-2 text-left transition-colors duration-(--duration-fast) hover:bg-accent aria-pressed:border-primary/40 aria-pressed:bg-primary/8"
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
            className="focus-ring block w-full resize-y rounded-lg border border-input bg-background px-2.5 py-1.5 text-sm text-foreground"
          />
        </label>
        {error && (
          <p role="alert" className="text-xs text-destructive-foreground">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="xs"
            disabled={
              deliveryDisabled ||
              submitting ||
              handledElsewhere ||
              formatCodexAsyncQuestionAnswer(question.title, answer) === null
            }
            onClick={() => {
              void submit();
            }}
          >
            {submitting ? "Sending…" : "Send answer"}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            className="text-muted-foreground"
            disabled={deliveryDisabled || submitting}
            onClick={() => {
              void skip();
            }}
          >
            Skip
          </Button>
          {pending.length > 1 && (
            <Button
              size="xs"
              variant="ghost"
              className="text-muted-foreground"
              disabled={deliveryDisabled || submitting}
              onClick={() => {
                void skip(true);
              }}
            >
              Skip all
            </Button>
          )}
        </div>
      </div>
    </details>
  );
}
