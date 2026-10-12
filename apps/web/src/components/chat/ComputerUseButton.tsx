import { useUiLocale } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import type { NativeControlChatState, ProviderDriverKind, ThreadId } from "@cafecode/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ComputerUseIcon } from "./ComputerUseIcon";
import { useEffect } from "react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useNativeControlActivity, computerActivityText } from "./useNativeControlActivity";

const queryKey = (threadId: ThreadId | null) => ["native-computer-use", threadId] as const;

export function ComputerUseButton({
  threadId,
  provider,
  local,
}: {
  threadId: ThreadId | null;
  provider: ProviderDriverKind;
  local: boolean;
}) {
  const uiLocale = useUiLocale();

  const bridge = window.desktopBridge;
  const activity = useNativeControlActivity();
  const ownsActivity =
    activity?.threadId === threadId && activity?.phase !== "inactive" && activity?.episode;
  const supported = Boolean(
    local &&
    threadId &&
    (provider === "codex" || provider === "claudeAgent") &&
    bridge?.getNativeControlChatState &&
    bridge?.setNativeControlChatEnabled,
  );
  const client = useQueryClient();
  const { data } = useQuery({
    queryKey: queryKey(threadId),
    queryFn: async () => {
      const next = await bridge!.getNativeControlChatState!(threadId!);
      const current = client.getQueryData<NativeControlChatState>(queryKey(threadId));
      return current && current.revision > next.revision ? current : next;
    },
    enabled: supported,
    staleTime: Infinity,
    refetchOnWindowFocus: "always",
    retry: false,
  });
  useEffect(() => {
    if (!supported) return;
    return bridge?.onNativeControlChanged?.(() => {
      void client.invalidateQueries({ queryKey: ["native-computer-use"] });
    });
  }, [bridge, client, supported]);
  const mutation = useMutation({
    mutationFn: (input: { threadId: ThreadId; enabled: boolean }) =>
      bridge!.setNativeControlChatEnabled!(input),
    onSuccess: (state: NativeControlChatState) => {
      // A switch to another chat never turns a late acknowledgement into a
      // write to that chat. Only update the server-acknowledged captured key.
      client.setQueryData<NativeControlChatState>(queryKey(state.threadId), (previous) =>
        previous && previous.revision > state.revision ? previous : state,
      );
    },
    onError: (_error, input) => {
      void client.invalidateQueries({ queryKey: queryKey(input.threadId) });
    },
  });
  if (!supported || data?.threadId !== threadId || (!data.control.enabled && !ownsActivity))
    return null;
  const pending = mutation.isPending && mutation.variables?.threadId === threadId;
  const failed = mutation.isError && mutation.variables?.threadId === threadId;
  const unavailable = data.control.phase !== "ready" || !data.control.runtimeAvailable;
  const detail = pending
    ? uiText("Updating computer use…", undefined, undefined, uiLocale)
    : failed
      ? uiText("Could not change computer use. Try again.", undefined, undefined, uiLocale)
      : unavailable
        ? uiText("Check local desktop control in Settings → MCP.", undefined, undefined, uiLocale)
        : data.enabled
          ? uiText(
              "Computer use is on for this chat. Click to disable desktop control and browser page access.",
              undefined,
              undefined,
              uiLocale,
            )
          : uiText(
              "Computer use is off for this chat. Click to enable desktop control and browser page access.",
              undefined,
              undefined,
              uiLocale,
            );
  const activityDetail =
    ownsActivity && activity
      ? uiText(
          "{provider} · {activity} · {target}. Window images and controls can be supplied to this chat''s selected provider. {policy}",
          {
            provider: activity.provider === "claudeAgent" ? "Claude" : "Codex",
            activity: computerActivityText(activity, uiLocale),
            target: activity.target
              ? [activity.target.app, activity.target.title].filter(Boolean).join(" · ")
              : uiText("Selecting target", undefined, undefined, uiLocale),
            policy:
              activity.inputPolicy === "background-only"
                ? uiText("Background input only.", undefined, undefined, uiLocale)
                : uiText(
                    "Foreground input is allowed when needed.",
                    undefined,
                    undefined,
                    uiLocale,
                  ),
          },
          undefined,
          uiLocale,
        )
      : undefined;
  return (
    <div className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={uiText("Computer use", undefined, undefined, uiLocale)}
              aria-pressed={data.enabled}
              aria-disabled={pending || unavailable}
              className={cn(
                "shrink-0 gap-1.5 px-2 text-xs",
                data.enabled
                  ? "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"
                  : "text-muted-foreground hover:text-foreground",
                (pending || unavailable) && "opacity-50",
              )}
              onClick={() => {
                if (pending || unavailable || !threadId) return;
                mutation.mutate({ threadId, enabled: !data.enabled });
              }}
            />
          }
        >
          <ComputerUseIcon className="size-4 shrink-0" />
          <span
            role={ownsActivity ? "status" : undefined}
            aria-live={ownsActivity ? "polite" : undefined}
          >
            {ownsActivity && activity
              ? computerActivityText(activity, uiLocale)
              : uiText("Computer use", undefined, undefined, uiLocale)}
          </span>
        </TooltipTrigger>
        <TooltipPopup className="max-w-80">{activityDetail ?? detail}</TooltipPopup>
      </Tooltip>
      {ownsActivity && activity && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="px-2 text-xs"
          disabled={activity.phase === "stopping"}
          aria-label={uiText("Stop computer use", undefined, undefined, uiLocale)}
          onClick={() => {
            if (activity.episode)
              void bridge
                ?.stopNativeControlActivity?.(activity.episode)
                .then(() => client.invalidateQueries({ queryKey: ["native-computer-use"] }))
                .catch(() => {});
          }}
        >
          {uiText("Stop", undefined, undefined, uiLocale)}
        </Button>
      )}
    </div>
  );
}
