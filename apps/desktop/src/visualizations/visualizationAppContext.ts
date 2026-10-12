import type { VisualizationHostDisplayMode } from "@cafecode/contracts/visualizationHost";

/** Native presentation only: none of these scalars grants an App an action. */
export interface VisualizationAppContext {
  readonly theme: "light" | "dark";
  readonly locale: "en" | "ja" | "ko";
  readonly reducedMotion: boolean;
  readonly scale: number;
  readonly displayMode: VisualizationHostDisplayMode;
  readonly containerDimensions: { readonly width: number; readonly height: number };
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * This process-local presenter tracks one SDK initialization, not an authority
 * receipt. Only the private native reply path may call receive. Self-posted
 * requests cannot initialize or update host context by naming a result field.
 */
export class VisualizationAppContextPresenter {
  private initializeId: string | number | undefined;
  private initialized = false;
  private initializationObserved = false;
  private context: VisualizationAppContext;
  private readonly preview: boolean;

  constructor(context: VisualizationAppContext, preview = false) {
    this.context = context;
    this.preview = preview;
  }

  observeOutgoing(value: unknown): void {
    if (
      this.initializationObserved ||
      !object(value) ||
      value.jsonrpc !== "2.0" ||
      value.method !== "ui/initialize" ||
      !(
        typeof value.id === "string" ||
        (typeof value.id === "number" && Number.isSafeInteger(value.id))
      )
    )
      return;
    this.initializationObserved = true;
    this.initializeId = value.id;
  }

  receive(value: unknown): unknown {
    if (
      !this.initialized &&
      this.initializeId !== undefined &&
      object(value) &&
      value.jsonrpc === "2.0" &&
      value.id === this.initializeId &&
      object(value.result) &&
      !Object.hasOwn(value, "error")
    ) {
      this.initialized = true;
      // Replace, rather than trust, backend/source-selected context fields. The
      // backend's independent RPC protocol still owns capabilities and results.
      return {
        ...value,
        result: {
          ...value.result,
          hostContext: {
            ...this.context,
            availableDisplayModes: this.preview ? ["inline"] : ["inline", "fullscreen"],
          },
        },
      };
    }
    return value;
  }

  update(context: VisualizationAppContext): object | null {
    const changed = JSON.stringify(context) !== JSON.stringify(this.context);
    this.context = context;
    return this.initialized && changed
      ? { jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: context }
      : null;
  }
}
