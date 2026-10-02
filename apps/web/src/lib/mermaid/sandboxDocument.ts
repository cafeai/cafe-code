import library from "@mermaid-js/tiny/dist/mermaid.tiny.js?raw";
import runtime from "./sandboxRuntime.js?raw";

/** All scripts are local locked bytes; diagram source is never interpolated here. */
export function createMermaidSandboxDocument(nonce: string): string {
  if (!/^[a-f0-9-]{36}$/.test(nonce)) throw new Error("Invalid renderer nonce");
  // Mermaid contains direct console calls outside its configured logger. Keep
  // private DSL/parser excerpts out of DevTools and Electron diagnostics too.
  const silence = `for (const key of ["log","info","warn","error","debug","trace","dir","table"]) console[key] = () => {}; addEventListener("error", e => e.preventDefault()); addEventListener("unhandledrejection", e => e.preventDefault());`;
  const scripts = `${silence}\n${library}\n${runtime}`.replace(/<\/script/gi, "<\\/script");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; font-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"></head><body><script nonce="${nonce}">${scripts}</script></body></html>`;
}
