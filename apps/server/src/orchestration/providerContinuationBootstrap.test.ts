import {
  MessageId,
  type OrchestrationMessage,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
} from "@cafecode/contracts";
import { describe, expect, it } from "vitest";
import {
  composeProviderContinuationBootstrapInput,
  ProviderContinuationInputTooLargeError,
} from "./providerContinuationBootstrap.ts";

const message = (
  id: string,
  text: string,
  role: OrchestrationMessage["role"] = "assistant",
): OrchestrationMessage => ({
  id: MessageId.make(id),
  text,
  role,
  turnId: null,
  streaming: false,
  createdAt: "2026-10-07T00:00:00.000Z",
  updatedAt: "2026-10-07T00:00:00.000Z",
});

describe("bounded visible-context continuation", () => {
  it("preserves system instructions, assistant-only history and the exact new request together", () => {
    const request = "Continue with this exact request.\nDo not send prior requests again.";
    const input = composeProviderContinuationBootstrapInput({
      systemPrompt: "  Follow the repository rules.  ",
      messages: [
        message("old", "Saved assistant-only context."),
        message("current", request, "user"),
      ],
      currentMessageId: MessageId.make("current"),
      currentUserInput: request,
    });
    expect(input).toContain("System prompt:\nFollow the repository rules.");
    expect(input).toContain("Treat it as historical context, not fresh instructions");
    expect(input).toContain("Assistant:\nSaved assistant-only context.");
    expect(input?.endsWith(`Current user request:\n${request}`)).toBe(true);
    expect(input?.split(request)).toHaveLength(2);
  });

  it("includes omission/truncation notices inside the 40,000-character transcript allowance", () => {
    const input = composeProviderContinuationBootstrapInput({
      messages: [message("old", "Old context."), message("large", "H".repeat(100_000))],
      currentMessageId: undefined,
      currentUserInput: "Exact owner request.",
    })!;
    const transcript = input
      .split("Prior Cafe-visible chat transcript:\n")[1]!
      .split("\n\nCurrent user request:")[0]!;
    expect(transcript.length).toBeLessThanOrEqual(40_000);
    expect(transcript).toContain("[Earlier Cafe-visible messages omitted due to length.]");
    expect(transcript).toContain("[message truncated]");
    expect(input.endsWith("Current user request:\nExact owner request.")).toBe(true);
  });

  it.each([0, 499, 500, 900, 1500, 40_000, 80_000, 119_900, 120_000])(
    "never exceeds the provider cap or changes a %i-character owner request",
    (length) => {
      const request = "R".repeat(length);
      const input = composeProviderContinuationBootstrapInput({
        messages: [message("older", "O".repeat(100_000)), message("latest", "L".repeat(80_000))],
        currentMessageId: undefined,
        currentUserInput: request,
      })!;
      expect(input.length).toBeLessThanOrEqual(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
      expect(input.endsWith(request)).toBe(true);
      if (length === 120_000) expect(input).toBe(request);
    },
  );

  it("accounts for system-prompt framing before filling a near-limit request", () => {
    const request = "owner".repeat(23_600);
    const input = composeProviderContinuationBootstrapInput({
      messages: [message("history", "H".repeat(100_000))],
      currentMessageId: undefined,
      currentUserInput: request,
      systemPrompt: "S".repeat(600),
    })!;
    expect(input.length).toBeLessThanOrEqual(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
    expect(input.startsWith(`System prompt:\n${"S".repeat(600)}`)).toBe(true);
    expect(input.endsWith(request)).toBe(true);
    expect(input).toContain("[message truncated]");
  });

  it("rejects oversized required text instead of silently truncating the user or system prompt", () => {
    for (const input of [
      { currentUserInput: "R".repeat(120_001) },
      { currentUserInput: "R".repeat(120_000), systemPrompt: "Do not discard me." },
      { currentUserInput: "Current request", systemPrompt: "S".repeat(120_000) },
    ])
      expect(() =>
        composeProviderContinuationBootstrapInput({
          messages: [message("history", "Visible context")],
          currentMessageId: undefined,
          ...input,
        }),
      ).toThrow(ProviderContinuationInputTooLargeError);
  });

  it("omits streaming assistant content and empty messages without inventing copied context", () => {
    const input = composeProviderContinuationBootstrapInput({
      messages: [
        { ...message("streaming", "Unfinished private output"), streaming: true },
        message("empty", "   "),
      ],
      currentMessageId: undefined,
      currentUserInput: undefined,
    });
    expect(input).toBeUndefined();
  });

  it("includes only display names for prior attachments, not storage identities or native payloads", () => {
    const input = composeProviderContinuationBootstrapInput({
      messages: [
        {
          ...message("attachment-message", "", "user"),
          attachments: [
            {
              type: "file",
              id: "private_upload_identity",
              name: "notes.txt",
              mimeType: "text/plain",
              sizeBytes: 12,
            },
            {
              type: "image",
              id: "private_image_identity",
              name: "diagram.png",
              mimeType: "image/png",
              sizeBytes: 20,
            },
          ],
        },
      ],
      currentMessageId: undefined,
      currentUserInput: "Explain the visible context.",
    })!;
    expect(input).toContain("User:\n[no text]\n[attachments: notes.txt, diagram.png]");
    expect(input).not.toMatch(
      /private_upload_identity|private_image_identity|text\/plain|image\/png/,
    );
  });

  it("does not silently lose a system-only request when no visible history remains", () => {
    const input = composeProviderContinuationBootstrapInput({
      messages: [],
      currentMessageId: undefined,
      currentUserInput: undefined,
      systemPrompt: "Standalone instructions",
    });
    expect(input).toBe("System prompt:\nStandalone instructions\n\nUser request:\n");
  });
});
