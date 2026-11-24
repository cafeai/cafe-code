import type {
  EnvironmentId,
  ProviderSessionQuotaInput,
  ProviderSessionQuotaReport,
  ProviderSessionQuotaResult,
} from "@cafecode/contracts";
import { useEffect, useMemo, useState } from "react";
import { useSavedEnvironmentRuntimeStore } from "../../environments/runtime/catalog";
import { subscribeMetadata } from "./metadataSubscription";

export interface ProviderQuotaContext {
  readonly environmentId: EnvironmentId;
  /** Null denies a subscription when the selected scope is unavailable. */
  readonly input: ProviderSessionQuotaInput | null;
  /** A chat without its own query can read native account allowances, but
   * cannot borrow another chat's passive report from an older remote owner. */
  readonly nativeOnly?: boolean;
  readonly scopeRevision: string;
  readonly connected: boolean;
  /** Presentation only; changing models reuses the same account observation. */
  readonly selectedModel?: string | null | undefined;
}

export interface ProviderQuotaState {
  readonly status: "loading" | "available" | "unavailable" | "offline";
  readonly report: ProviderSessionQuotaReport | null;
  readonly stale?: true;
}

type QuotaUpdate =
  | { readonly kind: "transport"; readonly status: "loading" | "unavailable" }
  | { readonly kind: "server"; readonly result: ProviderSessionQuotaResult };

function waitingForQuota(
  status: "loading" | "unavailable" | "offline",
  earlier: ProviderSessionQuotaReport | null | undefined,
): ProviderQuotaState {
  // Only a native allowance can survive a transport interruption. The passive
  // session report remains tied to an actively verified native query.
  return earlier?.source === "claude-cli"
    ? { status, report: earlier, stale: true }
    : { status, report: null };
}

/** Keep a historical native reading while the same visible scope reconnects.
 * Any scope change clears it in render. Authoritative server responses, even
 * null, replace it so a revoked binding cannot inherit the old report. */
export function useProviderQuota(
  context: ProviderQuotaContext | undefined,
  visible: boolean,
  expectedClaude = false,
): ProviderQuotaState | undefined {
  const environmentDenied = useSavedEnvironmentRuntimeStore((store) => {
    const runtime = context ? store.byId[context.environmentId] : undefined;
    return runtime?.authState === "requires-auth" || runtime?.role === "client";
  });
  // A known revocation is a scope change, even during an offline interval.
  const input = environmentDenied ? null : context?.input;
  const key = JSON.stringify(
    context
      ? {
          environmentId: context.environmentId,
          input,
          nativeOnly: context.nativeOnly,
          scopeRevision: context.scopeRevision,
        }
      : null,
  );
  const scope = useMemo(() => ({ key, visible }), [key, visible]);
  const connected = context?.connected === true;
  const request = useMemo(() => ({ scope, connected }), [scope, connected]);
  const [state, setState] = useState<{
    request: typeof request;
    value: ProviderQuotaState;
  } | null>(null);
  useEffect(() => {
    // Decode only the immutable typed scope, without resubscribing on a
    // differently allocated props object or a presentation-only model change.
    const scoped = JSON.parse(request.scope.key) as ProviderQuotaContext | null;
    if (!request.scope.visible || !request.connected || !scoped?.input) return;
    const input = scoped.input;
    return subscribeMetadata<QuotaUpdate>({
      loading: { kind: "transport", status: "loading" },
      unavailable: { kind: "transport", status: "unavailable" },
      // Account selection may use its bounded authentication check before the
      // separate native allowance read. Leave the owner's fifteen-second read
      // bound room to publish before this presentation-only loading deadline.
      loadingTimeoutMs: 16_000,
      publish: (update) =>
        setState((previous) => {
          if (update.kind === "transport") {
            const earlier =
              previous?.request.scope === request.scope ? previous.value.report : null;
            return { request, value: waitingForQuota(update.status, earlier) };
          }
          const { result } = update;
          const report =
            scoped.nativeOnly && result.report?.source !== "claude-cli" ? null : result.report;
          return {
            request,
            value: {
              status: report ? "available" : "unavailable",
              report,
              ...(report && result.stale ? { stale: true } : {}),
            },
          };
        }),
      subscribe: async (publish, awaiting, active) => {
        const { requireEnvironmentConnection } = await import("../../environments/runtime");
        if (!active()) return () => undefined;
        return requireEnvironmentConnection(
          scoped.environmentId,
        ).client.server.subscribeProviderQuota(
          input,
          (result) => publish({ kind: "server", result }),
          { onResubscribe: awaiting, retryNonTransportErrors: false },
        );
      },
    });
  }, [request]);
  if (!context) return expectedClaude ? { status: "unavailable", report: null } : undefined;
  if (!input || !visible) return { status: "unavailable", report: null };
  const earlier = state?.request.scope === scope ? state.value.report : null;
  if (!connected) return waitingForQuota("offline", earlier);
  return state?.request === request ? state.value : waitingForQuota("loading", earlier);
}
