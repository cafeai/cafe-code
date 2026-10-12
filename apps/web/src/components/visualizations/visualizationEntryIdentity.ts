import type { VisualizationTimelineEntry } from "@cafecode/contracts/visualizationApi";

/**
 * Immutable content can be reused by separate authenticated native invocations.
 * History identity therefore includes its exact message/turn/origin and actor,
 * not just the content revision. JSON tuple framing avoids delimiter collisions;
 * display labels and timestamps never retarget an already admitted history row.
 * Content/poster caches deliberately retain their separate revision identity.
 */
export function visualizationEntryIdentity(entry: VisualizationTimelineEntry): string {
  return JSON.stringify([
    entry.messageId,
    entry.turnId,
    entry.originItemId,
    entry.reference.artifactId,
    entry.reference.revisionId,
    entry.actor.type,
    entry.actor.type === "child" ? entry.actor.id : null,
  ]);
}
