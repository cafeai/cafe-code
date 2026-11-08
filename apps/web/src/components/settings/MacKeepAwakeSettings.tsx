import type { MacKeepAwakeState } from "@cafecode/contracts";
import { uiText, type UiLocale } from "@cafecode/shared/i18n";
import { useEffect, useRef, useState } from "react";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useUiLocale } from "../../i18n";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

function statusText(state: MacKeepAwakeState | null, locale: UiLocale): string {
  if (state?.reason === "battery-low")
    return uiText("Paused at 20% battery or below.", undefined, undefined, locale);
  if (state?.reason === "thermal-limit")
    return uiText("Paused while this Mac is too hot.", undefined, undefined, locale);
  if (state?.reason === "unknown-power")
    return uiText("Paused until power information is available.", undefined, undefined, locale);
  if (state?.reason === "lease-busy")
    return uiText("Another Cafe instance is using closed-lid mode.", undefined, undefined, locale);
  if (state?.reason === "cleanup-failed")
    return uiText(
      "The sleep request could not be released. Turn this off and check your Mac's sleep behavior.",
      undefined,
      undefined,
      locale,
    );
  if (state?.phase === "active")
    return uiText("Active for local work.", undefined, undefined, locale);
  if (state?.phase === "idle")
    return uiText("Waiting for local work.", undefined, undefined, locale);
  if (state?.phase === "unavailable")
    return uiText(
      "Closed-lid mode is unavailable. Turn it off and on to try again.",
      undefined,
      undefined,
      locale,
    );
  return uiText("Waiting for the local backend.", undefined, undefined, locale);
}

/** This is the primary machine's preference, even while viewing a saved remote.
 * Only the macOS preload exposes the capability. Browser UA/platform strings
 * cannot opt another host into native power control. */
export function MacKeepAwakeSettings() {
  const locale = useUiLocale();
  const enabled = useSettings((settings) => settings.keepAwakeWithLidClosed, {
    environmentId: null,
  });
  const { updateSettings } = useUpdateSettings({ environmentId: null });
  const [native, setNative] = useState<MacKeepAwakeState | null>(null);
  const [changing, setChanging] = useState(false);
  const pendingIntent = useRef(false);
  const read = window.desktopBridge?.getMacKeepAwakeState;
  const setIntent = window.desktopBridge?.setMacKeepAwakeIntent;
  useEffect(() => {
    if (!read) return;
    let retired = false;
    let pending = false;
    const refresh = async () => {
      if (retired || pending) return;
      pending = true;
      try {
        const state = await read();
        if (!retired) setNative(state);
      } catch {
        if (!retired) setNative({ phase: "unavailable", reason: "native-unavailable" });
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => {
      retired = true;
      clearInterval(timer);
    };
  }, [enabled, read]);
  if (!read || !setIntent) return null;
  const change = async (value: boolean) => {
    if (pendingIntent.current) return;
    pendingIntent.current = true;
    setChanging(true);
    try {
      // Off retires native input before persistence. A full disk or failed
      // settings write cannot let an old backend heartbeat undo that choice.
      // On merely clears revocation: backend-authoritative preference + work
      // must still arrive on the exact private pipe before native adoption.
      await setIntent(value);
      updateSettings({ keepAwakeWithLidClosed: value });
    } catch {
      setNative({ phase: "unavailable", reason: "native-unavailable" });
    } finally {
      pendingIntent.current = false;
      setChanging(false);
    }
  };
  const description = uiText(
    "Keep this Mac awake while local chats or background agents work, including with the lid closed. The screen can sleep. Pauses at 20% battery or below.",
    undefined,
    undefined,
    locale,
  );
  return (
    <SettingsRow
      searchId="general.closedLid"
      title={uiText("Work with the lid closed", undefined, undefined, locale)}
      description={
        enabled || native?.reason === "cleanup-failed"
          ? `${description} ${statusText(native, locale)}`
          : description
      }
      resetAction={
        enabled ? (
          <SettingResetButton
            label={uiText("Work with the lid closed", undefined, undefined, locale)}
            onClick={() => void change(false)}
          />
        ) : null
      }
      control={
        <Switch
          aria-label={uiText("Work with the lid closed", undefined, undefined, locale)}
          checked={enabled}
          disabled={changing}
          onCheckedChange={(value) => void change(value)}
        />
      }
    />
  );
}
