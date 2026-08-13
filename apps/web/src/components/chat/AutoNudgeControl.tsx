import {
  normalizeAutoNudgeBuiltInPrompt,
  THREAD_AUTO_NUDGE_PROMPT_MAX_CHARS,
  type EnvironmentId,
  type ThreadAutoNudgeConfig,
  type AutoNudgeMode,
  type ThreadId,
} from "@cafecode/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useAutoNudgeCoordinatorStatus } from "../../autoNudgeCoordinator";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";

export interface AutoNudgeControlProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly config: ThreadAutoNudgeConfig;
  readonly saving: boolean;
  readonly saveError: string | null;
  readonly onConfigure: (input: {
    readonly mode: AutoNudgeMode;
    readonly prompt: string;
    readonly backgroundContinuation: boolean;
  }) => Promise<void>;
}

function statusCopy(input: {
  readonly config: ThreadAutoNudgeConfig;
  readonly saving: boolean;
  readonly coordinatorStatus: "waiting" | "dispatching" | "failed";
}): string {
  if (input.config.mode === "off") return "Off";
  if (input.saving) return "Saving this thread";
  if (input.coordinatorStatus === "dispatching") return "Sending the saved prompt";
  if (input.coordinatorStatus === "failed") return "Last handoff failed";
  return input.config.backgroundContinuation
    ? "On - continues in background"
    : "On - waits for a new completed response";
}

export function AutoNudgeControl(props: AutoNudgeControlProps) {
  const { config } = props;
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState(config.prompt);
  const coordinatorStatus = useAutoNudgeCoordinatorStatus(props.environmentId, props.threadId);

  useEffect(() => setPrompt(config.prompt), [config.prompt]);

  const active = config.mode !== "off";
  const status = statusCopy({ config, saving: props.saving, coordinatorStatus });
  const statusClassName = !active
    ? "border-red-500/40 bg-red-500/10 text-red-300"
    : config.backgroundContinuation
      ? "border-cyan-400/45 bg-gradient-to-r from-cyan-500/15 to-emerald-500/20 text-emerald-200 motion-safe:animate-pulse"
      : "border-emerald-500/45 bg-emerald-500/15 text-emerald-200";

  const configureMode = async (mode: AutoNudgeMode) => {
    if (mode === "off") {
      await props.onConfigure({ mode, prompt, backgroundContinuation: false });
      return;
    }
    const nextPrompt = normalizeAutoNudgeBuiltInPrompt(mode, prompt);
    setPrompt(nextPrompt);
    await props.onConfigure({
      mode,
      prompt: nextPrompt,
      backgroundContinuation: config.backgroundContinuation,
    });
  };

  return (
    <Collapsible className="mb-1.5 w-full" onOpenChange={setOpen} open={open}>
      <div className={cn("overflow-hidden rounded-lg border text-xs", statusClassName)}>
        <CollapsibleTrigger
          aria-label={open ? "Minimize Auto Nudge" : "Open Auto Nudge"}
          className="flex min-h-8 w-full items-center justify-between gap-3 px-3 py-1.5 text-left"
        >
          <span className="font-semibold">Auto Nudge</span>
          <span className="ml-auto truncate">{status}</span>
          <ChevronDownIcon
            aria-hidden="true"
            className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")}
          />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="grid gap-3 border-t border-current/15 bg-background/80 p-3 text-foreground backdrop-blur-sm">
            <label className="grid gap-1">
              <span className="font-medium">Mode for this thread</span>
              <select
                className="min-h-9 rounded-md border border-input bg-background px-2 text-sm"
                disabled={props.saving}
                onChange={(event) => void configureMode(event.target.value as AutoNudgeMode)}
                value={config.mode}
              >
                <option value="off">Off</option>
                <option value="steady-progress">Steady progress</option>
                <option value="hardcore-fanout">Hardcore fanout</option>
              </select>
            </label>
            <label className="grid gap-1">
              <span className="font-medium">Prompt for this thread</span>
              <Textarea
                disabled={props.saving}
                maxLength={THREAD_AUTO_NUDGE_PROMPT_MAX_CHARS}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Write the next instruction for this thread."
                size="sm"
                value={prompt}
              />
              <span className="text-muted-foreground">
                {prompt.length}/{THREAD_AUTO_NUDGE_PROMPT_MAX_CHARS}
              </span>
            </label>
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-medium">Continue this thread in background</div>
                <div className="text-muted-foreground">Manual queued work always runs first.</div>
              </div>
              <Switch
                aria-label="Continue this thread in background"
                checked={active && config.backgroundContinuation}
                disabled={!active || props.saving}
                onCheckedChange={(checked) =>
                  void props.onConfigure({
                    mode: config.mode,
                    prompt,
                    backgroundContinuation: checked,
                  })
                }
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-muted-foreground">
                {config.roundsDispatched}/{config.maxRounds} handoffs used
              </span>
              <Button
                disabled={props.saving || (active && prompt.trim().length === 0)}
                onClick={() =>
                  void props.onConfigure({
                    mode: config.mode,
                    prompt,
                    backgroundContinuation: active && config.backgroundContinuation,
                  })
                }
                size="sm"
                type="button"
                variant="secondary"
              >
                Save prompt
              </Button>
            </div>
            <p className="text-muted-foreground">
              Auto Nudge runs only after a new response completes. It has no idle timer. It can use
              paid provider tokens. Monitor this thread and your provider usage.
            </p>
            {props.saveError ? (
              <p className="text-destructive" role="alert">
                {props.saveError}
              </p>
            ) : null}
          </div>
        </CollapsiblePanel>
      </div>
    </Collapsible>
  );
}
