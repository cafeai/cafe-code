import { randomUUID } from "node:crypto";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  VisualizationHostConnection,
  VisualizationHostDocument,
  VisualizationHostOpenInput,
  VisualizationHostPresentation,
  VisualizationHostPrepareInput,
  VisualizationHostPreviewInput,
} from "./visualizationHost.ts";

describe("private visualization native host schemas", () => {
  it("admits only exact loopback discovery with opaque generation and bearer", () => {
    const decode = Schema.decodeUnknownResult(VisualizationHostConnection);
    const value = {
      version: 1,
      generation: randomUUID(),
      token: "a".repeat(64),
      url: "http://127.0.0.1:1234/visualizations",
    };
    expect(Result.isSuccess(decode(value))).toBe(true);
    for (const url of [
      "https://127.0.0.1:1234/visualizations",
      "http://localhost:1234/visualizations",
      "http://127.0.0.1:1234/visualizations?secret=1",
      "http://127.0.0.1:1234/other",
    ])
      expect(Result.isFailure(decode({ ...value, url }))).toBe(true);
    expect(Result.isFailure(decode({ ...value, source: "private" }))).toBe(true);
  });
  it("keeps source private and uses the same admitted viewport range", () => {
    const decode = Schema.decodeUnknownResult(VisualizationHostDocument);
    const document = {
      kind: "generated",
      html: "<p>日本語 🐈</p>",
      assets: [],
      width: 1600,
      height: 2000,
      appearance: "dark",
    };
    expect(Result.isSuccess(decode(document))).toBe(true);
    expect(Result.isSuccess(decode({ ...document, height: 80 }))).toBe(true);
    for (const patch of [
      { html: "日".repeat((512 * 1024) / 3 + 1) },
      { height: 2001 },
      {
        assets: Array.from({ length: 17 }, () => ({
          id: "image",
          mime: "image/png",
          base64: "AAAA",
        })),
      },
      { html: "\ud800" },
      { path: "/secret" },
    ])
      expect(Result.isFailure(decode({ ...document, ...patch }))).toBe(true);
  });
  it("accepts no renderer source, URL or native path selector", () => {
    const value = {
      ticket: "a".repeat(64),
      bounds: { x: 0, y: 0, width: 400, height: 200 },
      appearance: "light",
    };
    const decode = Schema.decodeUnknownResult(VisualizationHostOpenInput);
    expect(Result.isSuccess(decode(value))).toBe(true);
    for (const field of ["html", "url", "path", "owner", "documentGeneration"])
      expect(Result.isFailure(decode({ ...value, [field]: "private" }))).toBe(true);
    expect(
      Result.isFailure(decode({ ...value, bounds: { ...value.bounds, width: Infinity } })),
    ).toBe(true);
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(VisualizationHostPrepareInput)({ ...value, document: "wrong" }),
      ),
    ).toBe(true);
  });
  it("admits finite color-only presentation and refuses executable CSS", () => {
    const color = "#123456";
    const colors = {
      background: color,
      foreground: color,
      muted: color,
      accent: color,
      accentForeground: color,
      chart1: color,
      chart2: color,
      chart3: color,
      chart4: color,
      chart5: color,
      chart6: color,
    };
    const value = { locale: "en", reducedMotion: true, scale: 1, colors };
    const decode = Schema.decodeUnknownResult(VisualizationHostPresentation);
    expect(Result.isSuccess(decode(value))).toBe(true);
    for (const accent of [
      "url(file:///secret)",
      "red;display:none",
      "var(--secret)",
      "expression(alert(1))",
    ])
      expect(Result.isFailure(decode({ ...value, colors: { ...colors, accent } }))).toBe(true);
    expect(Result.isFailure(decode({ ...value, scale: NaN }))).toBe(true);
    expect(Result.isFailure(decode({ ...value, provider: "secret" }))).toBe(true);
  });
  it("admits bounded original replay only for a private App preview", () => {
    const owner = { environmentId: "fixture", threadId: "fixture", operationId: randomUUID() };
    const document = {
      kind: "mcp-app",
      html: "<p>private</p>",
      assets: [],
      width: 400,
      height: 200,
      appearance: "light",
    };
    const previewReplay = {
      originalInputJson: '{"private":"input"}',
      originalResultJson: '{"content":[]}',
    };
    const decode = Schema.decodeUnknownResult(VisualizationHostPreviewInput);
    expect(Result.isSuccess(decode({ owner, document, previewReplay }))).toBe(true);
    for (const value of [
      { owner, document },
      { owner, document: { ...document, kind: "generated" }, previewReplay },
      { owner, document, previewReplay: { ...previewReplay, path: "/private" } },
      {
        owner,
        document,
        previewReplay: { ...previewReplay, originalInputJson: "日".repeat(128 * 1024) },
      },
    ])
      expect(Result.isFailure(decode(value))).toBe(true);
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(VisualizationHostDocument)({ ...document, previewReplay }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(VisualizationHostPrepareInput)({
          ticket: "a".repeat(64),
          owner,
          document,
          previewReplay,
        }),
      ),
    ).toBe(true);
  });
});
