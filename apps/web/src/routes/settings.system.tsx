import { createFileRoute } from "@tanstack/react-router";

import { SystemSettingsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/settings/system")({
  component: SystemSettingsPanel,
});
