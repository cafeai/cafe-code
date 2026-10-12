import { useUiLocale, useUiPresentation } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { UiMessage } from "~/i18n";
import type { ProviderDriverKind } from "@cafecode/contracts";
import { useId, useState, type ReactNode } from "react";
import { InfoIcon } from "lucide-react";
import {
  formatSubagentConcurrencyLimit,
  validSubagentLimit,
  subagentPolicySourceLabel,
  type SubagentConcurrencyPresentation,
} from "../../subagentConcurrency";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";

function getSUBAGENT_LIMIT_HELP() {
  return uiText(
    "Shows Cafe’s recorded session setting and requested setting. Changes wait for a safe idle turn; active children can delay them. Cafe can’t independently confirm the limit the provider enforces.",
  );
}

/** The labelled info tooltip is the one explanation surface for subagent limits. */
function SubagentLimitHelp({
  extra,
  presentation,
}: {
  readonly extra?: ReactNode;
  readonly presentation?: SubagentConcurrencyPresentation | null | undefined;
}) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            className="size-5 shrink-0 rounded-sm p-0 text-muted-foreground hover:text-foreground"
            aria-label={uiText("About subagent limits", undefined, undefined, uiLocale)}
          />
        }
      >
        <InfoIcon aria-hidden="true" className="size-3" />
      </TooltipTrigger>
      <TooltipPopup className="max-w-[min(20rem,calc(100vw-2rem))]">
        <span className="block">{uiPresentation.getSUBAGENT_LIMIT_HELP()}</span>
        {presentation ? (
          <>
            <span className="mt-1 block">
              <UiMessage
                message={"Source: <slot1></slot1>."}
                slots={{ slot1: uiPresentation.subagentPolicySourceLabel(presentation.source) }}
              />
            </span>
            <span className="mt-1 block">
              {presentation.configured === undefined
                ? uiText(
                    "Current session configuration is not recorded.",
                    undefined,
                    undefined,
                    uiLocale,
                  )
                : presentation.configured === null
                  ? uiText(
                      "Current session has no Cafe numeric override.",
                      undefined,
                      undefined,
                      uiLocale,
                    )
                  : uiText(
                      "Current session was configured with {value0}.",
                      {
                        value0: presentation.configured,
                      },
                      undefined,
                      uiLocale,
                    )}
              {presentation.pending
                ? uiText(
                    " The requested setting is pending a safe idle turn.",
                    undefined,
                    undefined,
                    uiLocale,
                  )
                : ""}
            </span>
          </>
        ) : null}
        {extra}
      </TooltipPopup>
    </Tooltip>
  );
}

export function SubagentConcurrencyDetails({
  presentation,
  showHeading = true,
  extraHelp,
}: {
  readonly presentation: SubagentConcurrencyPresentation | null | undefined;
  /** The editor already has a dialog title; context/rail labels act as headings. */
  readonly showHeading?: boolean;
  /** Editor-only notes appended to the shared tooltip. */
  readonly extraHelp?: ReactNode;
}) {
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const label = uiPresentation.formatSubagentConcurrencyLimit(presentation);
  if (label === null) return null;
  return (
    <div
      data-subagent-concurrency-details="true"
      className="flex min-w-0 max-w-[min(20rem,calc(100vw-3rem))] items-center gap-1.5 text-xs font-medium text-foreground [overflow-wrap:anywhere]"
    >
      {showHeading ? (
        <h3 className="min-w-0">{label}</h3>
      ) : (
        <span className="min-w-0">{label}</span>
      )}
      <SubagentLimitHelp extra={extraHelp} presentation={presentation} />
    </div>
  );
}

interface SubagentConcurrencyControlProps {
  readonly provider: ProviderDriverKind;
  readonly supported: boolean;
  readonly override: number | undefined;
  readonly presentation: SubagentConcurrencyPresentation | null;
  readonly isRunning: boolean;
  readonly onChange: (value: number | undefined) => Promise<void>;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/** Mounted outside the menu portal so closing its trigger cannot discard the editor. */
export function SubagentConcurrencyControl(props: SubagentConcurrencyControlProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-sm">
        {props.open ? <SubagentConcurrencyEditor {...props} /> : null}
      </DialogPopup>
    </Dialog>
  );
}

