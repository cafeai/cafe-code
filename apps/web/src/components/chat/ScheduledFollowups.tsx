import { useUiLocale, useUiPresentation } from "~/i18n";
import { uiText, type UiLocale } from "@cafecode/shared/i18n";
import { UiMessage } from "~/i18n";
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
import { InfoTip } from "../ui/info-tip";
import { ScheduledFollowupEditor } from "./ScheduledFollowupEditor";
import {
  formatScheduleTime,
  scheduleAccountLabel,
  scheduleModelLabel,
  scheduleRecurrenceLabel,
  scheduleRunIssuePresentation,
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
type ScheduleNotice =
  | "unavailable"
  | "saved"
  | "created"
  | "paused"
  | "deleted"
  | "resumed"
  | "run-requested";

/** Store only Cafe-owned presentation keys, never translated output or received
 * errors. Resolving the copy during render also covers a language change while
 * a single admitted request is awaiting its response, without repeating I/O. */
function scheduleNoticeText(notice: ScheduleNotice, locale: UiLocale): string {
  switch (notice) {
    case "unavailable":
      return uiText(
        "This schedule is no longer available. No changes were made.",
        undefined,
        undefined,
        locale,
      );
    case "saved":
      return uiText("Follow-up saved.", undefined, undefined, locale);
    case "created":
      return uiText("Follow-up created.", undefined, undefined, locale);
    case "paused":
      return uiText(
        "Schedule paused. An already running turn is not interrupted.",
        undefined,
        undefined,
        locale,
      );
    case "deleted":
      return uiText("Schedule deleted.", undefined, undefined, locale);
    case "resumed":
      return uiText("Schedule resumed.", undefined, undefined, locale);
    case "run-requested":
      return uiText(
        "Run requested. It will wait if this chat is busy.",
        undefined,
        undefined,
        locale,
      );
  }
}

const STATE_LABELS: Record<ScheduledFollowupRecord["state"], string> = {
  get active() {
    return uiText("Scheduled");
  },
  get paused() {
    return uiText("Paused");
  },
  get completed() {
    return uiText("Finished");
  },
  get needs_attention() {
    return uiText("Needs attention");
  },
  get pending_confirmation() {
    return uiText("Needs your approval");
  },
  get deleted() {
    return uiText("Deleted");
  },
};
const RUN_LABELS: Record<ScheduledFollowupRun["state"], string> = {
  get waiting() {
    return uiText("Waiting for this chat");
  },
  get dispatching() {
    return uiText("Starting");
  },
  get running() {
    return uiText("Running");
  },
  get completed() {
    return uiText("Completed");
  },
  get failed() {
    return uiText("Failed");
  },
  get interrupted() {
    return uiText("Interrupted");
  },
  get unknown() {
    return uiText("Status unconfirmed");
  },
  get skipped() {
    return uiText("Skipped");
  },
};

function runLabel(run: ScheduledFollowupRun): string {
  return run.state === "completed" && run.result === "no-change"
    ? uiText("No changes")
    : RUN_LABELS[run.state];
}

/** One bounded history page is held at a time. Moving backwards remembers only
 * opaque cursors, not hundreds of provider runs or conversation transcripts. */
function ScheduleHistory(props: {
  context: ScheduledFollowupsContext;
  record: ScheduledFollowupRecord;
}) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const { context, record } = props;
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [snapshot, setSnapshot] = useState<{
    key: string;
    page: ScheduledFollowupHistoryResult;
  } | null>(null);
  const [failureKey, setFailureKey] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const before = cursors[cursors.length - 1];
  const lastRunVersion = JSON.stringify([
    record.lastRun?.id ?? null,
    record.lastRun?.state ?? null,
    record.lastRun?.completedAt ?? null,
    record.lastRun?.summary ?? null,
    record.lastRun?.errorCode ?? null,
  ]);
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
      className="mt-2 animate-enter-rise space-y-2 border-t border-border-subtle pt-2"
      aria-label={uiText("Run history for {value0}", { value0: record.name }, undefined, uiLocale)}
    >
      {error ? (
        <div role="alert" className="text-xs text-muted-foreground">
          {uiText("History could not be loaded.", undefined, undefined, uiLocale)}{" "}
          <Button size="xs" variant="ghost" onClick={() => setRetry((value) => value + 1)}>
            {uiText("Retry history", undefined, undefined, uiLocale)}
          </Button>
        </div>
      ) : null}
      {loading ? (
        <p className="text-xs text-muted-foreground">
          {uiText("Loading runs…", undefined, undefined, uiLocale)}
        </p>
      ) : page?.runs.length ? (
        <ol className="space-y-2">
          {page.runs.map((run) => {
            const issue = uiPresentation.scheduleRunIssuePresentation(run);
            return (
              <li key={run.id} className="min-w-0 text-xs">
                <div className="flex flex-wrap items-baseline justify-between gap-1">
                  <span className="font-medium">{uiPresentation.runLabel(run)}</span>
                  <time
                    dateTime={run.createdAt}
                    className="text-2xs tabular-nums text-subtle-foreground"
                  >
                    {uiPresentation.formatScheduleTime(run.createdAt)}
                  </time>
                </div>
                {issue ? (
                  <p className="mt-1 break-words text-muted-foreground [overflow-wrap:anywhere]">
                    {issue.reason}
                  </p>
                ) : null}
                {run.summary ? (
                  <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground [overflow-wrap:anywhere]">
                    {run.summary}
                  </p>
                ) : null}
                {run.modelSelection ? (
                  <p className="mt-1 break-words text-2xs text-muted-foreground [overflow-wrap:anywhere]">
                    {scheduleModelLabel(run.modelSelection)}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : !error ? (
        <p className="text-xs text-muted-foreground">
          {uiText("No runs yet.", undefined, undefined, uiLocale)}
        </p>
      ) : null}
      {cursors.length > 1 || page?.nextCursor ? (
        <div className="flex items-center justify-between gap-2">
          <Button
            size="xs"
            variant="ghost"
            disabled={loading || cursors.length === 1}
            onClick={() => setCursors((prior) => prior.slice(0, -1))}
          >
            {uiText("Newer runs", undefined, undefined, uiLocale)}
          </Button>
          <span className="text-2xs tabular-nums text-muted-foreground">
            <UiMessage message={"Page <slot1></slot1>"} slots={{ slot1: cursors.length }} />
          </span>
          <Button
            size="xs"
            variant="ghost"
            disabled={loading || !page?.nextCursor}
            onClick={() => {
              if (page?.nextCursor) setCursors((prior) => [...prior, page.nextCursor!]);
            }}
          >
            {uiText("Older runs", undefined, undefined, uiLocale)}
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
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const { record, context } = props;
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const lastRun = record.lastRun;
  const issue = uiPresentation.scheduleRunIssuePresentation(lastRun);
  const liveRun = lastRun && ["waiting", "dispatching", "running"].includes(lastRun.state);
  const label =
    record.state === "active" && liveRun
      ? uiPresentation.runLabel(lastRun)
      : uiPresentation.STATE_LABELS[record.state];
  const selection = record.modelSelection ?? context.modelSelection;
  const accountMatches = record.authorizedInstanceId === context.modelSelection.instanceId;
  const disabled = props.pending || context.unavailable || props.readUnavailable;

  return (
    <article
      className="min-w-0 rounded-xl border border-border-subtle bg-muted/20 p-3"
      aria-label={uiText(
        "Scheduled follow-up: {value0}",
        { value0: record.name },
        undefined,
        uiLocale,
      )}
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-2 gap-y-1">
        <h4 className="min-w-0 flex-1 break-words text-sm font-medium [overflow-wrap:anywhere]">
          {record.name}
        </h4>
        <span className="text-2xs font-medium text-muted-foreground">{label}</span>
      </div>
      {record.nextRunAt && record.state === "active" ? (
        <p className="mt-1 break-words text-xs text-primary">
          <UiMessage
            message={"Next: <slot1></slot1>"}
            slots={{ slot1: uiPresentation.formatScheduleTime(record.nextRunAt) }}
          />
        </p>
      ) : null}
      <p className="mt-1 break-words text-2xs text-muted-foreground [overflow-wrap:anywhere]">
        <UiMessage
          message={"<slot1></slot1> · Schedule timezone: <slot3></slot3>"}
          slots={{
            slot1: uiPresentation.scheduleRecurrenceLabel(record),
            slot3: record.recurrence.timeZone,
          }}
        />
      </p>
      <p className="mt-2 break-words text-2xs text-muted-foreground [overflow-wrap:anywhere]">
        {record.modelSelection
          ? uiPresentation.scheduleModelLabel(selection)
          : uiText(
              "Uses chat settings · {value0}",
              { value0: uiPresentation.scheduleModelLabel(selection) },
              undefined,
              uiLocale,
            )}
      </p>
      <p className="break-words text-2xs text-muted-foreground [overflow-wrap:anywhere]">
        {uiText(
          "Account: {account}{changed, select, yes { · Account changed; review before enabling} other {}}",
          {
            account: scheduleAccountLabel(
              { ...selection, instanceId: record.authorizedInstanceId },
              context.provider,
            ),
            changed: !accountMatches ? "yes" : "no",
          },
          undefined,
          uiLocale,
        )}
      </p>
      {lastRun ? (
        <p className="mt-2 text-2xs text-muted-foreground">
          <UiMessage
            message={"Last run: <slot1></slot1>"}
            slots={{ slot1: uiPresentation.runLabel(lastRun) }}
          />
        </p>
      ) : null}
      {record.state === "pending_confirmation" ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {uiText("Proposed by an agent — review before enabling.", undefined, undefined, uiLocale)}
        </p>
      ) : null}
      {record.state === "needs_attention" ? (
        <div className="mt-2 space-y-1 text-xs text-muted-foreground">
          {issue ? <p>{issue.reason}</p> : null}
          <p>
            {issue?.action ??
              uiText(
                "Check this chat and run history, then review and enable the schedule when ready.",
                undefined,
                undefined,
                uiLocale,
              )}
          </p>
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-1">
        {record.state === "active" ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled || !accountMatches || Boolean(liveRun)}
            onClick={props.onRun}
          >
            {uiText("Run now", undefined, undefined, uiLocale)}
          </Button>
        ) : null}
        {record.state === "active" ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled}
            onClick={() => props.onStatus("paused")}
          >
            {uiText("Pause", undefined, undefined, uiLocale)}
          </Button>
        ) : record.state === "paused" && accountMatches ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled}
            onClick={() => props.onStatus("active")}
          >
            {uiText("Resume", undefined, undefined, uiLocale)}
          </Button>
        ) : null}
        {record.state !== "deleted" ? (
          <Button size="xs" variant="ghost" disabled={disabled} onClick={props.onEdit}>
            {record.state === "pending_confirmation" || record.state === "needs_attention"
              ? uiText("Review & enable", undefined, undefined, uiLocale)
              : uiText("Edit", undefined, undefined, uiLocale)}
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="ghost"
          aria-expanded={historyOpen}
          onClick={() => setHistoryOpen((value) => !value)}
        >
          {historyOpen
            ? uiText("Hide runs", undefined, undefined, uiLocale)
            : uiText("Run history", undefined, undefined, uiLocale)}
        </Button>
        {record.state !== "deleted" ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled}
            onClick={() => setConfirmDelete((value) => !value)}
          >
            {uiText("Delete", undefined, undefined, uiLocale)}
          </Button>
        ) : null}
      </div>
      {confirmDelete ? (
        <div className="mt-2 animate-enter-rise rounded-lg border border-border p-2 text-xs">
          <p>
            {uiText(
              "Delete this schedule? Future runs will stop. An already running turn is not interrupted.",
              undefined,
              undefined,
              uiLocale,
            )}
          </p>
          <div className="mt-2 flex flex-wrap gap-1">
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={disabled}
              onClick={() => props.onStatus("deleted")}
            >
              {uiText("Delete schedule", undefined, undefined, uiLocale)}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setConfirmDelete(false)}>
              {uiText("Keep schedule", undefined, undefined, uiLocale)}
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
  const uiLocale = useUiLocale();

  const { schedules, loading, error, refresh } = useScheduledFollowups(
    context.environmentId,
    context.threadId,
  );
  const [editor, setEditor] = useState<{ record: ScheduledFollowupRecord | null } | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  // Neither locale changes nor display messages are schedule authority. Retain
  // only the fixed result classification and render it in the current language;
  // the revision-bound single-attempt mutation and review guards stay unchanged.
  const [mutationFailed, setMutationFailed] = useState(false);
  const [notice, setNotice] = useState<ScheduleNotice | null>(null);
  const mutationError = mutationFailed
    ? uiText(
        "The change was not confirmed. Refresh and review the saved schedule before trying again; no automatic retry was sent.",
        undefined,
        undefined,
        uiLocale,
      )
    : null;
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
      setNotice("unavailable");
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

  const mutate = async (action: () => Promise<unknown>, success: ScheduleNotice) => {
    if (pendingRef.current || context.unavailable) return;
    pendingRef.current = true;
    setPending(true);
    setMutationFailed(false);
    setNotice(null);
    try {
      await action();
      setNotice(success);
      setEditor(null);
      window.requestAnimationFrame(() => headingRef.current?.focus());
    } catch {
      setMutationFailed(true);
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
      record ? "saved" : "created",
    );
  };

  return (
    <section
      aria-label={uiText("Scheduled follow-ups", undefined, undefined, uiLocale)}
      className="mt-4 min-w-0 border-t border-border-subtle pt-3"
      data-scheduled-followups="true"
    >
      <div className="mb-3 flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <h3
            ref={headingRef}
            tabIndex={-1}
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground outline-none"
          >
            <UiMessage
              message={"<slot1></slot1>Scheduled <slot3></slot3>"}
              slots={{
                slot1: <Clock3Icon className="size-3.5" />,
                slot3: (
                  <span className="tabular-nums text-subtle-foreground">{current.length}</span>
                ),
              }}
            />
          </h3>
          <InfoTip label={uiText("About scheduled follow-ups", undefined, undefined, uiLocale)}>
            {uiText(
              "Saved across restarts. Runs while this chat’s Cafe server is online and awake. Existing account permissions apply.",
              undefined,
              undefined,
              uiLocale,
            )}
          </InfoTip>
        </div>
        {!editor ? (
          <Button
            ref={createRef}
            size="xs"
            variant="ghost"
            disabled={pending || context.unavailable || reviewReadUnavailable}
            onClick={() => {
              setMutationFailed(false);
              setNotice(null);
              setEditor({ record: null });
            }}
          >
            <PlusIcon className="size-3" />
            {uiText("New follow-up", undefined, undefined, uiLocale)}
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
            setMutationFailed(false);
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
                {uiText("Refresh schedules", undefined, undefined, uiLocale)}
              </Button>
            </div>
          ) : null}
          {context.unavailable ? (
            <p className="mb-2 text-xs text-muted-foreground">
              {uiText(
                "This server is disconnected. Schedule controls return when it reconnects.",
                undefined,
                undefined,
                uiLocale,
              )}
            </p>
          ) : null}
          {mutationError ? (
            <p role="alert" className="mb-2 text-xs text-destructive-foreground">
              {mutationError}
            </p>
          ) : null}
          {notice ? (
            <p role="status" className="mb-2 text-xs text-muted-foreground">
              {scheduleNoticeText(notice, uiLocale)}
            </p>
          ) : null}
          {loading ? (
            <p className="text-xs text-muted-foreground">
              {uiText("Loading schedules…", undefined, undefined, uiLocale)}
            </p>
          ) : rows.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {showHistory
                ? uiText("No finished schedules.", undefined, undefined, uiLocale)
                : uiText(
                    "Schedule a check-in or a repeating task for this chat.",
                    undefined,
                    undefined,
                    uiLocale,
                  )}
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
                    setMutationFailed(false);
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
                      state === "paused" ? "paused" : state === "deleted" ? "deleted" : "resumed",
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
                      "run-requested",
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
                {uiText("Previous schedules", undefined, undefined, uiLocale)}
              </Button>
              <span className="text-2xs tabular-nums text-muted-foreground">
                {safePage + 1} / {pageCount}
              </span>
              <Button
                size="xs"
                variant="ghost"
                disabled={safePage + 1 === pageCount}
                onClick={() => setPage(safePage + 1)}
              >
                {uiText("Next schedules", undefined, undefined, uiLocale)}
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
              {showHistory
                ? uiText("Show current schedules", undefined, undefined, uiLocale)
                : uiText(
                    "Finished schedules ({value0})",
                    { value0: historical.length },
                    undefined,
                    uiLocale,
                  )}
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
});

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = {
  STATE_LABELS,
  formatScheduleTime,
  runLabel,
  scheduleModelLabel,
  scheduleRecurrenceLabel,
  scheduleRunIssuePresentation,
};
