import { createFileRoute } from "@tanstack/react-router";

import { UsageStatsPanel } from "../components/settings/UsageStatsPanel";

export const Route = createFileRoute("/settings/stats")({
  component: UsageStatsPanel,
});
