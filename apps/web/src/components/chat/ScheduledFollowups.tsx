import type {
  EnvironmentId,
  ModelSelection,
  ScheduledFollowupDraft,
  ScheduledFollowupHistoryResult,
  ScheduledFollowupId,
  ScheduledFollowupRecord,
  ScheduledFollowupRun,
  ServerProvider,
  ThreadId,
} from "@cafecode/contracts";
import { Clock3Icon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { ensureScheduledFollowupsApi } from "../../lib/scheduledFollowupsApi";
import { Button } from "../ui/button";
import { ScheduledFollowupEditor } from "./ScheduledFollowupEditor";
import {
  formatScheduleTime,
  scheduleAccountLabel,
  scheduleModelLabel,
  scheduleRecurrenceLabel,
} from "./schedulePresentation";
import { useScheduledFollowups } from "./useScheduledFollowups";

export interface ScheduledFollowupsContext {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly modelSelection: ModelSelection;
  readonly provider: ServerProvider | null;
  readonly unavailable: boolean;
}

const PAGE_SIZE = 5;
const HISTORY_PAGE_SIZE = 10;
const STATE_LABELS: Record<ScheduledFollowupRecord["state"], string> = {
  active: "Scheduled",
  paused: "Paused",
  completed: "Finished",
  needs_attention: "Needs attention",
  pending_confirmation: "Needs your approval",
  deleted: "Deleted",
};
const RUN_LABELS: Record<ScheduledFollowupRun["state"], string> = {
  waiting: "Waiting for this chat",
  dispatching: "Starting",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
  unknown: "Status unconfirmed",
  skipped: "Skipped",
};

function runLabel(run: ScheduledFollowupRun): string {
  return run.state === "completed" && run.result === "no-change"
    ? "No changes"
    : RUN_LABELS[run.state];
}

/** One bounded history page is held at a time. Moving backwards remembers only
 * opaque cursors, not hundreds of provider runs or conversation transcripts. */
function ScheduleHistory(props: {
  context: ScheduledFollowupsContext;
  record: ScheduledFollowupRecord;
}) {
  const { context, record } = props;
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [snapshot, setSnapshot] = useState<{
    key: string;
    page: ScheduledFollowupHistoryResult;
  } | null>(null);
  const [failureKey, setFailureKey] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const before = cursors[cursors.length - 1];
  const lastRunVersion = `${record.lastRun?.id ?? ""}:${record.lastRun?.state ?? ""}:${record.lastRun?.completedAt ?? ""}:${record.lastRun?.summary ?? ""}`;
  const requestKey = JSON.stringify([record.id, before, retry, lastRunVersion]);
  const page = snapshot?.key === requestKey ? snapshot.page : null;
  const error = failureKey === requestKey;
  const loading = !page && !error;

  useEffect(() => {
    let disposed = false;
    void Promise.resolve()
      .then(() =>
        ensureScheduledFollowupsApi(context.environmentId).history({
          threadId: context.threadId,
          id: record.id,
          limit: HISTORY_PAGE_SIZE,
          ...(before ? { before } : {}),
        }),
      )
      .then((result) => {
        if (!disposed) {
          setSnapshot({ key: requestKey, page: result });
          setFailureKey(null);
        }
      })
      .catch(() => {
        if (!disposed) setFailureKey(requestKey);
      });
    return () => {
      disposed = true;
    };
  }, [context.environmentId, context.threadId, record.id, before, requestKey]);

  return (
    <div
      className="mt-2 space-y-2 border-t border-border/50 pt-2"
      aria-label={`Run history for ${record.name}`}
    >
      {error ? (
        <div role="alert" className="text-xs text-muted-foreground">
          History could not be loaded.{" "}
          <Button size="xs" variant="ghost" onClick={() => setRetry((value) => value + 1)}>
            Retry history
          </Button>
        </div>
      ) : null}
      {loading ? (
        <p className="text-xs text-muted-foreground">Loading runs…</p>
      ) : page?.runs.length ? (
        <ol className="space-y-2">
          {page.runs.map((run) => (
            <li key={run.id} className="min-w-0 text-xs">
              <div className="flex flex-wrap items-baseline justify-between gap-1">
                <span className="font-medium">{runLabel(run)}</span>
                <time dateTime={run.createdAt} className="text-[11px] text-muted-foreground">
                  {formatScheduleTime(run.createdAt, record.recurrence.timeZone)}
                </time>
              </div>
              {run.summary ? (
                <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground [overflow-wrap:anywhere]">
                  {run.summary}
                </p>
              ) : null}
              {run.modelSelection ? (
                <p className="mt-1 break-words text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
                  {scheduleModelLabel(run.modelSelection)}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      ) : !error ? (
        <p className="text-xs text-muted-foreground">No runs yet.</p>
      ) : null}
      {cursors.length > 1 || page?.nextCursor ? (
        <div className="flex items-center justify-between gap-2">
          <Button
            size="xs"
            variant="ghost"
            disabled={loading || cursors.length === 1}
            onClick={() => setCursors((prior) => prior.slice(0, -1))}
          >
            Newer runs
          </Button>
          <span className="text-[11px] text-muted-foreground">Page {cursors.length}</span>
          <Button
            size="xs"
            variant="ghost"
            disabled={loading || !page?.nextCursor}
            onClick={() => {
              if (page?.nextCursor) setCursors((prior) => [...prior, page.nextCursor!]);
            }}
          >
            Older runs
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ScheduleCard(props: {
  context: ScheduledFollowupsContext;
  record: ScheduledFollowupRecord;
  pending: boolean;
  readUnavailable?: boolean;
  onEdit: () => void;
  onStatus: (state: "active" | "paused" | "deleted") => void;
  onRun: () => void;
}) {
  const { record, context } = props;
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const lastRun = record.lastRun;
  const liveRun = lastRun && ["waiting", "dispatching", "running"].includes(lastRun.state);
  const label =
    record.state === "active" && liveRun ? runLabel(lastRun) : STATE_LABELS[record.state];
  const selection = record.modelSelection ?? context.modelSelection;
  const accountMatches = record.authorizedInstanceId === context.modelSelection.instanceId;
  const disabled = props.pending || context.unavailable || props.readUnavailable;

  return (
    <article
      className="min-w-0 rounded-xl border border-border/60 bg-muted/20 p-3"
      aria-label={`Scheduled follow-up: ${record.name}`}
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-2 gap-y-1">
        <h4 className="min-w-0 flex-1 break-words text-sm font-medium [overflow-wrap:anywhere]">
          {record.name}
        </h4>
        <span className="text-[10px] font-medium text-muted-foreground">{label}</span>
      </div>
      {record.nextRunAt && record.state === "active" ? (
        <p className="mt-1 break-words text-xs text-primary">
          Next: {formatScheduleTime(record.nextRunAt, record.recurrence.timeZone)}
        </p>
      ) : null}
      <p className="mt-1 break-words text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
        {scheduleRecurrenceLabel(record)} · {record.recurrence.timeZone}
      </p>
      <p className="mt-2 break-words text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
        {record.modelSelection
          ? scheduleModelLabel(selection)
          : `Uses chat settings · ${scheduleModelLabel(selection)}`}
      </p>
      <p className="break-words text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
        Account:{" "}
        {scheduleAccountLabel(
          { ...selection, instanceId: record.authorizedInstanceId },
          context.provider,
        )}
        {!accountMatches ? " · Account changed; review before enabling" : ""}
      </p>
      {lastRun ? (
        <p className="mt-2 text-[11px] text-muted-foreground">Last run: {runLabel(lastRun)}</p>
      ) : null}
      {record.state === "pending_confirmation" ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Proposed by an agent. Review the instructions and the account that will run and pay for
          these follow-ups before enabling them.
        </p>
      ) : null}
      {record.state === "needs_attention" ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Check this chat and run history, then review and enable the schedule when ready.
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-1">
        {record.state === "active" ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled || !accountMatches || Boolean(liveRun)}
            onClick={props.onRun}
          >
            Run now
          </Button>
        ) : null}
        {record.state === "active" ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled}
            onClick={() => props.onStatus("paused")}
          >
            Pause
          </Button>
        ) : record.state === "paused" && accountMatches ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled}
            onClick={() => props.onStatus("active")}
          >
            Resume
          </Button>
        ) : null}
        {record.state !== "deleted" ? (
          <Button size="xs" variant="ghost" disabled={disabled} onClick={props.onEdit}>
            {record.state === "pending_confirmation" || record.state === "needs_attention"
              ? "Review & enable"
              : "Edit"}
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="ghost"
          aria-expanded={historyOpen}
          onClick={() => setHistoryOpen((value) => !value)}
        >
          {historyOpen ? "Hide runs" : "Run history"}
        </Button>
        {record.state !== "deleted" ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled}
            onClick={() => setConfirmDelete((value) => !value)}
          >
            Delete
          </Button>
        ) : null}
      </div>
      {confirmDelete ? (
        <div className="mt-2 rounded-lg border border-border/60 p-2 text-xs">
          <p>
            Delete this schedule? Future runs will stop. An already running turn is not interrupted.
          </p>
          <div className="mt-2 flex flex-wrap gap-1">
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={disabled}
              onClick={() => props.onStatus("deleted")}
            >
              Delete schedule
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setConfirmDelete(false)}>
              Keep schedule
            </Button>
          </div>
        </div>
      ) : null}
      {historyOpen ? <ScheduleHistory context={context} record={record} /> : null}
    </article>
  );
}

/**
 * Shared docked/popover surface. The backend owns every timer and state change;
 * this component never starts provider turns or evaluates saved instructions.
 * Mutations are submitted once with a reviewed revision. A lost response is an
 * ambiguous outcome: refresh server truth instead of automatically replaying it.
 */
export const ScheduledFollowups = memo(function ScheduledFollowups({
  context,
  initialReviewScheduleId,
}: {
  context: ScheduledFollowupsContext;
  /** Navigation only: resolve this ID through the exact chat's authoritative
   * list. Never take a model-authored definition or enable it on mount. */
  initialReviewScheduleId?: ScheduledFollowupId;
}) {
  const { schedules, loading, error, refresh } = useScheduledFollowups(
    context.environmentId,
    context.threadId,
  );
  const [editor, setEditor] = useState<{ record: ScheduledFollowupRecord | null } | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [page, setPage] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const createRef = useRef<HTMLButtonElement>(null);
  const initialReviewHandled = useRef(false);
  // An inline review first refreshes its exact saved target. Do not let a new
  // draft or cached-card action race that read and get replaced by its result.
  const reviewReadUnavailable = Boolean(initialReviewScheduleId && (loading || error));

  useEffect(() => {
    if (!initialReviewScheduleId || initialReviewHandled.current || loading || error) return;
    initialReviewHandled.current = true;
    const record = schedules.find(
      (entry) =>
        entry.id === initialReviewScheduleId &&
        entry.threadId === context.threadId &&
        entry.state !== "deleted",
    );
    if (record) {
      // Capture the reviewed revision. Later remote edits must fail the normal
      // backend revision fence, not silently replace a form under the owner.
      setEditor({ record });
    } else {
      setNotice("This schedule is no longer available. No changes were made.");
    }
  }, [context.threadId, error, initialReviewScheduleId, loading, schedules]);
  const current = schedules.filter(
    (record) => record.state !== "completed" && record.state !== "deleted",
  );
  const historical = schedules.filter(
    (record) => record.state === "completed" || record.state === "deleted",
  );
  const rows = showHistory ? historical : current;
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);

  const mutate = async (action: () => Promise<unknown>, success: string) => {
    if (pendingRef.current || context.unavailable) return;
    pendingRef.current = true;
    setPending(true);
    setMutationError(null);
    setNotice(null);
    try {
      await action();
      setNotice(success);
      setEditor(null);
      window.requestAnimationFrame(() => headingRef.current?.focus());
    } catch {
      setMutationError(
        "The change was not confirmed. Refresh and review the saved schedule before trying again; no automatic retry was sent.",
      );
    } finally {
      pendingRef.current = false;
      setPending(false);
      refresh();
    }
  };

  const save = (draft: ScheduledFollowupDraft) => {
    const record = editor?.record;
    void mutate(
      () =>
        ensureScheduledFollowupsApi(context.environmentId).save({
          threadId: context.threadId,
          expectedInstanceId: context.modelSelection.instanceId,
          ...draft,
          ...(record ? { id: record.id, expectedRevision: record.revision } : {}),
        }),
      record ? "Follow-up saved." : "Follow-up created.",
    );
  };

  return (
    <section
      aria-label="Scheduled follow-ups"
      className="mt-4 min-w-0 border-t border-border/60 pt-3"
      data-scheduled-followups="true"
    >
      <div className="mb-3 flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h3
          ref={headingRef}
          tabIndex={-1}
          className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground outline-none"
        >
          <Clock3Icon className="size-3.5" />
          Scheduled <span className="text-muted-foreground/65">{current.length}</span>
        </h3>
        {!editor ? (
          <Button
            ref={createRef}
            size="xs"
            variant="ghost"
            disabled={pending || context.unavailable || reviewReadUnavailable}
            onClick={() => {
              setMutationError(null);
              setNotice(null);
              setEditor({ record: null });
            }}
          >
            <PlusIcon className="size-3" />
            New follow-up
          </Button>
        ) : null}
      </div>
      {editor ? (
        <ScheduledFollowupEditor
          key={editor.record ? `${editor.record.id}:${editor.record.revision}` : "new"}
          context={context}
          record={editor.record}
          saving={pending}
          error={mutationError}
          onSave={save}
          onCancel={() => {
            setEditor(null);
            setMutationError(null);
            window.requestAnimationFrame(() => createRef.current?.focus());
          }}
        />
      ) : (
        <>
          {error ? (
            <div className="mb-2 text-xs text-muted-foreground" role="status">
              {error}{" "}
              <Button variant="ghost" size="xs" onClick={refresh}>
                <RefreshCwIcon className="size-3" />
                Refresh schedules
              </Button>
            </div>
          ) : null}
          {context.unavailable ? (
            <p className="mb-2 text-xs text-muted-foreground">
              This backend is disconnected. Schedule controls will return when it reconnects.
            </p>
          ) : null}
          {mutationError ? (
            <p role="alert" className="mb-2 text-xs text-destructive">
              {mutationError}
            </p>
          ) : null}
          {notice ? (
            <p role="status" className="mb-2 text-xs text-muted-foreground">
              {notice}
            </p>
          ) : null}
          {loading ? (
            <p className="text-xs text-muted-foreground">Loading schedules…</p>
          ) : rows.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {showHistory
                ? "No finished schedules."
                : "Schedule a check-in or a repeating task for this chat."}
            </p>
          ) : (
            <div className="space-y-2">
              {rows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE).map((record) => (
                <ScheduleCard
                  key={record.id}
                  context={context}
                  record={record}
                  pending={pending}
                  readUnavailable={reviewReadUnavailable}
                  onEdit={() => {
                    setMutationError(null);
                    setNotice(null);
                    setEditor({ record });
                  }}
                  onStatus={(state) => {
                    void mutate(
                      () =>
                        ensureScheduledFollowupsApi(context.environmentId).setStatus({
                          expectedInstanceId: context.modelSelection.instanceId,
                          threadId: context.threadId,
                          id: record.id,
                          expectedRevision: record.revision,
                          state,
                        }),
                      state === "paused"
                        ? "Schedule paused. An already running turn is not interrupted."
                        : state === "deleted"
                          ? "Schedule deleted."
                          : "Schedule resumed.",
                    );
                  }}
                  onRun={() => {
                    void mutate(
                      () =>
                        ensureScheduledFollowupsApi(context.environmentId).runNow({
                          threadId: context.threadId,
                          id: record.id,
                          expectedRevision: record.revision,
                        }),
                      "Run requested. It will wait if this chat is busy.",
                    );
                  }}
                />
              ))}
            </div>
          )}
          {pageCount > 1 ? (
            <div className="mt-2 flex items-center justify-between gap-2">
              <Button
                size="xs"
                variant="ghost"
                disabled={safePage === 0}
                onClick={() => setPage(safePage - 1)}
              >
                Previous schedules
              </Button>
              <span className="text-[11px] text-muted-foreground">
                {safePage + 1} / {pageCount}
              </span>
              <Button
                size="xs"
                variant="ghost"
                disabled={safePage + 1 === pageCount}
                onClick={() => setPage(safePage + 1)}
              >
                Next schedules
              </Button>
            </div>
          ) : null}
          {historical.length || showHistory ? (
            <Button
              size="xs"
              variant="ghost"
              className="mt-2"
              aria-expanded={showHistory}
              onClick={() => {
                setShowHistory((value) => !value);
                setPage(0);
              }}
            >
              {showHistory ? "Show current schedules" : `Finished schedules (${historical.length})`}
            </Button>
          ) : null}
          <p className="mt-3 text-[10px] leading-4 text-muted-foreground/70">
            Saved across restarts. Runs while this chat’s Cafe backend is online and awake. Existing
            account permissions apply.
          </p>
        </>
      )}
    </section>
  );
});
