import { type ReactNode, useState } from "react";

import { useClientSettingsHydrated, useSettings } from "~/hooks/useSettings";
import { StartupSkeleton, useStartupSkeletonShown } from "./InitialBackendBootstrapSurface";
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
 * Until client settings have hydrated we keep showing the startup skeleton:
 * rendering the app would flash it at a first-run user before onboarding, and
 * rendering onboarding could flash it at a returning user whose flag has not
 * loaded yet.
 *
 * This is the last startup gate, so it also fades the app in whenever a
 * skeleton or onboarding was on screen before it, instead of swapping it in.
 */
export function OnboardingSurface({ children }: { readonly children: ReactNode }) {
  const hydrated = useClientSettingsHydrated();
  const onboardingCompleted = useSettings((settings) => settings.onboardingCompleted);
  const bootstrapSkeletonShown = useStartupSkeletonShown();
  // Captured once: whether this gate itself held the app back on first render.
  const [gatedOnMount] = useState(() => !hydrated || !onboardingCompleted);

  if (!hydrated) {
    // The bootstrap skeleton usually precedes this one; continuing it without
    // replaying its fade keeps the hand-off invisible.
    return <StartupSkeleton animateIn={!bootstrapSkeletonShown} />;
  }
  if (!onboardingCompleted) {
    return <OnboardingScreen />;
  }
  if (bootstrapSkeletonShown || gatedOnMount) {
    return <div className="min-h-0 min-w-0 animate-enter-fade">{children}</div>;
  }
  return children;
}
