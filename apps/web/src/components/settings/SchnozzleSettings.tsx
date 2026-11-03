import { uiText } from "@cafecode/shared/i18n";
import { useEffect, useState } from "react";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { ensureLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function schnozzleOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function SchnozzleLauncher() {
  const enabled = useSettings((settings) => settings.schnozzleEnabled);
  const relay = useSettings((settings) => settings.schnozzleRelayOrigin);
  const [error, setError] = useState("");
  const origin = schnozzleOrigin(relay);
  if (!enabled || !origin) return null;
  return (
    <div className="p-2">
      <Button
        variant="outline"
        className="w-full"
        onClick={() => {
          setError("");
          void ensureLocalApi()
            .shell.openExternal(origin)
            .catch(() =>
              setError(uiText("Could not open the project. Check your browser settings.")),
            );
        }}
      >
        {uiText("Open Schnozzle")}
      </Button>
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function SchnozzleSettings() {
  const enabled = useSettings((settings) => settings.schnozzleEnabled);
  const relay = useSettings((settings) => settings.schnozzleRelayOrigin);
  const { updateSettings: update } = useUpdateSettings();
  const [input, setInput] = useState(relay);
  useEffect(() => setInput(relay), [relay]);
  const origin = schnozzleOrigin(input);
  return (
    <SettingsSection title={uiText("Amalgamating Schnozzle")}>
      <SettingsRow
        title={uiText("Shared project room")}
        description={uiText(
          "Connect independent work in Club Code, Cafe Code, or a browser. This optional feature opens a separate project room. It shares no chat history or repository access automatically.",
        )}
        control={
          <Switch
            aria-label={uiText("Enable Amalgamating Schnozzle")}
            checked={enabled}
            onCheckedChange={(checked) => update({ schnozzleEnabled: checked })}
          />
        }
      />
      {enabled && (
        <>
          <SettingsRow
            title={uiText("Relay address")}
            description={uiText(
              "Use your team''s HTTPS relay address. Paste invitations in the project room. Keep invitation codes out of this setting.",
            )}
            control={
              <div className="flex max-w-sm gap-2">
                <Input
                  aria-label={uiText("Schnozzle relay address")}
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder="https://schnozzle.example.com"
                />
                <Button
                  disabled={!origin}
                  onClick={() => {
                    if (origin) update({ schnozzleRelayOrigin: origin });
                  }}
                >
                  {uiText("Save")}
                </Button>
              </div>
            }
          />
          <SettingsRow
            title={uiText("Send it via the Amalgamating Schnozzle")}
            description={uiText(
              "A peculiar, indispensable attachment connecting otherwise separate contraptions. Review selected text, then paste it into your lane in the project room. Each member keeps control of their own AI context.",
            )}
            control={<SchnozzleLauncher />}
          />
        </>
      )}
    </SettingsSection>
  );
}
