import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

type JsonObject = Record<string, unknown>;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const readJson = (relativePath: string): JsonObject =>
  JSON.parse(readFileSync(resolve(repoRoot, relativePath), "utf8")) as JsonObject;

const asObject = (value: unknown, label: string): JsonObject => {
  expect(value, `${label} must be an object`).toBeTypeOf("object");
  expect(value, `${label} must not be an array`).not.toBeInstanceOf(Array);
  expect(value, `${label} must not be null`).not.toBeNull();
  return value as JsonObject;
};

const asStringArray = (value: unknown, label: string): ReadonlyArray<string> => {
  expect(value, `${label} must be an array`).toBeInstanceOf(Array);
  expect(value, `${label} must contain only strings`).toSatisfy(
    (items: unknown) => Array.isArray(items) && items.every((item) => typeof item === "string"),
  );
  return value as ReadonlyArray<string>;
};

const sorted = (values: ReadonlyArray<string>): ReadonlyArray<string> => values.toSorted();

const hasExactStringSet = (value: unknown, expected: ReadonlyArray<string>): boolean => {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string") &&
    JSON.stringify(sorted(value)) === JSON.stringify(sorted(expected))
  );
};

const packageRulesFrom = (config: JsonObject): ReadonlyArray<JsonObject> => {
  expect(config.packageRules).toBeInstanceOf(Array);
  return (config.packageRules as ReadonlyArray<unknown>).map((rule, index) =>
    asObject(rule, `packageRules[${index}]`),
  );
};

/**
 * Select a rule by the literal shape of one of its match fields. This helper
 * intentionally does not try to reproduce Renovate's glob/regex matcher. A
 * home-grown partial matcher would make these tests appear stronger than they
 * are and could silently disagree with Renovate after an upstream change.
 */
const singleRuleWithExactSet = (
  rules: ReadonlyArray<JsonObject>,
  field:
    | "matchDepNames"
    | "matchDepTypes"
    | "matchManagers"
    | "matchPackageNames"
    | "matchUpdateTypes",
  values: ReadonlyArray<string>,
): JsonObject => {
  const matches = rules.filter((rule) => hasExactStringSet(rule[field], values));
  expect(matches, `one rule must use ${field}=${JSON.stringify(values)}`).toHaveLength(1);
  return matches[0]!;
};

const objectEntriesDeep = (
  value: unknown,
  path = "$",
): ReadonlyArray<{ readonly key: string; readonly path: string; readonly value: unknown }> => {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => objectEntriesDeep(item, `${path}[${index}]`));
  }
  if (value === null || typeof value !== "object") return [];

  const entries: Array<{ readonly key: string; readonly path: string; readonly value: unknown }> =
    [];
  for (const [key, child] of Object.entries(value as JsonObject)) {
    const childPath = `${path}.${key}`;
    entries.push({ key, path: childPath, value: child });
    entries.push(...objectEntriesDeep(child, childPath));
  }
  return entries;
};

