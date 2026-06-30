/**
 * First-run onboarding logic.
 *
 * Pure helpers shared by the onboarding surface and the post-onboarding
 * "first run" hints. Kept free of React so the visibility rules can be unit
 * tested in isolation. State lives in client settings
 * (`onboardingCompleted`, `dismissedFirstRunHints`) so decisions survive
 * restarts and sync across devices.
 */

/** Stable keys persisted in `dismissedFirstRunHints`. */
export const FIRST_RUN_HINT_KEYS = {
  addFirstProject: "add-first-project",
} as const;

export type FirstRunHintKey = (typeof FIRST_RUN_HINT_KEYS)[keyof typeof FIRST_RUN_HINT_KEYS];

interface AddProjectHintInput {
  readonly onboardingCompleted: boolean;
  readonly dismissedHints: ReadonlyArray<string>;
  readonly projectCount: number;
}

/**
 * The "add your first project" nudge shows after onboarding is finished, while
 * the workspace still has no projects, and only until the user dismisses it.
 * Once a project exists the nudge is moot, so the count gate hides it even
 * before an explicit dismissal.
 */
export function shouldShowAddProjectHint(input: AddProjectHintInput): boolean {
  return (
    input.onboardingCompleted &&
    input.projectCount === 0 &&
    !input.dismissedHints.includes(FIRST_RUN_HINT_KEYS.addFirstProject)
  );
}

/**
 * Append a hint key to the dismissed list, de-duplicating so repeated
 * dismissals (X then action, or vice versa) don't grow the array.
 */
export function withDismissedHint(
  dismissedHints: ReadonlyArray<string>,
  key: FirstRunHintKey,
): ReadonlyArray<string> {
  if (dismissedHints.includes(key)) {
    return dismissedHints;
  }
  return [...dismissedHints, key];
}
