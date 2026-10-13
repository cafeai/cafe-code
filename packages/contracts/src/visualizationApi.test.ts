import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  VisualizationDiscardViewerTicketInput,
  VisualizationDiscardViewerTicketResult,
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
