import type { ThreadId } from "@cafecode/contracts";

export interface DesktopSessionBinding {
  readonly signature: string;
  readonly connectionPath: string | null;
  readonly bridgePath: string;
  startTurn(): Promise<void>;
  endTurn(): Promise<void>;
  dispose(): Promise<void>;
}
export interface DesktopSessionBroker {
  disabledBinding(): Pick<DesktopSessionBinding, "bridgePath" | "connectionPath">;
  detach(threadId: ThreadId): Promise<void>;
  inherit(source: ThreadId, target: ThreadId): Promise<void>;
  signature(threadId: ThreadId): Promise<string>;
  bind(threadId: ThreadId): Promise<DesktopSessionBinding>;
}

let broker: DesktopSessionBroker | undefined;
/** Like the provider credential broker, this connects the later persistence
 * layer to adapters without duplicating a runtime in every provider instance. */
export function installDesktopSessionBroker(value: DesktopSessionBroker) {
  broker = value;
  return () => {
    if (broker === value) broker = undefined;
  };
}
export const readDesktopSessionBroker = () => broker;