describe("Renovate repository policy", () => {
  const config = readJson(".github/renovate.json");
  const packageRules = packageRulesFrom(config);

  it("targets dev with an explicit manager allowlist", () => {
    expect(config.$schema).toBe("https://docs.renovatebot.com/renovate-schema.json");
    expect(config.baseBranchPatterns).toEqual(["dev"]);
    expect(config.enabledManagers).toEqual(["npm", "github-actions"]);

    // The repository policy deliberately does not extend any presets itself.
    // Renovate's hosted/global inherited policy is outside this local JSON and
    // must be audited separately when the installed app or account changes.
    expect(config).not.toHaveProperty("extends");
    expect(config).not.toHaveProperty("baseBranches");

    const allowedManagers = new Set(asStringArray(config.enabledManagers, "enabledManagers"));
    for (const [index, rule] of packageRules.entries()) {
      if (rule.matchManagers === undefined) continue;
      for (const manager of asStringArray(
        rule.matchManagers,
        `packageRules[${index}].matchManagers`,
      )) {
        expect(allowedManagers.has(manager), `packageRules[${index}] enables ${manager}`).toBe(
          true,
        );
      }
    }
  });

  it("cannot run package scripts, custom commands, or repository-owned remote credentials", () => {
    expect(config.ignoreScripts).toBe(true);

    const forbiddenKeys = new Set([
      "allowedCommands",
      "allowedEnv",
      "allowedHeaders",
      "customManagers",
      "encrypted",
      "endpoint",
      "env",
      "exposeAllEnv",
      "gitPrivateKey",
      "githubToken",
      "headers",
      "hostRules",
      "npmrc",
      "npmToken",
      "password",
      "postUpgradeTasks",
      "regexManagers",
      "repositories",
      "repository",
      "token",
      "username",
    ]);
    const forbiddenPaths = objectEntriesDeep(config)
      .filter(({ key }) => forbiddenKeys.has(key))
      .map(({ path }) => path);
    expect(forbiddenPaths).toEqual([]);

    // A package rule must not weaken the top-level script or merge policy.
    const unsafeOverrides = objectEntriesDeep(packageRules)
      .filter(
        ({ key, value }) =>
          (key === "ignoreScripts" && value !== true) ||
          ((key === "automerge" || key === "platformAutomerge") && value === true),
      )
      .map(({ path }) => path);
    expect(unsafeOverrides).toEqual([]);
    expect(config.automerge).toBe(false);
    expect(config.platformAutomerge).toBe(false);
  });

  it("bounds routine pull requests to a weekly, timestamp-gated window", () => {
    expect(config.timezone).toBe("Asia/Tokyo");
    expect(config.schedule).toEqual(["* 0-6 * * 1"]);
    expect(config.minimumReleaseAge).toBe("7 days");
    expect(config.minimumReleaseAgeBehaviour).toBe("timestamp-required");
    expect(config.internalChecksFilter).toBe("strict");

    expect(config.prConcurrentLimit).toBeGreaterThan(0);
    expect(config.prConcurrentLimit).toBeLessThanOrEqual(3);
    expect(config.branchConcurrentLimit).toBeGreaterThan(0);
    expect(config.branchConcurrentLimit).toBeLessThanOrEqual(3);
    expect(config.prHourlyLimit).toBeGreaterThan(0);
    expect(config.prHourlyLimit).toBeLessThanOrEqual(1);
  });

  it("disables the vulnerability-alert force block so it cannot bypass exclusions", () => {
    const alerts = asObject(config.vulnerabilityAlerts, "vulnerabilityAlerts");
    expect(alerts).toEqual({ enabled: false });
  });

  it("keeps resolution overrides and lockfile maintenance on the manual path", () => {
    expect(config.lockFileMaintenance).toEqual({ enabled: false });

    const resolutionRule = singleRuleWithExactSet(packageRules, "matchDepTypes", ["resolutions"]);
    expect(resolutionRule.matchManagers).toEqual(["npm"]);
    expect(resolutionRule.enabled).toBe(false);

    // This proves the disabled rule protects a real, actively maintained
    // security/compatibility surface rather than a currently empty dep type.
    const resolutions = asObject(readJson("package.json").resolutions, "package.json resolutions");
    expect(Object.keys(resolutions).length).toBeGreaterThan(0);
  });

  it("preserves the deliberate Effect, provider, native, and toolchain exclusions", () => {
    const effectPackages = ["effect", "@effect/**"];
    const providerPackages = [
      "@anthropic-ai/**",
      "@openai/codex",
      "@openai/codex-*",
      "@modelcontextprotocol/**",
      "@opencode-ai/**",
      "openai",
    ];
    const nativePackages = [
      "electron",
      "electron-builder",
      "electron-updater",
      "@electron/**",
      "app-builder-lib",
      "node-pty",
      "playwright",
      "playwright-core",
      "@playwright/**",
    ];

    for (const packages of [effectPackages, providerPackages, nativePackages]) {
      const rule = singleRuleWithExactSet(packageRules, "matchPackageNames", packages);
      expect(rule.matchManagers).toEqual(["npm"]);
      expect(rule.enabled).toBe(false);
    }

    const toolchainRule = singleRuleWithExactSet(packageRules, "matchDepNames", ["node", "yarn"]);
    expect(toolchainRule.enabled).toBe(false);

    const rootPackage = readJson("package.json");
    const dependenciesMeta = asObject(
      rootPackage.dependenciesMeta,
      "package.json dependenciesMeta",
    );
    const packagesWithBuildScripts = Object.entries(dependenciesMeta)
      .filter(([, metadata]) => asObject(metadata, "dependenciesMeta entry").built === true)
      .map(([name]) => name)
      .toSorted();

    // Build-enabled dependencies execute native installation code. They must
    // remain literal members of the audited native set; wildcard inference is
    // deliberately avoided here.
    expect(packagesWithBuildScripts).toEqual(["electron", "node-pty"]);
    for (const packageName of packagesWithBuildScripts) {
      expect(nativePackages).toContain(packageName);
    }
  });

  it("accounts for every checked-in provider SDK dependency", () => {
    const providerSdkNames = [
      "@anthropic-ai/claude-agent-sdk",
      "@anthropic-ai/sdk",
      "@modelcontextprotocol/sdk",
      "@opencode-ai/sdk",
    ];
    const serverDependencies = asObject(
      readJson("apps/server/package.json").dependencies,
      "server dependencies",
    );
    const stagedDependencies = asObject(
      readJson("packaging/desktop-runtime/package.json").dependencies,
      "staged dependencies",
    );
    const scriptDependencies = asObject(
      readJson("scripts/package.json").dependencies,
      "scripts dependencies",
    );

    for (const packageName of providerSdkNames) {
      expect(serverDependencies[packageName], `server ${packageName}`).toBeTypeOf("string");
      expect(stagedDependencies[packageName], `staged ${packageName}`).toBe(
        serverDependencies[packageName],
      );
    }
    for (const packageName of providerSdkNames.filter((name) => name !== "@opencode-ai/sdk")) {
      expect(scriptDependencies[packageName], `scripts ${packageName}`).toBe(
        serverDependencies[packageName],
      );
    }

    // Keep the provider exclusion literal and reviewable. We verify its exact
    // configured patterns rather than attempting to imitate Renovate matching.
    const providerRule = singleRuleWithExactSet(packageRules, "matchPackageNames", [
      "@anthropic-ai/**",
      "@openai/codex",
      "@openai/codex-*",
      "@modelcontextprotocol/**",
      "@opencode-ai/**",
      "openai",
    ]);
    expect(providerRule.enabled).toBe(false);
  });

  it("requires approval for majors and digest-pins GitHub Actions", () => {
    const majorRule = singleRuleWithExactSet(packageRules, "matchUpdateTypes", ["major"]);
    expect(majorRule.dependencyDashboardApproval).toBe(true);
    expect(majorRule).not.toHaveProperty("enabled", true);

    const actionsRule = singleRuleWithExactSet(packageRules, "matchManagers", ["github-actions"]);
    expect(actionsRule.groupName).toBe("GitHub Actions");
    expect(actionsRule.pinDigests).toBe(true);
    expect(actionsRule.minimumReleaseAge).toBeNull();
    expect(actionsRule).not.toHaveProperty("automerge", true);
    expect(actionsRule).not.toHaveProperty("platformAutomerge", true);
  });

  it("rejects package rules that can re-enable an excluded dependency", () => {
    // Renovate merges all matching rules in declaration order. Forbidding
    // `enabled: true` throughout the local rule list prevents a later broad
    // rule from undoing one of the manual exclusions above. Renovate applies
    // its vulnerability-alert force block after package rules, so the separate
    // exact-disabled assertion above is also required for this guarantee.
    const reEnableRules = packageRules
      .map((rule, index) => ({ index, rule }))
      .filter(({ rule }) => rule.enabled === true)
      .map(({ index }) => index);
    expect(reEnableRules).toEqual([]);
  });
});
