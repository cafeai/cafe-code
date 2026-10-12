import { useId, useState } from "react";
import { InfoIcon } from "lucide-react";
import { validCodexContextWindowOverride } from "@cafecode/contracts";
import { uiText } from "@cafecode/shared/i18n";
import { useUiLocale, useUiPresentation } from "~/i18n";
import { UiMessage } from "~/i18n";
import {
  formatCodexContextWindowOverride,
  type CodexContextWindowPresentation,
  codexContextWindowSourceLabel,
} from "../../codexContextWindow";
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

function contextWindowHelp() {
  return uiText(
    "Shows this chat’s saved choice and recorded session configuration, not verified model capacity. Changes wait for a safe idle turn and never interrupt current work. Codex controls supported capacity, reserved headroom and compaction. Reset inherits the account default, or Codex settings when it is blank.",
  );
}

function ContextWindowHelp({
  presentation,
}: {
  readonly presentation?: CodexContextWindowPresentation | undefined;
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
            aria-label={uiText("About context-window overrides", undefined, undefined, uiLocale)}
          />
        }
      >
        <InfoIcon aria-hidden="true" className="size-3" />
      </TooltipTrigger>
      <TooltipPopup className="max-w-[min(20rem,calc(100vw-2rem))]">
        {uiPresentation.contextWindowHelp()}
        {presentation ? (
          <span className="mt-1 block">
            <UiMessage
              message={"Source: <slot1></slot1>."}
              slots={{ slot1: uiPresentation.codexContextWindowSourceLabel(presentation.source) }}
            />
          </span>
        ) : null}
      </TooltipPopup>
    </Tooltip>
  );
}

export function CodexContextWindowDetails(props: {
  readonly presentation: CodexContextWindowPresentation | null | undefined;
  readonly showHeading?: boolean;
}) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);
  const label = uiPresentation.formatCodexContextWindowOverride(props.presentation, uiLocale);
  if (label === null) return null;
  return (
    <div
      data-codex-context-window-details="true"
      className="flex min-w-0 max-w-[min(20rem,calc(100vw-3rem))] items-center gap-1.5 text-xs font-medium text-foreground [overflow-wrap:anywhere]"
    >
      {props.showHeading === false ? (
        <span className="min-w-0">{label}</span>
      ) : (
        <h3 className="min-w-0">{label}</h3>
      )}
      <ContextWindowHelp presentation={props.presentation ?? undefined} />
    </div>
  );
}

interface CodexContextWindowControlProps {
  readonly supported: boolean;
  readonly override: number | null | undefined;
  readonly presentation: CodexContextWindowPresentation;
  readonly onChange: (value: number | null) => Promise<void>;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/** Outside the transient menu portal; closing its trigger never discards the editor. */
export function CodexContextWindowControl(props: CodexContextWindowControlProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-sm">
        {props.open ? <CodexContextWindowEditor {...props} /> : null}
      </DialogPopup>
    </Dialog>
  );
}

function CodexContextWindowEditor(props: CodexContextWindowControlProps) {
  const uiLocale = useUiLocale();
  // Received metadata updates explanation only. One opening owns its unsaved input.
  const [value, setValue] = useState(() => (props.override == null ? "" : String(props.override)));
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const parsed = value.trim() === "" ? null : Number(value);
  const valid = parsed === null || validCodexContextWindowOverride(parsed);
  const inputId = useId();
  const commit = async (next: number | null) => {
    if (pending || (next !== null && !props.supported)) return;
    setPending(true);
    setFailed(false);
    try {
      await props.onChange(next);
      props.onOpenChange(false);
    } catch {
      // No provider exception strings, and redraws never replay the metadata save.
      setFailed(true);
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>{uiText("Context window", undefined, undefined, uiLocale)}</DialogTitle>
        <DialogDescription>
          {uiText("For this chat. Blank uses the account default.", undefined, undefined, uiLocale)}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="grid gap-3">
        <div className="grid gap-1.5">
          <div className="flex items-center gap-1.5">
            <label htmlFor={inputId} className="text-sm">
              {uiText("Context window (tokens)", undefined, undefined, uiLocale)}
            </label>
            {formatCodexContextWindowOverride(props.presentation, uiLocale) === null ? (
              <ContextWindowHelp presentation={props.presentation} />
            ) : null}
          </div>
          <Input
            id={inputId}
            type="number"
            min={1}
            max={Number.MAX_SAFE_INTEGER}
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
            {uiText(
              "Enter a positive whole token count within the supported numeric range.",
              undefined,
              undefined,
              uiLocale,
            )}
          </p>
        ) : null}
        <CodexContextWindowDetails presentation={props.presentation} showHeading={false} />
        {!props.supported ? (
          <p className="text-xs text-muted-foreground">
            {uiText(
              "This Codex runtime can’t apply an override. Reset can still clear this chat’s saved choice.",
              undefined,
              undefined,
              uiLocale,
            )}
          </p>
        ) : null}
        {failed ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            {uiText(
              "Could not save this chat’s context override. Try again when connected.",
              undefined,
              undefined,
              uiLocale,
            )}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button variant="ghost" disabled={pending} onClick={() => void commit(null)}>
          {uiText("Reset", undefined, undefined, uiLocale)}
        </Button>
        <Button
          disabled={pending || !valid || (parsed !== null && !props.supported)}
          onClick={() => void commit(parsed)}
        >
          {uiText("Save", undefined, undefined, uiLocale)}
        </Button>
      </DialogFooter>
    </>
  );
}

const UI_PRESENTATION_SOURCES = {
  contextWindowHelp,
  formatCodexContextWindowOverride,
  codexContextWindowSourceLabel,
};
