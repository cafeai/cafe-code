import library from "mermaid/dist/mermaid.min.js?raw";
import familyAdmission from "./familyAdmission.js?raw";
import extendedFamilyAdmission from "./extendedFamilyAdmission.js?raw";
import eventModelingSvgLabels from "./eventModelingSvgLabels.js?raw";
import infoSvgViewport from "./infoSvgViewport.js?raw";
import runtime from "./sandboxRuntime.js?raw";

// Mermaid contains direct console calls outside its configured logger. Keep
// private DSL/parser excerpts out of DevTools and Electron diagnostics too.
const silence = `for (const key of ["log","info","warn","error","debug","trace","dir","table"]) console[key] = () => {}; addEventListener("error", e => e.preventDefault()); addEventListener("unhandledrejection", e => e.preventDefault());`;
// These bytes are immutable local assets, not a document, parsed diagram or
// renderer context. Escape their HTML script terminators once instead of
// repeatedly concatenating and scanning the full 5.6 MB engine for each job.
// Every invocation still creates its own nonce/CSP/document/frame and port;
// no source, parser state, capability or execution realm is retained here.
const scripts =
  `${silence}\n${library}\n${familyAdmission}\n${extendedFamilyAdmission}\n${eventModelingSvgLabels}\n${infoSvgViewport}\n${runtime}`.replace(
    /<\/script/gi,
    "<\\/script",
  );

/** All scripts are local locked bytes; diagram source is never interpolated here. */
export function createMermaidSandboxDocument(nonce: string): string {
  if (!/^[a-f0-9-]{36}$/.test(nonce)) throw new Error("Invalid renderer nonce");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; font-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"></head><body><script nonce="${nonce}">${scripts}</script></body></html>`;
}
