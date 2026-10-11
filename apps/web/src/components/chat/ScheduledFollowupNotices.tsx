import { useUiLocale, useUiPresentation } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { UiMessage } from "~/i18n";
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
  get pending_confirmation() {
    return uiText("Needs your approval");
  },
  get active() {
    return uiText("Scheduled");
  },
  get paused() {
    return uiText("Paused");
  },
  get needs_attention() {
    return uiText("Needs attention");
  },
  get completed() {
    return uiText("Finished");
  },
  get deleted() {
    return uiText("Deleted");
  },
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
  const uiLocale = useUiLocale();

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
      aria-label={uiText("Scheduled follow-up notices", undefined, undefined, uiLocale)}
      aria-busy={loading}
      className="min-w-0 space-y-2 py-3"
      data-scheduled-followup-notices="true"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <UiMessage
            message={"<slot1></slot1>Scheduled follow-ups<slot3></slot3>"}
            slots={{
              slot1: <Clock3Icon aria-hidden="true" className="size-3.5" />,
              slot3: showRefreshSpinner ? (
                <Spinner
                  aria-label={uiText("Refreshing schedules", undefined, undefined, uiLocale)}
                  className="size-3 text-subtle-foreground"
                />
              ) : null,
            }}
          />
        </h3>
        {pendingCount > 0 ? (
          <Button
            variant="ghost"
            size="xs"
            className="text-primary"
            onClick={() => setPagination({ scope, page: 0 })}
          >
            <span aria-live="polite">
              <UiMessage
                message={"<slot0></slot0> awaiting approval"}
                slots={{ slot0: pendingCount }}
              />
            </span>
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
              ? uiText(
                  "Disconnected. Schedule status may be out of date.",
                  undefined,
                  undefined,
                  uiLocale,
                )
              : uiText(
                  "Couldn’t refresh. Schedule status may be out of date.",
                  undefined,
                  undefined,
                  uiLocale,
                )}
          </p>
          {onRefresh ? (
            <Button
              variant="ghost"
              size="xs"
              disabled={context.unavailable || loading}
              onClick={onRefresh}
            >
              <RefreshCwIcon aria-hidden="true" className="size-3" />
              {uiText("Refresh schedules", undefined, undefined, uiLocale)}
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
          aria-label={uiText("Scheduled follow-up pages", undefined, undefined, uiLocale)}
          className="flex min-w-0 flex-wrap items-center justify-between gap-1"
        >
          <Button
            variant="ghost"
            size="xs"
            disabled={currentPage === 0}
            onClick={() => setPagination({ scope, page: currentPage - 1 })}
          >
            {uiText("Previous", undefined, undefined, uiLocale)}
          </Button>
          <span role="status" className="text-2xs text-subtle-foreground">
            {uiText(
              "{page} / {pages} · {count, plural, one {{count} follow-up} other {{count} follow-ups}}",
              { page: currentPage + 1, pages: pageCount, count: records.length },
              undefined,
              uiLocale,
            )}
          </span>
          <Button
            variant="ghost"
            size="xs"
            disabled={currentPage + 1 === pageCount}
            onClick={() => setPagination({ scope, page: currentPage + 1 })}
          >
            {uiText("More follow-ups", undefined, undefined, uiLocale)}
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
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();
  const pending = record.state === "pending_confirmation";
  const issue = uiPresentation.scheduleRunIssuePresentation(record.lastRun);
  const selection = record.modelSelection ?? context.modelSelection;
  const accountMatches = record.authorizedInstanceId === context.modelSelection.instanceId;
  return (
    <article
      aria-label={uiText(
        "Scheduled follow-up notice: {value0}",
        { value0: record.name },
        undefined,
        uiLocale,
      )}
      className={cn(
        "min-w-0 rounded-xl border p-3",
        pending ? "border-primary/30 bg-primary/5" : "border-border-subtle bg-card",
      )}
    >
      <p className={cn("text-xs font-medium", pending ? "text-primary" : "text-muted-foreground")}>
        {lastKnown
          ? uiText(
              "Last known: {status}",
              { status: uiPresentation.STATE_LABELS[record.state] },
              undefined,
              uiLocale,
            )
          : uiPresentation.STATE_LABELS[record.state]}
      </p>
      <h4 className="mt-1 break-words text-sm font-medium [overflow-wrap:anywhere]">
        {record.name}
      </h4>
      {pending ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {uiText("Won’t run until you approve.", undefined, undefined, uiLocale)}
        </p>
      ) : record.state === "needs_attention" ? (
        <div className="mt-1 space-y-1 text-xs text-muted-foreground">
          {issue ? <p>{issue.reason}</p> : null}
          <p>
            {issue?.action ??
              uiText(
                "Review its run history before enabling it again.",
                undefined,
                undefined,
                uiLocale,
              )}
          </p>
        </div>
      ) : null}
      <p className="mt-2 break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
        {record.recurrence.kind === "once"
          ? uiText(
              "{recurrence} · Planned: {time}",
              {
                recurrence: uiPresentation.scheduleRecurrenceLabel(record),
                time: uiPresentation.formatScheduleTime(record.recurrence.at),
              },
              undefined,
              uiLocale,
            )
          : uiPresentation.scheduleRecurrenceLabel(record)}
      </p>
      {record.state === "active" && record.nextRunAt ? (
        <p className="mt-1 break-words text-xs text-primary [overflow-wrap:anywhere]">
          {lastKnown
            ? uiText(
                "Last reported next run: {time}",
                {
                  time: uiPresentation.formatScheduleTime(record.nextRunAt),
                },
                undefined,
                uiLocale,
              )
            : uiText(
                "Next: {time}",
                { time: uiPresentation.formatScheduleTime(record.nextRunAt) },
                undefined,
                uiLocale,
              )}
        </p>
      ) : null}
      {!accountMatches ? (
        <p className="mt-1 text-xs text-status-attention-foreground">
          {uiText("Account changed; review before enabling", undefined, undefined, uiLocale)}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <Button
          variant={pending ? "outline" : "ghost"}
          size="sm"
          aria-label={uiText(
            "Review schedule: {value0}",
            { value0: record.name },
            undefined,
            uiLocale,
          )}
          disabled={stale}
          onClick={() => onReview(record)}
        >
          {uiText("Review schedule", undefined, undefined, uiLocale)}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          aria-expanded={detailsOpen}
          aria-controls={detailsId}
          onClick={() => setDetailsOpen((open) => !open)}
        >
          {uiText("Details", undefined, undefined, uiLocale)}
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
            <dt className="sr-only">{uiText("Model", undefined, undefined, uiLocale)}</dt>
            <dd>
              {record.modelSelection
                ? uiPresentation.scheduleModelLabel(selection)
                : uiText(
                    "Uses chat settings · {value0}",
                    {
                      value0: uiPresentation.scheduleModelLabel(selection),
                    },
                    undefined,
                    uiLocale,
                  )}
            </dd>
          </div>
          <div>
            <dt className="sr-only">{uiText("Account", undefined, undefined, uiLocale)}</dt>
            <dd>
              {uiText(
                "Account: {account}",
                {
                  account: scheduleAccountLabel(
                    { ...selection, instanceId: record.authorizedInstanceId },
                    context.provider,
                  ),
                },
                undefined,
                uiLocale,
              )}
            </dd>
          </div>
          <div>
            <dt className="sr-only">
              {uiText("Schedule timezone", undefined, undefined, uiLocale)}
            </dt>
            <dd>
              {uiText(
                "Schedule timezone: {timeZone}",
                { timeZone: record.recurrence.timeZone },
                undefined,
                uiLocale,
              )}
            </dd>
          </div>
        </dl>
      ) : null}
    </article>
  );
}

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = {
  STATE_LABELS,
  formatScheduleTime,
  scheduleModelLabel,
  scheduleRecurrenceLabel,
  scheduleRunIssuePresentation,
};
