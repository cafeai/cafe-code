/** One effect-owned metadata subscription. The caller owns scope selection;
 * disposal fences every callback, including an asynchronously acquired close.
 * This controller has no React, DOM, provider or credential dependencies.
 */
export function subscribeMetadata<Value>(options: {
  readonly loading: Value;
  readonly unavailable: Value;
  readonly publish: (value: Value) => void;
  readonly subscribe: (
    publish: (value: Value) => void,
    awaiting: () => void,
    active: () => boolean,
  ) => (() => void) | Promise<() => void>;
}): () => void {
  let current = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let close: (() => void) | undefined;
  const publish = (value: Value) => {
    if (!current) return;
    clearTimeout(timer);
    options.publish(value);
  };
  const awaiting = () => {
    if (!current) return;
    publish(options.loading);
    timer = setTimeout(() => publish(options.unavailable), 6000);
  };
  awaiting();
  const install = (value: () => void) => {
    if (current) close = value;
    else value();
  };
  try {
    const result = options.subscribe(publish, awaiting, () => current);
    if (typeof result === "function") install(result);
    else void result.then(install, () => publish(options.unavailable));
  } catch {
    publish(options.unavailable);
  }
  return () => {
    if (!current) return;
    current = false;
    clearTimeout(timer);
    close?.();
  };
}
