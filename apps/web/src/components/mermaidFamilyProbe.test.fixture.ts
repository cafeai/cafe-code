import { MERMAID_FAMILY_FIXTURES } from "./mermaidFamilies.test.fixture";
import { createMermaidFamilyProbeDocument } from "./mermaidFamilyDocument.test.fixture";
import {
  mermaidProbePhaseScript,
  readMermaidProbeSentinel,
  readMermaidProbeSvg,
  refuseMermaidProbeResult,
  runMermaidProbe,
  type MermaidProbeBootstrapPhase,
} from "./mermaidProbe.test.fixture";

/** Run the real pinned parser and production pre-layout admission in its
 * ordinary opaque document. Only the final renderer is replaced by a constant
 * sentinel, so large/cyclic boundary fixtures cannot enter expensive layout. */
export async function admitsParsedFamily(
  source: string,
  parsedMutation = "",
  parserFixtureSource?: string,
  expectedNativeStateCalls?: number,
  expectedNativeParserCalls?: number,
  observeBootstrap?: (phase: MermaidProbeBootstrapPhase) => void,
  admitSourceOnReady = true,
): Promise<boolean> {
  const nonce = crypto.randomUUID();
  const id = crypto.randomUUID();
  const admittedSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" />';
  const parsedOverride =
    parsedMutation || parserFixtureSource !== undefined
      ? `const originalDb = diagram.db;
         const methodNames = new Set([...Object.getOwnPropertyNames(originalDb), ...Object.getOwnPropertyNames(Object.getPrototypeOf(originalDb))]);
         const methods = [...methodNames].filter(name => typeof originalDb[name] === 'function').map(name => [name, originalDb[name]]);
         ${parsedMutation}
         probeMutationApplied = diagram.db !== originalDb || methods.some(([name, method]) => diagram.db[name] !== method);`
      : "";
  // Observe the real native parser even for the baseline invocation. The
  // wrapper forwards the exact source unless an existing explicit same-family
  // pre-parse substitute is requested; it never changes production admission.
  const override = `const nativeGetDiagram = mermaid.mermaidAPI.getDiagramFromText.bind(mermaid.mermaidAPI);
       const probeNativeGetDiagram = async (source) => {
         probeNativeParserCalls++;
         probePhase('parser-entered');
         const diagram = await nativeGetDiagram(${parserFixtureSource === undefined ? "source" : JSON.stringify(parserFixtureSource)});
         probePhase('parser-returned');
         ${parsedOverride}
         return diagram;
       };
       mermaid.mermaidAPI = { ...mermaid.mermaidAPI, getDiagramFromText: probeNativeGetDiagram };
       probeParserReplacementInstalled = mermaid.mermaidAPI.getDiagramFromText === probeNativeGetDiagram;`;
  const documentSource = createMermaidFamilyProbeDocument(
    nonce,
    id,
    `let probeMutationApplied = false; let probeNativeStateCalls = 0;
     let probeNativeParserCalls = 0; let probeParserReplacementInstalled = false;
     const nativePostMessage = MessagePort.prototype.postMessage;
     ${mermaidProbePhaseScript(id)}
     MessagePort.prototype.postMessage = function(value, ...transfer) {
       return nativePostMessage.call(this, { ...value, probeMutationApplied, probeNativeStateCalls, probeNativeParserCalls, probeParserReplacementInstalled }, ...transfer);
     };
     // The pre-layout probe deliberately replaces only final-image work. Its
     // empty sentinel is not a native event diagram and must not be passed to
     // the strict output adapter. Real SVG/PNG and adversarial output probes
     // below retain that adapter unchanged and qualify it independently.
     const nativeEventLabels = globalThis.cafeMermaidEventModelingSvgLabels;
     const nativeInfoViewport = globalThis.cafeMermaidInfoSvgViewport;
     if (typeof nativeEventLabels !== 'function' || typeof nativeInfoViewport !== 'function') throw new Error();
     globalThis.cafeMermaidEventModelingSvgLabels = svg => svg;
     globalThis.cafeMermaidInfoSvgViewport = svg => svg;
     mermaid.render = async () => {
       probePhase('render-entered');
       probePhase('render-returned');
       return { svg: ${JSON.stringify(admittedSvg)} };
     };${override}`,
  );
  return runMermaidProbe({
    id,
    documentSource,
    source,
    theme: "dark",
    kind: "Family admission probe",
    bootstrapObservation: {
      nonce,
      admitSourceOnReady,
      ...(observeBootstrap ? { onPhase: observeBootstrap } : {}),
    },
    invocation: parsedMutation
      ? "mutation"
      : parserFixtureSource === undefined
        ? "baseline"
        : "parser-substitute",
    readResult: (data) => {
      if (
        typeof data.probeMutationApplied !== "boolean" ||
        typeof data.probeParserReplacementInstalled !== "boolean" ||
        !Number.isSafeInteger(data.probeNativeStateCalls) ||
        (data.probeNativeStateCalls as number) < 0 ||
        !Number.isSafeInteger(data.probeNativeParserCalls) ||
        (data.probeNativeParserCalls as number) < 0
      )
        refuseMermaidProbeResult("received an invalid result");
      if (parsedMutation && data.probeMutationApplied !== true) {
        refuseMermaidProbeResult("parsed database mutation was not applied");
      }
      if (
        expectedNativeStateCalls !== undefined &&
        data.probeNativeStateCalls !== expectedNativeStateCalls
      ) {
        refuseMermaidProbeResult("native event-state resolver crossed its pre-layout fence");
      }
      if (
        expectedNativeParserCalls !== undefined &&
        !(
          data.probeParserReplacementInstalled === true &&
          data.probeNativeParserCalls === expectedNativeParserCalls
        )
      ) {
        refuseMermaidProbeResult("native parser crossed its pre-parse allocation fence");
      }
      return readMermaidProbeSentinel(
        data,
        [
          "probeMutationApplied",
          "probeNativeStateCalls",
          "probeNativeParserCalls",
          "probeParserReplacementInstalled",
        ],
        admittedSvg,
      );
    },
  });
}

