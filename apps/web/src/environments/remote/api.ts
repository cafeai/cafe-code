import { uiText } from "@cafecode/shared/i18n";
import type {
  AuthBearerBootstrapResult,
  AuthSessionState,
  AuthWebSocketTokenResult,
  ExecutionEnvironmentDescriptor,
} from "@cafecode/contracts";
import { ENVIRONMENT_ENDPOINT_PATHS } from "@cafecode/shared/environmentEndpoint";

class RemoteEnvironmentConnectionError extends Error {}
class RemoteEnvironmentNetworkError extends RemoteEnvironmentConnectionError {}

export function remoteEnvironmentErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof RemoteEnvironmentConnectionError) return error.message;
  if (isRemoteEnvironmentAuthHttpError(error)) {
    if (error.status === 401 || error.status === 403) {
      return uiText(
        "The server rejected the sign-in credential. Check the admin password or pairing credential, then try again.",
      );
    }
    if (error.status === 404) {
      return uiText(
        "This server does not support this sign-in method. Update Cafe Code on the server or use a pairing code.",
      );
    }
    if (error.status === 429)
      return uiText("Too many sign-in attempts. Wait a moment, then try again.");
    return uiText("The remote server could not complete this request. Try again shortly.");
  }
  return fallback;
}

class RemoteEnvironmentAuthHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "RemoteEnvironmentAuthHttpError";
    this.status = status;
  }
}

export function isRemoteEnvironmentAuthHttpError(
  error: unknown,
): error is RemoteEnvironmentAuthHttpError {
  return error instanceof RemoteEnvironmentAuthHttpError;
}

/**
 * Reconnecting may mint a fresh, short-lived socket token with the already
 * saved bearer. It must never replay enrollment, replace a rejected credential
 * or treat a malformed target/response as an ordinary outage. Keep admission
 * structural: raw network exception strings may contain credentials or URLs.
 */
export function isRetryableRemoteWebSocketUrlError(error: unknown): boolean {
  if (error instanceof RemoteEnvironmentNetworkError) return true;
  return (
    isRemoteEnvironmentAuthHttpError(error) &&
    (error.status === 408 || error.status === 429 || (error.status >= 500 && error.status <= 599))
  );
}

