import type { HexagonsRuntimeSettings } from "./config.js";

export interface HexagonsDisplayInfo {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly scaleFactor: number;
}

export interface HexagonsBackgroundState {
  readonly activeRenderer: "initializing" | "gpu-webgl2" | "canvas2d-fallback";
  readonly fallbackReason: string | null;
  readonly animationAllowed: boolean;
  readonly lastResult: Readonly<Record<string, unknown>>;
  readonly fallingResult: Readonly<Record<string, unknown>>;
  readonly tileCount: number;
}

export interface HexagonsBackgroundController {
  readonly root: HTMLDivElement;
  updateSettings(patch: Readonly<Record<string, unknown>>): HexagonsRuntimeSettings;
  replaceSettings(settings: Readonly<Record<string, unknown>>): HexagonsRuntimeSettings;
  resize(): void;
  getSettings(): HexagonsRuntimeSettings;
  getState(): HexagonsBackgroundState;
  destroy(): void;
}

export interface CreateHexagonsBackgroundOptions {
  readonly container: HTMLElement;
  readonly position?: "absolute" | "fixed";
  readonly zIndex?: number;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly getDisplayInfo?: () => Promise<HexagonsDisplayInfo>;
  readonly onState?: (state: HexagonsBackgroundState) => void;
  readonly pointerTarget?: Window | HTMLElement;
}

export function createHexagonBackground(
  options: CreateHexagonsBackgroundOptions,
): Promise<HexagonsBackgroundController>;
