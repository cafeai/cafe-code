import { expect, it } from "vitest";
import { Budget } from "./budget.ts";
import { NdjsonGuard, RELAY_RPC_MESSAGE_BYTES } from "./ndjson.ts";
import { utf8 } from "./bytes.ts";

it("bounds each unfinished command and the aggregate parser prefixes", () => {
  const budget = new Budget(262_144),
    a = new NdjsonGuard(budget),
    b = new NdjsonGuard(budget),
    c = new NdjsonGuard(budget);
  for (let i = 0; i < 4; i++) {
    a.admit(new Uint8Array(16_384));
    b.admit(new Uint8Array(16_384));
  }
  expect(budget.current).toBe(262_144);
  const healthy = new NdjsonGuard(budget);
  healthy.admit(utf8.encode("{}\n"));
  healthy.finish();
  expect(budget.current).toBe(262_144);
  expect(() => c.admit(utf8.encode("x"))).toThrow();
  expect(budget.current).toBe(262_144);
  a.admit(utf8.encode("\n{}\npartial"));
  expect(budget.current).toBe(131_086);
  expect(() => b.admit(utf8.encode("x"))).toThrow();
  expect(budget.current).toBe(14);
  expect(() => a.finish()).toThrow();
  expect(budget.current).toBe(0);
  c.close();
});

it("rejects an oversized complete command and accepts exact framed EOF", () => {
  const budget = new Budget(262_144),
    a = new NdjsonGuard(budget);
  a.admit(new Uint8Array(65_536));
  a.admit(utf8.encode("\n"));
  a.finish();
  expect(budget.current).toBe(0);
  const b = new NdjsonGuard(budget);
  expect(() => b.admit(new Uint8Array(65_538).fill(10, 65_537))).toThrow();
  expect(budget.current).toBe(0);
});

it("admits ordinary long prompts and inline image bytes under a shared finite prefix budget", () => {
  const budget = new Budget(RELAY_RPC_MESSAGE_BYTES * 2),
    guard = new NdjsonGuard(budget, RELAY_RPC_MESSAGE_BYTES);
  const command = utf8.encode(
    JSON.stringify({
      message: "m".repeat(120_000),
      imageDataUrl: "data:image/png;base64," + "A".repeat(300_000),
    }),
  );
  for (let offset = 0; offset < command.length; offset += 8192)
    guard.admit(command.subarray(offset, offset + 8192));
  expect(budget.current).toBe(command.length * 2);
  guard.admit(utf8.encode("\n"));
  guard.finish();
  expect(budget.current).toBe(0);
});
