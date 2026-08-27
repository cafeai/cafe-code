import { createFileRoute } from "@tanstack/react-router";

import { DictationSettings } from "../components/settings/DictationSettings";

export const Route = createFileRoute("/settings/dictation")({
  component: DictationSettings,
});
