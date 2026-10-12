import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  GeneratedVisualizationAssets,
  GeneratedVisualizationBridgeJsonText,
  GeneratedVisualizationBridgeMessage,
  GeneratedVisualizationDiagnostics,
  GeneratedVisualizationInput,
  GeneratedVisualizationInputJsonText,
  GeneratedVisualizationReference,
  GeneratedVisualizationReferenceJsonText,
  GeneratedVisualizationSource,
  GeneratedVisualizationSourceText,
  GeneratedVisualizationViewport,
  VISUALIZATION_LIMITS_VERSION,
  VISUALIZATION_MAX_ASSETS,
  VISUALIZATION_MAX_BRIDGE_BYTES,
  VISUALIZATION_MAX_DIAGNOSTIC_RECORDS,
  VISUALIZATION_MAX_DIAGNOSTICS_BYTES,
  VISUALIZATION_MAX_INPUT_JSON_BYTES,
  VISUALIZATION_MAX_REFERENCE_JSON_BYTES,
  VISUALIZATION_MAX_SOURCE_BYTES,
  VisualizationFailureClassification,
} from "./visualizations.ts";

const decodeInput = Schema.decodeUnknownSync(GeneratedVisualizationInput);
const encodeInput = Schema.encodeSync(GeneratedVisualizationInput);
const decodeReference = Schema.decodeUnknownSync(GeneratedVisualizationReference);
const encodeReference = Schema.encodeSync(GeneratedVisualizationReference);
const decodeSource = Schema.decodeUnknownSync(GeneratedVisualizationSource);

const artifactId = "12345678-1234-4123-8123-123456789abc";
const revisionId = "23456789-2345-4234-8234-23456789abcd";
const requestId = "34567890-3456-4345-8345-34567890abcd";
const assets = [{ assetId: "chart-image", attachmentId: "uploaded_image-1" }];
const input = {
  version: VISUALIZATION_LIMITS_VERSION,
  purpose: "generated-visualization",
  requestId,
  source: "  <!doctype html>\n<p>日本語 🐈</p>\n ",
  title: "  Received chart title  ",
  assets,
  appearance: "auto",
  viewport: { width: 1200, height: 800 },
} as const;
const reference = {
  version: VISUALIZATION_LIMITS_VERSION,
  purpose: "generated-visualization",
  artifactId,
  revisionId,
  title: "Chart",
  width: 1200,
  height: 800,
  poster: { id: requestId, width: 1200, height: 800 },
} as const;
const bridge = {
  version: VISUALIZATION_LIMITS_VERSION,
  artifactId,
  revisionId,
  hostGeneration: requestId,
  documentGeneration: artifactId,
  nonce: "ab".repeat(32),
  sequence: 1,
  kind: "document.size",
  width: 1200,
  height: 800,
} as const;
const diagnostics = {
  version: VISUALIZATION_LIMITS_VERSION,
  artifactId,
  revisionId,
  records: [{ classification: "capture-failed", message: "Synthetic received failure" }],
  truncated: false,
} as const;

