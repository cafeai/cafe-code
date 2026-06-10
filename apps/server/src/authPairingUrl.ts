const PAIRING_TOKEN_PARAM = "token";

export function buildServerPairingUrl(baseUrl: string, credential: string): string {
  const url = new URL("/pair", baseUrl);
  // Startup/CLI pairing links are printed into terminals and handed to OS URL
  // openers. Query tokens survive those handlers and the dev-server redirect;
  // hash-only tokens can be split into a bare `pair#token=...` target.
  url.hash = "";
  url.searchParams.set(PAIRING_TOKEN_PARAM, credential);
  return url.toString();
}
