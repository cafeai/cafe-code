import { getKnownEnvironmentHttpBaseUrl } from "@cafecode/client-runtime";
import type { EnvironmentId } from "@cafecode/contracts";

import { getPrimaryKnownEnvironment } from "../primary";

export function getEnvironmentHttpBaseUrl(environmentId: EnvironmentId): string | null {
  const primaryEnvironment = getPrimaryKnownEnvironment();
  if (primaryEnvironment?.environmentId !== environmentId) {
    return null;
  }

  return getKnownEnvironmentHttpBaseUrl(primaryEnvironment);
}

export function resolveEnvironmentHttpUrl(input: {
  readonly environmentId: EnvironmentId;
  readonly pathname: string;
  readonly searchParams?: Record<string, string>;
}): string {
  const httpBaseUrl = getEnvironmentHttpBaseUrl(input.environmentId);
  if (!httpBaseUrl) {
    throw new Error(`Unable to resolve HTTP base URL for environment ${input.environmentId}.`);
  }

  const url = new URL(httpBaseUrl);
  url.pathname = input.pathname;
  if (input.searchParams) {
    url.search = new URLSearchParams(input.searchParams).toString();
  }
  return url.toString();
}
