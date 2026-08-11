import { SaveIcon, UserRoundCogIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { useClientSettingsHydrated, useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import {
  captureSettingsProfile,
  mutateSettingsProfiles,
  settingsProfilesStore,
  SettingsProfileError,
  useSettingsProfiles,
} from "../../settingsProfiles";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function SettingsProfiles() {
  const library = useSettingsProfiles();
  const settings = useSettings();
  const hydrated = useClientSettingsHydrated();
  const { updateSettings } = useUpdateSettings();
  const { theme, setTheme } = useTheme();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState(false);

  const reportError = useCallback((cause: unknown) => {
    setError(true);
    setNotice(
      cause instanceof SettingsProfileError || cause instanceof Error
        ? cause.message
        : "The settings profile could not be changed.",
    );
  }, []);

  const save = useCallback(async () => {
    if (!hydrated || busy) return;
    setBusy(true);
    try {
      const payload = captureSettingsProfile(settings, theme);
      const profile = await mutateSettingsProfiles(() =>
        settingsProfilesStore.create(name, payload),
      );
      setName("");
      setError(false);
      setNotice(`Saved “${profile.name}” on this device.`);
    } catch (cause) {
      reportError(cause);
    } finally {
      setBusy(false);
    }
  }, [busy, hydrated, name, reportError, settings, theme]);

  const apply = useCallback(
    async (profileId: string) => {
      if (!hydrated || busy) return;
      setBusy(true);
      try {
        const profile = await mutateSettingsProfiles(() =>
          settingsProfilesStore.resolve(profileId),
        );
        if (profile === null) {
          throw new SettingsProfileError("That settings profile no longer exists.");
        }
        setTheme(profile.theme);
        updateSettings(profile.clientSettings);
        setError(false);
        setNotice(`Applied “${profile.name}”.`);
      } catch (cause) {
        reportError(cause);
      } finally {
        setBusy(false);
      }
    },
    [busy, hydrated, reportError, setTheme, updateSettings],
  );

  return (
    <SettingsSection title="Settings profiles" icon={<UserRoundCogIcon className="size-3.5" />}>
      <SettingsRow
        title="Save current profile"
        description="Save a named local profile, then apply it from any Cafe Code window on this device."
        status={
          notice ? (
            <span
              aria-live="polite"
              className={error ? "text-destructive" : "text-emerald-600 dark:text-emerald-400"}
              role="status"
            >
              {notice}
            </span>
          ) : (
            "Profiles include presentation and thread-view preferences only."
          )
        }
        control={
          <div className="flex w-full gap-2 sm:w-80">
            <Input
              aria-label="New settings profile name"
              disabled={busy || !hydrated}
              maxLength={64}
              placeholder="Profile name"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void save();
              }}
            />
            <Button disabled={busy || !hydrated || name.trim().length === 0} onClick={save}>
              <SaveIcon className="size-3.5" />
              Save
            </Button>
          </div>
        }
      />
      <SettingsRow
        title="Saved profiles"
        description="Credentials, providers, network security, project paths, native controls, media, automation, pacing, and telemetry are never included."
        status={
          library.profiles.length === 0
            ? "No profiles saved yet."
            : `${library.profiles.length} of 16 local profiles saved.`
        }
      >
        {library.profiles.length > 0 ? (
          <div className="-mx-4 mt-3 flex flex-wrap gap-2 border-t border-border/60 px-4 py-3 sm:-mx-5 sm:px-5">
            {library.profiles.map((profile) => (
              <Button
                key={profile.id}
                disabled={busy || !hydrated}
                size="sm"
                variant="outline"
                onClick={() => void apply(profile.id)}
              >
                {profile.name}
              </Button>
            ))}
          </div>
        ) : null}
      </SettingsRow>
    </SettingsSection>
  );
}
