import { existsSync, readdirSync, readFileSync } from "node:fs";
import { matchesGlob, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../apps/web");
const { touchTimelineFile, visualizationFluidFile, reducedMotionFiles, browserStressPattern } =
  JSON.parse(readFileSync(resolve(root, "browser-test-policy.json"), "utf8")) as {
    touchTimelineFile: string;
    visualizationFluidFile: string;
    reducedMotionFiles: string[];
    browserStressPattern: string;
  };
describe("browser feature inventory", () => {
  it("assigns specialized input/media fixtures without duplicate selectors", () => {
    const specialized = [touchTimelineFile, visualizationFluidFile, ...reducedMotionFiles];
    expect(new Set(specialized).size).toBe(specialized.length);
    for (const file of specialized) {
      expect(existsSync(resolve(root, file)), file).toBe(true);
      expect(file).not.toContain(".stress.");
    }
  });
  it("keeps stress qualification explicitly distinguishable from feature cases", () => {
    const files = readdirSync(resolve(root, "src/components"), { recursive: true }).filter(
      (file): file is string => typeof file === "string" && file.endsWith(".stress.browser.tsx"),
    );
    for (const file of files) expect(matchesGlob(file, browserStressPattern)).toBe(true);
    for (const file of [touchTimelineFile, visualizationFluidFile, ...reducedMotionFiles])
      expect(matchesGlob(file, browserStressPattern)).toBe(false);
  });
});
