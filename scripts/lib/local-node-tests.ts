// Workspace metadata and manifests are bounded native verification inputs.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { constants } from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { lstat, open, realpath } from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { resolve } from "node:path";
import * as Schema from "effect/Schema";
import { parseLocalTypecheckMetadata, readLocalTypecheckMetadata } from "./local-typecheck.ts";
import {
  readLocalVerificationCacheFailure,
  type LocalVerificationCache,
} from "./local-verification-cache.ts";
import { runTestPlan } from "./run-test-plan.ts";
import type { LocalVerificationTask } from "./local-verification-cache-contract.ts";
import {
  prepareLocalNodeVerificationEnvironment,
  prepareLocalVerificationTaskEnvironment,
} from "./local-verification-environment.ts";

const decode = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function manifest(path: string): Promise<Record<string, unknown>> {
  const file = await open(
    path,
    constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK),
  );
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > 1_048_576n)
      throw new Error("Unsupported local test manifest.");
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    const after = await file.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (
      length !== Number(before.size) ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      named.dev !== after.dev ||
      named.ino !== after.ino
    )
      throw new Error("Local test manifest changed during discovery.");
    const value = decode(bytes.subarray(0, length).toString("utf8"));
    if (!record(value)) throw new Error("Unsupported local test manifest.");
    return value;
  } finally {
    await file.close();
  }
}

export interface LocalNodeTestProgram {
  readonly name: string;
  readonly location: string;
}

/** The current Turbo test graph has no task dependencies. Qualify that actual
 * graph before scheduling its independent workspace owners directly; a future
 * ordering contract must be reviewed, never silently flattened. Scripts still
 * run through the original root `yarn test`/Turbo entry, with one exact filter.
 * A script-less workspace is not a passed test task. */
