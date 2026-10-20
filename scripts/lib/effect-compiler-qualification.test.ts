import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  effectCompilerQualificationEnvironment,
  validateEffectCompilerApiReport,
  validateEffectCompilerCliResult,
  type CompilerProcessResult,
} from "./effect-compiler-qualification.ts";

// Default tests exercise finite admission and refusal only. The real installed
// API/CLI compilation is performed by the explicit preflight, not repeated in
// every unit worker or substituted with a stub compiler that can pass itself.
const diagnostic = {
  code: 12,
  category: 1,
  source: "effect",
  file: "barrel.mts",
  line: 1,
  column: 10,
  messageMatches: true,
};
const report = { typescriptVersion: "5.9.3", qualified: [diagnostic], ordinary: [] };
const cliOutput =
  "barrel.mts(1,10): error TS12: Importing from barrel module effect is not allowed.    effect(importFromBarrel)\n";
const processResult = (changes: Partial<CompilerProcessResult> = {}): CompilerProcessResult => ({
  code: 1,
  signal: null,
  failure: null,
  stdout: cliOutput,
  stderr: "",
  ...changes,
});

describe("fresh Effect compiler behavior admission", () => {
  it("requires the exact API-owned Effect error and a clean plugin-absent control", () => {
    expect(validateEffectCompilerApiReport(JSON.stringify(report))).toEqual(report);
    for (const changed of [
      { code: 13 },
      { category: 0 },
      { source: "other" },
      { file: "namespace.mts" },
      { file: "foreign" },
      { line: 2 },
      { column: 9 },
      { messageMatches: false },
      { extra: "unqualified metadata" },
    ]) {
      expect(() =>
        validateEffectCompilerApiReport(
          JSON.stringify({ ...report, qualified: [{ ...diagnostic, ...changed }] }),
        ),
      ).toThrow(/during api/u);
    }
    for (const changed of [
      { qualified: [] },
      { qualified: [diagnostic, diagnostic] },
      { ordinary: [diagnostic] },
      { typescriptVersion: "5.8.3" },
      { extra: true },
      { ordinary: null },
    ])
      expect(() =>
        validateEffectCompilerApiReport(JSON.stringify({ ...report, ...changed })),
      ).toThrow(/during api/u);
  });

  it("rejects malformed, noisy and overlarge API output without echoing received data", () => {
    for (const value of [
      "",
      "private fixture cause",
      "null",
      "[]",
      "{}",
      JSON.stringify(report) + "\nnoise",
      "x".repeat(65_537),
    ]) {
      try {
        validateEffectCompilerApiReport(value);
        expect.fail("Invalid output must not qualify the installed compiler");
      } catch (error) {
        expect(String(error)).toContain("during api");
        expect(String(error)).not.toContain("private fixture cause");
      }
    }
  });

  it("requires actual CLI refusal rather than a successful or unrelated compiler failure", () => {
    expect(() => validateEffectCompilerCliResult(processResult(), "qualified")).not.toThrow();
    expect(() =>
      validateEffectCompilerCliResult(
        processResult({ code: 2, stdout: cliOutput.replaceAll("\n", "\r\n") }),
        "qualified",
      ),
    ).not.toThrow();
    for (const changed of [
      { code: 0 },
      { code: null },
      { code: 127 },
      { signal: "SIGINT" },
      { failure: "spawn" as const },
      { failure: "deadline" as const },
      { failure: "cancelled" as const },
      { failure: "output" as const },
      { stdout: "" },
      { stdout: cliOutput.replace("TS12", "TS2307") },
      { stdout: cliOutput.replace("barrel.mts", "namespace.mts") },
      { stdout: cliOutput.replace("(1,10)", "(1,9)") },
      { stdout: cliOutput.replace("effect(importFromBarrel)", "effect(other)") },
      { stdout: cliOutput + cliOutput },
      { stderr: "unrelated error" },
      { stdout: "x".repeat(65_537) },
    ])
      expect(() => validateEffectCompilerCliResult(processResult(changed), "qualified")).toThrow(
        /qualified-cli/u,
      );
  });

  it("requires ordinary TypeScript to accept both source files with no diagnostics", () => {
    const ordinary = processResult({ code: 0, stdout: "" });
    expect(() => validateEffectCompilerCliResult(ordinary, "ordinary")).not.toThrow();
    for (const changed of [
      { code: 1 },
      { stdout: cliOutput },
      { stderr: "noise" },
      { failure: "cancelled" as const },
      { signal: "SIGTERM" },
    ]) {
      expect(() =>
        validateEffectCompilerCliResult({ ...ordinary, ...changed }, "ordinary"),
      ).toThrow(/ordinary-cli/u);
    }
  });
});

describe("isolated compiler environment", () => {
  const fixture = join(tmpdir(), "cafe-owned-compiler-fixture");
  const inherited: NodeJS.ProcessEnv = {
    NODE_OPTIONS: "--import=untrusted",
    NODE_PATH: "untrusted resolver",
    PATH: "provider commands",
    NODE_COMPILE_CACHE: "foreign cached code",
    HOME: "real home",
    USERPROFILE: "real home",
    CODEX_HOME: "provider credentials",
    CLAUDE_CONFIG_DIR: "provider credentials",
    OPENAI_API_KEY: "private token",
    LD_PRELOAD: "foreign library",
    DYLD_INSERT_LIBRARIES: "foreign library",
    SystemRoot: "native system directory",
    WINDIR: "native Windows directory",
  };
  it.each(["linux", "darwin"] as const)(
    "retains only fixed compiler settings on %s",
    (platform) => {
      const environment = effectCompilerQualificationEnvironment(inherited, fixture, platform);
      expect(environment).toEqual({
        HOME: fixture,
        USERPROFILE: fixture,
        APPDATA: fixture,
        LOCALAPPDATA: fixture,
        XDG_CONFIG_HOME: fixture,
        XDG_DATA_HOME: fixture,
        XDG_CACHE_HOME: fixture,
        TMP: fixture,
        TEMP: fixture,
        TMPDIR: fixture,
        NODE_OPTIONS: "--max-old-space-size=4096",
        NODE_DISABLE_COMPILE_CACHE: "1",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      });
      expect(inherited.NODE_OPTIONS).toBe("--import=untrusted");
    },
  );
  it("preserves only native Windows system-directory entries with case-insensitive names", () => {
    const environment = effectCompilerQualificationEnvironment(
      { ...inherited, SystemRoot: undefined, sYsTeMrOoT: "owned system directory" },
      fixture,
      "win32",
    );
    expect(environment.SystemRoot).toBe("owned system directory");
    expect(environment.WINDIR).toBe("native Windows directory");
    for (const name of [
      "PATH",
      "NODE_PATH",
      "NODE_COMPILE_CACHE",
      "CODEX_HOME",
      "OPENAI_API_KEY",
      "LD_PRELOAD",
      "DYLD_INSERT_LIBRARIES",
    ]) {
      expect(environment).not.toHaveProperty(name);
    }
  });
  it("refuses a relative fixture root before it could replace any real home", () => {
    expect(() => effectCompilerQualificationEnvironment(inherited, "relative-root")).toThrow(
      /during fixture/u,
    );
  });
});
