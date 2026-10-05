import { create } from "zustand";
import type { EnvironmentId } from "@cafecode/contracts";
export const useRemoteDesktopViewer = create<{
  target: { environmentId: EnvironmentId; id: string } | null;
}>(() => ({ target: null }));
