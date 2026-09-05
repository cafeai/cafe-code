import {
  type EnvironmentId,
  type EnvironmentApi,
  type ProviderDriverKind,
  type ServerProviderSkill,
  type ThreadId,
  type TurnId,
} from "@cafecode/contracts";
import { ArrowLeftIcon, LoaderCircleIcon } from "lucide-react";
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
import { cn } from "~/lib/utils";

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

type DetailLoadState =
  | { readonly status: "idle" | "loading" }
  | { readonly status: "loaded"; readonly detail: LoadedSubagentDetail }
  | { readonly status: "unavailable" };

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
  }
}

const DETAIL_FOLLOW_THRESHOLD_PX = 48;
const DETAIL_REFRESH_MIN_INTERVAL_MS = 1_000;

type DetailRefreshRequest = { readonly immediate?: boolean };

function supportsSubagentTranscript(provider: ProviderDriverKind | null): boolean {
  return provider === "codex" || provider === "claudeAgent";
}

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
 * only bounded public user/assistant text; provider reasoning, tool payloads,
 * commands, paths, and raw errors never cross this boundary.
 */
export function SubagentDetailView({
  selection,
  environmentId,
  threadId,
  provider,
  markdownCwd,
  additionalWorkspaceRoots,
  skills,
  backButtonRef,
  onBack,
}: SubagentDetailViewProps) {
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

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => backButtonRef.current?.focus());
    return () => window.cancelAnimationFrame(frameId);
  }, [backButtonRef]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      onBack();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onBack]);

  useEffect(() => {
    if (!supportsSubagentTranscript(provider) || threadId === null || selection.turnId === null) {
      setLoadState({ status: "idle" });
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      setLoadState({ status: "unavailable" });
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
        if (!cancelled) setLoadState({ status: "loaded", detail });
      } catch {
        // Provider errors are intentionally opaque here: upstream responses
        // can include account, filesystem, or transport details. Retain the
        // last safe snapshot only within this keyed child-detail instance.
        if (!cancelled) {
          setLoadState((current) =>
            current.status === "loaded" ? current : { status: "unavailable" },
          );
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
  }, [
    environmentId,
    provider,
    retryRevision,
    selection.turnId,
    subagent.historyId,
    subagent.id,
    threadId,
  ]);

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

  const elapsed = formatElapsed(subagent.startedAt, live ? now : subagent.completedAt);
  const primaryDescription =
    subagent.description ??
    subagent.objective ??
    (subagent.status === "waiting" ? "Waiting to start" : "Working");
  const messages =
    loadState.status === "loaded" ? loadState.detail.messages : EMPTY_SUBAGENT_DETAIL_MESSAGES;
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
      className="absolute inset-0 z-40 flex min-h-0 min-w-0 flex-col overflow-hidden bg-background"
      aria-label={`Subagent detail: ${subagent.label}`}
      data-subagent-detail-view="true"
    >
      <header className="shrink-0 border-b border-border/55 bg-background/95 px-3 py-2.5 backdrop-blur sm:px-5 sm:py-3">
        <div className="mx-auto flex w-full max-w-3xl min-w-0 items-center gap-2.5">
          <button
            ref={backButtonRef}
            type="button"
            className="-ml-1 inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/55 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
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
                "text-[10px] font-medium uppercase tracking-[0.12em]",
                subagent.status === "failed"
                  ? "text-destructive/80"
                  : live
                    ? "text-sky-500"
                    : "text-muted-foreground/60",
              )}
            >
              {statusLabel(subagent.status)}
            </p>
          </div>
        </div>
      </header>

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
          <section className="min-w-0 rounded-xl border border-border/45 bg-card/25 p-3 sm:p-4">
            <p className="text-[9px] font-medium uppercase tracking-[0.16em] text-muted-foreground/55">
              Current work
            </p>
            <p className="mt-1.5 text-sm leading-5 text-foreground/90 break-words">
              {primaryDescription}
            </p>
            {subagent.objective && subagent.objective !== primaryDescription ? (
              <p className="mt-2 text-xs leading-5 text-muted-foreground/70 break-words">
                {subagent.objective}
              </p>
            ) : null}
            {elapsed ? (
              <p
                className="mt-3 border-t border-border/40 pt-2 font-mono text-[11px] text-muted-foreground/65 tabular-nums"
                data-subagent-detail-elapsed="true"
              >
                {live ? "Working" : "Worked"} for {elapsed}
              </p>
            ) : null}
          </section>

          {loadState.status === "loading" ? (
            <div
              className="flex items-center gap-2 py-3 text-sm text-muted-foreground/60"
              role="status"
            >
              <LoaderCircleIcon className="size-4 animate-spin" />
              Loading subagent history…
            </div>
          ) : null}

          {leadingTranscriptGap ? <TranscriptGap gap={leadingTranscriptGap} /> : null}

          {keyedMessages.map(({ key, message }, index) => {
            const isFinalResult =
              !live && message.role === "assistant" && index === lastAssistantIndex;
            const followingGap = transcriptGapByAnchor.get(message.key);
            return (
              <Fragment key={key}>
                <section
                  className={cn(
                    "min-w-0",
                    message.role === "user" &&
                      "rounded-xl border border-border/40 bg-muted/20 px-3 py-3 sm:px-4",
                  )}
                  data-subagent-detail-message={message.role}
                  data-subagent-detail-message-key={message.key}
                >
                  <p className="mb-2 text-[9px] font-medium uppercase tracking-[0.16em] text-muted-foreground/55">
                    {message.role === "user" ? "Assignment" : isFinalResult ? "Result" : "Update"}
                  </p>
                  <div className="min-w-0 text-sm leading-6 break-words">
                    <ChatMarkdown
                      text={message.text}
                      cwd={markdownCwd}
                      additionalWorkspaceRoots={additionalWorkspaceRoots}
                      normalizeCodexCitations={provider === "codex"}
                      skills={skills}
                    />
                    {message.omission ? (
                      <>
                        <p
                          className="my-3 border-border/45 border-y py-2 text-[11px] leading-5 text-muted-foreground/55"
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
                          normalizeCodexCitations={provider === "codex"}
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

          {loadState.status === "unavailable" ? (
            <div
              className="rounded-xl border border-border/40 bg-muted/15 px-3 py-3 text-xs leading-5 text-muted-foreground/65"
              role="status"
              data-subagent-detail-unavailable="true"
            >
              <p>
                The provider transcript is unavailable right now. The saved task summary and timing
                above remain available.
              </p>
              <button
                type="button"
                className="mt-2 rounded-md border border-border/55 bg-background/45 px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted/55 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                data-subagent-detail-retry="true"
                onClick={() => {
                  setLoadState({ status: "loading" });
                  setRetryRevision((revision) => revision + 1);
                }}
              >
                Retry
              </button>
            </div>
          ) : null}

          {loadState.status === "loaded" && messages.length === 0 ? (
            <p className="text-xs leading-5 text-muted-foreground/60" role="status">
              No public subagent messages were saved for this task. The task summary above is still
              available.
            </p>
          ) : null}

          {loadState.status === "loaded" &&
          loadState.detail.truncated &&
          loadState.detail.gaps.length === 0 &&
          !messages.some((message) => message.omission) ? (
            <p className="text-[11px] leading-5 text-muted-foreground/55" role="note">
              This long subagent history was shortened to keep the chat responsive.
            </p>
          ) : null}
        </div>
      </div>
      {newUpdateCount > 0 ? (
        <button
          type="button"
          className="absolute right-4 bottom-4 z-10 rounded-full border border-border/60 bg-card/95 px-3 py-1.5 text-xs text-foreground shadow-sm backdrop-blur"
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
      className="rounded-lg border border-dashed border-border/45 bg-muted/10 px-3 py-2 text-center text-[11px] leading-5 text-muted-foreground/55"
      role="note"
      data-subagent-detail-gap="true"
    >
      {props.gap.omittedMessages.toLocaleString()} intermediate{" "}
      {props.gap.omittedMessages === 1 ? "update" : "updates"} omitted
      {props.gap.omittedUtf8Bytes > 0
        ? ` (${props.gap.omittedUtf8Bytes.toLocaleString()} bytes)`
        : ""}
      . Showing the original assignment and latest activity.
    </p>
  );
}
