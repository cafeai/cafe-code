import { createFileRoute } from "@tanstack/react-router";

import { FilesSettingsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/settings/files-diffs")({
  component: FilesSettingsPanel,
});
