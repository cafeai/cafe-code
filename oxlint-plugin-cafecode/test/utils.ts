import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
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
const OXLINT_FIXTURE_TEST_TIMEOUT_MS = process.platform === "win32" ? 30_000 : undefined;

interface RuleHarness {
  readonly run: (
    sources: ReadonlyArray<string>,
  ) => Effect.Effect<
    string,
    OxlintFixtureFailure | PlatformError.PlatformError | Schema.SchemaError,
    NodeServices.NodeServices
  >;
  readonly runAndExpectFailure: (
    sources: ReadonlyArray<string>,
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

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const spawnAndCollectOutput = Effect.fnUntraced(function* (command: ChildProcess.Command) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);

  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectStreamAsString(child.stdout),
      collectStreamAsString(child.stderr),
      child.exitCode.pipe(Effect.map(Number)),
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

  const run: RuleHarness["run"] = Effect.fnUntraced(function* (sources: ReadonlyArray<string>) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fixtureDir = yield* fs.makeTempDirectoryScoped({ prefix: "cafecode-oxlint-" });
    const configPath = path.join(fixtureDir, ".oxlintrc.json");
    const sourcePaths = sources.map((_, index) => path.join(fixtureDir, `fixture-${index + 1}.ts`));
    const repoRoot = path.join(import.meta.dirname, "..", "..");
    const oxlintBin = path.join(repoRoot, "node_modules", ".bin", "oxlint");
    const pluginPath = path.join(repoRoot, "oxlint-plugin-cafecode", "index.ts");

    yield* fs.writeFileString(
      configPath,
      yield* encodeOxlintConfig({
        jsPlugins: [{ name: pluginName ?? "cafecode", specifier: pluginPath }],
        rules: { [ruleName]: "error" },
      }),
    );
    yield* Effect.forEach(
      sources,
      (source, index) => fs.writeFileString(sourcePaths[index]!, source),
      { discard: true },
    );

    const output = yield* spawnAndCollectOutput(
      ChildProcess.make(oxlintBin, ["--config", configPath, ...sourcePaths], { cwd: repoRoot }),
    );

    if (output.exitCode !== 0) {
      return yield* new OxlintFixtureFailure({
        exitCode: output.exitCode,
        stdout: output.stdout,
        stderr: output.stderr,
      });
    }

    return `${output.stdout}${output.stderr}`;
  }, Effect.scoped);

  const runAndExpectFailure: RuleHarness["runAndExpectFailure"] = (sources) =>
    run(sources).pipe(
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
        it.effect("passes", () => run(sources), OXLINT_FIXTURE_TEST_TIMEOUT_MS);
      });
    },
    invalid(name, sources, assertion) {
      test(name, (it) => {
        it.effect(
          "reports the rule diagnostic",
          () =>
            runAndExpectFailure(sources).pipe(
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