export async function discoverLocalNodeTestPrograms(
  root: string,
  signal: AbortSignal,
  readMetadata = readLocalTypecheckMetadata,
) {
  const turbo = await manifest(resolve(root, "turbo.json"));
  const tasks = turbo.tasks;
  if (
    !record(tasks) ||
    !record(tasks.test) ||
    tasks.test.cache !== false ||
    Object.keys(tasks).some((name) => name.endsWith("#test")) ||
    (tasks.test.dependsOn !== undefined &&
      (!Array.isArray(tasks.test.dependsOn) || tasks.test.dependsOn.length !== 0)) ||
    (tasks.test.with !== undefined &&
      (!Array.isArray(tasks.test.with) || tasks.test.with.length !== 0))
  )
    throw new Error("Unsupported ordered local test graph; run corepack yarn test.");
  const workspaces = parseLocalTypecheckMetadata(await readMetadata(root, signal));
  const programs: LocalNodeTestProgram[] = [];
  for (const workspace of workspaces) {
    if (signal.aborted) throw new Error("Local Node test discovery cancelled.");
    // Turbo reserves ellipses for graph traversal; a package name must never
    // acquire selector semantics or qualify a zero-match command as a pass.
    if (workspace.name.includes("...")) throw new Error("Unsupported local Node test selector.");
    const directory = resolve(root, workspace.location);
    if ((await realpath(directory)) !== directory)
      throw new Error("Unsupported aliased local test workspace.");
    if (workspace.location !== ".") {
      try {
        await lstat(resolve(directory, "turbo.json"));
        throw new Error("Workspace-specific test graphs require canonical corepack yarn test.");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    const data = await manifest(resolve(directory, "package.json"));
    if (data.name !== workspace.name) throw new Error("Unsupported local test workspace metadata.");
    if (data.scripts === undefined && workspace.location !== ".") continue;
    if (!record(data.scripts)) throw new Error("Unsupported local test workspace scripts.");
    if (workspace.location === ".") {
      if (data.scripts.test !== "turbo run test")
        throw new Error("Unsupported root test entry; run corepack yarn test.");
      continue;
    }
    if (data.scripts.test === undefined) continue;
    if (
      typeof data.scripts.test !== "string" ||
      data.scripts.test.length === 0 ||
      data.scripts.test.length > 4096
    )
      throw new Error("Unsupported local test script.");
    programs.push({ name: workspace.name, location: workspace.location });
  }
  if (programs.length === 0) throw new Error("No local workspace test tasks were discovered.");
  return programs;
}

/** Each exact Turbo invocation has one workspace and its original two-worker
 * cap. The outer bounded queue replaces only Turbo's independent-workspace
 * admission, not Vitest file isolation or native ownership. The server and
 * scripts workspaces each hold an exclusive barrier, including cache admission
 * and final rechecks, so their native-heavy work cannot overlap another owner.
 * Its POSIX Codex tail starts only after every complementary owner has closed. */
export async function runLocalNodeTestPrograms(
  root: string,
  programs: readonly LocalNodeTestProgram[],
  concurrency: 1 | 2 | 3,
  signal: AbortSignal,
  cache?: LocalVerificationCache,
  execute = runTestPlan,
) {
  if (![1, 2, 3].includes(concurrency)) throw new Error("Unsupported local Node admission limit.");
  if (programs.some((program) => program.name.includes("...")))
    throw new Error("Unsupported local Node test selector.");
  if (
    programs.length > 256 ||
    new Set(programs.map((program) => program.name)).size !== programs.length
  )
    throw new Error("Duplicate local Node test owner.");
  const reporter = resolve(root, "scripts/lib/test-timing-reporter.ts");
  let next = 0;
  let completed = 0;
  const failures: string[] = [];
  const worker = async (end: number) => {
    while (!signal.aborted && next < end) {
      const program = programs[next++]!;
      const args = [
        "test",
        `--filter=${program.name}`,
        "--concurrency=1",
        "--force",
        "--",
        "--maxWorkers=2",
        "--reporter=default",
        `--reporter=${reporter}`,
      ];
      // Only the cached server lane receives the reviewed fixture-owned Git
      // defaults. Refused/unknown environments retain their original fresh
      // execution; the producer independently checks the exact frozen values.
      // Never rewrite the coordinator's process.env or another workspace.
      const gitEnvironment = prepareLocalNodeVerificationEnvironment(
        root,
        program.location,
        Object.freeze({ ...process.env }),
        cache !== undefined,
      );
      const task: LocalVerificationTask = {
        id: `node:${program.name}`,
        cwd: root,
        args,
        environment: gitEnvironment,
        scope: { kind: "node", workspace: program.location },
      };
      const environment = prepareLocalVerificationTaskEnvironment(task, cache !== undefined);
      const step = { name: `Node tests ${program.name}`, args };
      let executionEntered = false;
      let executionFulfilled = false;
      const run = async () => {
        executionEntered = true;
        await execute([step], { signal, cwd: root, environment });
        executionFulfilled = true;
      };
      try {
        if (cache) {
          const result = await cache.run(
            {
              ...task,
              environment,
            },
            signal,
            run,
          );
          process.stdout.write(`Node tests ${program.name}: ${result.message}\n`);
        } else await run();
        completed += 1;
      } catch (error) {
        // Keep ordinary diagnostics from the remaining discovered workspaces,
        // just as the typecheck queue does; cancellation fences new admission.
        failures.push(program.name);
        // Never inspect/coerce a received error, even when it resembles our
        // class. The private identity lookup projects only finite module-owned
        // fields. Exact callback fulfillment distinguishes a child/transport
        // failure from a later input recheck, without guessing from log timing.
        const failure = readLocalVerificationCacheFailure(error);
        const stage = executionFulfilled
          ? "post-execution"
          : executionEntered
            ? "execution"
            : "admission";
        try {
          process.stderr.write(
            `Node tests ${program.name}: ${stage} failed${failure ? `; cache=${failure.reason}` : "; reason=unclassified"}.\n`,
          );
        } catch {
          // Diagnostic delivery cannot abandon the remaining admitted graph.
        }
      }
    }
  };
  // Preserve discovery order. Drain each contiguous ordinary group before an
  // exclusive owner, and drain that entire owner (including cache rechecks)
  // before admitting any later workspace. Failures do not stop later groups;
  // cancellation fences admission after all already-owned work settles.
  const exclusive = (program: LocalNodeTestProgram) =>
    program.location === "apps/server" || program.location === "scripts";
  while (!signal.aborted && next < programs.length) {
    const start = next;
    let end = start + 1;
    if (!exclusive(programs[start]!)) {
      while (end < programs.length && !exclusive(programs[end]!)) end += 1;
    }
    await Promise.all(
      Array.from({ length: Math.min(concurrency, end - start) }, () => worker(end)),
    );
  }
  if (signal.aborted || failures.length !== 0 || completed !== programs.length)
    throw new Error(
      `Local Node qualification incomplete (${completed}/${programs.length} workspace tasks completed; ${failures.length} failed).`,
    );
  process.stdout.write(
    `Local Node qualification: ${completed}/${programs.length} required workspace tasks qualified (fresh/reused shown above).\n`,
  );
}
