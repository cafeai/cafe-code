import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import { VcsProcessExitError, VcsProcessTimeoutError } from "@cafecode/contracts";
import {
  ProcessRunner,
  ProcessTimeoutError,
  type ProcessRunnerShape,
  type ProcessRunOutput,
} from "../processRunner.ts";
import * as VcsProcess from "./VcsProcess.ts";

const run = (input: VcsProcess.VcsProcessInput) =>
  Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    return yield* process.run(input);
  });

const liveLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));

const provideLive = <A, E, R>(effect: Effect.Effect<A, E, R | VcsProcess.VcsProcess>) =>
  effect.pipe(Effect.provide(liveLayer));

const successfulProcessOutput = (overrides: Partial<ProcessRunOutput> = {}): ProcessRunOutput => ({
  stdout: "",
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  ...overrides,
});

const provideProcessRunner =
  (runner: ProcessRunnerShape) =>
  <A, E, R>(effect: Effect.Effect<A, E, R | VcsProcess.VcsProcess>) =>
    effect.pipe(
      Effect.provide(
        Layer.effect(VcsProcess.VcsProcess, VcsProcess.make()).pipe(
          Layer.provide(Layer.succeed(ProcessRunner, runner)),
        ),
      ),
    );

describe("VcsProcess.run", () => {
  it.effect("wires stdin and stdout through one live subprocess", () =>
    Effect.gen(function* () {
      const result = yield* run({
        operation: "test.stdout",
        command: "node",
        args: [
          "-e",
          [
            "process.stdin.setEncoding('utf8');",
            "let data='';",
            "process.stdin.on('data', chunk => { data += chunk; });",
            "process.stdin.on('end', () => { process.stdout.write(`hello:${data}`); });",
          ].join(""),
        ],
        cwd: process.cwd(),
        stdin: "stdin payload",
      });

      expect(result).toMatchObject({
        stdout: "hello:stdin payload",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      });
    }).pipe(provideLive),
  );

  it.effect("fails with VcsProcessExitError for non-zero exits by default", () =>
    Effect.gen(function* () {
      const error = yield* run({
        operation: "test.exit",
        command: "node",
        args: ["-e", "process.stderr.write('boom'); process.exit(2)"],
        cwd: process.cwd(),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(VcsProcessExitError);
    }).pipe(
      provideProcessRunner({
        run: () =>
          Effect.succeed(
            successfulProcessOutput({
              code: ChildProcessSpawner.ExitCode(2),
              stderr: "boom",
            }),
          ),
      }),
    ),
  );

  it.effect("returns output when non-zero exits are allowed", () =>
    Effect.gen(function* () {
      const result = yield* run({
        operation: "test.allowed-exit",
        command: "node",
        args: ["-e", "process.stderr.write('boom'); process.exit(2)"],
        cwd: process.cwd(),
        allowNonZeroExit: true,
      });

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe("boom");
    }).pipe(
      provideProcessRunner({
        run: () =>
          Effect.succeed(
            successfulProcessOutput({
              code: ChildProcessSpawner.ExitCode(2),
              stderr: "boom",
            }),
          ),
      }),
    ),
  );

  it.effect("truncates output and appends the marker when requested", () =>
    Effect.gen(function* () {
      const result = yield* run({
        operation: "test.truncate-marker",
        command: "node",
        args: ["-e", "process.stdout.write('x'.repeat(2048))"],
        cwd: process.cwd(),
        maxOutputBytes: 128,
        appendTruncationMarker: true,
      });

      expect(result.stdoutTruncated).toBe(true);
      expect(result.stdout).toContain("[truncated]");
      expect(result.stderrTruncated).toBe(false);
    }).pipe(
      provideProcessRunner({
        run: (input) =>
          Effect.sync(() => {
            expect(input.maxOutputBytes).toBe(128);
            expect(input.truncatedMarker).toBe("\n\n[truncated]");
            return successfulProcessOutput({
              stdout: `${"x".repeat(128)}\n\n[truncated]`,
              stdoutTruncated: true,
            });
          }),
      }),
    ),
  );

  it.effect("truncates without the marker when truncation markers are disabled", () =>
    Effect.gen(function* () {
      const result = yield* run({
        operation: "test.truncate-silent",
        command: "node",
        args: ["-e", "process.stdout.write('x'.repeat(2048))"],
        cwd: process.cwd(),
        maxOutputBytes: 128,
      });

      expect(result.stdoutTruncated).toBe(true);
      expect(result.stdout).not.toContain("[truncated]");
    }).pipe(
      provideProcessRunner({
        run: (input) =>
          Effect.sync(() => {
            expect(input.maxOutputBytes).toBe(128);
            expect(input.truncatedMarker).toBe("");
            return successfulProcessOutput({
              stdout: "x".repeat(128),
              stdoutTruncated: true,
            });
          }),
      }),
    ),
  );

  it.effect("fails with VcsProcessTimeoutError on timeout", () =>
    Effect.gen(function* () {
      const error = yield* run({
        operation: "test.timeout",
        command: "node",
        args: ["-e", "setTimeout(() => {}, 5000)"],
        cwd: process.cwd(),
        timeoutMs: 50,
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(VcsProcessTimeoutError);
    }).pipe(
      provideProcessRunner({
        run: (input) =>
          Effect.fail(
            new ProcessTimeoutError({
              command: input.command,
              args: input.args,
              cwd: input.cwd,
              timeoutMs: 50,
            }),
          ),
      }),
    ),
  );
});
