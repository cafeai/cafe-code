import { memo, useId, useState } from "react";
import { ChevronRightIcon, MessageSquareTextIcon, TerminalIcon } from "lucide-react";
import type { TimestampFormat } from "@cafecode/contracts/settings";
import { cn } from "~/lib/utils";
import { formatElapsed } from "../../session-logic";
import { formatTimestamp } from "../../timestampFormat";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import type { ClaudeCommandInspection, ClaudePublicSummary } from "./providerOperationVisibility";

/** Public summaries stay separate from canonical assistant prose and answers. */
export const ClaudeSummaryWorkEntry = memo(function ClaudeSummaryWorkEntry(props: {
  readonly summary: ClaudePublicSummary;
}) {
  const panelId = useId();
  const [expanded, setExpanded] = useState(false);
  return (
    <Collapsible
      className="rounded-lg px-1 py-1"
      data-claude-public-summary="true"
      open={expanded}
      onOpenChange={setExpanded}
    >
      <div className="flex items-center gap-2 text-xs leading-5 text-muted-foreground">
        <span className="flex size-5 shrink-0 items-center justify-center">
          <MessageSquareTextIcon className="size-3" aria-hidden />
        </span>
        <span>Claude summary</span>
        {props.summary.status === "inProgress" ? (
          <span className="text-subtle-foreground">Updating…</span>
        ) : props.summary.status === "failed" ? (
          <span className="text-muted-foreground">Partial</span>
        ) : null}
      </div>
      {!expanded ? (
        <p
          className="line-clamp-3 pl-7 text-xs leading-5 whitespace-pre-wrap wrap-break-word text-chat-foreground"
          data-summary-preview="true"
        >
          {props.summary.text}
        </p>
      ) : null}
      <CollapsibleTrigger
        aria-controls={panelId}
        className="focus-ring group ml-7 inline-flex min-h-7 items-center gap-1 rounded-sm text-2xs text-muted-foreground hover:text-foreground"
      >
        <ChevronRightIcon
          className="size-3 transition-transform duration-(--duration-fast) group-data-[panel-open]:rotate-90"
          aria-hidden
        />
        Inspect summary
      </CollapsibleTrigger>
      <CollapsiblePanel id={panelId}>
        <p
          className="mt-1 pl-7 text-xs leading-5 whitespace-pre-wrap wrap-break-word text-chat-foreground"
          data-summary-full-text="true"
        >
          {props.summary.text}
        </p>
        {props.summary.truncated ? (
          <p className="pl-7 text-2xs text-muted-foreground">
            Summary truncated to the retained preview.
          </p>
        ) : null}
      </CollapsiblePanel>
    </Collapsible>
  );
});

/** Inert, bounded command text; opening this disclosure never executes it. */
export const ClaudeCommandWorkEntry = memo(function ClaudeCommandWorkEntry(props: {
  readonly inspection: ClaudeCommandInspection;
  readonly timestampFormat: TimestampFormat;
}) {
  const { inspection } = props;
  const panelId = useId();
  const status =
    inspection.status === "inProgress"
      ? "Running…"
      : inspection.status === "completed"
        ? "Completed"
        : inspection.status === "failed"
          ? "Failed"
          : "Status not recorded";
  const observedDuration =
    inspection.startedAt && inspection.completedAt
      ? formatElapsed(inspection.startedAt, inspection.completedAt)
      : null;
  return (
    <Collapsible className="min-w-0 rounded-lg px-1 py-1" data-claude-command-inspection="true">
      <CollapsibleTrigger
        aria-controls={panelId}
        aria-label={`Inspect command: ${inspection.description ?? inspection.command ?? "Command"}`}
        className="focus-ring group flex min-h-7 w-full min-w-0 items-center gap-2 rounded-sm text-left text-xs leading-5 hover:bg-accent"
      >
        <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
          <TerminalIcon className="size-3" aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate text-foreground">
          {inspection.description ?? inspection.command ?? "Command"}
        </span>
        <span
          className={cn(
            "shrink-0 text-2xs",
            inspection.status === "failed"
              ? "text-destructive-foreground"
              : "text-muted-foreground",
          )}
        >
          {status}
        </span>
        <ChevronRightIcon
          className="size-3 shrink-0 text-subtle-foreground transition-transform duration-(--duration-fast) group-data-[panel-open]:rotate-90"
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsiblePanel id={panelId}>
        <div className="mt-1 min-w-0 space-y-2 rounded-md border border-border-subtle bg-sunken p-2 text-xs text-muted-foreground">
          {inspection.description ? (
            <p className="whitespace-pre-wrap wrap-break-word">{inspection.description}</p>
          ) : null}
          {inspection.descriptionTruncated ? (
            <p className="text-2xs">Description truncated to the retained preview.</p>
          ) : null}
          <section aria-label="Command">
            <p className="mb-1 text-2xs">Command</p>
            {inspection.command ? (
              <pre
                className="font-mono text-xs leading-5 whitespace-pre-wrap wrap-anywhere"
                data-command-inspection-command="true"
              >
                {inspection.command}
              </pre>
            ) : (
              <p>Command not recorded.</p>
            )}
            {inspection.commandTruncated ? (
              <p className="mt-1 text-2xs">Command truncated to the retained preview.</p>
            ) : null}
          </section>
          <section aria-label="Received output">
            <p className="mb-1 text-2xs">Received output</p>
            {inspection.output === undefined ? (
              <p>
                {inspection.status === "inProgress"
                  ? "No output received yet."
                  : "Output not recorded."}
              </p>
            ) : inspection.output.length === 0 ? (
              <p>No displayable output retained.</p>
            ) : (
              <pre
                className="font-mono text-xs leading-5 whitespace-pre-wrap wrap-anywhere"
                data-command-inspection-output="true"
              >
                {inspection.output}
              </pre>
            )}
            {inspection.outputTruncated ? (
              <p className="mt-1 text-2xs">Output truncated to the retained preview.</p>
            ) : null}
          </section>
          <div
            className="flex flex-wrap gap-x-3 gap-y-1 text-2xs tabular-nums"
            data-command-inspection-timing="true"
          >
            {inspection.startedAt ? (
              <span>
                Start observed {formatTimestamp(inspection.startedAt, props.timestampFormat)}
              </span>
            ) : null}
            {inspection.completedAt ? (
              <span>
                Completion observed {formatTimestamp(inspection.completedAt, props.timestampFormat)}
              </span>
            ) : null}
            {observedDuration ? <span>Observed duration {observedDuration}</span> : null}
            {!inspection.startedAt && !inspection.completedAt ? (
              <span>Timing not recorded.</span>
            ) : null}
          </div>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
});
