import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ServerProviderUpdateError,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdatedPayload,
  type ServerProviderUpdateState,
} from "@cafecode/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { compareSemverVersions, parseSemver } from "@cafecode/shared/semver";

import { ProviderRegistry } from "./Services/ProviderRegistry.ts";
import { prepareCodexProviderUpdate } from "./codexUpdatePreflight.ts";
import { makeProviderMaintenanceCommandCoordinator } from "./providerMaintenanceCommandCoordinator.ts";
import { enrichProviderSnapshotWithVersionAdvisory } from "./providerMaintenance.ts";
import type { ProviderMaintenanceCapabilities } from "./providerMaintenance.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
const isServerProviderUpdateError = Schema.is(ServerProviderUpdateError);

const UPDATE_TIMEOUT_MS = 5 * 60_000;
const UPDATE_OUTPUT_MAX_BYTES = 10_000;

export interface ProviderMaintenanceCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface ProviderMaintenanceRunnerShape {
  readonly updateProvider: (
    target:
      | ProviderDriverKind
      | {
          readonly provider: ProviderDriverKind;
          readonly instanceId?: ProviderInstanceId | undefined;
        },
  ) => Effect.Effect<ServerProviderUpdatedPayload, ServerProviderUpdateError>;
}

export class ProviderMaintenanceRunner extends Context.Service<
  ProviderMaintenanceRunner,
  ProviderMaintenanceRunnerShape
>()("cafecode/provider/ProviderMaintenanceRunner") {}

class ProviderMaintenanceCommandError extends Data.TaggedError("ProviderMaintenanceCommandError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface VerifiedProviderRefresh {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly verifiedProviders: ReadonlyArray<ServerProvider>;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const runProviderMaintenanceCommandWithSpawner = Effect.fn("ProviderMaintenanceRunner.runCommand")(
  function* (input: {
    readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
    readonly command: string;
    readonly args: ReadonlyArray<string>;
  }) {
    const collectCommandResult = Effect.fn("ProviderMaintenanceRunner.collectCommandResult")(
      function* () {
        const child = yield* input.spawner
          .spawn(ChildProcess.make(input.command, [...input.args]))
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderMaintenanceCommandError({
                  message: `Failed to run update command ${input.command}: ${cause.message}`,
                  cause,
                }),
            ),
          );
        yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));

        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            collectUint8StreamText({
              stream: child.stdout,
              maxBytes: UPDATE_OUTPUT_MAX_BYTES,
            }),
            collectUint8StreamText({
              stream: child.stderr,
              maxBytes: UPDATE_OUTPUT_MAX_BYTES,
            }),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderMaintenanceCommandError({
                message: cause instanceof Error ? cause.message : "Update command failed to run.",
                cause,
              }),
          ),
        );

        return {
          stdout: stdout.text,
          stderr: stderr.text,
          exitCode: Number(exitCode),
          timedOut: false,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
        } satisfies ProviderMaintenanceCommandResult;
      },
    );

    return yield* collectCommandResult().pipe(
      Effect.scoped,
      Effect.timeoutOption(Duration.millis(UPDATE_TIMEOUT_MS)),
      Effect.map((result) =>
        Option.match(result, {
          onSome: (value) => value,
          onNone: () =>
            ({
              stdout: "",
              stderr: "",
              exitCode: null,
              timedOut: true,
              stdoutTruncated: false,
              stderrTruncated: false,
            }) satisfies ProviderMaintenanceCommandResult,
        }),
      ),
    );
  },
);

function trimNullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function commandOutput(result: ProviderMaintenanceCommandResult): string | null {
  const output = trimNullable([result.stderr, result.stdout].filter(Boolean).join("\n\n"));
  if (!output) {
    return null;
  }
  return truncateText(output, UPDATE_OUTPUT_MAX_BYTES);
}

function failureMessage(result: ProviderMaintenanceCommandResult): string {
  if (result.timedOut) {
    return "Update timed out.";
  }
  if (result.exitCode !== null && result.exitCode !== 0) {
    return `Update command exited with code ${result.exitCode}.`;
  }
  return "Update command failed.";
}

