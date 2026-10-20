import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import browserPolicy from "../../apps/web/browser-test-policy.json" with { type: "json" };
import { browserTestPlan, nodeTestPlan, testRepositoryRoot } from "./test-run-plan.ts";
import { corepackTestCommand } from "./run-test-plan.ts";
import type { CompleteLocalBrowserSelection } from "./browser-test-selection.ts";

describe("native test plans", () => {
  it("preserves the complete Node graph and bounded Windows pools", () => {
    const windows = nodeTestPlan("win32");
    expect(windows).toHaveLength(1);
    expect(windows[0]!.args).toEqual(
      expect.arrayContaining(["test", "--concurrency=2", "--maxWorkers=2"]),
    );
    expect(windows[0]!.args.some((value) => value.startsWith("--filter"))).toBe(false);
    for (const platform of ["darwin", "linux"] as const) {
      const steps = nodeTestPlan(platform);
      expect(steps.map((step) => step.args.find((arg) => arg.startsWith("--filter")))).toEqual([
        "--filter=!effect-codex-app-server",
        "--filter=effect-codex-app-server",
      ]);
    }
  });
  it.each(["darwin", "win32"] as const)(
    "uses separate sequential input/media/security invocations on %s",
    (platform) => {
      const steps = browserTestPlan(platform);
      const testSteps = steps.filter((step) => step.args.includes("test:browser"));
      for (const step of testSteps) expect(step.args).toContain("--maxWorkers=2");
      const index = (selector: string) => steps.findIndex((step) => step.args.includes(selector));
      expect(index("--project=touch")).toBe(index("--project=desktop"));
      expect(index("--project=visualization-fluid-motion")).toBeGreaterThan(
        index("--project=desktop"),
      );
      expect(index("--project=context-reduced-motion")).toBeGreaterThan(
        index("--project=visualization-fluid-motion"),
      );
      expect(index(browserPolicy.mermaidSecurityFiles[0]!)).toBeGreaterThan(
        index("--project=context-reduced-motion"),
      );
      expect(index(browserPolicy.mermaidFamilyFiles[0]!)).toBeGreaterThan(
        index(browserPolicy.mermaidSecurityFiles[0]!),
      );
      const desktop = steps[index("--project=desktop")]!;
      for (const file of browserPolicy.nativeDesktopFiles) {
        expect(desktop.args).toContain(file);
        expect(existsSync(resolve(testRepositoryRoot, "apps/web", file))).toBe(true);
      }
      expect(desktop.args).not.toContain(browserPolicy.mermaidSecurityFiles[0]);
      expect(desktop.args).not.toContain(browserPolicy.mermaidFamilyFiles[0]);
      const bridge = steps.find((step) => step.env?.CAFE_CODE_MCP_BRIDGE_E2E === "1")!;
      expect(bridge.args).toContain("integration/CafeMcpBridge.e2e.test.ts");
      expect(steps.indexOf(bridge)).toBeGreaterThan(index(browserPolicy.imageExportFiles[0]!));
      expect(index(browserPolicy.inlineFiles[0]!)).toBeGreaterThan(steps.indexOf(bridge));
    },
  );
  it("keeps Linux's complete desktop selection and one separate invocation per motion policy", () => {
    const steps = browserTestPlan("linux");
    const main = steps.find((step) => step.args.includes("--project=desktop"))!;
    expect(main.args.some((arg) => arg.endsWith(".browser.tsx"))).toBe(false);
    for (const project of ["visualization-fluid-motion", "context-reduced-motion"])
      expect(steps.filter((step) => step.args.includes(`--project=${project}`))).toHaveLength(1);
    expect(steps.some((step) => step.args.includes(browserPolicy.mermaidSecurityFiles[0]!))).toBe(
      false,
    );
  });
  it.each(["darwin", "linux", "win32"] as const)(
    "keeps complete local files disjoint while retaining sequential native groups on %s",
    (platform) => {
      const selection: CompleteLocalBrowserSelection = {
        desktopFiles: ["src/components/NewFeature.browser.tsx"],
        touchFiles: ["src/components/Touch.browser.tsx"],
        fluidFiles: ["src/components/Fluid.browser.tsx"],
        reducedMotionFiles: ["src/components/Reduced.browser.tsx"],
        mermaidSecurityFiles: ["src/components/Security.browser.tsx"],
        mermaidFamilyFiles: [
          "src/components/Family.browser.tsx",
          "src/components/Family.parsed.browser.tsx",
        ],
        imageExportFiles: ["src/components/Export.browser.tsx"],
        inlineFiles: ["src/components/Inline.browser.tsx"],
      };
      const artifacts = {
        path: resolve(tmpdir(), "cafe-browser-artifacts-fixture"),
        device: "1",
        inode: "2",
      };
      const steps = browserTestPlan(platform, { selection, artifacts });
      expect(steps[0]!.args).toEqual(expect.arrayContaining(["node", artifacts.path, "1", "2"]));
      expect(steps.some((step) => step.args.includes("build:desktop"))).toBe(false);
      const browserSteps = steps.filter((step) => step.args.includes("test:browser"));
      for (const step of browserSteps) {
        expect(step.args).toContain("--maxWorkers=2");
        expect(step.args.some((arg) => arg.startsWith("--exclude"))).toBe(false);
      }
      const ordinary = browserSteps.find((step) => step.args.includes("--project=desktop"))!;
      expect(ordinary.args).toEqual(
        expect.arrayContaining([...selection.desktopFiles, ...selection.touchFiles]),
      );
      for (const file of [
        ...selection.mermaidSecurityFiles,
        ...selection.mermaidFamilyFiles,
        ...selection.imageExportFiles,
        ...selection.inlineFiles,
      ]) {
        expect(ordinary.args).not.toContain(file);
        expect(browserSteps.filter((step) => step.args.includes(file))).toHaveLength(1);
      }
      const index = (selector: string) => steps.findIndex((step) => step.args.includes(selector));
      expect(index("--project=touch")).toBe(index("--project=desktop"));
      expect(index("--project=visualization-fluid-motion")).toBeGreaterThan(
        index("--project=desktop"),
      );
      expect(index("--project=context-reduced-motion")).toBeGreaterThan(
        index("--project=visualization-fluid-motion"),
      );
      expect(index(selection.mermaidSecurityFiles[0]!)).toBeGreaterThan(
        index("--project=context-reduced-motion"),
      );
      expect(index(selection.mermaidFamilyFiles[0]!)).toBeGreaterThan(
        index(selection.mermaidSecurityFiles[0]!),
      );
      const bridge = steps.find((step) => step.env?.CAFE_CODE_MCP_BRIDGE_E2E === "1")!;
      expect(bridge.env?.CAFE_CODE_MCP_BRIDGE_DIR).toBe(artifacts.path);
      expect(steps.indexOf(bridge)).toBeGreaterThan(index(selection.imageExportFiles[0]!));
      expect(index(selection.inlineFiles[0]!)).toBeGreaterThan(steps.indexOf(bridge));
    },
  );
  it("launches the pinned Node/Corepack entry with structured arguments through spaced paths", () => {
    const root = mkdtempSync(join(tmpdir(), "cafe-corepack-fixture-"));
    try {
      const corepack = join(root, "Corepack with spaces");
      mkdirSync(join(corepack, "dist"), { recursive: true });
      const entry = join(corepack, "dist/yarn.js");
      writeFileSync(entry, "");
      const args = ["workspace", "@cafecode/web", "test:browser", "literal $() & argument"];
      expect(corepackTestCommand(corepack, args)).toEqual({
        command: process.execPath,
        args: [entry, ...args],
      });
      expect(() => corepackTestCommand(undefined, args)).toThrow("Corepack Yarn");
      expect(() => corepackTestCommand(root, args)).toThrow("unavailable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
