export interface PolicyOverlayScope {
  active: boolean;
  dispose: (() => void) | null;
}

/** An exact owner's ACK can bridge projection lag, never replace canonical
 * policy at/after that ACK or resurrect an overlay after owner retirement. */
export async function saveAcknowledgedPolicyOverlay<T>(input: {
  readonly scope: PolicyOverlayScope;
  readonly isCurrent: () => boolean;
  readonly requested: T;
  readonly readSequence: () => number | undefined;
  readonly readCanonical: () => T | undefined;
  readonly readOverlay: () => T | undefined;
  readonly writeOverlay: (value: T | undefined) => void;
  readonly equal: (left: T | undefined, right: T | undefined) => boolean;
  readonly subscribe: (notify: () => void) => () => void;
  readonly dispatch: () => Promise<{ readonly sequence: number }>;
}) {
  const { scope } = input;
  scope.dispose?.();
  let acknowledged: number | null = null;
  let installed = false;
  let retired = false;
  let unsubscribe = () => {};
  const dispose = () => {
    if (retired) return;
    retired = true;
    unsubscribe();
    if (installed && input.equal(input.readOverlay(), input.requested))
      input.writeOverlay(undefined);
    installed = false;
    if (scope.dispose === dispose) scope.dispose = null;
  };
  unsubscribe = input.subscribe(() => {
    const sequence = input.readSequence();
    if (acknowledged !== null && sequence !== undefined && sequence >= acknowledged) dispose();
  });
  scope.dispose = dispose;
  try {
    acknowledged = (await input.dispatch()).sequence;
    const sequence = input.readSequence();
    if (
      !retired &&
      scope.active &&
      input.isCurrent() &&
      scope.dispose === dispose &&
      (sequence === undefined || sequence < acknowledged) &&
      !input.equal(input.readCanonical(), input.requested)
    ) {
      installed = true;
      input.writeOverlay(input.requested);
    }
  } finally {
    if (!installed) dispose();
  }
}
