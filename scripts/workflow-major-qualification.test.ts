import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { REPOSITORY_NODE_VERSION } from "./lib/node-version.ts";

const repoRoot = resolve(import.meta.dirname, "..");
const workflowNames = [
  "ci.yml",
  "issue-labels.yml",
  "pr-size.yml",
  "release.yml",
  "reliability.yml",
];
const qualifiedActionPins: Readonly<Record<string, string>> = {
  "actions/checkout": "3d3c42e5aac5ba805825da76410c181273ba90b1",
  "actions/cache": "55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
  "actions/download-artifact": "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
  "actions/github-script": "3a2844b7e9c422d3c10d287c895573f7108da1b3",
  "actions/setup-node": "820762786026740c76f36085b0efc47a31fe5020",
  "actions/upload-artifact": "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
};

interface Step {
  readonly name?: string;
  readonly uses?: string;
  readonly if?: string;
  readonly run?: string;
  readonly with?: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, string>>;
  readonly "continue-on-error"?: boolean;
  readonly "timeout-minutes"?: number;
}

interface Workflow {
  readonly jobs: Readonly<
    Record<
      string,
      {
        readonly "runs-on"?: string;
        readonly "timeout-minutes"?: number;
        readonly "continue-on-error"?: boolean;
        readonly strategy?: {
          readonly matrix?: {
            readonly os?: ReadonlyArray<string>;
            readonly include?: ReadonlyArray<{ readonly name: string; readonly os: string }>;
          };
        };
        readonly steps?: ReadonlyArray<Step>;
      }
    >
  >;
}

function readWorkflow(name: string): Workflow {
  return parse(readFileSync(resolve(repoRoot, ".github/workflows", name), "utf8")) as Workflow;
}

