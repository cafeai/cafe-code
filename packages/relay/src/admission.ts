import { concatenate, equalBytes, opaque, unopaque, utf8 } from "./bytes.ts";
import { sha256 } from "./crypto.ts";
import { requireRelay } from "./errors.ts";
import type { HostCapacityGrant } from "./broker.ts";

/** Public hosting owns a namespace derived from its admission key. Knowing a
 * locator cannot buy its slot with a different key, even after a lease expires. */
export function selfServiceHostLocator(networkId: string, admissionPublicKey: string): string {
  return opaque(
    sha256(
      concatenate(
        utf8.encode("CafeCode/relay/host-locator/v1\0"),
        unopaque(networkId, 32),
        unopaque(admissionPublicKey, 32),
      ),
    ),
  );
}

export function authorizeHostIdentity(input: {
  readonly networkId: string;
  readonly locator: string;
  readonly admissionPublicKey: string;
  readonly grants: readonly HostCapacityGrant[];
  readonly selfService: boolean;
}): HostCapacityGrant | undefined {
  const grant = input.grants.find((value) => value.locator === input.locator);
  requireRelay(
    grant
      ? grant.admissionPublicKey === input.admissionPublicKey
      : input.selfService &&
          input.locator === selfServiceHostLocator(input.networkId, input.admissionPublicKey),
    "AUTH_DENIED",
  );
  return grant;
}

/** Null explicitly selects paid self-service; an invalid operator token never
 * falls through to another enrollment mode. Both modes still require PoW. */
export function authorizeHostEnrollment(
  input: Parameters<typeof authorizeHostIdentity>[0] & {
    readonly capacityToken: string | null;
  },
): void {
  const grant = authorizeHostIdentity(input);
  requireRelay(
    grant
      ? input.capacityToken !== null &&
          equalBytes(unopaque(grant.tokenDigest, 32), sha256(unopaque(input.capacityToken, 32)))
      : input.capacityToken === null,
    "AUTH_DENIED",
  );
}
