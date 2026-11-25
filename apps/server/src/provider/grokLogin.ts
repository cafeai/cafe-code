import type { ServerProviderDeviceLoginEvent } from "@cafecode/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process";

import { ProviderAdapterValidationError } from "./Errors.ts";
import { terminateProbeChild } from "./providerSnapshot.ts";

export const GROK_LOGIN_ERRORS = {
  pending: "Grok sign-in is already in progress.",
  busy: "Close this account's Cafe chats before changing its native sign-in.",
  account:
    "Could not verify Grok's account status. Refresh this provider before trying sign-in again.",
  start: "Could not start Grok sign-in. Try again or run grok login in a terminal.",
  url: "Grok CLI returned an invalid sign-in link. Update Grok before trying again.",
  failed: "Grok sign-in did not complete. Start again and approve the code in your browser.",
  timeout: "Grok sign-in timed out. Start again to get a new code.",
} as const;

const STARTUP_TIMEOUT_MS = 30_000;
const APPROVAL_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_BYTES = 32_768;
const MAX_URL_LENGTH = 4_096;
const USER_CODE_PATTERN = /^[A-Z0-9]{2,16}-[A-Z0-9]{2,16}$/u;
const ALLOWED_GROK_DEVICE_ORIGINS = new Set(["https://accounts.x.ai", "https://auth.x.ai"]);

const invalid = (issue: string) =>
  new ProviderAdapterValidationError({ provider: "grok", operation: "login", issue });

