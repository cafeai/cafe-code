import type { ServerProviderDeviceLoginEvent } from "@cafecode/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process";

import { geminiCliEnvironment, geminiPrivateHomeArgs } from "./acp/GeminiAcpRuntime.ts";
import { ProviderAdapterValidationError } from "./Errors.ts";
import { terminateProbeChild } from "./providerSnapshot.ts";

export const GEMINI_LOGIN_ERRORS = {
  pending: "Gemini sign-in is already in progress.",
  busy: "Close this account's Cafe chats before changing its native sign-in.",
  account:
    "Could not verify Gemini's account status. Refresh this provider before trying sign-in again.",
  start: "Could not start Gemini sign-in. Try again or run agy acp --login in a terminal.",
  url: "Antigravity CLI returned an invalid sign-in link. Update the CLI before trying again.",
  code: "Enter the authorization code or callback URL from the browser.",
  expired: "This Gemini sign-in attempt is no longer active. Close this dialog and try again.",
  failed:
    "Gemini sign-in did not complete. Check the authorization code or callback URL and try again.",
  timeout: "Gemini sign-in timed out. Start again to get a new sign-in link.",
} as const;

const STARTUP_TIMEOUT_MS = 30_000;
const HUMAN_CODE_TIMEOUT_MS = 10 * 60_000;
const EXCHANGE_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 32_768;
const MAX_URL_LENGTH = 4_096;
const MAX_CODE_LENGTH = 4_096;

const ALLOWED_VERIFICATION_ORIGINS = new Set([
  "https://accounts.google.com",
  "https://myaccount.google.com",
  "https://support.google.com",
  "https://antigravity.google",
]);

const invalid = (issue: string) =>
  new ProviderAdapterValidationError({ provider: "gemini", operation: "login", issue });

