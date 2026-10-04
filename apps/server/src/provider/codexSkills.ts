import type { ProviderSkillsResult, ServerProviderSkill } from "@cafecode/contracts";
import type * as CodexSchema from "effect-codex-app-server/schema";
import type * as CodexClient from "effect-codex-app-server/client";
import * as Effect from "effect/Effect";

/** One on-demand metadata request. No implicit model/account/thread discovery
 * belongs here; the caller owns the private connection and exact cwd authority. */
export const requestCodexSkills = (client: CodexClient.CodexAppServerClientShape, cwd: string) =>
  client
    .request("skills/list", { cwds: [cwd], forceReload: true })
    .pipe(Effect.map((response) => publicCodexSkills(response, cwd)));

const UNSAFE_LABEL = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/u;
function label(value: string | null | undefined, limit: number): string | undefined {
  if (!value || value.length > limit || UNSAFE_LABEL.test(value)) return undefined;
  return value.trim() || undefined;
}

/** Only the exact requested cwd can contribute picker data. The old fallback
 * that flattened unrelated entries would leak another project's catalogue.
 * Native paths/dependencies/prompts/icons never cross this read-only boundary. */
export function publicCodexSkills(
  response: CodexSchema.V2SkillsListResponse,
  cwd: string,
): ProviderSkillsResult {
  if (response.data.length > 16) return { status: "unavailable", skills: [] };
  const entries = response.data.filter((entry) => entry.cwd === cwd);
  const entry = entries[0];
  if (entries.length !== 1 || !entry || entry.skills.length > 512 || entry.errors.length > 0) {
    return { status: "unavailable", skills: [] };
  }
  const seen = new Set<string>();
  const skills: ServerProviderSkill[] = [];
  for (const skill of entry.skills) {
    // This grammar matches Cafe's inert $skill token and native named lookup.
    // Never permit provider metadata to insert a second instruction or path.
    if (
      !skill.enabled ||
      !/^[A-Za-z][A-Za-z0-9:_-]{0,127}$/.test(skill.name) ||
      seen.has(skill.name)
    )
      continue;
    seen.add(skill.name);
    const displayName = label(skill.interface?.displayName, 128);
    const shortDescription = label(
      skill.shortDescription ?? skill.interface?.shortDescription ?? skill.description,
      512,
    );
    const pluginId = label(skill.pluginId, 128);
    skills.push({
      name: skill.name,
      enabled: true,
      scope: skill.scope,
      ...(displayName ? { displayName } : {}),
      ...(shortDescription ? { shortDescription } : {}),
      ...(pluginId ? { pluginId } : {}),
    });
  }
  return { status: skills.length > 0 ? "available" : "empty", skills };
}
