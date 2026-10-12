import { afterEach, describe, expect, it, vi } from "vitest";

import {
  VISUALIZATION_MAX_BRIDGE_BYTES,
  VISUALIZATION_MAX_INPUT_JSON_BYTES,
  VISUALIZATION_MAX_REFERENCE_JSON_BYTES,
} from "@cafecode/contracts/visualizations";
import {
  decodeGeneratedVisualizationBridgeJson,
  decodeGeneratedVisualizationInputJson,
  decodeGeneratedVisualizationReferenceJson,
  decodeGeneratedVisualizationTransportJson,
  VISUALIZATION_JSON_MAX_DEPTH,
  VISUALIZATION_JSON_MAX_TOKENS,
} from "./visualizationJson.ts";

const id = "d6cba977-2c7a-4a97-94ae-e4b01e316d05";
const input = {
  version: 1,
  purpose: "generated-visualization",
  requestId: id,
  source: '<script>const sample = {"日本語": [1, 2]};</script>',
  title: "Local chart",
  assets: [],
  appearance: "auto",
};
const reference = {
  version: 1,
  purpose: "generated-visualization",
  artifactId: id,
  revisionId: id,
  title: "Local chart",
  width: 640,
  height: 480,
};
const bridge = {
  version: 1,
  artifactId: id,
  revisionId: id,
  hostGeneration: id,
  documentGeneration: id,
  nonce: "a".repeat(64),
  sequence: 1,
  kind: "document.health",
  status: "ready",
};

afterEach(() => vi.restoreAllMocks());

