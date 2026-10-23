import "../index.css";
import { describe, expect, it, vi } from "vitest";
import { createMermaidSandboxDocument } from "../lib/mermaid/sandboxDocument";
import { MERMAID_FAMILY_FIXTURES } from "./mermaidFamilies.test.fixture";
import {
  instrumentMermaidProbeBootstrap,
  readMermaidProbeSentinel,
  runMermaidProbe,
  type MermaidProbeBootstrapPhase,
} from "./mermaidProbe.test.fixture";
import { admitsParsedFamily } from "./mermaidFamilyProbe.test.fixture";
import { createMermaidFamilyProbeDocument } from "./mermaidFamilyDocument.test.fixture";
import { installMermaidFamilyCleanup } from "./mermaidFamilyCleanup.test.fixture";

installMermaidFamilyCleanup();

const probeSentinel = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" />';

/** This tiny peer qualifies only the shared probe transport and its result
 * oracle. Real native Mermaid parsing/layout remains in every family case
 * below. Static synthetic code uses the same opaque frame, nonce-only script
 * policy and one-use parent port without loading another engine or context. */
function startSyntheticProbe(
  response: string,
  source = "synthetic isolated probe",
  observeBootstrap?: (phase: MermaidProbeBootstrapPhase) => void,
  admitSourceOnReady = false,
  signal?: AbortSignal,
) {
  const nonce = crypto.randomUUID();
  const id = crypto.randomUUID();
  const documentSource = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; font-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"></head><body><script nonce="${nonce}">
    addEventListener('message', function receive(event) {
      if (event.source !== parent || event.data !== 'cafe-mermaid-render' || event.ports.length !== 1) return;
      removeEventListener('message', receive);
      const port = event.ports[0];
      port.onmessage = ({ data }) => {
        port.onmessage = null;
        const id = data.id;
        if (data.source !== ${JSON.stringify(source)} || data.theme !== 'dark' || globalThis.probeWasUsed) {
          port.postMessage({ id, failed: false });
          return;
        }
        globalThis.probeWasUsed = true;
        ${response}
      };
      port.start();
    });
    </script></body></html>`;
  const readResult = vi.fn((data: Record<string, unknown>) =>
    readMermaidProbeSentinel(data, [], probeSentinel),
  );
  const result = runMermaidProbe({
    id,
    documentSource,
    source,
    theme: "dark",
    kind: "Family admission probe",
    invocation: "baseline",
    ...(signal ? { signal } : {}),
    ...(observeBootstrap
      ? { bootstrapObservation: { nonce, onPhase: observeBootstrap, admitSourceOnReady } }
      : {}),
    readResult,
  });
  const frame = document.querySelector<HTMLIFrameElement>(
    `iframe[data-mermaid-family-security-fixture="${id}"]`,
  )!;
  expect(frame).not.toBeNull();
  return { id, nonce, frame, result, readResult };
}

function expectRetiredProbe(frame: HTMLIFrameElement, ports: readonly unknown[]): void {
  expect(frame.isConnected).toBe(false);
  expect(frame.onload).toBeNull();
  expect(frame.onerror).toBeNull();
  expect(ports).toHaveLength(2);
  for (const value of ports) {
    expect(value).toBeInstanceOf(MessagePort);
    const port = value as MessagePort;
    expect(port.onmessage).toBeNull();
    expect(port.onmessageerror).toBeNull();
  }
}

describe("Mermaid family probe qualification", () => {
  it.for(["before setup", "during observer registration"] as const)(
    "rejects an exact owner aborted %s without appending a frame",
    async (timing, { onTestFinished }) => {
      const controller = new AbortController();
      const reason = { private: "unqualified synthetic cancellation detail" };
      const create = vi.spyOn(document, "createElement");
      // The pre-aborted path must never invoke this constructor. Leave the
      // actual native constructor untouched in the registration-race control.
      const channels =
        timing === "before setup" ? vi.spyOn(globalThis, "MessageChannel") : undefined;
      const append = vi.spyOn(document.body, "append");
      const close = vi.spyOn(MessagePort.prototype, "close");
      const readResult = vi.fn(() => true);
      let result: Promise<boolean> | undefined;
      onTestFinished(async () => {
        controller.abort(reason);
        await result?.catch(() => undefined);
      });
      if (timing === "before setup") controller.abort(reason);
      else {
        // Abort with the real native controller just before its listener is
        // installed. Only the synchronous post-registration recheck can see
        // this already-delivered edge; no fake clock or signal flag is used.
        const nativeAdd = controller.signal.addEventListener.bind(controller.signal);
        vi.spyOn(controller.signal, "addEventListener").mockImplementation(
          (type, listener, options) => {
            if (type === "abort") controller.abort(reason);
            nativeAdd(type, listener, options);
          },
        );
      }
      result = runMermaidProbe({
        id: crypto.randomUUID(),
        documentSource: "<!doctype html><html><body></body></html>",
        source: "unsubmitted synthetic source",
        theme: "dark",
        kind: "Family admission probe",
        invocation: "baseline",
        signal: controller.signal,
        readResult,
      });
      await expect(result).rejects.toMatchObject({
        name: "Error",
        message: "Mermaid probe owner retired",
      });
      expect(append).not.toHaveBeenCalled();
      expect(readResult).not.toHaveBeenCalled();
      if (timing === "before setup") {
        expect(create).not.toHaveBeenCalled();
        expect(channels).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
      } else {
        expect(close).toHaveBeenCalledTimes(2);
      }
    },
  );

  it("retires a held native load and rejects its queued startup callbacks without source", async ({
    signal,
    onTestFinished,
  }) => {
    const controller = new AbortController();
    const abort = () => controller.abort({ private: "unqualified synthetic owner detail" });
    const close = vi.spyOn(MessagePort.prototype, "close");
    const send = vi.spyOn(MessagePort.prototype, "postMessage");
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const removeAbort = vi.spyOn(controller.signal, "removeEventListener");
    const addAbort = vi.spyOn(controller.signal, "addEventListener");
    const nativeAppend = document.body.append;
    const held: { load: HTMLIFrameElement["onload"] } = { load: null };
    let receiveLoad!: (event: Event) => void;
    const loaded = new Promise<Event>((resolve) => {
      receiveLoad = resolve;
    });
    const witness = (event: Event) => receiveLoad(event);
    let probe: ReturnType<typeof startSyntheticProbe> | undefined;
    onTestFinished(async () => {
      signal.removeEventListener("abort", abort);
      abort();
      probe?.frame.removeEventListener("load", witness);
      await probe?.result.catch(() => undefined);
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    vi.spyOn(document.body, "append").mockImplementation(function (this: HTMLElement, ...nodes) {
      for (const node of nodes) {
        if (node instanceof HTMLIFrameElement && node.dataset.mermaidFamilySecurityFixture) {
          held.load = node.onload;
          node.onload = null;
          node.addEventListener("load", witness, { once: true });
        }
      }
      nativeAppend.apply(this, nodes);
    });
    probe = startSyntheticProbe(
      "port.postMessage({ id, failed: true });",
      undefined,
      () => undefined,
      false,
      controller.signal,
    );
    const ownedProbe = probe;
    const observer = added.mock.calls.find(([type]) => type === "message")?.[1];
    const ownerWindow = ownedProbe.frame.contentWindow;
    const rejected = expect(ownedProbe.result).rejects.toMatchObject({
      name: "Error",
      message: "Mermaid probe owner retired",
    });
    try {
      const nativeLoad = await Promise.race([
        loaded,
        ownedProbe.result.then(() => {
          throw new Error("The held native load completed without retirement.");
        }),
      ]);
      expect(signal.aborted).toBe(false);
      expect(nativeLoad.isTrusted).toBe(true);
      expect(nativeLoad.target).toBe(ownedProbe.frame);
      expect(send).not.toHaveBeenCalled();
      abort();
      expectRetiredProbe(ownedProbe.frame, close.mock.contexts);
      held.load?.call(ownedProbe.frame, nativeLoad);
      const stale = new MessageEvent("message", {
        source: ownerWindow,
        origin: "null",
        data: {
          id: ownedProbe.id,
          nonce: ownedProbe.nonce,
          probeBootstrapPhase: "engine-entered",
        },
      });
      window.dispatchEvent(stale);
      if (typeof observer === "function") observer.call(window, stale);
      await rejected;
      expect(send).not.toHaveBeenCalled();
      expect(ownedProbe.readResult).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(2);
      expect(removed).toHaveBeenCalledWith("message", observer);
      expect(removeAbort).toHaveBeenCalledWith("abort", addAbort.mock.calls[0]?.[1]);
    } finally {
      abort();
      ownedProbe.frame.removeEventListener("load", witness);
      await ownedProbe.result.catch(() => undefined);
    }
  });

  it("retires after the original native request and refuses a captured late valid result", async ({
    signal,
    onTestFinished,
  }) => {
    const controller = new AbortController();
    const abort = () => controller.abort({ private: "unqualified synthetic owner detail" });
    const close = vi.spyOn(MessagePort.prototype, "close");
    const nativeSend = MessagePort.prototype.postMessage;
    let announceSent!: () => void;
    const sent = new Promise<void>((resolve) => {
      announceSent = resolve;
    });
    const captured: { port?: MessagePort; receive: MessagePort["onmessage"] } = {
      receive: null,
    };
    let probe: ReturnType<typeof startSyntheticProbe> | undefined;
    onTestFinished(async () => {
      signal.removeEventListener("abort", abort);
      abort();
      await probe?.result.catch(() => undefined);
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const send = vi.spyOn(MessagePort.prototype, "postMessage").mockImplementation(function (
      this: MessagePort,
      message: unknown,
    ) {
      // Complete the real native source send first; this receipt is not a
      // manufactured renderer result and cannot qualify Mermaid admission.
      nativeSend.call(this, message);
      captured.port = this;
      captured.receive = this.onmessage;
      announceSent();
    });
    probe = startSyntheticProbe("", undefined, undefined, false, controller.signal);
    const ownedProbe = probe;
    const queuedLoad = ownedProbe.frame.onload;
    const rejected = expect(ownedProbe.result).rejects.toMatchObject({
      name: "Error",
      message: "Mermaid probe owner retired",
    });
    try {
      await Promise.race([
        sent,
        ownedProbe.result.then(() => {
          throw new Error("The synthetic probe completed without its native request.");
        }),
      ]);
      expect(signal.aborted).toBe(false);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith({
        id: ownedProbe.id,
        source: "synthetic isolated probe",
        theme: "dark",
      });
      expect(captured.receive).toBeTypeOf("function");
      abort();
      expectRetiredProbe(ownedProbe.frame, close.mock.contexts);
      queuedLoad?.call(ownedProbe.frame, new Event("load"));
      captured.receive?.call(
        captured.port!,
        new MessageEvent("message", { data: { id: ownedProbe.id, svg: probeSentinel } }),
      );
      await rejected;
      expect(ownedProbe.readResult).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(2);
    } finally {
      abort();
      await ownedProbe.result.catch(() => undefined);
    }
  });

  it("propagates exact owner retirement through the real family builder before source admission", async ({
    signal,
    onTestFinished,
  }) => {
    const controller = new AbortController();
    const abort = () => controller.abort({ private: "unqualified synthetic owner detail" });
    const phases: MermaidProbeBootstrapPhase[] = [];
    const close = vi.spyOn(MessagePort.prototype, "close");
    const send = vi.spyOn(MessagePort.prototype, "postMessage");
    const nativeAppend = document.body.append;
    const owned: { frame?: HTMLIFrameElement; load: HTMLIFrameElement["onload"] } = {
      load: null,
    };
    let admission: ReturnType<typeof admitsParsedFamily> | undefined;
    // Own cancellation before the real builder constructs or appends its
    // opaque full-engine document. Cleanup joins only this original promise;
    // the assertion below still observes its actual retirement rejection.
    onTestFinished(async () => {
      signal.removeEventListener("abort", abort);
      abort();
      await admission?.catch(() => undefined);
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    vi.spyOn(document.body, "append").mockImplementation(function (this: HTMLElement, ...nodes) {
      for (const node of nodes) {
        if (node instanceof HTMLIFrameElement && node.dataset.mermaidFamilySecurityFixture) {
          expect(owned.frame).toBeUndefined();
          owned.frame = node;
          // Observe, but do not withhold or replace, its native load callback.
          owned.load = node.onload;
        }
      }
      nativeAppend.apply(this, nodes);
    });
    const fixture = MERMAID_FAMILY_FIXTURES.find((entry) => entry.family === "kanban")!;
    admission = admitsParsedFamily(
      fixture.source,
      "",
      undefined,
      undefined,
      undefined,
      (phase) => {
        phases.push(phase);
        // This marker comes from the completed real engine, receiver and
        // override script. Retire the exact owner before the observer returns
        // to the existing source-admission step, not by changing its timer.
        if (phase === "fixture-ready") abort();
      },
      true,
      controller.signal,
    );
    try {
      await expect(admission).rejects.toMatchObject({
        name: "Error",
        message: "Mermaid probe owner retired",
      });
      expect(signal.aborted).toBe(false);
      expect(phases).toEqual([
        "engine-entered",
        "engine-returned",
        "receiver-installed",
        "fixture-ready",
      ]);
      expect(owned.frame).toBeDefined();
      expect(owned.frame!.getAttribute("sandbox")).toBe("allow-scripts");
      expect(owned.load).toBeTypeOf("function");
      expect(send).not.toHaveBeenCalled();
      expectRetiredProbe(owned.frame!, close.mock.contexts);
      expect(close).toHaveBeenCalledTimes(2);
      // An already-queued callback cannot transfer its port after retirement.
      owned.load?.call(owned.frame!, new Event("load"));
      expect(send).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(2);
    } finally {
      abort();
      await admission.catch(() => undefined);
    }
  });

  it("preserves exact instrumented bytes while binding each fresh opaque family document", () => {
    for (let index = 0; index < 2; index++) {
      const nonce = crypto.randomUUID();
      const id = crypto.randomUUID();
      // Quotes, backslashes and escaped script text exercise the same original
      // caller-owned JavaScript serialization. Template reuse must not rewrite
      // them or retain a preceding invocation's metadata/fixture script.
      const fixtureScript = `globalThis.fixtureBinding = ${JSON.stringify({
        index,
        id,
        quote: '"',
        slash: "\\",
        script: "<\\/script>",
        templateLike:
          "149ec896-9346-4785-9522-7b65f62a144f c8d073fc-ea46-4169-ae43-9f97afad960a __CAFE_MERMAID_FAMILY_FIXTURE_SLOT_V1__",
      })};`;
      const original = createMermaidSandboxDocument(nonce).replace(
        "</script></body>",
        `</script><script nonce="${nonce}">${fixtureScript}</script></body>`,
      );
      expect(
        createMermaidFamilyProbeDocument(nonce, id, fixtureScript) ===
          instrumentMermaidProbeBootstrap(original, nonce, id),
        "Immutable family template changed exact engine/receiver/fixture bindings",
      ).toBe(true);
    }
    expect(() =>
      createMermaidFamilyProbeDocument('"; script-src *', crypto.randomUUID(), ""),
    ).toThrow("Invalid probe bootstrap binding");
    expect(() => createMermaidFamilyProbeDocument(crypto.randomUUID(), "invalid-id", "")).toThrow(
      "Invalid probe bootstrap binding",
    );
  });

  it("retains identical immutable scripts with distinct per-document nonce policies", () => {
    // The cached object is inert fixed script text only. Distinct documents
    // still bind their own CSP and script nonce, and the engine's embedded
    // script terminators must remain escaped rather than ending that script.
    const firstNonce = crypto.randomUUID();
    const secondNonce = crypto.randomUUID();
    const first = createMermaidSandboxDocument(firstNonce);
    const second = createMermaidSandboxDocument(secondNonce);
    expect(firstNonce).not.toBe(secondNonce);
    expect(first.replaceAll(firstNonce, secondNonce)).toBe(second);
    for (const [source, nonce] of [
      [first, firstNonce],
      [second, secondNonce],
    ] as const) {
      expect(source).toContain(`script-src 'nonce-${nonce}'`);
      expect(source).toContain(`<script nonce="${nonce}">`);
      expect(source.match(/<\/script/gi)).toHaveLength(1);
      expect(source).toContain("connect-src 'none'; img-src 'none'; font-src 'none'");
    }
    expect(() => createMermaidSandboxDocument('"; script-src *')).toThrow("Invalid renderer nonce");
  });

  it("binds bootstrap observations to the exact assets and completed fixture script", () => {
    const nonce = crypto.randomUUID();
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    const documentSource = createMermaidSandboxDocument(nonce).replace(
      "</script></body>",
      `</script><script nonce="${nonce}">globalThis.fixtureOverrideInstalled = true;</script></body>`,
    );
    const first = instrumentMermaidProbeBootstrap(documentSource, nonce, firstId);
    const second = instrumentMermaidProbeBootstrap(documentSource, nonce, secondId);
    // Only the small metadata script varies. Engine/receiver bytes and every
    // marker inside their scripts remain identical for each fresh invocation.
    expect(first.replaceAll(firstId, secondId)).toBe(second);
    expect(first).toContain(
      "globalThis.fixtureOverrideInstalled = true;\ncafeMermaidProbeBootstrap('fixture-ready');</script></body></html>",
    );
    expect(first).toContain("connect-src 'none'; img-src 'none'; font-src 'none'");
    expect(first.match(/<\/script/gi)).toHaveLength(3);
    expect(() => instrumentMermaidProbeBootstrap(documentSource, "invalid-nonce", firstId)).toThrow(
      "Invalid probe bootstrap binding",
    );
    expect(() => instrumentMermaidProbeBootstrap("<script></script>", nonce, firstId)).toThrow(
      "Invalid probe bootstrap asset",
    );
    expect(() => instrumentMermaidProbeBootstrap(first, nonce, firstId)).toThrow(
      "Probe bootstrap document already instrumented",
    );
  });

  it.each([
    {
      name: "observes the initialized native receiver while its exact load callback is withheld",
      admitSourceOnReady: false,
    },
    {
      name: "admits the initialized native receiver without releasing its held generic load callback",
      admitSourceOnReady: true,
    },
  ])("$name", async ({ admitSourceOnReady }) => {
    const phases: MermaidProbeBootstrapPhase[] = [];
    let markReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const close = vi.spyOn(MessagePort.prototype, "close");
    const send = vi.spyOn(MessagePort.prototype, "postMessage");
    const nativeAppend = document.body.append;
    const held: { frame?: HTMLIFrameElement; load: HTMLIFrameElement["onload"] } = { load: null };
    vi.spyOn(document.body, "append").mockImplementation(function (this: HTMLElement, ...nodes) {
      for (const node of nodes) {
        if (node instanceof HTMLIFrameElement && node.dataset.mermaidFamilySecurityFixture) {
          expect(held.frame).toBeUndefined();
          held.frame = node;
          held.load = node.onload;
          // Hold only the exact fixture's callback. Its real srcdoc, full
          // locked engine, receiver registration and fixture overrides still
          // initialize in their original fresh opaque native document.
          node.onload = null;
        }
      }
      nativeAppend.apply(this, nodes);
    });
    const fixture = MERMAID_FAMILY_FIXTURES.find((entry) => entry.family === "kanban")!;
    const admission = admitsParsedFamily(
      fixture.source,
      "",
      undefined,
      undefined,
      1,
      (phase) => {
        phases.push(phase);
        if (phase === "fixture-ready") markReady?.();
      },
      admitSourceOnReady,
    );
    let released = false;
    try {
      await Promise.race([
        ready,
        admission.then(() => {
          throw new Error("Native probe completed before the held load callback");
        }),
      ]);
      expect(phases).toEqual([
        "engine-entered",
        "engine-returned",
        "receiver-installed",
        "fixture-ready",
      ]);
      expect(held.frame?.getAttribute("sandbox")).toBe("allow-scripts");
      expect(held.load).toBeTypeOf("function");
      if (!admitSourceOnReady) {
        expect(held.frame?.isConnected).toBe(true);
        expect(send).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
        released = true;
        held.load?.call(held.frame!, new Event("load"));
      }
      // The received sentinel and original exact native parser-call oracle,
      // not a mock invocation or bootstrap marker, prove positive admission.
      expect(await admission).toBe(true);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith({
        id: held.frame!.dataset.mermaidFamilySecurityFixture,
        source: fixture.source,
        theme: "dark",
      });
      expectRetiredProbe(held.frame!, close.mock.contexts);
      // The ready-gated branch has already received real native admission
      // without executing its generic callback. A queued callback after that
      // result cannot transfer/replay source or reopen its retired exact port.
      held.load?.call(held.frame!, new Event("load"));
      released = true;
      expect(send).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(2);
    } finally {
      if (!released) held.load?.call(held.frame!, new Event("load"));
      await admission.catch(() => undefined);
    }
  });

  it.each([
    {
      name: "ignores foreign, stale and malformed startup observations before the real load",
      admitSourceOnReady: false,
    },
    {
      name: "refuses generic load and unqualified terminal markers as Family source authority",
      admitSourceOnReady: true,
    },
  ])("$name", async ({ admitSourceOnReady }) => {
    const phases: MermaidProbeBootstrapPhase[] = [];
    const send = vi.spyOn(MessagePort.prototype, "postMessage");
    const close = vi.spyOn(MessagePort.prototype, "close");
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const held: { load: HTMLIFrameElement["onload"]; event?: Event } = { load: null };
    let resolveLoad: ((event: Event) => void) | undefined;
    const loaded = new Promise<Event>((resolve) => {
      resolveLoad = resolve;
    });
    const captureLoad = (event: Event) => {
      held.event = event;
      resolveLoad?.(event);
    };
    const nativeAppend = document.body.append;
    vi.spyOn(document.body, "append").mockImplementation(function (this: HTMLElement, ...nodes) {
      for (const node of nodes) {
        if (node instanceof HTMLIFrameElement && node.dataset.mermaidFamilySecurityFixture) {
          held.load = node.onload;
          node.onload = null;
          // Install the witness before native insertion. Foreign observations
          // must not release a receiver that has not finished its own srcdoc.
          node.addEventListener("load", captureLoad, { once: true });
        }
      }
      nativeAppend.apply(this, nodes);
    });
    const probe = startSyntheticProbe(
      "port.postMessage({ id, failed: true });",
      undefined,
      (phase) => phases.push(phase),
      admitSourceOnReady,
    );
    const foreignPort = new MessageChannel();
    const ownedWindow = probe.frame.contentWindow;
    const observer = added.mock.calls.find(([type]) => type === "message")?.[1];
    const marker = {
      id: probe.id,
      nonce: probe.nonce,
      probeBootstrapPhase: "engine-entered",
    };
    try {
      for (const [source, origin, data] of [
        [window, "null", marker],
        [probe.frame.contentWindow, location.origin, marker],
        [probe.frame.contentWindow, "null", { ...marker, id: crypto.randomUUID() }],
        [probe.frame.contentWindow, "null", { ...marker, nonce: crypto.randomUUID() }],
        [probe.frame.contentWindow, "null", { ...marker, private: "unqualified diagnostic field" }],
        [probe.frame.contentWindow, "null", { ...marker, probeBootstrapPhase: "fixture-ready" }],
        [probe.frame.contentWindow, "null", { ...marker, probeBootstrapPhase: "unknown" }],
      ] as const) {
        window.dispatchEvent(new MessageEvent("message", { source, origin, data }));
      }
      expect(phases).toEqual([]);
      expect(send).not.toHaveBeenCalled();
      const nativeLoad = await Promise.race([
        loaded,
        probe.result.then(() => {
          throw new Error("Synthetic probe completed before its exact native load");
        }),
      ]);
      expect(nativeLoad.isTrusted).toBe(true);
      expect(nativeLoad.target).toBe(probe.frame);
      expect(phases).toEqual([]);
      expect(send).not.toHaveBeenCalled();
      // Correct earlier observations still confer no source authority. The
      // real native load also cannot start the opt-in Family branch.
      for (const phase of ["engine-entered", "engine-returned", "receiver-installed"]) {
        window.dispatchEvent(
          new MessageEvent("message", {
            source: ownedWindow,
            origin: "null",
            data: { ...marker, probeBootstrapPhase: phase },
          }),
        );
      }
      expect(phases).toEqual(["engine-entered", "engine-returned", "receiver-installed"]);
      if (admitSourceOnReady) held.load?.call(probe.frame, nativeLoad);
      expect(send).not.toHaveBeenCalled();
      const readyMarker = { ...marker, probeBootstrapPhase: "fixture-ready" };
      for (const [source, origin, data] of [
        [window, "null", readyMarker],
        [ownedWindow, location.origin, readyMarker],
        [ownedWindow, "null", { ...readyMarker, id: crypto.randomUUID() }],
        [ownedWindow, "null", { ...readyMarker, nonce: crypto.randomUUID() }],
        [ownedWindow, "null", { ...readyMarker, private: "unqualified diagnostic field" }],
        [ownedWindow, "null", { id: probe.id, probeBootstrapPhase: "fixture-ready" }],
        [ownedWindow, "null", [readyMarker]],
        [ownedWindow, "null", null],
      ] as const) {
        window.dispatchEvent(new MessageEvent("message", { source, origin, data }));
      }
      window.dispatchEvent(
        new MessageEvent("message", {
          source: ownedWindow,
          origin: "null",
          data: readyMarker,
          ports: [foreignPort.port1],
        }),
      );
      expect(phases).toEqual(["engine-entered", "engine-returned", "receiver-installed"]);
      expect(send).not.toHaveBeenCalled();
      window.dispatchEvent(
        new MessageEvent("message", { source: ownedWindow, origin: "null", data: readyMarker }),
      );
      if (!admitSourceOnReady) {
        expect(send).not.toHaveBeenCalled();
        held.load?.call(probe.frame, nativeLoad);
      }
      expect(send).toHaveBeenCalledTimes(1);
      // Replayed readiness and a queued load cannot reserve a second request,
      // even while the first exact native peer reply is still pending.
      window.dispatchEvent(
        new MessageEvent("message", { source: ownedWindow, origin: "null", data: readyMarker }),
      );
      held.load?.call(probe.frame, nativeLoad);
      expect(send).toHaveBeenCalledTimes(1);
      expect(await probe.result).toBe(false);
      expectRetiredProbe(probe.frame, close.mock.contexts);
      expect(observer).toBeTypeOf("function");
      expect(removed).toHaveBeenCalledWith("message", observer);
      const stale = new MessageEvent("message", {
        source: ownedWindow,
        origin: "null",
        data: marker,
      });
      window.dispatchEvent(stale);
      // A callback captured before retirement may itself already be queued.
      // It must preserve the settled owner even with its original WindowProxy.
      if (typeof observer === "function") observer.call(window, stale);
      expect(phases).toEqual([
        "engine-entered",
        "engine-returned",
        "receiver-installed",
        "fixture-ready",
      ]);
      expect(send).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(2);
    } finally {
      probe.frame.removeEventListener("load", captureLoad);
      if (held.event) held.load?.call(probe.frame, held.event);
      else if (probe.frame.isConnected) probe.frame.dispatchEvent(new Event("error"));
      await probe.result.catch(() => undefined);
      foreignPort.port1.close();
      foreignPort.port2.close();
    }
  });

  it("preserves native progress across synchronous reservation and queued duplicate startup callbacks", async () => {
    const close = vi.spyOn(MessagePort.prototype, "close");
    const nativeSend = MessagePort.prototype.postMessage;
    const reenter: { invoke?: () => void } = {};
    const send = vi.spyOn(MessagePort.prototype, "postMessage").mockImplementation(function (
      this: MessagePort,
      message: unknown,
    ) {
      nativeSend.call(this, message);
      const receive = this.onmessage;
      const id = (message as { readonly id: string }).id;
      // Forward the real exact source first. These controlled delivery edges
      // qualify callback ownership and the fixed failure-phase oracle; they
      // are not evidence of successful native parsing or admission.
      receive?.call(
        this,
        new MessageEvent("message", { data: { id, probePhase: "parser-entered" } }),
      );
      reenter.invoke?.();
      queueMicrotask(() => {
        receive?.call(this, new MessageEvent("message", { data: { id, failed: false } }));
      });
    });
    const probe = startSyntheticProbe(
      "port.postMessage({ id, failed: true });",
      undefined,
      () => undefined,
      true,
    );
    const load = probe.frame.onload;
    const ownedWindow = probe.frame.contentWindow;
    const marker = { id: probe.id, nonce: probe.nonce, probeBootstrapPhase: "fixture-ready" };
    const captureLoad: { resolve?: (event: Event) => void } = {};
    const loaded = new Promise<Event>((resolve) => {
      captureLoad.resolve = resolve;
    });
    const witness = (event: Event) => captureLoad.resolve?.(event);
    probe.frame.addEventListener("load", witness, { once: true });
    const rejected = expect(probe.result).rejects.toThrow(
      "received an invalid result (baseline; phase parser-entered) [bootstrap fixture-ready]",
    );
    try {
      const nativeLoad = await Promise.race([
        loaded,
        probe.result.then(() => {
          throw new Error("Synthetic source ownership completed before its exact native load");
        }),
      ]);
      expect(nativeLoad.isTrusted).toBe(true);
      expect(nativeLoad.target).toBe(probe.frame);
      expect(send).not.toHaveBeenCalled();
      reenter.invoke = () => {
        window.dispatchEvent(
          new MessageEvent("message", { source: ownedWindow, origin: "null", data: marker }),
        );
        load?.call(probe.frame, nativeLoad);
      };
      for (const phase of [
        "engine-entered",
        "engine-returned",
        "receiver-installed",
        "fixture-ready",
      ]) {
        window.dispatchEvent(
          new MessageEvent("message", {
            source: ownedWindow,
            origin: "null",
            data: { ...marker, probeBootstrapPhase: phase },
          }),
        );
      }
      await rejected;
      expect(send).toHaveBeenCalledTimes(1);
      expectRetiredProbe(probe.frame, close.mock.contexts);
    } finally {
      probe.frame.removeEventListener("load", witness);
      if (probe.frame.isConnected) probe.frame.dispatchEvent(new Event("error"));
      await probe.result.catch(() => undefined);
    }
  });

  it.each([
    {
      name: "refuses an exact queued startup marker at the unchanged absolute deadline",
      admitSourceOnReady: false,
      terminal: false,
    },
    {
      name: "refuses initial Family bootstrap at the unchanged absolute deadline",
      admitSourceOnReady: true,
      terminal: false,
    },
    {
      name: "refuses terminal Family readiness at the unchanged absolute deadline",
      admitSourceOnReady: true,
      terminal: true,
    },
  ])("$name", async ({ admitSourceOnReady, terminal }) => {
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    const phases: MermaidProbeBootstrapPhase[] = [];
    const close = vi.spyOn(MessagePort.prototype, "close");
    const send = vi.spyOn(MessagePort.prototype, "postMessage");
    const probe = startSyntheticProbe(
      "port.postMessage({ id, failed: true });",
      undefined,
      (phase) => phases.push(phase),
      admitSourceOnReady,
    );
    const load = probe.frame.onload;
    probe.frame.onload = null;
    if (terminal) {
      for (const phase of ["engine-entered", "engine-returned", "receiver-installed"]) {
        window.dispatchEvent(
          new MessageEvent("message", {
            source: probe.frame.contentWindow,
            origin: "null",
            data: { id: probe.id, nonce: probe.nonce, probeBootstrapPhase: phase },
          }),
        );
      }
    }
    now.mockReturnValue(10_000);
    window.dispatchEvent(
      new MessageEvent("message", {
        source: probe.frame.contentWindow,
        origin: "null",
        data: {
          id: probe.id,
          nonce: probe.nonce,
          probeBootstrapPhase: terminal ? "fixture-ready" : "engine-entered",
        },
      }),
    );
    await expect(probe.result).rejects.toThrow(
      `did not reply (baseline; phase document-constructed) [bootstrap ${terminal ? "receiver-installed" : "not-observed"}]`,
    );
    load?.call(probe.frame, new Event("load"));
    expect(phases).toEqual(
      terminal ? ["engine-entered", "engine-returned", "receiver-installed"] : [],
    );
    expect(send).not.toHaveBeenCalled();
    expectRetiredProbe(probe.frame, close.mock.contexts);
  });

  it("uses fresh frames, nonces, IDs and ports for consecutive exact source requests", async () => {
    const close = vi.spyOn(MessagePort.prototype, "close");
    const reply = `port.postMessage({ id, svg: ${JSON.stringify(probeSentinel)} });`;
    const first = startSyntheticProbe(reply, "first synthetic source");
    expect(first.frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(await first.result).toBe(true);
    const firstPorts = close.mock.contexts.slice();
    expectRetiredProbe(first.frame, firstPorts);
    const second = startSyntheticProbe(reply, "second synthetic source");
    expect(await second.result).toBe(true);
    const secondPorts = close.mock.contexts.slice(2);
    expectRetiredProbe(second.frame, secondPorts);
    expect(second.frame).not.toBe(first.frame);
    expect(second.id).not.toBe(first.id);
    expect(second.nonce).not.toBe(first.nonce);
    for (const port of secondPorts) expect(firstPorts).not.toContain(port);
  });

  it("accepts only an explicit content-free refusal as a negative result", async () => {
    const close = vi.spyOn(MessagePort.prototype, "close");
    const probe = startSyntheticProbe("port.postMessage({ id, failed: true });");
    expect(await probe.result).toBe(false);
    expectRetiredProbe(probe.frame, close.mock.contexts);
  });

  it.each([
    ["a matching ID without a result", "{ id }"],
    ["a false failure flag", "{ id, failed: false }"],
    ["a non-string SVG", "{ id, svg: 17 }"],
    ["a different SVG sentinel", "{ id, svg: '<svg />' }"],
    [
      "conflicting success and failure",
      `{ id, failed: true, svg: ${JSON.stringify(probeSentinel)} }`,
    ],
    ["private failure fields", "{ id, failed: true, error: 'private synthetic parser content' }"],
  ])("rejects %s and retires its exact probe", async (_name, response) => {
    const close = vi.spyOn(MessagePort.prototype, "close");
    const probe = startSyntheticProbe(`port.postMessage(${response});`);
    await expect(probe.result).rejects.toThrow(
      "received an invalid result (baseline; phase request-sent)",
    );
    expectRetiredProbe(probe.frame, close.mock.contexts);
  });

  it("reports only a fixed phase received on the exact probe port", async () => {
    const close = vi.spyOn(MessagePort.prototype, "close");
    const probe = startSyntheticProbe(
      "port.postMessage({ id, probePhase: 'parser-entered' }); port.postMessage({ id, failed: false });",
    );
    await expect(probe.result).rejects.toThrow(
      "received an invalid result (baseline; phase parser-entered)",
    );
    expectRetiredProbe(probe.frame, close.mock.contexts);
  });

  it("keeps repeated native phase observations separate from the parser-count oracle", async () => {
    const close = vi.spyOn(MessagePort.prototype, "close");
    const probe = startSyntheticProbe(
      `for (const probePhase of ['parser-entered', 'parser-returned', 'parser-entered', 'parser-returned', 'render-entered', 'render-returned']) port.postMessage({ id, probePhase });
       port.postMessage({ id, failed: true });`,
    );
    expect(await probe.result).toBe(false);
    expectRetiredProbe(probe.frame, close.mock.contexts);
  });

  it("refuses a queued valid reply at the absolute deadline before timer delivery", async () => {
    // Only this synthetic peer's monotonic clock is controlled. Its actual
    // ten-second callback stays pending, proving that a queued result cannot
    // gain extra allowance merely by being dispatched before that callback.
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    const close = vi.spyOn(MessagePort.prototype, "close");
    const clear = vi.spyOn(globalThis, "clearTimeout");
    const timers = vi.spyOn(globalThis, "setTimeout");
    vi.spyOn(MessagePort.prototype, "postMessage").mockImplementation(function (
      this: MessagePort,
      message: unknown,
    ) {
      const queuedResponse = this.onmessage;
      queueMicrotask(() => {
        now.mockReturnValue(10_000);
        queuedResponse?.call(
          this,
          new MessageEvent("message", {
            data: { id: (message as { readonly id: string }).id, svg: probeSentinel },
          }),
        );
      });
    });
    const probe = startSyntheticProbe(
      `port.postMessage({ id, svg: ${JSON.stringify(probeSentinel)} });`,
    );
    await expect(probe.result).rejects.toThrow("did not reply (baseline; phase request-sent)");
    expectRetiredProbe(probe.frame, close.mock.contexts);
    const timerIndex = timers.mock.calls.findIndex((call) => call[1] === 10_000);
    expect(timerIndex).toBeGreaterThanOrEqual(0);
    const timer = timers.mock.results[timerIndex]!;
    expect(timer.type).toBe("return");
    expect(clear).toHaveBeenCalledWith(timer.value);
  });

  it("fences queued load and response callbacks after a source-send exception", async () => {
    const close = vi.spyOn(MessagePort.prototype, "close");
    const retired: { port?: MessagePort; onmessage: MessagePort["onmessage"] } = {
      onmessage: null,
    };
    const send = vi.spyOn(MessagePort.prototype, "postMessage").mockImplementation(function (
      this: MessagePort,
    ) {
      retired.port = this;
      retired.onmessage = this.onmessage;
      throw new Error("private synthetic transport detail");
    });
    const probe = startSyntheticProbe(
      `port.postMessage({ id, svg: ${JSON.stringify(probeSentinel)} });`,
    );
    const queuedLoad = probe.frame.onload;
    await expect(probe.result).rejects.toThrow("send failed (baseline; phase frame-loaded)");
    expectRetiredProbe(probe.frame, close.mock.contexts);
    expect(send).toHaveBeenCalledTimes(1);
    queuedLoad?.call(probe.frame, new Event("load"));
    expect(retired.onmessage).toBeTypeOf("function");
    retired.onmessage?.call(
      retired.port!,
      new MessageEvent("message", { data: { id: probe.id, svg: probeSentinel } }),
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("retires a frame error before load without transferring or sending source", async () => {
    const close = vi.spyOn(MessagePort.prototype, "close");
    const send = vi.spyOn(MessagePort.prototype, "postMessage");
    const probe = startSyntheticProbe("port.postMessage({ id, failed: true });");
    const queuedLoad = probe.frame.onload;
    probe.frame.dispatchEvent(new Event("error"));
    await expect(probe.result).rejects.toThrow(
      "load failed (baseline; phase document-constructed)",
    );
    queuedLoad?.call(probe.frame, new Event("load"));
    expect(send).not.toHaveBeenCalled();
    expectRetiredProbe(probe.frame, close.mock.contexts);
  });

  it("retires a message deserialization error without accepting a negative result", async () => {
    const close = vi.spyOn(MessagePort.prototype, "close");
    vi.spyOn(MessagePort.prototype, "postMessage").mockImplementation(function (this: MessagePort) {
      this.dispatchEvent(new MessageEvent("messageerror"));
    });
    const probe = startSyntheticProbe("port.postMessage({ id, failed: true });");
    await expect(probe.result).rejects.toThrow("message failed (baseline; phase frame-loaded)");
    expectRetiredProbe(probe.frame, close.mock.contexts);
  });

  it("keeps one ten-second allowance after construction and fences a late load", async () => {
    // Advance only the isolated helper's original timer. This is not a retry,
    // an increased native-renderer deadline or a browser/media override.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const close = vi.spyOn(MessagePort.prototype, "close");
      const send = vi.spyOn(MessagePort.prototype, "postMessage");
      const probe = startSyntheticProbe("port.postMessage({ id, failed: true });");
      const queuedLoad = probe.frame.onload;
      const rejected = expect(probe.result).rejects.toThrow(
        "did not reply (baseline; phase document-constructed)",
      );
      vi.advanceTimersByTime(9_999);
      expect(probe.frame.isConnected).toBe(true);
      vi.advanceTimersByTime(1);
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
      queuedLoad?.call(probe.frame, new Event("load"));
      expect(send).not.toHaveBeenCalled();
      expectRetiredProbe(probe.frame, close.mock.contexts);
    } finally {
      vi.useRealTimers();
    }
  });
});