function stripTrailingUrlPunctuation(raw: string): string {
  return raw.replace(/[.,;:!?)'"\]>]+$/u, "");
}

/**
 * Parse and strictly validate Grok's `grok login --device-auth` prompt.
 * Only an allowlisted xAI device-authorization URL and bounded user code are
 * accepted; raw stdout/stderr never leave this boundary.
 */
export function parseGrokDeviceLoginInstructions(
  text: string,
  options?: { readonly requireTerminator?: boolean },
): Extract<ServerProviderDeviceLoginEvent, { readonly type: "device-code" }> | null {
  const pattern = options?.requireTerminator
    ? /https:\/\/(?:accounts|auth)\.x\.ai\/[^\s<>"'`()[\]{}]+(?=\s)/gu
    : /https:\/\/(?:accounts|auth)\.x\.ai\/[^\s<>"'`()[\]{}]+/gu;
  const matches = text.match(pattern);
  if (!matches) return null;

  for (const rawMatch of matches) {
    const candidate = stripTrailingUrlPunctuation(rawMatch);
    // oxlint-disable-next-line no-control-regex -- Refuse control bytes before parsing a provider-authored browser target.
    if (candidate.length > MAX_URL_LENGTH || /[\u0000-\u0020\u007f]/u.test(candidate)) continue;
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    if (
      !ALLOWED_GROK_DEVICE_ORIGINS.has(url.origin) ||
      !url.pathname.includes("device") ||
      url.username ||
      url.password ||
      url.hash
    ) {
      continue;
    }

    const queryCode = url.searchParams.get("user_code")?.trim().toUpperCase();
    const lineCode = text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => USER_CODE_PATTERN.test(line));
    const userCode =
      queryCode && USER_CODE_PATTERN.test(queryCode)
        ? queryCode
        : lineCode && USER_CODE_PATTERN.test(lineCode)
          ? lineCode
          : undefined;
    if (!userCode) continue;
    if (queryCode && lineCode && queryCode !== lineCode) continue;

    return {
      type: "device-code",
      verificationUrl: url.href,
      userCode,
    };
  }
  return null;
}

export function grokLoginFailureMessage(error: unknown): string {
  // Preserve nominal local error classification here; structural wire lookalikes must not acquire this control/recovery outcome.
  // @effect-diagnostics-next-line instanceOfSchema:off
  return error instanceof ProviderAdapterValidationError &&
    error.provider === "grok" &&
    error.operation === "login" &&
    Object.values(GROK_LOGIN_ERRORS).some((issue) => issue === error.issue)
    ? error.issue
    : GROK_LOGIN_ERRORS.start;
}

/**
 * In-app device-code sign-in driven by `grok --no-auto-update login --device-auth`.
 * Works identically on desktop and remote/headless servers while honoring the
 * instance's configured binary path and `GROK_HOME`.
 */
export const makeGrokLogin = Effect.fn("makeGrokLogin")(function* (options: {
  readonly binaryPath: string;
  readonly homePath?: string | undefined;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly hasSessions: Effect.Effect<boolean>;
  readonly refresh: Effect.Effect<unknown>;
}) {
  const instanceScope = yield* Effect.scope;
  const retired = yield* Deferred.make<never, ProviderAdapterValidationError>();
  yield* Effect.addFinalizer(() => Deferred.fail(retired, invalid(GROK_LOGIN_ERRORS.start)));

  let pending = false;

  const loginDeviceCode = <SessionError>(hasOwnedSessions: Effect.Effect<boolean, SessionError>) =>
    Stream.callback<ServerProviderDeviceLoginEvent, ProviderAdapterValidationError>(
      (queue) =>
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const worker = Effect.gen(function* () {
            if (pending) return yield* invalid(GROK_LOGIN_ERRORS.pending);
            pending = true;
            yield* Effect.gen(function* () {
              const assertIdle = Effect.gen(function* () {
                if (
                  (yield* options.hasSessions) ||
                  (yield* hasOwnedSessions.pipe(
                    Effect.timeout(15_000),
                    Effect.mapError(() => invalid(GROK_LOGIN_ERRORS.account)),
                  ))
                ) {
                  return yield* invalid(GROK_LOGIN_ERRORS.busy);
                }
              });
              yield* assertIdle;

              const command = options.binaryPath.trim() || "grok";
              const homePath = options.homePath?.trim();
              const child = yield* options.spawner
                .spawn(
                  ChildProcess.make(command, ["--no-auto-update", "login", "--device-auth"], {
                    env: {
                      ...options.environment,
                      GROK_OAUTH2_REFERRER: "cafe-code",
                      ...(homePath ? { GROK_HOME: homePath } : {}),
                    },
                    extendEnv: true,
                    shell: false,
                  }),
                )
                .pipe(Effect.mapError(() => invalid(GROK_LOGIN_ERRORS.start)));

              yield* Effect.gen(function* () {
                const instructionsFound =
                  yield* Deferred.make<
                    Extract<ServerProviderDeviceLoginEvent, { readonly type: "device-code" }>
                  >();
                let capturedBytes = 0;
                let capturedText = "";

                const makeChunkConsumer = () => {
                  const decoder = new TextDecoder("utf-8");
                  return (chunk: Uint8Array) =>
                    Effect.gen(function* () {
                      if (capturedBytes < MAX_OUTPUT_BYTES) {
                        const remaining = MAX_OUTPUT_BYTES - capturedBytes;
                        const slice =
                          chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
                        capturedBytes += slice.byteLength;
                        capturedText += decoder.decode(slice, { stream: true });
                      }
                      const instructions = parseGrokDeviceLoginInstructions(capturedText, {
                        requireTerminator: true,
                      });
                      if (instructions) {
                        yield* Deferred.succeed(instructionsFound, instructions);
                      }
                    });
                };

                const stdoutFiber = yield* Stream.runForEach(
                  child.stdout,
                  makeChunkConsumer(),
                ).pipe(Effect.ignore, Effect.forkScoped);
                const stderrFiber = yield* Stream.runForEach(
                  child.stderr,
                  makeChunkConsumer(),
                ).pipe(Effect.ignore, Effect.forkScoped);

                const exitEffect = child.exitCode.pipe(
                  Effect.map(Number),
                  Effect.tap(() => Fiber.join(stdoutFiber).pipe(Effect.ignore)),
                  Effect.tap(() => Fiber.join(stderrFiber).pipe(Effect.ignore)),
                );

                const initialOutcome = yield* Effect.raceFirst(
                  Deferred.await(instructionsFound).pipe(
                    Effect.map((instructions) => ({ _tag: "instructions" as const, instructions })),
                  ),
                  exitEffect.pipe(Effect.map((code) => ({ _tag: "exited" as const, code }))),
                ).pipe(Effect.mapError(() => invalid(GROK_LOGIN_ERRORS.start)));

                if (initialOutcome._tag === "exited") {
                  if (initialOutcome.code === 0) {
                    yield* options.refresh.pipe(Effect.ignore);
                    yield* Deferred.succeed(started, undefined);
                    yield* Queue.offer(queue, { type: "authenticated" });
                    return;
                  }
                  if (/https:\/\//u.test(capturedText)) {
                    return yield* invalid(GROK_LOGIN_ERRORS.url);
                  }
                  return yield* invalid(GROK_LOGIN_ERRORS.start);
                }

                yield* Deferred.succeed(started, undefined);
                yield* Queue.offer(queue, initialOutcome.instructions);

                const exitCode = yield* exitEffect.pipe(
                  Effect.timeoutOrElse({
                    duration: APPROVAL_TIMEOUT_MS,
                    orElse: () => Effect.fail(invalid(GROK_LOGIN_ERRORS.timeout)),
                  }),
                  Effect.mapError((error) => invalid(grokLoginFailureMessage(error))),
                );
                if (exitCode !== 0) {
                  return yield* invalid(GROK_LOGIN_ERRORS.failed);
                }
                yield* options.refresh.pipe(Effect.ignore);
                yield* Queue.offer(queue, { type: "authenticated" });
              }).pipe(Effect.ensuring(terminateProbeChild(child, "2 seconds")), Effect.scoped);
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  pending = false;
                }),
              ),
            );
          });

          const startupDeadline = Effect.sleep(STARTUP_TIMEOUT_MS).pipe(
            Effect.andThen(Deferred.isDone(started)),
            Effect.flatMap((acknowledged) =>
              acknowledged ? Effect.never : Effect.fail(invalid(GROK_LOGIN_ERRORS.start)),
            ),
          );
          const fiber = yield* Effect.forkIn(
            Effect.raceFirst(worker, startupDeadline).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.interrupt
                  : Queue.fail(queue, invalid(grokLoginFailureMessage(Cause.squash(cause)))),
              ),
              Effect.andThen(Queue.end(queue)),
            ),
            instanceScope,
          );
          yield* Effect.addFinalizer(() => Fiber.interrupt(fiber));
        }).pipe(Effect.uninterruptible),
      { bufferSize: 2 },
    ).pipe(Stream.interruptWhen(Deferred.await(retired)));

  return { loginDeviceCode };
});
