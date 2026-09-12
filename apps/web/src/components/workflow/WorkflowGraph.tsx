import { memo, useEffect, useId, useMemo, useState } from "react";

import { deriveWorkflowGraphLayout } from "../../workflowGraph";
import type { WorkflowNode, WorkflowNodeStatus } from "../../workflowProjection";

const STATUS_COLOR: Readonly<Record<WorkflowNodeStatus, string>> = {
  queued: "#f59e0b",
  running: "#60a5fa",
  waiting: "#a78bfa",
  completed: "#34d399",
  failed: "#f87171",
  interrupted: "#fb923c",
  unknown: "#94a3b8",
};

const STATUS_LABEL: Readonly<Record<WorkflowNodeStatus, string>> = {
  queued: "Queued",
  running: "Running",
  waiting: "Waiting",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
  unknown: "Not reported",
};

/**
 * Draws the workflow nodes and the edges the projection reports.
 *
 * An edge means that the thread recorded the agent. It is not a claim that one
 * agent started another: no current Cafe provider reports that relationship.
 */
export const WorkflowGraph = memo(function WorkflowGraph({
  nodes,
}: {
  readonly nodes: readonly WorkflowNode[];
}) {
  const layout = useMemo(() => deriveWorkflowGraphLayout(nodes), [nodes]);
  const markerId = useId().replaceAll(":", "");
  const [selectedId, setSelectedId] = useState<string | null>(() => nodes[0]?.id ?? null);

  useEffect(() => {
    if (selectedId && nodes.some((node) => node.id === selectedId)) return;
    setSelectedId(nodes[0]?.id ?? null);
  }, [nodes, selectedId]);

  const selected = nodes.find((node) => node.id === selectedId) ?? null;
  const selectedParent = selected?.parentId
    ? (nodes.find((node) => node.id === selected.parentId) ?? null)
    : null;

  return (
    <div className="space-y-2" data-testid="workflow-graph">
      <div className="overflow-auto rounded-lg border border-border/50 bg-background/35">
        <div
          className="relative text-muted-foreground"
          style={{ height: layout.height, width: layout.width }}
        >
          <svg
            aria-hidden="true"
            className="absolute inset-0"
            height={layout.height}
            width={layout.width}
          >
            <defs>
              <marker
                id={markerId}
                markerHeight="6"
                markerWidth="7"
                orient="auto"
                refX="6"
                refY="3"
              >
                <path d="M 0 0 L 6 3 L 0 6 z" fill="currentColor" />
              </marker>
            </defs>
            {layout.edges.map((edge) => (
              <path
                d={edge.path}
                fill="none"
                key={edge.id}
                markerEnd={`url(#${markerId})`}
                stroke="currentColor"
                strokeOpacity="0.45"
                strokeWidth="1.5"
              />
            ))}
          </svg>

          {layout.nodes.map((entry) => {
            const active = entry.node.id === selectedId;
            const color = STATUS_COLOR[entry.node.status];
            return (
              <button
                aria-pressed={active}
                className="absolute overflow-hidden rounded-lg border bg-card/95 px-2.5 py-2 text-left shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-testid={`workflow-graph-node-${entry.node.id}`}
                key={entry.node.id}
                onClick={() => setSelectedId(entry.node.id)}
                style={{
                  borderColor: active ? color : `color-mix(in srgb, ${color} 45%, transparent)`,
                  height: entry.height,
                  left: entry.x,
                  top: entry.y,
                  width: entry.width,
                }}
                type="button"
              >
                <span className="flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: color }}
                  />
                  <span className="truncate text-[11px] font-medium text-foreground/90">
                    {entry.node.title}
                  </span>
                </span>
                <span className="mt-1 block truncate text-[9px] text-muted-foreground">
                  {entry.node.kind === "thread" ? "Thread" : "Agent"} ·{" "}
                  {STATUS_LABEL[entry.node.status]}
                </span>
                <span className="mt-1 block truncate text-[9px] text-muted-foreground/70">
                  {entry.node.detail ?? entry.node.objective ?? "Detail not reported"}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {layout.unknownParentCount > 0 ? (
        <p className="text-[10px] text-amber-300/80" data-testid="workflow-graph-unknown-parents">
          {layout.unknownParentCount} relationship
          {layout.unknownParentCount === 1 ? " is" : "s are"} unknown or cyclic. Cafe does not draw
          them.
        </p>
      ) : null}
      {layout.duplicateNodeIdCount > 0 ? (
        <p className="text-[10px] text-amber-300/80" data-testid="workflow-graph-duplicates">
          {layout.duplicateNodeIdCount} repeated node identifier
          {layout.duplicateNodeIdCount === 1 ? " was" : "s were"} dropped.
        </p>
      ) : null}

      {selected ? (
        <section
          aria-label="Selected workflow node"
          className="rounded-lg border border-border/45 bg-background/35 p-2"
          data-testid="workflow-graph-selection"
        >
          <h3 className="text-[11px] font-medium text-foreground/90">{selected.title}</h3>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {selected.objective ?? selected.detail ?? "Objective not reported"}
          </p>
          <p className="mt-1 text-[10px] text-muted-foreground/70">
            Recorded by:{" "}
            {selected.parentId === null
              ? "This node is the thread."
              : (selectedParent?.title ?? "The source reported a thread that is not available.")}
          </p>
        </section>
      ) : null}

      <ol aria-label="Workflow nodes and reported relationships" className="sr-only">
        {nodes.map((node) => (
          <li key={`accessible:${node.id}`}>
            {node.title}, {node.kind}, status {STATUS_LABEL[node.status]},{" "}
            {node.parentId
              ? `recorded by ${nodes.find((candidate) => candidate.id === node.parentId)?.title ?? "an unavailable thread"}`
              : "no parent reported"}
          </li>
        ))}
      </ol>
    </div>
  );
});
