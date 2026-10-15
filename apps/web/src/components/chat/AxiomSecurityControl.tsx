import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, CopyIcon, RefreshCwIcon, ShieldCheckIcon, ShieldAlertIcon } from "lucide-react";
import type {
  EnvironmentId,
  ProviderSecurityInput,
  ProviderSecurityReport,
} from "@cafecode/contracts";
import { uiText } from "@cafecode/shared/i18n";
import { useUiLocale } from "~/i18n";
import { copyTextToClipboard } from "../../lib/copyToClipboard";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "../ui/dialog";

export function axiomSecurityLabel(
  report: ProviderSecurityReport | null,
  nowSeconds: number,
): string {
  if (!report) return uiText("Verification unavailable");
  if (report.reply.state === "verifying") return uiText("Verifying reply");
  if (report.reply.state === "verified") return uiText("Reply verified");
  if (report.reply.state === "incomplete") return uiText("Reply incomplete");
  if (report.reply.state === "failed") return uiText("Reply check failed");
  if (report.evidence && report.evidence.hardExpiresAtUnixSeconds <= nowSeconds)
    return uiText("Report needs refresh");
  if (report.attestation.state === "degraded") return uiText("Degraded attestation");
  if (report.attestation.state === "outdated") return uiText("Attestation needs review");
  if (report.attestation.state === "verified" && report.evidence)
    return uiText("Attestation verified");
  if (report.attestation.state === "verifying") return uiText("Verifying attestation");
  if (report.attestation.state === "failed") return uiText("Attestation check failed");
  return uiText("Attestation not verified");
}

const admitReport = (input: ProviderSecurityInput | null, report: ProviderSecurityReport | null) =>
  input && report?.runtimeId === input.runtimeId && report.modelId === input.modelId
    ? report
    : null;
const timestamp = (seconds: number) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(
    new Date(seconds * 1000),
  );

/** The parent keys this control by exact chat/account/runtime/model ownership.
 * This component subscribes to received metadata only; mounting and opening
 * the inspector never starts a provider, inference or verification request. */
