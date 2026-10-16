import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import runtime from "./sandboxRuntime.js?raw";
import { admitMermaidSource } from "./policy";
import { MERMAID_FAMILY_FIXTURES } from "../../components/mermaidFamilies.test.fixture";

/** Qualify the exact inert receiver's source-only gate without booting the
 * engine. Native opaque-origin/port/parser tests remain in the browser suite. */
function receiver() {
  const parent = {};
  let receive!: (event: unknown) => Promise<void>;
  const parse = vi.fn(async () => {
    throw new Error("Synthetic parser boundary");
  });
  const initialize = vi.fn();
  const render = vi.fn();
  const preflight = vi.fn();
  const port = {
    onmessage: null as null | ((event: unknown) => Promise<void>),
    postMessage: vi.fn(),
    close: vi.fn(),
    start: vi.fn(),
  };
  const window = {
    addEventListener: (_name: string, callback: typeof receive) => {
      receive = callback;
    },
    removeEventListener: vi.fn(),
  };
  runInNewContext(runtime, {
    window,
    parent,
    TextEncoder,
    globalThis: {
      mermaid: { initialize, render, mermaidAPI: { getDiagramFromText: parse } },
      cafeMermaidFamilyPreflight: preflight,
    },
  });
  return {
    parse,
    initialize,
    render,
    preflight,
    port,
    async send(source: string) {
      await receive({ source: parent, data: "cafe-mermaid-render", ports: [port] });
      expect(port.onmessage).toBeTypeOf("function");
      await port.onmessage!({ data: { id: "source-fixture", source, theme: "dark" } });
      expect(port.onmessage).toBeNull();
    },
  };
}

describe("Mermaid source-only admission at both boundaries", () => {
  it("forwards ordinary source to the exact parser boundary", async () => {
    const peer = receiver();
    const source = "flowchart TD\nA[One] --> B[Two]";
    await peer.send(source);
    expect(peer.preflight).toHaveBeenCalledExactlyOnceWith(source);
    expect(peer.initialize).toHaveBeenCalledOnce();
    expect(peer.parse).toHaveBeenCalledExactlyOnceWith(source);
    expect(peer.render).not.toHaveBeenCalled();
    expect(peer.port.postMessage).toHaveBeenCalledExactlyOnceWith({
      id: "source-fixture",
      failed: true,
    });
    expect(peer.port.start).toHaveBeenCalledOnce();
    expect(peer.port.close).toHaveBeenCalledOnce();
  });
  it.each(MERMAID_FAMILY_FIXTURES)(
    "refuses configuration and callbacks for $family before parser access",
    async ({ source }) => {
      for (const hostile of [
        `%%{init: {"securityLevel":"loose"}}%%\n${source}`,
        `${source}\nclick target "https://example.invalid/diagram"`,
        `---\nconfig:\n  securityLevel: loose\n---\n${source}`,
      ]) {
        expect(() => admitMermaidSource(hostile)).toThrow();
        const peer = receiver();
        await peer.send(hostile);
        expect(peer.initialize).not.toHaveBeenCalled();
        expect(peer.preflight).not.toHaveBeenCalled();
        expect(peer.parse).not.toHaveBeenCalled();
        expect(peer.render).not.toHaveBeenCalled();
        expect(peer.port.postMessage).toHaveBeenCalledExactlyOnceWith({
          id: "source-fixture",
          failed: true,
        });
        expect(peer.port.start).toHaveBeenCalledOnce();
        expect(peer.port.close).toHaveBeenCalledOnce();
      }
    },
  );
});
