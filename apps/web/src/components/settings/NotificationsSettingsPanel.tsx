import { useEffect, useState } from "react";

import { isElectron } from "../../env";
import { useClientSettingsHydrated, useSettings, useUpdateSettings } from "../../hooks/useSettings";
import {
  disableWebPushNotifications,
  enableWebPushNotifications,
  getWebPushSupport,
} from "../../lib/webPushNotifications";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

/**
 * Per-device notifications toggle. The setting lives in client settings
 * (localStorage / desktop client store), so each device opts in separately:
 * the desktop app fires native OS notifications from the renderer, while
 * browsers register a Web Push subscription so notifications arrive even
 * when the tab is frozen or closed.
 */
export function NotificationsSettingsPanel() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const settingsHydrated = useClientSettingsHydrated();
  const [isApplying, setIsApplying] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);

  const webPushSupport = getWebPushSupport();
  const toggleDisabled = isApplying || (!isElectron && !webPushSupport.supported);

  // The persisted setting is authoritative for this device. Once it has
  // hydrated, if it reads off but a push subscription is still live — e.g. one
  // orphaned before notificationsEnabled persisted correctly — tear it down so
  // pushes actually stop instead of arriving while the toggle reads off. Gated
  // on hydration so we never unsubscribe during the pre-hydration window (when
  // the setting transiently defaults to off); a no-op when nothing is subscribed.
  useEffect(() => {
    if (
      isElectron ||
      !webPushSupport.supported ||
      !settingsHydrated ||
      isApplying ||
      settings.notificationsEnabled
    ) {
      return;
    }
    void disableWebPushNotifications().catch(() => {});
  }, [settingsHydrated, isApplying, settings.notificationsEnabled, webPushSupport.supported]);

  const handleToggle = async (nextEnabled: boolean) => {
    setToggleError(null);
    if (isElectron) {
      // The desktop app notifies from the renderer; no registration needed.
      updateSettings({ notificationsEnabled: nextEnabled });
      return;
    }
    setIsApplying(true);
    try {
      if (nextEnabled) {
        await enableWebPushNotifications();
      } else {
        await disableWebPushNotifications();
      }
      updateSettings({ notificationsEnabled: nextEnabled });
    } catch (error) {
      setToggleError(error instanceof Error ? error.message : "Could not update notifications.");
    } finally {
      setIsApplying(false);
    }
  };

  const unsupportedReason =
    !isElectron && !webPushSupport.supported
      ? webPushSupport.reason === "insecure-context"
        ? "Needs an HTTPS connection to the server."
        : "This browser can't show push notifications. On iOS, add Cafe to your home screen first."
      : null;

  return (
    <SettingsPageContainer title="Notifications">
      <SettingsSection>
        <SettingsRow
          title="Chat completion notifications"
          description="Notify when a chat finishes, even in the background. This device only."
          status={
            toggleError ? (
              <span className="text-destructive-foreground">{toggleError}</span>
            ) : (
              unsupportedReason
            )
          }
          control={
            <Switch
              checked={settings.notificationsEnabled}
              disabled={toggleDisabled}
              onCheckedChange={(checked) => {
                void handleToggle(Boolean(checked));
              }}
              aria-label="Enable chat completion notifications"
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
