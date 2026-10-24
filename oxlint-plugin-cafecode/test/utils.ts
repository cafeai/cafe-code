import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, type TestContext } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

class OxlintFixtureFailure extends Data.TaggedError("OxlintFixtureFailure")<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  static readonly is = (u: unknown): u is OxlintFixtureFailure =>
    Predicate.isTagged(u, "OxlintFixtureFailure");
}

class OxlintFixtureExpectedFailure extends Data.TaggedError("OxlintFixtureExpectedFailure")<{
  readonly ruleName: string;
}> {
  override get message() {
    return `Expected oxlint to report a failure for rule ${this.ruleName}, but it passed.`;
  }
}

const encodeOxlintConfig = Schema.encodeEffect(Schema.UnknownFromJsonString);
const encodeOxlintObservation = Schema.encodeSync(Schema.UnknownFromJsonString);
// The harness shells out to oxlint and loads the local plugin entrypoint, which can
// exceed Vitest's default 5s budget on slower CI machines even when the rule passes.
const OXLINT_FIXTURE_TEST_TIMEOUT_MS = process.platform === "win32" ? 30_000 : 10_000;

type FixturePhase =
  | "fixture-entered"
  | "directory-ready"
  | "config-written"
  | "sources-written"
  | "spawn-entered"
  | "spawned"
  | "stdout-first"
  | "stdout-ended"
  | "stderr-first"
  | "stderr-ended"
  | "exit-observed"
  | "command-finalizing"
  | "command-scope-finalized"
  | "fixture-finalized";

interface FixtureObservation {
  readonly mark: (phase: FixturePhase, count?: number, bytes?: number) => void;
  readonly retire: () => void;
}

/** Passive diagnostics do not add readiness, another allowance or input/output
 * content. Retain at most sixteen fixed phases/counts until this exact scoped
 * invocation finishes; an unsuccessful native action keeps its original error.
 */
function observeFixture(context: TestContext): FixtureObservation {
  const started = performance.now();
  let retired = false;
  const phases: { phase: FixturePhase; elapsedMs: number; count: number; bytes: number }[] = [];
  const bounded = (value: number, maximum: number) =>
    Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.floor(value))) : 0;
  const observation: FixtureObservation = {
    mark(phase, count = 0, bytes = 0) {
      try {
        if (retired || phases.length >= 16) return;
        phases.push({
          phase,
          elapsedMs: bounded(performance.now() - started, 60_000),
          count: bounded(count, 1_000_000),
          bytes: bounded(bytes, 64 * 1024 ** 2),
        });
      } catch {
        /* Diagnostics never replace the native/test result. */
      }
    },
    retire() {
      retired = true;
    },
  };
  // Register before the Effect body can allocate a directory or native child.
  // The adapter's owned cancellation/finalizers, not these records, retire IO.
  context.onTestFinished(() => observation.retire());
  context.onTestFailed(() => {
    try {
      process.stderr.write(`Synthetic oxlint fixture phases: ${encodeOxlintObservation(phases)}\n`);
    } catch {
      /* Failure reporting cannot mask the original failure. */
    }
  });
  return observation;
}

interface RuleHarness {
  readonly run: (
    sources: ReadonlyArray<string>,
    observation?: FixtureObservation,
  ) => Effect.Effect<
    string,
    OxlintFixtureFailure | PlatformError.PlatformError | Schema.SchemaError,
    NodeServices.NodeServices
  >;
  readonly runAndExpectFailure: (
    sources: ReadonlyArray<string>,
    observation?: FixtureObservation,
  ) => Effect.Effect<
    string,
    OxlintFixtureExpectedFailure | PlatformError.PlatformError | Schema.SchemaError,
    NodeServices.NodeServices
  >;
  readonly valid: (name: string, sources: ReadonlyArray<string>) => void;
  readonly invalid: (
    name: string,
    sources: ReadonlyArray<string>,
    assertion?: (output: string) => void,
  ) => void;
}

const collectStreamAsString = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  channel: "stdout" | "stderr",
  observation?: FixtureObservation,
): Effect.Effect<string, E> => {
  let chunks = 0;
  let bytes = 0;
  return stream.pipe(
    Stream.tap((chunk) =>
      Effect.sync(() => {
        chunks = Math.min(1_000_000, chunks + 1);
        bytes = Math.min(64 * 1024 ** 2, bytes + chunk.byteLength);
        if (chunks === 1) observation?.mark(`${channel}-first`, chunks, bytes);
      }),
    ),
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
    Effect.tap(() => Effect.sync(() => observation?.mark(`${channel}-ended`, chunks, bytes))),
  );
};

