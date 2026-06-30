import { describe, expect, it } from "vitest";

import {
  FIRST_RUN_HINT_KEYS,
  shouldShowAddProjectHint,
  withDismissedHint,
} from "./firstRunOnboarding";

describe("firstRunOnboarding", () => {
  describe("shouldShowAddProjectHint", () => {
    it("shows after onboarding when there are no projects and it is not dismissed", () => {
      expect(
        shouldShowAddProjectHint({
          onboardingCompleted: true,
          dismissedHints: [],
          projectCount: 0,
        }),
      ).toBe(true);
    });

    it("hides before onboarding is complete", () => {
      expect(
        shouldShowAddProjectHint({
          onboardingCompleted: false,
          dismissedHints: [],
          projectCount: 0,
        }),
      ).toBe(false);
    });

    it("hides once a project exists", () => {
      expect(
        shouldShowAddProjectHint({
          onboardingCompleted: true,
          dismissedHints: [],
          projectCount: 1,
        }),
      ).toBe(false);
    });

    it("hides once dismissed", () => {
      expect(
        shouldShowAddProjectHint({
          onboardingCompleted: true,
          dismissedHints: [FIRST_RUN_HINT_KEYS.addFirstProject],
          projectCount: 0,
        }),
      ).toBe(false);
    });
  });

  describe("withDismissedHint", () => {
    it("appends a new key", () => {
      expect(withDismissedHint([], FIRST_RUN_HINT_KEYS.addFirstProject)).toEqual([
        FIRST_RUN_HINT_KEYS.addFirstProject,
      ]);
    });

    it("does not duplicate an existing key", () => {
      const existing = [FIRST_RUN_HINT_KEYS.addFirstProject];
      expect(withDismissedHint(existing, FIRST_RUN_HINT_KEYS.addFirstProject)).toBe(existing);
    });
  });
});
