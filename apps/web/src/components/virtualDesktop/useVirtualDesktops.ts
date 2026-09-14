import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  VirtualDesktopError,
  type EnvironmentId,
  type ThreadId,
  type VirtualDesktopRequest,
} from "@cafecode/contracts";
import { getEnvironmentHttpBaseUrl, requireEnvironmentConnection } from "~/environments/runtime";

export function useVirtualDesktops(
  environmentId: EnvironmentId | null,
  threadId?: ThreadId | null,
  live = false,
  enabled = true,
) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = ["virtual-desktops", environmentId, threadId ?? null] as const;
  const query = useQuery({
    queryKey: key,
    queryFn: () => {
      if (!environmentId) throw new Error("No environment.");
      return requireEnvironmentConnection(environmentId).client.server.virtualDesktop({
        operation: "status",
        ...(threadId ? { threadId } : {}),
      });
    },
    enabled: Boolean(environmentId) && enabled,
    staleTime: 5000,
    // Disabled/unsupported providers must not turn every focused composer into
    // a perpetual status probe. Settings mutations invalidate this shared key.
    refetchInterval: live ? (query) => (query.state.data?.enabled ? 2000 : false) : false,
    retry: false,
  });
  async function change(input: VirtualDesktopRequest) {
    if (!environmentId || busy) return false;
    setBusy(true);
    setPendingId(input.id ?? input.operation);
    setError(null);
    try {
      const state =
        await requireEnvironmentConnection(environmentId).client.server.virtualDesktop(input);
      client.setQueryData(key, state);
      await client.invalidateQueries({ queryKey: ["virtual-desktops", environmentId] });
      return true;
    } catch (error) {
      // Desktop RPC errors contain bounded, server-authored explanations.
      // Keep native/transport failures behind the generic fallback.
      setError(
        error instanceof VirtualDesktopError
          ? error.message
          : "The desktop operation did not complete. Refresh its state before trying again.",
      );
      // A different chat may have acquired control since the picker loaded.
      // Refresh availability without retrying the rejected selection.
      await client.invalidateQueries({ queryKey: ["virtual-desktops", environmentId] });
      return false;
    } finally {
      setBusy(false);
      setPendingId(null);
    }
  }
  const environmentUrl = environmentId ? getEnvironmentHttpBaseUrl(environmentId) : null;
  let local = false;
  const bootstrap = window.desktopBridge?.getLocalEnvironmentBootstrap();
  try {
    local = Boolean(
      environmentUrl &&
      bootstrap?.httpBaseUrl &&
      new URL(environmentUrl).origin === new URL(bootstrap.httpBaseUrl).origin &&
      window.desktopBridge?.openVirtualDesktop,
    );
  } catch {
    /* no matching local client */
  }
  async function connect(id: string) {
    if (!local || !environmentUrl || busy) return;
    setBusy(true);
    setPendingId(id);
    setError(null);
    try {
      await window.desktopBridge!.openVirtualDesktop({
        id,
        environmentUrl,
        appearance: {
          dark: document.documentElement.classList.contains("dark"),
          scale: Math.min(
            3,
            Math.max(
              0.5,
              Number.parseFloat(getComputedStyle(document.documentElement).fontSize) / 16,
            ),
          ),
        },
      });
      await query.refetch();
    } catch {
      setError(
        "Could not open the desktop viewer. Recheck prerequisites and try again from the local Linux app.",
      );
    } finally {
      setBusy(false);
      setPendingId(null);
    }
  }
  return {
    ...query,
    busy,
    pendingId,
    error: error ?? (query.isError ? "Could not load desktops. Refresh to try again." : null),
    change,
    connect,
    local,
  };
}
