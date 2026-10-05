import { useSyncExternalStore } from "react";
import { EnvironmentId } from "@cafecode/contracts";
import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
const fixture = vi.hoisted(() => ({
  params: {} as { environmentId?: string; draftId?: string },
  listeners: new Set<() => void>(),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useParams: () =>
    useSyncExternalStore(
      (listener) => {
        fixture.listeners.add(listener);
        return () => fixture.listeners.delete(listener);
      },
      () => fixture.params,
    ),
  useNavigate: () => vi.fn(),
  useLocation: ({ select }: { select: (location: { pathname: string }) => unknown }) =>
    select({ pathname: "/" }),
}));
vi.mock("../localApi", () => ({
  ensureLocalApi: () => ({ persistence: {} }),
  readLocalApi: () => undefined,
}));
import { writePrimaryEnvironmentDescriptor } from "../environments/primary";
import { useSavedEnvironmentRegistryStore } from "../environments/runtime/catalog";
import {
  resetWorkspaceEnvironmentForTests,
  selectWorkspaceEnvironment,
  useWorkspaceEnvironmentId,
  useIsSavedRemoteEnvironment,
  WorkspaceEnvironmentProvider,
} from "../environments/workspace";
import { useComposerDraftStore } from "../composerDraftStore";
import { WorkspaceEnvironmentSelector } from "./WorkspaceEnvironmentSelector";
const local = EnvironmentId.make("local"),
  remote = EnvironmentId.make("remote");
function Current() {
  const environmentId = useWorkspaceEnvironmentId();
  const savedRemote = useIsSavedRemoteEnvironment(environmentId);
  return (
    <output data-testid="workspace" data-remote={savedRemote}>
      {environmentId}
    </output>
  );
}
beforeEach(() => {
  fixture.params = {};
  resetWorkspaceEnvironmentForTests();
  writePrimaryEnvironmentDescriptor({ environmentId: local } as never);
  useSavedEnvironmentRegistryStore.setState({
    byId: {
      [remote]: {
        environmentId: remote,
        label: "PC",
        httpBaseUrl: "https://pc",
        wsBaseUrl: "wss://pc",
        createdAt: "fixture",
        lastConnectedAt: null,
      },
    },
  });
  useComposerDraftStore.setState({ draftThreadsByThreadKey: {} });
});
it("admits a remote deep link before rendering children and keeps workspace selection separate from local bootstrap", async () => {
  fixture.params = { environmentId: remote };
  const screen = await render(
    <WorkspaceEnvironmentProvider>
      <Current />
    </WorkspaceEnvironmentProvider>,
  );
  expect(screen.getByTestId("workspace")).toHaveTextContent(remote);
  expect(screen.getByTestId("workspace")).toHaveAttribute("data-remote", "true");
  fixture.params = {};
  for (const listener of fixture.listeners) listener();
  await expect.element(screen.getByTestId("workspace")).toHaveTextContent(remote);
  selectWorkspaceEnvironment(local);
  await expect.element(screen.getByTestId("workspace")).toHaveTextContent(local);
  await expect.element(screen.getByTestId("workspace")).toHaveAttribute("data-remote", "false");
});
it("selects the draft's server and falls back to local after the selected saved server is removed", async () => {
  useComposerDraftStore.setState({
    draftThreadsByThreadKey: { draft: { environmentId: remote } as never },
  });
  fixture.params = { draftId: "draft" };
  const screen = await render(
    <WorkspaceEnvironmentProvider>
      <Current />
    </WorkspaceEnvironmentProvider>,
  );
  await expect.element(screen.getByTestId("workspace")).toHaveTextContent(remote);
  fixture.params = {};
  for (const listener of fixture.listeners) listener();
  useSavedEnvironmentRegistryStore.setState({ byId: {} });
  await expect.element(screen.getByTestId("workspace")).toHaveTextContent(local);
  await expect.element(screen.getByTestId("workspace")).toHaveAttribute("data-remote", "false");
});
it("keeps the workspace selector absent until a remote connection is saved", async () => {
  const saved = useSavedEnvironmentRegistryStore.getState().byId;
  useSavedEnvironmentRegistryStore.setState({ byId: {} });
  const screen = await render(
    <WorkspaceEnvironmentProvider>
      <WorkspaceEnvironmentSelector />
    </WorkspaceEnvironmentProvider>,
  );
  await expect
    .element(screen.getByRole("combobox", { name: "Workspace server" }))
    .not.toBeInTheDocument();
  useSavedEnvironmentRegistryStore.setState({ byId: saved });
  await expect.element(screen.getByRole("combobox", { name: "Workspace server" })).toBeVisible();
  useSavedEnvironmentRegistryStore.setState({ byId: {} });
  await expect
    .element(screen.getByRole("combobox", { name: "Workspace server" }))
    .not.toBeInTheDocument();
});
