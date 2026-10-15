import {
  AxiomSettings,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@cafecode/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ServerConfig } from "../../config.ts";
import { makeAxiomTextGeneration } from "../../textGeneration/AxiomTextGeneration.ts";
import {
  axiomConfigurationKey,
  axiomDefaultThinkingLevel,
  axiomCreditBalance,
  AxiomBilling,
  AxiomAccount,
  AxiomModels,
  decodeAxiom,
  makeAxiomControl,
  type AxiomModel,
} from "../acp/AxiomAcpSupport.ts";
import { makeAxiomAdapter } from "../Layers/AxiomAdapter.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { defaultProviderContinuationIdentity, type ProviderDriver } from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

const DRIVER = ProviderDriverKind.make("axiom");
const decodeSettings = Schema.decodeSync(AxiomSettings);
export const axiomModelToCafe = (model: AxiomModel): ServerProviderModel => ({
  slug: model.id,
  name: model.shortLabel,
  shortName: model.shortLabel,
  isCustom: false,
  capabilities: {
    inputModalities: model.supportsImages ? ["text", "image"] : ["text"],
    supportsAutoMode: false,
    fileMimeTypes: model.fileMimeTypes,
    optionDescriptors: model.thinkingLevels.length
      ? [
          {
            id: "thinkingLevel",
            label: "Thinking",
            type: "select",
            options: model.thinkingLevels.map((id) => ({
              id,
              label: id === "xhigh" ? "Extra high" : id.charAt(0).toUpperCase() + id.slice(1),
              ...(id === axiomDefaultThinkingLevel(model) ? { isDefault: true } : {}),
            })),
          },
        ]
      : [],
  },
});

export type AxiomDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | ServerConfig;
export const AxiomDriver: ProviderDriver<AxiomSettings, AxiomDriverEnv> = {
  driverKind: DRIVER,
  metadata: { displayName: "Axiom", supportsMultipleInstances: true },
  configSchema: AxiomSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const server = yield* ServerConfig;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const processEnvironment = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER,
        instanceId,
      });
      const timestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const initial = (checkedAt: string): ServerProvider => ({
        instanceId,
        driver: DRIVER,
        displayName: displayName ?? "Axiom",
        ...(accentColor ? { accentColor } : {}),
        continuation: { groupKey: continuationIdentity.continuationKey },
        enabled,
        installed: false,
        version: null,
        status: enabled ? "warning" : "disabled",
        auth: { status: "unknown" },
        checkedAt,
        models: [],
        slashCommands: [],
        skills: [],
        showInteractionModeToggle: true,
        runtimeCapabilities: { liveSteer: "supported", threadGoals: "unsupported" },
        message: "Checking the configured native AxiomCLI.",
      });
      const checkProvider = Effect.gen(function* () {
        const base = initial(yield* timestamp);
        if (!enabled) return { ...base, message: "Axiom is disabled." };
        return yield* Effect.gen(function* () {
          const { client, initialized, extension } = yield* makeAxiomControl(
            config,
            server.cwd,
            processEnvironment,
          );
          const { status } = yield* client.raw
            .request("_axiom/account/status", {})
            .pipe(Effect.flatMap((value) => decodeAxiom(AxiomAccount, value)));
          const authenticated = status.state === "valid" && status.account !== undefined;
          const models = authenticated
            ? (yield* client.raw
                .request("_axiom/models/list", {})
                .pipe(Effect.flatMap((value) => decodeAxiom(AxiomModels, value)))).models
                .filter((model) => ["near", "tinfoil"].includes(model.providerId))
                .map(axiomModelToCafe)
            : [];
          const billing =
            authenticated && extension.features.billing === 4
              ? yield* client.raw.request("_axiom/billing/status", {}).pipe(
                  Effect.flatMap((value) => decodeAxiom(AxiomBilling, value)),
                  Effect.catch(() => Effect.succeed(undefined)),
                )
              : undefined;
          const after = yield* client.raw
            .request("_axiom/account/status", {})
            .pipe(Effect.flatMap((value) => decodeAxiom(AxiomAccount, value)));
          if (
            after.status.state !== status.state ||
            after.status.account?.id !== status.account?.id
          )
            return {
              ...base,
              installed: true,
              message: "Axiom's native account changed; refresh this provider.",
            };
          return {
            ...base,
            installed: true,
            version: initialized.agentInfo?.version ?? null,
            status: authenticated ? ("ready" as const) : ("warning" as const),
            auth: {
              status: authenticated ? ("authenticated" as const) : ("unauthenticated" as const),
              type: "native",
              ...(authenticated && status.account?.displayName
                ? { label: status.account.displayName }
                : {}),
            },
            authActions: { login: true },
            models,
            ...(billing
              ? {
                  accountRateLimits: {
                    checkedAt: base.checkedAt,
                    rateLimits: {
                      limitId: "axiom-credit",
                      limitName: "Axiom credit",
                      credits: {
                        hasCredits: billing.status.availableMicrousd > 0,
                        unlimited: false,
                        balance: axiomCreditBalance(billing.status.availableMicrousd),
                      },
                    },
                  },
                }
              : {}),
            message: authenticated
              ? "AxiomCLI is ready. Inference verification is enforced by the native runtime."
              : "Sign in to Axiom to load your model catalog.",
          };
        }).pipe(
          Effect.timeout(15_000),
          Effect.scoped,
          Effect.catchCause((cause) =>
            Effect.succeed({
              ...base,
              installed: !cause.reasons.some(
                (reason) =>
                  reason._tag === "Fail" &&
                  typeof reason.error === "object" &&
                  reason.error !== null &&
                  "_tag" in reason.error &&
                  reason.error._tag === "AcpSpawnError",
              ),
              status: "error" as const,
              message:
                "Could not qualify AxiomCLI. Check the configured executable, compatible version and native sign-in.",
            }),
          ),
        );
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      const snapshot = yield* makeManagedServerProvider({
        maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
          provider: DRIVER,
          packageName: null,
        }),
        getSettings: Effect.succeed(config),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: () => timestamp.pipe(Effect.map(initial)),
        checkProvider,
        refreshModels: () =>
          Effect.gen(function* () {
            const { client } = yield* makeAxiomControl(config, server.cwd, processEnvironment);
            return (yield* client.raw
              .request("_axiom/models/list", {})
              .pipe(Effect.flatMap((value) => decodeAxiom(AxiomModels, value)))).models
              .filter((model) => ["near", "tinfoil"].includes(model.providerId))
              .map(axiomModelToCafe);
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.timeout(15_000),
            Effect.scoped,
            Effect.catchCause(() => Effect.succeed(undefined)),
          ),
        refreshInterval: Duration.minutes(5),
      }).pipe(
        Effect.mapError(
          () =>
            new ProviderDriverError({
              driver: DRIVER,
              instanceId,
              detail: "Could not initialize Axiom provider discovery.",
            }),
        ),
      );
      const adapter = yield* makeAxiomAdapter(config, {
        instanceId,
        environment: processEnvironment,
        onAccountChanged: snapshot.refresh.pipe(Effect.asVoid),
        configurationKey: axiomConfigurationKey(config, environment),
      });
      const textGeneration = yield* makeAxiomTextGeneration(config, processEnvironment);
      return {
        instanceId,
        driverKind: DRIVER,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      };
    }),
};
