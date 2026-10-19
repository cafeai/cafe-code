import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronRightIcon, CircleAlertIcon, RotateCcwIcon } from "lucide-react";
import {
  EventId,
  type EnvironmentId,
  type ProviderDiagnosticSnapshot,
  type ThreadId,
  type TurnId,
} from "@cafecode/contracts";
import type { TimestampFormat } from "@cafecode/contracts/settings";
import { uiText } from "@cafecode/shared/i18n";
import { deriveProviderDiagnosticCategory } from "@cafecode/shared/providerDiagnostic";
import { useUiLocale } from "~/i18n";
import { readEnvironmentApi } from "../../environmentApi";
import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import { useDelayedFlag } from "../../hooks/useDelayedFlag";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { getWsConnectionStatus, wsConnectionStatusAtom } from "../../rpc/wsConnectionState";
import { copyTextToClipboard } from "../../lib/copyToClipboard";
import { formatDiagnosticTimestamp } from "../../timestampFormat";
import {
  providerDiagnosticCategoryPresentation,
  providerDiagnosticCopyDetails,
  providerDiagnosticSubjectLabel,
  providerDiagnosticWorkLogLabel,
  readMatchingProviderDiagnosticResponse,
  type ProviderDiagnosticAction,
  type ProviderDiagnosticWorkLogRecord,
} from "../../providerDiagnostic";
import { cn } from "~/lib/utils";
import { SubagentAvatar } from "../subagents/SubagentAvatar";
import { Button } from "../ui/button";
import { InspectableWorkEntry } from "./InspectableWorkEntry";

type DiagnosticLoadState = {
  readonly scope: string;
  readonly generation: number;
  readonly status: "loading" | "loaded" | "error";
  readonly diagnostic: ProviderDiagnosticSnapshot | null;
};

/**
 * A private received-data reader, never a retry/control surface. Only explicit
 * expansion fetches the exact activity from its owning environment. Switching
 * chat, turn or occurrence synchronously hides old bytes and cancels their
 * eventual publication; no body data becomes header/tooltip/debug metadata.
 */
