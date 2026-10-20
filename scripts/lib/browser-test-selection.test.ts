import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  browserTestMode,
  partitionCompleteBrowserFiles,
  resolveCompleteLocalBrowserSelection,
  type BrowserSelectionPolicy,
} from "./browser-test-selection.ts";

const policy: BrowserSelectionPolicy = {
  desktopInclude: ["src/components/**/*.browser.tsx"],
  touchTimelineFile: "src/components/chat/Touch.browser.tsx",
  visualizationFluidFile: "src/components/Fluid.browser.tsx",
  reducedMotionFiles: ["src/components/Reduced.motion.browser.tsx"],
  browserStressPattern: "**/*.stress.browser.tsx",
  mermaidSecurityFiles: ["src/components/Security.browser.tsx"],
  mermaidFamilyFiles: ["src/components/Family.browser.tsx"],
  imageExportFiles: ["src/components/Export.browser.tsx"],
  inlineFiles: ["src/components/Inline.browser.tsx"],
};
const ordinary = "src/components/Ordinary.browser.tsx";
const specialized = [
  policy.touchTimelineFile,
  policy.visualizationFluidFile,
  ...policy.reducedMotionFiles,
  ...policy.mermaidSecurityFiles,
  ...policy.mermaidFamilyFiles,
  ...policy.imageExportFiles,
  ...policy.inlineFiles,
];

describe("complete local browser selection", () => {
  it("admits new ordinary files and a newly split semantic family without changing a manual subset", () => {
    const added = "src/components/new/NewFeature.browser.tsx";
    const splitFamily = "src/components/Family.parsed.browser.tsx";
    const selection = partitionCompleteBrowserFiles(
      [...specialized, ordinary, added, splitFamily],
      { ...policy, mermaidFamilyFiles: [...policy.mermaidFamilyFiles, splitFamily] },
    );
    expect(selection.desktopFiles).toEqual([ordinary, added].sort());
    expect(selection.mermaidFamilyFiles).toEqual(
      [policy.mermaidFamilyFiles[0], splitFamily].sort(),
    );
    expect(selection.touchFiles).toEqual([policy.touchTimelineFile]);
    const selected = Object.values(selection).flat();
    expect(new Set(selected)).toEqual(new Set([...specialized, ordinary, added, splitFamily]));
    expect(selected.length).toBe(new Set(selected).size);
  });

  it("refuses a removed required file, conflicting owner or empty ordinary domain", () => {
    expect(() =>
      partitionCompleteBrowserFiles([ordinary, ...specialized.slice(1)], policy),
    ).toThrow("missing");
    expect(() =>
      partitionCompleteBrowserFiles([ordinary, ...specialized], {
        ...policy,
        inlineFiles: policy.mermaidSecurityFiles,
      }),
    ).toThrow("conflicting owners");
    expect(() => partitionCompleteBrowserFiles(specialized, policy)).toThrow("ordinary");
    expect(() =>
      partitionCompleteBrowserFiles([ordinary, ordinary, ...specialized], policy),
    ).toThrow("malformed");
  });

  it("refuses case-insensitive substring filters which would execute a deferred file twice", () => {
    const overlapping = `${policy.mermaidSecurityFiles[0]}.extra.browser.tsx`;
    expect(() =>
      partitionCompleteBrowserFiles([...specialized, ordinary, overlapping], policy),
    ).toThrow("overlap");
    expect(() =>
      partitionCompleteBrowserFiles(
        [...specialized, ordinary, policy.mermaidSecurityFiles[0]!.replace("Security", "SECURITY")],
        policy,
      ),
    ).toThrow("overlap");
  });

  it("uses the runner's actual glob semantics for nested/hidden files while excluding stress", () => {
    const root = mkdtempSync(join(tmpdir(), "cafe-browser-selection-"));
    try {
      const hidden = "src/components/.fixture/Hidden.browser.tsx";
      const stress = "src/components/Optional.stress.browser.tsx";
      for (const file of [ordinary, hidden, stress, ...specialized]) {
        const path = join(root, "apps/web", file);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "// inert discovery fixture\n");
      }
      const selection = resolveCompleteLocalBrowserSelection(root, policy);
      expect(selection.desktopFiles).toEqual([hidden, ordinary].sort());
      expect(Object.values(selection).flat()).not.toContain(stress);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed/out-of-scope selections and unrecognized CLI filters", () => {
    for (const file of [
      "../Outside.browser.tsx",
      "src/components/../Other.browser.tsx",
      "src\\components\\X.browser.tsx",
    ])
      expect(() => partitionCompleteBrowserFiles([...specialized, file], policy)).toThrow(
        "malformed",
      );
    expect(browserTestMode([])).toBe("native-ci");
    expect(browserTestMode(["--complete-local"])).toBe("complete-local");
    for (const args of [
      ["--exclude=Security"],
      ["--complete-local", "Ordinary"],
      ["--complete-local", "--complete-local"],
    ])
      expect(() => browserTestMode(args)).toThrow("optional --complete-local");
  });
});
