/** Transport qualification only: callers construct the ordinary opaque
 * document before entering this helper, as the original ten-second probes did.
 * No renderer state, source admission or native browser context is shared. */
const phases = [
  "document-constructed",
  "frame-loaded",
  "request-sent",
  "parser-entered",
  "parser-returned",
  "render-entered",
  "render-returned",
] as const;

type ProbePhase = (typeof phases)[number];
type ProbeInvocation = "baseline" | "mutation" | "parser-substitute";
type ProbeResultFailure =
  | "received an invalid result"
  | "parsed database mutation was not applied"
  | "native event-state resolver crossed its pre-layout fence"
  | "native parser crossed its pre-parse allocation fence"
  | "native diagram-output mutation was not applied";

class MermaidProbeResultError extends Error {
  constructor(readonly reason: ProbeResultFailure) {
    super(reason);
  }
}

/** Preserve useful proof failures without copying arbitrary received errors. */
export function refuseMermaidProbeResult(reason: ProbeResultFailure): never {
  throw new MermaidProbeResultError(reason);
}

interface MermaidProbeOptions<T> {
  readonly id: string;
  readonly documentSource: string;
  readonly source: string;
  readonly theme: "light" | "dark";
  readonly kind: "Graph admission probe" | "Family admission probe" | "Native diagram-output probe";
  readonly invocation: ProbeInvocation;
  readonly readResult: (data: Record<string, unknown>) => T;
}

export function runMermaidProbe<T>(options: MermaidProbeOptions<T>): Promise<T> {
  const frame = document.createElement("iframe");
  const channel = new MessageChannel();
  frame.dataset.mermaidFamilySecurityFixture = options.id;
  frame.setAttribute("sandbox", "allow-scripts");
  return new Promise((resolve, reject) => {
    let settled = false;
    let phase: ProbePhase = "document-constructed";
    const failure = (reason: string) =>
      new Error(`${options.kind} ${reason} (${options.invocation}; phase ${phase})`);
    const finish = (outcome: { readonly result: T } | { readonly error: Error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      // Clear every callback before closing/removing its owner. Already queued
      // callbacks also check settled: a retired frame cannot transfer its port,
      // send another source request, or settle a later invocation's result.
      frame.onload = null;
      frame.onerror = null;
      channel.port1.onmessage = null;
      channel.port1.onmessageerror = null;
      channel.port1.close();
      channel.port2.close();
      frame.remove();
      if ("error" in outcome) reject(outcome.error);
      else resolve(outcome.result);
    };
    // Preserve the original scope and duration: document construction has
    // finished, while frame loading, parsing and the reply all share one fixed
    // allowance. Observed breadcrumbs never renew this timer or authorize a
    // retry, and it remains an asynchronous bound rather than a CPU deadline.
    const deadline = performance.now() + 10_000;
    const expired = () => performance.now() >= deadline;
    const timeout = setTimeout(() => finish({ error: failure("did not reply") }), 10_000);
    channel.port1.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (settled || !data || typeof data !== "object" || !("id" in data) || data.id !== options.id)
        return;
      // Browser work can delay the timer callback behind an already queued
      // message. An expired reply still fails; timer delivery order is never
      // permission to accept success beyond the original allowance.
      if (expired()) {
        finish({ error: failure("did not reply") });
        return;
      }
      try {
        if (Array.isArray(data) || Object.getPrototypeOf(data) !== Object.prototype)
          refuseMermaidProbeResult("received an invalid result");
        if ("probePhase" in data) {
          // Only exact fixed phase scalars may cross this diagnostic boundary.
          // No source, parser error, mutation text or received object is ever
          // interpolated into a failure. Port identity/id still own the reply.
          const next = phases.indexOf(data.probePhase as ProbePhase);
          if (Object.keys(data).sort().join(",") !== "id,probePhase" || next < 3)
            throw failure("received an invalid phase");
          // These are observations, not a second parser-call policy. Native
          // paths may enter/return more than once; the callers' original exact
          // parser/state counts remain authoritative, and repeated phases
          // neither reject a valid result nor renew the absolute deadline.
          phase = phases[next]!;
          return;
        }
        finish({ result: options.readResult(data as Record<string, unknown>) });
      } catch (error) {
        // Validators use fixed errors too. Keep the last observed phase even
        // for malformed replies, without displaying their unqualified fields.
        finish({
          error: failure(
            error instanceof MermaidProbeResultError ? error.reason : "received an invalid result",
          ),
        });
      }
    };
    channel.port1.onmessageerror = () => finish({ error: failure("message failed") });
    frame.onerror = () => finish({ error: failure("load failed") });
    frame.onload = () => {
      if (settled) return;
      if (expired()) {
        finish({ error: failure("did not reply") });
        return;
      }
      frame.onload = null;
      phase = "frame-loaded";
      try {
        if (!frame.contentWindow) {
          finish({ error: failure("lost its frame") });
          return;
        }
        frame.contentWindow.postMessage("cafe-mermaid-render", "*", [channel.port2]);
        channel.port1.postMessage({ id: options.id, source: options.source, theme: options.theme });
        if (!settled) phase = "request-sent";
      } catch {
        finish({ error: failure("send failed") });
      }
    };
    try {
      frame.srcdoc = options.documentSource;
      document.body.append(frame);
    } catch {
      finish({ error: failure("setup failed") });
    }
  });
}

/** A matching ID alone is not evidence of a production refusal. Both success
 * and failure must have the exact production result shape after removing only
 * the caller's fixed probe fields; malformed output must fail qualification. */
export function readMermaidProbeSvg(
  data: Record<string, unknown>,
  probeFields: readonly string[],
): string | null {
  if (Array.isArray(data) || Object.getPrototypeOf(data) !== Object.prototype)
    refuseMermaidProbeResult("received an invalid result");
  const fields = Object.keys(data)
    .filter((name) => !probeFields.includes(name))
    .sort()
    .join(",");
  if (fields === "id,svg" && typeof data.svg === "string") return data.svg;
  if (fields === "failed,id" && data.failed === true) return null;
  refuseMermaidProbeResult("received an invalid result");
}

export function readMermaidProbeSentinel(
  data: Record<string, unknown>,
  probeFields: readonly string[],
  sentinel: string,
): boolean {
  const svg = readMermaidProbeSvg(data, probeFields);
  if (svg !== null && svg !== sentinel) refuseMermaidProbeResult("received an invalid result");
  return svg !== null;
}

/** Static fixture instrumentation observes the same one-use transferred port.
 * It does not replace the production receiver, request or parser source. Its
 * messages bypass only the fixture's final-result metadata wrapper and contain
 * a random invocation ID plus one code-owned phase; the timer is never reset. */
export function mermaidProbePhaseScript(id: string): string {
  return `let probeProgressPort;
    const probePhase = phase => {
      if (probeProgressPort) nativePostMessage.call(probeProgressPort, { id: ${JSON.stringify(id)}, probePhase: phase });
    };
    addEventListener('message', function observeProbePort(event) {
      if (event.source !== parent || event.data !== 'cafe-mermaid-render' || event.ports.length !== 1) return;
      removeEventListener('message', observeProbePort);
      probeProgressPort = event.ports[0];
    });`;
}