function classifyProviderUpdateVerification(
  providers: ReadonlyArray<ServerProvider>,
  verifiedTargetVersion?: string,
): Pick<ServerProviderUpdateState, "status" | "message"> {
  const unverified = {
    status: "unchanged",
    message: "Update command completed, but Cafe Code could not verify the provider version.",
  } as const;
  const runtimeFailed = {
    status: "failed",
    message:
      "Update command completed, but the provider failed its runtime check. Check its installation in provider settings.",
  } as const;

  // Disabled or unavailable instances cannot establish the result of the
  // update. In particular, their cached version is not a fresh runtime probe.
  if (
    providers.length === 0 ||
    providers.some((provider) => !provider.enabled || provider.availability === "unavailable")
  ) {
    return unverified;
  }

  // Package managers can exit successfully while omitting a native optional
  // dependency. The refreshed runtime must therefore be checked independently
  // of the command exit code and the latest-version advisory. Never copy a
  // provider's message into update diagnostics: it can contain private output.
  if (
    providers.some(
      (provider) =>
        !provider.installed ||
        provider.probePhases?.some(
          (phase) =>
            (phase.phase === "prepare-runtime-home" || phase.phase === "version") &&
            phase.outcome === "error",
        ),
    )
  ) {
    return runtimeFailed;
  }

  // A timed-out/skipped version probe is inconclusive even if the registry
  // retained an earlier healthy version. Legacy providers without phase
  // diagnostics still qualify through their current snapshot and version.
  if (
    providers.some((provider) =>
      provider.probePhases?.some(
        (phase) =>
          (phase.phase === "prepare-runtime-home" || phase.phase === "version") &&
          phase.outcome !== "success",
      ),
    )
  ) {
    return unverified;
  }

  if (providers.some((provider) => provider.status === "error")) {
    return runtimeFailed;
  }
  if (providers.some((provider) => !provider.version || !parseSemver(provider.version))) {
    return unverified;
  }
  // A cached latest-version advisory may predate this update. For commands
  // pinned by preflight, only the exact selected version proves that the
  // intended executable was installed; an older healthy CLI is insufficient.
  if (
    verifiedTargetVersion &&
    providers.some(
      (provider) =>
        provider.version === null ||
        compareSemverVersions(provider.version, verifiedTargetVersion) !== 0,
    )
  ) {
    return {
      status: "unchanged",
      message:
        "Update command completed, but Cafe Code did not detect the selected provider version.",
    };
  }
  if (providers.some((provider) => provider.versionAdvisory?.status === "behind_latest")) {
    return {
      status: "unchanged",
      message:
        "Update command completed, but Cafe Code still detects an outdated provider version.",
    };
  }
  if (providers.some((provider) => provider.versionAdvisory?.status !== "current")) {
    return {
      status: "unchanged",
      message:
        "Update command completed, but Cafe Code could not verify the latest provider version.",
    };
  }
  return { status: "succeeded", message: "Provider updated." };
}

function makeUpdateState(input: {
  readonly status: ServerProviderUpdateState["status"];
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly message: string | null;
  readonly output?: string | null;
}): ServerProviderUpdateState {
  return {
    status: input.status,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    message: input.message,
    output: input.output ?? null,
  };
}

