// Native fixture retains actual host file/socket identity and exact owned cleanup.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createServer, request, type Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { runPrivateGlideRequest } from "./privateDaemon.ts";

async function fixture(execute: Parameters<typeof runPrivateGlideRequest>[2]) {
  const tasks = new Set<Promise<void>>();
  const server = createServer((incoming, outgoing) => {
    const task = runPrivateGlideRequest(incoming, outgoing, execute);
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  });
  await new Promise<void>((yes) => server.listen(0, "127.0.0.1", yes));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port.");
  const url = `http://127.0.0.1:${address.port}`;
  return {
    server,
    url,
    close: async () => {
      await close(server);
      await Promise.all(tasks);
    },
  };
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((yes) => server.close(() => yes()));
}
describe("private Glide daemon transport", () => {
  it("admits worst-case JSON expansion of a bounded JS cell, and rejects actual oversized or deeply nested bodies", async () => {
    const execute = vi.fn(async (body: unknown) => body);
    const f = await fixture(execute);
    try {
      const body = { code: "\0".repeat(128 * 1024) };
      const response = await fetch(f.url, { method: "POST", body: JSON.stringify(body) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(body);
      for (const invalid of ["x".repeat(1024 * 1024 + 1), "[".repeat(17) + "0" + "]".repeat(17)]) {
        const refused = await fetch(f.url, { method: "POST", body: invalid });
        expect(refused.status).toBe(403);
        await refused.body?.cancel();
      }
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  });
  it("propagates actual client disconnection to only that execution's abort signal", async () => {
    const entered = Promise.withResolvers<AbortSignal>();
    const cancelled = Promise.withResolvers<void>();
    const f = await fixture(async (_body, signal) => {
      entered.resolve(signal);
      await new Promise<void>((yes) =>
        signal.addEventListener(
          "abort",
          () => {
            cancelled.resolve();
            yes();
          },
          { once: true },
        ),
      );
      return null;
    });
    const client = request(f.url, { method: "POST" });
    client.on("error", () => {});
    try {
      client.end("{}");
      expect((await entered.promise).aborted).toBe(false);
      client.destroy();
      await cancelled.promise;
      expect((await entered.promise).aborted).toBe(true);
    } finally {
      client.destroy();
      await f.close();
    }
  });
  it("refuses a fifth execution while retaining a control lane for reset or Stop", async () => {
    const opened = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let count = 0;
    const f = await fixture(async (body) => {
      if ((body as { kind: string }).kind !== "execute") return { control: true };
      if (++count === 4) opened.resolve();
      await release.promise;
      return null;
    });
    const admitted = Array.from({ length: 4 }, () =>
      fetch(f.url, { method: "POST", body: '{"kind":"execute"}' }),
    );
    try {
      await opened.promise;
      const refused = await fetch(f.url, { method: "POST", body: '{"kind":"execute"}' });
      expect(refused.status).toBe(503);
      expect(count).toBe(4);
      await refused.body?.cancel();
      const control = await fetch(f.url, { method: "POST", body: '{"kind":"reset"}' });
      expect(control.status).toBe(200);
      expect(await control.json()).toEqual({ control: true });
      expect(count).toBe(4);
      release.resolve();
      for (const response of await Promise.all(admitted)) {
        expect(response.status).toBe(200);
        await response.body?.cancel();
      }
    } finally {
      release.resolve();
      await Promise.allSettled(admitted);
      await f.close();
    }
  });
});
