// Synthetic stdio transport keeps exact stream identity and explicit retirement.
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runGlideMcp } from "../glide/entry.ts";
import { runGlideBridge } from "./glideBridge.ts";
import { runLocalBridge } from "./localBridge.ts";

vi.mock("./localBridge.ts", () => ({ runLocalBridge: vi.fn(async () => undefined) }));
afterEach(() => vi.mocked(runLocalBridge).mockClear());

describe.each([
  ["managed", runGlideBridge],
  ["historical standalone", runGlideMcp],
] as const)("%s Glide MCP admission", (_name, run) => {
  it.each([
    [],
    [""],
    ["private-connection.json", "extra"],
    ["--native-helper", "/caller/helper", "--allow-app", "fixture.editor"],
    ["--native-helper=/caller/helper"],
    ["--allow-app", "fixture.editor"],
    ["--input-mode", "foreground"],
  ])("rejects caller-granted native access or missing chat credentials: %j", async (...args) => {
    await expect(run(args)).rejects.toThrow("authorized Cafe chat connection");
    expect(runLocalBridge).not.toHaveBeenCalled();
  });

  it("forwards only through the Glide chat audience and preserves its exact transport", async () => {
    const input = Readable.from([]);
    const output = new Writable({ write: (_chunk, _encoding, done) => done() });
    try {
      await run(["private-connection.json"], { input, output });
      expect(runLocalBridge).toHaveBeenCalledExactlyOnceWith({
        connectionPath: "private-connection.json",
        target: "cafe-glide",
        input,
        output,
      });
    } finally {
      input.destroy();
      output.destroy();
    }
  });
});
