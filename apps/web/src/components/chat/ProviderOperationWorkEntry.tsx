import { useUiLocale, useUiPresentation } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { UiMessage } from "~/i18n";
import { memo, useEffect, useId, useRef, useState } from "react";
import { BrainIcon, ChevronRightIcon, MessageSquareTextIcon, TerminalIcon } from "lucide-react";
import type { TimestampFormat } from "@cafecode/contracts/settings";
import { formatElapsed } from "../../session-logic";
import { formatTimestamp } from "../../timestampFormat";
import { cn } from "~/lib/utils";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { InspectableWorkEntry } from "./InspectableWorkEntry";
import {
  compactCommandPreview,
  type ClaudeCommandInspection,
  type ProviderPublicSummary,
} from "./providerOperationVisibility";

/** Pause after a trace finishes before it folds away, so the end is readable. */
const SUMMARY_AUTO_COLLAPSE_DELAY_MS = 450;

/**
 * Public summaries (Claude) and thinking (OpenCode) stay separate from
 * canonical assistant prose and answers. While a trace is still streaming it
 * is shown expanded so it can be followed live; once it finishes it folds
 * down to a one-line preview with an eased height + fade animation. A trace
 * that is already finished when it mounts (history, remount) starts folded.
 * Any manual toggle while streaming is respected and suppresses the
 * automatic collapse. OpenCode thinking can be raw model reasoning rather
 * than a summary, so it reads as secondary, muted text.
 */
