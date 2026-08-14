import {
  EyeIcon,
  PencilIcon,
  RefreshCwIcon,
  SaveIcon,
  Trash2Icon,
  UserRoundCogIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  getClientSettings,
  useClientSettingsHydrated,
  useSettings,
  useUpdateSettings,
} from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import {
  buildSettingsProfileApplyPatch,
  buildSettingsProfileRollbackPatch,
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
  const { updateClientSettingsConfirmed } = useUpdateSettings();
  const { theme, setTheme } = useTheme();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [previewProfileId, setPreviewProfileId] = useState<string | null>(null);
  const [pendingDeleteProfile, setPendingDeleteProfile] = useState<SettingsProfile | null>(null);
  const [pendingRenameProfile, setPendingRenameProfile] = useState<SettingsProfile | null>(null);
  const [renameName, setRenameName] = useState("");
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
        const applyPatch = buildSettingsProfileApplyPatch(profile.clientSettings);
        const rollbackPatch = buildSettingsProfileRollbackPatch(getClientSettings(), applyPatch);
        const previousTheme = theme;
        let settingsWriteAttempted = false;
        let themeWriteAttempted = false;
        try {
          themeWriteAttempted = true;
          setTheme(profile.theme);
          settingsWriteAttempted = true;
          await updateClientSettingsConfirmed(applyPatch);
          const activation = await mutateSettingsProfiles(() =>
            settingsProfilesStore.activate(profile),
          );
          if (activation !== "activated") {
            throw new SettingsProfileError(
              activation === "missing"
                ? `“${profile.name}” was deleted or renamed while it was being applied.`
                : `“${profile.name}” changed while it was being applied.`,
            );
          }
        } catch (cause) {
          let settingsRollbackFailed = false;
          let themeRollbackFailed = false;
          // A rejected RPC can be an indeterminate acknowledgement after the
          // server committed the patch. Restore the prior values whenever a
          // settings write was attempted, not only after a confirmed reply.
          if (settingsWriteAttempted) {
            try {
              await updateClientSettingsConfirmed(rollbackPatch);
            } catch {
              settingsRollbackFailed = true;
            }
          }
          if (themeWriteAttempted) {
            try {
              setTheme(previousTheme);
            } catch {
              themeRollbackFailed = true;
            }
          }
          if (settingsRollbackFailed || themeRollbackFailed) {
            const failedState =
              settingsRollbackFailed && themeRollbackFailed
                ? "settings and theme"
                : settingsRollbackFailed
                  ? "settings"
                  : "theme";
            throw new SettingsProfileError(
              `The profile was not activated, and the previous ${failedState} could not be restored. Review the current settings before you continue.`,
            );
          }
          throw cause;
        }
        setPreviewProfileId(null);
        setError(false);
        setNotice(`Applied “${profile.name}”.`);
      } catch (cause) {
        reportError(cause);
      } finally {
        setBusy(false);
      }
    },
    [busy, hydrated, reportError, setTheme, theme, updateClientSettingsConfirmed],
  );

  const updateActive = useCallback(
    async (expectedProfile: SettingsProfile) => {
      if (!hydrated || busy) return;
      setBusy(true);
      try {
        const payload = captureSettingsProfile(settings, theme);
        const result = await mutateSettingsProfiles(() =>
          settingsProfilesStore.updateActive(expectedProfile, payload),
        );
        if (typeof result === "string") {
          setError(true);
          setNotice(
            result === "inactive"
              ? "Another window changed the active profile. Review the profile list."
              : result === "missing"
                ? `“${expectedProfile.name}” was deleted or renamed in another window.`
                : `“${expectedProfile.name}” changed in another window. Review it and try again.`,
          );
          return;
        }
        setError(false);
        setNotice(`Updated “${result.name}” with the current settings.`);
      } catch (cause) {
        reportError(cause);
      } finally {
        setBusy(false);
      }
    },
    [busy, hydrated, reportError, settings, theme],
  );

  const confirmRename = useCallback(async () => {
    if (pendingRenameProfile === null || busy) return;
    const profile = pendingRenameProfile;
    setBusy(true);
    try {
      const result = await mutateSettingsProfiles(() =>
        settingsProfilesStore.rename(profile, renameName),
      );
      if (typeof result === "string") {
        setError(true);
        setNotice(
          result === "missing"
            ? `“${profile.name}” was deleted or renamed in another window.`
            : `“${profile.name}” changed in another window. Review it and try again.`,
        );
        return;
      }
      if (previewProfileId === profile.id) setPreviewProfileId(result.id);
      setError(false);
      setNotice(`Renamed “${profile.name}” to “${result.name}”.`);
    } catch (cause) {
      reportError(cause);
    } finally {
      setPendingRenameProfile(null);
      setRenameName("");
      setBusy(false);
    }
  }, [busy, pendingRenameProfile, previewProfileId, renameName, reportError]);

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
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {profile.name}
                  {library.activeProfileId === profile.id ? (
                    <span className="ml-2 text-emerald-600 dark:text-emerald-400">Active</span>
                  ) : null}
                </span>
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
                {library.activeProfileId === profile.id ? (
                  <Button
                    aria-label={`Update active profile ${profile.name}`}
                    disabled={busy || !hydrated}
                    size="sm"
                    variant="outline"
                    onClick={() => void updateActive(profile)}
                  >
                    <RefreshCwIcon aria-hidden="true" className="size-3.5" />
                    Update
                  </Button>
                ) : null}
                <Button
                  aria-label={`Rename ${profile.name}`}
                  disabled={busy || !hydrated}
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setPendingRenameProfile(profile);
                    setRenameName(profile.name);
                  }}
                >
                  <PencilIcon aria-hidden="true" className="size-3.5" />
                  Rename
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
        open={pendingRenameProfile !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setPendingRenameProfile(null);
            setRenameName("");
          }
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Rename settings profile</AlertDialogTitle>
            <AlertDialogDescription>
              Enter a unique local profile name. Current settings do not change.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            aria-label="Settings profile name"
            disabled={busy}
            maxLength={64}
            value={renameName}
            onChange={(event) => setRenameName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && renameName.trim().length > 0) void confirmRename();
            }}
          />
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={busy} />}>
              Cancel
            </AlertDialogClose>
            <Button
              disabled={busy || renameName.trim().length === 0}
              onClick={() => void confirmRename()}
            >
              Rename profile
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
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