describe("qualified major Actions and Ubuntu runner boundaries", () => {
  it("uses reviewed immutable Action commits and the canonical exact standalone Node pin", () => {
    const actions = workflowNames.flatMap((name) =>
      Object.values(readWorkflow(name).jobs)
        .flatMap((job) => job.steps ?? [])
        .filter((step) => step.uses?.startsWith("actions/")),
    );
    expect(actions).toHaveLength(34);
    for (const step of actions) {
      const [action, commit] = step.uses!.split("@");
      expect(commit, step.uses).toBe(qualifiedActionPins[action!]);
      expect(commit, step.uses).toMatch(/^[a-f0-9]{40}$/);
      // Checkout 7's guard must stay enabled even on pull_request_target jobs.
      expect(step.with ?? {}, step.uses).not.toHaveProperty("allow-unsafe-pr-checkout");
      if (action === "actions/setup-node") {
        expect(step.with?.["node-version-file"]).toBe(".node-version");
        expect(step.with).not.toHaveProperty("node-version");
        // Resolve the exact checked-in value, not an LTS alias whose meaning
        // could change between qualification and artifact publication.
        expect(
          readFileSync(resolve(repoRoot, String(step.with?.["node-version-file"])), "utf8").trim(),
        ).toBe(REPOSITORY_NODE_VERSION);
      }
    }
    const privilegedCheckout = readWorkflow("pr-size.yml").jobs.label?.steps?.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    // The privileged label job reads PR objects as passive Git data only. Its
    // checkout remains the default trusted base, never a PR-selected ref/repo.
    expect(privilegedCheckout?.with).toEqual({ "fetch-depth": 0 });
  });

  it("keeps the published Linux artifact on Ubuntu 24 while qualifying Ubuntu 26", () => {
    const release = readWorkflow("release.yml");
    expect(
      release.jobs.artifacts?.strategy?.matrix?.include?.find((entry) => entry.name === "linux-x64")
        ?.os,
    ).toBe("ubuntu-24.04");
    const ci = readWorkflow("ci.yml");
    expect(ci.jobs.quality?.strategy?.matrix?.os).toEqual([
      "ubuntu-26.04",
      "windows-2025",
      "macos-15",
    ]);
    expect(ci.jobs["linux-artifact"]?.["runs-on"]).toBe("ubuntu-26.04");
    // No fixed-image job may silently retain an older quality/admin runner.
    for (const name of workflowNames) {
      for (const job of Object.values(readWorkflow(name).jobs)) {
        if (job["runs-on"]?.startsWith("ubuntu-")) expect(job["runs-on"]).toBe("ubuntu-26.04");
      }
    }
  });

  it("bounds only Windows default-suite scheduling without suppressing failures", () => {
    const quality = readWorkflow("ci.yml").jobs.quality!;
    const steps = quality.steps ?? [];
    const defaultTests = steps.filter((step) => step.run === "corepack yarn test");
    const boundedTests = steps.filter(
      (step) => step.run === "corepack yarn test --concurrency=2 -- --maxWorkers=2",
    );
    expect(defaultTests).toHaveLength(1);
    expect(defaultTests[0]!.if).toBe("runner.os != 'Windows'");
    expect(boundedTests).toHaveLength(1);
    expect(boundedTests[0]!.if).toBe("runner.os == 'Windows'");
    expect(boundedTests[0]!.env).toBeUndefined();
    expect(boundedTests[0]!["continue-on-error"]).toBeUndefined();
    expect(boundedTests[0]!["timeout-minutes"]).toBeUndefined();
    expect(quality["timeout-minutes"]).toBe(45);
    expect(quality["continue-on-error"]).toBeUndefined();

    // Turbo forwards the worker option to every default-suite script. Keep
    // that admission bound to direct Vitest commands: a future wrapper or a
    // different test runner needs deliberate review instead of silently
    // receiving an unsupported flag. Do not replace a suite with a filter.
    const workspaceManifests = [
      "apps/desktop/package.json",
      "apps/server/package.json",
      "apps/web/package.json",
      "oxlint-plugin-cafecode/package.json",
      "packages/client-runtime/package.json",
      "packages/contracts/package.json",
      "packages/effect-acp/package.json",
      "packages/effect-codex-app-server/package.json",
      "packages/shared/package.json",
      "scripts/package.json",
    ];
    const rootPackage = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
      scripts: { test: string };
    };
    expect(rootPackage.scripts.test).toBe("turbo run test");
    for (const manifestPath of workspaceManifests) {
      const manifest = JSON.parse(readFileSync(resolve(repoRoot, manifestPath), "utf8")) as {
        scripts: { test: string };
      };
      expect(manifest.scripts.test, manifestPath).toMatch(/^vitest run(?: |$)/);
    }
  });

  it("separates all native Turbo cache keys and restore prefixes by runner image", () => {
    let caches = 0;
    for (const name of workflowNames) {
      for (const job of Object.values(readWorkflow(name).jobs)) {
        for (const step of job.steps ?? []) {
          if (!step.uses?.startsWith("actions/cache@")) continue;
          caches++;
          const image =
            job["runs-on"] === "${{ matrix.os }}" ? "${{ matrix.os }}" : job["runs-on"]!;
          // Turbo restores compiled native helpers as well as JavaScript. Both
          // exact hits and fallback prefixes must keep libc/graphics ABIs apart.
          expect(step.with?.key).toContain(`-${image}-`);
          const prefixes = String(step.with?.["restore-keys"] ?? "")
            .split("\n")
            .filter(Boolean);
          for (const prefix of prefixes) expect(prefix).toContain(`-${image}-`);
        }
      }
    }
    expect(caches).toBe(5);
  });

  it("executes the real Ubuntu helper and bounded private desktop fixture after building", () => {
    const steps = readWorkflow("ci.yml").jobs.quality?.steps ?? [];
    const build = steps.findIndex((step) => step.run === "corepack yarn build:desktop");
    const qualification = steps.findIndex((step) =>
      step.run?.includes("integration/VirtualDesktopFallback.e2e.test.ts"),
    );
    const finalBuild = steps.findIndex(
      (step) => step.run === "corepack yarn build:desktop --force",
    );
    expect(build).toBeGreaterThanOrEqual(0);
    expect(qualification).toBeGreaterThan(build);
    expect(finalBuild).toBeGreaterThan(qualification);
    const step = steps[qualification]!;
    expect(step.if).toBe("runner.os == 'Linux'");
    expect(step["timeout-minutes"]).toBe(5);
    expect(step.env).toEqual({ CAFE_CODE_VIRTUAL_DESKTOP_E2E: "1", DBUS_SESSION_BUS_ADDRESS: "" });
    expect(step.run).toContain("timeout 10s apps/server/dist/cafe-desktop-native --version");
    expect(step.run).toContain(
      "corepack yarn workspace @cafeai/cafe-code exec vitest run --config vitest.e2e.config.ts",
    );
    const runtime = steps.find((candidate) => candidate.run?.includes("sway xwayland dbus-daemon"));
    expect(runtime?.if).toBe("runner.os == 'Linux'");
    expect(runtime?.run).toContain("sudo install -d -m 0700");
  });

  it("qualifies the installed fixed Electron binary on every quality host before application tests", () => {
    const steps = readWorkflow("ci.yml").jobs.quality?.steps ?? [];
    const install = steps.findIndex((step) => step.run === "corepack yarn install --immutable");
    const runtime = steps.findIndex(
      (step) => step.run === "node scripts/qualify-electron-runtime.ts",
    );
    const tests = steps.findIndex((step) => step.run === "corepack yarn test");
    expect(install).toBeGreaterThanOrEqual(0);
    expect(runtime).toBeGreaterThan(install);
    expect(runtime).toBeLessThan(tests);
    // This is a native-runtime check, not a Linux-only policy simulation.
    expect(steps[runtime]!.if).toBeUndefined();
  });
});
