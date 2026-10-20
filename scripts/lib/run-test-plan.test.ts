import { EventEmitter } from "node:events";
// Exact private native fixture paths and cleanup qualify the child-handle runner.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
// Native event-emitter fixtures implement this exact held child/close contract.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { runTestPlan } from "./run-test-plan.ts";
import type { TestStep } from "./test-run-plan.ts";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

async function withRunner(
  use: (
    children: ChildProcess[],
    run: (steps: readonly TestStep[]) => Promise<void>,
  ) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "cafe-test-plan-"));
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist/yarn.js"), "// inert Corepack entry\n");
  const children: ChildProcess[] = [];
  const runs: Promise<void>[] = [];
  const run = (steps: readonly TestStep[]) => {
    const pending = runTestPlan(steps);
    runs.push(pending);
    // Join below even if a preceding fixture assertion throws before the test
    // reaches its own await; cleanup must not produce an unhandled rejection.
    void pending.catch(() => {});
    return pending;
  };
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubEnv("COREPACK_ROOT", root);
  spawn.mockImplementation(() => {
    const child = new EventEmitter() as ChildProcess;
    child.kill = vi.fn(() => true);
    children.push(child);
    return child;
  });
  try {
    await use(children, run);
  } finally {
    // Retire the exact synthetic children even when a test assertion fails.
    // There is no native process or provider behind these event emitters.
    for (const child of children) child.emit("close", null, "SIGTERM");
    await Promise.allSettled(runs);
    spawn.mockReset();
    log.mockRestore();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("sequential test-plan lifetime", () => {
  it("waits for stdio close, not only process exit, before starting the next owned invocation", async () => {
    await withRunner(async (children, execute) => {
      let settled = false;
      const run = execute([
        { name: "first", args: ["exec", "first"] },
        { name: "second", args: ["exec", "second"] },
      ]).then(() => {
        settled = true;
      });
      expect(children).toHaveLength(1);
      children[0]!.emit("exit", 0, null);
      await Promise.resolve();
      expect(children).toHaveLength(1);
      expect(settled).toBe(false);
      children[0]!.emit("close", 0, null);
      await Promise.resolve();
      expect(children).toHaveLength(2);
      expect(settled).toBe(false);
      children[1]!.emit("close", 0, null);
      await run;
      expect(settled).toBe(true);
      expect(spawn).toHaveBeenCalledWith(
        process.execPath,
        expect.any(Array),
        expect.objectContaining({ shell: false }),
      );
    });
  });

  it("keeps parent cancellation authoritative even when the child exits zero", async () => {
    await withRunner(async (children, execute) => {
      const before = new Set(process.listeners("SIGINT"));
      const run = execute([{ name: "cancelled group", args: ["exec", "fixture"] }]);
      const rejection = expect(run).rejects.toThrow("cancelled group cancelled (0)");
      const interrupt = process.listeners("SIGINT").find((listener) => !before.has(listener));
      expect(interrupt).toBeDefined();
      interrupt!("SIGINT");
      expect(children[0]!.kill).toHaveBeenCalledExactlyOnceWith("SIGINT");
      children[0]!.emit("close", 0, null);
      await rejection;
      expect(new Set(process.listeners("SIGINT"))).toEqual(before);
      expect(children).toHaveLength(1);
    });
  });

  it("does not admit a second group after a transport error or native signal", async () => {
    await withRunner(async (children, execute) => {
      const failure = new Error("synthetic child transport failure");
      const run = execute([
        { name: "failed group", args: ["exec", "fixture"] },
        { name: "must not start", args: ["exec", "next"] },
      ]);
      const rejection = expect(run).rejects.toBe(failure);
      children[0]!.emit("error", failure);
      children[0]!.emit("exit", 0, null);
      await Promise.resolve();
      expect(children).toHaveLength(1);
      children[0]!.emit("close", 0, null);
      await rejection;
      expect(children).toHaveLength(1);
    });
    await withRunner(async (children, execute) => {
      const run = execute([{ name: "signalled group", args: ["exec", "fixture"] }]);
      const rejection = expect(run).rejects.toThrow("SIGTERM");
      children[0]!.emit("close", null, "SIGTERM");
      await rejection;
    });
  });
});