function stripTrailingUrlPunctuation(raw: string): string {
  return raw.replace(/[.,;:!?)'"\]>]+$/u, "");
}

/** Validate an Antigravity CLI Google OAuth authorization link. Never project
 * OAuth state, PKCE parameters or pasted codes into public snapshots or logs. */
export function geminiOAuthAuthorizationUrl(
  text: string,
  options?: { readonly requireTerminator?: boolean },
): string | null {
  const pattern = options?.requireTerminator
    ? /https:\/\/accounts\.google\.com\/o\/oauth2\/auth[^\s<>"'`()[\]{}]+(?=\s)/gu
    : /https:\/\/accounts\.google\.com\/o\/oauth2\/auth[^\s<>"'`()[\]{}]+/gu;
  const matches = text.match(pattern);
  if (!matches) return null;
  for (const rawMatch of matches) {
    const candidate = stripTrailingUrlPunctuation(rawMatch);
    // oxlint-disable-next-line no-control-regex -- Refuse control bytes before parsing a provider-authored browser target.
    if (candidate.length > MAX_URL_LENGTH || /[\u0000-\u0020\u007f]/u.test(candidate)) continue;
    try {
      const url = new URL(candidate);
      if (
        url.origin === "https://accounts.google.com" &&
        url.pathname === "/o/oauth2/auth" &&
        !url.username &&
        !url.password &&
        !url.hash &&
        url.searchParams.get("redirect_uri") === "https://antigravity.google/oauth-callback" &&
        url.searchParams.get("response_type") === "code" &&
        (url.searchParams.get("client_id")?.trim().length ?? 0) > 0
      ) {
        return url.href;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/** Extract an allowlisted Google account verification or Terms-of-Service
 * appeal URL from provider error output, excluding the initial OAuth prompt
 * and callback URLs. */
export function geminiVerificationUrl(text: string): string | null {
  const matches = text.match(/https:\/\/[^\s<>"'`()[\]{}]+/gu);
  if (!matches) return null;
  for (const rawMatch of matches) {
    const candidate = stripTrailingUrlPunctuation(rawMatch);
    // oxlint-disable-next-line no-control-regex -- Refuse control bytes before parsing a provider-authored browser target.
    if (candidate.length > MAX_URL_LENGTH || /[\u0000-\u0020\u007f]/u.test(candidate)) continue;
    try {
      const url = new URL(candidate);
      if (!ALLOWED_VERIFICATION_ORIGINS.has(url.origin) || url.username || url.password) continue;
      if (url.origin === "https://accounts.google.com" && url.pathname === "/o/oauth2/auth") {
        continue;
      }
      if (url.origin === "https://antigravity.google" && url.pathname === "/oauth-callback") {
        continue;
      }
      return url.href;
    } catch {
      continue;
    }
  }
  return null;
}

function collectBoundedStrings(value: unknown, out: string[], depth = 0): void {
  if (out.length >= 32 || depth > 4 || value == null) return;
  if (typeof value === "string") {
    out.push(value.slice(0, MAX_URL_LENGTH * 2));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (out.length >= 32) break;
      collectBoundedStrings(item, out, depth + 1);
    }
    return;
  }
  if (typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      if (out.length >= 32) break;
      collectBoundedStrings(entry, out, depth + 1);
    }
  }
}

/** Inspect one bounded JSON-RPC wire line from an ACP discovery process for an
 * allowlisted Google verification/appeal URL inside an error response. */
export function geminiVerificationUrlFromJsonRpcLine(line: string): string | null {
  if (line.length > MAX_OUTPUT_BYTES || !line.includes("https://")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const error = (parsed as { readonly error?: unknown }).error;
  if (error === null || typeof error !== "object" || Array.isArray(error)) return null;
  const errorRecord = error as { readonly message?: unknown; readonly data?: unknown };
  const strings: string[] = [];
  collectBoundedStrings(errorRecord.message, strings);
  collectBoundedStrings(errorRecord.data, strings);
  for (const text of strings) {
    const url = geminiVerificationUrl(text);
    if (url) return url;
  }
  return null;
}

export function normalizeSubmittedGeminiLoginCode(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_CODE_LENGTH) return null;
  // oxlint-disable-next-line no-control-regex -- Refuse line breaks and control bytes before writing to native child stdin.
  if (/[\u0000-\u001f\u007f]/u.test(trimmed)) return null;
  return trimmed;
}

export function geminiLoginFailureMessage(error: unknown): string {
  // Preserve nominal local error classification here; structural wire lookalikes must not acquire this control/recovery outcome.
  // @effect-diagnostics-next-line instanceOfSchema:off
  return error instanceof ProviderAdapterValidationError &&
    error.provider === "gemini" &&
    error.operation === "login" &&
    Object.values(GEMINI_LOGIN_ERRORS).some((issue) => issue === error.issue)
    ? error.issue
    : GEMINI_LOGIN_ERRORS.start;
}

export interface GeminiLoginRefreshResult {
  readonly authenticated: boolean;
  readonly verificationUrl: string | null;
}

/** Headless Google OAuth + PKCE sign-in driven by `agy acp --login`.
 * Works identically for local desktop and remote servers without needing a
 * browser on the server host. The user opens the validated Google OAuth URL in
 * their own browser and pastes the authorization code or callback URL back over
 * the authenticated connection, which writes it once to the exact child's stdin. */
export const makeGeminiLogin = Effect.fn("makeGeminiLogin")(function* <QualifyError>(options: {
  readonly qualifyCli: (
    cwd: string,
  ) => Effect.Effect<
    { readonly binaryPath: string; readonly nativeHome?: string | undefined },
    QualifyError
  >;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly fs: FileSystem.FileSystem;
  readonly hasSessions: Effect.Effect<boolean>;
  readonly refresh: Effect.Effect<GeminiLoginRefreshResult>;
}) {
  const instanceScope = yield* Effect.scope;
  const retired = yield* Deferred.make<never, ProviderAdapterValidationError>();
  yield* Effect.addFinalizer(() => Deferred.fail(retired, invalid(GEMINI_LOGIN_ERRORS.start)));

  let pending = false;
  let activeSubmission:
    | {
        readonly loginId: string;
        readonly submitted: Deferred.Deferred<string>;
      }
    | undefined;

  const submitLoginCode = (input: { readonly loginId: string; readonly code: string }) =>
    Effect.gen(function* () {
      const normalized = normalizeSubmittedGeminiLoginCode(input.code);
      if (!normalized) return yield* invalid(GEMINI_LOGIN_ERRORS.code);
      const current = activeSubmission;
      if (!current || current.loginId !== input.loginId) {
        return yield* invalid(GEMINI_LOGIN_ERRORS.expired);
      }
      const accepted = yield* Deferred.succeed(current.submitted, normalized);
      if (!accepted) return yield* invalid(GEMINI_LOGIN_ERRORS.expired);
      if (activeSubmission === current) activeSubmission = undefined;
    });

  const loginDeviceCode = <SessionError>(hasOwnedSessions: Effect.Effect<boolean, SessionError>) =>
    Stream.callback<ServerProviderDeviceLoginEvent, ProviderAdapterValidationError>(
      (queue) =>
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const worker = Effect.gen(function* () {
            if (pending) return yield* invalid(GEMINI_LOGIN_ERRORS.pending);
            pending = true;
            yield* Effect.gen(function* () {
              const assertIdle = Effect.gen(function* () {
                if (
                  (yield* options.hasSessions) ||
                  (yield* hasOwnedSessions.pipe(
                    Effect.timeout(15_000),
                    Effect.mapError(() => invalid(GEMINI_LOGIN_ERRORS.account)),
                  ))
                ) {
                  return yield* invalid(GEMINI_LOGIN_ERRORS.busy);
                }
              });
              yield* assertIdle;

              const cwd = yield* options.fs
                .makeTempDirectoryScoped({ prefix: "cafecode-gemini-login-" })
                .pipe(Effect.mapError(() => invalid(GEMINI_LOGIN_ERRORS.start)));
              const cli = yield* options
                .qualifyCli(cwd)
                .pipe(Effect.mapError(() => invalid(GEMINI_LOGIN_ERRORS.start)));

              yield* assertIdle;

              const child = yield* options.spawner
                .spawn(
                  ChildProcess.make(
                    cli.binaryPath,
                    ["acp", ...geminiPrivateHomeArgs(cli.nativeHome), "--login"],
                    {
                      cwd,
                      env: geminiCliEnvironment(options.environment, cli.nativeHome),
                      extendEnv: false,
                      stdin: "pipe",
                    },
                  ),
                )
                .pipe(Effect.mapError(() => invalid(GEMINI_LOGIN_ERRORS.start)));

              yield* Effect.gen(function* () {
                const authUrlFound = yield* Deferred.make<string>();
                const codeDeferred = yield* Deferred.make<string>();
                let codeWasSubmitted = false;
                let preCodeBytes = 0;
                let preCodeText = "";
                let postCodeBytes = 0;
                let postCodeText = "";

                const makeChunkConsumer = () => {
                  const decoder = new TextDecoder("utf-8");
                  return (chunk: Uint8Array) =>
                    Effect.gen(function* () {
                      if (!codeWasSubmitted) {
                        if (preCodeBytes < MAX_OUTPUT_BYTES) {
                          const remaining = MAX_OUTPUT_BYTES - preCodeBytes;
                          const slice =
                            chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
                          preCodeBytes += slice.byteLength;
                          preCodeText += decoder.decode(slice, { stream: true });
                        }
                        const url = geminiOAuthAuthorizationUrl(preCodeText, {
                          requireTerminator: true,
                        });
                        if (url) {
                          yield* Deferred.succeed(authUrlFound, url);
                        }
                      } else if (postCodeBytes < MAX_OUTPUT_BYTES) {
                        const remaining = MAX_OUTPUT_BYTES - postCodeBytes;
                        const slice =
                          chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
                        postCodeBytes += slice.byteLength;
                        postCodeText += decoder.decode(slice, { stream: true });
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

                const earlyExit = child.exitCode.pipe(
                  Effect.andThen(Fiber.join(stdoutFiber).pipe(Effect.ignore)),
                  Effect.andThen(Fiber.join(stderrFiber).pipe(Effect.ignore)),
                  Effect.map((code) => ({ _tag: "exited" as const, code })),
                );

                const initialOutcome = yield* Effect.raceFirst(
                  Deferred.await(authUrlFound).pipe(
                    Effect.map((url) => ({ _tag: "url" as const, url })),
                  ),
                  earlyExit,
                ).pipe(Effect.mapError(() => invalid(GEMINI_LOGIN_ERRORS.start)));

                if (initialOutcome._tag === "exited") {
                  const verificationUrl = geminiVerificationUrl(preCodeText);
                  if (verificationUrl) {
                    yield* Deferred.succeed(started, undefined);
                    yield* Queue.offer(queue, {
                      type: "verification-required",
                      verificationUrl,
                    });
                    return;
                  }
                  if (/https:\/\//u.test(preCodeText)) {
                    return yield* invalid(GEMINI_LOGIN_ERRORS.url);
                  }
                  return yield* invalid(GEMINI_LOGIN_ERRORS.start);
                }

                const loginId = globalThis.crypto.randomUUID();
                const submission = { loginId, submitted: codeDeferred };
                activeSubmission = submission;

                const submittedCode = yield* Effect.gen(function* () {
                  yield* Deferred.succeed(started, undefined);
                  yield* Queue.offer(queue, {
                    type: "oauth-code",
                    loginId,
                    authorizationUrl: initialOutcome.url,
                  });
                  const waitResult = yield* Effect.raceFirst(
                    Deferred.await(codeDeferred).pipe(
                      Effect.map((code) => ({ _tag: "code" as const, code })),
                    ),
                    child.exitCode.pipe(Effect.map((code) => ({ _tag: "exited" as const, code }))),
                  ).pipe(
                    Effect.mapError(() => invalid(GEMINI_LOGIN_ERRORS.failed)),
                    Effect.timeoutOrElse({
                      duration: HUMAN_CODE_TIMEOUT_MS,
                      orElse: () => Effect.fail(invalid(GEMINI_LOGIN_ERRORS.timeout)),
                    }),
                  );
                  if (waitResult._tag === "exited") {
                    return yield* invalid(GEMINI_LOGIN_ERRORS.failed);
                  }
                  return waitResult.code;
                }).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      if (activeSubmission === submission) activeSubmission = undefined;
                    }),
                  ),
                );

                codeWasSubmitted = true;
                yield* Stream.run(
                  Stream.encodeText(Stream.make(`${submittedCode}\n`)),
                  child.stdin,
                ).pipe(Effect.mapError(() => invalid(GEMINI_LOGIN_ERRORS.failed)));

                const exitCode = yield* child.exitCode.pipe(
                  Effect.mapError(() => invalid(GEMINI_LOGIN_ERRORS.failed)),
                  Effect.timeoutOrElse({
                    duration: EXCHANGE_TIMEOUT_MS,
                    orElse: () => Effect.fail(invalid(GEMINI_LOGIN_ERRORS.timeout)),
                  }),
                );

                yield* Fiber.join(stdoutFiber).pipe(Effect.timeout("1 second"), Effect.ignore);
                yield* Fiber.join(stderrFiber).pipe(Effect.timeout("1 second"), Effect.ignore);

                const outputVerificationUrl = geminiVerificationUrl(postCodeText);
                if (Number(exitCode) !== 0) {
                  if (outputVerificationUrl) {
                    yield* Queue.offer(queue, {
                      type: "verification-required",
                      verificationUrl: outputVerificationUrl,
                    });
                    return;
                  }
                  return yield* invalid(GEMINI_LOGIN_ERRORS.failed);
                }

                const refreshed = yield* options.refresh.pipe(
                  Effect.mapError(() => invalid(GEMINI_LOGIN_ERRORS.failed)),
                );
                if (refreshed.authenticated) {
                  yield* Queue.offer(queue, { type: "authenticated" });
                  return;
                }
                const verificationUrl = refreshed.verificationUrl ?? outputVerificationUrl;
                if (verificationUrl) {
                  yield* Queue.offer(queue, {
                    type: "verification-required",
                    verificationUrl,
                  });
                  return;
                }
                return yield* invalid(GEMINI_LOGIN_ERRORS.failed);
              }).pipe(Effect.ensuring(terminateProbeChild(child, "250 millis")));
            }).pipe(
              Effect.scoped,
              Effect.ensuring(
                Effect.sync(() => {
                  pending = false;
                  activeSubmission = undefined;
                }),
              ),
            );
          });

          const startupDeadline = Effect.sleep(STARTUP_TIMEOUT_MS).pipe(
            Effect.andThen(Deferred.isDone(started)),
            Effect.flatMap((acknowledged) =>
              acknowledged ? Effect.never : Effect.fail(invalid(GEMINI_LOGIN_ERRORS.start)),
            ),
          );
          const fiber = yield* Effect.forkIn(
            Effect.raceFirst(worker, startupDeadline).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.interrupt
                  : Queue.fail(queue, invalid(geminiLoginFailureMessage(Cause.squash(cause)))),
              ),
              Effect.andThen(Queue.end(queue)),
            ),
            instanceScope,
          );
          yield* Effect.addFinalizer(() => Fiber.interrupt(fiber));
        }).pipe(Effect.uninterruptible),
      { bufferSize: 2 },
    ).pipe(Stream.interruptWhen(Deferred.await(retired)));

  return { loginDeviceCode, submitLoginCode };
});
