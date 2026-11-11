/** Public trust anchor and discovery URLs only. No host enrollment capability
 * or offline signing material is shipped with the desktop application. */
export const CAFE_RELAY_NETWORK = Object.freeze({
  networkId: "_KkbwdvqjXAbmrrROGsu4OPxb7_BM1mgnWj1B9DHHLY",
  rootPublicKey: "XJv9GaRrTRofnK_Zwd-W1xzIfxKB9nmO6zB3cJS5QIc",
  minimumRevision: 2,
  viewerOrigin: "https://relay.cafecode.sh",
  bootstrapUrls: [
    "https://relay-uk.cafecode.sh/v1/network",
    "https://relay-ca.cafecode.sh/v1/network",
    "https://relay-us-west.cafecode.sh/v1/network",
  ] as readonly string[],
});
