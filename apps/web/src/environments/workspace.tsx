import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@cafecode/contracts";
import { useParams } from "@tanstack/react-router";
import { createContext, useContext, useLayoutEffect, type ReactNode } from "react";
import { create } from "zustand";
import { useComposerDraftStore } from "../composerDraftStore";
import { readPrimaryEnvironmentDescriptor, usePrimaryEnvironmentId } from "./primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "./runtime/catalog";

// This selects a renderer workspace, never the authenticated primary transport.
// Keeping those identities separate prevents remote navigation from changing
// local bootstrap, safeStorage, or the ownership of native desktop actions.
export const useWorkspaceSelection = create<{ environmentId: EnvironmentId | null }>(() => ({
  environmentId: null,
}));
const WorkspaceContext = createContext<EnvironmentId | null | undefined>(undefined);

export function selectWorkspaceEnvironment(environmentId: EnvironmentId | null): void {
  useWorkspaceSelection.setState({ environmentId });
}

export function readWorkspaceEnvironmentId(): EnvironmentId | null {
  return (
    useWorkspaceSelection.getState().environmentId ??
    readPrimaryEnvironmentDescriptor()?.environmentId ??
    null
  );
}

export function readWorkspaceEnvironmentDescriptor(
  environmentId = readWorkspaceEnvironmentId(),
): ExecutionEnvironmentDescriptor | null {
  const primary = readPrimaryEnvironmentDescriptor();
  return environmentId === primary?.environmentId
    ? primary
    : environmentId
      ? (useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.descriptor ?? null)
      : null;
}

export function useWorkspaceEnvironmentId(): EnvironmentId | null {
  const provided = useContext(WorkspaceContext);
  const selected = useWorkspaceSelection((s) => s.environmentId);
  const primary = usePrimaryEnvironmentId();
  return provided !== undefined ? provided : (selected ?? primary);
}

/** New remote-only controls require an explicitly saved connection. The
 * primary server keeps its existing UX even when it is accessed in a browser. */
export function useIsSavedRemoteEnvironment(environmentId: EnvironmentId | null): boolean {
  const primary = usePrimaryEnvironmentId();
  const saved = useSavedEnvironmentRegistryStore((s) =>
    environmentId ? Boolean(s.byId[environmentId]) : false,
  );
  return environmentId !== null && environmentId !== primary && saved;
}

export function useWorkspaceContextEnvironmentId(): EnvironmentId | null | undefined {
  return useContext(WorkspaceContext);
}

export function WorkspaceEnvironmentProvider({ children }: { children: ReactNode }) {
  const primary = usePrimaryEnvironmentId();
  const selected = useWorkspaceSelection((s) => s.environmentId);
  const params = useParams({ strict: false }) as { environmentId?: string; draftId?: string };
  const draftEnvironmentId = useComposerDraftStore((s) =>
    params.draftId ? (s.draftThreadsByThreadKey[params.draftId]?.environmentId ?? null) : null,
  );
  const records = useSavedEnvironmentRegistryStore((s) => s.byId);
  const routeEnvironmentId = params.environmentId
    ? EnvironmentId.make(params.environmentId)
    : draftEnvironmentId;
  // Resolve the route before rendering children. Waiting for a selection effect
  // would allow the old Desk's route echo to overwrite a remote deep link.
  const environmentId =
    routeEnvironmentId ??
    (selected && (selected === primary || records[selected]) ? selected : primary);
  useLayoutEffect(() => {
    selectWorkspaceEnvironment(environmentId);
  }, [environmentId]);
  return <WorkspaceContext.Provider value={environmentId}>{children}</WorkspaceContext.Provider>;
}

export function resetWorkspaceEnvironmentForTests(): void {
  selectWorkspaceEnvironment(null);
}
