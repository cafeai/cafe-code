import {
  type EnvironmentId,
  type EnvironmentApi,
  type ProviderDriverKind,
  type ServerProviderSkill,
  type ThreadId,
  type TurnId,
} from "@cafecode/contracts";
import {
  ArrowLeftIcon,
  FilePenLineIcon,
  FileSearchIcon,
  MessageSquareIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { formatElapsed, type WorkLogEntry } from "../../session-logic";
import ChatMarkdown from "../ChatMarkdown";
import { SubagentAvatar } from "../subagents/SubagentAvatar";
import { SUBAGENT_STATUS_UNAVAILABLE_DETAIL } from "../subagents/SubagentRosterRow";
import { cn } from "~/lib/utils";
import { useChatPane } from "../../chatPaneContext";
import { useDelayedFlag } from "../../hooks/useDelayedFlag";
import { Button } from "../ui/button";
import { InfoTip } from "../ui/info-tip";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import { SubagentTaskControls } from "./SubagentTaskControls";

type SubagentWorkEntry = WorkLogEntry & {
  readonly subagent: NonNullable<WorkLogEntry["subagent"]>;
};

export interface SubagentDetailSelection {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly rowId: string;
  readonly turnId: TurnId | null;
  readonly workEntry: SubagentWorkEntry;
}

interface SubagentDetailViewProps {
  readonly selection: SubagentDetailSelection;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly provider: ProviderDriverKind | null;
  readonly markdownCwd: string | undefined;
  readonly additionalWorkspaceRoots: ReadonlyArray<string>;
  readonly skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  readonly backButtonRef: RefObject<HTMLButtonElement | null>;
  readonly onBack: () => void;
}

type LoadedSubagentDetail = Awaited<
  ReturnType<EnvironmentApi["orchestration"]["getThreadTurnSubagentDetail"]>
>;

const EMPTY_SUBAGENT_DETAIL_MESSAGES: LoadedSubagentDetail["messages"] = [];
const EMPTY_SUBAGENT_DETAIL_GAPS: LoadedSubagentDetail["gaps"] = [];
const EMPTY_SUBAGENT_DETAIL_ACTIVITIES: NonNullable<LoadedSubagentDetail["activities"]> = [];
const SUBAGENT_ACTIVITY_PRESENTATION = {
  command: { label: "Command", icon: TerminalIcon },
  file_read: { label: "File read", icon: FileSearchIcon },
  file_edit: { label: "File edit", icon: FilePenLineIcon },
  agent_message: { label: "Agent message", icon: MessageSquareIcon },
  tool: { label: "Tool use", icon: WrenchIcon },
} as const;

type DetailLoadState =
  | { readonly status: "idle" | "loading" }
  | {
      readonly status: "loaded";
      readonly detail: LoadedSubagentDetail;
      /**
       * A refresh failure must not erase the last authenticated snapshot, but
       * preserving it silently would present old provider text as current.
       * Keep the failure state beside that exact keyed snapshot so the user
       * can distinguish retained history from a successful live refresh.
       */
      readonly refreshStatus: "current" | "unavailable" | "retrying";
    }
  | {
      readonly status: "unavailable";
      /** API discovery must rebind the effect; provider read failures retry through its scheduler. */
      readonly retryMode: "rebind" | "scheduled";
    };

function isLiveStatus(status: SubagentWorkEntry["subagent"]["status"]): boolean {
  return status === "active" || status === "waiting";
}

function statusLabel(status: SubagentWorkEntry["subagent"]["status"]): string {
  switch (status) {
    case "waiting":
      return "Waiting";
    case "active":
      return "Working";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
    case "unknown":
      return "Status unavailable";
  }
}

const DETAIL_FOLLOW_THRESHOLD_PX = 48;
const DETAIL_REFRESH_MIN_INTERVAL_MS = 1_000;
const SUBAGENT_MESSAGE_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

type DetailRefreshRequest = { readonly immediate?: boolean };

/**
 * One selected worker owns at most one visibility-aware timer. Opening this
 * screen pauses the hidden list's shared clock, so the preserved scroll-state
 * tree and this live duration never leave two timer loops running together.
 */
function useDetailNow(enabled: boolean): string {
  const [now, setNow] = useState(() => new Date().toISOString());

  useEffect(() => {
    if (!enabled) return;
    let intervalId: number | null = null;
    const stop = () => {
      if (intervalId === null) return;
      window.clearInterval(intervalId);
      intervalId = null;
    };
    const start = () => {
      if (document.visibilityState !== "visible" || intervalId !== null) return;
      setNow(new Date().toISOString());
      intervalId = window.setInterval(() => setNow(new Date().toISOString()), 1_000);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };

    start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stop();
    };
  }, [enabled]);

  return now;
}