function SubagentConcurrencyEditor(props: SubagentConcurrencyControlProps) {
  const uiLocale = useUiLocale();

  // One local edit per opening: upstream metadata may update the explanatory
  // rows, but must not clobber keystrokes. Closing unmounts this draft while the
  // dialog root retains its focus/portal lifecycle; reopening reads fresh data.
  const [value, setValue] = useState(() =>
    props.override === undefined ? "" : String(props.override),
  );
  const [pending, setPending] = useState(false);
  // A failure bit is enough for this one Cafe-owned message. Do not retain an
  // exception or startup-language string, and never repeat commit on a redraw.
  const [errorCode, setErrorCode] = useState(false);
  const parsed = value.trim() === "" ? undefined : Number(value);
  const valid = parsed === undefined || validSubagentLimit(parsed);
  const commit = async (limit: number | undefined) => {
    if (pending || (limit !== undefined && !props.supported)) return;
    setPending(true);
    setErrorCode(false);
    try {
      await props.onChange(limit);
      props.onOpenChange(false);
    } catch {
      setErrorCode(true);
    } finally {
      setPending(false);
    }
  };
  // Running-state and provider-specific notes extend the one labelled tooltip
  // instead of repeating its explanation as extra paragraphs.
  const editorHelp = (
    <>
      {props.isRunning ? (
        <span className="mt-1 block">
          {uiText("Your current work won’t be interrupted.", undefined, undefined, uiLocale)}
        </span>
      ) : null}
      <span className="mt-1 block">
        {props.provider === "claudeAgent"
          ? uiText(
              "Claude limits Agent-tool admission, not all running work. Resumes, manual forks, Ultracode and teams have different limits.",
              undefined,
              undefined,
              uiLocale,
            )
          : uiText(
              "Codex limits spawned resident agents. The primary agent is not counted.",
              undefined,
              undefined,
              uiLocale,
            )}
      </span>
    </>
  );
  const hasPolicyDetails = formatSubagentConcurrencyLimit(props.presentation) !== null;
  const inputId = useId();
  return (
    <>
      <DialogHeader>
        <DialogTitle>{uiText("Subagent limit", undefined, undefined, uiLocale)}</DialogTitle>
        <DialogDescription>
          {uiText(
            "For this chat (1–64). Blank uses the account default.",
            undefined,
            undefined,
            uiLocale,
          )}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="grid gap-3">
        <div className="grid gap-1.5">
          <div className="flex items-center gap-1.5">
            <label htmlFor={inputId} className="text-sm">
              {uiText("Maximum concurrent subagents", undefined, undefined, uiLocale)}
            </label>
            {/* With neither requested nor recorded pending policy there is no status row; keep the one
                explanation surface beside the field instead. */}
            {hasPolicyDetails ? null : (
              <SubagentLimitHelp extra={editorHelp} presentation={props.presentation} />
            )}
          </div>
          <Input
            id={inputId}
            type="number"
            min={1}
            max={64}
            step={1}
            value={value}
            disabled={pending || !props.supported}
            placeholder={uiText("Account default", undefined, undefined, uiLocale)}
            onChange={(event) => setValue(event.target.value)}
            aria-invalid={!valid}
          />
        </div>
        {!valid ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            {uiText("Enter a whole number from 1 to 64.", undefined, undefined, uiLocale)}
          </p>
        ) : null}
        {hasPolicyDetails ? (
          <SubagentConcurrencyDetails
            presentation={props.presentation}
            showHeading={false}
            extraHelp={editorHelp}
          />
        ) : null}
        {!props.supported ? (
          <p className="text-xs text-muted-foreground">
            {uiText(
              "This account can’t apply a numeric limit. Reset clears only this chat’s override; an inherited numeric account limit must be cleared in account settings or used with a supported runtime.",
              undefined,
              undefined,
              uiLocale,
            )}
          </p>
        ) : null}
        {errorCode ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            {uiText(
              "Could not save this chat''s subagent limit. Try again when connected.",
              undefined,
              undefined,
              uiLocale,
            )}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button variant="ghost" disabled={pending} onClick={() => void commit(undefined)}>
          {uiText("Reset", undefined, undefined, uiLocale)}
        </Button>
        <Button
          disabled={pending || !valid || (parsed !== undefined && !props.supported)}
          onClick={() => void commit(parsed)}
        >
          {uiText("Save", undefined, undefined, uiLocale)}
        </Button>
      </DialogFooter>
    </>
  );
}

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = {
  formatSubagentConcurrencyLimit,
  getSUBAGENT_LIMIT_HELP,
  subagentPolicySourceLabel,
};
