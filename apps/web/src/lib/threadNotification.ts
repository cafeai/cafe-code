import type { ClientSettings, TurnId } from "@cafecode/contracts";

export type ThreadNotificationKind = "completion" | "user-input";

export interface ThreadNotificationState {
  readonly running: boolean;
  readonly turnId: TurnId | null;
  readonly userInputPending: boolean;
}

export function getThreadNotificationKind(
  previous: ThreadNotificationState | undefined,
  current: ThreadNotificationState,
  preferences: Pick<ClientSettings, "notificationsEnabled" | "userInputNotificationsEnabled">,
): ThreadNotificationKind | null {
  // Hydration and enabling a preference must not announce historical prompts.
  if (!previous) return null;
  if (
    preferences.userInputNotificationsEnabled &&
    (!previous.userInputPending || previous.turnId !== current.turnId) &&
    current.userInputPending
  ) {
    return "user-input";
  }
  if (
    preferences.notificationsEnabled &&
    previous.running &&
    !current.running &&
    !current.userInputPending
  ) {
    return "completion";
  }
  return null;
}

export function isThreadNotificationPending(
  kind: ThreadNotificationKind,
  current: ThreadNotificationState,
): boolean {
  return kind === "user-input"
    ? current.userInputPending
    : !current.running && !current.userInputPending;
}
