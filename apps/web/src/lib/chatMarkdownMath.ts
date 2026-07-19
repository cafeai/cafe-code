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

function normalizeDollarDisplayDelimiters(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];
  let activeFence: { indent: string; marker: string } | null = null;
  let activeBlock: {
    readonly indent: string;
    readonly openingLine: string;
    readonly body: string[];
  } | null = null;

  const emitDisplayBlock = (indent: string, bodyLines: ReadonlyArray<string>) => {
    const body = trimBlankEdgeLines(bodyLines).map((bodyLine) =>
      bodyLine.startsWith(indent) ? bodyLine.slice(indent.length) : bodyLine,
    );

    output.push(`${indent}$$`);
    for (const bodyLine of body) {
      output.push(`${indent}${bodyLine}`);
    }
    output.push(`${indent}$$`);
  };

  for (const line of lines) {
    if (activeBlock) {
      const closeIndex = line.indexOf("$$");
      if (closeIndex >= 0 && line.slice(closeIndex + 2).trim().length === 0) {
        activeBlock.body.push(line.slice(0, closeIndex));
        emitDisplayBlock(activeBlock.indent, activeBlock.body);
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

    const openMatch = line.match(/^([ \t]*)\$\$(.*)$/);
    if (!openMatch) {
      output.push(line);
      continue;
    }

    const [, indent = "", afterOpen = ""] = openMatch;
    const sameLineCloseIndex = afterOpen.indexOf("$$");
    if (sameLineCloseIndex >= 0) {
      const afterClose = afterOpen.slice(sameLineCloseIndex + 2);
      if (afterClose.trim().length === 0) {
        emitDisplayBlock(indent, [afterOpen.slice(0, sameLineCloseIndex)]);
        continue;
      }

      output.push(line);
      continue;
    }

    activeBlock = {
      indent,
      openingLine: line,
      body: [afterOpen],
    };
  }

  if (activeBlock) {
    output.push(activeBlock.openingLine, ...activeBlock.body.slice(1));
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

function isEscapedCharacter(text: string, index: number): boolean {
  let precedingBackslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    precedingBackslashes += 1;
  }
  return precedingBackslashes % 2 === 1;
}

function characterRunLength(text: string, index: number, character: string): number {
  let cursor = index;
  while (cursor < text.length && text[cursor] === character) {
    cursor += 1;
  }
  return cursor - index;
}

function findClosingDelimiter(
  text: string,
  start: number,
  character: string,
  delimiterLength: number,
): number | null {
  for (let cursor = start; cursor < text.length; ) {
    const delimiterIndex = text.indexOf(character, cursor);
    if (delimiterIndex < 0) return null;

    const runLength = characterRunLength(text, delimiterIndex, character);
    if (
      runLength === delimiterLength &&
      (character === "`" || !isEscapedCharacter(text, delimiterIndex))
    ) {
      return delimiterIndex;
    }

    cursor = delimiterIndex + runLength;
  }

  return null;
}

function findClosingTexBrace(tex: string, openingBraceIndex: number): number | null {
  let depth = 0;

  for (let cursor = openingBraceIndex; cursor < tex.length; cursor += 1) {
    const character = tex[cursor];
    if (isEscapedCharacter(tex, cursor)) continue;

    if (character === "{") {
      depth += 1;
      continue;
    }

    if (character === "}") {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }

  return null;
}

function escapeTextttLiteralUnderscores(tex: string): string {
  const command = "\\texttt{";
  const output: string[] = [];
  let cursor = 0;

  while (cursor < tex.length) {
    const commandIndex = tex.indexOf(command, cursor);
    if (commandIndex < 0) {
      output.push(tex.slice(cursor));
      break;
    }

    // An odd preceding backslash count means this is literal `\texttt`, not a
    // TeX command. Advancing through the command's first slash also guarantees
    // progress without changing provider-authored text.
    if (isEscapedCharacter(tex, commandIndex)) {
      output.push(tex.slice(cursor, commandIndex + 1));
      cursor = commandIndex + 1;
      continue;
    }

    const openingBraceIndex = commandIndex + command.length - 1;
    const closingBraceIndex = findClosingTexBrace(tex, openingBraceIndex);
    if (closingBraceIndex === null) {
      output.push(tex.slice(cursor));
      break;
    }

    output.push(tex.slice(cursor, openingBraceIndex + 1));
    for (let bodyIndex = openingBraceIndex + 1; bodyIndex < closingBraceIndex; bodyIndex += 1) {
      const character = tex[bodyIndex] ?? "";
      if (character === "_" && !isEscapedCharacter(tex, bodyIndex)) {
        output.push("\\_");
      } else {
        output.push(character);
      }
    }
    output.push("}");
    cursor = closingBraceIndex + 1;
  }

  return output.join("");
}

function normalizeLiteralTextCommandsInMathChunk(markdown: string): string {
  const output: string[] = [];
  let cursor = 0;

  while (cursor < markdown.length) {
    const character = markdown[cursor] ?? "";

    // Markdown code spans can contain convincing-looking `$...$` examples.
    // Skip the complete span so render-time repairs never mutate literal code.
    if (character === "`") {
      const delimiterLength = characterRunLength(markdown, cursor, "`");
      const closingIndex = findClosingDelimiter(
        markdown,
        cursor + delimiterLength,
        "`",
        delimiterLength,
      );
      if (closingIndex !== null) {
        output.push(markdown.slice(cursor, closingIndex + delimiterLength));
        cursor = closingIndex + delimiterLength;
        continue;
      }
    }

    if (character !== "$" || isEscapedCharacter(markdown, cursor)) {
      output.push(character);
      cursor += 1;
      continue;
    }

    const delimiterLength = characterRunLength(markdown, cursor, "$");
    if (delimiterLength !== 1 && delimiterLength !== 2) {
      output.push(markdown.slice(cursor, cursor + delimiterLength));
      cursor += delimiterLength;
      continue;
    }

    const contentStart = cursor + delimiterLength;
    const closingIndex = findClosingDelimiter(markdown, contentStart, "$", delimiterLength);
    if (closingIndex === null) {
      output.push(markdown.slice(cursor, contentStart));
      cursor = contentStart;
      continue;
    }

    output.push(markdown.slice(cursor, contentStart));
    output.push(escapeTextttLiteralUnderscores(markdown.slice(contentStart, closingIndex)));
    output.push(markdown.slice(closingIndex, closingIndex + delimiterLength));
    cursor = closingIndex + delimiterLength;
  }

  return output.join("");
}

function normalizeLiteralTextCommandsInMath(text: string): string {
  // Provider models occasionally put source identifiers inside `\texttt`
  // without escaping underscores. KaTeX correctly treats those underscores as
  // invalid text-mode syntax and emits a visible red parse error. Repair only
  // normalized math regions, after all supported provider delimiter shapes
  // have become `$`/`$$`, while retaining raw persisted provider output.
  return transformOutsideFences(text, normalizeLiteralTextCommandsInMathChunk);
}

/**
 * Providers do not consistently delimit math. Normalize common chat output
 * shapes before the Markdown AST is built so KaTeX handles them as math, while
 * leaving ordinary non-math code fences untouched.
 */
export function normalizeChatMarkdownMath(text: string): string {
  return normalizeLiteralTextCommandsInMath(
    normalizeStandaloneMathParagraphs(
      normalizeLatexDelimiters(
        normalizeDollarDisplayDelimiters(
          normalizeTableRowMathDelimiters(normalizeMathFences(text)),
        ),
      ),
    ),
  );
}
