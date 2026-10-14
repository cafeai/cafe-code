import { describe, expect, it } from "vitest";
import { updateScrollToBottomDismissals } from "./useScrollToBottomDismissal";

describe("scroll control dismissal policy", () => {
  it("changes only the exact owner and reuses unchanged snapshots", () => {
    const first = "environment-one:chat";
    const other = "environment-two:chat";
    const hidden = updateScrollToBottomDismissals(new Set<string>(), first, true);
    expect([...hidden]).toEqual([first]);
    expect(updateScrollToBottomDismissals(hidden, first, true)).toBe(hidden);
    expect(updateScrollToBottomDismissals(hidden, other, false)).toBe(hidden);
    const both = updateScrollToBottomDismissals(hidden, other, true);
    expect([...both]).toEqual([first, other]);
    expect([...updateScrollToBottomDismissals(both, first, false)]).toEqual([other]);
    expect([...hidden]).toEqual([first]);
  });

  it("bounds remembered choices and admits a new hide after reaching bottom", () => {
    let choices: ReadonlySet<string> = new Set<string>();
    for (let index = 0; index < 65; index += 1) {
      choices = updateScrollToBottomDismissals(choices, `owner-${index}`, true);
    }
    expect(choices.size).toBe(64);
    expect(choices.has("owner-0")).toBe(false);
    expect(choices.has("owner-1")).toBe(true);
    choices = updateScrollToBottomDismissals(choices, "owner-1", false);
    choices = updateScrollToBottomDismissals(choices, "owner-1", true);
    choices = updateScrollToBottomDismissals(choices, "owner-new", true);
    expect(choices.size).toBe(64);
    expect(choices.has("owner-2")).toBe(false);
    expect(choices.has("owner-1")).toBe(true);
  });
});
