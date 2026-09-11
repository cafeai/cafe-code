import {
  THREAD_SUBAGENT_LIMIT_OPTION_ID,
  type EnvironmentId,
  type ModelSelection,
  type ProviderDriverKind,
  type ScopedThreadRef,
} from "@cafecode/contracts";
import {
  createModelSelection,
  omitThreadSubagentLimitOption,
  readThreadSubagentLimitOption,
} from "@cafecode/shared/model";
import { useId, useState } from "react";
import { GitForkIcon } from "lucide-react";
import { newCommandId } from "~/lib/utils";
import { readEnvironmentApi } from "../../environmentApi";
import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

export function ThreadAgentControl(props: {
  readonly environmentId: EnvironmentId;
  readonly draftTarget: ScopedThreadRef | DraftId;
  readonly serverThreadRef: ScopedThreadRef | null;
  readonly provider: ProviderDriverKind;
  readonly modelSelection: ModelSelection;
}) {
  const limit = readThreadSubagentLimitOption(props.modelSelection.options);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const descriptionId = useId();
  const valid = value === "" || (/^[1-9]\d?$/.test(value) && Number(value) <= 64);

  const save = async () => {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    const options = [
      ...(omitThreadSubagentLimitOption(props.modelSelection.options) ?? []),
      { id: THREAD_SUBAGENT_LIMIT_OPTION_ID, value: value || "inherit" },
    ];
    try {
      // Persist against the captured environment/thread, never the active route.
      // A failed server write must not leave a renderer-only success state.
      if (props.serverThreadRef !== null) {
        const api = readEnvironmentApi(props.serverThreadRef.environmentId);
        if (!api) throw new Error("Environment unavailable");
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: props.serverThreadRef.threadId,
          modelSelection: createModelSelection(
            props.modelSelection.instanceId,
            props.modelSelection.model,
            options,
          ),
        });
      }
      useComposerDraftStore
        .getState()
        .setProviderModelOptions(props.draftTarget, props.provider, options, {
          instanceId: props.modelSelection.instanceId,
          model: props.modelSelection.model,
          persistSticky: false,
        });
      setOpen(false);
    } catch {
      setError("Could not save the subagent limit. Connect to this environment and try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        aria-label={`Subagent limit: ${limit ?? "provider default"}`}
        onClick={() => {
          setValue(limit === null ? "" : String(limit));
          setError(null);
          setOpen(true);
        }}
      >
        <GitForkIcon className="size-3.5" aria-hidden="true" />
        <span>{limit ?? "Agents"}</span>
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!saving) setOpen(next);
        }}
      >
        <DialogPopup className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Subagent limit for this thread</DialogTitle>
            <DialogDescription>
              Set the maximum concurrent subagents. The agent decides how many to use.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <label htmlFor={inputId} className="text-sm font-medium">
              Maximum subagents (1–64)
            </label>
            <Input
              id={inputId}
              type="text"
              inputMode="numeric"
              value={value}
              disabled={saving}
              aria-describedby={descriptionId}
              aria-invalid={!valid}
              onChange={(event) => setValue(event.target.value)}
              placeholder="Provider default"
            />
            <p id={descriptionId} className="text-sm text-muted-foreground">
              Leave this field empty to use the provider instance setting. Changes take effect on
              the next idle session start or resume. Active work continues.
            </p>
            {props.provider === "claudeAgent" && (
              <p className="text-sm text-muted-foreground">
                Claude applies this limit to Agent-tool launches. Resumed agents and team workflows
                can exceed it.
              </p>
            )}
            {!valid && (
              <p role="alert" className="text-sm text-destructive">
                Enter a whole number from 1 to 64, or leave the field empty.
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="button" disabled={!valid || saving} onClick={() => void save()}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
