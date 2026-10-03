import { describe, expect, it } from "vitest";

import {
  deriveWorkflowGraphLayout,
  WORKFLOW_GRAPH_MAX_LEVEL,
  WORKFLOW_GRAPH_NODE_HEIGHT,
  WORKFLOW_GRAPH_NODE_WIDTH,
} from "./workflowGraph";
import type { WorkflowNode } from "./workflowProjection";

function node(id: string, parentId: string | null, overrides: Partial<WorkflowNode> = {}) {
  return {
    id,
    parentId,
    kind: parentId === null ? "thread" : "agent",
    title: id,
    objective: null,
    detail: null,
    status: "running",
    startedAt: null,
    lastActivityAt: null,
    completedAt: null,
    observedSpanSeconds: null,
    ...overrides,
  } satisfies WorkflowNode;
}

describe("deriveWorkflowGraphLayout", () => {
  it("returns a bounded empty frame for no nodes", () => {
    const layout = deriveWorkflowGraphLayout([]);

    expect(layout.nodes).toHaveLength(0);
    expect(layout.edges).toHaveLength(0);
    expect(layout.width).toBeGreaterThan(WORKFLOW_GRAPH_NODE_WIDTH);
    expect(layout.height).toBeGreaterThan(WORKFLOW_GRAPH_NODE_HEIGHT);
  });

  it("places children one level right of the parent and draws one edge each", () => {
    const layout = deriveWorkflowGraphLayout([
      node("thread:1", null),
      node("agent:a", "thread:1"),
      node("agent:b", "thread:1"),
    ]);

    expect(layout.nodes.map((entry) => entry.level)).toEqual([0, 1, 1]);
    expect(layout.edges.map((edge) => edge.childId)).toEqual(["agent:a", "agent:b"]);
    expect(layout.edges[0]?.path).toMatch(/^M \d/);
    expect(layout.unknownParentCount).toBe(0);
  });

  it("keeps a node with an unknown parent at the root level and counts it", () => {
    const layout = deriveWorkflowGraphLayout([
      node("thread:1", null),
      node("agent:a", "thread:missing"),
    ]);

    expect(layout.unknownParentCount).toBe(1);
    expect(layout.edges).toHaveLength(0);
    expect(layout.nodes.find((entry) => entry.node.id === "agent:a")?.level).toBe(0);
  });

  it("breaks a cycle without drawing an edge and without recursion failure", () => {
    const layout = deriveWorkflowGraphLayout([
      node("agent:a", "agent:b"),
      node("agent:b", "agent:c"),
      node("agent:c", "agent:a"),
    ]);

    expect(layout.nodes).toHaveLength(3);
    expect(layout.edges).toHaveLength(0);
    expect(layout.nodes.every((entry) => entry.level === 0)).toBe(true);
  });

  it("breaks a self-referencing node", () => {
    const layout = deriveWorkflowGraphLayout([node("agent:a", "agent:a")]);

    expect(layout.nodes).toHaveLength(1);
    expect(layout.edges).toHaveLength(0);
  });

  it("drops a repeated node id and counts it", () => {
    const layout = deriveWorkflowGraphLayout([
      node("thread:1", null),
      node("agent:a", "thread:1"),
      node("agent:a", "thread:1", { title: "repeat" }),
    ]);

    expect(layout.nodes).toHaveLength(2);
    expect(layout.duplicateNodeIdCount).toBe(1);
    expect(layout.nodes.at(-1)?.node.title).toBe("agent:a");
  });

  it("clamps a deep chain to the maximum level", () => {
    const nodes = [
      node("n0", null),
      ...Array.from({ length: WORKFLOW_GRAPH_MAX_LEVEL + 6 }, (_, index) =>
        node(`n${index + 1}`, `n${index}`),
      ),
    ];

    const layout = deriveWorkflowGraphLayout(nodes);

    expect(Math.max(...layout.nodes.map((entry) => entry.level))).toBe(WORKFLOW_GRAPH_MAX_LEVEL);
  });

  it("produces the same layout for the same input", () => {
    const nodes = [node("thread:1", null), node("agent:a", "thread:1")];

    expect(deriveWorkflowGraphLayout(nodes)).toEqual(deriveWorkflowGraphLayout(nodes));
  });
});
