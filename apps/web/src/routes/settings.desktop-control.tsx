import { createFileRoute } from "@tanstack/react-router";
import { VirtualDesktopSettings } from "../components/virtualDesktop/VirtualDesktopSettings";

export const Route = createFileRoute("/settings/desktop-control")({
  component: VirtualDesktopSettings,
});