/** Observe the production output adapters after real native parsing and
 * rendering. Mutations below are static synthetic test code, never received
 * diagram source. The ordinary opaque document, CSP and one-use port remain
 * intact; no HTML/SVG is attached to the application document. */
export async function renderNativeFamilyOutput(
  family: "eventmodeling" | "info",
  outputMutation = "",
): Promise<string | null> {
  const source =
    family === "info"
      ? "info"
      : MERMAID_FAMILY_FIXTURES.find((entry) => entry.family === "eventmodeling")!.source;
  const nonce = crypto.randomUUID();
  const id = crypto.randomUUID();
  const documentSource = createMermaidFamilyProbeDocument(
    nonce,
    id,
    `
       let probeOutputMutationApplied = false;
       const nativePostMessage = MessagePort.prototype.postMessage;
       ${mermaidProbePhaseScript(id)}
       MessagePort.prototype.postMessage = function(value, ...transfer) {
         return nativePostMessage.call(this, { ...value, probeOutputMutationApplied }, ...transfer);
       };
       const nativeRender = mermaid.render.bind(mermaid);
       mermaid.render = async (...args) => {
         probePhase('render-entered');
         const native = await nativeRender(...args);
         probePhase('render-returned');
         if (!${JSON.stringify(outputMutation)}) return native;
         const template = document.createElement('template');
         template.innerHTML = native.svg;
         const svg = template.content.querySelector('svg');
         const foreignObject = svg.querySelector('foreignObject');
         const bold = foreignObject?.querySelector('b');
         const code = svg.querySelector('foreignObject code');
         ${outputMutation}
         probeOutputMutationApplied = true;
         return { ...native, svg: template.innerHTML };
       };
     `,
  );
  return runMermaidProbe({
    id,
    documentSource,
    source,
    theme: "light",
    kind: "Native diagram-output probe",
    bootstrapObservation: { nonce, admitSourceOnReady: true },
    invocation: outputMutation ? "mutation" : "baseline",
    readResult: (data) => {
      if (typeof data.probeOutputMutationApplied !== "boolean")
        refuseMermaidProbeResult("received an invalid result");
      if (outputMutation && data.probeOutputMutationApplied !== true) {
        refuseMermaidProbeResult("native diagram-output mutation was not applied");
      }
      return readMermaidProbeSvg(data, ["probeOutputMutationApplied"]);
    },
  });
}
