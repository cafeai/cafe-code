import { useCallback, useEffect, useRef, useState } from "react";
import { CheckIcon, MousePointer2Icon } from "lucide-react";
import type {
  EnvironmentId,
  GlideControlInput,
  GlideControlResult,
  GlideThreadActivity,
  RuntimeMode,
  ThreadId,
} from "@cafecode/contracts";
import { uiText } from "@cafecode/shared/i18n";
import { useUiLocale } from "~/i18n";
import { cn } from "~/lib/utils";
import { readEnvironmentApi } from "../../environmentApi";
import { getLocalShellCapabilities } from "../../localCapabilities";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { GlideSetupDialog } from "./GlideSetupDialog";
import {
  GLIDE_SETUP_ERROR,
  GLIDE_SETUP_POLL_INTERVAL_MS,
  type GlideSetupError,
  glideButtonDisabled,
  glideClickIntent,
  glidePermissionsGranted,
  glideSetupShouldPoll,
} from "./glideSetup";

type Read = { busy: boolean; reportErrors: boolean; action?: "status" | "activity" };

export function GlideControl({
  environmentId,
  threadId,
  runtimeMode,
  draftEnabled = false,
  onDraftEnabledChange,
  onActivityChange,
  draftRevision,
  refreshKey,
  disabled = false,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId | null;
  runtimeMode: RuntimeMode;
  draftEnabled?: boolean;
  onDraftEnabledChange?: (enabled: boolean, revision?: string) => void;
  onActivityChange?: (activity: GlideThreadActivity | undefined) => void;
  draftRevision?: string | undefined;
  refreshKey?: string | boolean;
  disabled?: boolean;
}) {
  const locale = useUiLocale();
  const [status, setStatus] = useState<GlideControlResult>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupStartedAt, setSetupStartedAt] = useState(0);
  const [pollingStopped, setPollingStopped] = useState(false);
  const [setupError, setSetupError] = useState<GlideSetupError>();
  // `owner` retires every response from a previous chat/mode/refresh scope.
  // Within one scope, request sequence numbers make the newest issued read or
  // mutation authoritative so a slow background poll cannot overwrite a newer
  // permission or toggle result.
  const owner = useRef(0);
  const issued = useRef(0);
  const applied = useRef(0);
  const mutating = useRef(false);
  const reading = useRef(false);
  const draft = useRef({
    enabled: draftEnabled,
    revision: draftRevision,
    change: onDraftEnabledChange,
  });
  draft.current = { enabled: draftEnabled, revision: draftRevision, change: onDraftEnabledChange };

  const request = useCallback(
    async (input: GlideControlInput, generation: number): Promise<GlideControlResult | null> => {
      const api = readEnvironmentApi(environmentId)?.glide;
      if (!api) return null;
      const sequence = ++issued.current;
      const value = await api.control(input);
      if (owner.current !== generation || sequence < applied.current) return null;
      applied.current = sequence;
      setStatus((previous) =>
        input.action === "activity" && previous
          ? {
              ...previous,
              enabled: value.enabled,
              paused: value.paused,
              busy: value.busy,
              activity: value.activity,
              stopRevision: value.stopRevision,
            }
          : value,
      );
      if (
        !threadId &&
        draft.current.enabled &&
        value.stopRevision !== undefined &&
        (draft.current.revision ?? "0") !== value.stopRevision
      )
        draft.current.change?.(false);
      return value;
    },
    [environmentId, threadId],
  );

  const read = useCallback(
    async (generation: number, mode: Read) => {
      // Never read while a permission mutation is in flight: the owner rejects
      // concurrent reads for that chat, and the mutation's result is newer.
      if (reading.current || mutating.current || owner.current !== generation) return;
      reading.current = true;
      if (mode.busy) setPending(true);
      try {
        await request(
          { action: mode.action ?? "status", ...(threadId ? { threadId } : {}) },
          generation,
        );
        if (owner.current === generation && mode.reportErrors) setError(false);
      } catch {
        if (owner.current === generation && mode.reportErrors) setError(true);
        if (owner.current === generation && mode.action === "activity")
          setStatus((previous) =>
            previous ? { ...previous, activity: { state: "unavailable" } } : previous,
          );
      } finally {
        if (owner.current === generation) {
          reading.current = false;
          if (mode.busy) setPending(false);
        }
      }
    },
    [request, threadId],
  );

  useEffect(() => {
    const generation = ++owner.current;
    setStatus(undefined);
    setError(false);
    setPending(false);
    reading.current = false;
    mutating.current = false;
    if (!readEnvironmentApi(environmentId)?.glide) return;
    const onFocus = () => {
      void read(generation, { busy: false, reportErrors: true });
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") onFocus();
    };
    void read(generation, { busy: true, reportErrors: true });
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (owner.current === generation) owner.current++;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [environmentId, threadId, runtimeMode, refreshKey, read]);

  const granted = glidePermissionsGranted(status);
  useEffect(() => {
    onActivityChange?.(status?.activity);
  }, [onActivityChange, status?.activity]);
  useEffect(() => {
    if (!(status?.enabled || (!threadId && draftEnabled))) return;
    const generation = owner.current;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible")
        void read(generation, { busy: false, reportErrors: false, action: "activity" });
    }, 500);
    return () => window.clearInterval(timer);
  }, [status?.enabled, threadId, draftEnabled, read]);
  // Poll only while setup is open and incomplete. The timer belongs to this
  // effect, so closing, completing, unmounting or a chat change clears it.
  useEffect(() => {
    if (!setupOpen || granted || pollingStopped) return;
    const generation = owner.current;
    const timer = window.setInterval(() => {
      if (
        !glideSetupShouldPoll({
          open: true,
          granted: false,
          startedAt: setupStartedAt,
          now: Date.now(),
        })
      ) {
        window.clearInterval(timer);
        setPollingStopped(true);
        return;
      }
      void read(generation, { busy: false, reportErrors: false });
    }, GLIDE_SETUP_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [setupOpen, granted, pollingStopped, setupStartedAt, read]);

  const mutate = async (input: GlideControlInput) => {
    if (mutating.current) return null;
    const generation = owner.current;
    mutating.current = true;
    setPending(true);
    setError(false);
    try {
      return await request(input, generation);
    } catch {
      if (owner.current === generation) setError(true);
      return null;
    } finally {
      if (owner.current === generation) {
        mutating.current = false;
        setPending(false);
      }
    }
  };

  const openSetup = () => {
    setSetupError(undefined);
    setPollingStopped(false);
    setSetupStartedAt(Date.now());
    setSetupOpen(true);
    void read(owner.current, { busy: false, reportErrors: false });
  };

  // Settings and Finder actions return a fresh status but never imply a grant:
  // completion still comes only from the native permission fields.
  const sideAction = async (
    action: "open-accessibility" | "open-screen-recording" | "reveal-host-app",
  ) => {
    const generation = owner.current;
    setSetupError(undefined);
    try {
      await request({ action, ...(threadId ? { threadId } : {}) }, generation);
    } catch {
      if (owner.current === generation)
        setSetupError(
          action === "reveal-host-app" ? GLIDE_SETUP_ERROR.reveal : GLIDE_SETUP_ERROR.settings,
        );
    }
  };

  const enable = async () => {
    setSetupError(undefined);
    if (threadId) {
      const value = await mutate({ action: "set-enabled", threadId, enabled: true });
      if (value?.enabled) setSetupOpen(false);
      else setSetupError(GLIDE_SETUP_ERROR.enable);
      return;
    }
    const value = await mutate({ action: "status" });
    if (value && glidePermissionsGranted(value)) {
      onDraftEnabledChange?.(true, value.stopRevision ?? "0");
      setSetupOpen(false);
    } else setSetupError(GLIDE_SETUP_ERROR.enable);
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
          : status && !granted
            ? uiText(
                "macOS permissions are needed. Click to set up computer use.",
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
    <>
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
              aria-haspopup={!enabled && status && !granted ? "dialog" : undefined}
              disabled={glideButtonDisabled({
                disabled,
                pending,
                canTarget: !!threadId || !!onDraftEnabledChange,
                enabled,
                error,
                status,
                runtimeMode,
              })}
              className={cn(
                "shrink-0 gap-1.5 px-2 text-muted-foreground hover:text-foreground",
                enabled && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
              )}
              onPointerDown={(event) => {
                if (event.pointerType === "mouse") event.preventDefault();
              }}
              onClick={() => {
                const intent = glideClickIntent({ error, enabled, status });
                if (intent === "refresh") {
                  void mutate({ action: "status", ...(threadId ? { threadId } : {}) });
                  return;
                }
                if (intent === "setup") {
                  openSetup();
                  return;
                }
                if (threadId) void mutate({ action: "set-enabled", threadId, enabled: !enabled });
                else if (enabled) onDraftEnabledChange?.(false);
                else void enable();
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
      <GlideSetupDialog
        open={setupOpen}
        onOpenChange={setSetupOpen}
        status={status}
        enabled={enabled}
        enabling={pending}
        error={setupError}
        pollingStopped={pollingStopped}
        canReveal={getLocalShellCapabilities(environmentId).canOpenLocalPath}
        onOpenSettings={(action) => void sideAction(action)}
        onReveal={() => void sideAction("reveal-host-app")}
        onCheckAgain={() => {
          setPollingStopped(false);
          setSetupStartedAt(Date.now());
          void read(owner.current, { busy: false, reportErrors: false });
        }}
        onEnable={() => void enable()}
      />
    </>
  );
}