/**
 * Read-only, in-chat navigation for one provider child thread.
 *
 * The server validates the opaque child id against this exact Cafe
 * thread/turn before it reads Codex or Claude history. The browser receives
 * only bounded public user/assistant text, fixed activity categories, and
 * optional sanitized operation details admitted by the server. Details are
 * inert display text, never Markdown, navigable paths, or executable commands.
 * Provider reasoning, raw tool payloads/results, recipients, and raw errors
 * remain excluded. Category labels do not assert success.
 */
export function SubagentDetailView(props: SubagentDetailViewProps) {
  // The durable tuple, not the visible row/name or latest parent provider,
  // owns a transcript snapshot. Reusing a row for a newly resumed history
  // must synchronously discard its old text, including while the new read is
  // pending or unavailable. Presentation-only renames keep the same instance.
  const identity = JSON.stringify([
    props.environmentId,
    props.threadId,
    props.selection.turnId,
    props.selection.workEntry.subagent.id,
    props.selection.workEntry.subagent.historyId ?? null,
  ]);
  return <BoundSubagentDetailView key={identity} {...props} />;
}

function BoundSubagentDetailView({
  selection,
  environmentId,
  threadId,
  markdownCwd,
  additionalWorkspaceRoots,
  skills,
  backButtonRef,
  onBack,
}: SubagentDetailViewProps) {
  const pane = useChatPane();
  const { subagent } = selection.workEntry;
  const live = isLiveStatus(subagent.status);
  const now = useDetailNow(live);
  const [loadState, setLoadState] = useState<DetailLoadState>({ status: "idle" });
  const detailScrollRef = useRef<HTMLDivElement | null>(null);
  const followingTailRef = useRef(true);
  const initialTailPositionedRef = useRef(false);
  const priorTranscriptRevisionRef = useRef<string | null>(null);
  const refreshDetailRef = useRef<(request?: DetailRefreshRequest) => void>(() => undefined);
  const observedLifecycleRevisionRef = useRef(
    subagent.lifecycleRevision ?? subagent.updatedAt ?? subagent.completedAt ?? subagent.status,
  );
  const [newUpdateCount, setNewUpdateCount] = useState(0);
  const [retryRevision, setRetryRevision] = useState(0);
  // Fast history reads show nothing; slower ones show message-shaped
  // skeletons (style guide §9) rather than a spinner line.
  const showLoadingSkeleton = useDelayedFlag(loadState.status === "loading");

  useEffect(() => {
    if (!pane.active || !pane.visible) return;
    const frameId = window.requestAnimationFrame(() => backButtonRef.current?.focus());
    return () => window.cancelAnimationFrame(frameId);
  }, [backButtonRef, pane.active, pane.visible]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!pane.active || !pane.visible) return;
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      onBack();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onBack, pane.active, pane.visible]);

  useEffect(() => {
    // The parent may since have switched providers. The authenticated server
    // resolves the historical child's immutable provider binding; its response
    // is authoritative for transcript formatting and availability.
    if (threadId === null || selection.turnId === null) {
      setLoadState({ status: "idle" });
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      setLoadState({ status: "unavailable", retryMode: "rebind" });
      refreshDetailRef.current = () => undefined;
      return;
    }

    let cancelled = false;
    let inFlight = false;
    let trailingRefreshRequested = false;
    let trailingRefreshImmediate = false;
    let trailingTimerId: number | null = null;
    let lastRequestStartedAt = 0;
    setLoadState((current) => (current.status === "loaded" ? current : { status: "loading" }));
    const request = {
      threadId,
      turnId: selection.turnId,
      subagentId: subagent.id,
      ...(subagent.historyId ? { historyId: subagent.historyId } : {}),
    };
    const clearTrailingTimer = () => {
      if (trailingTimerId === null) return;
      window.clearTimeout(trailingTimerId);
      trailingTimerId = null;
    };
    const runRefresh = async (): Promise<void> => {
      trailingTimerId = null;
      if (cancelled) return;
      if (document.visibilityState !== "visible") {
        trailingRefreshRequested = true;
        return;
      }
      if (inFlight) {
        trailingRefreshRequested = true;
        return;
      }
      inFlight = true;
      lastRequestStartedAt = Date.now();
      try {
        const detail = await api.orchestration.getThreadTurnSubagentDetail(request);
        if (!cancelled) setLoadState({ status: "loaded", detail, refreshStatus: "current" });
      } catch {
        // Provider errors are intentionally opaque here: upstream responses
        // can include account, filesystem, or transport details. Retain the
        // last safe snapshot only within this keyed child-detail instance,
        // while marking it unavailable so stale text never appears current.
        if (!cancelled) {
          // React may evaluate a functional state update after this request's
          // finally block consumes the mutable trailing flag. Snapshot it now
          // so the visible retry state agrees with the scheduler decision.
          const trailingRefreshWillRun = trailingRefreshRequested;
          setLoadState((current) => {
            if (current.status === "loaded") {
              return {
                ...current,
                // If an invalidation arrived while this request was in
                // flight, the same scheduler will immediately run its one
                // trailing refresh. Keep Retry hidden until that attempt
                // settles so rapid input cannot grow a request chain.
                refreshStatus: trailingRefreshWillRun ? "retrying" : "unavailable",
              };
            }
            // An initial-history Retry can also arrive behind an automatic
            // lifecycle refresh. Preserve its loading state until the single
            // trailing attempt settles instead of exposing another Retry.
            return trailingRefreshWillRun && current.status === "loading"
              ? current
              : { status: "unavailable", retryMode: "scheduled" };
          });
        }
      } finally {
        inFlight = false;
      }
      if (trailingRefreshRequested && !cancelled) {
        const immediate = trailingRefreshImmediate;
        trailingRefreshRequested = false;
        trailingRefreshImmediate = false;
        scheduleRefresh({ immediate });
      }
    };
    const scheduleRefresh = ({ immediate = false }: DetailRefreshRequest = {}): void => {
      if (cancelled) return;
      if (document.visibilityState !== "visible") {
        trailingRefreshRequested = true;
        trailingRefreshImmediate ||= immediate;
        return;
      }
      if (inFlight) {
        trailingRefreshRequested = true;
        trailingRefreshImmediate ||= immediate;
        return;
      }
      if (immediate) {
        clearTrailingTimer();
        void runRefresh();
        return;
      }
      if (trailingTimerId !== null) return;
      const delay = Math.max(
        0,
        DETAIL_REFRESH_MIN_INTERVAL_MS - (Date.now() - lastRequestStartedAt),
      );
      if (delay === 0) {
        void runRefresh();
        return;
      }
      trailingTimerId = window.setTimeout(() => void runRefresh(), delay);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        trailingRefreshRequested = false;
        trailingRefreshImmediate = false;
        scheduleRefresh({ immediate: true });
      }
    };

    refreshDetailRef.current = scheduleRefresh;
    document.addEventListener("visibilitychange", onVisibilityChange);
    // Identity/setup changes own their initial read. Relying only on lifecycle
    // metadata would miss a switch between two workers whose timestamps and
    // statuses happen to be identical.
    scheduleRefresh({ immediate: true });
    return () => {
      cancelled = true;
      clearTrailingTimer();
      refreshDetailRef.current = () => undefined;
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [environmentId, retryRevision, selection.turnId, subagent.historyId, subagent.id, threadId]);

  useEffect(() => {
    const revision =
      subagent.lifecycleRevision ?? subagent.updatedAt ?? subagent.completedAt ?? subagent.status;
    if (observedLifecycleRevisionRef.current === revision) return;
    observedLifecycleRevisionRef.current = revision;
    const terminal =
      subagent.status === "completed" ||
      subagent.status === "failed" ||
      subagent.status === "stopped";
    // Provider lifecycle edges invalidate the transcript. Ordinary progress is
    // rate-capped to protect long histories from adversarial event frequency;
    // a terminal edge bypasses the delay so the final report appears promptly.
    refreshDetailRef.current({ immediate: terminal });
  }, [subagent.completedAt, subagent.lifecycleRevision, subagent.status, subagent.updatedAt]);

  useEffect(() => {
    initialTailPositionedRef.current = false;
    followingTailRef.current = true;
    priorTranscriptRevisionRef.current = null;
    setNewUpdateCount(0);
  }, [environmentId, selection.turnId, subagent.id, threadId]);

  const elapsed =
    subagent.status === "unknown"
      ? null
      : formatElapsed(subagent.startedAt, live ? now : subagent.completedAt);
  const primaryDescription =
    subagent.description ?? subagent.objective ?? statusLabel(subagent.status);
  const messages =
    loadState.status === "loaded" ? loadState.detail.messages : EMPTY_SUBAGENT_DETAIL_MESSAGES;
  const activities =
    loadState.status === "loaded"
      ? (loadState.detail.activities ?? EMPTY_SUBAGENT_DETAIL_ACTIVITIES)
      : EMPTY_SUBAGENT_DETAIL_ACTIVITIES;
  const keyedMessages = useMemo(
    () => messages.map((message) => ({ key: message.key, message })),
    [messages],
  );
  const lastAssistantIndex = useMemo(
    () => keyedMessages.findLastIndex(({ message }) => message.role === "assistant"),
    [keyedMessages],
  );
  const transcriptGaps =
    loadState.status === "loaded" ? loadState.detail.gaps : EMPTY_SUBAGENT_DETAIL_GAPS;
  const transcriptGapByAnchor = useMemo(
    () => new Map(transcriptGaps.map((gap) => [gap.afterMessageKey, gap])),
    [transcriptGaps],
  );
  const leadingTranscriptGap = transcriptGapByAnchor.get(null);
  const transcriptRevision = useMemo(() => {
    if (loadState.status !== "loaded") return null;
    const last = loadState.detail.messages.at(-1);
    return JSON.stringify([
      loadState.detail.messages.length,
      last?.key ?? null,
      last?.text ?? null,
      last?.omission?.tail ?? null,
      loadState.detail.gaps,
      loadState.detail.truncated,
      // Tool-only work can advance while public messages are unchanged. Keep
      // it on the same follow/jump lane without adding another refresh timer.
      loadState.detail.activities,
      loadState.detail.activityHistoryIncomplete,
    ]);
  }, [loadState]);

  useLayoutEffect(() => {
    const scroller = detailScrollRef.current;
    if (!scroller || transcriptRevision === null) return;
    const priorRevision = priorTranscriptRevisionRef.current;
    priorTranscriptRevisionRef.current = transcriptRevision;
    if (!initialTailPositionedRef.current) {
      initialTailPositionedRef.current = true;
      followingTailRef.current = true;
      scroller.scrollTop = scroller.scrollHeight;
      setNewUpdateCount(0);
      return;
    }
    if (priorRevision === transcriptRevision) return;
    if (followingTailRef.current) {
      scroller.scrollTop = scroller.scrollHeight;
      setNewUpdateCount(0);
    } else {
      setNewUpdateCount((count) => count + 1);
    }
  }, [transcriptRevision]);

  return (
    <section
      className="absolute inset-0 z-40 flex min-h-0 min-w-0 flex-col overflow-hidden bg-background animate-enter-from-end"
      aria-label={`Subagent detail: ${subagent.label}`}
      data-subagent-detail-view="true"
    >
      <header className="shrink-0 border-b border-border-subtle bg-background/95 px-3 py-2.5 backdrop-blur sm:px-5 sm:py-3">
        <div className="mx-auto flex w-full max-w-3xl min-w-0 items-center gap-2.5">
          <button
            ref={backButtonRef}
            type="button"
            className="-ml-1 inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-(--duration-fast) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            aria-label="Back to conversation"
            onClick={onBack}
          >
            <ArrowLeftIcon className="size-5" />
          </button>
          <SubagentAvatar seed={subagent.id} className="size-8 shrink-0 sm:size-9" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-medium text-foreground sm:text-base">
              {subagent.label}
            </h2>
            <p
              className={cn(
                "flex items-center gap-1 text-2xs font-medium",
                subagent.status === "failed"
                  ? "text-destructive-foreground"
                  : live
                    ? "text-primary"
                    : "text-muted-foreground",
              )}
              data-subagent-detail-status="true"
            >
              {statusLabel(subagent.status)}
              {subagent.status === "unknown" ? (
                <InfoTip label="About this status" side="bottom">
                  {SUBAGENT_STATUS_UNAVAILABLE_DETAIL}
                </InfoTip>
              ) : null}
            </p>
          </div>
        </div>
      </header>
      {threadId && selection.turnId && (
        <SubagentTaskControls
          key={subagent.taskControl?.taskGeneration ?? subagent.id}
          environmentId={environmentId}
          threadId={threadId}
          turnId={selection.turnId}
          subagent={subagent}
        />
      )}

      <div
        ref={detailScrollRef}
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain px-3 py-4 [scrollbar-gutter:stable] sm:px-5 sm:py-6"
        data-subagent-detail-scroll="true"
        data-subagent-detail-following={followingTailRef.current ? "true" : "false"}
        onScroll={(event) => {
          const node = event.currentTarget;
          const atTail =
            node.scrollHeight - node.scrollTop - node.clientHeight <= DETAIL_FOLLOW_THRESHOLD_PX;
          followingTailRef.current = atTail;
          if (atTail) setNewUpdateCount(0);
        }}
      >
        <div className="mx-auto w-full min-w-0 max-w-3xl space-y-5 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
          <section className="min-w-0 rounded-xl border border-border-subtle bg-card p-3 sm:p-4">
            <p className="label-overline">Current work</p>
            <p className="mt-1.5 text-sm leading-5 text-foreground break-words">
              {primaryDescription}
            </p>
            {subagent.objective && subagent.objective !== primaryDescription ? (
              <p className="mt-2 text-xs leading-5 text-muted-foreground break-words">
                {subagent.objective}
              </p>
            ) : null}
            {elapsed ? (
              <p
                className="mt-3 border-t border-border-subtle pt-2 font-mono text-2xs text-subtle-foreground tabular-nums"
                data-subagent-detail-elapsed="true"
              >
                {live ? "Working" : "Worked"} for {elapsed}
              </p>
            ) : null}
          </section>

          {loadState.status === "loading" ? (
            <div role="status" data-subagent-detail-loading="true">
              <span className="sr-only">Loading subagent history…</span>
              {showLoadingSkeleton ? (
                <div aria-hidden="true" className="space-y-5 animate-enter-fade">
                  <Skeleton className="h-16 rounded-xl" />
                  <div className="space-y-2">
                    <Skeleton className="h-3 w-20" />
                    <Skeleton className="h-3 w-full" />
                    <Skeleton className="h-3 w-4/5" />
                  </div>
                  <div className="space-y-2">
                    <Skeleton className="h-3 w-16" />
                    <Skeleton className="h-3 w-11/12" />
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {leadingTranscriptGap ? <TranscriptGap gap={leadingTranscriptGap} /> : null}

          {keyedMessages.map(({ key, message }, index) => {
            const isFinalResult =
              !live && message.role === "assistant" && index === lastAssistantIndex;
            const messageLabel =
              message.role === "user"
                ? "Assignment"
                : message.phase === "final_answer"
                  ? "Final reply"
                  : message.phase === "commentary"
                    ? "Update"
                    : isFinalResult
                      ? "Result"
                      : "Update";
            const followingGap = transcriptGapByAnchor.get(message.key);
            return (
              <Fragment key={key}>
                <section
                  className={cn(
                    "min-w-0",
                    message.role === "user" &&
                      "rounded-xl border border-border-subtle bg-muted/40 px-3 py-3 sm:px-4",
                  )}
                  data-subagent-detail-message={message.role}
                  data-subagent-detail-message-key={message.key}
                >
                  <div className="mb-2 flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-subtle-foreground">
                    <p className="text-2xs font-medium">{messageLabel}</p>
                    {message.timestamp ? (
                      <time
                        className="max-w-full text-right font-mono text-2xs tabular-nums break-words"
                        dateTime={message.timestamp}
                      >
                        {SUBAGENT_MESSAGE_TIMESTAMP_FORMATTER.format(new Date(message.timestamp))}
                      </time>
                    ) : null}
                  </div>
                  <div className="min-w-0 text-sm leading-6 break-words">
                    <ChatMarkdown
                      text={message.text}
                      cwd={markdownCwd}
                      additionalWorkspaceRoots={additionalWorkspaceRoots}
                      normalizeCodexCitations={
                        loadState.status === "loaded" && loadState.detail.provider === "codex"
                      }
                      skills={skills}
                    />
                    {message.omission ? (
                      <>
                        <p
                          className="my-3 border-border-subtle border-y py-2 text-2xs leading-5 text-subtle-foreground"
                          role="note"
                          data-subagent-detail-content-omission="true"
                        >
                          {message.omission.omittedUtf8Bytes.toLocaleString()} bytes omitted from
                          the middle of this update.
                        </p>
                        {/* The tail is a separate Markdown document so a cut
                            code fence or link in the head cannot change how the
                            newest provider text is parsed. */}
                        <ChatMarkdown
                          text={message.omission.tail}
                          cwd={markdownCwd}
                          additionalWorkspaceRoots={additionalWorkspaceRoots}
                          normalizeCodexCitations={
                            loadState.status === "loaded" && loadState.detail.provider === "codex"
                          }
                          skills={skills}
                        />
                      </>
                    ) : null}
                  </div>
                </section>
                {followingGap ? <TranscriptGap gap={followingGap} /> : null}
              </Fragment>
            );
          })}

          {loadState.status === "loaded" &&
          (activities.length > 0 || loadState.detail.activityHistoryIncomplete === true) ? (
            <section
              aria-label="Subagent activity"
              className="min-w-0 border-t border-border-subtle pt-4"
            >
              <h3 className="mb-2 text-2xs font-medium text-subtle-foreground">Activity</h3>
              {/* Provider times can be absent. Keep this bounded activity tail
                  in its supplied order instead of inventing chronology among
                  the separately retained public messages above. The optional
                  detail is a separately bounded, sanitized display projection,
                  never a raw tool payload or authority to open/run anything. */}
              <ol className="space-y-1" aria-label="Recorded activity">
                {activities.map((activity) => {
                  const { label, icon: Icon } = SUBAGENT_ACTIVITY_PRESENTATION[activity.kind];
                  return (
                    <li
                      key={activity.key}
                      data-subagent-detail-activity={activity.kind}
                      className="min-w-0 py-1.5 text-xs text-muted-foreground"
                    >
                      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                        <span className="inline-flex min-w-0 items-center gap-2">
                          <Icon
                            aria-hidden="true"
                            className="size-3.5 shrink-0 text-subtle-foreground"
                          />
                          {label}
                        </span>
                        {activity.timestamp ? (
                          <time
                            dateTime={activity.timestamp}
                            className="max-w-full text-right font-mono text-2xs tabular-nums break-words text-subtle-foreground"
                          >
                            {SUBAGENT_MESSAGE_TIMESTAMP_FORMATTER.format(
                              new Date(activity.timestamp),
                            )}
                          </time>
                        ) : null}
                      </div>
                      {activity.detail ? (
                        // Preserve the full bounded detail for selection and
                        // assistive technology. Wrapping long tokens avoids a
                        // nested scrollbar or a hover-only truncated command.
                        <code
                          data-subagent-detail-activity-detail="true"
                          className="mt-1 block min-w-0 pl-5.5 font-mono text-2xs leading-5 whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]"
                        >
                          {activity.detail}
                        </code>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
              {loadState.detail.activityHistoryIncomplete === true ? (
                <p
                  role="note"
                  data-subagent-detail-activity-incomplete="true"
                  className="mt-2 text-2xs leading-5 text-subtle-foreground"
                >
                  Some activity couldn’t be loaded.
                </p>
              ) : null}
            </section>
          ) : null}

          {loadState.status === "unavailable" ? (
            <div
              className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border-subtle bg-card px-3 py-2.5 text-xs leading-5 text-muted-foreground animate-enter-fade"
              role="status"
              data-subagent-detail-unavailable="true"
            >
              <p>Transcript unavailable.</p>
              <Button
                type="button"
                size="xs"
                variant="outline"
                data-subagent-detail-retry="true"
                onClick={() => {
                  setLoadState({ status: "loading" });
                  if (loadState.retryMode === "rebind") {
                    // The environment API did not exist when this keyed view
                    // mounted, so there is no scheduler to reuse yet.
                    setRetryRevision((revision) => revision + 1);
                  } else {
                    refreshDetailRef.current({ immediate: true });
                  }
                }}
              >
                Retry
              </Button>
            </div>
          ) : null}

          {loadState.status === "loaded" && loadState.refreshStatus !== "current" ? (
            <div
              className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border-subtle bg-card px-3 py-2.5 text-xs leading-5 text-muted-foreground animate-enter-fade"
              role="status"
              data-subagent-detail-refresh-unavailable="true"
            >
              <p>Couldn’t refresh. Showing the last loaded transcript.</p>
              {loadState.refreshStatus === "retrying" ? (
                <span className="inline-flex items-center gap-1.5 text-foreground">
                  <Spinner aria-hidden="true" role={undefined} className="size-3.5" />
                  Retrying…
                </span>
              ) : (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  data-subagent-detail-retry="true"
                  onClick={() => {
                    // Retain the authenticated snapshot while retrying. The
                    // keyed detail instance guarantees it belongs to this
                    // exact child/turn/history identity.
                    setLoadState((current) =>
                      current.status === "loaded"
                        ? { ...current, refreshStatus: "retrying" }
                        : current,
                    );
                    // Reuse the mounted request coalescer. Remounting this
                    // effect would abandon its in-flight flag without
                    // cancelling the provider RPC and permit a parallel read.
                    refreshDetailRef.current({ immediate: true });
                  }}
                >
                  Retry
                </Button>
              )}
            </div>
          ) : null}

          {loadState.status === "loaded" && messages.length === 0 && activities.length === 0 ? (
            <p className="text-xs leading-5 text-muted-foreground" role="status">
              No messages yet.
            </p>
          ) : null}

          {loadState.status === "loaded" && loadState.detail.historyIncomplete === true ? (
            <p
              className="rounded-lg border border-dashed border-border-subtle px-3 py-2 text-center text-2xs leading-5 text-subtle-foreground"
              role="note"
              data-subagent-detail-history-incomplete="true"
            >
              Some messages couldn’t be loaded.
            </p>
          ) : null}

          {loadState.status === "loaded" &&
          loadState.detail.truncated &&
          loadState.detail.historyIncomplete !== true &&
          loadState.detail.gaps.length === 0 &&
          !messages.some((message) => message.omission) ? (
            <p className="text-2xs leading-5 text-subtle-foreground" role="note">
              Older messages hidden.
            </p>
          ) : null}
        </div>
      </div>
      {newUpdateCount > 0 ? (
        <button
          type="button"
          className="absolute right-4 bottom-4 z-10 rounded-full border border-border bg-raised px-3 py-1.5 text-xs text-foreground shadow-sm transition-colors duration-(--duration-fast) hover:bg-accent animate-enter-rise"
          data-subagent-detail-jump-to-latest="true"
          onClick={() => {
            const scroller = detailScrollRef.current;
            if (scroller) scroller.scrollTop = scroller.scrollHeight;
            followingTailRef.current = true;
            setNewUpdateCount(0);
          }}
        >
          {newUpdateCount} new {newUpdateCount === 1 ? "update" : "updates"} · Jump to latest
        </button>
      ) : null}
    </section>
  );
}

function TranscriptGap(props: { readonly gap: LoadedSubagentDetail["gaps"][number] }) {
  return (
    <p
      className="rounded-lg border border-dashed border-border-subtle px-3 py-2 text-center text-2xs leading-5 text-subtle-foreground"
      role="note"
      data-subagent-detail-gap="true"
    >
      {props.gap.omittedMessages.toLocaleString()} intermediate{" "}
      {props.gap.omittedMessages === 1 ? "update" : "updates"} omitted
      {props.gap.omittedUtf8Bytes > 0
        ? ` (${props.gap.omittedUtf8Bytes.toLocaleString()} bytes)`
        : ""}
    </p>
  );
}
