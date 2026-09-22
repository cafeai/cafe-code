import type { Construct } from "micromark-util-types";
import remarkMath from "remark-math";
// oxlint-disable-next-line unicorn/require-module-specifiers -- This type-only import loads remark-parse's unified.Data augmentation without adding runtime code.
import type {} from "remark-parse";
import type { Processor } from "unified";

import { hasChatInlineMathBoundaries } from "./chatMarkdownMath";

const DOLLAR = 36;

function guardCurrency(construct: Construct): Construct {
  return {
    ...construct,
    tokenize(effects, ok, nok) {
      const start = this.now();

      // Delegate tokenization, code/escape handling, and math AST construction
      // to remark-math. Its mathText tokenizer calls `ok` just after the closing
      // dollar run, while rejection here still rolls the whole attempt back.
      // A remark AST transform would be too late: swallowed emphasis and links
      // would already have been reduced to opaque TeX text.
      return construct.tokenize.call(
        this,
        effects,
        (code) => {
          const source = this.sliceSerialize({ start, end: this.now() });
          if (source[1] !== "$" && !hasChatInlineMathBoundaries(source, code)) {
            return nok(code);
          }
          return ok(code);
        },
        nok,
      );
    },
  };
}

/** Keep currency out of single-dollar math without rewriting provider text. */
// oxlint-disable oxc/no-this-in-exported-function -- Unified explicitly calls plugin functions with the processor as `this`; this is not an unbound application callback.
function remarkChatMath(this: Processor): void {
  remarkMath.call(this, { singleDollarTextMath: true });

  // remark-math 6 registers one micromark extension per invocation. Wrap only
  // that extension's inline-dollar construct; keep upstream display math and
  // all other Markdown constructs (including URLs and literal code) untouched.
  const extension = this.data().micromarkExtensions?.at(-1);
  const inlineMath = extension?.text?.[DOLLAR];
  if (extension?.text && inlineMath) {
    extension.text[DOLLAR] = Array.isArray(inlineMath)
      ? inlineMath.map(guardCurrency)
      : guardCurrency(inlineMath);
  }
}
// oxlint-enable oxc/no-this-in-exported-function

export { remarkChatMath };
