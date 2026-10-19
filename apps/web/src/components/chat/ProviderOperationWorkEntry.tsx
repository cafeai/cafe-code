import { useUiLocale, useUiPresentation } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { UiMessage } from "~/i18n";
import { memo } from "react";
import { MessageSquareTextIcon, TerminalIcon } from "lucide-react";
import type { TimestampFormat } from "@cafecode/contracts/settings";
import { formatElapsed } from "../../session-logic";
import { formatTimestamp } from "../../timestampFormat";
import { InspectableWorkEntry } from "./InspectableWorkEntry";
import {
  compactCommandPreview,
  type ClaudeCommandInspection,
  type ClaudePublicSummary,
} from "./providerOperationVisibility";

/**
 * Public summaries stay separate from canonical assistant prose and answers.
 * The text is already bounded (4,096 characters) and is the whole point of
 * the row, so it is always shown in full: a disclosure would only repeat it.
 */
export const ClaudeSummaryWorkEntry = memo(function ClaudeSummaryWorkEntry(props: {
  readonly summary: ClaudePublicSummary;
}) {
  const uiLocale = useUiLocale();

  return (
    <div className="rounded-lg px-1 py-1" data-claude-public-summary="true">
      <div className="flex items-center gap-2 text-xs leading-5 text-muted-foreground">
        <span className="flex size-5 shrink-0 items-center justify-center">
          <MessageSquareTextIcon className="size-3" aria-hidden />
        </span>
        <span>{uiText("Claude summary", undefined, undefined, uiLocale)}</span>
        {props.summary.status === "inProgress" ? (
          <span className="text-subtle-foreground">
            {uiText("Updating…", undefined, undefined, uiLocale)}
          </span>
        ) : props.summary.status === "failed" ? (
          <span className="text-muted-foreground">
            {uiText("Partial", undefined, undefined, uiLocale)}
          </span>
        ) : null}
      </div>
      <p
        className="pl-7 text-xs leading-5 whitespace-pre-wrap wrap-break-word text-chat-foreground"
        data-summary-text="true"
      >
        {props.summary.text}
      </p>
      {props.summary.truncated ? (
        <p className="pl-7 text-2xs text-muted-foreground">
          {uiText("Summary truncated to the retained preview.", undefined, undefined, uiLocale)}
        </p>
      ) : null}
    </div>
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
