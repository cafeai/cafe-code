// Fixture identities use the same native lexical paths as the executor. The
// one owned Node child below receives only synthetic environment fields, never
// a user profile, runtime hook, provider or inherited credential environment.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join, resolve } from "node:path";
// The exact pinned Node child is retained through native close, including abort.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  localVerificationGitConfiguration,
  localVerificationGitEnvironment,
  localVerificationGitEnvironmentMatches,
  localVerificationRuntimeEnvironmentSupported,
  prepareLocalNodeVerificationEnvironment,
  prepareLocalVerificationTaskEnvironment,
} from "./local-verification-environment.ts";
import type { LocalVerificationTask } from "./local-verification-cache-contract.ts";

const root = resolve(import.meta.dirname, "../..");
const environmentTask = (
  environment: LocalVerificationTask["environment"],
): LocalVerificationTask => ({
  id: "typecheck:fixture-codex",
  cwd: root,
  args: [process.execPath, join(root, "node_modules/typescript/lib/_tsc.js"), "--noEmit"],
  environment,
  scope: {
    kind: "typecheck",
    workspace: "packages/effect-codex-app-server",
    compiler: join(root, "node_modules/typescript/lib/_tsc.js"),
  },
});

describe("local verification controlled native environment", () => {
  it("defines only the fixed Git selectors and preserves the ordinary local-configuration precedence", () => {
    expect(localVerificationGitConfiguration).toBe(
      "[core]\n\tattributesFile = /dev/null\n\texcludesFile = /dev/null\n",
    );
    const expected = {
      GIT_CONFIG_GLOBAL: join(root, "scripts/fixtures/local-verification-git.config"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_TEMPLATE_DIR: join(root, "scripts/fixtures/local-verification-git-template"),
    };
    const environment = localVerificationGitEnvironment(root);
    expect(environment).toEqual(expected);
    expect(Object.isFrozen(environment)).toBe(true);
    expect(localVerificationGitEnvironmentMatches(root, environment)).toBe(true);
    expect(localVerificationGitEnvironmentMatches(root, { ...environment, GIT_PAGER: "cat" })).toBe(
      true,
    );
    expect(localVerificationGitEnvironmentMatches(root, { ...environment, GIT_PAGER: "" })).toBe(
      true,
    );
    expect(
      localVerificationGitEnvironmentMatches(root, {
        ...environment,
        GIT_CONFIG_GLOBAL: "/unqualified-global",
      }),
    ).toBe(false);
    expect(
      localVerificationGitEnvironmentMatches(root, {
        ...environment,
        GIT_TEMPLATE_DIR: "/unqualified-template",
      }),
    ).toBe(false);
    expect(localVerificationGitEnvironmentMatches(root, {})).toBe(false);
  });

  it("admits only simple numeric heap options without loader or shell-hook interpretation", () => {
    for (const NODE_OPTIONS of [
      undefined,
      "",
      "--max-old-space-size=4096",
      "--max-semi-space-size=64",
      "--max-old-space-size=4096 --max-semi-space-size=64",
    ])
      expect(localVerificationRuntimeEnvironmentSupported({ NODE_OPTIONS })).toBe(true);
    for (const NODE_OPTIONS of [
      "--import=./hook.mjs",
      "--require ./hook.cjs",
      "--experimental-loader=./hook.mjs",
      "--max-old-space-size=4096 --import=./hook.mjs",
      "--max-old-space-size=4096\n--max-semi-space-size=64",
      "--max-old-space-size=4096 --max-old-space-size=4096",
      "--max-old-space-size=4096 ",
      " --max-old-space-size=4096",
      "--max-old-space-size=Infinity",
      "--max-old-space-size=-1",
    ])
      expect(localVerificationRuntimeEnvironmentSupported({ NODE_OPTIONS })).toBe(false);
    for (const name of [
      "NODE_PATH",
      "BASH_ENV",
      "ENV",
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "DYLD_INSERT_LIBRARIES",
      "DYLD_LIBRARY_PATH",
      "DYLD_FRAMEWORK_PATH",
    ]) {
      expect(localVerificationRuntimeEnvironmentSupported({ [name]: "unqualified-hook" })).toBe(
        false,
      );
      expect(localVerificationRuntimeEnvironmentSupported({ [name]: "" })).toBe(true);
    }
  });

  it("refuses unknown Git selectors and conflicting fixed values without allowing an arbitrary pager", () => {
    const controlled = localVerificationGitEnvironment(root);
    for (const name of [
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_PARAMETERS",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
      "GIT_EXEC_PATH",
      "GIT_DIR",
      "GIT_COMMON_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_SSH",
      "GIT_SSH_COMMAND",
      "GIT_ASKPASS",
      "GIT_EXTERNAL_DIFF",
      "GIT_ATTR_SOURCE",
      "GIT_FUTURE_SELECTOR",
    ]) {
      expect(
        localVerificationRuntimeEnvironmentSupported({ ...controlled, [name]: "unqualified" }),
      ).toBe(false);
      expect(
        localVerificationGitEnvironmentMatches(root, { ...controlled, [name]: "unqualified" }),
      ).toBe(false);
    }
    expect(localVerificationRuntimeEnvironmentSupported({ GIT_UNKNOWN: undefined })).toBe(false);
    for (const GIT_PAGER of ["less", "cat -n", "$(unqualified)", "cat\n", " cat"])
      expect(localVerificationGitEnvironmentMatches(root, { ...controlled, GIT_PAGER })).toBe(
        false,
      );
    for (const [name, value] of [
      ["GIT_CONFIG_NOSYSTEM", "0"],
      ["GIT_CONFIG_SYSTEM", "/unqualified"],
      ["GIT_ATTR_NOSYSTEM", "0"],
    ] as const)
      expect(localVerificationRuntimeEnvironmentSupported({ ...controlled, [name]: value })).toBe(
        false,
      );
  });

  it("never reads received getters, proxy traps, inherited scalars or opaque values", () => {
    let calls = 0;
    const getter = Object.defineProperty({}, "PRIVATE_ENVIRONMENT", {
      enumerable: true,
      get() {
        calls += 1;
        throw new Error("Opaque getter");
      },
    });
    const proxy = new Proxy(
      {},
      {
        get() {
          calls += 1;
          throw new Error("Opaque value");
        },
        getPrototypeOf() {
          calls += 1;
          throw new Error("Opaque prototype");
        },
        ownKeys() {
          calls += 1;
          throw new Error("Opaque keys");
        },
        getOwnPropertyDescriptor() {
          calls += 1;
          throw new Error("Opaque descriptor");
        },
      },
    );
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const opaque = {
      toString() {
        calls += 1;
        throw new Error("Opaque coercion");
      },
    };
    for (const value of [
      getter,
      proxy,
      revoked.proxy,
      Object.create({ GIT_SSH: "inherited" }),
      { TOKEN: opaque },
      { TOKEN: false },
      { TOKEN: 1 },
      { TOKEN: "nul\u0000value" },
      { [Symbol("opaque")]: "value" },
      Object.defineProperty({}, "TOKEN", { value: "hidden" }),
      null,
      undefined,
      [],
    ]) {
      expect(localVerificationRuntimeEnvironmentSupported(value)).toBe(false);
      expect(localVerificationGitEnvironmentMatches(root, value)).toBe(false);
    }
    for (const value of [getter, proxy, revoked.proxy]) {
      expect(prepareLocalNodeVerificationEnvironment(root, "apps/server", value, true)).toBe(value);
      expect(prepareLocalVerificationTaskEnvironment(environmentTask(value), true, "linux")).toBe(
        value,
      );
    }
    expect(calls).toBe(0);
    const own: Record<string, string> = Object.create(null);
    own.SYNTHETIC_INPUT = "unchanged";
    expect(localVerificationRuntimeEnvironmentSupported(own)).toBe(true);
  });

  it("refuses nonfinite environment inventories without truncating their identity", () => {
    expect(
      localVerificationRuntimeEnvironmentSupported({ TOO_LARGE: "x".repeat(64 * 1024 + 1) }),
    ).toBe(false);
    expect(
      localVerificationRuntimeEnvironmentSupported(
        Object.fromEntries(
          Array.from({ length: 4097 }, (_, index) => [`VALUE_${index}`, "bounded"]),
        ),
      ),
    ).toBe(false);
    expect(
      localVerificationRuntimeEnvironmentSupported(
        Object.fromEntries(
          Array.from({ length: 18 }, (_, index) => [`VALUE_${index}`, "x".repeat(60 * 1024)]),
        ),
      ),
    ).toBe(false);
  });

  it("returns the exact original on disabled, other-workspace or unqualified environments", () => {
    const original = Object.freeze({ SYNTHETIC_INPUT: "unchanged", GIT_PAGER: "cat" });
    expect(prepareLocalNodeVerificationEnvironment(root, "apps/server", original, false)).toBe(
      original,
    );
    expect(prepareLocalNodeVerificationEnvironment(root, "scripts", original, true)).toBe(original);
    expect(prepareLocalNodeVerificationEnvironment(root, "future-workspace", original, true)).toBe(
      original,
    );
    for (const original of [
      { GIT_CONFIG_GLOBAL: "/unqualified" },
      { GIT_TEMPLATE_DIR: "/unqualified" },
      { GIT_CONFIG_NOSYSTEM: "0" },
      { GIT_CONFIG_SYSTEM: "/unqualified" },
      { GIT_ATTR_NOSYSTEM: "0" },
      { GIT_PAGER: "less" },
      { GIT_CONFIG_COUNT: "0" },
      { NODE_OPTIONS: "--import=./hook.mjs" },
    ])
      expect(prepareLocalNodeVerificationEnvironment(root, "apps/server", original, true)).toBe(
        original,
      );
  });

  it("prepares a frozen exact environment clone without mutating the original or unrelated values", () => {
    const original = Object.freeze({
      PATH: "/synthetic/bin",
      SYNTHETIC_INPUT: "unchanged",
      GIT_PAGER: "cat",
      NODE_OPTIONS: "--max-old-space-size=4096",
    });
    const prepared = prepareLocalNodeVerificationEnvironment(root, "apps/server", original, true);
    if (process.platform === "win32") {
      // The cache store/native null-device policy is POSIX-only. Windows keeps
      // its exact original fresh environment, not an unexplained skipped case.
      expect(prepared).toBe(original);
      return;
    }
    expect(prepared).not.toBe(original);
    expect(prepared).toEqual({ ...original, ...localVerificationGitEnvironment(root) });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(localVerificationGitEnvironmentMatches(root, prepared)).toBe(true);
    expect(original).toEqual({
      PATH: "/synthetic/bin",
      SYNTHETIC_INPUT: "unchanged",
      GIT_PAGER: "cat",
      NODE_OPTIONS: "--max-old-space-size=4096",
    });
    const repeated = prepareLocalNodeVerificationEnvironment(root, "apps/server", prepared, true);
    expect(repeated).toEqual(prepared);
    expect(Object.isFrozen(repeated)).toBe(true);
    const partial = prepareLocalNodeVerificationEnvironment(
      root,
      "apps/server",
      { ...original, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: undefined },
      true,
    );
    expect(localVerificationGitEnvironmentMatches(root, partial)).toBe(true);
  });

  it("removes only the exact caller tracing field from an eligible task's actual frozen environment", () => {
    const original = Object.freeze({
      CODEX_TOOL_CALL_ID: "synthetic-caller",
      CODEX_TOOL_CALL_ID_SUFFIX: "unchanged-neighbor",
      SYNTHETIC_INPUT: "unchanged-input",
      NODE_OPTIONS: "--max-old-space-size=4096",
      GIT_PAGER: "cat",
      OPTIONAL_INPUT: undefined,
    });
    const prepared = prepareLocalVerificationTaskEnvironment(
      environmentTask(original),
      true,
      "linux",
    );
    expect(prepared).not.toBe(original);
    expect(prepared).toEqual({
      CODEX_TOOL_CALL_ID_SUFFIX: "unchanged-neighbor",
      SYNTHETIC_INPUT: "unchanged-input",
      NODE_OPTIONS: "--max-old-space-size=4096",
      GIT_PAGER: "cat",
      OPTIONAL_INPUT: undefined,
    });
    expect(Object.hasOwn(prepared, "CODEX_TOOL_CALL_ID")).toBe(false);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(original.CODEX_TOOL_CALL_ID).toBe("synthetic-caller");
    expect(Object.keys(original)).toHaveLength(Object.keys(prepared).length + 1);
    expect(prepareLocalVerificationTaskEnvironment(environmentTask(prepared), true, "linux")).toBe(
      prepared,
    );
  });

  it("preserves exact environments for fresh, ineligible, hosted, Windows and unsupported tasks", () => {
    const original = Object.freeze({
      CODEX_TOOL_CALL_ID: "synthetic-caller",
      SYNTHETIC_INPUT: "same",
    });
    const task = environmentTask(original);
    expect(prepareLocalVerificationTaskEnvironment(task, false, "linux")).toBe(original);
    expect(prepareLocalVerificationTaskEnvironment(task, true, "win32")).toBe(original);
    expect(
      prepareLocalVerificationTaskEnvironment(
        { ...task, scope: { kind: "node", workspace: "scripts" } },
        true,
        "linux",
      ),
    ).toBe(original);
    for (const fields of [
      { CI: "1" },
      { GITHUB_ACTIONS: "true" },
      { NODE_OPTIONS: "--import=./unqualified.mjs" },
      { NODE_PATH: "/synthetic/unqualified" },
      { GIT_CONFIG_COUNT: "1" },
      { GIT_CONFIG_NOSYSTEM: "0" },
      { TOO_LARGE: "x".repeat(64 * 1024 + 1) },
    ]) {
      const unsupported = Object.freeze({ ...original, ...fields });
      expect(
        prepareLocalVerificationTaskEnvironment(environmentTask(unsupported), true, "linux"),
      ).toBe(unsupported);
      expect(unsupported.CODEX_TOOL_CALL_ID).toBe("synthetic-caller");
    }
    for (const fields of [
      { GIT_CONFIG_GLOBAL: join(root, "unqualified-global") },
      { GIT_TEMPLATE_DIR: join(root, "unqualified-template") },
    ]) {
      const unsupported = Object.freeze({
        ...original,
        ...localVerificationGitEnvironment(root),
        ...fields,
      });
      expect(
        prepareLocalVerificationTaskEnvironment(
          { ...environmentTask(unsupported), scope: { kind: "node", workspace: "apps/server" } },
          true,
          "linux",
        ),
      ).toBe(unsupported);
    }
  });

  it.skipIf(process.platform === "win32")(
    "delivers the prepared environment to an exact owned Node child without leaking caller tracing",
    async (context) => {
      let child: ReturnType<typeof spawn> | undefined;
      let closing: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
      let retired = false;
      let closed = false;
      let failed = false;
      let output = "";
      let receivedBytes = 0;
      const retire = () => {
        retired = true;
        if (child && !closed) {
          try {
            child.kill("SIGTERM");
          } catch {
            failed = true;
          }
        }
      };
      context.signal.addEventListener("abort", retire, { once: true });
      context.onTestFinished(async () => {
        retire();
        try {
          if (closing) await closing;
        } finally {
          context.signal.removeEventListener("abort", retire);
        }
      });
      const assertActive = () => {
        if (retired || context.signal.aborted)
          throw new Error("Synthetic environment child retired");
      };
      const original = Object.freeze({
        CODEX_TOOL_CALL_ID: "synthetic-caller",
        CODEX_TOOL_CALL_ID_SUFFIX: "unchanged-neighbor",
        CAFE_CODE_SYNTHETIC_SENTINEL: "unchanged-input",
      });
      const environment = prepareLocalVerificationTaskEnvironment(environmentTask(original), true);
      // Print fixed dispositions only. Received or inherited environment values
      // are never copied into a child receipt, console output or assertion log.
      const program = `const ok = !Object.hasOwn(process.env, "CODEX_TOOL_CALL_ID") && process.env.CODEX_TOOL_CALL_ID_SUFFIX === "unchanged-neighbor" && process.env.CAFE_CODE_SYNTHETIC_SENTINEL === "unchanged-input"; process.stdout.write(ok ? "qualified\\n" : "refused\\n"); process.exitCode = ok ? 0 : 1;`;
      assertActive();
      child = spawn(process.execPath, ["--input-type=commonjs", "--eval", program], {
        cwd: root,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      closing = new Promise((resolve) => {
        child!.once("error", () => {
          failed = true;
        });
        child!.stdout!.on("data", (bytes: Buffer) => {
          receivedBytes += bytes.length;
          if (receivedBytes <= 64) output += bytes.toString("utf8");
          else {
            failed = true;
            retire();
          }
        });
        child!.stderr!.on("data", (bytes: Buffer) => {
          receivedBytes += bytes.length;
          failed = true;
          if (receivedBytes > 64) retire();
        });
        child!.once("close", (code, signal) => {
          closed = true;
          resolve({ code, signal });
        });
      });
      if (context.signal.aborted) retire();
      const result = await closing;
      assertActive();
      expect(result).toEqual({ code: 0, signal: null });
      expect(failed).toBe(false);
      expect(output).toBe("qualified\n");
      expect(original.CODEX_TOOL_CALL_ID).toBe("synthetic-caller");
    },
  );
});
