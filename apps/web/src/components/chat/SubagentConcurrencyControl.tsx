import type { ProviderDriverKind } from "@cafecode/contracts";
import { useState } from "react";
import {
  validSubagentLimit,
  type SubagentConcurrencyPresentation,
} from "../../subagentConcurrency";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";

export function SubagentConcurrencyDetails({
  presentation,
}: {
  readonly presentation: SubagentConcurrencyPresentation | null | undefined;
}) {
  if (!presentation) return null;
  return (
    <div
      data-subagent-concurrency-details="true"
      className="grid min-w-0 max-w-[min(20rem,calc(100vw-3rem))] gap-1 break-words text-xs text-muted-foreground"
    >
      <span>Requested: {presentation.requested ?? "Provider / inherited default"}</span>
      <span>
        Configured:{" "}
        {presentation.configured === undefined
          ? "Unknown"
          : presentation.configured === null
            ? "No Cafe numeric override"
            : presentation.configured}
      </span>
      <span>Source: {presentation.source}</span>
      {presentation.pending ? <span>Pending until a safe idle session boundary.</span> : null}
      <span>Native effective limit is not verified.</span>
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
  return (
    <>
      <DialogHeader>
        <DialogTitle>Subagent limit</DialogTitle>
        <DialogDescription>
          For this chat only. Enter 1–64; blank uses the instance or provider's inherited
          configuration.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="grid gap-3">
        <label className="grid gap-1.5">
          <span className="text-sm">Maximum concurrent subagents</span>
          <Input
            type="number"
            min={1}
            max={64}
            step={1}
            value={value}
            disabled={pending || !props.supported}
            placeholder="Provider / inherited default"
            onChange={(event) => setValue(event.target.value)}
            aria-invalid={!valid}
          />
        </label>
        {!valid ? (
          <p role="alert" className="text-xs text-destructive">
            Enter a whole number from 1 to 64.
          </p>
        ) : null}
        <SubagentConcurrencyDetails presentation={props.presentation} />
        {!props.supported ? (
          <p className="text-xs text-muted-foreground">
            This runtime cannot apply a numeric override. Reset removes this chat's saved request.
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {props.isRunning
            ? "Current work keeps its existing configuration. Changes wait until a safe idle session boundary."
            : "Applied at the next safe session start or resume, not immediately."}
        </p>
        <p className="text-xs text-muted-foreground">
          {props.provider === "claudeAgent"
            ? "Claude limits Agent-tool admission, not all running work. Resumes, manual forks, Ultracode and teams have different limits."
            : "Codex limits spawned resident agent threads. The primary agent is not counted."}
        </p>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
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
