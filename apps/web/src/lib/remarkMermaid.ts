// oxlint-disable-next-line unicorn/require-module-specifiers -- This type-only import loads remark-parse's unified.Data augmentation without adding runtime code.
import type {} from "remark-parse";
import type { Processor } from "unified";

/**
 * Admit only explicitly tagged Mermaid fences and retain their parser-proven
 * completion state. Markdown considers an unclosed fence a valid code block,
 * including when a surrounding list/blockquote ends or a transcript is cut
 * short, so message streaming state cannot tell us whether rendering is safe.
 */
// oxlint-disable oxc/no-this-in-exported-function -- Unified explicitly binds plugins to their processor and token handlers to their compiler context.
export function remarkMermaid(this: Processor): void {
  const rootsWithMermaidFences = new WeakSet<object>();
  const explicitFences = new WeakSet<object>();
  const closedFences = new WeakSet<object>();
  const data = this.data();
  const extensions = (data.fromMarkdownExtensions ??= []);

  extensions.push({
    enter: {
      codeFencedFence(token) {
        const node = this.stack.findLast((entry) => entry.type === "code");
        if (node?.type !== "code") return;

        if (!this.data.flowCodeInside) {
          // Inspect only the parser's opening-fence token, never search or
          // rewrite the document with a fence regular expression. Require a
          // literal language label so encoded lookalikes cannot bypass the
          // normalizer's cheap "mermaid" admission check.
          if (/^(?:`{3,}|~{3,})[ \t]*mermaid(?:[ \t]|$)/.test(this.sliceSerialize(token))) {
            explicitFences.add(node);
            const root = this.stack[0];
            if (root) rootsWithMermaidFences.add(root);
          }
          return;
        }
        // The upstream compiler sets this flag only after the opening fence.
        // A second codeFencedFence token therefore proves an actual matching
        // closer, including marker kind/length, indentation and containers.
        // Short runs, inline backticks and runs followed by text never reach
        // this path as closers. Do not override upstream exit handlers: they
        // own buffering, language decoding and exact code-value construction.
        if (explicitFences.has(node) && node.lang === "mermaid") {
          closedFences.add(node);
        }
      },
    },
    transforms: [
      (tree) => {
        // Ordinary messages do not need a second AST walk on each streamed
        // update. Tokenization already tells us whether this tree has work.
        if (!rootsWithMermaidFences.has(tree)) return;
        const pending: Array<typeof tree | (typeof tree.children)[number]> = [tree];
        while (pending.length > 0) {
          const node = pending.pop();
          if (!node) continue;
          if (node.type === "code" && node.lang === "mermaid" && explicitFences.has(node)) {
            // Carry the mdast value separately: mdast-to-hast adds a display
            // newline to code children. Copying those children would silently
            // change the DSL every time a diagram is copied or re-rendered.
            node.data = {
              ...node.data,
              hProperties: {
                ...node.data?.hProperties,
                "data-mermaid-source": node.value,
                "data-mermaid-complete": closedFences.has(node) ? "true" : "false",
              },
            };
          } else if ("children" in node) {
            // Keep this one bounded walk iterative, including for deeply
            // nested provider-authored list/blockquote content.
            for (const child of node.children) pending.push(child);
          }
        }
      },
    ],
  });
}
// oxlint-enable oxc/no-this-in-exported-function
