import { FetchHttpClient } from "effect/unstable/http";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OpenCodeRuntimeLive } from "../provider/opencodeRuntime.ts";
import { ProviderAdapterRegistryLive } from "../provider/Layers/ProviderAdapterRegistry.ts";
import { ProviderEventLoggersLive } from "../provider/Layers/ProviderEventLoggers.ts";
import { ProviderInstanceRegistryHydrationLive } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { ProviderServiceLive } from "../provider/Layers/ProviderService.ts";
import { ProviderSessionDirectoryLive } from "../provider/Layers/ProviderSessionDirectory.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderSupervisorRegistryLive } from "../providerSupervisor/ProviderSupervisorRegistry.ts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsLive } from "../serverSettings.ts";
import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore.ts";
import { SessionCredentialServiceLive } from "../auth/Layers/SessionCredentialService.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "../persistence/Layers/Sqlite.ts";
import { RemoteProviderServiceLive } from "./RemoteProviderService.ts";
import {
  ProviderRuntimeInventoryLocalLive,
  ProviderRuntimeInventoryRemoteSupervisorLive,
} from "./ProviderRuntimeInventory.ts";

const PersistenceLayerLive = Layer.empty.pipe(Layer.provideMerge(SqlitePersistenceLayerLive));

const ProviderMcpCredentialLayerLive = SessionCredentialServiceLive.pipe(
  Layer.provide(PersistenceLayerLive),
  Layer.provide(ServerSecretStoreLive),
);

const ProviderSessionDirectoryLayerLive = ProviderSessionDirectoryLive.pipe(
  Layer.provide(ProviderSessionRuntimeRepositoryLive),
);

const ProviderAdapterRegistryLayerLive = ProviderAdapterRegistryLive.pipe(
  Layer.provideMerge(ProviderInstanceRegistryHydrationLive),
);

const ProviderServiceLayerLive = ProviderServiceLive.pipe(
  Layer.provide(ProviderAdapterRegistryLayerLive),
  Layer.provideMerge(ProviderSessionDirectoryLayerLive),
);

const ProviderRuntimeInventoryLayerLive = ProviderRuntimeInventoryLocalLive.pipe(
  Layer.provide(ProviderAdapterRegistryLayerLive),
);

const LocalProviderRuntimeLayerLive = Layer.mergeAll(
  ProviderServiceLayerLive,
  ProviderRuntimeInventoryLayerLive,
  ProviderSupervisorRegistryLive,
);

const RemoteSupervisorProviderRuntimeLayerLive = Layer.mergeAll(
  RemoteProviderServiceLive,
  ProviderRuntimeInventoryRemoteSupervisorLive,
  ProviderSupervisorRegistryLive,
);

export const ProviderDaemonRuntimeLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return config.providerSupervisor === undefined
      ? LocalProviderRuntimeLayerLive
      : RemoteSupervisorProviderRuntimeLayerLive;
  }),
).pipe(
  Layer.provideMerge(PersistenceLayerLive),
  Layer.provideMerge(ServerSettingsLive),
  // Grok chat sessions need an owner bearer for Cafe's authenticated /mcp
  // endpoint. Provider adapters normally live in this detached process, so it
  // must issue/revoke credentials against the same SQLite + signing-secret
  // stores as the main backend rather than relying on process-global backend
  // state or sending a bearer through the provider command ledger.
  Layer.provideMerge(ProviderMcpCredentialLayerLive),
  Layer.provideMerge(ProviderEventLoggersLive),
  Layer.provideMerge(OpenCodeRuntimeLive),
  Layer.provideMerge(FetchHttpClient.layer),
);
