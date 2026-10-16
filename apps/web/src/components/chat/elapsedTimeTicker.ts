interface Visibility {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}
/** Presentation-only timer. Every owner disposes its interval/listener before
 * a replacement turn or status node can publish. No provider state is inferred.
 */
export function startElapsedTimeTicker(input: {
  startedMs: number;
  publish: (elapsedMs: number) => void;
  visibility: Visibility;
  now?: () => number;
}): () => void {
  const now = input.now ?? Date.now;
  let interval: ReturnType<typeof setInterval> | undefined;
  let current = true;
  const update = () => {
    if (current) input.publish(Math.max(0, now() - input.startedMs));
  };
  const synchronize = () => {
    clearInterval(interval);
    interval = undefined;
    if (!current || input.visibility.visibilityState === "hidden") return;
    update();
    interval = setInterval(update, 1000);
  };
  synchronize();
  input.visibility.addEventListener("visibilitychange", synchronize);
  return () => {
    if (!current) return;
    current = false;
    clearInterval(interval);
    input.visibility.removeEventListener("visibilitychange", synchronize);
  };
}
