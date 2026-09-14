import { describe, expect, it } from "vitest";
import { readDesktopObservationItem } from "./desktopObservation.ts";
import { sanitizeProviderToolData } from "./activityPayloadSanitizer.ts";

const reference = {
  id: "24ff9ac9-1d98-4bb9-9d3f-1e868663a064",
  capturedAt: "2026-09-09T00:00:00.000Z",
  width: 1280,
  height: 800,
  frame: 14,
  humanControl: false,
  storage: "saved",
};
const item = {
  type: "mcpToolCall",
  server: "cafe-desktop",
  tool: "observe",
  status: "completed",
  result: { structuredContent: { desktopObservation: reference } },
};

describe("desktop observation references", () => {
  it("survives canonical tool-payload compaction while retaining only allowlisted metadata", () => {
    const withSecret = {
      ...item,
      result: {
        structuredContent: {
          desktopObservation: { ...reference, image: "private image", path: "/private/file" },
        },
      },
    };
    expect(readDesktopObservationItem(withSecret)?.reference).toEqual(reference);
    expect(readDesktopObservationItem(sanitizeProviderToolData({ item })?.item)?.reference).toEqual(
      reference,
    );
  });
  it("never infers an observation from text or another tool, and rejects invalid references", () => {
    expect(readDesktopObservationItem({ ...item, server: "other" })).toBeUndefined();
    expect(readDesktopObservationItem({ ...item, tool: "launch" })).toBeUndefined();
    expect(
      readDesktopObservationItem({
        ...item,
        result: { content: [{ type: "text", text: JSON.stringify(reference) }] },
      }),
    ).toEqual({ pending: false });
    for (const value of [
      { ...reference, id: "../../secret" },
      { ...reference, capturedAt: "private text" },
      { ...reference, width: 999999 },
    ]) {
      expect(
        readDesktopObservationItem({
          ...item,
          result: { structuredContent: { desktopObservation: value } },
        }),
      ).toEqual({ pending: false });
    }
  });
  it("retains an act screenshot reference, but never invents one for an ordinary action", () => {
    const action = { ...item, tool: "act" };
    expect(readDesktopObservationItem(action)?.reference).toEqual(reference);
    expect(
      readDesktopObservationItem(sanitizeProviderToolData({ item: action })?.item)?.reference,
    ).toEqual(reference);
    expect(
      readDesktopObservationItem({ ...action, status: "inProgress", result: null }),
    ).toBeUndefined();
    expect(
      readDesktopObservationItem({
        ...action,
        result: { content: [{ type: "text", text: "private input" }] },
      }),
    ).toBeUndefined();
  });
});
