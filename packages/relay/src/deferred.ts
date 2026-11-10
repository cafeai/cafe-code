export interface DeferredPromise<A> {
  readonly promise: Promise<A>;
  readonly resolve: (value: A) => void;
  readonly reject: (error: unknown) => void;
}
/** Owned deferred, without requiring a newer global Promise implementation. */
export function deferred<A>(): DeferredPromise<A> {
  let resolve!: (value: A | PromiseLike<A>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}
