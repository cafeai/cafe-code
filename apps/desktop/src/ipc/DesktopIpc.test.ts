import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import * as DesktopIpc from "./DesktopIpc.ts";

const origin = new URL("http://127.0.0.1:5733/");
function frame(url = origin.href): DesktopIpc.DesktopIpcWebFrame {
  const value = { url, frameToken: "initial", detached: false } as DesktopIpc.DesktopIpcWebFrame;
  (value as { top: DesktopIpc.DesktopIpcWebFrame }).top = value;
  return value;
}

async function fixture(
  task: (input: {
    invoke: DesktopIpc.DesktopIpcHandleListener;
    sync: DesktopIpc.DesktopIpcSyncListener;
    sender: { mainFrame: DesktopIpc.DesktopIpcWebFrame; isDestroyed: () => boolean };
    calls: () => number;
  }) => Promise<void>,
  role: "main" | "dictation" = "main",
  pending?: () => Promise<void>,
) {
  let invoke!: DesktopIpc.DesktopIpcHandleListener;
  let sync!: DesktopIpc.DesktopIpcSyncListener;
  let calls = 0;
  const sender = { mainFrame: frame(), isDestroyed: () => false };
  const ipc = DesktopIpc.make({
    handle: (_channel, listener) => {
      invoke = listener;
    },
    on: (_channel, listener) => {
      sync = listener;
    },
    removeHandler: () => {},
    removeAllListeners: () => {},
  });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* ipc.trustWebContents(sender, { url: origin, role });
        yield* ipc.handle({
          channel: "desktop:secret",
          handler: () =>
            Effect.gen(function* () {
              calls++;
              if (pending) yield* Effect.promise(pending);
              return "secret";
            }),
        });
        yield* ipc.handleSync({
          channel: "desktop:get-local-environment-bootstrap",
          handler: () =>
            Effect.sync(() => {
              calls++;
              return "bootstrap";
            }),
        });
        yield* Effect.promise(() => task({ invoke, sync, sender, calls: () => calls }));
      }),
    ),
  );
}

describe("desktop document authorization", () => {
  it("allows only the exact registered HTTP origin", () => {
    expect(DesktopIpc.isTrustedDesktopIpcFrameUrl(`${origin.origin}/chat/one`, origin)).toBe(true);
    for (const url of [
      "http://127.0.0.1:1/",
      "http://localhost:5733/",
      "http://[::1]:5733/",
      "https://127.0.0.1:5733/",
      "file:///Applications/CafeCode/index.html",
      "data:text/html,hello",
      "https://evil.example/",
      "http://user:pass@127.0.0.1:5733/",
      "http://127.0.0.1:5733/api/attachments/private.html",
      "http://127.0.0.1:5733/attachments/private.svg",
      "http://127.0.0.1:5733/%61pi/auth/session",
      "http://127.0.0.1:5733/%2561pi/auth/session",
      "http://127.0.0.1:5733/assets/received.html",
    ]) {
      expect(DesktopIpc.isTrustedDesktopIpcFrameUrl(url, origin)).toBe(false);
    }
  });
  it("checks the live main frame, sender, origin, and destruction before invoking", async () => {
    await fixture(async ({ invoke, sender, calls }) => {
      await expect(invoke({ sender, senderFrame: sender.mainFrame }, null)).resolves.toBe("secret");
      for (const senderFrame of [
        frame("http://127.0.0.1:1/"),
        frame(),
        null,
        { ...frame(), top: sender.mainFrame },
      ]) {
        await expect(invoke({ sender, senderFrame }, null)).rejects.toThrow(
          DesktopIpc.DesktopIpcSenderValidationError,
        );
      }
      const original = sender.mainFrame;
      sender.mainFrame = frame("file:///unrelated.html");
      await expect(invoke({ sender, senderFrame: sender.mainFrame }, null)).rejects.toThrow();
      sender.mainFrame = original;
      sender.isDestroyed = () => true;
      await expect(invoke({ sender, senderFrame: original }, null)).rejects.toThrow();
      await expect(
        invoke({ sender: { mainFrame: original }, senderFrame: original }, null),
      ).rejects.toThrow();
      expect(calls()).toBe(1);
    });
  });
  it("limits dictation surfaces to their exact bootstrap document", async () => {
    await fixture(async ({ invoke, sync, sender, calls }) => {
      await expect(invoke({ sender, senderFrame: sender.mainFrame }, null)).rejects.toThrow();
      const event = { sender, senderFrame: sender.mainFrame, returnValue: null as unknown };
      sync(event);
      expect(event.returnValue).toBe("bootstrap");
      sender.mainFrame = frame(`${origin.origin}/other`);
      sync({ ...event, senderFrame: sender.mainFrame });
      expect(calls()).toBe(1);
    }, "dictation");
  });
  it("withholds asynchronous results after same-URL document replacement", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await fixture(
      async ({ invoke, sender }) => {
        const result = Promise.resolve(invoke({ sender, senderFrame: sender.mainFrame }, null));
        const assertion = expect(result).rejects.toThrow();
        sender.mainFrame = frame();
        release();
        await assertion;
      },
      "main",
      () => pending,
    );
  });
  it("withholds results when the native document token changes in place", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await fixture(
      async ({ invoke, sender }) => {
        const result = Promise.resolve(invoke({ sender, senderFrame: sender.mainFrame }, null));
        const assertion = expect(result).rejects.toThrow();
        (sender.mainFrame as { frameToken: string }).frameToken = "replacement";
        release();
        await assertion;
      },
      "main",
      () => pending,
    );
  });
});
