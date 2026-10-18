import { createServer } from "node:http";
import { expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import { glideControlResponses, glideExecutionResponses } from "./mcpResponse.ts";

it("holds native execution response ownership through finish and reserves separate control output", async () => {
  const held = new Set<() => void>();
  const server = createServer((incoming, outgoing) => {
    const budget = incoming.url === "/execute" ? glideExecutionResponses : glideControlResponses;
    try {
      const lease = budget.acquire(outgoing);
      lease.beginOutput();
      outgoing.writeHead(200);
      outgoing.write("owned");
      if (incoming.url === "/execute") {
        const finish = () => outgoing.end();
        held.add(finish);
        outgoing.once("close", () => held.delete(finish));
      } else outgoing.end();
    } catch {
      outgoing.writeHead(503);
      outgoing.end();
    }
  });
  await new Promise<void>((yes) => server.listen(0, "127.0.0.1", yes));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing response fixture address.");
  const url = `http://127.0.0.1:${address.port}`;
  const clients: Response[] = [];
  try {
    for (let index = 0; index < 4; index++) clients.push(await fetch(`${url}/execute`));
    expect(held.size).toBe(4);
    const refused = await fetch(`${url}/execute`);
    expect(refused.status).toBe(503);
    await refused.body?.cancel();
    const control = await fetch(`${url}/reset`);
    expect(control.status).toBe(200);
    expect(await control.text()).toBe("owned");
    for (const finish of held) finish();
    expect(await Promise.all(clients.map((response) => response.text()))).toEqual(
      Array(4).fill("owned"),
    );
  } finally {
    for (const finish of held) finish();
    await Promise.allSettled(clients.map((response) => response.body?.cancel()));
    server.closeAllConnections();
    await new Promise<void>((yes) => server.close(() => yes()));
  }
});

it("bounds actual image bytes and smaller control streams independently", async () => {
  const output = (size: number) => Stream.make(new Uint8Array(size));
  const tooLargeControl = await Effect.runPromise(
    glideControlResponses.bound(output(64 * 1024 + 1)).pipe(Stream.runDrain, Effect.exit),
  );
  expect(Exit.isFailure(tooLargeControl)).toBe(true);
  const image = await Effect.runPromise(
    glideExecutionResponses.bound(output(80 * 1024)).pipe(Stream.runDrain, Effect.exit),
  );
  expect(Exit.isSuccess(image)).toBe(true);
  const excessiveChunks = Stream.fromIterable(Array.from({ length: 2049 }, () => new Uint8Array()));
  expect(
    Exit.isFailure(
      await Effect.runPromise(
        glideExecutionResponses.bound(excessiveChunks).pipe(Stream.runDrain, Effect.exit),
      ),
    ),
  ).toBe(true);
});
