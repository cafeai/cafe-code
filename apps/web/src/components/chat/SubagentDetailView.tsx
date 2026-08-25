import {
  type EnvironmentId,
  type EnvironmentApi,
  type ProviderDriverKind,
  type ServerProviderSkill,
  type ThreadId,
  type TurnId,
} from "@cafecode/contracts";
import { ArrowLeftIcon, LoaderCircleIcon } from "lucide-react";
import { useEffect, useMemo, useState, type RefObject } from "react";

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
 * thread/turn before it performs Codex `thread/read`. The browser receives
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
    // The provider transcript path is intentionally Codex-only. Other
    // providers still get the useful durable lifecycle detail below, without
    // the renderer inventing unsupported transcript semantics.
    // Live description changes render directly from `selection`; they do not
    // retrigger a potentially large provider `thread/read`. A terminal status
    // transition does refetch once so the ended child's final report appears.
    if (provider !== "codex" || threadId === null || selection.turnId === null) {
      setLoadState({ status: "idle" });
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      setLoadState({ status: "unavailable" });
      return;
    }

    let cancelled = false;
    setLoadState((current) => (current.status === "loaded" ? current : { status: "loading" }));
    void api.orchestration
      .getThreadTurnSubagentDetail({
        threadId,
        turnId: selection.turnId,
        subagentId: subagent.id,
      })
      .then((detail) => {
        if (!cancelled) setLoadState({ status: "loaded", detail });
      })
      .catch(() => {
        // Provider errors are intentionally opaque here: upstream responses can
        // include account, filesystem, or transport details. The saved Cafe
        // lifecycle remains visible as a useful and safe fallback.
        if (!cancelled) {
          setLoadState((current) =>
            current.status === "loaded" ? current : { status: "unavailable" },
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    environmentId,
    provider,
    selection.turnId,
    subagent.completedAt,
    subagent.id,
    subagent.status,
    threadId,
  ]);

  const elapsed = formatElapsed(subagent.startedAt, live ? now : subagent.completedAt);
  const primaryDescription =
    subagent.description ??
    subagent.objective ??
    (subagent.status === "waiting" ? "Waiting to start" : "Working");
  const messages =
    loadState.status === "loaded" ? loadState.detail.messages : EMPTY_SUBAGENT_DETAIL_MESSAGES;
  const keyedMessages = useMemo(() => {
    const output: Array<{
      readonly key: string;
      readonly message: LoadedSubagentDetail["messages"][number];
    }> = [];
    let sequence = 0;
    for (const message of messages) {
      // The canonical transcript order is immutable for one response. A local
      // sequence key keeps duplicate provider messages distinct without
      // exposing provider-native item identifiers to the renderer contract.
      output.push({ key: `subagent-message-${sequence}`, message });
      sequence += 1;
    }
    return output;
  }, [messages]);
  const lastAssistantIndex = useMemo(
    () => keyedMessages.findLastIndex(({ message }) => message.role === "assistant"),
    [keyedMessages],
  );

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
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain px-3 py-4 [scrollbar-gutter:stable] sm:px-5 sm:py-6"
        data-subagent-detail-scroll="true"
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

          {keyedMessages.map(({ key, message }, index) => {
            const isFinalResult =
              !live && message.role === "assistant" && index === lastAssistantIndex;
            return (
              <section
                key={key}
                className={cn(
                  "min-w-0",
                  message.role === "user" &&
                    "rounded-xl border border-border/40 bg-muted/20 px-3 py-3 sm:px-4",
                )}
                data-subagent-detail-message={message.role}
              >
                <p className="mb-2 text-[9px] font-medium uppercase tracking-[0.16em] text-muted-foreground/55">
                  {message.role === "user" ? "Assignment" : isFinalResult ? "Result" : "Update"}
                </p>
                <div className="min-w-0 text-sm leading-6 break-words">
                  <ChatMarkdown
                    text={message.text}
                    cwd={markdownCwd}
                    additionalWorkspaceRoots={additionalWorkspaceRoots}
                    normalizeCodexCitations
                    skills={skills}
                  />
                </div>
              </section>
            );
          })}

          {loadState.status === "unavailable" ? (
            <p
              className="rounded-xl border border-border/40 bg-muted/15 px-3 py-3 text-xs leading-5 text-muted-foreground/65"
              role="status"
              data-subagent-detail-unavailable="true"
            >
              The provider transcript is unavailable right now. The saved task summary and timing
              above remain available.
            </p>
          ) : null}

          {loadState.status === "loaded" && messages.length === 0 ? (
            <p className="text-xs leading-5 text-muted-foreground/60" role="status">
              No public subagent messages were saved for this task. The task summary above is still
              available.
            </p>
          ) : null}

          {loadState.status === "loaded" && loadState.detail.truncated ? (
            <p className="text-[11px] leading-5 text-muted-foreground/55" role="note">
              This long subagent history was shortened to keep the chat responsive.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