const spawnAndCollectOutput = Effect.fnUntraced(function* (
  command: ChildProcess.Command,
  observation?: FixtureObservation,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  observation?.mark("spawn-entered");
  const child = yield* spawner.spawn(command);
  observation?.mark("spawned");
  // This marker precedes the already-owned child's finalizer. The outer
  // ensuring marker below records only after that complete scope has closed.
  yield* Effect.addFinalizer(() => Effect.sync(() => observation?.mark("command-finalizing")));

  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectStreamAsString(child.stdout, "stdout", observation),
      collectStreamAsString(child.stderr, "stderr", observation),
      child.exitCode.pipe(
        Effect.map(Number),
        Effect.tap(() => Effect.sync(() => observation?.mark("exit-observed"))),
      ),
    ],
    { concurrency: "unbounded" },
  );

  return { exitCode, stdout, stderr };
}, Effect.scoped);

export const createOxlintRuleHarness = (ruleName: string): RuleHarness => {
  const [pluginName, shortRuleName] = ruleName.split("/");
  const diagnosticRuleName =
    pluginName && shortRuleName ? `${pluginName}\\(${shortRuleName}\\)` : ruleName;
  const test = it.layer(NodeServices.layer);

  const run: RuleHarness["run"] = Effect.fnUntraced(function* (
    sources: ReadonlyArray<string>,
    observation?: FixtureObservation,
  ) {
    observation?.mark("fixture-entered");
    // Registered before directory acquisition, so LIFO finalization records
    // completion only after the later directory/native-resource owners retire.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        observation?.mark("fixture-finalized");
        observation?.retire();
      }),
    );
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fixtureDir = yield* fs.makeTempDirectoryScoped({ prefix: "cafecode-oxlint-" });
    observation?.mark("directory-ready");
    const configPath = path.join(fixtureDir, ".oxlintrc.json");
    const sourcePaths = sources.map((_, index) => path.join(fixtureDir, `fixture-${index + 1}.ts`));
    const repoRoot = path.join(import.meta.dirname, "..", "..");
    const oxlintEntrypoint = path.join(repoRoot, "node_modules", "oxlint", "bin", "oxlint");
    const pluginPath = path.join(repoRoot, "oxlint-plugin-cafecode", "index.ts");

    yield* fs.writeFileString(
      configPath,
      yield* encodeOxlintConfig({
        jsPlugins: [{ name: pluginName ?? "cafecode", specifier: pluginPath }],
        rules: { [ruleName]: "error" },
      }),
    );
    observation?.mark("config-written");
    yield* Effect.forEach(
      sources,
      (source, index) => fs.writeFileString(sourcePaths[index]!, source),
      { discard: true },
    );
    observation?.mark("sources-written", sources.length);

    const output = yield* spawnAndCollectOutput(
      // Yarn's Windows `.bin` artifact is a `.cmd` shim and cannot be spawned
      // directly with `shell: false`. Running Oxlint's JavaScript entrypoint
      // through the pinned Node executable is portable and avoids introducing
      // a shell boundary around fixture-controlled paths.
      ChildProcess.make(
        process.execPath,
        [oxlintEntrypoint, "--config", configPath, ...sourcePaths],
        { cwd: repoRoot },
      ),
      observation,
    ).pipe(Effect.ensuring(Effect.sync(() => observation?.mark("command-scope-finalized"))));

    if (output.exitCode !== 0) {
      return yield* new OxlintFixtureFailure({
        exitCode: output.exitCode,
        stdout: output.stdout,
        stderr: output.stderr,
      });
    }

    return `${output.stdout}${output.stderr}`;
  }, Effect.scoped);

  const runAndExpectFailure: RuleHarness["runAndExpectFailure"] = (sources, observation) =>
    run(sources, observation).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          OxlintFixtureFailure.is(error)
            ? Effect.succeed(
                `oxlint fixture failed with exit code ${error.exitCode}\n${error.stdout}\n${error.stderr}`,
              )
            : Effect.fail(error),
        onSuccess: () => Effect.fail(new OxlintFixtureExpectedFailure({ ruleName })),
      }),
    );

  return {
    run,
    runAndExpectFailure,
    valid(name, sources) {
      test(name, (it) => {
        it.effect(
          "passes",
          (context) => run(sources, observeFixture(context)),
          OXLINT_FIXTURE_TEST_TIMEOUT_MS,
        );
      });
    },
    invalid(name, sources, assertion) {
      test(name, (it) => {
        it.effect(
          "reports the rule diagnostic",
          (context) =>
            runAndExpectFailure(sources, observeFixture(context)).pipe(
              Effect.tap((output) =>
                Effect.sync(() => {
                  assert.match(output, new RegExp(diagnosticRuleName));
                  assertion?.(output);
                }),
              ),
            ),
          OXLINT_FIXTURE_TEST_TIMEOUT_MS,
        );
      });
    },
  };
};
