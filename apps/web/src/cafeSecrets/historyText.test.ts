import { expect, it } from "vitest";
import { cafeSecretReference, parseCafeSecrets } from "@cafecode/shared/cafeSecrets";
import { cafeSecretHistoryText } from "./historyText";

const id = "0123456789abcdef0123456789abcdef";
const other = "fedcba9876543210fedcba9876543210";
const reference = cafeSecretReference(id);

it("restores user-facing markers without changing the stored text or resolving literals", () => {
  const stored = `Use ${reference} twice: ${reference}; literal \\${reference}; missing ${cafeSecretReference(other)}.`;
  const displayed = cafeSecretHistoryText(stored, new Map([[id, "synthetic-key"]]));
  expect(displayed).toBe(
    `Use [sec:synthetic-key] twice: [sec:synthetic-key]; literal \\${reference}; missing ${cafeSecretReference(other)}.`,
  );
  expect(stored).not.toContain("synthetic-key");
  expect(cafeSecretHistoryText(stored, new Map())).toBe(stored);
});

it("renders escaped values literally and never recursively resolves reference-shaped values", () => {
  const value = `a]b\\c ${cafeSecretReference(other)} <script>text</script> $skill`;
  const displayed = cafeSecretHistoryText(
    reference,
    new Map([
      [id, value],
      [other, "unrelated-value"],
    ]),
  );
  expect(parseCafeSecrets(displayed).spans.map((span) => span.value)).toEqual([value]);
  expect(displayed).not.toContain("unrelated-value");
});

it("bounds repeated value expansion while preserving the remaining source text", () => {
  const stored = `${reference} `.repeat(100) + "original tail";
  const displayed = cafeSecretHistoryText(stored, new Map([[id, "v".repeat(16_384)]]));
  expect(displayed.length).toBeLessThanOrEqual(1_048_576);
  expect(displayed).toContain("[sec:" + "v".repeat(16_384) + "]");
  expect(displayed).toContain(reference);
  expect(displayed.endsWith("original tail")).toBe(true);
});
