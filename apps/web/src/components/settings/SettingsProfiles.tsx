import { EyeIcon, SaveIcon, Trash2Icon, UserRoundCogIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useClientSettingsHydrated, useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import {
  buildSettingsProfileApplyPatch,
  captureSettingsProfile,
  getSettingsProfileDifferenceKeys,
  isSameSettingsProfile,
  mutateSettingsProfiles,
  settingsProfilesStore,
  SettingsProfileError,
  type SettingsProfile,
  type SettingsProfileDifferenceKey,
  useSettingsProfiles,
} from "../../settingsProfiles";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow, SettingsSection } from "./settingsLayout";

function profileDifferenceLabel(key: SettingsProfileDifferenceKey): string {
  if (key === "theme") return "Theme";
  const words = key.replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

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
  const [previewProfileId, setPreviewProfileId] = useState<string | null>(null);
  const [pendingDeleteProfile, setPendingDeleteProfile] = useState<SettingsProfile | null>(null);
  const previewProfile =
    previewProfileId === null
      ? null
      : (library.profiles.find((profile) => profile.id === previewProfileId) ?? null);
  const previewDifferenceKeys = useMemo(
    () =>
      previewProfile === null
        ? []
        : getSettingsProfileDifferenceKeys(previewProfile, settings, theme),
    [previewProfile, settings, theme],
  );

  useEffect(() => {
    if (previewProfileId !== null && previewProfile === null) setPreviewProfileId(null);
  }, [previewProfile, previewProfileId]);

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
    async (expectedProfile: SettingsProfile) => {
      if (!hydrated || busy) return;
      setBusy(true);
      try {
        const resolved = await mutateSettingsProfiles(() => {
          const current = settingsProfilesStore.resolve(expectedProfile.id);
          if (current === null) return { kind: "missing" as const };
          if (!isSameSettingsProfile(expectedProfile, current)) {
            return { kind: "changed" as const };
          }
          return { kind: "current" as const, profile: current };
        });
        if (resolved.kind === "missing") {
          setPreviewProfileId(null);
          setError(true);
          setNotice(
            `“${expectedProfile.name}” was deleted or renamed in another window. Select another profile.`,
          );
          return;
        }
        if (resolved.kind === "changed") {
          setPreviewProfileId(null);
          setError(true);
          setNotice(
            `“${expectedProfile.name}” changed in another window. Preview the profile again before you apply it.`,
          );
          return;
        }
        const profile = resolved.profile;
        setTheme(profile.theme);
        updateSettings(buildSettingsProfileApplyPatch(profile.clientSettings));
        setPreviewProfileId(null);
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

  const confirmDelete = useCallback(async () => {
    if (pendingDeleteProfile === null || busy) return;
    const profile = pendingDeleteProfile;
    setBusy(true);
    try {
      const result = await mutateSettingsProfiles(() => settingsProfilesStore.remove(profile));
      if (result === "missing") {
        setError(true);
        setNotice(`“${profile.name}” was already deleted or renamed in another window.`);
        return;
      }
      if (result === "changed") {
        setError(true);
        setNotice(`“${profile.name}” changed in another window. Review the profile and try again.`);
        return;
      }
      if (previewProfileId === profile.id) setPreviewProfileId(null);
      setError(false);
      setNotice(`Deleted “${profile.name}”. Current settings did not change.`);
    } catch (cause) {
      reportError(cause);
    } finally {
      setPendingDeleteProfile(null);
      setBusy(false);
    }
  }, [busy, pendingDeleteProfile, previewProfileId, reportError]);

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
            "Profiles can include media configuration. Applying a profile turns external media off."
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
        description="Profiles never include credentials, providers, network security, project paths, native controls, automation, pacing, or telemetry."
        status={
          library.profiles.length === 0
            ? "No profiles saved yet."
            : `${library.profiles.length} of 16 local profiles saved.`
        }
      >
        {library.profiles.length > 0 ? (
          <div className="-mx-4 mt-3 grid gap-2 border-t border-border/60 px-4 py-3 sm:-mx-5 sm:px-5">
            {library.profiles.map((profile) => (
              <div key={profile.id} className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{profile.name}</span>
                <Button
                  aria-label={`Preview ${profile.name}`}
                  aria-controls="settings-profile-preview"
                  aria-expanded={previewProfile?.id === profile.id}
                  disabled={busy || !hydrated}
                  size="sm"
                  variant={previewProfile?.id === profile.id ? "secondary" : "outline"}
                  onClick={() =>
                    setPreviewProfileId((current) => (current === profile.id ? null : profile.id))
                  }
                >
                  <EyeIcon aria-hidden="true" className="size-3.5" />
                  Preview
                </Button>
                <Button
                  aria-label={`Apply ${profile.name}`}
                  disabled={busy || !hydrated}
                  size="sm"
                  variant="outline"
                  onClick={() => void apply(profile)}
                >
                  Apply
                </Button>
                <Button
                  aria-label={`Delete ${profile.name}`}
                  className="text-destructive hover:text-destructive"
                  disabled={busy || !hydrated}
                  size="sm"
                  variant="outline"
                  onClick={() => setPendingDeleteProfile(profile)}
                >
                  <Trash2Icon aria-hidden="true" className="size-3.5" />
                  Delete
                </Button>
              </div>
            ))}
            {previewProfile !== null ? (
              <section
                id="settings-profile-preview"
                aria-label={`Changes from applying ${previewProfile.name}`}
                className="rounded-lg border bg-muted/30 p-3 text-sm"
              >
                <p className="font-medium">
                  {previewDifferenceKeys.length === 0
                    ? "This profile will not change the current profile settings."
                    : `${previewDifferenceKeys.length} profile setting${previewDifferenceKeys.length === 1 ? "" : "s"} will change.`}
                </p>
                {previewDifferenceKeys.length > 0 ? (
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
                    {previewDifferenceKeys.map((key) => (
                      <li key={key}>{profileDifferenceLabel(key)}</li>
                    ))}
                  </ul>
                ) : null}
                <p className="mt-2 text-muted-foreground">Preview does not apply the profile.</p>
              </section>
            ) : null}
          </div>
        ) : null}
      </SettingsRow>
      <AlertDialog
        open={pendingDeleteProfile !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPendingDeleteProfile(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete settings profile “{pendingDeleteProfile?.name ?? ""}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This deletes only the saved profile. Current settings do not change.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={busy} />}>
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" disabled={busy} onClick={() => void confirmDelete()}>
              Delete profile
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}
