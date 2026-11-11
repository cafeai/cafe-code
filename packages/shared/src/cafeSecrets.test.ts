import { describe, expect, it } from "vitest";
import {
  cafeSecretReference,
  containsCafeSecrets,
  findCafeSecretRanges,
  hasCafeSecretReference,
  makeCafeSecretStreamRedactor,
  parseCafeSecrets,
  redactCafeSecretText,
  substituteCafeSecretReferences,
  supportsCafeSecrets,
} from "./cafeSecrets.ts";

const id = "0123456789abcdef0123456789abcdef";
const otherId = "fedcba9876543210fedcba9876543210";
describe("Cafe Secrets syntax and substitution", () => {
  it("captures explicit markers with original offsets and retains escapes across admission", () => {
    const text = "Use [sec:alpha] and \\[sec:literal], then [sec:a\\]b\\\\c]";
    const parsed = parseCafeSecrets(text);
    expect(parsed.text).toBe(text);
    expect(parsed.spans.map((span) => span.value)).toEqual(["alpha", "a]b\\c"]);
    expect(parsed.spans.map((span) => text.slice(span.start, span.end))).toEqual([
      "[sec:alpha]",
      "[sec:a\\]b\\\\c]",
    ]);
    expect(containsCafeSecrets("\\[sec:literal]")).toBe(false);
    expect(containsCafeSecrets("\\\\[sec:active]")).toBe(true);
  });
  it("marks unfinished values as sensitive for draft storage without admitting them", () => {
    expect(findCafeSecretRanges("before [sec:unfinished")).toEqual([{ start: 7, end: 22 }]);
    expect(parseCafeSecrets("[sec:unfinished").spans).toEqual([]);
    expect(containsCafeSecrets("[!NOTE] [!abc] [section:value]")).toBe(false);
  });
  it("substitutes exact references once without interpreting replacement tokens", () => {
    const values = new Map([
      [id, `$&\\n${cafeSecretReference(otherId)}`],
      [otherId, "second"],
    ]);
    expect(substituteCafeSecretReferences(`key=${cafeSecretReference(id)}`, values)).toBe(
      `key=$&\\n${cafeSecretReference(otherId)}`,
    );
    expect(() => substituteCafeSecretReferences(cafeSecretReference(otherId), new Map())).toThrow(
      "unavailable",
    );
    expect(() => substituteCafeSecretReferences("[CAFE_SECRET_unknown]", values)).toThrow(
      "unavailable",
    );
    expect(hasCafeSecretReference("[CAFE_SECRET_<id>]")).toBe(false);
    expect(hasCafeSecretReference(`\\${cafeSecretReference(id)}`)).toBe(false);
    expect(substituteCafeSecretReferences(`\\${cafeSecretReference(id)}`, values)).toBe(
      `\\${cafeSecretReference(id)}`,
    );
  });
  it("redacts longest overlaps and preserves existing references on a second pass", () => {
    const values = new Map([
      [id, "abc"],
      [otherId, "abcdef"],
    ]);
    const output = redactCafeSecretText("abcdef abc abcdef", values);
    expect(output).toBe(
      `${cafeSecretReference(otherId)} ${cafeSecretReference(id)} ${cafeSecretReference(otherId)}`,
    );
    expect(redactCafeSecretText(output, new Map([[id, "a"]]))).toBe(output);
  });
  it("redacts every output split, including overlapping values and reserved references", () => {
    const values = new Map([
      [id, "secret-key-123"],
      [otherId, "secret-key-123-long"],
    ]);
    const text = `before secret-key-123-long middle secret-key-123 after ${cafeSecretReference(id)}`;
    const expected = redactCafeSecretText(text, values);
    for (let split = 0; split <= text.length; split++) {
      const redact = makeCafeSecretStreamRedactor(values);
      expect(redact(text.slice(0, split)) + redact(text.slice(split)) + redact("", true)).toBe(
        expected,
      );
    }
    const redact = makeCafeSecretStreamRedactor(new Map([[id, "a"]]));
    expect(
      [...cafeSecretReference(id)].map((part) => redact(part)).join("") + redact("", true),
    ).toBe(cafeSecretReference(id));
  });
  it("keeps streaming overlap boundaries and Unicode intact with a bounded output", () => {
    const values = new Map([
      [id, "abc"],
      [otherId, "cdef"],
    ]);
    const source = `😀abcdef${" ".repeat(60)}😀`;
    for (let split = 0; split <= source.length; split++) {
      const stream = makeCafeSecretStreamRedactor(values);
      expect(stream(source.slice(0, split)) + stream(source.slice(split)) + stream("", true)).toBe(
        redactCafeSecretText(source, values),
      );
    }
    const stream = makeCafeSecretStreamRedactor(new Map([[id, "q"]]));
    const output = stream("q".repeat(100_000), true);
    expect(output.length).toBeLessThan(1_048_620);
    expect(output).toContain("output truncated");
    expect(output).not.toContain("q");
    expect(stream("q", true)).toBe("");
  });

  it("supports only the implemented drivers, independent of account aliases", () => {
    expect(supportsCafeSecrets("codex")).toBe(true);
    expect(supportsCafeSecrets("claudeAgent")).toBe(true);
    expect(supportsCafeSecrets("codex_work")).toBe(false);
    expect(supportsCafeSecrets("openCode")).toBe(false);
    expect(supportsCafeSecrets(undefined)).toBe(false);
  });
});
