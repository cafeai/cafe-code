import { uiText } from "@cafecode/shared/i18n";
import type { ServerProviderSkill } from "@cafecode/contracts";

function titleCaseWords(value: string): string {
  return value
    .split(/[\s:_-]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function normalizePathSeparators(pathValue: string): string {
  return pathValue.replaceAll("\\", "/");
}

export function formatProviderSkillDisplayName(
  skill: Pick<ServerProviderSkill, "name" | "displayName">,
): string {
  const displayName = skill.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  return titleCaseWords(skill.name);
}

export function formatProviderSkillInstallSource(
  skill: Pick<ServerProviderSkill, "path" | "pluginId" | "scope">,
): string | null {
  if (skill.pluginId?.trim()) {
    return uiText("App");
  }
  const normalizedPath = normalizePathSeparators(skill.path ?? "");
  if (normalizedPath.includes("/.codex/plugins/") || normalizedPath.includes("/.agents/plugins/")) {
    return uiText("App");
  }

  const normalizedScope = skill.scope?.trim().toLowerCase();
  if (normalizedScope === "system") {
    return uiText("System");
  }
  if (
    normalizedScope === "project" ||
    normalizedScope === "repo" ||
    normalizedScope === "workspace" ||
    normalizedScope === "local"
  ) {
    return uiText("Project");
  }
  if (normalizedScope === "user" || normalizedScope === "personal") {
    return uiText("Personal");
  }
  if (normalizedScope) {
    return titleCaseWords(normalizedScope);
  }

  return null;
}
