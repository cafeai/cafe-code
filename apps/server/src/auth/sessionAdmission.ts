import * as Semaphore from "effect/Semaphore";

// One backend owns browser sessions and Web Push. Serialize only local
// authorization/transport initiation with revocation, never remote delivery.
// Database identity and expiry validation remain mandatory inside this fence.
const admission = Semaphore.makeUnsafe(1);
export const withSessionAdmission = admission.withPermits(1);
