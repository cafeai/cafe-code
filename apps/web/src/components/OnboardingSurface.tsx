import { type ReactNode } from "react";

import { useClientSettingsHydrated, useSettings } from "~/hooks/useSettings";
import { OnboardingScreen } from "./OnboardingScreen";

/**
 * Gates the app shell behind the first-run onboarding flow.
 *
 * Renders {@link OnboardingScreen} full-screen on a fresh install and the app
 * otherwise. Sits inside the backend bootstrap surface so provider statuses
 * are already available when the providers step renders.
 *
 * The decision reads `onboardingCompleted` from settings, which — once the
 * server config has loaded — is the persisted, server-authoritative value.
 * Until client settings have hydrated we render children rather than risk
 * flashing onboarding to a returning user whose flag has not loaded yet.
 */
export function OnboardingSurface({ children }: { readonly children: ReactNode }) {
  const hydrated = useClientSettingsHydrated();
  const onboardingCompleted = useSettings((settings) => settings.onboardingCompleted);

  if (!hydrated) {
    return children;
  }
  if (onboardingCompleted) {
    return children;
  }
  return <OnboardingScreen />;
}
