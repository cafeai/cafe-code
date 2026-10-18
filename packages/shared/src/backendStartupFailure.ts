/** Exact native child exit reserved for a typed, fail-closed profile startup
 * refusal after server runtime finalizers have drained. It is not inferred
 * from stderr, an exception tag, a PID lookup or a public HTTP response. */
export const BACKEND_PROFILE_STARTUP_REFUSED_EXIT_CODE = 78;
