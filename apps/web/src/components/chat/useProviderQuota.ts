import type {
  EnvironmentId,
  ProviderSessionQuotaInput,
  ProviderSessionQuotaReport,
  ProviderSessionQuotaResult,
} from "@cafecode/contracts";
import { useEffect, useMemo, useState } from "react";
import { subscribeMetadata } from "./metadataSubscription";

export interface ProviderQuotaContext {
  readonly environmentId: EnvironmentId;
  /** Null marks a Claude chat whose exact query is unavailable. Unlike Settings
   * input without session, it must never borrow another chat's latest report. */
  readonly input: ProviderSessionQuotaInput | null;
  readonly scopeRevision: string;
  readonly connected: boolean;
  /** Presentation only; changing models reuses the same account observation. */
  readonly selectedModel?: string | null | undefined;
}

export interface ProviderQuotaState {
  readonly status: "loading" | "available" | "unavailable" | "offline";
  readonly report: ProviderSessionQuotaReport | null;
}

/** Metadata subscription: the owner may read native allowances without a prompt.
 * Scope/visibility changes clear in render, before old effect cleanup. Each
 * reconnect clears the previous reading while the authenticated transport
 * revalidates its subscription; transport delivery owns its connection fence. */
export function useProviderQuota(
  context: ProviderQuotaContext | undefined,
  visible: boolean,
  expectedClaude = false,
): ProviderQuotaState | undefined {
  const key = JSON.stringify(
    context
      ? {
          environmentId: context.environmentId,
          input: context.input,
          scopeRevision: context.scopeRevision,
          connected: context.connected,
        }
      : null,
  );
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
    return subscribeMetadata<ProviderQuotaState>({
      loading: { status: "loading", report: null },
      unavailable: { status: "unavailable", report: null },
      publish: (value) => setState({ request, value }),
      subscribe: async (publish, awaiting, active) => {
        const { requireEnvironmentConnection } = await import("../../environments/runtime");
        if (!active()) return () => undefined;
        return requireEnvironmentConnection(
          scoped.environmentId,
        ).client.server.subscribeProviderQuota(
          input,
          (result: ProviderSessionQuotaResult) =>
            publish({ status: result.report ? "available" : "unavailable", report: result.report }),
          { onResubscribe: awaiting, retryNonTransportErrors: false },
        );
      },
    });
    // The serialized scope captures the complete input, settings generation and
    // connection state; caller object identity alone is not a new subscription.
  }, [key, request, visible]);
  if (!context) return expectedClaude ? { status: "unavailable", report: null } : undefined;
  if (!context.connected) return { status: "offline", report: null };
  if (!context.input) return { status: "unavailable", report: null };
  if (!visible) return { status: "unavailable", report: null };
  return state?.request === request ? state.value : { status: "loading", report: null };
}
