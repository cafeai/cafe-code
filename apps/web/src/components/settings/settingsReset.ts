import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@cafecode/contracts/settings";
import { uiText, type UiLocale } from "@cafecode/shared/i18n";
import * as Equal from "effect/Equal";

/** Only controls owned by this page participate. Account configuration, secrets,
 * connections and destructive history actions never belong to a defaults reset. */
export function getSettingsPageReset(
  pathname: string,
  settings: UnifiedSettings,
  capabilities: { desktop: boolean },
  locale?: UiLocale,
) {
  const general = {
    timestampFormat: uiText("Time format", undefined, undefined, locale),
    defaultThreadEnvMode: uiText("New chat workspace", undefined, undefined, locale),
    addProjectBaseDirectory: uiText("Default project folder", undefined, undefined, locale),
    defaultEditor: uiText("Default editor", undefined, undefined, locale),
    ...(capabilities.desktop
      ? { powerSaveBlockerMode: uiText("Keep awake", undefined, undefined, locale) }
      : {}),
  };
  const appearance = {
    interfaceScalePercent: uiText("Interface size", undefined, undefined, locale),
    appAccentColor: uiText("Accent color", undefined, undefined, locale),
    continueBackgroundAnimations: uiText("Animate while unfocused", undefined, undefined, locale),
    showSidebarMascot: uiText("Enable sidebar image", undefined, undefined, locale),
    showSidebarSearch: uiText("Sidebar search", undefined, undefined, locale),
    showSidebarAttribution: uiText("Sidebar attribution", undefined, undefined, locale),
    brandWordmarkPrefix: uiText("Branding prefix", undefined, undefined, locale),
    sidebarBrandImage: uiText("Sidebar image", undefined, undefined, locale),
    sidebarBrandImageDataUrl: uiText("Sidebar image", undefined, undefined, locale),
    sidebarStarSpeed: uiText("Sidebar star speed", undefined, undefined, locale),
    themeAccentColor: uiText("Sidebar effects color", undefined, undefined, locale),
    ambianceEnabled: uiText("Weather layer", undefined, undefined, locale),
    ambianceEffect: uiText("Effect", undefined, undefined, locale),
    ambianceIntensity: uiText("Intensity", undefined, undefined, locale),
    ambianceOpacity: uiText("Opacity", undefined, undefined, locale),
    ambianceReactMode: uiText("React to chat", undefined, undefined, locale),
    ambianceSurfaceSidebar: uiText("Surfaces", undefined, undefined, locale),
    ambianceSurfaceThread: uiText("Surfaces", undefined, undefined, locale),
    ambianceSurfaceComposer: uiText("Surfaces", undefined, undefined, locale),
    ambianceColor: uiText("Weather color", undefined, undefined, locale),
    ambianceAtriumColor: uiText("Atrium color", undefined, undefined, locale),
  };
  const chats = {
    ambianceAtriumEnabled: uiText("Task Atrium", undefined, undefined, locale),
    chatClickBehavior: uiText("Clicking a chat", undefined, undefined, locale),
    showDeskTabs: uiText("Chat tabs", undefined, undefined, locale),
    autoOpenPlanSidebar: uiText("Auto-open plan panel", undefined, undefined, locale),
    enableAssistantStreaming: uiText("Assistant output", undefined, undefined, locale),
    chatCopyFormat: uiText("Chat selection copy", undefined, undefined, locale),
    confirmThreadArchive: uiText("Archive confirmation", undefined, undefined, locale),
    confirmThreadDelete: uiText("Delete confirmation", undefined, undefined, locale),
  };
  const entries: Partial<Record<keyof UnifiedSettings, string>> =
    pathname === "/settings/general"
      ? general
      : pathname === "/settings/appearance"
        ? appearance
        : pathname === "/settings/chat-threads"
          ? chats
          : pathname === "/settings/providers"
            ? {
                textGenerationModelSelection: uiText(
                  "Automatic naming model",
                  undefined,
                  undefined,
                  locale,
                ),
              }
            : pathname === "/settings/source-control"
              ? {
                  automaticGitFetchInterval: uiText(
                    "Automatic Git fetch interval",
                    undefined,
                    undefined,
                    locale,
                  ),
                }
              : {};
  const patch: Partial<UnifiedSettings> = {};
  const labels = new Set<string>();
  for (const key of Object.keys(entries) as Array<keyof UnifiedSettings>) {
    if (Equal.equals(settings[key], DEFAULT_UNIFIED_SETTINGS[key])) continue;
    Object.assign(patch, { [key]: DEFAULT_UNIFIED_SETTINGS[key] });
    labels.add(entries[key]!);
  }
  return { patch, labels: [...labels] };
}
