import { createFileRoute } from "@tanstack/react-router";

import { RecentlyDeletedThreadsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/settings/recently-deleted")({
  component: RecentlyDeletedThreadsPanel,
});