export function AxiomSecurityControl({
  environmentId,
  input,
  connected,
  idle,
  onOpenChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly input: ProviderSecurityInput | null;
  readonly connected: boolean;
  readonly idle: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}) {
  const locale = useUiLocale();
  const instanceId = input?.instanceId;
  const threadId = input?.threadId;
  const runtimeId = input?.runtimeId;
  const modelId = input?.modelId;
  const request = useMemo(
    () => ({
      environmentId,
      connected,
      input:
        instanceId && threadId && runtimeId && modelId
          ? { instanceId, threadId, runtimeId, modelId }
          : null,
    }),
    [environmentId, connected, instanceId, threadId, runtimeId, modelId],
  );
  const currentRequest = useRef(request);
  useLayoutEffect(() => {
    currentRequest.current = request;
  }, [request]);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [received, setReceived] = useState<{
    request: typeof request;
    report: ProviderSecurityReport | null;
  } | null>(null);
  const [open, setOpen] = useState(false);
  const [pendingRequest, setPendingRequest] = useState<typeof request | null>(null);
  const [errorRequest, setErrorRequest] = useState<typeof request | null>(null);
  const [consented, setConsented] = useState<{
    request: typeof request;
    report: ProviderSecurityReport;
  } | null>(null);
  const pending = pendingRequest === request;
  const error = errorRequest === request;
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!request.input || !request.connected) return;
    let current = true;
    let unsubscribe: (() => void) | undefined;
    void import("../../environments/runtime")
      .then(({ requireEnvironmentConnection }) => {
        if (!current) return;
        unsubscribe = requireEnvironmentConnection(
          request.environmentId,
        ).client.server.subscribeProviderSecurity(
          request.input!,
          (result) => {
            if (current)
              setReceived({ request, report: admitReport(request.input, result.report) });
          },
          {
            onResubscribe: () => {
              if (current) setReceived({ request, report: null });
            },
            retryNonTransportErrors: false,
          },
        );
      })
      .catch(() => {
        if (current) setReceived({ request, report: null });
      });
    return () => {
      current = false;
      unsubscribe?.();
    };
  }, [request]);
  const report = received?.request === request && connected ? received.report : null;
  const consent = consented?.request === request && consented.report === report;
  const expiry = report?.evidence?.hardExpiresAtUnixSeconds;
  useEffect(() => {
    if (!expiry) return;
    // Expiry only changes presentation. It never renews evidence or changes
    // authentication of a reply accepted against its original environment.
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [expiry]);
  const label = axiomSecurityLabel(report, now);
  const outdated = report?.attestation.state === "outdated" && report.providerId === "near";
  const evidence = report?.evidence;
  const warning =
    outdated ||
    report?.attestation.state === "degraded" ||
    report?.reply.state === "failed" ||
    report?.reply.state === "incomplete";
  const Icon = warning ? ShieldAlertIcon : ShieldCheckIcon;
  const refresh = async (acceptOutdatedTee = false) => {
    if (!input || !connected || !idle || pending || (acceptOutdatedTee && (!outdated || !consent)))
      return;
    setPendingRequest(request);
    setErrorRequest(null);
    try {
      const { requireEnvironmentConnection } = await import("../../environments/runtime");
      if (!mounted.current || currentRequest.current !== request) return;
      const result = await requireEnvironmentConnection(
        environmentId,
      ).client.server.refreshProviderSecurity({
        ...input,
        ...(acceptOutdatedTee ? { acceptOutdatedTee: true } : {}),
      });
      if (!mounted.current || currentRequest.current !== request) return;
      setReceived({ request, report: admitReport(request.input, result.report) });
      setConsented(null);
    } catch {
      if (mounted.current && currentRequest.current === request) setErrorRequest(request);
    } finally {
      if (mounted.current && currentRequest.current === request) setPendingRequest(null);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        setConsented(null);
        setErrorRequest(null);
        onOpenChange?.(value);
      }}
    >
      <DialogTrigger
        render={
          <button
            type="button"
            className="cafe-composer-tab-action"
            data-axiom-verification="true"
          />
        }
      >
        <Icon
          aria-hidden="true"
          className={
            warning ? "size-3.5 shrink-0 text-status-attention-foreground" : "size-3.5 shrink-0"
          }
        />
        <span className="truncate" aria-live="polite">
          {label}
        </span>
      </DialogTrigger>
      <DialogPopup
        className="no-drag max-w-xl motion-reduce:transition-none"
        bottomStickOnMobile={false}
      >
        <DialogHeader>
          <DialogTitle>{uiText("Axiom verification", undefined, undefined, locale)}</DialogTitle>
          <DialogDescription>
            {uiText(
              "Verified by local AxiomCLI. Attestation and reply authentication are separate checks.",
              undefined,
              undefined,
              locale,
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5 break-words">
          <section className="space-y-2">
            <h3 className="text-sm font-medium">
              {uiText("Latest reply verification", undefined, undefined, locale)}
            </h3>
            <p className="text-sm text-muted-foreground">
              {report?.reply.state === "none" || !report
                ? uiText(
                    "No reply verification is available for this session.",
                    undefined,
                    undefined,
                    locale,
                  )
                : axiomSecurityLabel(
                    { ...report, attestation: { state: "unverified" }, evidence: null },
                    now,
                  )}
            </p>
          </section>
          <section className="space-y-3">
            <h3 className="text-sm font-medium">
              {uiText("Cached attestation report", undefined, undefined, locale)}
            </h3>
            <p className="text-sm text-muted-foreground">
              {report ? axiomSecurityLabel({ ...report, reply: { state: "none" } }, now) : label}
            </p>
            {evidence ? (
              <>
                <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
                  <dt>{uiText("Provider", undefined, undefined, locale)}</dt>
                  <dd>{evidence.providerId}</dd>
                  <dt>{uiText("Model", undefined, undefined, locale)}</dt>
                  <dd>{evidence.modelId}</dd>
                  <dt>{uiText("Verified at", undefined, undefined, locale)}</dt>
                  <dd>{timestamp(evidence.verifiedAtUnixSeconds)}</dd>
                  <dt>{uiText("Expires at", undefined, undefined, locale)}</dt>
                  <dd>{timestamp(evidence.hardExpiresAtUnixSeconds)}</dd>
                  <dt>{uiText("Encryption protocol", undefined, undefined, locale)}</dt>
                  <dd>{evidence.e2eeProtocol}</dd>
                </dl>
                <ul className="space-y-2 text-xs">
                  {evidence.checks.map((check) => (
                    <li
                      key={`${check.name}:${check.detail}:${check.passed}`}
                      className="flex gap-2"
                    >
                      <span aria-hidden="true">{check.passed ? "✓" : "!"}</span>
                      <span>
                        <strong>{check.name}</strong>
                        <span className="block text-muted-foreground">{check.detail}</span>
                      </span>
                    </li>
                  ))}
                </ul>
                <details className="text-xs">
                  <summary className="cursor-pointer py-1">
                    {uiText("Public evidence details", undefined, undefined, locale)}
                  </summary>
                  <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 break-all">
                    {JSON.stringify(evidence, null, 2)}
                  </pre>
                </details>
              </>
            ) : null}
          </section>
          <p className="text-xs text-muted-foreground">
            {uiText(
              "The report describes the provider checks shown above. Local chat storage and external tools are outside inference encryption.",
              undefined,
              undefined,
              locale,
            )}
          </p>
          {outdated ? (
            <label className="flex items-start gap-2 text-xs text-status-attention-foreground">
              <input
                type="checkbox"
                checked={consent}
                onChange={(event) =>
                  setConsented(event.target.checked && report ? { request, report } : null)
                }
              />
              <span>
                {uiText(
                  "Accept Intel OutOfDate for this NEAR provider until AxiomCLI restarts. All other verification checks remain required.",
                  undefined,
                  undefined,
                  locale,
                )}
              </span>
            </label>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {uiText(
                "Verification could not be refreshed. Check this session and try again.",
                undefined,
                undefined,
                locale,
              )}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!input || !connected || !idle || pending}
              onClick={() => void refresh()}
            >
              <RefreshCwIcon className="size-3.5" />
              {uiText("Refresh attestation", undefined, undefined, locale)}
            </Button>
            {outdated ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!consent || !idle || pending}
                onClick={() => void refresh(true)}
              >
                {uiText("Accept outdated TEE", undefined, undefined, locale)}
              </Button>
            ) : null}
            {evidence ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  void copyTextToClipboard(JSON.stringify(evidence, null, 2))
                    .then(() => setCopied(true))
                    .catch(() => {
                      if (mounted.current && currentRequest.current === request)
                        setErrorRequest(request);
                    });
                }}
              >
                {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
                {uiText("Copy public report", undefined, undefined, locale)}
              </Button>
            ) : null}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