describe("generated visualization data boundaries", () => {
  it("retains exact source and display metadata without trimming or public source copies", () => {
    const decoded = decodeInput(input);
    expect(decoded.source).toBe(input.source);
    expect(decoded.title).toBe(input.title);
    expect(encodeInput(decoded)).toEqual(input);
    const compact = decodeReference(reference);
    expect(encodeReference(compact)).toEqual(reference);
    expect(Object.keys(compact).toSorted()).toEqual(Object.keys(reference).toSorted());
    const privateSource = {
      version: 1,
      purpose: input.purpose,
      artifactId,
      revisionId,
      source: input.source,
      assets,
    };
    expect(decodeSource(privateSource).source).toBe(input.source);
  });

  it("bounds actual source UTF-8 bytes for ASCII, Japanese and supplementary characters", () => {
    const decode = Schema.decodeUnknownResult(GeneratedVisualizationSourceText);
    for (const source of [
      "a".repeat(VISUALIZATION_MAX_SOURCE_BYTES),
      "日".repeat(Math.floor(VISUALIZATION_MAX_SOURCE_BYTES / 3)) + "aa",
      "🐈".repeat(VISUALIZATION_MAX_SOURCE_BYTES / 4),
    ]) {
      expect(Result.isSuccess(decode(source))).toBe(true);
      expect(Result.isFailure(decode(source + "a"))).toBe(true);
    }
    // Never use the throwing formatter for a large rejected source. Its issue
    // may retain actual input; tests inspect only the bounded success/failure tag.
    expect(Result.isFailure(decode("日".repeat(VISUALIZATION_MAX_SOURCE_BYTES)))).toBe(true);
    expect(Result.isFailure(decode(""))).toBe(true);
  });

  it("refuses unpaired surrogates instead of silently replacing immutable source", () => {
    const decode = Schema.decodeUnknownResult(GeneratedVisualizationSourceText);
    for (const source of ["\ud800", "\udc00", "x\ud800x", "\ud800\ud800", "\udc00\ud800"])
      expect(Result.isFailure(decode(source))).toBe(true);
    expect(Result.isSuccess(decode("\ud800\udc00"))).toBe(true);
  });

  it("keeps raw wire text separately byte-bounded without pretending it parses JSON", () => {
    const bounds = [
      [GeneratedVisualizationInputJsonText, VISUALIZATION_MAX_INPUT_JSON_BYTES],
      [GeneratedVisualizationReferenceJsonText, VISUALIZATION_MAX_REFERENCE_JSON_BYTES],
      [GeneratedVisualizationBridgeJsonText, VISUALIZATION_MAX_BRIDGE_BYTES],
    ] as const;
    for (const [schema, maximum] of bounds) {
      const decode = Schema.decodeUnknownResult(schema);
      expect(Result.isSuccess(decode("a".repeat(maximum)))).toBe(true);
      expect(Result.isFailure(decode("a".repeat(maximum + 1)))).toBe(true);
      expect(Result.isSuccess(decode("🐈".repeat(maximum / 4)))).toBe(true);
      expect(Result.isFailure(decode("🐈".repeat(maximum / 4) + "a"))).toBe(true);
      expect(Result.isFailure(decode("\ud800"))).toBe(true);
      expect(Result.isFailure(decode(""))).toBe(true);
    }
    expect(
      Result.isSuccess(Schema.decodeUnknownResult(GeneratedVisualizationInputJsonText)("not JSON")),
    ).toBe(true);
  });

  it("rejects owner, authority, path, network and prototype selectors without caller options", () => {
    const decode = Schema.decodeUnknownResult(GeneratedVisualizationInput);
    for (const key of [
      "accountId",
      "threadId",
      "chatId",
      "runtimeId",
      "server",
      "url",
      "outputPath",
      "permissions",
      "constructor",
      "prototype",
    ])
      expect(Result.isFailure(decode({ ...input, [key]: "untrusted" }))).toBe(true);
    const prototypeSelector: unknown = JSON.parse('{"__proto__":{"authority":true}}');
    expect(Result.isFailure(decode({ ...input, ...Object(prototypeSelector) }))).toBe(true);
    for (const key of ["path", "url", "mimeType", "digest", "ownerId"])
      expect(
        Result.isFailure(decode({ ...input, assets: [{ ...assets[0], [key]: "untrusted" }] })),
      ).toBe(true);
    expect(
      Result.isFailure(decode({ ...input, viewport: { ...input.viewport, threadId: "other" } })),
    ).toBe(true);
  });

  it("requires the dedicated purpose/version and opaque canonical request identity", () => {
    const decode = Schema.decodeUnknownResult(GeneratedVisualizationInput);
    for (const purpose of ["image", "file", "mcp-app", "text/html", "generated-visualization "])
      expect(Result.isFailure(decode({ ...input, purpose }))).toBe(true);
    for (const requestId of [
      "../secret",
      "https://host.invalid",
      "",
      "34567890-3456-4345-8345-34567890ABCD",
    ])
      expect(Result.isFailure(decode({ ...input, requestId }))).toBe(true);
    expect(Result.isFailure(decode({ ...input, version: 2 }))).toBe(true);
  });

  it("admits finite unique logical asset aliases, never file/URL metadata", () => {
    const decode = Schema.decodeUnknownResult(GeneratedVisualizationAssets);
    expect(Result.isSuccess(decode([]))).toBe(true);
    const maximum = Array.from({ length: VISUALIZATION_MAX_ASSETS }, (_, index) => ({
      assetId: `asset-${index}`,
      attachmentId: "same_uploaded_attachment",
    }));
    // One owned attachment can have distinct logical aliases; ownership is not
    // inferred here, and duplicate logical names cannot hide resource replacement.
    expect(Result.isSuccess(decode(maximum))).toBe(true);
    expect(
      Result.isFailure(decode([...maximum, { assetId: "extra", attachmentId: "upload" }])),
    ).toBe(true);
    expect(Result.isFailure(decode([assets[0], assets[0]]))).toBe(true);
    for (const attachmentId of [
      "/private.png",
      "C:\\private.png",
      "../private",
      "https://host/image",
      "a".repeat(129),
      " upload",
      "upload\u0000",
    ])
      expect(Result.isFailure(decode([{ assetId: "asset", attachmentId }]))).toBe(true);
    for (const assetId of ["../asset", "", "a".repeat(65), "image.svg", "https://host"])
      expect(Result.isFailure(decode([{ assetId, attachmentId: "upload" }]))).toBe(true);
  });

  it("refuses nonfinite/out-of-range geometry and control-bearing titles", () => {
    const viewport = Schema.decodeUnknownResult(GeneratedVisualizationViewport);
    for (const width of [NaN, Infinity, -Infinity, 239, 1601, 1200.5])
      expect(Result.isFailure(viewport({ width, height: 800 }))).toBe(true);
    for (const height of [NaN, Infinity, -Infinity, 79, 2001, 800.5])
      expect(Result.isFailure(viewport({ width: 1200, height }))).toBe(true);
    expect(Result.isSuccess(viewport({ width: 240, height: 80 }))).toBe(true);
    expect(Result.isSuccess(viewport({ width: 1600, height: 2000 }))).toBe(true);
    const decode = Schema.decodeUnknownResult(GeneratedVisualizationInput);
    for (const title of [
      "",
      "  ",
      "x\ny",
      "x\u0000y",
      "x\u007fy",
      "x\u202ey",
      "x\ud800",
      "a".repeat(161),
    ])
      expect(Result.isFailure(decode({ ...input, title }))).toBe(true);
  });

  it("rejects private source, proof and diagnostic leakage at compact nested references", () => {
    const decode = Schema.decodeUnknownResult(GeneratedVisualizationReference);
    for (const key of [
      "source",
      "html",
      "diagnostics",
      "digest",
      "completionProof",
      "path",
      "assets",
      "reference",
    ])
      expect(Result.isFailure(decode({ ...reference, [key]: "private-sentinel" }))).toBe(true);
    for (const key of ["source", "url", "path", "digest", "capability"])
      expect(
        Result.isFailure(
          decode({ ...reference, poster: { ...reference.poster, [key]: "private-sentinel" } }),
        ),
      ).toBe(true);
    expect(
      Result.isFailure(
        decode({ ...reference, poster: { ...reference.poster, width: 8192, height: 8192 } }),
      ),
    ).toBe(true);
    expect(Result.isFailure(decode({ ...reference, purpose: "file" }))).toBe(true);
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(GeneratedVisualizationSource)({
          ...reference,
          source: input.source,
          assets,
        }),
      ),
    ).toBe(true);
  });

  it("keeps diagnostics private, finite, and bounded including encoded JSON escapes", () => {
    const decode = Schema.decodeUnknownResult(GeneratedVisualizationDiagnostics);
    expect(Result.isSuccess(decode(diagnostics))).toBe(true);
    expect(Result.isFailure(decode({ ...diagnostics, html: input.source }))).toBe(true);
    expect(
      Result.isFailure(
        decode({ ...diagnostics, records: [{ ...diagnostics.records[0], auth: "private" }] }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        decode({
          ...diagnostics,
          records: [{ classification: "arbitrary-provider-error", message: "x" }],
        }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        decode({
          ...diagnostics,
          records: [{ classification: "timeout", message: "x".repeat(501) }],
        }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        decode({ ...diagnostics, records: [{ classification: "timeout", message: "\ud800" }] }),
      ),
    ).toBe(true);
    const records = Array.from({ length: VISUALIZATION_MAX_DIAGNOSTIC_RECORDS }, () => ({
      classification: "timeout",
      message: "x",
    }));
    expect(Result.isSuccess(decode({ ...diagnostics, records }))).toBe(true);
    expect(Result.isFailure(decode({ ...diagnostics, records: [...records, records[0]] }))).toBe(
      true,
    );
    const escaped = {
      ...diagnostics,
      records: records.map((record) => ({
        classification: record.classification,
        message: "\u0000".repeat(500),
      })),
    };
    expect(
      new TextEncoder().encode(JSON.stringify(escaped)).byteLength >
        VISUALIZATION_MAX_DIAGNOSTICS_BYTES,
    ).toBe(true);
    expect(Result.isFailure(decode(escaped))).toBe(true);
    const unicode = {
      ...diagnostics,
      records: records.map((record) => ({
        classification: record.classification,
        message: "日".repeat(500),
      })),
    };
    expect(Result.isFailure(decode(unicode))).toBe(true);
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(VisualizationFailureClassification)("secret error body"),
      ),
    ).toBe(true);
  });

  it("bounds generation-tagged presentation observations without admitting App methods", () => {
    const decode = Schema.decodeUnknownResult(GeneratedVisualizationBridgeMessage);
    expect(Result.isSuccess(decode(bridge))).toBe(true);
    const { width: _width, height: _height, ...binding } = bridge;
    expect(Result.isSuccess(decode({ ...binding, kind: "document.health", status: "ready" }))).toBe(
      true,
    );
    expect(
      Result.isFailure(
        decode({ ...binding, kind: "document.health", status: "ready", source: input.source }),
      ),
    ).toBe(true);
    for (const sequence of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(Result.isFailure(decode({ ...bridge, sequence }))).toBe(true);
    for (const key of ["artifactId", "revisionId", "hostGeneration", "documentGeneration"])
      expect(Result.isFailure(decode({ ...bridge, [key]: "unknown-generation" }))).toBe(true);
    expect(Result.isFailure(decode({ ...bridge, nonce: "ab".repeat(31) }))).toBe(true);
    expect(Result.isFailure(decode({ ...bridge, nonce: "AB".repeat(32) }))).toBe(true);
    for (const kind of [
      "tools/call",
      "resources/read",
      "ui/message",
      "open-link",
      "host.presentation",
    ])
      expect(Result.isFailure(decode({ ...bridge, kind }))).toBe(true);
    for (const key of [
      "method",
      "arguments",
      "url",
      "authorized",
      "retired",
      "credentials",
      "rawJson",
    ])
      expect(Result.isFailure(decode({ ...bridge, [key]: "untrusted" }))).toBe(true);
  });
});
