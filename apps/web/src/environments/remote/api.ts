import type {
  AuthBearerBootstrapResult,
  AuthSessionState,
  AuthWebSocketTokenResult,
  ExecutionEnvironmentDescriptor,
} from "@cafecode/contracts";
import { ENVIRONMENT_ENDPOINT_PATHS } from "@cafecode/shared/environmentEndpoint";

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

function remoteEndpointUrl(httpBaseUrl: string, pathname: string): string {
  const url = new URL(httpBaseUrl);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function fetchRemoteJson<T>(input: {
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
      headers: {
        ...(input.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(input.bearerToken ? { authorization: `Bearer ${input.bearerToken}` } : {}),
      },
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    });
  } catch (error) {
    throw new Error("Could not reach the remote Cafe Code server.", { cause: error });
  }

  if (!response.ok) {
    throw new RemoteEnvironmentAuthHttpError(
      `Remote auth request failed (${response.status}).`,
      response.status,
    );
  }

  return (await response.json()) as T;
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
}): Promise<ExecutionEnvironmentDescriptor> {
  let lastError: unknown;
  for (const pathname of ENVIRONMENT_ENDPOINT_PATHS) {
    try {
      return await fetchRemoteJson<ExecutionEnvironmentDescriptor>({
        httpBaseUrl: input.httpBaseUrl,
        pathname,
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Failed to fetch remote environment.");
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
    throw new Error("Remote WebSocket URLs must use WS or WSS.");
  }
  if (url.username || url.password) {
    throw new Error("Remote WebSocket URLs cannot contain embedded credentials.");
  }
  url.search = "";
  url.hash = "";
  const issued = await issueRemoteWebSocketToken({
    httpBaseUrl: input.httpBaseUrl,
    bearerToken: input.bearerToken,
  });
  url.searchParams.set("wsToken", issued.token);
  return url.toString();
}