export const ProviderDiagnosticWorkEntry = memo(function ProviderDiagnosticWorkEntry(props: {
  readonly diagnostic: ProviderDiagnosticWorkLogRecord;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly turnId: TurnId | null;
  readonly activityId: string;
  readonly createdAt: string;
  readonly timestampFormat: TimestampFormat;
  /** Opens existing controls for the owning chat; omitted outside a chat. */
  readonly onAction?: (action: ProviderDiagnosticAction) => void;
}) {
  const uiLocale = useUiLocale();
  const scope = JSON.stringify([
    props.environmentId,
    props.threadId,
    props.turnId,
    props.activityId,
  ]);
  const [open, setOpen] = useState({ scope, expanded: false });
  const expanded = open.scope === scope && open.expanded;
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<DiagnosticLoadState | null>(null);
  const [copyState, setCopyState] = useState<{
    scope: string;
    kind: "json" | "details" | "failed";
  } | null>(null);
  // Technical details (IDs, JSON, copy) mount only on request and reset per
  // occurrence, so the default view leads with what happened and what to do.
  const [technical, setTechnical] = useState({ scope, open: false });
  const technicalOpen = technical.scope === scope && technical.open;
  const technicalPanelId = useId();
  const committedScope = useRef(scope);
  const readGeneration = useRef(0);
  const currentReadIsOwned = useRef<() => boolean>(() => false);
  useLayoutEffect(() => {
    committedScope.current = scope;
    return () => {
      readGeneration.current += 1;
    };
  }, [scope]);
  useEffect(() => {
    if (!expanded || !props.diagnostic.recorded || props.threadId === null) {
      // Do not retain private reader bytes while collapsed. The persisted
      // snapshot remains on the server, available through a fresh owner read.
      setLoaded(null);
      setCopyState(null);
      return;
    }
    const generation = ++readGeneration.current;
    const identity = {
      threadId: props.threadId,
      turnId: props.turnId,
      activityId: EventId.make(props.activityId),
    };
    let cancelled = false;
    setLoaded({ scope, generation, status: "loading", diagnostic: null });
    const api = readEnvironmentApi(props.environmentId);
    const requestedConnection = readEnvironmentConnection(props.environmentId);
    const primaryOpenedAt =
      requestedConnection?.kind === "primary" ? getWsConnectionStatus().connectedAt : null;
    const transportPermitsDetails = () => {
      if (requestedConnection?.kind === "saved") {
        const runtime = useSavedEnvironmentRuntimeStore.getState().byId[props.environmentId];
        return (
          runtime?.connectionState === "connected" &&
          runtime.authState === "authenticated" &&
          runtime.role === "owner"
        );
      }
      if (requestedConnection?.kind === "primary") {
        const status = getWsConnectionStatus();
        return status.phase === "connected" && status.connectedAt === primaryOpenedAt;
      }
      // Some admitted API adapters do not publish a transport registry entry.
      // Their private read still requires the server's authenticated owner and
      // secure-transport gate; absence is not invented local role evidence.
      return true;
    };
    const stillOwned = () =>
      !cancelled &&
      committedScope.current === scope &&
      readGeneration.current === generation &&
      transportPermitsDetails();
    currentReadIsOwned.current = stillOwned;
    const revoke = () => {
      if (cancelled) return;
      cancelled = true;
      currentReadIsOwned.current = () => false;
      readGeneration.current += 1;
      setLoaded({ scope, generation, status: "error", diagnostic: null });
      setCopyState(null);
    };
    // Explicit saved-server disconnects and transport replacements revoke
    // the reader's private material even when the selected thread id stays
    // unchanged. Observe the existing registry only: no auth/profile/network
    // probe or extra detail subscription is created by this disclosure.
    const observeAdmission = () => {
      if (
        readEnvironmentConnection(props.environmentId) !== requestedConnection ||
        !transportPermitsDetails()
      )
        revoke();
    };
    const unsubscribeConnection = subscribeEnvironmentConnections(observeAdmission);
    // Ordinary transport recovery retains the same connection object. Observe
    // only its existing in-memory lifecycle/role state, without fetching auth,
    // credentials or provider metadata. Reconnection never starts a new read.
    const unsubscribeSavedStatus =
      requestedConnection?.kind === "saved"
        ? useSavedEnvironmentRuntimeStore.subscribe(observeAdmission)
        : () => {};
    const unsubscribePrimaryStatus =
      requestedConnection?.kind === "primary"
        ? appAtomRegistry.subscribe(wsConnectionStatusAtom, observeAdmission)
        : () => {};
    if (!api || !transportPermitsDetails()) {
      revoke();
    } else {
      void api.orchestration.getThreadActivityDiagnostic(identity).then(
        (response) => {
          if (!stillOwned()) return;
          const admitted = readMatchingProviderDiagnosticResponse(response, identity);
          setLoaded({
            scope,
            generation,
            status: admitted ? "loaded" : "error",
            diagnostic: admitted?.diagnostic ?? null,
          });
        },
        () => {
          // Transport/provider exception text may itself contain private data.
          // Fixed local feedback is sufficient; an explicit read retry is safe.
          if (stillOwned()) setLoaded({ scope, generation, status: "error", diagnostic: null });
        },
      );
    }
    return () => {
      cancelled = true;
      unsubscribeConnection();
      unsubscribeSavedStatus();
      unsubscribePrimaryStatus();
    };
  }, [
    scope,
    expanded,
    attempt,
    props.diagnostic.recorded,
    props.environmentId,
    props.threadId,
    props.turnId,
    props.activityId,
  ]);

  const subject = props.diagnostic.summary.subject;
  const subjectLabel = providerDiagnosticSubjectLabel(props.diagnostic.summary, uiLocale);
  const retryLabel = providerDiagnosticWorkLogLabel(props.diagnostic, uiLocale);
  const state = loaded?.scope === scope ? loaded : null;
  const snapshot = expanded && state?.status === "loaded" ? state.diagnostic : null;
  const isRetry = props.diagnostic.summary.status === "retry";
  // Older rows lack the published category; derive the same closed category
  // from the structured fields of the already admitted private copy. The
  // collapsed heading keeps its public label, so nothing private leaks there.
  const category =
    props.diagnostic.category ??
    (snapshot ? deriveProviderDiagnosticCategory(snapshot) : undefined);
  const presentation =
    category !== undefined && !isRetry
      ? providerDiagnosticCategoryPresentation(category, uiLocale)
      : null;
  const action = presentation?.action !== undefined && props.onAction ? presentation.action : null;
  const showLoading = useDelayedFlag(
    expanded &&
      props.diagnostic.recorded &&
      props.threadId !== null &&
      (!state || state.status === "loading"),
  );
  const copy = (kind: "json" | "details") => {
    if (
      !snapshot ||
      !expanded ||
      committedScope.current !== scope ||
      state?.generation !== readGeneration.current ||
      !currentReadIsOwned.current()
    )
      return;
    const generation = readGeneration.current;
    void copyTextToClipboard(
      kind === "json" ? snapshot.json : providerDiagnosticCopyDetails(snapshot, uiLocale),
    ).then(
      () => {
        if (committedScope.current === scope && readGeneration.current === generation)
          setCopyState({ scope, kind });
      },
      () => {
        if (committedScope.current === scope && readGeneration.current === generation)
          setCopyState({ scope, kind: "failed" });
      },
    );
  };
  return (
    <InspectableWorkEntry
      kind="provider-diagnostic"
      expanded={expanded}
      onExpandedChange={(value) => {
        if (!value) {
          // Revoke before the next paint and before any queued copy callback.
          readGeneration.current += 1;
          setLoaded(null);
          setCopyState(null);
          setTechnical({ scope, open: false });
        }
        setOpen({ scope, expanded: value });
      }}
      accessibleLabel={uiText(
        "Inspect provider diagnostic: {subject} · {event}",
        { subject: subjectLabel, event: retryLabel },
        undefined,
        uiLocale,
      )}
      icon={
        subject.kind === "subagent" && subject.id ? (
          <SubagentAvatar seed={subject.id} className="size-4" />
        ) : props.diagnostic.summary.status === "error" ? (
          <CircleAlertIcon className="size-3 text-destructive-foreground" aria-hidden />
        ) : (
          <RotateCcwIcon className="size-3" aria-hidden />
        )
      }
      heading={
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 text-foreground">
          <span className="min-w-0 [overflow-wrap:anywhere]">
            <span data-provider-diagnostic-subject="true">{subjectLabel}</span>
            {" · "}
            <span
              className={
                props.diagnostic.summary.status === "error"
                  ? "text-destructive-foreground"
                  : undefined
              }
            >
              {retryLabel}
            </span>
          </span>
          <time
            dateTime={props.createdAt}
            className="ml-auto text-2xs text-muted-foreground tabular-nums"
            data-provider-diagnostic-time="true"
          >
            {formatDiagnosticTimestamp(props.createdAt, props.timestampFormat, uiLocale)}
          </time>
        </span>
      }
    >
      {/* Conditional mounting removes diagnostics immediately on collapse,
          rather than leaving private text in a hidden animated panel. */}
      {expanded ? (
        <div data-provider-diagnostic-details="true" className="min-w-0 space-y-3">
          {/* Cafe-authored guidance comes only from the public category, so
              it is useful even while the private copy loads or is missing. */}
          {presentation || isRetry || props.diagnostic.retriesBefore ? (
            <section className="space-y-2" data-provider-diagnostic-guidance="true">
              {presentation && category !== props.diagnostic.category ? (
                <p className="font-medium text-foreground">{presentation.title}</p>
              ) : null}
              {presentation ? (
                <p className="text-foreground [overflow-wrap:anywhere]">{presentation.guidance}</p>
              ) : isRetry ? (
                <p className="text-foreground">
                  {uiText(
                    "The provider lost its connection and is reconnecting. This usually recovers without any action.",
                    undefined,
                    undefined,
                    uiLocale,
                  )}
                </p>
              ) : null}
              {category === "cyber-policy" && props.diagnostic.turnDaybreak !== undefined ? (
                <p>
                  {props.diagnostic.turnDaybreak
                    ? uiText("Daybreak was on for this turn.", undefined, undefined, uiLocale)
                    : uiText("Daybreak was off for this turn.", undefined, undefined, uiLocale)}
                </p>
              ) : null}
              {props.diagnostic.retriesBefore ? (
                <p>
                  {props.diagnostic.retriesBefore.countLimited
                    ? uiText(
                        "Cafe saw at least {count} reconnect attempts before this error.",
                        { count: props.diagnostic.retriesBefore.count },
                        undefined,
                        uiLocale,
                      )
                    : uiText(
                        "Cafe saw {count, plural, one {# reconnect attempt} other {# reconnect attempts}} before this error.",
                        { count: props.diagnostic.retriesBefore.count },
                        undefined,
                        uiLocale,
                      )}
                </p>
              ) : null}
              {action ? (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => props.onAction?.(action)}
                  data-provider-diagnostic-action={action}
                >
                  {action === "model-picker"
                    ? uiText("Choose another model", undefined, undefined, uiLocale)
                    : action === "model-options"
                      ? uiText("Open model options", undefined, undefined, uiLocale)
                      : uiText("Open provider settings", undefined, undefined, uiLocale)}
                </Button>
              ) : null}
            </section>
          ) : null}
          {!props.diagnostic.recorded ||
          props.threadId === null ||
          (state?.status === "loaded" && !snapshot) ? (
            <p>
              {uiText(
                "Diagnostic details were not recorded for this event.",
                undefined,
                undefined,
                uiLocale,
              )}
            </p>
          ) : state?.status === "error" ? (
            <div className="space-y-2">
              <p role="status">
                {uiText(
                  "Could not load diagnostic details. Reconnect and try again.",
                  undefined,
                  undefined,
                  uiLocale,
                )}
              </p>
              <Button size="xs" variant="outline" onClick={() => setAttempt((value) => value + 1)}>
                {uiText("Retry details", undefined, undefined, uiLocale)}
              </Button>
            </div>
          ) : !snapshot && showLoading ? (
            <p role="status">
              {uiText("Loading diagnostic details…", undefined, undefined, uiLocale)}
            </p>
          ) : snapshot ? (
            <>
              {snapshot.message ? (
                <section aria-label={uiText("Provider message", undefined, undefined, uiLocale)}>
                  <p className="mb-1 text-2xs">
                    {uiText("Provider message", undefined, undefined, uiLocale)}
                  </p>
                  <p className="whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">
                    {snapshot.message}
                  </p>
                </section>
              ) : null}
              <div className="min-w-0">
                <button
                  type="button"
                  className="focus-ring group/technical -mx-1 flex items-center gap-1 rounded-sm px-1 py-0.5 text-2xs text-muted-foreground hover:text-foreground"
                  aria-expanded={technicalOpen}
                  aria-controls={technicalPanelId}
                  onClick={() => setTechnical({ scope, open: !technicalOpen })}
                >
                  <ChevronRightIcon
                    aria-hidden
                    className={cn(
                      "size-3 shrink-0 transition-transform duration-(--duration-fast) motion-reduce:transition-none",
                      technicalOpen && "rotate-90",
                    )}
                  />
                  {uiText("Technical details", undefined, undefined, uiLocale)}
                </button>
                {technicalOpen ? (
                  <div id={technicalPanelId} className="mt-2 min-w-0 space-y-2">
                    <dl className="space-y-1 [overflow-wrap:anywhere]">
                      <DiagnosticField
                        label={uiText("Source", undefined, undefined, uiLocale)}
                        value={snapshot.source}
                      />
                      {snapshot.method ? (
                        <DiagnosticField
                          label={uiText("Method", undefined, undefined, uiLocale)}
                          value={snapshot.method}
                        />
                      ) : null}
                      <DiagnosticField
                        label={uiText("Observed at", undefined, undefined, uiLocale)}
                        value={formatDiagnosticTimestamp(
                          snapshot.observedAt,
                          props.timestampFormat,
                          uiLocale,
                        )}
                      />
                      {snapshot.native.eventId ? (
                        <DiagnosticField
                          label={uiText("Event receipt ID", undefined, undefined, uiLocale)}
                          value={snapshot.native.eventId}
                        />
                      ) : null}
                      {snapshot.native.threadId ? (
                        <DiagnosticField
                          label={uiText("Native thread ID", undefined, undefined, uiLocale)}
                          value={snapshot.native.threadId}
                        />
                      ) : null}
                      {snapshot.native.turnId ? (
                        <DiagnosticField
                          label={uiText("Native turn ID", undefined, undefined, uiLocale)}
                          value={snapshot.native.turnId}
                        />
                      ) : null}
                      {snapshot.native.subagentRuntimeId ? (
                        <DiagnosticField
                          label={uiText("Runtime generation", undefined, undefined, uiLocale)}
                          value={snapshot.native.subagentRuntimeId}
                        />
                      ) : null}
                      {snapshot.native.requestId ? (
                        <DiagnosticField
                          label={uiText("Native request ID", undefined, undefined, uiLocale)}
                          value={snapshot.native.requestId}
                        />
                      ) : null}
                    </dl>
                    {/* One honest line replaces three stacked disclaimers. */}
                    <p className="text-2xs" data-provider-diagnostic-capture-note="true">
                      {uiText(
                        "Diagnostic copy with secrets removed before storage{redacted, select, yes {; secret values redacted} other {}}{omitted, select, yes {; some fields omitted} other {}}{truncated, select, yes {; truncated to the size limit} other {}}. Not the complete provider payload.",
                        {
                          redacted: snapshot.redacted ? "yes" : "no",
                          omitted: snapshot.omittedFields ? "yes" : "no",
                          truncated: snapshot.truncated ? "yes" : "no",
                        },
                        undefined,
                        uiLocale,
                      )}
                    </p>
                    {isRetry ? (
                      <p className="text-2xs">
                        {uiText(
                          "Retry observations do not record a retry deadline or prove recovery.",
                          undefined,
                          undefined,
                          uiLocale,
                        )}
                      </p>
                    ) : null}
                    <section
                      aria-label={uiText(
                        "Diagnostic JSON — secrets redacted",
                        undefined,
                        undefined,
                        uiLocale,
                      )}
                    >
                      <pre
                        className="min-w-0 font-mono text-xs leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]"
                        data-provider-diagnostic-json="true"
                      >
                        {snapshot.json}
                      </pre>
                    </section>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button size="xs" variant="outline" onClick={() => copy("details")}>
                        {uiText("Copy details", undefined, undefined, uiLocale)}
                      </Button>
                      <Button size="xs" variant="outline" onClick={() => copy("json")}>
                        {uiText("Copy JSON", undefined, undefined, uiLocale)}
                      </Button>
                      {copyState?.scope === scope ? (
                        <span role="status" className="text-2xs">
                          {copyState.kind === "failed"
                            ? uiText(
                                "Could not copy diagnostic details.",
                                undefined,
                                undefined,
                                uiLocale,
                              )
                            : uiText("Copied", undefined, undefined, uiLocale)}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </InspectableWorkEntry>
  );
});

function DiagnosticField(props: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex flex-wrap gap-x-2">
      <dt className="text-subtle-foreground">{props.label}</dt>
      <dd className="min-w-0 font-mono">{props.value}</dd>
    </div>
  );
}