export const ProviderSummaryWorkEntry = memo(function ProviderSummaryWorkEntry(props: {
  readonly summary: ProviderPublicSummary;
}) {
  const uiLocale = useUiLocale();
  const panelId = useId();
  const thinking = props.summary.provider === "opencode";
  const streaming = props.summary.status === "inProgress";
  const [open, setOpen] = useState(streaming);
  const userToggledRef = useRef(false);
  const wasStreamingRef = useRef(streaming);

  useEffect(() => {
    const wasStreaming = wasStreamingRef.current;
    wasStreamingRef.current = streaming;
    if (streaming) {
      // A trace that resumes streaming re-opens unless the reader folded it.
      if (!wasStreaming && !userToggledRef.current) setOpen(true);
      return;
    }
    if (!wasStreaming || userToggledRef.current) return;
    const timer = window.setTimeout(() => setOpen(false), SUMMARY_AUTO_COLLAPSE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [streaming]);

  const label = thinking
    ? uiText("OpenCode thinking", undefined, undefined, uiLocale)
    : uiText("Claude summary", undefined, undefined, uiLocale);
  const preview = props.summary.text.split("\n").find((line) => line.trim().length > 0) ?? "";

  return (
    <Collapsible
      className="min-w-0 rounded-lg"
      data-provider-public-summary={props.summary.provider}
      data-summary-open={open ? "true" : "false"}
      open={open}
      onOpenChange={(next) => {
        userToggledRef.current = true;
        setOpen(next);
      }}
    >
      <CollapsibleTrigger
        aria-controls={panelId}
        className="focus-ring group flex min-h-7 w-full min-w-0 items-center gap-2 rounded-lg px-1 py-1 text-left text-xs leading-5 text-muted-foreground transition-colors duration-(--duration-fast) hover:bg-accent"
      >
        <span className="flex size-5 shrink-0 items-center justify-center">
          {thinking ? (
            <BrainIcon
              className={cn("size-3", streaming && "animate-pulse motion-reduce:animate-none")}
              aria-hidden
            />
          ) : (
            <MessageSquareTextIcon
              className={cn("size-3", streaming && "animate-pulse motion-reduce:animate-none")}
              aria-hidden
            />
          )}
        </span>
        <span className="shrink-0">{label}</span>
        {streaming ? (
          <span className="shrink-0 text-subtle-foreground">
            {uiText("Updating…", undefined, undefined, uiLocale)}
          </span>
        ) : props.summary.status === "failed" ? (
          <span className="shrink-0 text-muted-foreground">
            {uiText("Partial", undefined, undefined, uiLocale)}
          </span>
        ) : null}
        {/* One-line preview, mounted only while folded; fades in as the body folds away. */}
        {open ? (
          <span className="flex-1" />
        ) : (
          <span
            aria-hidden
            className="min-w-0 flex-1 animate-enter-fade truncate text-subtle-foreground [animation-delay:180ms] [animation-duration:320ms] motion-reduce:animate-none"
          >
            {preview}
          </span>
        )}
        <ChevronRightIcon
          className="size-3 shrink-0 text-subtle-foreground transition-transform duration-300 ease-(--ease-in-out) group-data-[panel-open]:rotate-90 motion-reduce:transition-none"
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsiblePanel
        id={panelId}
        className="group/summary duration-[380ms] ease-(--ease-in-out) motion-reduce:transition-none motion-reduce:duration-0"
      >
        <div className="origin-top pb-1 opacity-100 blur-none transition-[opacity,translate,filter] duration-[380ms] ease-(--ease-in-out) group-data-[ending-style]/summary:-translate-y-1 group-data-[ending-style]/summary:opacity-0 group-data-[ending-style]/summary:blur-[2px] group-data-[starting-style]/summary:-translate-y-1 group-data-[starting-style]/summary:opacity-0 group-data-[starting-style]/summary:blur-[2px] motion-reduce:transition-none">
          <p
            className={cn(
              "pl-8 text-xs leading-5 whitespace-pre-wrap wrap-break-word",
              thinking ? "text-muted-foreground" : "text-chat-foreground",
            )}
            data-summary-text="true"
          >
            {props.summary.text}
          </p>
          {props.summary.truncated ? (
            <p className="pl-8 text-2xs text-muted-foreground">
              {thinking
                ? uiText(
                    "Thinking truncated to the retained preview.",
                    undefined,
                    undefined,
                    uiLocale,
                  )
                : uiText(
                    "Summary truncated to the retained preview.",
                    undefined,
                    undefined,
                    uiLocale,
                  )}
            </p>
          ) : null}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
});

/**
 * Inert, bounded command text; opening this disclosure never executes it.
 * The collapsed row deliberately mirrors an ordinary (Codex) command row:
 * a muted "Ran command" verb plus a dim preview, with only an in-progress or
 * failed outcome surfaced. The complete status, command, output and timing
 * stay inside the disclosure.
 */
export const ClaudeCommandWorkEntry = memo(function ClaudeCommandWorkEntry(props: {
  readonly inspection: ClaudeCommandInspection;
  readonly timestampFormat: TimestampFormat;
  readonly workspaceRoot?: string | undefined;
}) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const { inspection } = props;
  const status =
    inspection.status === "inProgress"
      ? uiText("Running…", undefined, undefined, uiLocale)
      : inspection.status === "completed"
        ? uiText("Completed", undefined, undefined, uiLocale)
        : inspection.status === "failed"
          ? uiText("Failed", undefined, undefined, uiLocale)
          : uiText("Status not recorded", undefined, undefined, uiLocale);
  const observedDuration =
    inspection.startedAt && inspection.completedAt
      ? uiPresentation.formatElapsed(inspection.startedAt, inspection.completedAt)
      : null;
  const verb =
    inspection.status === "inProgress"
      ? uiText("Running command…", undefined, undefined, uiLocale)
      : uiText("Ran command", undefined, undefined, uiLocale);
  const preview =
    inspection.description ??
    (inspection.command ? compactCommandPreview(inspection.command, props.workspaceRoot) : null);
  return (
    <InspectableWorkEntry
      kind="claude-command"
      compact
      icon={<TerminalIcon className="size-3" aria-hidden />}
      accessibleLabel={uiText(
        "Inspect command: {value0}",
        {
          value0:
            inspection.description ??
            inspection.command ??
            uiText("Command", undefined, undefined, uiLocale),
        },
        undefined,
        uiLocale,
      )}
      heading={
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {verb}
          {preview ? <span className="text-subtle-foreground"> - {preview}</span> : null}
        </span>
      }
      metadata={
        inspection.status === "failed" ? (
          // Hidden while open: the disclosure's own status line then says it.
          <span className="shrink-0 text-2xs text-destructive-foreground group-data-[panel-open]:hidden">
            {status}
          </span>
        ) : undefined
      }
    >
      {inspection.description ? (
        <p className="whitespace-pre-wrap wrap-break-word">{inspection.description}</p>
      ) : null}
      {inspection.descriptionTruncated ? (
        <p className="text-2xs">
          {uiText("Description truncated to the retained preview.", undefined, undefined, uiLocale)}
        </p>
      ) : null}
      <section aria-label={uiText("Command", undefined, undefined, uiLocale)}>
        <p className="mb-1 text-2xs">{uiText("Command", undefined, undefined, uiLocale)}</p>
        {inspection.command ? (
          <pre
            className="font-mono text-xs leading-5 whitespace-pre-wrap wrap-anywhere"
            data-command-inspection-command="true"
          >
            {inspection.command}
          </pre>
        ) : (
          <p>{uiText("Command not recorded.", undefined, undefined, uiLocale)}</p>
        )}
        {inspection.commandTruncated ? (
          <p className="mt-1 text-2xs">
            {uiText("Command truncated to the retained preview.", undefined, undefined, uiLocale)}
          </p>
        ) : null}
      </section>
      <section aria-label={uiText("Received output", undefined, undefined, uiLocale)}>
        <p className="mb-1 text-2xs">{uiText("Received output", undefined, undefined, uiLocale)}</p>
        {inspection.output === undefined ? (
          <p>
            {inspection.status === "inProgress"
              ? uiText("No output received yet.", undefined, undefined, uiLocale)
              : uiText("Output not recorded.", undefined, undefined, uiLocale)}
          </p>
        ) : inspection.output.length === 0 ? (
          <p>{uiText("No displayable output retained.", undefined, undefined, uiLocale)}</p>
        ) : (
          <pre
            className="font-mono text-xs leading-5 whitespace-pre-wrap wrap-anywhere"
            data-command-inspection-output="true"
          >
            {inspection.output}
          </pre>
        )}
        {inspection.outputTruncated ? (
          <p className="mt-1 text-2xs">
            {uiText("Output truncated to the retained preview.", undefined, undefined, uiLocale)}
          </p>
        ) : null}
      </section>
      <div
        className="flex flex-wrap gap-x-3 gap-y-1 text-2xs tabular-nums"
        data-command-inspection-timing="true"
      >
        <span
          className={inspection.status === "failed" ? "text-destructive-foreground" : undefined}
          data-command-inspection-status="true"
        >
          {status}
        </span>
        {inspection.startedAt ? (
          <span>
            <UiMessage
              message={"Start observed <slot1></slot1>"}
              slots={{ slot1: formatTimestamp(inspection.startedAt, props.timestampFormat) }}
            />
          </span>
        ) : null}
        {inspection.completedAt ? (
          <span>
            <UiMessage
              message={"Completion observed <slot1></slot1>"}
              slots={{ slot1: formatTimestamp(inspection.completedAt, props.timestampFormat) }}
            />
          </span>
        ) : null}
        {observedDuration ? (
          <span>
            <UiMessage
              message={"Observed duration <slot1></slot1>"}
              slots={{ slot1: observedDuration }}
            />
          </span>
        ) : null}
        {!inspection.startedAt && !inspection.completedAt ? (
          <span>{uiText("Timing not recorded.", undefined, undefined, uiLocale)}</span>
        ) : null}
      </div>
    </InspectableWorkEntry>
  );
});

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = { formatElapsed };