describe("bounded visualization JSON decoding", () => {
  it("preserves exact received source rather than trimming, evaluating or formatting it", () => {
    const source = `  ${input.source}\n\\\\"[{]}"\n  `;
    const value = { ...input, source };
    expect(decodeGeneratedVisualizationInputJson(JSON.stringify(value))).toEqual({
      status: "decoded",
      value,
    });
    expect(decodeGeneratedVisualizationReferenceJson(JSON.stringify(reference))).toEqual({
      status: "decoded",
      value: reference,
    });
    expect(decodeGeneratedVisualizationBridgeJson(JSON.stringify(bridge))).toEqual({
      status: "decoded",
      value: bridge,
    });
  });

  it("admits the full bounded manifest without mistaking source brackets for nesting", () => {
    const value = {
      ...input,
      source: `${"[".repeat(1000)}${"}".repeat(1000)}\n${input.source}`,
      assets: Array.from({ length: 16 }, (_, index) => ({
        assetId: `asset-${index}`,
        attachmentId: id,
      })),
    };
    expect(decodeGeneratedVisualizationInputJson(JSON.stringify(value)).status).toBe("decoded");
  });

  it("admits a generated tool envelope beyond native App limits with exact Unicode and sixteen aliases", () => {
    const argumentsValue = {
      ...input,
      source: `<main>${'🌸"\\'.repeat(35_000)}</main>`,
      assets: Array.from({ length: 16 }, (_, index) => ({
        assetId: `asset-${index}`,
        attachmentId: id,
      })),
      viewport: { width: 640, height: 480 },
    };
    const envelope = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "preview_visualization", arguments: argumentsValue },
    };
    const encoded = JSON.stringify(envelope);
    expect(new TextEncoder().encode(encoded).byteLength).toBeGreaterThan(128 * 1024);
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThan(
      VISUALIZATION_MAX_INPUT_JSON_BYTES,
    );
    expect(decodeGeneratedVisualizationTransportJson(encoded)).toEqual({
      status: "decoded",
      value: envelope,
    });
    expect(decodeGeneratedVisualizationInputJson(JSON.stringify(argumentsValue))).toEqual({
      status: "decoded",
      value: argumentsValue,
    });
  });

  it.each([
    [decodeGeneratedVisualizationInputJson, VISUALIZATION_MAX_INPUT_JSON_BYTES],
    [decodeGeneratedVisualizationTransportJson, VISUALIZATION_MAX_INPUT_JSON_BYTES],
    [decodeGeneratedVisualizationReferenceJson, VISUALIZATION_MAX_REFERENCE_JSON_BYTES],
    [decodeGeneratedVisualizationBridgeJson, VISUALIZATION_MAX_BRIDGE_BYTES],
  ] as const)("refuses oversized text before native parsing", (decode, bound) => {
    const parse = vi.spyOn(JSON, "parse");
    expect(decode(" ".repeat(bound + 1))).toEqual({ status: "rejected" });
    // Fewer UTF-16 units than the ceiling can still overflow actual UTF-8.
    expect(decode('"' + "界".repeat(Math.ceil(bound / 3)) + '"')).toEqual({
      status: "rejected",
    });
    expect(parse).not.toHaveBeenCalled();
  });

  it("refuses excessive nesting and shallow token floods before JSON.parse", () => {
    const parse = vi.spyOn(JSON, "parse");
    const nesting = VISUALIZATION_JSON_MAX_DEPTH + 1;
    expect(
      decodeGeneratedVisualizationInputJson("[".repeat(nesting) + "0" + "]".repeat(nesting)),
    ).toEqual({ status: "rejected" });
    const flood = JSON.stringify(Array.from({ length: VISUALIZATION_JSON_MAX_TOKENS }, () => 0));
    expect(decodeGeneratedVisualizationInputJson(flood)).toEqual({ status: "rejected" });
    expect(parse).not.toHaveBeenCalled();
  });

  it("fences generated transport depth and lexical tokens before parsing or allocating values", () => {
    const parse = vi.spyOn(JSON, "parse");
    const nesting = VISUALIZATION_JSON_MAX_DEPTH + 1;
    const nested = "[".repeat(nesting) + "0" + "]".repeat(nesting);
    const flood = JSON.stringify(Array.from({ length: VISUALIZATION_JSON_MAX_TOKENS }, () => 0));
    for (const encoded of [nested, flood, '"\ud800"'])
      expect(decodeGeneratedVisualizationTransportJson(encoded)).toEqual({ status: "rejected" });
    expect(parse).not.toHaveBeenCalled();
  });

  it("returns no raw parse/schema issue, exception, source or selected field on rejection", () => {
    const sentinel = "PRIVATE_SOURCE_SENTINEL";
    for (const value of [
      `{${sentinel}`,
      JSON.stringify({ ...input, source: sentinel, accountId: sentinel }),
      JSON.stringify({ ...reference, source: sentinel }),
      JSON.stringify({ ...bridge, method: "tools/call", arguments: { secret: sentinel } }),
      JSON.stringify({ ...input, assets: [{ assetId: "safe", attachmentId: id, path: sentinel }] }),
    ]) {
      for (const decode of [
        decodeGeneratedVisualizationInputJson,
        decodeGeneratedVisualizationReferenceJson,
        decodeGeneratedVisualizationBridgeJson,
      ]) {
        const result = decode(value);
        expect(result).toEqual({ status: "rejected" });
        expect(JSON.stringify(result)).not.toContain(sentinel);
      }
    }
  });

  it("does not coerce objects or invoke their string conversion", () => {
    const stringify = vi.fn(() => JSON.stringify(input));
    for (const value of [null, 0, [], { toString: stringify }, new String(JSON.stringify(input))]) {
      expect(decodeGeneratedVisualizationInputJson(value)).toEqual({ status: "rejected" });
    }
    expect(stringify).not.toHaveBeenCalled();
  });

  it.each([
    "",
    "\t \r\n",
    "{} {}",
    '[{"unfinished": "value}',
    '"unterminated\\',
    '{"n":NaN}',
    '{"n":Infinity}',
    JSON.stringify({ ...reference, width: 1e100 }),
  ])("refuses malformed or unsupported JSON without escaping an error", (text) => {
    expect(decodeGeneratedVisualizationReferenceJson(text)).toEqual({ status: "rejected" });
  });
});
