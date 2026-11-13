import { RelayError } from "@cafecode/relay/errors";
import { isRemoteEnvironmentAuthHttpError } from "./api";

export type SecondFactorReason = "required" | "invalid" | "locked";
export interface SecondFactorContinuation {
  readonly secondFactor?: string;
  readonly requestSecondFactor?: (request: {
    readonly reason: SecondFactorReason;
    readonly signal: AbortSignal;
  }) => Promise<string | undefined>;
  readonly signal?: AbortSignal;
}

export function secondFactorReason(error: unknown): SecondFactorReason | undefined {
  if (error instanceof RelayError) {
    if (error.code === "SECOND_FACTOR_REQUIRED") return "required";
    if (error.code === "SECOND_FACTOR_REJECTED") return "invalid";
    if (error.code === "SECOND_FACTOR_LOCKED") return "locked";
  }
  if (isRemoteEnvironmentAuthHttpError(error)) {
    if (error.status === 401 && error.reason === "two-factor-required") return "required";
    if (error.status === 401 && error.reason === "two-factor-invalid") return "invalid";
    if (error.status === 429 && error.reason === "two-factor-locked") return "locked";
  }
  return undefined;
}

/** Only a definitive first-factor response and another explicit submission may
 * continue enrollment. Network errors and uncertain one-use results never retry. */
export async function withSecondFactor<T>(
  attempt: (code: string | undefined) => Promise<T>,
  input: SecondFactorContinuation,
): Promise<T> {
  const signal = input.signal
    ? AbortSignal.any([input.signal, AbortSignal.timeout(120_000)])
    : AbortSignal.timeout(120_000);
  let code = input.secondFactor;
  for (;;) {
    if (signal.aborted) throw new RelayError("INCOMPLETE");
    try {
      const result = await attempt(code);
      if (signal.aborted) throw new RelayError("AUTH_INDETERMINATE");
      return result;
    } catch (error) {
      const reason = secondFactorReason(error);
      if (!reason || !input.requestSecondFactor || signal.aborted) throw error;
      let abort: () => void = () => {};
      try {
        code = await Promise.race([
          input.requestSecondFactor({ reason, signal }),
          new Promise<undefined>((resolve) => {
            abort = () => resolve(undefined);
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
          }),
        ]);
      } finally {
        signal.removeEventListener("abort", abort);
      }
      if (!code?.trim() || signal.aborted) throw new RelayError("INCOMPLETE");
      code = code.trim();
    }
  }
}
