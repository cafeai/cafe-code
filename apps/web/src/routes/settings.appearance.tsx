import { createFileRoute } from "@tanstack/react-router";

import { AppearanceSettingsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/settings/appearance")({
  component: AppearanceSettingsPanel,
});
