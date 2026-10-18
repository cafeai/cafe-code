import "../../index.css";
import { EnvironmentId, type ServerConfig } from "@cafecode/contracts";
import { setUiLocale } from "@cafecode/shared/i18n";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { DataProfileSettings } from "./DataProfileSettings";

const state = vi.hoisted(() => ({
  selectedId: "local",
  configs: {} as Record<
    string,
    Pick<ServerConfig, "dataProfile" | "dataDirectoryPath" | "environment"> | null
  >,
  reads: [] as string[],
}));

vi.mock("../../environments/workspace", () => ({
  useWorkspaceEnvironmentId: () => state.selectedId,
}));
vi.mock("../../rpc/serverState", () => ({
  useServerConfig: (id: string) => {
    state.reads.push(id);
    return state.configs[id] ?? null;
  },
}));

function config(
  profile: "production" | "debug" | undefined,
  path: string | undefined,
  label: string,
) {
  return {
    dataProfile: profile,
    dataDirectoryPath: path,
    environment: {
      environmentId: EnvironmentId.make(label),
      label,
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: true },
    },
  } satisfies Pick<ServerConfig, "dataProfile" | "dataDirectoryPath" | "environment">;
}

beforeEach(() => {
  setUiLocale("en");
  state.selectedId = "local";
  state.reads = [];
  state.configs = {
    local: config("debug", "/fixture/Cafe/.debug/userdata", "Local Debug"),
    remote: config("production", "/srv/cafe/userdata", "Remote release"),
  };
});

describe("data profile settings", () => {
  it("shows the authenticated Debug data directory without an edit or migration action", async () => {
    await render(<DataProfileSettings />);
    await expect.element(page.getByText("Debug", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText("/fixture/Cafe/.debug/userdata", { exact: true }))
      .toBeVisible();
    await expect.element(page.getByText("Local Debug", { exact: true })).toBeVisible();
    expect(state.reads.every((id) => id === "local")).toBe(true);
    await expect.element(page.getByRole("button")).not.toBeInTheDocument();
  });

  it("uses the selected remote server instead of borrowing the local Debug profile", async () => {
    state.selectedId = "remote";
    await render(<DataProfileSettings />);
    await expect.element(page.getByText("Production", { exact: true })).toBeVisible();
    await expect.element(page.getByText("/srv/cafe/userdata", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Remote release", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText("/fixture/Cafe/.debug/userdata", { exact: true }))
      .not.toBeInTheDocument();
    expect(state.reads.length).toBeGreaterThan(0);
    expect(state.reads.every((id) => id === "remote")).toBe(true);
  });

  it("does not infer a legacy or disconnected server's profile from desktop state", async () => {
    state.configs.local = config(undefined, undefined, "Legacy server");
    await render(<DataProfileSettings />);
    await expect.element(page.getByText("Unavailable", { exact: true }).first()).toBeVisible();
    await expect.element(page.getByText("Debug", { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByText("Production", { exact: true })).not.toBeInTheDocument();
  });
});
