import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EnvironmentId, ThreadId } from "@cafecode/contracts";
import { VisualizationListResult } from "@cafecode/contracts/visualizationApi";
import * as Schema from "effect/Schema";
import { observeVisualizationOwner, useVisualizationTransportRevision } from "./visualizationOwner";
import {
  createVisualizationHistoryController,
  type VisualizationHistoryState,
  type VisualizationHistoryViewport,
} from "./visualizationHistoryController";

const decodeList = Schema.decodeUnknownSync(VisualizationListResult);
const EMPTY: VisualizationHistoryState = { entries: [], loading: false, failed: false };

/** Compact metadata follows actual list visibility; chart execution stays separately admitted. */
export function useThreadVisualizations(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
  foreground: boolean,
  revision: string,
) {
  const scope = JSON.stringify([environmentId, threadId, foreground]);
  const transportRevision = useVisualizationTransportRevision(environmentId);
  const previousRevision = useRef({ scope, revision });
  const committed = useRef(scope);
  const reader = useRef<ReturnType<typeof createVisualizationHistoryController> | null>(null);
  const viewport = useRef<{ scope: string; value: VisualizationHistoryViewport } | null>(null);
  const [state, setState] = useState<{ scope: string; value: VisualizationHistoryState }>({
    scope,
    value: EMPTY,
  });
  useLayoutEffect(() => {
    committed.current = scope;
    return () => {
      committed.current = "";
    };
  }, [scope]);
  useEffect(() => {
    if (!foreground || !threadId) return;
    let stopped = false;
    let scopedReader: ReturnType<typeof createVisualizationHistoryController> | undefined;
    const owner = observeVisualizationOwner(environmentId, () => {
      stopped = true;
      scopedReader?.close();
      setState({ scope, value: { ...EMPTY, failed: true } });
    });
    scopedReader = createVisualizationHistoryController({
      threadId,
      current: () => !stopped && committed.current === scope && owner.current(),
      list: async (input) => {
        if (!owner.api?.visualizations) throw new Error("visualization-history-unavailable");
        return decodeList(await owner.api.visualizations.list(input));
      },
      publish: (value) => setState({ scope, value }),
    });
    reader.current = scopedReader;
    scopedReader.invalidate();
    if (viewport.current?.scope === scope) scopedReader.observeViewport(viewport.current.value);
    return () => {
      stopped = true;
      scopedReader.close();
      if (reader.current === scopedReader) reader.current = null;
      owner.dispose();
    };
  }, [environmentId, threadId, foreground, scope, transportRevision]);
  useEffect(() => {
    const previous = previousRevision.current;
    previousRevision.current = { scope, revision };
    if (previous.scope === scope && previous.revision !== revision) reader.current?.invalidate();
  }, [scope, revision]);
  return {
    ...(state.scope === scope && foreground ? state.value : EMPTY),
    observeViewport: useCallback(
      (value: VisualizationHistoryViewport) => {
        viewport.current = { scope, value };
        if (committed.current === scope) reader.current?.observeViewport(value);
      },
      [scope],
    ),
    refresh: useCallback(() => reader.current?.retry(), []),
  };
}
