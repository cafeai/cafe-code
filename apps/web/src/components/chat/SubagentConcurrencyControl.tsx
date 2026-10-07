import type { ProviderDriverKind } from "@cafecode/contracts";
import { useId, useState, type ReactNode } from "react";
import { InfoIcon } from "lucide-react";
import {
  formatSubagentConcurrencyLimit,
  validSubagentLimit,
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

const SUBAGENT_LIMIT_HELP =
  "This is the saved limit. Changes take effect before a new turn when the session can safely restart. Cafe can’t independently confirm the limit the provider enforces.";

/** The labelled info tooltip is the one explanation surface for subagent limits. */
function SubagentLimitHelp({ extra }: { readonly extra?: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            className="size-5 shrink-0 rounded-sm p-0 text-muted-foreground hover:text-foreground"
            aria-label="About subagent limits"
          />
        }
      >
        <InfoIcon aria-hidden="true" className="size-3" />
      </TooltipTrigger>
      <TooltipPopup className="max-w-[min(20rem,calc(100vw-2rem))]">
        <span className="block">{SUBAGENT_LIMIT_HELP}</span>
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
  const label = formatSubagentConcurrencyLimit(presentation);
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
      <SubagentLimitHelp extra={extraHelp} />
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
  // One local edit per opening: upstream metadata may update the explanatory
  // rows, but must not clobber keystrokes. Closing unmounts this draft while the
  // dialog root retains its focus/portal lifecycle; reopening reads fresh data.
  const [value, setValue] = useState(() =>
    props.override === undefined ? "" : String(props.override),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = value.trim() === "" ? undefined : Number(value);
  const valid = parsed === undefined || validSubagentLimit(parsed);
  const commit = async (limit: number | undefined) => {
    if (pending || (limit !== undefined && !props.supported)) return;
    setPending(true);
    setError(null);
    try {
      await props.onChange(limit);
      props.onOpenChange(false);
    } catch {
      setError("Could not save this chat's subagent limit. Try again when connected.");
    } finally {
      setPending(false);
    }
  };
  // Running-state and provider-specific notes extend the one labelled tooltip
  // instead of repeating its explanation as extra paragraphs.
  const editorHelp = (
    <>
      {props.isRunning ? (
        <span className="mt-1 block">Your current work won’t be interrupted.</span>
      ) : null}
      <span className="mt-1 block">
        {props.provider === "claudeAgent"
          ? "Claude limits Agent-tool admission, not all running work. Resumes, manual forks, Ultracode and teams have different limits."
          : "Codex limits spawned resident agents. The primary agent is not counted."}
      </span>
    </>
  );
  const hasSavedLimit = formatSubagentConcurrencyLimit(props.presentation) !== null;
  const inputId = useId();
  return (
    <>
      <DialogHeader>
        <DialogTitle>Subagent limit</DialogTitle>
        <DialogDescription>For this chat (1–64). Blank uses the account default.</DialogDescription>
      </DialogHeader>
      <DialogPanel className="grid gap-3">
        <div className="grid gap-1.5">
          <div className="flex items-center gap-1.5">
            <label htmlFor={inputId} className="text-sm">
              Maximum concurrent subagents
            </label>
            {/* With no saved limit there is no status row; keep the one
                explanation surface beside the field instead. */}
            {hasSavedLimit ? null : <SubagentLimitHelp extra={editorHelp} />}
          </div>
          <Input
            id={inputId}
            type="number"
            min={1}
            max={64}
            step={1}
            value={value}
            disabled={pending || !props.supported}
            placeholder="Account default"
            onChange={(event) => setValue(event.target.value)}
            aria-invalid={!valid}
          />
        </div>
        {!valid ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            Enter a whole number from 1 to 64.
          </p>
        ) : null}
        {hasSavedLimit ? (
          <SubagentConcurrencyDetails
            presentation={props.presentation}
            showHeading={false}
            extraHelp={editorHelp}
          />
        ) : null}
        {!props.supported ? (
          <p className="text-xs text-muted-foreground">
            This account can’t apply a numeric limit. Reset clears this chat’s saved value.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            {error}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button variant="ghost" disabled={pending} onClick={() => void commit(undefined)}>
          Reset
        </Button>
        <Button
          disabled={pending || !valid || (parsed !== undefined && !props.supported)}
          onClick={() => void commit(parsed)}
        >
          Save
        </Button>
      </DialogFooter>
    </>
  );
}
