import type { RelayNode } from "./descriptor.ts";
export interface RelayObservation {
  readonly nodeId: string;
  readonly rtt: number;
  readonly measuredAt: number;
}
/** Choose on host-observed RTT, with a finite stale horizon and switch margin. */
export function selectHostRelays(
  nodes: readonly RelayNode[],
  observations: readonly RelayObservation[],
  currentPrimary: string | undefined,
  now: number,
): readonly RelayNode[] {
  const scores = new Map(
    observations
      .filter(
        (value) =>
          Number.isFinite(value.rtt) &&
          value.rtt >= 0 &&
          value.measuredAt <= now &&
          now - value.measuredAt < 300_000,
      )
      .map((value) => [value.nodeId, value.rtt]),
  );
  const ordered = [...nodes].sort(
    (a, b) => (scores.get(a.id) ?? Infinity) - (scores.get(b.id) ?? Infinity),
  );
  const current = ordered.find((node) => node.id === currentPrimary),
    fastest = ordered[0];
  if (current && fastest && current !== fastest) {
    const oldScore = scores.get(current.id) ?? Infinity,
      newScore = scores.get(fastest.id) ?? Infinity;
    if (newScore >= oldScore * 0.8 || oldScore - newScore < 10) {
      ordered.splice(ordered.indexOf(current), 1);
      ordered.unshift(current);
    }
  }
  return ordered.slice(0, 2);
}
