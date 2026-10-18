import { useEffect, useRef, useState } from "react";
import { CheckIcon, MousePointer2Icon } from "lucide-react";
import type {
  EnvironmentId,
  GlideControlInput,
  GlideControlResult,
  RuntimeMode,
  ThreadId,
} from "@cafecode/contracts";
import { uiText } from "@cafecode/shared/i18n";
import { useUiLocale } from "~/i18n";
import { cn } from "~/lib/utils";
import { readEnvironmentApi } from "../../environmentApi";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function GlideControl({
  environmentId,
  threadId,
  runtimeMode,
  draftEnabled = false,
  onDraftEnabledChange,
  refreshKey,
  disabled = false,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId | null;
  runtimeMode: RuntimeMode;
  draftEnabled?: boolean;
  onDraftEnabledChange?: (enabled: boolean) => void;
  refreshKey?: string | boolean;
  disabled?: boolean;
}) {
  const locale = useUiLocale();
  const [status, setStatus] = useState<GlideControlResult>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const owner = useRef(0);
  const inFlight = useRef(false);

  useEffect(() => {
    const generation = ++owner.current;
    setStatus(undefined);
    setError(false);
    setPending(false);
    inFlight.current = false;
    const api = readEnvironmentApi(environmentId)?.glide;
    if (!api) return;
    const refresh = async () => {
      if (inFlight.current || owner.current !== generation) return;
      inFlight.current = true;
      setPending(true);
      try {
        const value = await api.control({ action: "status", ...(threadId ? { threadId } : {}) });
        if (owner.current === generation) {
          setStatus(value);
          setError(false);
        }
      } catch {
        if (owner.current === generation) setError(true);
      } finally {
        if (owner.current === generation) {
          inFlight.current = false;
          setPending(false);
        }
      }
    };
    const onFocus = () => {
      void refresh();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    void refresh();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (owner.current === generation) owner.current++;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [environmentId, threadId, runtimeMode, refreshKey]);

  const execute = async (input: GlideControlInput) => {
    const api = readEnvironmentApi(environmentId)?.glide;
    if (!api || inFlight.current) return;
    const generation = owner.current;
    inFlight.current = true;
    setPending(true);
    setError(false);
    try {
      const value = await api.control(input);
      if (owner.current === generation) setStatus(value);
    } catch {
      if (owner.current === generation) setError(true);
    } finally {
      if (owner.current === generation) {
        inFlight.current = false;
        setPending(false);
      }
    }
  };
  const enabled = threadId ? status?.enabled === true : draftEnabled;
  const label = uiText("Computer use", undefined, undefined, locale);
  const description = error
    ? uiText("Computer use could not be confirmed. Click to refresh.", undefined, undefined, locale)
    : enabled
      ? uiText(
          "Computer use is on. Click to turn it off for this chat.",
          undefined,
          undefined,
          locale,
        )
      : status && !status.available
        ? uiText("Computer use requires the macOS desktop app.", undefined, undefined, locale)
        : runtimeMode !== "full-access"
          ? uiText("Select Full access to enable computer use.", undefined, undefined, locale)
          : status && !status.accessibility
            ? uiText(
                "Allow Cafe Code to control your Mac. Click to open System Settings.",
                undefined,
                undefined,
                locale,
              )
            : status && !status.screenRecording
              ? uiText(
                  "Allow screen recording for Cafe Code. Click to open System Settings.",
                  undefined,
                  undefined,
                  locale,
                )
              : uiText(
                  "Allow this chat to read and control desktop apps in the background.",
                  undefined,
                  undefined,
                  locale,
                );
  return (
    <Tooltip>
      <TooltipTrigger
        delay={250}
        render={
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-computer-use="true"
            aria-label={label}
            aria-pressed={enabled}
            aria-busy={pending}
            disabled={
              disabled ||
              pending ||
              (!threadId && !onDraftEnabledChange) ||
              (!enabled && (!status?.available || runtimeMode !== "full-access") && !error)
            }
            className={cn(
              "shrink-0 gap-1.5 px-2 text-muted-foreground hover:text-foreground",
              enabled && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
            )}
            onPointerDown={(event) => {
              if (event.pointerType === "mouse") event.preventDefault();
            }}
            onClick={() => {
              const target = threadId ? { threadId } : {};
              if (error) {
                void execute({ action: "status", ...target });
                return;
              }
              if (!enabled && !status?.accessibility) {
                void execute({ action: "open-accessibility", ...target });
                return;
              }
              if (!enabled && !status?.screenRecording) {
                void execute({ action: "open-screen-recording", ...target });
                return;
              }
              if (threadId) void execute({ action: "set-enabled", threadId, enabled: !enabled });
              else onDraftEnabledChange?.(!enabled);
            }}
          />
        }
      >
        <MousePointer2Icon aria-hidden="true" className="size-3.5" />
        <span>{label}</span>
        {enabled ? <CheckIcon aria-hidden="true" className="size-3" /> : null}
      </TooltipTrigger>
      <TooltipPopup role="tooltip" className="no-drag pointer-events-none max-w-72">
        {description}
      </TooltipPopup>
    </Tooltip>
  );
}
