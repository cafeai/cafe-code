export function resolveWebUiConnectionSetupUrl(location: {
  readonly hostname: string;
  readonly port: string;
  readonly protocol: string;
}): string | null {
  if (location.protocol !== "https:") {
    return null;
  }

  // The packaged desktop server reserves the HTTP bootstrap listener two
  // ports below its HTTPS listener (3773/3775 by default).
  const httpsPort = Number(location.port || "443");
  if (!Number.isInteger(httpsPort) || httpsPort <= 2) {
    return null;
  }

  return `http://${location.hostname}:${httpsPort - 2}/`;
}
