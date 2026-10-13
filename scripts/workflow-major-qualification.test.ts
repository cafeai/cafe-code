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
  readonly env?: Readonly<Record<string, string>>;
  readonly jobs: Readonly<
    Record<
      string,
      {
        readonly "runs-on"?: string;
        readonly "timeout-minutes"?: number;
        readonly "continue-on-error"?: boolean;
        readonly env?: Readonly<Record<string, string>>;
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
    // The Desk and visualization/Mermaid failure-only synthetic uploads reuse
    // the independently reviewed artifact Action. Keep the exact total and
    // qualify both publication boundaries below, not arbitrary new steps.
    expect(actions).toHaveLength(36);
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

  it("retains only the synthetic Desk fixture attachments after a quality failure", () => {
    const steps = readWorkflow("ci.yml").jobs.quality?.steps ?? [];
    const retention = steps.filter(
      (step) => step.name === "Retain synthetic Desk sidebar failure artifacts",
    );
    expect(retention).toHaveLength(1);
    // Hidden-file admission is safe only for this fixed synthetic-only folder.
    // An exact step assertion prevents broad globs, successful-run uploads,
    // longer retention, mutable Action references, or new execution overrides
    // from riding along with this narrowly reviewed diagnostic publication.
    expect(retention[0]).toEqual({
      name: "Retain synthetic Desk sidebar failure artifacts",
      if: "failure()",
      uses: `actions/upload-artifact@${qualifiedActionPins["actions/upload-artifact"]}`,
      with: {
        name: "desk-sidebar-failure-${{ matrix.os }}-${{ github.run_attempt }}",
        path: "apps/web/.vitest/attachments/failure-screenshots/DeskSidebar.browser.tsx/",
        "include-hidden-files": true,
        "if-no-files-found": "ignore",
        "retention-days": 7,
      },
    });
  });

  it("retains only the nine reviewed synthetic visualization and Mermaid failure paths", () => {
    const steps = readWorkflow("ci.yml").jobs.quality?.steps ?? [];
    const retention = steps.filter(
      (step) => step.name === "Retain synthetic visualization and Mermaid failure evidence",
    );
    expect(retention).toHaveLength(1);
    // Literal block equality preserves exactly nine paths, including their
    // fixture-specific hidden directories. No profile/source/JSON/temp-tree
    // glob, successful-run upload, override or longer retention is admitted.
    const paths = [
      "apps/web/.vitest/attachments/failure-screenshots/VisualizationCommitChart.browser.tsx/",
      "apps/web/.vitest/attachments/failure-screenshots/MermaidFamilies.browser.tsx/",
      "apps/web/.vitest/attachments/failure-screenshots/MermaidSecurity.browser.tsx/",
      "apps/web/.vitest/attachments/failure-screenshots/Visualizations.browser.tsx/",
      "apps/web/.vitest/attachments/failure-screenshots/VisualizationFluid.browser.tsx/",
      "apps/web/.vitest/attachments/failure-screenshots/VisualizationHistory.browser.tsx/",
      "apps/web/.vitest/attachments/failure-screenshots/VisualizationOwner.browser.tsx/",
      "apps/web/.vitest/attachments/failure-screenshots/InlineMcpAppBridge.browser.tsx/",
      "apps/web/.vitest/attachments/failure-screenshots/VisualizationInlineCapture.browser.tsx/",
    ];
    expect(retention[0]).toEqual({
      name: "Retain synthetic visualization and Mermaid failure evidence",
      if: "failure()",
      uses: `actions/upload-artifact@${qualifiedActionPins["actions/upload-artifact"]}`,
      with: {
        name: "visualization-qualification-failure-${{ matrix.os }}-${{ github.run_attempt }}",
        path: `${paths.join("\n")}\n`,
        "include-hidden-files": true,
        "if-no-files-found": "ignore",
        "retention-days": 7,
      },
    });
  });

  it("binds current inline browser qualification without retired execution lanes or private replay", () => {
    const workflow = readWorkflow("ci.yml");
    const quality = workflow.jobs.quality!;
    const steps = quality.steps ?? [];
    const inline = {
      name: "Full-access inline visualization browser qualification",
      if: "runner.os != 'Linux'",
      run: "corepack yarn workspace @cafecode/web test:browser src/components/visualizations/VisualizationHistory.browser.tsx src/components/visualizations/VisualizationOwner.browser.tsx src/components/visualizations/InlineMcpAppBridge.browser.tsx src/components/visualizations/VisualizationInlineCapture.browser.tsx --maxWorkers=2",
    };
    // The approved execution path is an ordinary browser frame. Whole-step
    // equality preserves its exact fixtures/two workers with no per-step
    // deadline, environment override or failure bypass; it is not native-host
    // isolation evidence. Linux retains the complete browser suite instead.
    expect(steps.filter((step) => step.name === inline.name)).toEqual([inline]);
    expect(steps.filter((step) => step.name === "Browser tests")).toEqual([
      {
        name: "Browser tests",
        if: "runner.os == 'Linux'",
        run: "corepack yarn workspace @cafecode/web test:browser",
      },
    ]);

    const shared = steps.filter(
      (step) =>
        step.name === "Cross-platform Markdown, timeline, menus and file action browser tests",
    );
    expect(shared).toHaveLength(1);
    expect(shared[0]!.if).toBe("runner.os != 'Linux'");
    const sharedArguments = shared[0]!.run!.split(/\s+/);
    expect(sharedArguments.slice(0, 5)).toEqual([
      "corepack",
      "yarn",
      "workspace",
      "@cafecode/web",
      "test:browser",
    ]);
    expect(sharedArguments.slice(5, -1)).toEqual(
      expect.arrayContaining([
        "src/components/WorkspaceEnvironment.browser.tsx",
        "src/components/visualizations/Visualizations.browser.tsx",
        "src/components/visualizations/VisualizationFluid.browser.tsx",
        "src/components/visualizations/Visualizations.motion.browser.tsx",
      ]),
    );
    // The real fixed-font, WebGL/fluid and reduced-motion fixtures run in the
    // inherited native browser projects. Only literal component file selectors
    // may precede the unchanged worker cap: no retry/deadline/input CLI override.
    for (const argument of sharedArguments.slice(5, -1))
      expect(argument).toMatch(/^src\/components\/[^\s]+\.browser\.tsx$/);
    expect(sharedArguments.at(-1)).toBe("--maxWorkers=2");
    // Keyboard popup readiness also requires native qualification on the
    // other hosts. Preserve the complete file exactly once in this same
    // subset; Linux still owns its unchanged complete suite.
    expect(
      sharedArguments.filter(
        (argument) => argument === "src/components/WorkspaceEnvironment.browser.tsx",
      ),
    ).toHaveLength(1);
    expect(shared[0]!.env).toBeUndefined();
    expect(shared[0]!["timeout-minutes"]).toBeUndefined();
    expect(shared[0]!["continue-on-error"]).toBeUndefined();

    const retiredStepNames = [
      "Prepare synthetic native visualization evidence directories",
      "Prepare installed Electron sandbox helper (Linux)",
      "Isolated native visualization host qualification",
      "Isolated native visualization host qualification (Linux)",
      "Isolated native visualization chat font qualification",
      "Isolated native visualization chat font qualification (Linux)",
    ];
    const allSteps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
    for (const name of retiredStepNames)
      expect(
        allSteps.filter((step) => step.name === name),
        name,
      ).toEqual([]);
    for (const step of allSteps) {
      expect(step.run ?? "").not.toContain("NativeVisualizationElectron.e2e.test.ts");
      expect(step.run ?? "").not.toContain("chrome-sandbox");
      expect(step.run ?? "").not.toContain("cafe-visualization-comprehensive");
      expect(step.run ?? "").not.toContain("cafe-visualization-font");
    }
    const privateReplayKeys = [
      "CAFE_CODE_VISUALIZATION_E2E",
      "CAFE_CODE_VISUALIZATION_E2E_CAPTURE_DIR",
      "CAFE_CODE_VISUALIZATION_FONT_REPLAY",
      "CAFE_CODE_VISUALIZATION_BAR_REPLAY",
      "CAFE_CODE_VISUALIZATION_BAR_SOURCE",
      "CAFE_CODE_VISUALIZATION_BAR_SOURCE_SHA256",
      "CAFE_CODE_VISUALIZATION_BAR_SOURCE_BYTES",
    ];
    // Shared workflow/job environments are inherited by steps. Refuse both a
    // private replay and accidental reactivation of the retired native host.
    const environments = [
      workflow.env,
      ...Object.values(workflow.jobs).flatMap((job) => [
        job.env,
        ...(job.steps ?? []).map((step) => step.env),
      ]),
    ];
    for (const environment of environments)
      for (const key of privateReplayKeys) expect(environment ?? {}).not.toHaveProperty(key);
    expect(quality["timeout-minutes"]).toBe(45);
    expect(quality["continue-on-error"]).toBeUndefined();
    // The initial bundle supplies copied bridge fixtures; the uncached desktop
    // build must remain the final executable check, after every browser lane.
    const final = {
      name: "Final forced desktop verification",
      run: "corepack yarn build:desktop --force",
    };
    expect(steps.filter((step) => step.name === final.name)).toEqual([final]);
    expect(steps.filter((step) => step.run !== undefined).at(-1)).toEqual(final);
  });

  it("runs Mermaid security exactly once in a dedicated sequential native-host step", () => {
    const steps = readWorkflow("ci.yml").jobs.quality?.steps ?? [];
    const selector = "src/components/MermaidSecurity.browser.tsx";
    const dedicated = {
      name: "Mermaid source and parsed-graph security browser qualification",
      if: "runner.os != 'Linux'",
      run: `corepack yarn workspace @cafecode/web test:browser ${selector} --maxWorkers=2`,
    };
    // Whole-step equality admits only this complete file with its existing
    // native-host worker bound: no environment, timeout, failure bypass, retry
    // or input override may be attached to the scheduling partition.
    expect(steps.filter((step) => step.name === dedicated.name)).toEqual([dedicated]);
    const selectedSteps = steps.filter((step) => step.run?.split(/\s+/).includes(selector));
    expect(selectedSteps).toEqual([dedicated]);
    expect(
      selectedSteps[0]!.run!.split(/\s+/).filter((argument) => argument === selector),
    ).toHaveLength(1);

    const broadIndex = steps.findIndex(
      (step) =>
        step.name === "Cross-platform Markdown, timeline, menus and file action browser tests",
    );
    const dedicatedIndex = steps.findIndex((step) => step.name === dedicated.name);
    expect(broadIndex).toBeGreaterThanOrEqual(0);
    // Job steps are sequential. Keep the security file outside the broad
    // invocation and immediately after it, before the remaining qualifications
    // and required final forced desktop build, rather than silently dropping it.
    expect(dedicatedIndex).toBe(broadIndex + 1);
    expect(steps[broadIndex]!.run!.split(/\s+/)).not.toContain(selector);
    for (const laterName of [
      "Generated chart layout and range animation browser qualification",
      "Additional Mermaid family browser qualification",
      "Full-access inline visualization browser qualification",
      "Final forced desktop verification",
    ])
      expect(steps.findIndex((step) => step.name === laterName)).toBeGreaterThan(dedicatedIndex);

    // The complete Linux invocation still owns coverage of this file and every
    // other browser test, with no selector or scheduling-policy substitution.
    expect(steps.filter((step) => step.name === "Browser tests")).toEqual([
      {
        name: "Browser tests",
        if: "runner.os == 'Linux'",
        run: "corepack yarn workspace @cafecode/web test:browser",
      },
    ]);
  });

  it("keeps visualization and Mermaid browser qualification on the original worker and deadline bounds", () => {
    const steps = readWorkflow("ci.yml").jobs.quality?.steps ?? [];
    for (const expected of [
      {
        name: "Browser tests",
        if: "runner.os == 'Linux'",
        run: "corepack yarn workspace @cafecode/web test:browser",
      },
      {
        name: "Mermaid source and parsed-graph security browser qualification",
        if: "runner.os != 'Linux'",
        run: "corepack yarn workspace @cafecode/web test:browser src/components/MermaidSecurity.browser.tsx --maxWorkers=2",
      },
      {
        name: "Generated chart layout and range animation browser qualification",
        if: "runner.os != 'Linux'",
        run: "corepack yarn workspace @cafecode/web test:browser src/components/visualizations/VisualizationCommitChart.browser.tsx --maxWorkers=2",
      },
      {
        name: "Additional Mermaid family browser qualification",
        if: "runner.os != 'Linux'",
        run: "corepack yarn workspace @cafecode/web test:browser src/components/MermaidFamilies.browser.tsx --maxWorkers=2",
      },
    ])
      // Exact steps preserve Linux's complete suite, focused native-host files,
      // two workers and the absence of per-step timeout/failure bypasses.
      expect(steps.filter((step) => step.name === expected.name)).toEqual([expected]);
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
