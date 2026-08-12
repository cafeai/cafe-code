import { useEffect, useRef } from "react";

import { useIsMobile } from "../hooks/useMediaQuery";
import { useClientSettingsHydrated, useSettings } from "../hooks/useSettings";
import { useTheme } from "../hooks/useTheme";
import {
  captureSettingsProfile,
  mutateSettingsProfiles,
  settingsProfilesStore,
  type MobileSettingsProfileBootstrapResult,
  type SettingsProfilePayload,
} from "../settingsProfiles";

export const DEFAULT_MOBILE_SETTINGS_PROFILE_NAME = "Mobile Profile";

type MobileProfileSeedStore = {
  readonly seedMobileProfileOnce: (
    name: string,
    payload: SettingsProfilePayload,
  ) => MobileSettingsProfileBootstrapResult;
};

export function shouldAttemptMobileSettingsProfileBootstrap(input: {
  readonly isNarrowLayout: boolean;
  readonly settingsHydrated: boolean;
}): boolean {
  return input.isNarrowLayout && input.settingsHydrated;
}

export async function attemptMobileSettingsProfileBootstrap(input: {
  readonly isNarrowLayout: boolean;
  readonly settingsHydrated: boolean;
  readonly payload: SettingsProfilePayload;
  readonly store?: MobileProfileSeedStore;
  readonly runMutation?: (
    mutation: () => MobileSettingsProfileBootstrapResult,
  ) => Promise<MobileSettingsProfileBootstrapResult>;
  readonly reportError?: (error: unknown) => void;
}): Promise<MobileSettingsProfileBootstrapResult | "failed"> {
  if (!shouldAttemptMobileSettingsProfileBootstrap(input)) return "skipped";

  const store = input.store ?? settingsProfilesStore;
  const runMutation = input.runMutation ?? mutateSettingsProfiles;
  try {
    return await runMutation(() =>
      store.seedMobileProfileOnce(DEFAULT_MOBILE_SETTINGS_PROFILE_NAME, input.payload),
    );
  } catch (error) {
    (input.reportError ?? console.error)("[SETTINGS_PROFILES] mobile bootstrap failed", error);
    return "failed";
  }
}

/**
 * A narrow renderer (below the shared md breakpoint) receives one safe local
 * profile snapshot after client settings hydrate. This is a presentation
 * convenience, not a hardware-device classification. Eligibility is checked
 * again under the shared profile mutation lock before any storage write.
 */
export function MobileSettingsProfileBootstrap() {
  const isNarrowLayout = useIsMobile();
  const settingsHydrated = useClientSettingsHydrated();
  const settings = useSettings();
  const { theme } = useTheme();
  const attemptedRef = useRef(false);

  useEffect(() => {
    if (
      attemptedRef.current ||
      !shouldAttemptMobileSettingsProfileBootstrap({ isNarrowLayout, settingsHydrated })
    ) {
      return;
    }

    attemptedRef.current = true;
    void attemptMobileSettingsProfileBootstrap({
      isNarrowLayout,
      settingsHydrated,
      payload: captureSettingsProfile(settings, theme),
    });
  }, [isNarrowLayout, settings, settingsHydrated, theme]);

  return null;
}
