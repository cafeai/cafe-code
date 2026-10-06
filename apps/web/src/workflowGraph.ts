import type { WorkflowNode } from "./workflowProjection";

/**
 * Deterministic layout for the workflow graph.
 *
 * The layout draws only the edges the projection reports. A missing parent, a
 * cycle, or a repeated node id leaves the node unconnected and is counted, so
 * the view can state the limit instead of inventing a relationship.
 *
 * Sizes follow the silver ratio (1 + sqrt(2), about 2.414): the node box is
 * 188x78 (about 2.41:1), the row gap is 32, and the column gap is 32 * 2.414.
 */
export const WORKFLOW_GRAPH_NODE_WIDTH = 188;
export const WORKFLOW_GRAPH_NODE_HEIGHT = 78;
export const WORKFLOW_GRAPH_ROW_GAP = 32;
export const WORKFLOW_GRAPH_COLUMN_GAP = 77;
export const WORKFLOW_GRAPH_PADDING = 32;
export const WORKFLOW_GRAPH_MAX_LEVEL = 12;

export interface WorkflowGraphNodeLayout {
  readonly node: WorkflowNode;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly level: number;
}

export interface WorkflowGraphEdgeLayout {
  readonly id: string;
  readonly parentId: string;
  readonly childId: string;
  readonly path: string;
}

export interface WorkflowGraphLayout {
  readonly nodes: readonly WorkflowGraphNodeLayout[];
  readonly edges: readonly WorkflowGraphEdgeLayout[];
  readonly width: number;
  readonly height: number;
  /** Nodes that name a parent the layout cannot draw. */
  readonly unknownParentCount: number;
  /** Repeated node ids that the layout dropped. */
  readonly duplicateNodeIdCount: number;
}

function levelOf(
  node: WorkflowNode,
  byId: ReadonlyMap<string, WorkflowNode>,
  memo: Map<string, number>,
  visiting: Set<string>,
): number {
  const known = memo.get(node.id);
  if (known !== undefined) return known;
  if (!node.parentId) {
    memo.set(node.id, 0);
    return 0;
  }
  // A node that is already on the current walk closes a cycle. Place it at the
  // root level and draw no edge for it.
  if (visiting.has(node.id)) {
    memo.set(node.id, 0);
    return 0;
  }
  const parent = byId.get(node.parentId);
  if (!parent) {
    memo.set(node.id, 0);
    return 0;
  }
  visiting.add(node.id);
  const level = Math.min(WORKFLOW_GRAPH_MAX_LEVEL, levelOf(parent, byId, memo, visiting) + 1);
  visiting.delete(node.id);
  memo.set(node.id, level);
  return level;
}

function edgePath(parent: WorkflowGraphNodeLayout, child: WorkflowGraphNodeLayout): string {
  const startX = parent.x + parent.width;
  const startY = parent.y + parent.height / 2;
  const endX = child.x;
  const endY = child.y + child.height / 2;
  const midpointX = startX + Math.max(20, (endX - startX) / 2);
  return `M ${startX} ${startY} H ${midpointX} V ${endY} H ${endX}`;
}

function emptyLayout(duplicateNodeIdCount: number): WorkflowGraphLayout {
  return {
    nodes: [],
    edges: [],
    width: WORKFLOW_GRAPH_NODE_WIDTH + WORKFLOW_GRAPH_PADDING * 2,
    height: WORKFLOW_GRAPH_NODE_HEIGHT + WORKFLOW_GRAPH_PADDING * 2,
    unknownParentCount: 0,
    duplicateNodeIdCount,
  };
}

/**
 * Builds the node and edge boxes for one snapshot.
 *
 * Call with `snapshot.nodes`. The function is pure and does no measurement, so
 * the same snapshot always produces the same picture.
 */
export function deriveWorkflowGraphLayout(
  sourceNodes: readonly WorkflowNode[],
): WorkflowGraphLayout {
  const byId = new Map<string, WorkflowNode>();
  const uniqueNodes: WorkflowNode[] = [];
  let duplicateNodeIdCount = 0;
  for (const node of sourceNodes) {
    if (byId.has(node.id)) {
      duplicateNodeIdCount += 1;
      continue;
    }
    byId.set(node.id, node);
    uniqueNodes.push(node);
  }
  if (uniqueNodes.length === 0) {
    return emptyLayout(duplicateNodeIdCount);
  }

  const cyclicIds = new Set<string>();
  for (const node of uniqueNodes) {
    const chain: string[] = [];
    const positions = new Map<string, number>();
    let current: WorkflowNode | undefined = node;
    while (current) {
      const repeatedAt = positions.get(current.id);
      if (repeatedAt !== undefined) {
        for (const id of chain.slice(repeatedAt)) cyclicIds.add(id);
        break;
      }
      positions.set(current.id, chain.length);
      chain.push(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
  }

  const levelById = new Map<string, number>();
  const groups = new Map<number, WorkflowNode[]>();
  let unknownParentCount = 0;
  for (const node of uniqueNodes) {
    const level = cyclicIds.has(node.id) ? 0 : levelOf(node, byId, levelById, new Set());
    const group = groups.get(level) ?? [];
    group.push(node);
    groups.set(level, group);
    if (node.parentId && !byId.has(node.parentId)) unknownParentCount += 1;
  }

  const nodes: WorkflowGraphNodeLayout[] = [];
  let maxRows = 1;
  for (const [level, group] of Array.from(groups.entries()).toSorted(
    ([left], [right]) => left - right,
  )) {
    maxRows = Math.max(maxRows, group.length);
    for (const [row, node] of group.entries()) {
      nodes.push({
        node,
        level,
        x: WORKFLOW_GRAPH_PADDING + level * (WORKFLOW_GRAPH_NODE_WIDTH + WORKFLOW_GRAPH_COLUMN_GAP),
        y: WORKFLOW_GRAPH_PADDING + row * (WORKFLOW_GRAPH_NODE_HEIGHT + WORKFLOW_GRAPH_ROW_GAP),
        width: WORKFLOW_GRAPH_NODE_WIDTH,
        height: WORKFLOW_GRAPH_NODE_HEIGHT,
      });
    }
  }

  const layoutById = new Map(nodes.map((node) => [node.node.id, node] as const));
  const edges = nodes.flatMap<WorkflowGraphEdgeLayout>((child) => {
    const parentId = child.node.parentId;
    if (!parentId) return [];
    const parent = layoutById.get(parentId);
    if (
      cyclicIds.has(child.node.id) ||
      cyclicIds.has(parentId) ||
      !parent ||
      parent.level >= child.level
    ) {
      // The parent exists but the edge is not drawable, so report it as an
      // unknown relationship rather than drawing a guess.
      if (parent) unknownParentCount += 1;
      return [];
    }
    return [
      {
        id: `${parentId}->${child.node.id}`,
        parentId,
        childId: child.node.id,
        path: edgePath(parent, child),
      },
    ];
  });

  const maxLevel = Math.max(...nodes.map((node) => node.level), 0);
  return {
    nodes,
    edges,
    width:
      WORKFLOW_GRAPH_PADDING * 2 +
      (maxLevel + 1) * WORKFLOW_GRAPH_NODE_WIDTH +
      maxLevel * WORKFLOW_GRAPH_COLUMN_GAP,
    height:
      WORKFLOW_GRAPH_PADDING * 2 +
      maxRows * WORKFLOW_GRAPH_NODE_HEIGHT +
      (maxRows - 1) * WORKFLOW_GRAPH_ROW_GAP,
    unknownParentCount,
    duplicateNodeIdCount,
  };
}
