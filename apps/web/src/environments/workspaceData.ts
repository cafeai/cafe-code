import type { EnvironmentId } from "@cafecode/contracts";
import { useShallow } from "zustand/react/shallow";
import {
  selectProjectsForEnvironment,
  selectSidebarThreadsForEnvironment,
  selectThreadsForEnvironment,
  useStore,
} from "../store";
import { useWorkspaceEnvironmentId } from "./workspace";

// Connections retain their own projections in the store. Visible catalogs
// read one server; switching never deletes another server's work or history.
export function useWorkspaceProjects(environmentId?: EnvironmentId | null) {
  const selected = useWorkspaceEnvironmentId();
  const target = environmentId === undefined ? selected : environmentId;
  return useStore(useShallow((state) => selectProjectsForEnvironment(state, target)));
}

export function useWorkspaceSidebarThreads() {
  const selected = useWorkspaceEnvironmentId();
  return useStore(useShallow((state) => selectSidebarThreadsForEnvironment(state, selected)));
}

export function useWorkspaceThreads(environmentId?: EnvironmentId | null) {
  const selected = useWorkspaceEnvironmentId();
  const target = environmentId === undefined ? selected : environmentId;
  return useStore(useShallow((state) => selectThreadsForEnvironment(state, target)));
}
