import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute("/settings/files")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/general", replace: true });
  },
});
