import { useEffect, useMemo, useState } from "react";
import type {
  EnvironmentId,
  ProviderSessionQuotaInput,
  ProviderSessionQuotaReport,
  ProviderSessionQuotaResult,
} from "@cafecode/contracts";

export interface ProviderQuotaContext {
  readonly environmentId: EnvironmentId;
  /** Null marks a Claude chat whose exact query is unavailable. Unlike Settings
   * input without session, it must never borrow another chat's latest report. */
  readonly input: ProviderSessionQuotaInput | null;
  readonly scopeRevision: string;
  readonly connected: boolean;
}

export interface ProviderQuotaState {
  readonly status: "loading" | "available" | "unavailable" | "offline";
  readonly report: ProviderSessionQuotaReport | null;
}

/** Metadata subscription only: it never refreshes a provider or submits /usage.
 * Scope/visibility changes clear in render, before old effect cleanup. Each
 * reconnect clears the previous reading while the authenticated transport
 * revalidates its subscription; transport delivery owns its connection fence. */
export function useProviderQuota(
  context: ProviderQuotaContext | undefined,
  visible: boolean,
  expectedClaude = false,
): ProviderQuotaState | undefined {
  const key = JSON.stringify(context ?? null);
  const request = useMemo(() => ({ key, visible }), [key, visible]);
  const [state, setState] = useState<{ request: typeof request; value: ProviderQuotaState } | null>(
    null,
  );
  useEffect(() => {
    // The serialized input contains only typed identifiers and the opaque UI
    // revision. Recreate its immutable scope rather than resubscribing whenever
    // a caller creates an equivalent props object during a clock-only render.
    const scoped = JSON.parse(key) as ProviderQuotaContext | null;
    if (!visible || !scoped?.connected || !scoped.input) return;
    const input = scoped.input;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const publish = (value: ProviderQuotaState) => {
      if (!current) return;
      clearTimeout(timer);
      setState({ request, value });
    };
    const awaiting = () => {
      publish({ status: "loading", report: null });
      timer = setTimeout(() => publish({ status: "unavailable", report: null }), 6_000);
    };
    awaiting();
    let close: (() => void) | undefined;
    const subscribe = async () => {
      try {
        // Hidden/unscoped legacy consumers must not load the runtime bootstrap
        // graph at all. This still uses the existing authenticated connection;
        // it neither bootstraps a connection nor probes a provider.
        const { requireEnvironmentConnection } = await import("../../environments/runtime");
        if (!current) return;
        close = requireEnvironmentConnection(
          scoped.environmentId,
        ).client.server.subscribeProviderQuota(
          input,
          (result: ProviderSessionQuotaResult) =>
            publish({ status: result.report ? "available" : "unavailable", report: result.report }),
          { onResubscribe: awaiting, retryNonTransportErrors: false },
        );
      } catch {
        publish({ status: "unavailable", report: null });
      }
    };
    void subscribe();
    return () => {
      current = false;
      clearTimeout(timer);
      close?.();
    };
    // The serialized scope captures the complete input, settings generation and
    // connection state; caller object identity alone is not a new subscription.
  }, [key, request, visible]);
  if (!context) return expectedClaude ? { status: "unavailable", report: null } : undefined;
  if (!context.connected) return { status: "offline", report: null };
  if (!context.input) return { status: "unavailable", report: null };
  if (!visible) return { status: "unavailable", report: null };
  return state?.request === request ? state.value : { status: "loading", report: null };
}
