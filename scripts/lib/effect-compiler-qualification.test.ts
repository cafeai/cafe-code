// Host-native path spelling must agree with the existing native file and tool boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { tmpdir } from "node:os";
// These owned real-file fixtures qualify descriptor/type/size admission;
// path-only Effect IO cannot supply the alias and sparse-file controls.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { link, lstat, mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  effectCompilerQualificationEnvironment,
  readInstalledEffectCompilerHash,
  validateEffectCompilerApiReport,
  validateEffectCompilerCliResult,
  validateInstalledEffectCompilerHashes,
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
  it("hashes exact owned bytes and refuses aliased or wrong compiler content", async () => {
    const root = await mkdtemp(join(tmpdir(), "cafe-compiler-hash-"));
    try {
      const file = join(root, "compiler.js");
      await writeFile(file, "abc", { flag: "wx", mode: 0o600 });
      const digest = await readInstalledEffectCompilerHash(file);
      expect(digest).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
      expect(() => validateInstalledEffectCompilerHashes(digest, digest)).toThrow(/installation/u);
      const symbolic = join(root, "symbolic.js");
      let hasSymbolic = false;
      try {
        await symlink(file, symbolic);
        hasSymbolic = true;
      } catch (error) {
        // Only Windows' lack of symlink privilege may omit this one alias
        // assertion. The real regular/hash/hardlink/size controls still run.
        expect(process.platform).toBe("win32");
        expect(error).toMatchObject({ code: "EPERM" });
      }
      if (hasSymbolic)
        await expect(readInstalledEffectCompilerHash(symbolic)).rejects.toThrow(/installation/u);
      const hard = join(root, "hard.js");
      await link(file, hard);
      await expect(readInstalledEffectCompilerHash(hard)).rejects.toThrow(/installation/u);
      await expect(readInstalledEffectCompilerHash(file)).rejects.toThrow(/installation/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("refuses oversized sparse and non-regular entries without allocating their declared bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "cafe-compiler-bound-"));
    try {
      const oversized = join(root, "oversized.js");
      const file = await open(oversized, "wx", 0o600);
      try {
        await file.truncate(24 * 1024 * 1024 + 1);
      } finally {
        await file.close();
      }
      await expect(readInstalledEffectCompilerHash(oversized)).rejects.toThrow(/installation/u);
      expect((await lstat(oversized)).size).toBe(24 * 1024 * 1024 + 1);
      const directory = join(root, "not-a-module");
      await mkdir(directory);
      await expect(readInstalledEffectCompilerHash(directory)).rejects.toThrow(/installation/u);
      if (process.platform !== "win32")
        await expect(readInstalledEffectCompilerHash("/dev/null")).rejects.toThrow(/installation/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("rejects plain, stale and partially injected compiler entries before qualification", () => {
    const api = "87c212c214acfe9e416c12b6682d12c373c43272ec26f108db3bfae344d54f50";
    const cli = "f0f0580b611dbbd93a31a07dc97cce7f9cec87a064e53358ff5d9c814528fc6a";
    expect(() => validateInstalledEffectCompilerHashes(api, cli)).not.toThrow();
    for (const [actualApi, actualCli] of [
      ["", cli],
      [api, ""],
      [cli, api],
      ["ee0185011fb281e1cd3b8b4c11971a3e8cd2158b64f7af4431e09bbb142b16cf", cli],
      [api, "5defff9e7ca3ef18d397767acd222c289ebba8a70b4187fad80c2edc4cacf932"],
    ])
      expect(() => validateInstalledEffectCompilerHashes(actualApi!, actualCli!)).toThrow(
        /installation/u,
      );
  });
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
