// Saved images admit two transfers at a time. Waiting and active requests are
// cancelled on unmount; PNGs never enter persisted renderer/query state.
let active = 0;
const waiting = new Set<() => void>();
function pump() {
  for (let slots = 2 - active; slots > 0 && waiting.size; slots--)
    waiting.values().next().value?.();
}
export function admitImageTransfer(signal: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    const abort = () => {
      waiting.delete(ready);
      reject(new Error("cancelled"));
    };
    const ready = () => {
      waiting.delete(ready);
      signal.removeEventListener("abort", abort);
      active++;
      resolve(() => {
        active--;
        pump();
      });
    };
    waiting.add(ready);
    signal.addEventListener("abort", abort, { once: true });
    pump();
  });
}
