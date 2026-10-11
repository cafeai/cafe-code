/**
 * This boot-only token adapter deliberately does not load the web application,
 * fonts, icons or stylesheet: those resources require the backend whose
 * readiness this window explains. Keep its semantic palette, rem typography
 * and stepped status motion aligned with index.css and the style guide.
 */
export const DESKTOP_STARTUP_STYLE = `
:root {
  color-scheme: light dark;
  --background: #f9f9f9;
  --foreground: #262626;
  --muted-foreground: #686868;
  --primary: oklch(0.488 0.217 264);
  --border-subtle: rgba(0,0,0,.05);
  --font-sans: "DM Sans Variable", "DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --duration-base: 160ms;
  --ease-out: cubic-bezier(.2,.8,.2,1);
  --cafe-spin-duration: 1s;
  --cafe-spin-steps: 60;
}
@media (prefers-color-scheme: dark) {
  :root { --background: #161616; --foreground: #f5f5f5; --muted-foreground: #8c8c8c; --primary: oklch(0.588 0.217 264); --border-subtle: rgba(255,255,255,.04); }
}
* { box-sizing: border-box; }
html, body { width: 100%; min-height: 100%; margin: 0; }
body { background: var(--background); color: var(--foreground); font: 400 .875rem/1.5 var(--font-sans); }
main { padding: 1.5rem; min-width: 0; animation: appear var(--duration-base) var(--ease-out) both; }
h1 { font-size: 1rem; font-weight: 600; line-height: 1.5; margin: 0 0 1.5rem; }
.status { display: flex; gap: .75rem; align-items: center; min-width: 0; }
.spinner { width: 1rem; height: 1rem; flex: none; border: .125rem solid var(--border-subtle); border-top-color: var(--primary); border-radius: 50%; animation: spin var(--cafe-spin-duration) steps(var(--cafe-spin-steps), end) infinite; }
.label { font-weight: 500; overflow-wrap: anywhere; }
.detail { color: var(--muted-foreground); margin: .5rem 0 0 1.75rem; font-size: .8125rem; line-height: 1.5; overflow-wrap: anywhere; }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes appear { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { main, .spinner { animation: none; } }
`;

export type DesktopStartupPhase = "starting" | "migrating" | "ready";

/** No provider strings, IDs, paths or errors are accepted by this document. */
export function desktopStartupCopy(phase: DesktopStartupPhase): {
  readonly label: string;
  readonly detail: string;
} {
  switch (phase) {
    case "migrating":
      return {
        label: "Updating your workspace…",
        detail: "Large workspaces can take a while. Your chats stay saved.",
      };
    case "ready":
      return { label: "Opening your workspace…", detail: "" };
    default:
      return { label: "Starting…", detail: "" };
  }
}

/**
 * The caller supplies the SHA-256 of exactly DESKTOP_STARTUP_STYLE. No inline
 * scripts or style attributes are needed; browser zoom supplies interface
 * scaling. Keeping the document inert avoids adding a second preload or IPC
 * capability surface before the authenticated backend becomes ready.
 */
export function createDesktopStartupDocument(
  phase: DesktopStartupPhase,
  styleSha256: string,
): string {
  // The hash is generated in main, but this boundary still rejects an injected
  // policy delimiter instead of trusting a TypeScript string annotation.
  if (!/^[A-Za-z0-9+/]{43}=$/.test(styleSha256)) {
    throw new Error("Invalid startup stylesheet identity.");
  }
  const { label, detail } = desktopStartupCopy(phase);
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'sha256-${styleSha256}'; script-src 'none'; connect-src 'none'; img-src 'none'; font-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">
<title>Cafe Code</title><style>${DESKTOP_STARTUP_STYLE}</style></head>
<body><main><h1>Cafe Code</h1><div class="status" role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span><span class="label">${label}</span></div>${detail ? `<p class="detail">${detail}</p>` : ""}</main></body></html>`;
}
