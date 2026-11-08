// Native Git is fully local: exact held children, structured argv and fixture-
// owned configuration qualify environment behavior without a real profile.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { spawn } from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { dirname, join } from "node:path";
import * as Schema from "effect/Schema";
import { describe, expect, it, type TestContext } from "vitest";
import {
  localVerificationGitConfiguration,
  localVerificationGitEnvironment,
  prepareLocalNodeVerificationEnvironment,
} from "./local-verification-environment.ts";

interface GitResult {
  readonly code: number;
  readonly stdout: string;
}

const encode = Schema.encodeSync(Schema.UnknownFromJsonString);

function fixture(context: TestContext, observeCommands = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cafe-local-git-")));
  const home = join(root, "external-home");
  const xdg = join(root, "external-xdg");
  const global = join(home, ".gitconfig");
  const xdgConfig = join(xdg, "git/config");
  const system = join(root, "external-system.gitconfig");
  const attributes = join(xdg, "git/attributes");
  const ignore = join(xdg, "git/ignore");
  const template = join(root, "external-template");
  const hooks = join(root, "external-hooks");
  const hookLog = join(root, "owned-hook-observations");
  const pending: Promise<unknown>[] = [];
  const children = new Set<ReturnType<typeof spawn>>();
  const observations: {
    readonly kind: "init" | "config" | "commit" | "check-attr" | "check-ignore" | "other";
    readonly ordinal: number;
    readonly phase: "launch" | "close";
    readonly elapsedMs: number;
    readonly exit:
      | "pending"
      | "expected"
      | "unexpected"
      | "signal"
      | "transport-failure"
      | "retired";
  }[] = [];
  // Passive native-command timing is not a readiness condition or another
  // allowance. Failed cases retain only finite, fixed-label observations;
  // argv, paths, environment, output and received errors never enter them.
  const startedAt = performance.now();
  let nextCommand = 0;
  const observe = (
    kind: (typeof observations)[number]["kind"],
    ordinal: number,
    phase: "launch" | "close",
    exit: (typeof observations)[number]["exit"],
  ) => {
    if (!observeCommands || observations.length >= 32) return;
    const elapsed = performance.now() - startedAt;
    observations.push({
      kind,
      ordinal,
      phase,
      elapsedMs: Number.isFinite(elapsed)
        ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(elapsed)))
        : 0,
      exit,
    });
  };
  if (observeCommands)
    context.onTestFailed(() => {
      try {
        process.stderr.write(`Synthetic Git command phases: ${encode(observations)}\n`);
      } catch {
        /* Diagnostic delivery never replaces the original native failure. */
      }
    });
  let retired = false;
  const retire = () => {
    retired = true;
    for (const child of children) child.kill("SIGTERM");
  };
  context.signal.addEventListener("abort", retire, { once: true });
  context.onTestFinished(async () => {
    retire();
    await Promise.allSettled(pending);
    context.signal.removeEventListener("abort", retire);
    rmSync(root, { recursive: true, force: true });
  });
  const put = (path: string, bytes: string, mode = 0o600) => {
    if (retired || context.signal.aborted) throw new Error("Synthetic Git fixture retired");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, bytes, { mode });
  };
  for (const path of [
    home,
    join(xdg, "git"),
    template,
    hooks,
    join(root, "scripts/fixtures/local-verification-git-template"),
  ])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  put(
    join(root, "scripts/fixtures/local-verification-git.config"),
    localVerificationGitConfiguration,
  );
  put(join(root, "scripts/fixtures/local-verification-git-template/.gitkeep"), "");
  // No ambient GIT_* selectors, loader hooks or real HOME/XDG configuration
  // enter preparation. Only the same host tool PATH is inherited.
  const original = Object.freeze({
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: xdg,
    LANG: "C",
    LC_ALL: "C",
    CAFE_TEST_HOOK_LOG: hookLog,
  });
  const prepared = prepareLocalNodeVerificationEnvironment(root, "apps/server", original, true);
  expect(prepared).not.toBe(original);
  expect(prepared).toMatchObject(localVerificationGitEnvironment(root));
  // This deliberate baseline uses ONLY the fixture's system/global/XDG files.
  // It is never passed as conflicting input to the preparation API.
  const external = Object.freeze({
    ...original,
    GIT_CONFIG_SYSTEM: system,
    GIT_ATTR_NOSYSTEM: "1",
  });
  const git = (
    args: readonly string[],
    environment: Readonly<NodeJS.ProcessEnv> = prepared,
    cwd = root,
    expectedCode = 0,
  ): Promise<string> => {
    if (retired || context.signal.aborted) throw new Error("Synthetic Git fixture retired");
    const ordinal = ++nextCommand;
    const kind =
      args[0] === "init" ||
      args[0] === "config" ||
      args[0] === "commit" ||
      args[0] === "check-attr" ||
      args[0] === "check-ignore"
        ? args[0]
        : "other";
    observe(kind, ordinal, "launch", "pending");
    const child = spawn("git", args, {
      cwd,
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let stdout = "";
    let bytes = 0;
    let failed = false;
    const collect = (chunk: Buffer, retain: boolean) => {
      bytes += chunk.length;
      if (bytes > 65_536) {
        failed = true;
        child.kill("SIGTERM");
      } else if (retain) stdout += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
    const closed = new Promise<GitResult>((resolve, reject) => {
      child.once("error", () => {
        failed = true;
      });
      child.once("close", (code, signal) => {
        children.delete(child);
        observe(
          kind,
          ordinal,
          "close",
          retired || context.signal.aborted
            ? "retired"
            : failed
              ? "transport-failure"
              : signal !== null
                ? "signal"
                : code === null
                  ? "transport-failure"
                  : code === expectedCode
                    ? "expected"
                    : "unexpected",
        );
        if (failed || retired || context.signal.aborted || signal !== null || code === null)
          reject(new Error("Synthetic Git command did not close normally"));
        else resolve({ code, stdout });
      });
    });
    const result = closed.then((value) => {
      expect(value.code).toBe(expectedCode);
      return value.stdout.trim();
    });
    pending.push(result);
    void result.catch(() => {}); // Original caller retains the actual failure.
    if (context.signal.aborted) child.kill("SIGTERM");
    return result;
  };
  const initRepository = async (name: string, environment = prepared) => {
    const path = join(root, name);
    await git(["init", path], environment);
    return path;
  };
  const repository = async (name: string, environment = prepared) => {
    const path = await initRepository(name, environment);
    // Only commit fixtures need an identity. Query/template fixtures retain
    // actual native initialization without unrelated configuration children.
    await git(["config", "user.name", "Synthetic Verification"], environment, path);
    await git(["config", "user.email", "synthetic@example.invalid"], environment, path);
    return path;
  };
  return {
    root,
    home,
    xdg,
    global,
    xdgConfig,
    system,
    attributes,
    ignore,
    template,
    hooks,
    hookLog,
    prepared,
    external,
    put,
    git,
    initRepository,
    repository,
  };
}

// Windows uses the original environment: POSIX /dev/null, mode and /bin/sh
// controls here do not borrow authority for an unqualified Windows equivalent.
describe.skipIf(process.platform === "win32")("native local-verification Git environment", () => {
  // Configuration lookup and repository attributes/ignore lookup are separate
  // contracts. Each now owns its default deadline and private namespace; the
  // aggregate allowance increases without extending or retrying either case.
  it("isolates mutable external config selectors while preserving explicit per-case overrides", async (context) => {
    const f = fixture(context, true);
    const changeExternal = (suffix: string) => {
      f.put(f.global, `[verification]\n\thome = home-${suffix}\n`);
      f.put(f.xdgConfig, `[verification]\n\txdg = xdg-${suffix}\n`);
      f.put(f.system, `[verification]\n\tsystem = system-${suffix}\n`);
    };
    changeExternal("before");
    for (const suffix of ["before", "after"]) {
      if (suffix === "after") changeExternal(suffix);
      const baseline = (await f.git(["config", "--get-regexp", "^verification\\."], f.external))
        .split("\n")
        .sort();
      expect(baseline).toEqual([
        `verification.home home-${suffix}`,
        `verification.system system-${suffix}`,
        `verification.xdg xdg-${suffix}`,
      ]);
      expect(
        await f.git(["config", "--get-regexp", "^verification\\."], f.prepared, f.root, 1),
      ).toBe("");
    }
    const explicit = { ...f.prepared, GIT_CONFIG_GLOBAL: f.global };
    expect(await f.git(["config", "--get", "verification.home"], explicit)).toBe("home-after");
  });

  it("isolates mutable default attributes and ignore files", async (context) => {
    const f = fixture(context, true);
    f.put(f.global, "# fixture-owned empty global configuration\n");
    f.put(f.xdgConfig, "# fixture-owned empty XDG configuration\n");
    f.put(f.system, "# fixture-owned empty system configuration\n");
    const changeExternal = (suffix: string) => {
      f.put(f.attributes, `*.txt verification-attribute=external-${suffix}\n`);
      f.put(f.ignore, `external-${suffix}.tmp\n`);
    };
    changeExternal("before");
    const repo = await f.initRepository("attribute-repository");
    f.put(join(repo, "payload.txt"), "inert bytes\n");
    for (const suffix of ["before", "after"]) {
      if (suffix === "after") changeExternal(suffix);
      expect(
        await f.git(
          ["check-attr", "verification-attribute", "--", "payload.txt"],
          f.external,
          repo,
        ),
      ).toBe(`payload.txt: verification-attribute: external-${suffix}`);
      expect(
        await f.git(
          ["check-attr", "verification-attribute", "--", "payload.txt"],
          f.prepared,
          repo,
        ),
      ).toBe("payload.txt: verification-attribute: unspecified");
      expect(await f.git(["check-ignore", `external-${suffix}.tmp`], f.external, repo)).toBe(
        `external-${suffix}.tmp`,
      );
      expect(await f.git(["check-ignore", `external-${suffix}.tmp`], f.prepared, repo, 1)).toBe("");
    }
  });

  // Template selection and hook execution are independent native contracts.
  // Separate private fixtures increase the aggregate case allowance, while
  // each unchanged default deadline and every non-retried assertion remain.
  it("isolates changing external templates while preserving explicit templates", async (context) => {
    const f = fixture(context, true);
    const configPath = (path: string) => path.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    f.put(f.global, `[init]\n\ttemplateDir = "${configPath(f.template)}"\n`);
    f.put(f.xdgConfig, "# fixture-owned empty XDG configuration\n");
    f.put(f.system, "# fixture-owned empty system configuration\n");
    f.put(join(f.template, "external-template-marker"), "template-before\n");
    const baseline = await f.initRepository("baseline-repository", f.external);
    expect(readFileSync(join(baseline, ".git/external-template-marker"), "utf8")).toBe(
      "template-before\n",
    );
    f.put(join(f.template, "external-template-marker"), "template-after\n");
    const changedBaseline = join(f.root, "changed-baseline-repository");
    await f.git(["init", changedBaseline], f.external);
    expect(readFileSync(join(changedBaseline, ".git/external-template-marker"), "utf8")).toBe(
      "template-after\n",
    );
    const isolated = await f.initRepository("isolated-repository");
    expect(existsSync(join(isolated, ".git/external-template-marker"))).toBe(false);
    expect(existsSync(join(isolated, ".git/.gitkeep"))).toBe(false);
    const explicit = join(f.root, "explicit-template");
    f.put(join(explicit, "explicit-template-marker"), "deliberately selected\n");
    const explicitRepository = join(f.root, "explicit-template-repository");
    await f.git(["init", `--template=${explicit}`, explicitRepository]);
    expect(readFileSync(join(explicitRepository, ".git/explicit-template-marker"), "utf8")).toBe(
      "deliberately selected\n",
    );
  });

  it("isolates changing external hooks while preserving a real repository hook", async (context) => {
    const f = fixture(context, true);
    const configPath = (path: string) => path.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    f.put(f.global, `[core]\n\thooksPath = "${configPath(f.hooks)}"\n`);
    f.put(f.xdgConfig, "# fixture-owned empty XDG configuration\n");
    f.put(f.system, "# fixture-owned empty system configuration\n");
    const hook = (label: string) =>
      `#!/bin/sh\nprintf '%s\\n' '${label}' >> "$CAFE_TEST_HOOK_LOG"\n`;
    f.put(join(f.hooks, "pre-commit"), hook("external-before"), 0o700);
    const baseline = await f.repository("baseline-repository", f.external);
    await f.git(["commit", "--allow-empty", "-m", "synthetic baseline"], f.external, baseline);
    expect(readFileSync(f.hookLog, "utf8")).toBe("external-before\n");
    f.put(join(f.hooks, "pre-commit"), hook("external-after"), 0o700);
    await f.git(
      ["commit", "--allow-empty", "-m", "synthetic changed baseline"],
      f.external,
      baseline,
    );
    expect(readFileSync(f.hookLog, "utf8")).toBe("external-before\nexternal-after\n");
    const isolated = await f.repository("isolated-repository");
    await f.git(["commit", "--allow-empty", "-m", "synthetic isolated"], f.prepared, isolated);
    expect(readFileSync(f.hookLog, "utf8")).toBe("external-before\nexternal-after\n");
    f.put(join(isolated, ".git/hooks/pre-commit"), hook("repository-local"), 0o700);
    await f.git(["commit", "--allow-empty", "-m", "synthetic local hook"], f.prepared, isolated);
    expect(readFileSync(f.hookLog, "utf8")).toBe(
      "external-before\nexternal-after\nrepository-local\n",
    );
  });

  it("retains deliberate repository-local configuration, attributes and ignore policy", async (context) => {
    const f = fixture(context);
    const repo = await f.initRepository("local-policy-repository");
    await f.git(["config", "verification.local", "repository-value"], f.prepared, repo);
    f.put(join(repo, ".gitattributes"), "*.txt verification-attribute=repository-value\n");
    f.put(join(repo, ".gitignore"), "repository-only.tmp\n");
    f.put(join(repo, "payload.txt"), "inert bytes\n");
    expect(
      await f.git(["config", "--local", "--get", "verification.local"], f.prepared, repo),
    ).toBe("repository-value");
    expect(
      await f.git(["check-attr", "verification-attribute", "--", "payload.txt"], f.prepared, repo),
    ).toBe("payload.txt: verification-attribute: repository-value");
    expect(await f.git(["check-ignore", "repository-only.tmp"], f.prepared, repo)).toBe(
      "repository-only.tmp",
    );
    expect(await f.git(["check-ignore", "not-ignored.tmp"], f.prepared, repo, 1)).toBe("");

    // The controlled global /dev/null defaults must not become forced -c
    // settings: an explicit repository-local file selection still wins.
    const selectedAttributes = join(f.root, "selected-local-attributes");
    const selectedIgnore = join(f.root, "selected-local-ignore");
    f.put(selectedAttributes, "*.bin selected-attribute=local-config\n");
    f.put(selectedIgnore, "selected-local-config.tmp\n");
    f.put(join(repo, "payload.bin"), "inert selected bytes\n");
    await f.git(["config", "core.attributesFile", selectedAttributes], f.prepared, repo);
    await f.git(["config", "core.excludesFile", selectedIgnore], f.prepared, repo);
    expect(
      await f.git(["check-attr", "selected-attribute", "--", "payload.bin"], f.prepared, repo),
    ).toBe("payload.bin: selected-attribute: local-config");
    expect(await f.git(["check-ignore", "selected-local-config.tmp"], f.prepared, repo)).toBe(
      "selected-local-config.tmp",
    );
  });
});