export const make = Effect.fn("ProviderMaintenanceRunner.make")(function* () {
  const providerRegistry = yield* ProviderRegistry;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const runnerScope = yield* Effect.scope;
  const runMaintenanceCommand = (command: string, args: ReadonlyArray<string>) =>
    runProviderMaintenanceCommandWithSpawner({
      spawner,
      command,
      args,
    });
  const commandCoordinator = yield* makeProviderMaintenanceCommandCoordinator({
    makeAlreadyRunningError: () =>
      new ServerProviderUpdateError({
        provider: ProviderDriverKind.make("unknown"),
        reason: "An update is already running for this provider.",
      }),
  });

  const verifyRefreshedProvider = (
    provider: ProviderDriverKind,
    maintenanceCapabilities: ProviderMaintenanceCapabilities,
    instanceId: ProviderInstanceId,
  ): Effect.Effect<VerifiedProviderRefresh> =>
    providerRegistry.getProviders.pipe(
      Effect.map((providers) =>
        providers
          .filter(
            (candidate) => candidate.driver === provider && candidate.instanceId === instanceId,
          )
          .map((candidate) => candidate.instanceId),
      ),
      Effect.flatMap((instanceIds) =>
        instanceIds.length === 0
          ? providerRegistry.refreshInstance(instanceId)
          : Effect.forEach(
              instanceIds,
              (instanceId) => providerRegistry.refreshInstance(instanceId),
              {
                concurrency: "unbounded",
                discard: true,
              },
            ).pipe(Effect.andThen(providerRegistry.getProviders)),
      ),
      Effect.flatMap((providers) => {
        const refreshedProviders = providers.filter(
          (candidate) => candidate.driver === provider && candidate.instanceId === instanceId,
        );
        if (refreshedProviders.length === 0) {
          return Effect.succeed<VerifiedProviderRefresh>({
            providers,
            verifiedProviders: [],
          });
        }
        return Effect.forEach(
          refreshedProviders,
          (refreshedProvider) =>
            enrichProviderSnapshotWithVersionAdvisory(
              refreshedProvider,
              maintenanceCapabilities,
            ).pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
          {
            concurrency: "unbounded",
          },
        ).pipe(
          Effect.map(
            (verifiedProviders): VerifiedProviderRefresh => ({
              providers,
              verifiedProviders,
            }),
          ),
          Effect.catchCause(() =>
            Effect.logWarning("Provider post-update version verification failed", {
              provider,
              failureKind: "version_advisory_unavailable",
            }).pipe(
              Effect.as<VerifiedProviderRefresh>({
                providers,
                verifiedProviders: refreshedProviders,
              }),
            ),
          ),
        );
      }),
    );

  const updateProvider: ProviderMaintenanceRunnerShape["updateProvider"] = Effect.fn(
    "ProviderMaintenanceRunner.updateProvider",
  )(function* (target) {
    const provider = typeof target === "string" ? target : target.provider;
    const instanceId =
      typeof target === "string"
        ? defaultInstanceIdForDriver(provider)
        : (target.instanceId ?? defaultInstanceIdForDriver(provider));
    const targetKey = `instance:${instanceId}`;
    const capabilities = yield* providerRegistry.getProviderMaintenanceCapabilitiesForInstance(
      instanceId,
      provider,
    );
    const update = capabilities.update;
    if (!update) {
      return yield* new ServerProviderUpdateError({
        provider,
        reason: "This provider does not support one-click updates.",
      });
    }

    const setUpdateState = (state: ServerProviderUpdateState | null) =>
      providerRegistry.setProviderMaintenanceActionState({
        instanceId,
        action: "update",
        state,
      });
    const setQueuedState = setUpdateState(
      makeUpdateState({
        status: "queued",
        startedAt: null,
        finishedAt: null,
        message: "Waiting for another provider update to finish.",
      }),
    ).pipe(Effect.asVoid);
    const startedAtRef = yield* Ref.make<string | null>(null);

    const runProviderUpdate = Effect.fn("ProviderMaintenanceRunner.runProviderUpdate")(
      function* () {
        const finish = (state: ServerProviderUpdateState) =>
          setUpdateState(state).pipe(Effect.map((providers) => ({ providers })));
        const runCommandAndVerify = Effect.fn("ProviderMaintenanceRunner.runCommandAndVerify")(
          function* () {
            const startedAt = yield* nowIso;
            yield* Ref.set(startedAtRef, startedAt);
            yield* setUpdateState(
              makeUpdateState({
                status: "running",
                startedAt,
                finishedAt: null,
                message: "Updating provider.",
              }),
            );

            // Resolve the selected Codex package and its host-native dependency
            // before an update can remove the currently working installation.
            // Preflight returns only fixed public failure text and pins the
            // package argument so a changing latest tag cannot race this check.
            const prepared = yield* prepareCodexProviderUpdate(provider, update).pipe(
              Effect.provideService(HttpClient.HttpClient, httpClient),
              Effect.result,
            );
            if (Result.isFailure(prepared)) {
              return yield* finish(
                makeUpdateState({
                  status: "failed",
                  startedAt,
                  finishedAt: yield* nowIso,
                  message: prepared.failure.message,
                }),
              );
            }
            const preparedUpdate = prepared.success;
            const result = yield* runMaintenanceCommand(
              preparedUpdate.executable,
              preparedUpdate.args,
            );
            const finishedAt = yield* nowIso;
            if (result.timedOut || result.exitCode !== 0) {
              return yield* finish(
                makeUpdateState({
                  status: "failed",
                  startedAt,
                  finishedAt,
                  message: failureMessage(result),
                  output: commandOutput(result),
                }),
              );
            }

            const { verifiedProviders } = yield* verifyRefreshedProvider(
              provider,
              capabilities,
              instanceId,
            );
            return yield* finish(
              makeUpdateState({
                ...classifyProviderUpdateVerification(
                  verifiedProviders,
                  preparedUpdate.verifiedTargetVersion,
                ),
                startedAt,
                finishedAt,
                output: commandOutput(result),
              }),
            );
          },
        );

        const recordFailedUpdate = Effect.fn("ProviderMaintenanceRunner.recordFailedUpdate")(
          function* (cause: Cause.Cause<unknown>) {
            // Provider/process failures may embed executable paths, platform
            // diagnostics, environment fragments, or command details. Record
            // only an allowlisted category in server logs and expose a fixed
            // client message; the normal non-zero-exit path above separately
            // publishes the already-bounded stdout/stderr intended for users.
            const failureKind = Cause.hasInterruptsOnly(cause)
              ? "interrupted"
              : "unexpected_failure";
            yield* Effect.logWarning("Provider update failed before completion", {
              provider,
              instanceId,
              failureKind,
            });
            const startedAt = yield* Ref.get(startedAtRef);
            return yield* finish(
              makeUpdateState({
                status: "failed",
                startedAt,
                finishedAt: yield* nowIso,
                message: "Provider update failed before completion.",
                output: null,
              }),
            );
          },
        );

        return yield* runCommandAndVerify().pipe(Effect.catchCause(recordFailedUpdate));
      },
    );

    const updateJob = commandCoordinator
      .withCommandLock({
        targetKey,
        lockKey: update.lockKey,
        onQueued: setQueuedState,
        onAcquiredExit: (exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : Ref.get(startedAtRef).pipe(
                Effect.flatMap((startedAt) =>
                  nowIso.pipe(
                    Effect.flatMap((finishedAt) =>
                      setUpdateState(
                        makeUpdateState({
                          status: "failed",
                          startedAt,
                          finishedAt,
                          // Do not surface Effect causes or interruptor metadata here.
                          // Provider update errors can contain paths or process details;
                          // this terminal state only needs to explain that the owned job
                          // stopped before it could publish its normal result.
                          message: "Provider update stopped before completion.",
                          output: null,
                        }),
                      ),
                    ),
                  ),
                ),
                Effect.asVoid,
              ),
        run: runProviderUpdate(),
      })
      .pipe(
        Effect.mapError((error) =>
          isServerProviderUpdateError(error)
            ? new ServerProviderUpdateError({
                provider,
                reason: error.reason,
              })
            : error,
        ),
      );

    // A provider update mutates process-global package-manager state. Once
    // admitted, its lifetime belongs to the server, not to whichever renderer
    // WebSocket happened to request it. Forking into the runner layer's scope
    // lets a reconnect stop waiting without interrupting the command; the
    // authoritative ProviderRegistry snapshots keep every client informed.
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const worker = yield* updateJob.pipe(Effect.interruptible, Effect.forkIn(runnerScope));
        return yield* restore(Fiber.join(worker));
      }),
    );
  });

  return ProviderMaintenanceRunner.of({
    updateProvider,
  });
});

export const layer = Layer.effect(ProviderMaintenanceRunner, make());
