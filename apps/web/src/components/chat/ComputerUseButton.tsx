import type { NativeControlChatState, ProviderDriverKind, ThreadId } from "@cafecode/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MousePointer2Icon } from "lucide-react";
import { useEffect } from "react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

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
  const bridge = window.desktopBridge;
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
  if (!supported || data?.threadId !== threadId || !data.control.enabled) return null;
  const pending = mutation.isPending && mutation.variables?.threadId === threadId;
  const failed = mutation.isError && mutation.variables?.threadId === threadId;
  const unavailable = data.control.phase !== "ready" || !data.control.runtimeAvailable;
  const detail = pending
    ? "Updating computer use…"
    : failed
      ? "Could not change computer use. Try again."
      : unavailable
        ? "Check local desktop control in Settings → MCP."
        : `Computer use is ${data.enabled ? "on" : "off"} for this chat. Click to ${data.enabled ? "disable" : "enable"}.`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Computer use"
            aria-pressed={data.enabled}
            aria-disabled={pending || unavailable}
            className={cn(
              "shrink-0",
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
        <MousePointer2Icon
          aria-hidden="true"
          className={cn("size-4", data.enabled && "fill-primary/20")}
        />
      </TooltipTrigger>
      <TooltipPopup className="max-w-64">{detail}</TooltipPopup>
    </Tooltip>
  );
}
