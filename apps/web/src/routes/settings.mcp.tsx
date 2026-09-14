import { createFileRoute } from "@tanstack/react-router";
import { McpSettings } from "../components/settings/McpSettings";

export const Route = createFileRoute("/settings/mcp")({ component: McpSettings });
