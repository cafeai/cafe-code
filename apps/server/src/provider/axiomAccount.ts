import type { ServerProvider } from "@cafecode/contracts";
import { ProviderAdapterValidationError } from "./Errors.ts";
import type { AxiomAccount } from "./acp/AxiomAcpSupport.ts";

export function axiomAccountHealth(
  status: (typeof AxiomAccount.Type)["status"],
): Pick<ServerProvider, "status" | "auth" | "message"> {
  const authenticated = status.state === "valid" && status.account !== undefined;
  return {
    status: authenticated ? "ready" : "warning",
    auth: {
      status: authenticated
        ? "authenticated"
        : status.state === "signed_out" || status.state === "expired"
          ? "unauthenticated"
          : "unknown",
      type: "native",
      ...(authenticated && status.account?.displayName
        ? { label: status.account.displayName }
        : {}),
    },
    message: authenticated
      ? "AxiomCLI is ready. Inference verification is enforced by the native runtime."
      : status.state === "signed_out"
        ? "Sign in to Axiom to load your model catalog."
        : status.state === "expired"
          ? "Your Axiom sign-in has expired. Sign in again to refresh your model catalog."
          : status.state === "starting"
            ? "Axiom is still checking its native account. Refresh this provider in a moment."
            : "Axiom's account check is temporarily unavailable. Refresh this provider to try again.",
  };
}

export const AXIOM_LOGIN_ERRORS = {
  pending: "Axiom sign-in is already in progress.",
  busy: "Close this account's Cafe chats before changing its native sign-in.",
  connection: "Could not start the native Axiom account connection.",
  account:
    "Could not verify Axiom's account status. Refresh this provider before trying sign-in again.",
  start:
    "Could not start native Axiom sign-in. Try again or sign in through the installed Axiom app.",
  url: "Axiom returned an invalid sign-in link. Refresh or update Axiom before trying again.",
  browser:
    "Could not open your browser for Axiom sign-in. Sign in through the installed Axiom app, then refresh this provider.",
} as const;

/** Only Cafe-authored finite messages may cross the public login error boundary. */
export function axiomLoginFailureMessage(error: unknown): string {
  // Preserve nominal local error classification here; structural wire lookalikes must not acquire this control/recovery outcome.
  // @effect-diagnostics-next-line instanceOfSchema:off
  return error instanceof ProviderAdapterValidationError &&
    error.provider === "axiom" &&
    error.operation === "login" &&
    Object.values(AXIOM_LOGIN_ERRORS).some((message) => message === error.issue)
    ? error.issue
    : AXIOM_LOGIN_ERRORS.start;
}

/** Native already validates its authorization metadata. Independently bind the
 * browser launch to that same configured website and exact native-login route.
 * This private URL must never enter renderer data, logs or command diagnostics. */
export function axiomLoginUrl(value: string, environment: NodeJS.ProcessEnv): string | null {
  if (value.length > 4096 || /[\u0000-\u0020\u007f]/u.test(value)) return null;
  try {
    const expected = new URL(environment.AXIOM_AUTH_URL ?? "https://auth.axiom.stream");
    const url = new URL(value);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(expected.hostname);
    if (
      (expected.protocol !== "https:" && !(expected.protocol === "http:" && loopback)) ||
      expected.username ||
      expected.password ||
      url.origin !== expected.origin ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname !== "/native/authorize" ||
      [...url.searchParams].length !== 2 ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(url.searchParams.get("authorization_id") ?? "") ||
      !/^[A-Za-z0-9_-]{16,512}$/u.test(url.searchParams.get("state") ?? "")
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}
