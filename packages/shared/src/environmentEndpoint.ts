export const CAFE_CODE_ENVIRONMENT_ENDPOINT_PATH = "/.well-known/cafe-code/environment";

export const ENVIRONMENT_ENDPOINT_PATHS = [CAFE_CODE_ENVIRONMENT_ENDPOINT_PATH] as const;

/**
 * Public download path for the backend's self-signed HTTPS certificate (PEM).
 * Intentionally reachable over plain HTTP too, so a phone that cannot yet trust
 * the self-signed HTTPS listener can still fetch and install the certificate to
 * bootstrap trust. Only the public certificate is ever served here — never the
 * private key.
 */
export const CAFE_CODE_HTTPS_CERTIFICATE_PATH = "/.well-known/cafe-code/certificate.crt";
