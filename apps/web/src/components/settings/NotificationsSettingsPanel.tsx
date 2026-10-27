import { useUiLocale } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { useEffect, useRef, useState } from "react";

import { isElectron } from "../../env";
import { useClientSettingsHydrated, useSettings, useUpdateSettings } from "../../hooks/useSettings";
import {
  disableWebPushNotifications,
  enableWebPushNotifications,
  getWebPushSupport,
} from "../../lib/webPushNotifications";
import { Switch } from "../ui/switch";
import { Button } from "../ui/button";
import {
  sendDesktopNotification,
  useDesktopNotificationResult,
} from "../../lib/desktopNotifications";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

type NotificationSettingKey = "notificationsEnabled" | "userInputNotificationsEnabled";

/**
 * Per-device notification preferences. The settings live in client settings
 * (localStorage / desktop client store), so each device opts in separately:
 * the desktop app fires native OS notifications from the renderer, while
 * browsers register a Web Push subscription so notifications arrive even
 * when the tab is frozen or closed.
 */
export function NotificationsSettingsPanel() {
  const uiLocale = useUiLocale();

  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const settingsHydrated = useClientSettingsHydrated();
  const [isApplying, setIsApplying] = useState(false);
  const mounted = useRef(true);
  const applying = useRef(false);
  const desktopResult = useDesktopNotificationResult();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [toggleError, setToggleError] = useState<{
    readonly key: NotificationSettingKey;
    readonly message: string;
  } | null>(null);

  const webPushSupport = getWebPushSupport();
  const toggleDisabled = isApplying || (!isElectron && !webPushSupport.supported);

  // The persisted setting is authoritative for this device. Once it has
  // hydrated, if it reads off but a push subscription is still live — e.g. one
  // orphaned before the preferences persisted correctly — tear it down so
  // pushes actually stop instead of arriving while the toggle reads off. Gated
  // on hydration so we never unsubscribe during the pre-hydration window (when
  // the setting transiently defaults to off); a no-op when nothing is subscribed.
  useEffect(() => {
    if (
      isElectron ||
      !webPushSupport.supported ||
      !settingsHydrated ||
      isApplying ||
      settings.notificationsEnabled ||
      settings.userInputNotificationsEnabled
    ) {
      return;
    }
    void disableWebPushNotifications().catch(() => {});
  }, [
    settingsHydrated,
    isApplying,
    settings.notificationsEnabled,
    settings.userInputNotificationsEnabled,
    webPushSupport.supported,
  ]);

  const handleToggle = async (key: NotificationSettingKey, nextEnabled: boolean) => {
    setToggleError(null);
    const preferences = {
      notificationsEnabled: settings.notificationsEnabled,
      userInputNotificationsEnabled: settings.userInputNotificationsEnabled,
      [key]: nextEnabled,
    };
    if (applying.current) return;
    applying.current = true;
    setIsApplying(true);
    try {
      if (isElectron) {
        // Explicit opt-in creates the native presenter and its macOS permission
        // request. Never claim a saved preference proves OS authorization.
        if (nextEnabled && (await testDesktopNotification()) !== "sent") return;
      } else if (preferences.notificationsEnabled || preferences.userInputNotificationsEnabled) {
        await enableWebPushNotifications({
          notifyOnCompletion: preferences.notificationsEnabled,
          notifyOnUserInput: preferences.userInputNotificationsEnabled,
        });
      } else {
        await disableWebPushNotifications();
      }
      if (mounted.current) updateSettings({ [key]: nextEnabled });
    } catch (error) {
      setToggleError({
        key,
        message:
          error instanceof Error
            ? error.message
            : uiText("Could not update notifications.", undefined, undefined, uiLocale),
      });
    } finally {
      applying.current = false;
      if (mounted.current) setIsApplying(false);
    }
  };

  const testDesktopNotification = () =>
    sendDesktopNotification({
      title: uiText("Cafe Code", undefined, undefined, uiLocale),
      body: uiText("Test notification from Cafe Code.", undefined, undefined, uiLocale),
      tag: "cafe-code-notification-test",
    });

  const handleTestNotification = async () => {
    if (applying.current) return;
    applying.current = true;
    setIsApplying(true);
    try {
      await testDesktopNotification();
    } finally {
      applying.current = false;
      if (mounted.current) setIsApplying(false);
    }
  };

  const unsupportedReason =
    !isElectron && !webPushSupport.supported
      ? webPushSupport.reason === "insecure-context"
        ? uiText("Needs an HTTPS connection to the server.", undefined, undefined, uiLocale)
        : uiText(
            "This browser can't show push notifications. On iOS, add Cafe to your home screen first.",
            undefined,
            undefined,
            uiLocale,
          )
      : null;

  return (
    <SettingsPageContainer title={uiText("Notifications", undefined, undefined, uiLocale)}>
      <SettingsSection>
        <SettingsRow
          searchId="notifications.chatCompletion"
          title={uiText("Chat completion notifications", undefined, undefined, uiLocale)}
          description={uiText(
            "Notify when a chat finishes, even in the background. This device only.",
            undefined,
            undefined,
            uiLocale,
          )}
          status={
            toggleError?.key === "notificationsEnabled" ? (
              <span className="text-destructive-foreground">{toggleError.message}</span>
            ) : (
              unsupportedReason
            )
          }
          control={
            <Switch
              checked={settings.notificationsEnabled}
              disabled={toggleDisabled}
              onCheckedChange={(checked) => {
                void handleToggle("notificationsEnabled", Boolean(checked));
              }}
              aria-label={uiText(
                "Enable chat completion notifications",
                undefined,
                undefined,
                uiLocale,
              )}
            />
          }
        />
        {isElectron ? (
          <SettingsRow
            title={uiText("Test notifications", undefined, undefined, uiLocale)}
            description={uiText(
              "Allow notifications when your system asks. On macOS, check System Settings → Notifications for Cafe Code.",
              undefined,
              undefined,
              uiLocale,
            )}
            status={
              desktopResult && desktopResult !== "cancelled" ? (
                <span role="status">
                  {desktopResult === "sent"
                    ? uiText(
                        "Notification sent. If no banner appears, check notification settings and Focus or Do Not Disturb.",
                        undefined,
                        undefined,
                        uiLocale,
                      )
                    : desktopResult === "unsupported"
                      ? uiText(
                          "This desktop build cannot send notifications.",
                          undefined,
                          undefined,
                          uiLocale,
                        )
                      : uiText(
                          "Could not send a notification. Allow Cafe Code in system notification settings, then try again. macOS requires a signed app.",
                          undefined,
                          undefined,
                          uiLocale,
                        )}
                </span>
              ) : null
            }
            control={
              <Button
                variant="outline"
                size="sm"
                disabled={isApplying}
                onClick={() => void handleTestNotification()}
              >
                {uiText("Send test notification", undefined, undefined, uiLocale)}
              </Button>
            }
          />
        ) : null}
        <SettingsRow
          searchId="notifications.userInput"
          title={uiText("User input notifications", undefined, undefined, uiLocale)}
          description={uiText(
            "Notify when a chat asks for your input, even in the background. This device only.",
            undefined,
            undefined,
            uiLocale,
          )}
          status={
            toggleError?.key === "userInputNotificationsEnabled" ? (
              <span className="text-destructive-foreground">{toggleError.message}</span>
            ) : (
              unsupportedReason
            )
          }
          control={
            <Switch
              checked={settings.userInputNotificationsEnabled}
              disabled={toggleDisabled}
              onCheckedChange={(checked) => {
                void handleToggle("userInputNotificationsEnabled", Boolean(checked));
              }}
              aria-label={uiText("Enable user input notifications", undefined, undefined, uiLocale)}
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
