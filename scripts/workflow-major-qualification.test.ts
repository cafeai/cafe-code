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
  "test-stress.yml",
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

describe("workflow security and runtime policy", () => {
  it("pins Actions immutably and uses the canonical standalone Node version", () => {
    for (const name of workflowNames)
      for (const job of Object.values(readWorkflow(name).jobs))
        for (const step of job.steps ?? []) {
          if (step.uses?.startsWith("actions/")) {
            const [action, pin] = step.uses.split("@");
            expect(pin, step.uses).toMatch(/^[a-f0-9]{40}$/);
            expect(pin).toBe(qualifiedActionPins[action!]);
            expect(step.with ?? {}).not.toHaveProperty("allow-unsafe-pr-checkout");
            if (action === "actions/setup-node") {
              expect(step.with?.["node-version-file"]).toBe(".node-version");
              expect(readFileSync(resolve(repoRoot, ".node-version"), "utf8").trim()).toBe(
                REPOSITORY_NODE_VERSION,
              );
            }
          }
        }
  });
  it("keeps privileged PR labeling on the trusted base checkout", () => {
    const workflow = readWorkflow("pr-size.yml");
    for (const job of Object.values(workflow.jobs))
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith("actions/checkout@")) {
          expect(step.with ?? {}).not.toHaveProperty("ref");
          expect(step.with ?? {}).not.toHaveProperty("repository");
        }
        expect(step.uses?.startsWith("actions/cache@")).not.toBe(true);
        expect(step.run ?? "").toBe("");
      }
  });
  it("uploads only allowlisted synthetic failure directories", () => {
    const allowed = new Set([
      "DeskSidebar.browser.tsx",
      "MermaidFamilies.browser.tsx",
      "MermaidSecurity.browser.tsx",
      "Visualizations.browser.tsx",
      "VisualizationFluid.browser.tsx",
      "VisualizationHistory.browser.tsx",
      "VisualizationOwner.browser.tsx",
      "InlineMcpAppBridge.browser.tsx",
      "VisualizationInlineCapture.browser.tsx",
    ]);
    for (const step of readWorkflow("ci.yml").jobs.quality?.steps ?? [])
      if (step.uses?.startsWith("actions/upload-artifact")) {
        expect(step.if).toBe("failure()");
        expect(step.with?.["retention-days"]).toBeLessThanOrEqual(7);
        const paths = String(step.with?.path ?? "")
          .trim()
          .split(/\s+/);
        expect(paths.length).toBeGreaterThan(0);
        for (const path of paths) {
          expect(path).toMatch(/^apps\/web\/\.vitest\/attachments\/failure-screenshots\/[^/]+\/$/);
          expect(allowed.has(path.split("/").at(-2)!)).toBe(true);
        }
      }
  });
  it("keeps the forced desktop build after browser verification", () => {
    const steps = readWorkflow("ci.yml").jobs.quality?.steps ?? [];
    const checks = steps.filter((step) => step.run);
    expect(checks.at(-1)?.run).toContain("yarn build:desktop --force");
    expect(readWorkflow("ci.yml").jobs.quality?.["continue-on-error"]).not.toBe(true);
    for (const step of checks) expect(step["continue-on-error"]).not.toBe(true);
  });
});
