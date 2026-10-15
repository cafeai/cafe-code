import "../../index.css";
import {
  EnvironmentId,
  ProviderInstanceId,
  SubagentRuntimeId,
  ThreadId,
} from "@cafecode/contracts";
import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { AxiomMcpControl } from "./AxiomMcpControl";

const fixture = vi.hoisted(() => ({ manage: vi.fn() }));
vi.mock("../../environments/runtime", () => ({
  requireEnvironmentConnection: () => ({
    client: { server: { manageProviderMcp: fixture.manage } },
  }),
}));
const input = {
  instanceId: ProviderInstanceId.make("axiom-mcp-account"),
  threadId: ThreadId.make("axiom-mcp-chat"),
  runtimeId: SubagentRuntimeId.make("10000000-0000-4000-8000-000000000001"),
  modelId: "fixture-model",
};
const state = {
  revision: 4,
  servers: [
    {
      name: "fixture",
      command: "fixture-command",
      args: [],
      enabled: true,
      environmentKeys: ["SECRET"],
      status: "tested",
      error: null,
      tools: [
        { name: "mcp__fixture__example", description: "Fixture tool", schemaHash: "a".repeat(64) },
      ],
    },
  ],
  selectedTools: [],
};
beforeEach(() => fixture.manage.mockReset());

it("opens without a call, reads explicitly, and selects tools with the received revision", async () => {
  const onRevision = vi.fn();
  fixture.manage.mockResolvedValueOnce({ state }).mockResolvedValueOnce({
    state: { ...state, revision: 5, selectedTools: ["mcp__fixture__example"] },
  });
  await render(
    <AxiomMcpControl
      environmentId={EnvironmentId.make("local")}
      input={input}
      connected
      idle
      onRevision={onRevision}
    />,
  );
  await page.getByRole("button", { name: "MCP tools", exact: true }).click();
  expect(fixture.manage).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect
    .element(page.getByRole("checkbox", { name: "mcp__fixture__example Fixture tool" }))
    .toBeVisible();
  await page.getByRole("checkbox", { name: "mcp__fixture__example Fixture tool" }).click();
  await expect.poll(() => onRevision.mock.calls.at(-1)?.[0]).toBe(5);
  expect(fixture.manage.mock.calls[1]?.[0]).toEqual({
    ...input,
    expectedRevision: 4,
    action: { kind: "select", tools: ["mcp__fixture__example"] },
  });
});

it("blocks actions without an idle owned session and discards a response after ownership changes", async () => {
  const onRevision = vi.fn();
  let resolve!: (value: unknown) => void;
  fixture.manage.mockReturnValue(
    new Promise((value) => {
      resolve = value;
    }),
  );
  const view = await render(
    <AxiomMcpControl
      environmentId={EnvironmentId.make("local")}
      input={input}
      connected
      idle
      onRevision={onRevision}
    />,
  );
  await page.getByRole("button", { name: "MCP tools", exact: true }).click();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(() => fixture.manage.mock.calls.length).toBe(1);
  await view.rerender(
    <AxiomMcpControl
      environmentId={EnvironmentId.make("local")}
      input={{
        ...input,
        runtimeId: SubagentRuntimeId.make("10000000-0000-4000-8000-000000000002"),
      }}
      connected
      idle={false}
      onRevision={onRevision}
    />,
  );
  resolve({ state });
  await expect.element(page.getByRole("button", { name: "Refresh", exact: true })).toBeDisabled();
  expect(onRevision).not.toHaveBeenCalled();
});
