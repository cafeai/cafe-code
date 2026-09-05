import { createFileRoute } from "@tanstack/react-router";

import { AmbianceSettingsPanel } from "../components/settings/AmbianceSettings";

export const Route = createFileRoute("/settings/ambiance")({
  component: AmbianceSettingsPanel,
});
