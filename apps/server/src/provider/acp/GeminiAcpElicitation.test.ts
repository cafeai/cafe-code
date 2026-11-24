import { describe, expect, it } from "@effect/vitest";

import {
  buildGeminiElicitationResponse,
  parseGeminiElicitation,
  type GeminiElicitationRequest,
} from "./GeminiAcpElicitation.ts";

function sampleRequest(
  overrides?: Partial<Extract<GeminiElicitationRequest, { readonly mode: "form" }>>,
): Extract<GeminiElicitationRequest, { readonly mode: "form" }> {
  return {
    mode: "form",
    sessionId: "gemini-session",
    toolCallId: "call_1",
    message: "The agent has 2 questions.",
    requestedSchema: {
      type: "object",
      properties: {
        q1: {
          type: "string",
          title: "Favorite color?",
          oneOf: [
            { const: "1", title: "Red" },
            { const: "2", title: "Blue" },
          ],
        },
        q1_other: {
          type: "string",
          title: "Other",
          description: "Optional free-form answer to: Favorite color?",
        },
        q2: {
          type: "array",
          title: "Fruits?",
          items: {
            anyOf: [
              { const: "1", title: "Apple" },
              { const: "2", title: "Banana" },
              { const: "3", title: "Pear" },
            ],
          },
        },
        q2_other: {
          type: "string",
          title: "Other",
          description: "Optional free-form answer to: Fruits?",
        },
      },
    },
    ...overrides,
  };
}

describe("Gemini ACP elicitation translation", () => {
  it("folds companion _other fields into parent questions and maps choices, custom text, and skips", () => {
    const plan = parseGeminiElicitation(sampleRequest());
    expect(plan).toBeDefined();
    expect(plan?.supportsUnanswered).toBe(true);
    expect(plan?.questions).toEqual([
      {
        id: "q1",
        header: "Question",
        question: "Favorite color?",
        multiSelect: false,
        options: [
          { label: "Red", description: "Red" },
          { label: "Blue", description: "Blue" },
        ],
      },
      {
        id: "q2",
        header: "Question",
        question: "Fruits?",
        multiSelect: true,
        options: [
          { label: "Apple", description: "Apple" },
          { label: "Banana", description: "Banana" },
          { label: "Pear", description: "Pear" },
        ],
      },
    ]);

    expect(
      buildGeminiElicitationResponse(plan!, {
        q1: "Purple",
        q2: ["Apple", "Pear"],
      }),
    ).toEqual({
      response: {
        action: "accept",
        content: {
          q1_other: "Purple",
          q2: ["1", "3"],
        },
      },
      answers: {
        q1: "Purple",
        q2: ["Apple", "Pear"],
      },
      unanswered: undefined,
    });

    expect(buildGeminiElicitationResponse(plan!, { q1: "Blue" }, { q2: "skipped" })).toEqual({
      response: {
        action: "accept",
        content: { q1: "2" },
      },
      answers: { q1: "Blue" },
      unanswered: { q2: "skipped" },
    });

    expect(buildGeminiElicitationResponse(plan!, {}, { q1: "dismissed", q2: "dismissed" })).toEqual(
      {
        response: { action: "decline" },
        answers: {},
        unanswered: { q1: "dismissed", q2: "dismissed" },
      },
    );
  });

  it("supports custom free-text answers on multi-select questions and rejects invalid answers", () => {
    const plan = parseGeminiElicitation(sampleRequest())!;

    expect(
      buildGeminiElicitationResponse(plan, {
        q1: "Red",
        q2: "Dragonfruit",
      }),
    ).toEqual({
      response: {
        action: "accept",
        content: { q1: "1", q2_other: "Dragonfruit" },
      },
      answers: { q1: "Red", q2: "Dragonfruit" },
      unanswered: undefined,
    });

    expect(buildGeminiElicitationResponse(plan, { q1: "Red" })).toBeUndefined();
    expect(
      buildGeminiElicitationResponse(plan, { q1: "Red", q2: ["Apple"] }, { q2: "skipped" }),
    ).toBeUndefined();
    expect(
      buildGeminiElicitationResponse(plan, { q1: ["Red", "Blue"], q2: ["Apple"] }),
    ).toBeUndefined();
    expect(
      buildGeminiElicitationResponse(plan, { q1: "Red", q2: ["Apple"], unknown: "x" }),
    ).toBeUndefined();
  });

  it("enforces required fields and schemas without _other companion fields", () => {
    const request = sampleRequest({
      requestedSchema: {
        type: "object",
        required: ["q1"],
        properties: {
          q1: {
            type: "string",
            title: "Strict choice?",
            enum: ["Yes", "No"],
          },
        },
      },
    });
    const plan = parseGeminiElicitation(request)!;
    expect(plan.supportsUnanswered).toBe(false);
    expect(buildGeminiElicitationResponse(plan, { q1: "Maybe" })).toBeUndefined();
    expect(buildGeminiElicitationResponse(plan, {}, { q1: "skipped" })).toBeUndefined();
    expect(buildGeminiElicitationResponse(plan, { q1: "Yes" })).toEqual({
      response: { action: "accept", content: { q1: "Yes" } },
      answers: { q1: "Yes" },
      unanswered: undefined,
    });
  });

  it("rejects url mode, empty schemas, and proxy answer objects", () => {
    expect(
      parseGeminiElicitation({
        mode: "url",
        sessionId: "gemini-session",
        message: "Open url",
        elicitationId: "elicit-1",
        url: "https://example.com",
      }),
    ).toBeUndefined();
    expect(
      parseGeminiElicitation(
        sampleRequest({ requestedSchema: { type: "object", properties: {} } }),
      ),
    ).toBeUndefined();

    const plan = parseGeminiElicitation(sampleRequest())!;
    const proxy = new Proxy({ q1: "Red", q2: ["Apple"] }, {});
    expect(buildGeminiElicitationResponse(plan, proxy)).toBeUndefined();
  });
});
