// @effect-diagnostics nodeBuiltinImport:off
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Runtime from "effect/Runtime";
import { afterEach, describe, expect, it } from "vitest";
import { BACKEND_PROFILE_STARTUP_REFUSED_EXIT_CODE } from "@cafecode/shared/backendStartupFailure";

import { BackendProfileGuardError } from "./backendProfileGuard.ts";
import { backendStartupTeardown } from "./backendStartupTeardown.ts";
import { DataProfileSelectionError } from "./cli/config.ts";

function codeFor(exit: Exit.Exit<unknown, unknown>, teardown: Runtime.Teardown): number {
  const codes: number[] = [];
  teardown(exit, (code) => codes.push(code));
  expect(codes).toHaveLength(1);
  return codes[0]!;
}

describe("completed backend startup teardown", () => {
  it("classifies only one actual typed profile/guard refusal", () => {
    for (const error of [
      new BackendProfileGuardError(),
      new DataProfileSelectionError({ message: "Synthetic profile refusal." }),
    ]) {
      expect(codeFor(Exit.fail(error), backendStartupTeardown)).toBe(
        BACKEND_PROFILE_STARTUP_REFUSED_EXIT_CODE,
      );
    }
  });

  it("preserves the native default for ordinary, structural, defect, interrupt and mixed exits", () => {
    const known = new BackendProfileGuardError();
    const custom = new Error("Synthetic explicit exit code.");
    Object.defineProperty(custom, Runtime.errorExitCode, { value: 42 });
    // Cause.combine normalizes equivalent guard errors into one reason. Use
    // distinct actual refusal types to exercise the multiple-failure veto.
    const combinedRefusals = Cause.combine(
      Cause.fail(known),
      Cause.fail(new DataProfileSelectionError({ message: "Synthetic distinct profile refusal." })),
    );
    expect(combinedRefusals.reasons).toHaveLength(2);
    const exits: ReadonlyArray<Exit.Exit<unknown, unknown>> = [
      Exit.succeed(undefined),
      Exit.fail(new Error("Synthetic ordinary failure.")),
      Exit.fail(custom),
      Exit.fail({ _tag: "BackendProfileGuardError", message: known.message }),
      Exit.fail({ _tag: "DataProfileSelectionError", message: "Synthetic profile refusal." }),
      Exit.fail(known.message),
      Exit.die(known),
      Exit.interrupt(123),
      Exit.failCause(Cause.empty),
      Exit.failCause(Cause.combine(Cause.fail(known), Cause.die(new Error("Unrelated defect.")))),
      Exit.failCause(Cause.combine(Cause.fail(known), Cause.interrupt(123))),
      Exit.failCause(combinedRefusals),
    ];
    for (const exit of exits) {
      expect(codeFor(exit, backendStartupTeardown)).toBe(codeFor(exit, Runtime.defaultTeardown));
    }
  });

  it("does not let arbitrary error exit-code metadata impersonate a typed profile refusal", () => {
    const claimed = new Error("Synthetic unrelated reserved-code claim.");
    Object.defineProperty(claimed, Runtime.errorExitCode, {
      value: BACKEND_PROFILE_STARTUP_REFUSED_EXIT_CODE,
    });
    for (const exit of [Exit.fail(claimed), Exit.die(claimed)]) {
      expect(codeFor(exit, Runtime.defaultTeardown)).toBe(
        BACKEND_PROFILE_STARTUP_REFUSED_EXIT_CODE,
      );
      expect(codeFor(exit, backendStartupTeardown)).toBe(1);
    }
  });
});

const peers: ChildProcess[] = [];
const peerPath = fileURLToPath(
  new URL("./testUtils/backendStartupTeardownPeer.ts", import.meta.url),
);
const waitExit = (child: ChildProcess) =>
  child.pid === undefined || child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolve) => child.once("exit", () => resolve()));
afterEach(async () => {
  for (const child of peers.splice(0)) {
    const exited = waitExit(child);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  }
});

describe("native scoped backend teardown", () => {
  for (const [scenario, expectedCode] of [
    ["guard", BACKEND_PROFILE_STARTUP_REFUSED_EXIT_CODE],
    ["profile", BACKEND_PROFILE_STARTUP_REFUSED_EXIT_CODE],
    ["ordinary", 1],
    ["mixed", 1],
    ["finalizer-defect", 1],
    ["interrupt", 130],
    ["success", 0],
  ] as const) {
    it(`drains its actual asynchronous finalizer before ${scenario} exits ${expectedCode}`, async () => {
      const child = spawn(process.execPath, [peerPath, scenario], {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        // No application/provider selectors, credentials, preloads or real
        // profile locations enter this exact test-owned native Node peer.
        env: {
          NODE_OPTIONS: "",
          ELECTRON_RUN_AS_NODE: "1",
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        },
      });
      peers.push(child);
      let output = "";
      let errorOutput = "";
      let outputLimitExceeded = false;
      const collect = (current: string, chunk: Buffer) => {
        if (current.length >= 4096) {
          outputLimitExceeded = true;
          return current;
        }
        const next = current + chunk.toString("utf8");
        if (next.length > 4096) outputLimitExceeded = true;
        return next.slice(0, 4096);
      };
      child.stdout!.on("data", (chunk: Buffer) => {
        output = collect(output, chunk);
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        errorOutput = collect(errorOutput, chunk);
      });
      const observed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code, signal) => resolve({ code, signal }));
        },
      );
      expect(observed.signal).toBeNull();
      expect(observed.code).toBe(expectedCode);
      expect(outputLimitExceeded).toBe(false);
      expect(output).toBe("acquired\nfinalized\n");
      // Native Node experimental/deprecation warnings are not application
      // failure reports and need not be identical across supported hosts.
      expect(errorOutput).not.toContain("Synthetic ");
    });
  }
});
