import { describe, expect, it } from "vitest";
import { makeOpenCodeStartupOutput, OPENCODE_STARTUP_OUTPUT_MAX_CHARS } from "./opencodeRuntime.ts";

describe("OpenCode startup output", () => {
  it("accepts a split readiness marker only for the launched listener", () => {
    const output = makeOpenCodeStartupOutput({ hostname: "127.0.0.1", port: 4321 });
    expect(output.write("initializing\nopencode server list")).toBeNull();
    expect(output.write("ening on http://127.0.0.1:432")).toBeNull();
    expect(output.write("1\n")).toBe("http://127.0.0.1:4321");
    expect(output.bufferedChars).toBe(0);
  });

  for (const address of [
    "http://other-server.invalid:4321",
    "http://127.0.0.1:4322",
    "https://127.0.0.1:4321",
    "http://user:password@127.0.0.1:4321",
    "http://127.0.0.1:4321/private",
    "http://127.0.0.1:4321?token=private",
    "http://127.0.0.1:4321#private",
  ]) {
    it(`refuses a readiness marker for ${address}`, () => {
      const output = makeOpenCodeStartupOutput({ hostname: "127.0.0.1", port: 4321 });
      expect(output.write(`opencode server listening on ${address}\n`)).toBeNull();
    });
  }

  it("bounds pre-readiness noise and retains no output after readiness or retirement", () => {
    const output = makeOpenCodeStartupOutput({ hostname: "127.0.0.1", port: 4321 });
    const noise = "x".repeat(OPENCODE_STARTUP_OUTPUT_MAX_CHARS * 4);
    expect(output.write(noise)).toBeNull();
    expect(output.bufferedChars).toBeLessThanOrEqual(OPENCODE_STARTUP_OUTPUT_MAX_CHARS);
    expect(output.write("\nopencode server listening on http://127.0.0.1:4321\n")).toBe(
      "http://127.0.0.1:4321",
    );
    expect(output.write(noise)).toBeNull();
    expect(output.bufferedChars).toBe(0);
    const retired = makeOpenCodeStartupOutput({ hostname: "127.0.0.1", port: 4321 });
    retired.write(noise);
    retired.finish();
    expect(retired.write("opencode server listening on http://127.0.0.1:4321\n")).toBeNull();
    expect(retired.bufferedChars).toBe(0);
  });

  it("waits for the full marker and can ignore a foreign marker before the real listener", () => {
    const output = makeOpenCodeStartupOutput({ hostname: "127.0.0.1", port: 4321 });
    expect(output.write("opencode server listening on http://127.0.0.1:4321")).toBeNull();
    expect(output.write("/other\n")).toBeNull();
    expect(output.write("opencode server listening on http://127.0.0.1:4321\n")).toBe(
      "http://127.0.0.1:4321",
    );
  });
});
