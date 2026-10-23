/** Transport qualification only: callers construct the ordinary opaque
 * document before entering this helper, as the original ten-second probes did.
 * No renderer state, source admission or native browser context is shared. */
import library from "mermaid/dist/mermaid.min.js?raw";
import runtime from "../lib/mermaid/sandboxRuntime.js?raw";

const bootstrapPhases = [
  "engine-entered",
  "engine-returned",
  "receiver-installed",
  "fixture-ready",
] as const;
export type MermaidProbeBootstrapPhase = (typeof bootstrapPhases)[number];

// These are the same memoized inert assets imported by sandboxDocument, never
// another app-realm engine. Match their complete escaped bytes, not a generic
// closing-script fragment that could incorrectly qualify another receiver.
const escapedLibrary = library.replace(/<\/script/gi, "<\\/script");
const escapedRuntime = runtime.replace(/<\/script/gi, "<\\/script");
const bootstrapSentinel = "<!--cafe-mermaid-probe-bootstrap-v1-->";

/** Add observations to one already constructed fixture document. The large
 * instrumented script remains identical between invocations: only a separate
 * nonce-protected metadata script carries its fresh id/nonce. Instrumentation
 * never transfers a port or submits source: callers separately opt into using
 * only its terminal bound readiness observation as their source gate.
 * Every marker executes inside the script it observes, so a thrown engine,
 * receiver-registration or fixture-override step cannot mint later readiness. */
export function instrumentMermaidProbeBootstrap(
  documentSource: string,
  nonce: string,
  id: string,
): string {
  if (!/^[a-f0-9-]{36}$/.test(nonce) || !/^[a-f0-9-]{36}$/.test(id))
    throw new Error("Invalid probe bootstrap binding");
  if (documentSource.includes(bootstrapSentinel))
    throw new Error("Probe bootstrap document already instrumented");
  for (const asset of [escapedLibrary, escapedRuntime]) {
    const first = documentSource.indexOf(asset);
    if (first < 0 || first !== documentSource.lastIndexOf(asset))
      throw new Error("Invalid probe bootstrap asset");
  }
  const opening = `<script nonce="${nonce}">`;
  const firstScript = documentSource.indexOf(opening);
  const ending = "</script></body></html>";
  if (firstScript < 0 || !documentSource.endsWith(ending))
    throw new Error("Invalid probe bootstrap document");
  const metadata = `${bootstrapSentinel}<script nonce="${nonce}">
    const cafeMermaidProbeBootstrap = phase => parent.postMessage({
      id: ${JSON.stringify(id)}, nonce: ${JSON.stringify(nonce)}, probeBootstrapPhase: phase
    }, '*');
    </script>`;
  let observed =
    documentSource.slice(0, firstScript) + metadata + documentSource.slice(firstScript);
  observed = observed.replace(
    escapedLibrary,
    () =>
      `cafeMermaidProbeBootstrap('engine-entered');\n${escapedLibrary}\ncafeMermaidProbeBootstrap('engine-returned');`,
  );
  observed = observed.replace(
    escapedRuntime,
    () => `${escapedRuntime}\ncafeMermaidProbeBootstrap('receiver-installed');`,
  );
  return (
    observed.slice(0, -ending.length) + "\ncafeMermaidProbeBootstrap('fixture-ready');" + ending
  );
}

const nativePhases = [
  "parser-entered",
  "parser-returned",
  "render-entered",
  "render-returned",
] as const;

type ProbePhase =
  | "document-constructed"
  | "frame-loaded"
  | "fixture-ready"
  | "request-sent"
  | (typeof nativePhases)[number];
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
  readonly signal?: AbortSignal;
  readonly bootstrapObservation?: {
    readonly nonce: string;
    readonly onPhase?: (phase: MermaidProbeBootstrapPhase) => void;
    // Family fixtures require their actual engine/receiver/overrides to be
    // ready, rather than a later generic iframe-load callback. Other probes
    // retain their original load gate. Both span the same absolute allowance.
    readonly admitSourceOnReady?: boolean;
  };
}

