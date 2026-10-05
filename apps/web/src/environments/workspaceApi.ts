import type { EnvironmentId, LocalApi, ServerConfig } from "@cafecode/contracts";
import { readLocalApi } from "../localApi";
import { readPrimaryEnvironmentDescriptor } from "./primary";
import { readEnvironmentConnection } from "./runtime/service";
import { useSavedEnvironmentRuntimeStore } from "./runtime/catalog";
import { readWorkspaceEnvironmentId } from "./workspace";
import { getServerConfig } from "../rpc/serverState";

export function getWorkspaceServerConfig(
  environmentId = readWorkspaceEnvironmentId(),
): ServerConfig | null {
  const primary = getServerConfig();
  return !environmentId || environmentId === primary?.environment.environmentId
    ? primary
    : (useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.serverConfig ?? null);
}

/** Capture one server at the beginning of an action. An asynchronous result or
 * a confirmation dialog must never retarget its write after workspace switching. */
export function readWorkspaceApi(
  environmentId = readWorkspaceEnvironmentId(),
): LocalApi | undefined {
  const local = readLocalApi();
  if (!local) return undefined;
  if (
    !environmentId ||
    environmentId === readPrimaryEnvironmentDescriptor()?.environmentId ||
    environmentId === getServerConfig()?.environment.environmentId
  )
    return local;
  const connection = readEnvironmentConnection(environmentId);
  if (
    !connection ||
    useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.connectionState !== "connected"
  )
    return undefined;
  const remoteServer = {
    ...connection.client.server,
    getRuntimeLayerDiagnostics: (input = {}) =>
      connection.client.server.getRuntimeLayerDiagnostics(input),
  };
  const server = Object.fromEntries(
    Object.entries(remoteServer).map(([name, method]) => [
      name,
      name.startsWith("subscribe")
        ? method
        : (...args: unknown[]) =>
            Promise.resolve((method as (...args: unknown[]) => unknown)(...args)).catch(() => {
              throw new Error(
                "The selected server operation did not complete. Check the connection and your access before trying again.",
              );
            }),
    ]),
  ) as LocalApi["server"];
  return { ...local, server };
}

export function ensureWorkspaceApi(environmentId = readWorkspaceEnvironmentId()): LocalApi {
  const api = readWorkspaceApi(environmentId);
  if (!api) throw new Error("Reconnect to the selected Cafe server before trying again.");
  return api;
}

export function patchWorkspaceServerConfig(
  environmentId: EnvironmentId,
  patch: Partial<ServerConfig>,
): void {
  const runtime = useSavedEnvironmentRuntimeStore.getState();
  const config = runtime.byId[environmentId]?.serverConfig;
  if (config) runtime.patch(environmentId, { serverConfig: { ...config, ...patch } });
}
