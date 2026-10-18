import { uiText } from "@cafecode/shared/i18n";
import { useUiLocale } from "~/i18n";

import { useWorkspaceEnvironmentId } from "../../environments/workspace";
import { useServerConfig } from "../../rpc/serverState";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** Owner-authenticated server metadata, scoped to the selected environment.
 * A Debug desktop connected to a Production remote must say Production here;
 * neither a desktop badge nor an old server's missing fields prove isolation. */
export function DataProfileSettings() {
  const uiLocale = useUiLocale();
  const environmentId = useWorkspaceEnvironmentId();
  const serverConfig = useServerConfig(environmentId);
  const profile = serverConfig?.dataProfile;
  const profileLabel =
    profile === "debug"
      ? uiText("Debug", undefined, undefined, uiLocale)
      : profile === "production"
        ? uiText("Production", undefined, undefined, uiLocale)
        : uiText("Unavailable", undefined, undefined, uiLocale);

  return (
    <SettingsSection title={uiText("Data profile", undefined, undefined, uiLocale)}>
      <SettingsRow
        title={uiText("Active environment", undefined, undefined, uiLocale)}
        description={serverConfig?.environment.label}
        control={
          <span className="rounded-md border px-2 py-1 text-xs font-medium">{profileLabel}</span>
        }
        status={uiText(
          "This is the selected server's data, not necessarily the desktop app's local profile.",
          undefined,
          undefined,
          uiLocale,
        )}
      />
      <SettingsRow
        title={uiText("Data directory", undefined, undefined, uiLocale)}
        control={
          <code className="max-w-full break-all text-xs">
            {serverConfig?.dataDirectoryPath ??
              uiText("Unavailable", undefined, undefined, uiLocale)}
          </code>
        }
      />
    </SettingsSection>
  );
}
