import { format } from "oxfmt";
import { describe, expect, it, vi } from "vitest";
import { formatGeneratedCatalogJson, type GeneratedCatalogFilename } from "./ui-catalog-format.ts";

// Keep the real installed native formatter for positive/idempotence cases.
// A file-local observable boundary injects failures without production hooks,
// filesystem writes, arbitrary source execution or a native CLI subprocess.
vi.mock("oxfmt", async (importOriginal) => {
  const original = await importOriginal<typeof import("oxfmt")>();
  return { ...original, format: vi.fn(original.format) };
});

describe("canonical generated catalog JSON formatting", () => {
  it("uses the installed formatter for both short and long location arrays", async () => {
    const metadata = {
      Ready: { message: "Ready", locations: ["apps/web/src/View.tsx:1"] },
      "Long-lived work": {
        message: "Long-lived work",
        locations: Array.from(
          { length: 12 },
          (_, index) =>
            `apps/web/src/components/chat/LongLivedWorkLogSection${index}.tsx:${index + 1}`,
        ),
      },
    };
    const raw = JSON.stringify(metadata, null, 2) + "\n";
    const formatted = await formatGeneratedCatalogJson("messages.json", raw);
    expect(formatted).not.toBe(raw);
    expect(formatted).toContain('"locations": [\n');
    expect(formatted).not.toContain("\r");
    expect(formatted.endsWith("\n")).toBe(true);
    expect(JSON.parse(formatted)).toEqual(metadata);
    expect(await formatGeneratedCatalogJson("messages.json", formatted)).toBe(formatted);
  });

  it("preserves exact ICU/context keys and rich-tag contents and is idempotent", async () => {
    const source = "{count, plural, one {<action>Open {name}</action>} other {# items}}";
    const key = "composer\u0004" + source;
    const english = {
      [key]: source,
      "Apostrophe and braces": "Cafe''s '{example}' <action>{name}</action>",
    };
    const raw = JSON.stringify(english, null, 2) + "\n";
    const formatted = await formatGeneratedCatalogJson("en.json", raw);
    expect(JSON.parse(formatted)).toEqual(english);
    expect(Object.keys(JSON.parse(formatted))).toEqual(Object.keys(english));
    expect(await formatGeneratedCatalogJson("en.json", formatted)).toBe(formatted);
  });

  it("rejects invalid/non-object JSON or unapproved outputs without parser snippets", async () => {
    for (const source of ['{"private text":', "null", "[]", '"private text"'])
      await expect(formatGeneratedCatalogJson("en.json", source)).rejects.toThrow(
        "generated catalog JSON formatting failed",
      );
    await expect(
      formatGeneratedCatalogJson("fr.json" as GeneratedCatalogFilename, "{}"),
    ).rejects.toThrow("generated catalog JSON formatting failed");
  });

  it("reduces native formatter failures and diagnostics to a content-free reason", async () => {
    vi.mocked(format).mockRejectedValueOnce(new Error("private native exception and path"));
    await expect(formatGeneratedCatalogJson("en.json", "{}")).rejects.toThrow(
      /^generated catalog JSON formatting failed$/,
    );
    const diagnostic = {
      severity: "Error",
      message: "private formatter message",
      labels: [],
      helpMessage: null,
      codeframe: "private formatter source snippet",
    } as Awaited<ReturnType<typeof format>>["errors"][number];
    vi.mocked(format).mockResolvedValueOnce({ code: "{}", errors: [diagnostic] });
    await expect(formatGeneratedCatalogJson("en.json", "{}")).rejects.toThrow(
      /^generated catalog JSON formatting failed$/,
    );
  });

  it("rejects malformed or semantically changed formatted output before publication", async () => {
    for (const code of ['{"private invalid output":', '{"Ready":"Changed"}']) {
      vi.mocked(format).mockResolvedValueOnce({ code, errors: [] });
      await expect(formatGeneratedCatalogJson("en.json", '{"Ready":"Ready"}')).rejects.toThrow(
        /^generated catalog JSON formatting failed$/,
      );
    }
  });
});
