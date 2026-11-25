import { describe, expect, it } from "vitest";

import { extractMarkdownLinkDestinations, resolveMarkdownFileLinkMeta } from "../markdown-links";
import { normalizeCodexFileCitations } from "./codexFileCitations";

const citation = ':codex-file-citation{path="/tmp/review (final).pdf" purpose="source"}';
const link = "[review (final).pdf](</tmp/review%20(final).pdf>)";

describe("normalizeCodexFileCitations", () => {
  it("turns inline source and standalone output citations into Markdown links", () => {
    expect(
      normalizeCodexFileCitations(
        `See **page 4** of ${citation}.\n\n::codex-file-citation{purpose='output' artifact_kind=workbook path=/tmp/report.xlsx}`,
      ),
    ).toBe(`See **page 4** of ${link}.\n\n[report.xlsx](</tmp/report.xlsx>)`);
  });

  it.each([
    ["/tmp/Q%20?A#1 [review]_&.pdf", "/tmp/Q%20?A#1 [review]_&.pdf"],
    [String.raw`C:\repo\.reports\表 (1).pdf:4:2`, "C:/repo/.reports/表 (1).pdf:4:2"],
    [String.raw`\\host\share\Review.pdf`, String.raw`\\host\share\Review.pdf`],
    ["資料/Review A.pdf", "/repo/project/./資料/Review A.pdf"],
    [String.raw`/tmp/say \"hello\".pdf`, '/tmp/say "hello".pdf'],
  ])("preserves the exact destination of %s through file-link resolution", (path, expected) => {
    const cwd = "/repo/project";
    const result = normalizeCodexFileCitations(`:codex-file-citation{path="${path}"}`, cwd);
    const destinations = extractMarkdownLinkDestinations(result);
    expect(destinations).toHaveLength(1);
    expect(resolveMarkdownFileLinkMeta(destinations[0]?.value, cwd)?.targetPath).toBe(expected);
  });

  it("preserves citation examples and existing Markdown links", () => {
    const examples = [
      `\`${citation}\``,
      `> - Example\n>\n>   ~~~~mermaid\n>   A[${citation}]\n>   ~~~~`,
      `<pre>\n${citation}\n</pre>`,
      `[${citation}](https://example.test/report)`,
      `![${citation}](https://example.test/report.png)`,
      `[report]: https://example.test/report '${citation}'`,
      `$${citation}$`,
      `\\${citation}`,
      `!${citation}`,
    ].join("\n\n");
    expect(normalizeCodexFileCitations(`${examples}\n\nSee ${citation}.`)).toBe(
      `${examples}\n\nSee ${link}.`,
    );
  });

  it.each([
    ':codex-file-citation{path="/tmp/review.pdf"',
    ':codex-file-citation{purpose="source"}',
    ':codex-file-citation{path="/tmp/a.pdf" path="/tmp/b.pdf"}',
    ':codex-file-citation{path="/tmp/report\nname.pdf"}',
    ':codex-file-citation{path="javascript:alert(1)"}',
    ':codex-file-citation{path="https://example.test/review.pdf"}',
    ':codex-file-citation{path="//example.test/review.pdf"}',
    ':codex-file-citation{path="report.pdf"}', // An unbound relative path.
  ])("leaves unsupported or incomplete directives literal (%s)", (source) => {
    expect(normalizeCodexFileCitations(source)).toBe(source);
  });
});
