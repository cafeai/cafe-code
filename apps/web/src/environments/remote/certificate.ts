import type {
  RemoteCertificateInspection,
  RemoteCertificatePreparation,
} from "@cafecode/contracts";
import { uiText } from "@cafecode/shared/i18n";

export type RemoteCertificateProblem = Extract<
  RemoteCertificateInspection,
  "changed" | "untrusted" | "invalid-certificate"
>;

/** A finite classification only. Never retain the native/network error or credentials. */
export class RemoteEnvironmentCertificateError extends Error {
  constructor(readonly certificateStatus: RemoteCertificateProblem) {
    super(
      certificateStatus === "changed"
        ? uiText("The server's HTTPS certificate has changed. Review it before reconnecting.")
        : certificateStatus === "untrusted"
          ? uiText("The server's HTTPS certificate needs your approval before reconnecting.")
          : uiText(
              "The server's HTTPS certificate is invalid or expired, or does not match its address.",
            ),
    );
    this.name = "RemoteEnvironmentCertificateError";
  }
}

/** Only fixed local explanations may be surfaced from the explicit review action. */
export class RemoteCertificateReviewError extends Error {}

export function remoteCertificatePreparationMessage(
  result: Exclude<RemoteCertificatePreparation, "approved">,
): string {
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
  return messages[result];
}
