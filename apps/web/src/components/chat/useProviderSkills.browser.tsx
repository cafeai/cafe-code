import { useState } from "react";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  DEFAULT_UNIFIED_SETTINGS,
  type ProviderSkillsInput,
  type ProviderSkillsResult,
  type ServerProvider,
} from "@cafecode/contracts";
import { render } from "vitest-browser-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { providerSkillsScopeRevision, useProviderSkills } from "./useProviderSkills";

const { read } = vi.hoisted(() => ({
  read: vi.fn<(input: ProviderSkillsInput, env: string) => Promise<ProviderSkillsResult>>(),
}));
vi.mock("../../environments/runtime", () => ({
  requireEnvironmentConnection: (env: string) => ({
    client: { server: { listProviderSkills: (input: ProviderSkillsInput) => read(input, env) } },
  }),
}));
const env = EnvironmentId.make("local");
const input: ProviderSkillsInput = {
  instanceId: ProviderInstanceId.make("personal"),
  context: { kind: "thread", threadId: ThreadId.make("chat") },
};
function Harness({
  scope = input,
  environment = env,
  revision = "",
}: {
  scope?: ProviderSkillsInput;
  environment?: EnvironmentId;
  revision?: string;
}) {
  const [open, setOpen] = useState(false);
  const result = useProviderSkills(environment, scope, open, revision);
  return (
    <>
      <button onClick={() => setOpen(!open)}>{open ? "Close" : "Open"}</button>
      <div role="status">{result.loading ? "Loading" : (result.status ?? "Not requested")}</div>
      {result.skills.map((skill) => (
        <span key={skill.name}>{skill.name}</span>
      ))}
    </>
  );
}
const available = (name: string): ProviderSkillsResult => ({
  status: "available",
  skills: [{ name, enabled: true }],
});
afterEach(() => vi.clearAllMocks());
describe("gesture-owned skill discovery", () => {
  it("invalidates only workspace/account configuration, not periodic provider metadata", () => {
    const snapshot: ServerProvider = {
      instanceId: input.instanceId,
      driver: "codex" as ServerProvider["driver"],
      enabled: true,
      installed: true,
      version: "0.160.0",
      status: "ready",
      auth: { status: "authenticated", email: "old@example.test" },
      checkedAt: "2026-10-05T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    };
    const scope = {
      cwd: "/saved/worktree",
      instanceId: input.instanceId,
      settings: DEFAULT_UNIFIED_SETTINGS,
      snapshot,
    };
    const before = providerSkillsScopeRevision(scope);
    expect(
      providerSkillsScopeRevision({
        ...scope,
        snapshot: {
          ...snapshot,
          checkedAt: "2026-10-05T00:00:05.000Z",
          models: [{ slug: "new", name: "New", isCustom: false, capabilities: {} }],
          message: "Periodic probe completed",
        },
      }),
    ).toBe(before);
    expect(providerSkillsScopeRevision({ ...scope, cwd: "/moved/worktree" })).not.toBe(before);
    expect(
      providerSkillsScopeRevision({
        ...scope,
        snapshot: { ...snapshot, auth: { status: "authenticated", email: "new@example.test" } },
      }),
    ).not.toBe(before);
    expect(
      providerSkillsScopeRevision({
        ...scope,
        settings: {
          ...DEFAULT_UNIFIED_SETTINGS,
          providerInstances: {
            [input.instanceId]: { driver: snapshot.driver, config: { homePath: "/changed/home" } },
          },
        },
      }),
    ).not.toBe(before);
    const sensitiveSettings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [input.instanceId]: {
          driver: snapshot.driver,
          config: { homePath: "/private/provider/home", credential: "private-config-canary" },
          environment: [{ name: "API_KEY", value: "private-environment-canary", sensitive: true }],
        },
      },
    };
    const opaque = providerSkillsScopeRevision({ ...scope, settings: sensitiveSettings });
    expect(opaque).not.toContain("private-config-canary");
    expect(opaque).not.toContain("private-environment-canary");
    expect(opaque).not.toContain("/private/provider/home");
    expect(
      providerSkillsScopeRevision({
        ...scope,
        settings: sensitiveSettings,
        snapshot: { ...snapshot, checkedAt: "2026-10-05T00:00:10.000Z" },
      }),
    ).toBe(opaque);
  });

  it.each(["cwd", "configuration"])(
    "clears a completed result under the same IDs when %s changes",
    async (revision) => {
      read.mockResolvedValueOnce(available("old-scope-skill"));
      let finish!: (result: ProviderSkillsResult) => void;
      read.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const view = await render(<Harness revision="original" />);
      await page.getByRole("button", { name: "Open", exact: true }).click();
      await expect.element(page.getByText("old-scope-skill")).toBeVisible();
      await view.rerender(<Harness revision={revision} />);
      await expect.element(page.getByRole("status")).toHaveTextContent("Loading");
      await expect.element(page.getByText("old-scope-skill")).not.toBeInTheDocument();
      expect(read).toHaveBeenLastCalledWith(input, env);
      expect(read).toHaveBeenCalledTimes(2);
      finish(available("current-scope-skill"));
      await expect.element(page.getByText("current-scope-skill")).toBeVisible();
      await view.rerender(<Harness revision={revision} />);
      expect(read).toHaveBeenCalledTimes(2);
    },
  );

  it("fences a slow result when workspace/configuration changes under the same IDs", async () => {
    let finishOld!: (result: ProviderSkillsResult) => void;
    read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    read.mockResolvedValue(available("current-scope-skill"));
    const view = await render(<Harness revision="original" />);
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await view.rerender(<Harness revision="changed-cwd-and-config" />);
    await expect.element(page.getByText("current-scope-skill")).toBeVisible();
    finishOld(available("private-retired-skill"));
    await expect.element(page.getByText("private-retired-skill")).not.toBeInTheDocument();
    await expect.element(page.getByText("current-scope-skill")).toBeVisible();
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenLastCalledWith(input, env);
  });
  it("does not probe at mount, reads the exact instance/context and refreshes only on reopening", async () => {
    read.mockResolvedValue(available("review"));
    const view = await render(<Harness />);
    expect(read).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await expect.element(page.getByText("review", { exact: true })).toBeVisible();
    expect(read).toHaveBeenCalledExactlyOnceWith(input, env);
    await view.rerender(<Harness />);
    expect(read).toHaveBeenCalledTimes(1);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    read.mockResolvedValue({ status: "empty", skills: [] });
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await expect.element(page.getByRole("status")).toHaveTextContent("empty");
    await expect.element(page.getByText("review", { exact: true })).not.toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(2);
  });
  it.each(["account", "project", "environment"])(
    "fences old catalogue responses on %s changes",
    async (kind) => {
      let resolveOld!: (result: ProviderSkillsResult) => void;
      read.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      );
      read.mockResolvedValue(available("new-skill"));
      const view = await render(<Harness />);
      await page.getByRole("button", { name: "Open", exact: true }).click();
      const next =
        kind === "account"
          ? { ...input, instanceId: ProviderInstanceId.make("work") }
          : kind === "project"
            ? {
                ...input,
                context: { kind: "project" as const, projectId: ProjectId.make("new-project") },
              }
            : input;
      await view.rerender(
        <Harness
          scope={next}
          environment={kind === "environment" ? EnvironmentId.make("remote") : env}
        />,
      );
      await expect.element(page.getByText("new-skill", { exact: true })).toBeVisible();
      resolveOld(available("private-old-skill"));
      await expect
        .element(page.getByText("private-old-skill", { exact: true }))
        .not.toBeInTheDocument();
      await expect.element(page.getByText("new-skill", { exact: true })).toBeVisible();
    },
  );
  it("hides a previous permitted result immediately while an explicit refresh is pending", async () => {
    read.mockResolvedValueOnce(available("previous-skill"));
    let finish!: (result: ProviderSkillsResult) => void;
    read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render(<Harness />);
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await expect.element(page.getByText("previous-skill")).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await expect.element(page.getByRole("status")).toHaveTextContent("Loading");
    await expect.element(page.getByText("previous-skill")).not.toBeInTheDocument();
    finish({ status: "empty", skills: [] });
    await expect.element(page.getByRole("status")).toHaveTextContent("empty");
  });

  it("reports disabled/error states without provider exception text", async () => {
    read
      .mockResolvedValueOnce({ status: "disabled", skills: [] })
      .mockRejectedValueOnce(new Error("private-path-and-secret"));
    await render(<Harness />);
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await expect.element(page.getByRole("status")).toHaveTextContent("disabled");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await expect.element(page.getByRole("status")).toHaveTextContent("unavailable");
    await expect.element(page.getByText("private-path-and-secret")).not.toBeInTheDocument();
  });
});
