import { describe, expect, it } from "vitest";
import {
  assertEffectQueueApiEquivalence,
  effectQueueProbeSources,
  reverseExactQueuePatch,
  validateEffectQueueApiReport,
} from "./effect-language-service-queue-qualification.ts";

// Default tests admit/refuse finite proof values only. Actual dependency code
// and copied compiler API/CLI qualification remain the explicit entrypoint.
const report = {
  typescriptVersion: "5.9.3",
  diagnostics: [12, 55, 56, 57, 58, 59, 60, 61, 62].map((code, start) => ({
    code,
    category: 1,
    source: "effect",
    file: "wide.mts",
    start,
    length: 1,
    message: `qualified-${code}`,
  })),
  ordinary: [],
};

describe("Effect FIFO diagnostic evidence", () => {
  it("requires real-rule positives plus an empty plugin-absent control without dropping order or spans", () => {
    const accepted = validateEffectQueueApiReport(JSON.stringify(report));
    expect(() => assertEffectQueueApiEquivalence(accepted, accepted)).not.toThrow();
    for (const changed of [
      { ...report, diagnostics: [...report.diagnostics].reverse() },
      {
        ...report,
        diagnostics: report.diagnostics.map((row, index) =>
          index === 0 ? { ...row, start: row.start + 1 } : row,
        ),
      },
      {
        ...report,
        diagnostics: report.diagnostics.map((row, index) =>
          index === 0 ? { ...row, length: row.length + 1 } : row,
        ),
      },
      {
        ...report,
        diagnostics: report.diagnostics.map((row, index) =>
          index === 0 ? { ...row, message: "changed message" } : row,
        ),
      },
    ])
      expect(() =>
        assertEffectQueueApiEquivalence(
          accepted,
          validateEffectQueueApiReport(JSON.stringify(changed)),
        ),
      ).toThrow();
    for (const changed of [
      { ...report, diagnostics: report.diagnostics.slice(1) },
      { ...report, ordinary: [report.diagnostics[0]] },
      { ...report, typescriptVersion: "5.8.3" },
      { ...report, extra: true },
      {
        ...report,
        diagnostics: report.diagnostics.map((row) => ({ ...row, source: "typescript" })),
      },
      { ...report, diagnostics: report.diagnostics.map((row) => ({ ...row, file: "foreign" })) },
      { ...report, diagnostics: report.diagnostics.map((row) => ({ ...row, category: 0 })) },
      { ...report, diagnostics: report.diagnostics.map((row) => ({ ...row, start: -1 })) },
    ])
      expect(() => validateEffectQueueApiReport(JSON.stringify(changed))).toThrow();
    for (const text of ["null", "[]", "{}", "private error", "x".repeat(65_537)])
      expect(() => validateEffectQueueApiReport(text)).toThrow("not qualified");
  });

  it("inverts exact reviewed hunks rather than accepting fuzzy/mismatched or external file paths", () => {
    const patch =
      "diff --git a/index.js b/index.js\nindex old..new 100644\n--- a/index.js\n+++ b/index.js\n@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+cleared\n";
    expect(reverseExactQueuePatch("keep\nnew\ncleared\n", patch, "index.js")).toBe("keep\nold\n");
    for (const [source, altered, file] of [
      ["keep\nwrong\ncleared\n", patch, "index.js"],
      ["keep\nnew\ncleared\n", patch.replace("+1,3", "+1,2"), "index.js"],
      ["keep\nnew\ncleared\n", patch + patch, "index.js"],
      ["keep\nnew\ncleared\n", patch, "../outside.js"],
    ])
      expect(() => reverseExactQueuePatch(source!, altered!, file!)).toThrow();
  });

  it("bounds the inert source domain and keeps its ordinary control free of intentional native calls", () => {
    const source = effectQueueProbeSources();
    expect(
      Object.values(source).reduce((sum, text) => sum + Buffer.byteLength(text), 0),
    ).toBeLessThanOrEqual(192 * 1024);
    expect(source["control.mts"]).toBe(
      'import * as Effect from "effect/Effect";\nexport const value = Effect.succeed(1);\n',
    );
  });
});
