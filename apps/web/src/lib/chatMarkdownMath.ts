const FENCE_START_PATTERN = /^([ \t]{0,3})(`{3,}|~{3,})([^\n]*)$/;

const TEX_COMMAND_PATTERN =
  /\\(?:alpha|beta|bmod|cdot|cdots|delta|end|equiv|exists|forall|frac|gamma|in|int|lambda|ldots|left|mapsto|mathbb|mathbf|mathrm|operatorname|partial|pmod|prod|right|sqrt|sum|to|begin)\b/;
const TEX_OPERATOR_PATTERN = /(?:[_^{}=<>]|[∈∉≤≥≠≈≡→←↔∞]|\bmod\b)/;
const MARKDOWN_STRUCTURAL_LINE_PATTERN = /^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|\|)/;
const LONG_PROSE_WORD_PATTERN = /[A-Za-z]{3,}/g;

function isFenceClose(line: string, fenceIndent: string, fenceMarker: string): boolean {
  const markerChar = fenceMarker[0];
  const minLength = fenceMarker.length;
  const pattern = new RegExp(
    `^${fenceIndent}[${markerChar === "`" ? "`" : "~"}]{${minLength},}[ \\t]*$`,
  );
  return pattern.test(line);
}

function isMathFence(info: string): boolean {
  const language = info.trim().split(/\s+/, 1)[0]?.toLowerCase();
  return language === "math" || language === "latex" || language === "tex";
}

function normalizeMathFences(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const startMatch = line.match(FENCE_START_PATTERN);
    if (!startMatch) {
      output.push(line);
      continue;
    }

    const [, fenceIndent = "", fenceMarker = "", fenceInfo = ""] = startMatch;
    const body: string[] = [];
    let closeLine: string | undefined;
    let cursor = index + 1;

    for (; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor] ?? "";
      if (isFenceClose(candidate, fenceIndent, fenceMarker)) {
        closeLine = candidate;
        break;
      }
      body.push(candidate);
    }

    if (!isMathFence(fenceInfo)) {
      output.push(line, ...body);
      if (closeLine !== undefined) {
        output.push(closeLine);
        index = cursor;
      } else {
        index = lines.length;
      }
      continue;
    }

    output.push("$$", body.join("\n").trim(), "$$");
    index = closeLine !== undefined ? cursor : lines.length;
  }

  return output.join("\n");
}

function trimBlankEdgeLines(lines: ReadonlyArray<string>): ReadonlyArray<string> {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? "").trim().length === 0) {
    start += 1;
  }
  while (end > start && (lines[end - 1] ?? "").trim().length === 0) {
    end -= 1;
  }
  return lines.slice(start, end);
}

function transformOutsideFences(text: string, transform: (chunk: string) => string): string {
  const lines = text.split("\n");
  const output: string[] = [];
  let activeFence: { indent: string; marker: string } | null = null;
  let pendingChunk: string[] = [];

  const flushPendingChunk = () => {
    if (pendingChunk.length === 0) return;
    output.push(transform(pendingChunk.join("\n")));
    pendingChunk = [];
  };

  for (const line of lines) {
    if (activeFence) {
      output.push(line);
      if (isFenceClose(line, activeFence.indent, activeFence.marker)) {
        activeFence = null;
      }
      continue;
    }

    const fenceStartMatch = line.match(FENCE_START_PATTERN);
    if (fenceStartMatch) {
      flushPendingChunk();
      const [, fenceIndent = "", fenceMarker = ""] = fenceStartMatch;
      activeFence = { indent: fenceIndent, marker: fenceMarker };
      output.push(line);
      continue;
    }

    pendingChunk.push(line);
  }

  flushPendingChunk();
  return output.join("\n");
}

function normalizeStandaloneSlashDisplayDelimiters(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];
  let activeBlock: { indent: string; body: string[] } | null = null;
  let activeFence: { indent: string; marker: string } | null = null;

  for (const line of lines) {
    if (activeBlock) {
      if (line.trim() === "\\]") {
        const { indent } = activeBlock;
        const body = trimBlankEdgeLines(activeBlock.body).map((bodyLine) =>
          bodyLine.startsWith(indent) ? bodyLine.slice(indent.length) : bodyLine,
        );

        // Preserve the list/blockquote continuation indentation on both
        // delimiters and content. Mixing an indented opening delimiter with a
        // column-zero closing delimiter makes remark-math split the block and
        // can turn the following prose into accidental display math.
        output.push(`${indent}$$`);
        for (const bodyLine of body) {
          output.push(`${indent}${bodyLine}`);
        }
        output.push(`${indent}$$`);
        activeBlock = null;
        continue;
      }

      activeBlock.body.push(line);
      continue;
    }

    if (activeFence) {
      output.push(line);
      if (isFenceClose(line, activeFence.indent, activeFence.marker)) {
        activeFence = null;
      }
      continue;
    }

    const fenceStartMatch = line.match(FENCE_START_PATTERN);
    if (fenceStartMatch) {
      const [, fenceIndent = "", fenceMarker = ""] = fenceStartMatch;
      activeFence = { indent: fenceIndent, marker: fenceMarker };
      output.push(line);
      continue;
    }

    if (line.trim() === "\\[") {
      const indent = line.slice(0, line.indexOf("\\["));
      activeBlock = { indent, body: [] };
      continue;
    }

    output.push(line);
  }

  if (activeBlock) {
    output.push(`${activeBlock.indent}\\[`, ...activeBlock.body);
  }

  return output.join("\n");
}

function normalizeInlineSlashDisplayDelimiters(text: string): string {
  return text.replace(/\\\[([\s\S]*?)\\\]/g, (match: string, math: string, offset: number) => {
    const before = text.slice(0, offset);
    const after = text.slice(offset + match.length);
    const needsLeadingBreak = before.length > 0 && !/\n\s*$/.test(before);
    const needsTrailingBreak = after.length > 0 && !/^\s*\n/.test(after);
    return `${needsLeadingBreak ? "\n\n" : ""}$$\n${math.trim()}\n$$${needsTrailingBreak ? "\n\n" : ""}`;
  });
}

function normalizeInlineSlashMathDelimiters(text: string): string {
  return text.replace(/\\\((.*?)\\\)/g, (_match, math: string) => `$${math.trim()}$`);
}

function normalizeLatexDelimiters(text: string): string {
  const standaloneNormalized = normalizeStandaloneSlashDisplayDelimiters(text);
  const displayNormalized = transformOutsideFences(
    standaloneNormalized,
    normalizeInlineSlashDisplayDelimiters,
  );
  return transformOutsideFences(displayNormalized, normalizeInlineSlashMathDelimiters);
}

function normalizeTableRowMathDelimiters(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];
  let activeFence: { indent: string; marker: string } | null = null;

  for (const line of lines) {
    if (activeFence) {
      output.push(line);
      if (isFenceClose(line, activeFence.indent, activeFence.marker)) {
        activeFence = null;
      }
      continue;
    }

    const fenceStartMatch = line.match(FENCE_START_PATTERN);
    if (fenceStartMatch) {
      const [, fenceIndent = "", fenceMarker = ""] = fenceStartMatch;
      activeFence = { indent: fenceIndent, marker: fenceMarker };
      output.push(line);
      continue;
    }

    if (!line.includes("|")) {
      output.push(line);
      continue;
    }

    // GFM table cells cannot contain real block math. Providers sometimes put
    // same-line display delimiters inside a table cell to mean "large formula";
    // keeping `$$...$$` or `\[...\]` there can break table parsing after a
    // reload. Render it as inline math so the table remains structurally valid
    // and the formula can scroll with the table.
    output.push(
      line
        .replace(/\$\$([^\n]*?)\$\$/g, (_match, math: string) => `$${math.trim()}$`)
        .replace(/\\\[([^\n]*?)\\\]/g, (_match, math: string) => `$${math.trim()}$`),
    );
  }

  return output.join("\n");
}

function removeTexSyntaxForProseCheck(line: string): string {
  return line
    .replace(/\\[A-Za-z]+[*]?/g, " ")
    .replace(/\\./g, " ")
    .replace(/[0-9_^{}/()[\].,;:=+\-<>|*&%$#~!?'"]/g, " ")
    .replace(/[∈∉≤≥≠≈≡→←↔∞]/g, " ");
}

function isStandaloneMathLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.includes("`")) return false;
  if (MARKDOWN_STRUCTURAL_LINE_PATTERN.test(trimmed)) return false;
  if (!TEX_COMMAND_PATTERN.test(trimmed) && !TEX_OPERATOR_PATTERN.test(trimmed)) return false;

  const proseProbe = removeTexSyntaxForProseCheck(trimmed);
  const longWords = proseProbe.match(LONG_PROSE_WORD_PATTERN) ?? [];
  return longWords.length <= 1;
}

function normalizeStandaloneMathParagraphs(text: string): string {
  return text
    .split(/(\n{2,})/)
    .map((segment) => {
      if (/^\n{2,}$/.test(segment)) return segment;
      const trimmed = segment.trim();
      if (trimmed.length === 0) return segment;
      if (trimmed.startsWith("$$") || trimmed.endsWith("$$")) return segment;
      const lines = trimmed.split("\n");
      if (!lines.every(isStandaloneMathLine)) return segment;
      return `$$\n${trimmed}\n$$`;
    })
    .join("");
}

/**
 * Providers do not consistently delimit math. Normalize common chat output
 * shapes before the Markdown AST is built so KaTeX handles them as math, while
 * leaving ordinary non-math code fences untouched.
 */
export function normalizeChatMarkdownMath(text: string): string {
  return normalizeStandaloneMathParagraphs(
    normalizeLatexDelimiters(normalizeTableRowMathDelimiters(normalizeMathFences(text))),
  );
}
