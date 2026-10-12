import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  GeneratedVisualizationBridgeJsonText,
  GeneratedVisualizationBridgeMessage,
  GeneratedVisualizationInput,
  GeneratedVisualizationInputJsonText,
  GeneratedVisualizationReference,
  GeneratedVisualizationReferenceJsonText,
} from "@cafecode/contracts/visualizations";

/**
 * Bound parser work independently of encoded bytes. A source string is one
 * token regardless of its contents; brackets inside code are not JSON nesting.
 * The current closed contracts need at most three nested containers and fewer
 * than 512 lexical tokens, including the complete sixteen-entry asset manifest.
 */
export const VISUALIZATION_JSON_MAX_DEPTH = 8;
export const VISUALIZATION_JSON_MAX_TOKENS = 512;

export type VisualizationJsonResult<A> =
  | { readonly status: "decoded"; readonly value: A }
  | { readonly status: "rejected" };

const rejected = Object.freeze({ status: "rejected" as const });

/**
 * This is only a pre-parser work fence, not another JSON implementation. JSON's
 * syntax and all property/value semantics remain the native parser's and the
 * exact schema's responsibility. Counting punctuation as well as value/key
 * tokens intentionally overcounts work: huge shallow arrays/objects must not
 * reach schema decoding merely because they fit the transport's byte ceiling.
 */
function withinJsonWorkBudget(text: string): boolean {
  let depth = 0;
  let tokens = 0;
  let inString = false;
  let escaped = false;
  let inPrimitive = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === " " || character === "\n" || character === "\r" || character === "\t") {
      inPrimitive = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      inPrimitive = false;
      tokens += 1;
    } else if (character === "{" || character === "[") {
      depth += 1;
      inPrimitive = false;
      tokens += 1;
      if (depth > VISUALIZATION_JSON_MAX_DEPTH) return false;
    } else if (character === "}" || character === "]") {
      depth -= 1;
      inPrimitive = false;
      tokens += 1;
      if (depth < 0) return false;
    } else if (character === "," || character === ":") {
      inPrimitive = false;
      tokens += 1;
    } else if (!inPrimitive) {
      inPrimitive = true;
      tokens += 1;
    }
    if (tokens > VISUALIZATION_JSON_MAX_TOKENS) return false;
  }
  return depth === 0 && !inString && tokens > 0;
}

function makeDecoder<S extends Schema.Codec<unknown, unknown, never, never>>(
  textSchema: Schema.Codec<string, string, never, never>,
  valueSchema: S,
): (input: unknown) => VisualizationJsonResult<S["Type"]> {
  const decodeText = Schema.decodeUnknownResult(textSchema);
  const decodeValue = Schema.decodeUnknownResult(valueSchema);

  return (input) => {
    try {
      // Result decoding deliberately avoids the synchronous throwing formatter:
      // its issue can contain the rejected source and formatter output can echo
      // that source. No issue, JSON.parse exception or received value is returned
      // on failure, even for malformed text or an exotic in-process object.
      const text = decodeText(input);
      if (Result.isFailure(text) || !withinJsonWorkBudget(text.success)) return rejected;
      const value = decodeValue(JSON.parse(text.success));
      if (Result.isFailure(value)) return rejected;
      return { status: "decoded", value: value.success };
    } catch {
      return rejected;
    }
  };
}

/**
 * These functions validate bounded data shapes only. A decoded purpose, UUID,
 * nonce or generation never proves ownership/publication/host qualification.
 * Future authenticated services must supply that independent authority. The
 * successful producer value remains private source, not a loggable summary.
 */
export const decodeGeneratedVisualizationInputJson = makeDecoder(
  GeneratedVisualizationInputJsonText,
  GeneratedVisualizationInput,
);
/** The generated-tool transport has its own encoded-byte ceiling, independent
 * of native App messages and their escaped HTTP envelopes. This pre-parser
 * accepts bounded JSON only; the SDK still validates the protocol envelope and
 * the tool/store's closed schema still validates every generated input. Its
 * decoded value conveys no session, tool, publication or native authority. */
export const decodeGeneratedVisualizationTransportJson = makeDecoder(
  GeneratedVisualizationInputJsonText,
  Schema.Unknown,
);
export const decodeGeneratedVisualizationReferenceJson = makeDecoder(
  GeneratedVisualizationReferenceJsonText,
  GeneratedVisualizationReference,
);
export const decodeGeneratedVisualizationBridgeJson = makeDecoder(
  GeneratedVisualizationBridgeJsonText,
  GeneratedVisualizationBridgeMessage,
);
