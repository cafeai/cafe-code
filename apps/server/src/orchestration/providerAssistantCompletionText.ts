import type { ProviderRuntimeEvent } from "@cafecode/contracts";

export function hasRenderableAssistantText(text: string | undefined): boolean {
  return (text?.trim().length ?? 0) > 0;
}

export function completedAssistantTextDelta(input: {
  readonly projectedText: string | undefined;
  readonly bufferedText: string;
  readonly fallbackText: string | undefined;
}): string {
  const fallbackText = input.fallbackText;
  if (!hasRenderableAssistantText(fallbackText)) {
    return input.bufferedText;
  }
  const finalFallbackText = fallbackText!;

  const projectedText = input.projectedText ?? "";
  const projectedAndBufferedText = `${projectedText}${input.bufferedText}`;
  if (projectedAndBufferedText.length === 0) {
    return finalFallbackText;
  }

  if (finalFallbackText.startsWith(projectedAndBufferedText)) {
    return `${input.bufferedText}${finalFallbackText.slice(projectedAndBufferedText.length)}`;
  }

  if (input.bufferedText.length > 0) {
    return input.bufferedText;
  }

  // Codex item/completed carries the authoritative final assistant item text.
  // When Cafe has only projected a streamed prefix, append exactly the missing
  // suffix before the terminal marker. Do not append divergent completion text:
  // that would duplicate visible content and corrupt the append-only message
  // event stream. Divergence remains visible through provider/runtime logs.
  return finalFallbackText.startsWith(projectedText)
    ? finalFallbackText.slice(projectedText.length)
    : "";
}

export function assistantCompletionTextFromRuntimeEvent(
  event: ProviderRuntimeEvent,
): string | undefined {
  return event.type === "item.completed" && event.payload.itemType === "assistant_message"
    ? event.payload.detail
    : undefined;
}

export type PrefixSafeAssistantRepair =
  | {
      readonly type: "append";
      readonly suffix: string;
    }
  | {
      readonly type: "unchanged";
    }
  | {
      readonly type: "empty-completion";
    }
  | {
      readonly type: "diverged";
    };

export function prefixSafeAssistantRepairSuffix(input: {
  readonly projectedText: string;
  readonly completionText: string | undefined;
}): PrefixSafeAssistantRepair {
  if (!hasRenderableAssistantText(input.completionText)) {
    return { type: "empty-completion" };
  }

  const completionText = input.completionText!;
  if (!completionText.startsWith(input.projectedText)) {
    return { type: "diverged" };
  }

  const suffix = completionText.slice(input.projectedText.length);
  if (!hasRenderableAssistantText(suffix)) {
    return { type: "unchanged" };
  }
  return {
    type: "append",
    suffix,
  };
}