function remoteEndpointUrl(httpBaseUrl: string, pathname: string): string {
  const url = new URL(httpBaseUrl);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function fetchRemoteJson<T>(input: {
  readonly httpBaseUrl: string;
  readonly pathname: string;
  readonly method?: "GET" | "POST";
  readonly bearerToken?: string;
  readonly body?: unknown;
}): Promise<T> {
  const requestUrl = remoteEndpointUrl(input.httpBaseUrl, input.pathname);
  let response: Response;
  try {
    response = await fetch(requestUrl, {
      method: input.method ?? "GET",
      // Saved servers authenticate independently of primary/browser cookies.
      // Never forward a bootstrap POST body through a server-supplied redirect.
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        ...(input.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(input.bearerToken ? { authorization: `Bearer ${input.bearerToken}` } : {}),
      },
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    });
  } catch {
    throw new RemoteEnvironmentNetworkError(
      uiText(
        "Could not reach the remote Cafe Code server. Check the address, network access, and HTTPS certificate trust.",
      ),
    );
  }

  if (!response.ok) {
    throw new RemoteEnvironmentAuthHttpError(
      uiText("Remote auth request failed ({status}).", { status: response.status }),
      response.status,
    );
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new RemoteEnvironmentConnectionError(
      uiText(
        "The remote Cafe Code server returned an invalid response. Check the server address and port.",
      ),
    );
  }
}

export async function bootstrapRemoteBearerSession(input: {
  readonly httpBaseUrl: string;
  readonly credential: string;
}): Promise<AuthBearerBootstrapResult> {
  return fetchRemoteJson<AuthBearerBootstrapResult>({
    httpBaseUrl: input.httpBaseUrl,
    pathname: "/api/auth/bootstrap/bearer",
    method: "POST",
    body: {
      credential: input.credential,
    },
  });
}

export async function bootstrapRemotePasswordBearerSession(input: {
  readonly password: string;
  readonly httpBaseUrl: string;
}): Promise<AuthBearerBootstrapResult> {
  // Use the bearer endpoint rather than the primary server's cookie login.
  // Only the resulting session is retained; passwords never enter saved metadata.
  return fetchRemoteJson<AuthBearerBootstrapResult>({
    httpBaseUrl: input.httpBaseUrl,
    pathname: "/api/auth/bootstrap/password/bearer",
    method: "POST",
    body: {
      password: input.password,
    },
  });
}

export async function fetchRemoteSessionState(input: {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
}): Promise<AuthSessionState> {
  return fetchRemoteJson<AuthSessionState>({
    httpBaseUrl: input.httpBaseUrl,
    pathname: "/api/auth/session",
    bearerToken: input.bearerToken,
  });
}

export async function fetchRemoteEnvironmentDescriptor(input: {
  readonly httpBaseUrl: string;
  readonly approveCertificate?: boolean;
}): Promise<ExecutionEnvironmentDescriptor> {
  let lastError: unknown;
  for (const pathname of ENVIRONMENT_ENDPOINT_PATHS) {
    try {
      return await fetchRemoteJson<ExecutionEnvironmentDescriptor>({
        httpBaseUrl: input.httpBaseUrl,
        pathname,
      });
    } catch (error) {
      // Only enrollment may ask for native trust, before sending any credential.
      // Retry the public GET once; bootstrap POSTs are never replayed.
      const prepare = window.desktopBridge?.prepareRemoteCertificate;
      if (
        input.approveCertificate &&
        prepare &&
        error instanceof RemoteEnvironmentNetworkError &&
        new URL(input.httpBaseUrl).protocol === "https:"
      ) {
        const result = await prepare(input.httpBaseUrl);
        if (result === "approved") {
          return fetchRemoteJson<ExecutionEnvironmentDescriptor>({
            httpBaseUrl: input.httpBaseUrl,
            pathname,
          });
        }
        const messages = {
          declined: uiText("Certificate approval was cancelled. No sign-in credential was sent."),
          "invalid-certificate": uiText(
            "The server’s HTTPS certificate is expired, does not match its address, or cannot be trusted. Update and restart Cafe Code on the server, then try again.",
          ),
          unreachable: uiText(
            "Could not reach the remote Cafe Code server. Check the address and network access.",
          ),
          "storage-error": uiText(
            "Could not save certificate approval. Check that Cafe Code can write its local app data, then try again.",
          ),
          unchanged: uiText(
            "The server’s HTTPS certificate is valid, but the request failed. Check the server’s network access and cross-origin configuration.",
          ),
        };
        throw new RemoteEnvironmentConnectionError(messages[result]);
      }
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(uiText("Failed to fetch remote environment."));
}

export async function issueRemoteWebSocketToken(input: {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
}): Promise<AuthWebSocketTokenResult> {
  return fetchRemoteJson<AuthWebSocketTokenResult>({
    httpBaseUrl: input.httpBaseUrl,
    pathname: "/api/auth/ws-token",
    method: "POST",
    bearerToken: input.bearerToken,
  });
}

export async function resolveRemoteWebSocketConnectionUrl(input: {
  readonly wsBaseUrl: string;
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
}): Promise<string> {
  const url = new URL(input.wsBaseUrl, window.location.origin);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(uiText("Remote WebSocket URLs must use WS or WSS."));
  }
  if (url.username || url.password) {
    throw new Error(uiText("Remote WebSocket URLs cannot contain embedded credentials."));
  }
  url.search = "";
  url.hash = "";
  const issued = await issueRemoteWebSocketToken({
    httpBaseUrl: input.httpBaseUrl,
    bearerToken: input.bearerToken,
  });
  // JSON decoding alone does not establish a usable capability. A malformed
  // successful response must fail before opening a socket, not turn into an
  // endlessly retried `wsToken=undefined` authentication failure.
  if (!issued || typeof issued.token !== "string" || issued.token.trim().length === 0) {
    throw new RemoteEnvironmentConnectionError(
      uiText("The remote server returned an invalid socket token."),
    );
  }
  url.searchParams.set("wsToken", issued.token);
  return url.toString();
}
