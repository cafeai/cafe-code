import { admitMermaidSource, MERMAID_FAILURE, MERMAID_POLICY } from "./policy";
import { sanitizeMermaidSvg, type MermaidResult } from "./sanitizeSvg";

export type { MermaidResult } from "./sanitizeSvg";
export type MermaidTheme = "dark" | "light";
type Renderer = (source: string, theme: MermaidTheme) => Promise<MermaidResult>;
/**
 * `peek` is a synchronous, read-only lookup of an already sanitized cached
 * result so a re-mounted block (virtualized scroll, chat switch) can show its
 * diagram on first paint instead of flashing source. It never renders, never
 * admits new source and returns `undefined` on a miss. Optional so test
 * doubles that only mock the async renderer keep working.
 */
export type MermaidRenderService = ((
  source: string,
  theme: MermaidTheme,
) => Promise<MermaidResult>) & {
  readonly peek?: (source: string, theme: MermaidTheme) => MermaidResult | null | undefined;
};

export async function renderInMermaidSandbox(
  source: string,
  theme: MermaidTheme,
): Promise<MermaidResult> {
  const { createMermaidSandboxDocument } = await import("./sandboxDocument");
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const frame = document.createElement("iframe");
    const channel = new MessageChannel();
    // allow-same-origin is intentionally absent. Even a compromised Mermaid
    // dependency must not read cookies, storage, the app DOM or desktop bridge.
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.title = "Isolated diagram renderer";
    frame.style.cssText =
      "position:fixed;left:-10000px;top:0;width:1024px;height:768px;visibility:hidden;pointer-events:none";
    frame.referrerPolicy = "no-referrer";
    let settled = false;
    const finish = (result?: MermaidResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      channel.port1.close();
      channel.port2.close();
      frame.remove();
      if (result) resolve(result);
      else reject(new Error(MERMAID_FAILURE));
    };
    // This bounds stalled asynchronous jobs, NOT synchronous CPU execution in
    // a shared browser thread. Source and parsed-graph admission precede layout.
    const timeout = setTimeout(() => finish(), 15_000);
    channel.port1.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (!data || typeof data !== "object" || !("id" in data) || data.id !== id) return;
      try {
        finish(sanitizeMermaidSvg("svg" in data ? data.svg : undefined));
      } catch {
        finish();
      }
    };
    channel.port1.onmessageerror = () => finish();
    frame.onerror = () => finish();
    frame.onload = () => {
      frame.onload = null;
      try {
        if (!frame.contentWindow) {
          finish();
          return;
        }
        frame.contentWindow.postMessage("cafe-mermaid-render", "*", [channel.port2]);
        channel.port1.postMessage({ id, source, theme });
      } catch {
        finish();
      }
    };
    try {
      frame.srcdoc = createMermaidSandboxDocument(crypto.randomUUID());
      document.body.append(frame);
    } catch {
      finish();
    }
  });
}

/** Injectable renderer keeps scheduling/cache tests independent of browser layout. */
export function createMermaidRenderService(renderer: Renderer): MermaidRenderService {
  const cache = new Map<string, { value: MermaidResult | null; bytes: number }>();
  const inFlight = new Map<string, Promise<MermaidResult>>();
  let bytes = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const peek = (source: string, theme: MermaidTheme): MermaidResult | null | undefined =>
    // Same full-source key as the renderer below; only admitted, sanitized
    // results (or a cached failure marker) can ever be present.
    cache.get(JSON.stringify([MERMAID_POLICY, theme, source]))?.value;
  const render = (source: string, theme: MermaidTheme): Promise<MermaidResult> => {
    try {
      admitMermaidSource(source);
    } catch {
      return Promise.reject(new Error(MERMAID_FAILURE));
    }
    // Full source is the key, not a truncated/noncryptographic digest. Distinct
    // private diagrams can never alias to another user's image through collision.
    const key = JSON.stringify([MERMAID_POLICY, theme, source]);
    const cached = cache.get(key);
    if (cached) {
      cache.delete(key);
      cache.set(key, cached);
      return cached.value
        ? Promise.resolve(cached.value)
        : Promise.reject(new Error(MERMAID_FAILURE));
    }
    const pending = inFlight.get(key);
    if (pending) return pending;
    if (inFlight.size >= 64) return Promise.reject(new Error(MERMAID_FAILURE));
    const remember = (value: MermaidResult | null) => {
      const size = key.length * 2 + (value?.svg.length ?? 0) * 2 + 2048;
      if (size > 16 * 1024 * 1024) return;
      while (cache.size >= 128 || bytes + size > 16 * 1024 * 1024) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        bytes -= cache.get(oldest)!.bytes;
        cache.delete(oldest);
      }
      cache.set(key, { value, bytes: size });
      bytes += size;
    };
    const job = tail
      .then(() => renderer(source, theme))
      .then(
        (result) => {
          remember(result);
          return result;
        },
        () => {
          remember(null);
          throw new Error(MERMAID_FAILURE);
        },
      )
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, job);
    // Observe failures immediately and always release the serialization chain.
    // Callers still receive the rejection; a bad diagram cannot poison the queue.
    tail = job.catch(() => undefined);
    return job;
  };
  return Object.assign(render, { peek });
}

export const renderMermaid = createMermaidRenderService(renderInMermaidSandbox);
