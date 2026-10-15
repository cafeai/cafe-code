import { uiText } from "@cafecode/shared/i18n";
import type { EnvironmentId, EnvironmentApi } from "@cafecode/contracts";

import type { WsRpcClient } from "./rpc/wsRpcClient";
import { readEnvironmentConnection } from "./environments/runtime";
import type { EnvironmentConnection } from "./environments/runtime/connection";

const environmentApiOverridesForTests = new Map<EnvironmentId, EnvironmentApi>();
// Disclosure owners compare exact API identity as well as the connection and
// authenticated transport generation. Reconstructing this adapter on every
// read would make an unchanged production connection appear immediately stale.
// Key by the registry's connection, not its client or environment spelling: a
// replacement must get new identity even when it deliberately reuses a client.
// Weak ownership also releases adapters when their connection is no longer held.
const environmentApisByConnection = new WeakMap<EnvironmentConnection, EnvironmentApi>();

export function createEnvironmentApi(rpcClient: WsRpcClient): EnvironmentApi {
  return {
    mcpApps: rpcClient.mcpApps,
    visualizations: rpcClient.visualizations,
    providerInteractions: {
      respond: rpcClient.server.respondToInteraction,
      resolveUrl: rpcClient.server.resolveInteractionUrl,
    },
    scheduledFollowups: rpcClient.scheduledFollowups,
    projects: {
      searchEntries: rpcClient.projects.searchEntries,
      writeFile: rpcClient.projects.writeFile,
    },
    filesystem: {
      browse: rpcClient.filesystem.browse,
    },
    sourceControl: {
      lookupRepository: rpcClient.sourceControl.lookupRepository,
      cloneRepository: rpcClient.sourceControl.cloneRepository,
    },
    vcs: {
      pull: rpcClient.vcs.pull,
      refreshStatus: rpcClient.vcs.refreshStatus,
      onStatus: (input, callback, options) => rpcClient.vcs.onStatus(input, callback, options),
      listRefs: rpcClient.vcs.listRefs,
      createWorktree: rpcClient.vcs.createWorktree,
      removeWorktree: rpcClient.vcs.removeWorktree,
      createRef: rpcClient.vcs.createRef,
      switchRef: rpcClient.vcs.switchRef,
      init: rpcClient.vcs.init,
    },
    git: {
      resolvePullRequest: rpcClient.git.resolvePullRequest,
      preparePullRequestThread: rpcClient.git.preparePullRequestThread,
    },
    orchestration: {
      dispatchCommand: rpcClient.orchestration.dispatchCommand,
      getArchivedShellSnapshot: rpcClient.orchestration.getArchivedShellSnapshot,
      getDeletedShellSnapshot: rpcClient.orchestration.getDeletedShellSnapshot,
      getThreadTurnActivityPage: rpcClient.orchestration.getThreadTurnActivityPage,
      getThreadActivityDiagnostic: rpcClient.orchestration.getThreadActivityDiagnostic,
      getThreadTurnSubagentDetail: rpcClient.orchestration.getThreadTurnSubagentDetail,
      controlTask: rpcClient.orchestration.controlTask,
      getThreadTurnWorkLogPresence: rpcClient.orchestration.getThreadTurnWorkLogPresence,
      hardDeleteThread: rpcClient.orchestration.hardDeleteThread,
      repairAssistantMessageFromProviderJournal:
        rpcClient.orchestration.repairAssistantMessageFromProviderJournal,
      repairThreadAssistantMessages: rpcClient.orchestration.repairThreadAssistantMessages,
      subscribeShell: (callback, options) =>
        rpcClient.orchestration.subscribeShell(callback, options),
      subscribeThread: (input, callback, options) =>
        rpcClient.orchestration.subscribeThread(input, callback, options),
    },
  };
}

export function readEnvironmentApi(environmentId: EnvironmentId): EnvironmentApi | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  if (!environmentId) {
    return undefined;
  }

  const overriddenApi = environmentApiOverridesForTests.get(environmentId);
  if (overriddenApi) {
    return overriddenApi;
  }

  const connection = readEnvironmentConnection(environmentId);
  if (!connection) return undefined;
  const existing = environmentApisByConnection.get(connection);
  if (existing) return existing;
  const api = createEnvironmentApi(connection.client);
  environmentApisByConnection.set(connection, api);
  return api;
}

export function ensureEnvironmentApi(environmentId: EnvironmentId): EnvironmentApi {
  const api = readEnvironmentApi(environmentId);
  if (!api) {
    throw new Error(
      uiText("Environment API not found for environment {environmentId}", {
        environmentId: environmentId,
      }),
    );
  }
  return api;
}

export function __setEnvironmentApiOverrideForTests(
  environmentId: EnvironmentId,
  api: EnvironmentApi,
): void {
  environmentApiOverridesForTests.set(environmentId, api);
}

export function __resetEnvironmentApiOverridesForTests(): void {
  environmentApiOverridesForTests.clear();
}