export function runMermaidProbe<T>(options: MermaidProbeOptions<T>): Promise<T> {
  // Capture the exact caller's owner once. A retired invocation must not even
  // allocate a frame or native ports, and its unqualified reason stays opaque.
  const signal = options.signal;
  if (signal?.aborted) return Promise.reject(new Error("Mermaid probe owner retired"));
  const frame = document.createElement("iframe");
  const channel = new MessageChannel();
  frame.dataset.mermaidFamilySecurityFixture = options.id;
  frame.setAttribute("sandbox", "allow-scripts");
  return new Promise((resolve, reject) => {
    let settled = false;
    let phase: ProbePhase = "document-constructed";
    let bootstrapPhase = -1;
    let sourceReserved = false;
    const failure = (reason: string) =>
      new Error(
        `${options.kind} ${reason} (${options.invocation}; phase ${phase})` +
          (options.bootstrapObservation
            ? ` [bootstrap ${bootstrapPhases[bootstrapPhase] ?? "not-observed"}]`
            : ""),
      );
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
      window.removeEventListener("message", observeBootstrap);
      signal?.removeEventListener("abort", onAbort);
      channel.port1.close();
      channel.port2.close();
      frame.remove();
      if ("error" in outcome) reject(outcome.error);
      else resolve(outcome.result);
    };
    function onAbort(): void {
      // Retirement is neither a renderer refusal nor retry authority. Use the
      // same exact-owner cleanup without reading/coercing the received reason.
      finish({ error: new Error("Mermaid probe owner retired") });
    }
    // Preserve the original scope and duration: document construction has
    // finished, while frame loading, parsing and the reply all share one fixed
    // allowance. Observed breadcrumbs never renew this timer or authorize a
    // retry, and it remains an asynchronous bound rather than a CPU deadline.
    const deadline = performance.now() + 10_000;
    const expired = () => performance.now() >= deadline;
    const timeout = setTimeout(() => finish({ error: failure("did not reply") }), 10_000);
    const sendSource = (readyPhase: "frame-loaded" | "fixture-ready") => {
      if (settled || sourceReserved) return;
      if (expired()) {
        finish({ error: failure("did not reply") });
        return;
      }
      phase = readyPhase;
      try {
        const ownerWindow = frame.contentWindow;
        if (!ownerWindow) {
          finish({ error: failure("lost its frame") });
          return;
        }
        // Reserve the exact one-use source/port before either transport I/O.
        // Queued duplicate load/readiness callbacks cannot transfer again or
        // regress a phase already observed on the original request's port.
        sourceReserved = true;
        frame.onload = null;
        ownerWindow.postMessage("cafe-mermaid-render", "*", [channel.port2]);
        if (settled) return;
        channel.port1.postMessage({ id: options.id, source: options.source, theme: options.theme });
        if (!settled && phase === readyPhase) phase = "request-sent";
      } catch {
        finish({ error: failure("send failed") });
      }
    };
    function observeBootstrap(event: MessageEvent<unknown>): void {
      const observation = options.bootstrapObservation;
      const data = event.data;
      if (
        settled ||
        !observation ||
        event.source !== frame.contentWindow ||
        event.origin !== "null" ||
        event.ports.length !== 0 ||
        !data ||
        typeof data !== "object" ||
        Array.isArray(data) ||
        Object.getPrototypeOf(data) !== Object.prototype ||
        Object.keys(data).sort().join(",") !== "id,nonce,probeBootstrapPhase" ||
        !("id" in data) ||
        data.id !== options.id ||
        !("nonce" in data) ||
        data.nonce !== observation.nonce ||
        !("probeBootstrapPhase" in data)
      )
        return;
      const next = bootstrapPhases.indexOf(data.probeBootstrapPhase as MermaidProbeBootstrapPhase);
      if (next < 0 || next !== bootstrapPhase + 1) return;
      // Every startup step remains inside the original allowance. Only the
      // terminal exact marker may own Family source admission; prior/foreign
      // observations cannot renew the timer or authorize a transferred port.
      if (expired()) {
        finish({ error: failure("did not reply") });
        return;
      }
      bootstrapPhase = next;
      try {
        observation.onPhase?.(bootstrapPhases[next]!);
        if (next === bootstrapPhases.length - 1 && observation.admitSourceOnReady)
          sendSource("fixture-ready");
      } catch {
        finish({ error: failure("bootstrap observer failed") });
      }
    }
    if (options.bootstrapObservation) window.addEventListener("message", observeBootstrap);
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
          const next = nativePhases.indexOf(data.probePhase as (typeof nativePhases)[number]);
          if (Object.keys(data).sort().join(",") !== "id,probePhase" || next < 0)
            throw failure("received an invalid phase");
          // These are observations, not a second parser-call policy. Native
          // paths may enter/return more than once; the callers' original exact
          // parser/state counts remain authoritative, and repeated phases
          // neither reject a valid result nor renew the absolute deadline.
          phase = nativePhases[next]!;
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
      if (settled || sourceReserved || options.bootstrapObservation?.admitSourceOnReady) return;
      sendSource("frame-loaded");
    };
    // Register before native insertion, then close the check/register race.
    // Existing callbacks also retain the settled fence if already queued.
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    if (settled) return;
    try {
      frame.srcdoc = options.documentSource;
      if (settled) return;
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
