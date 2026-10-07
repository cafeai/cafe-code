import type { ScheduledFollowupRecord } from "@cafecode/contracts";
import { ChevronRightIcon, Clock3Icon, RefreshCwIcon } from "lucide-react";
import { memo, useId, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { useDelayedFlag } from "../../hooks/useDelayedFlag";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import type { ScheduledFollowupsContext } from "./ScheduledFollowups";
import {
  formatScheduleTime,
  scheduleAccountLabel,
  scheduleModelLabel,
  scheduleRecurrenceLabel,
  scheduleRunIssuePresentation,
} from "./schedulePresentation";

export interface ScheduledFollowupNoticesProps {
  readonly context: ScheduledFollowupsContext;
  readonly schedules: readonly ScheduledFollowupRecord[];
  readonly loading?: boolean;
  readonly error?: string | null;
  /** Opens the existing owner review surface; this is never execution consent. */
  readonly onReview: (record: ScheduledFollowupRecord) => void;
  readonly onRefresh?: () => void;
}

// Keep the conversation tail small even when a chat owns the maximum number of
// saved schedules. Pagination makes every record reachable without retaining a
// second expanding transcript or adding work proportional to message history.
const PAGE_SIZE = 3;
const STATE_LABELS: Record<ScheduledFollowupRecord["state"], string> = {
  pending_confirmation: "Needs your approval",
  active: "Scheduled",
  paused: "Paused",
  needs_attention: "Needs attention",
  completed: "Finished",
  deleted: "Deleted",
};

/**
 * A read-only conversation projection of server-saved schedules. In particular,
 * neither assistant text nor opening this notice can authorize a paid turn.
 * The caller owns the shared read projection and the separate owner editor;
 * this component intentionally has no scheduler, provider, or mutation API.
 */
export const ScheduledFollowupNotices = memo(function ScheduledFollowupNotices({
  context,
  schedules,
  loading = false,
  error = null,
  onReview,
  onRefresh,
}: ScheduledFollowupNoticesProps) {
  const scope = JSON.stringify([context.environmentId, context.threadId]);
  const [pagination, setPagination] = useState({ scope, page: 0 });
  const records = useMemo(
    () =>
      schedules
        // The shared resource is already thread-scoped. Retain this admission at
        // the presentation boundary so a stale caller cannot show another chat's
        // title or review action while its next read is being hydrated.
        .filter((record) => record.threadId === context.threadId && record.state !== "deleted")
        .toSorted((left, right) => {
          const approvalOrder =
            Number(right.state === "pending_confirmation") -
            Number(left.state === "pending_confirmation");
          // Contract timestamps are canonical UTC, so lexical ordering is exact.
          // The opaque id breaks ties without relying on a changing server order.
          return (
            approvalOrder ||
            right.updatedAt.localeCompare(left.updatedAt) ||
            left.id.localeCompare(right.id)
          );
        }),
    [schedules, context.threadId],
  );
  const pageCount = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
  const currentPage = pagination.scope === scope ? Math.min(pagination.page, pageCount - 1) : 0;
  const pendingCount = records.filter((record) => record.state === "pending_confirmation").length;
  // Loading keeps rows non-reviewable (a review must resolve a fresh revision),
  // but only a failed read or a disconnect labels them "last known".
  const lastKnown = context.unavailable || Boolean(error);
  const stale = lastKnown || loading;
  const showRefreshSpinner = useDelayedFlag(loading && records.length > 0);

  // An empty chat keeps its ordinary layout, including while its first read is
  // in flight: no "Loading…" line that appears and disappears on every chat
  // open. Failed reads remain discoverable and retryable.
  if (records.length === 0 && !error) return null;

  return (
    <section
      aria-label="Scheduled follow-up notices"
      aria-busy={loading}
      className="min-w-0 space-y-2 py-3"
      data-scheduled-followup-notices="true"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Clock3Icon aria-hidden="true" className="size-3.5" />
          Scheduled follow-ups
          {showRefreshSpinner ? (
            <Spinner aria-label="Refreshing schedules" className="size-3 text-subtle-foreground" />
          ) : null}
        </h3>
        {pendingCount > 0 ? (
          <Button
            variant="ghost"
            size="xs"
            className="text-primary"
            onClick={() => setPagination({ scope, page: 0 })}
          >
            <span aria-live="polite">{pendingCount} awaiting approval</span>
          </Button>
        ) : null}
      </div>
      {lastKnown ? (
        <div
          role="status"
          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
        >
          <p>
            {context.unavailable
              ? "Disconnected. Schedule status may be out of date."
              : "Couldn’t refresh. Schedule status may be out of date."}
          </p>
          {onRefresh ? (
            <Button
              variant="ghost"
              size="xs"
              disabled={context.unavailable || loading}
              onClick={onRefresh}
            >
              <RefreshCwIcon aria-hidden="true" className="size-3" />
              Refresh schedules
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="space-y-2">
        {records.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map((record) => (
          <ScheduledFollowupNoticeCard
            key={record.id}
            record={record}
            context={context}
            lastKnown={lastKnown}
            stale={stale}
            onReview={onReview}
          />
        ))}
      </div>
      {pageCount > 1 ? (
        <nav
          aria-label="Scheduled follow-up pages"
          className="flex min-w-0 flex-wrap items-center justify-between gap-1"
        >
          <Button
            variant="ghost"
            size="xs"
            disabled={currentPage === 0}
            onClick={() => setPagination({ scope, page: currentPage - 1 })}
          >
            Previous
          </Button>
          <span role="status" className="text-2xs text-subtle-foreground">
            {currentPage + 1} / {pageCount} · {records.length} follow-ups
          </span>
          <Button
            variant="ghost"
            size="xs"
            disabled={currentPage + 1 === pageCount}
            onClick={() => setPagination({ scope, page: currentPage + 1 })}
          >
            More follow-ups
          </Button>
        </nav>
      ) : null}
    </section>
  );
});

/**
 * One saved schedule. Name, state and timing stay visible; model, account and
 * time zone sit behind a Details toggle. Approval and account-change notices
 * are disclosures at the point of action, so they always stay visible.
 */
function ScheduledFollowupNoticeCard({
  record,
  context,
  lastKnown,
  stale,
  onReview,
}: {
  readonly record: ScheduledFollowupRecord;
  readonly context: ScheduledFollowupsContext;
  readonly lastKnown: boolean;
  readonly stale: boolean;
  readonly onReview: (record: ScheduledFollowupRecord) => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();
  const pending = record.state === "pending_confirmation";
  const issue = scheduleRunIssuePresentation(record.lastRun);
  const selection = record.modelSelection ?? context.modelSelection;
  const accountMatches = record.authorizedInstanceId === context.modelSelection.instanceId;
  return (
    <article
      aria-label={`Scheduled follow-up notice: ${record.name}`}
      className={cn(
        "min-w-0 rounded-xl border p-3",
        pending ? "border-primary/30 bg-primary/5" : "border-border-subtle bg-card",
      )}
    >
      <p className={cn("text-xs font-medium", pending ? "text-primary" : "text-muted-foreground")}>
        {lastKnown ? "Last known: " : ""}
        {STATE_LABELS[record.state]}
      </p>
      <h4 className="mt-1 break-words text-sm font-medium [overflow-wrap:anywhere]">
        {record.name}
      </h4>
      {pending ? (
        <p className="mt-1 text-xs text-muted-foreground">Won’t run until you approve.</p>
      ) : record.state === "needs_attention" ? (
        <div className="mt-1 space-y-1 text-xs text-muted-foreground">
          {issue ? <p>{issue.reason}</p> : null}
          <p>{issue?.action ?? "Review its run history before enabling it again."}</p>
        </div>
      ) : null}
      <p className="mt-2 break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
        {scheduleRecurrenceLabel(record)}
        {record.recurrence.kind === "once"
          ? ` · Planned: ${formatScheduleTime(record.recurrence.at)}`
          : null}
      </p>
      {record.state === "active" && record.nextRunAt ? (
        <p className="mt-1 break-words text-xs text-primary [overflow-wrap:anywhere]">
          {lastKnown ? "Last reported next run: " : "Next: "}
          {formatScheduleTime(record.nextRunAt)}
        </p>
      ) : null}
      {!accountMatches ? (
        <p className="mt-1 text-xs text-status-attention-foreground">
          Account changed; review before enabling
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <Button
          variant={pending ? "outline" : "ghost"}
          size="sm"
          aria-label={`Review schedule: ${record.name}`}
          disabled={stale}
          onClick={() => onReview(record)}
        >
          Review schedule
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          aria-expanded={detailsOpen}
          aria-controls={detailsId}
          onClick={() => setDetailsOpen((open) => !open)}
        >
          Details
          <ChevronRightIcon
            aria-hidden="true"
            className={cn(
              "size-3.5 transition-transform duration-(--duration-fast) ease-out",
              detailsOpen && "rotate-90",
            )}
          />
        </Button>
      </div>
      {detailsOpen ? (
        <dl
          id={detailsId}
          className="mt-1 space-y-0.5 break-words text-2xs text-muted-foreground [overflow-wrap:anywhere] animate-enter-rise"
        >
          <div>
            <dt className="sr-only">Model</dt>
            <dd>
              {record.modelSelection
                ? scheduleModelLabel(selection)
                : `Uses chat settings · ${scheduleModelLabel(selection)}`}
            </dd>
          </div>
          <div>
            <dt className="sr-only">Account</dt>
            <dd>
              Account:{" "}
              {scheduleAccountLabel(
                { ...selection, instanceId: record.authorizedInstanceId },
                context.provider,
              )}
            </dd>
          </div>
          <div>
            <dt className="sr-only">Schedule timezone</dt>
            <dd>Schedule timezone: {record.recurrence.timeZone}</dd>
          </div>
        </dl>
      ) : null}
    </article>
  );
}
