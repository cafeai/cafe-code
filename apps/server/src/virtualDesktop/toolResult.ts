import { readDesktopObservationReference } from "@cafecode/shared/desktopObservation";

/** Shared between MCP rendering and numeric accounting; count the actual text
 * sent to the model without traversing or logging image bytes. */
export function desktopToolResult(result: unknown) {
  if (typeof result !== "object" || result === null || Array.isArray(result))
    return {
      text: JSON.stringify(result) ?? "null",
      image: undefined,
      observation: undefined,
      isError: false,
    };
  const { image, observation: rawReference, ...metadata } = result as Record<string, unknown>;
  return {
    text: JSON.stringify(metadata),
    image: typeof image === "string" ? image : undefined,
    observation: readDesktopObservationReference(rawReference),
    isError: metadata.success === false,
  };
}
