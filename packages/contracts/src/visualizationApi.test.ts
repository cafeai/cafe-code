import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  VisualizationDiscardViewerTicketInput,
  VisualizationDiscardViewerTicketResult,
  VisualizationInlineInput,
  VisualizationInlineResult,
  VisualizationInlineFrameInput,
  VisualizationInlineFrameResult,
  VisualizationInlineFrameRetireResult,
} from "./visualizationApi.ts";

const decodeInput = Schema.decodeUnknownResult(VisualizationDiscardViewerTicketInput);
const decodeResult = Schema.decodeUnknownResult(VisualizationDiscardViewerTicketResult);
const tuple = {
  threadId: "isolated-chat",
  artifactId: "00000000-0000-4000-8000-000000000001",
  revisionId: "00000000-0000-4000-8000-000000000002",
};

describe("exact unused visualization ticket contracts", () => {
  it("admits only an opaque ticket and the complete owned tuple", () => {
    const input = { ...tuple, ticket: "a".repeat(64) };
    expect(Result.isSuccess(decodeInput(input))).toBe(true);
    for (const patch of [
      { ticket: "a".repeat(63) },
      { ticket: "A".repeat(64) },
      { ticket: `${input.ticket}/other` },
      { ticket: { value: input.ticket } },
      { artifactId: undefined },
      { threadId: "x".repeat(201) },
      { source: "private-source" },
      { owner: { operationId: tuple.revisionId } },
      { leaseId: tuple.revisionId },
      { hostGeneration: tuple.revisionId },
      { revoke: true },
    ])
      expect(Result.isFailure(decodeInput({ ...input, ...patch }))).toBe(true);
  });
  it("keeps native false finite and never returns private ticket or source data", () => {
    for (const discarded of [true, false])
      expect(Result.isSuccess(decodeResult({ ...tuple, discarded }))).toBe(true);
    for (const patch of [
      { discarded: "false" },
      { ticket: "a".repeat(64) },
      { source: "private-source" },
      { owner: { threadId: tuple.threadId } },
      { error: "private-diagnostic" },
    ])
      expect(Result.isFailure(decodeResult({ ...tuple, discarded: false, ...patch }))).toBe(true);
  });
});

describe("owned Full-access inline browser contracts", () => {
  const grant = {
    ...tuple,
    frameId: "00000000-0000-4000-8000-000000000003",
    ticket: "b".repeat(64),
  };
  const output = {
    ...grant,
    purpose: "generated-visualization",
    fullAccess: true,
    html: "<main>🌸</main>",
    expiresAtMs: 30_000,
  };
  const decodeInline = Schema.decodeUnknownResult(VisualizationInlineResult);
  it("separates executable admission from private diagnostics and permission requests", () => {
    expect(Result.isSuccess(Schema.decodeUnknownResult(VisualizationInlineInput)(tuple))).toBe(
      true,
    );
    expect(Result.isSuccess(decodeInline(output))).toBe(true);
    expect(Result.isSuccess(decodeInline({ ...output, purpose: "mcp-app" }))).toBe(true);
    for (const patch of [
      { fullAccess: undefined },
      { fullAccess: false },
      { rawJson: "private raw request" },
      { diagnostics: [] },
      { receipt: { proof: "a".repeat(64) } },
      { authority: { mode: "full-access" } },
      { source: "private source" },
      { purpose: "unknown" },
      { html: "" },
      { html: "\ud800" },
      { html: "\udfff" },
      { html: "🌸".repeat(4 * 1024 * 1024 + 1) },
      { html: "a".repeat(16 * 1024 * 1024 + 1) },
    ])
      expect(Result.isFailure(decodeInline({ ...output, ...patch }))).toBe(true);
  });
  it("admits only the complete exact tuple and finite backend action grant", () => {
    const decodeGrant = Schema.decodeUnknownResult(VisualizationInlineFrameInput);
    expect(Result.isSuccess(decodeGrant(grant))).toBe(true);
    for (const patch of [
      { frameId: "not-a-frame" },
      { ticket: "B".repeat(64) },
      { ticket: "b".repeat(63) },
      { revisionId: undefined },
      { fullAccess: true },
      { expiresAtMs: Number.MAX_SAFE_INTEGER },
      { owner: {} },
    ])
      expect(Result.isFailure(decodeGrant({ ...grant, ...patch }))).toBe(true);
    const result = { ...tuple, frameId: grant.frameId, expiresAtMs: 30_000 };
    expect(
      Result.isSuccess(Schema.decodeUnknownResult(VisualizationInlineFrameResult)(result)),
    ).toBe(true);
    for (const expiresAtMs of [0, -1, 1.5, Number.POSITIVE_INFINITY])
      expect(
        Result.isFailure(
          Schema.decodeUnknownResult(VisualizationInlineFrameResult)({ ...result, expiresAtMs }),
        ),
      ).toBe(true);
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(VisualizationInlineFrameRetireResult)({
          ...tuple,
          frameId: grant.frameId,
          retired: false,
        }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(VisualizationInlineFrameRetireResult)({
          ...tuple,
          frameId: grant.frameId,
          retired: false,
          ticket: grant.ticket,
        }),
      ),
    ).toBe(true);
  });
});
