export const CAFE_DOCUMENT_VISIBILITY_ATTRIBUTE = "data-cafe-visibility";
export const CAFE_WINDOW_FOCUS_ATTRIBUTE = "data-cafe-window-focus";
export const CAFE_BACKGROUND_ANIMATIONS_ATTRIBUTE = "data-cafe-background-animations";

export type CafeDocumentVisibility = "hidden" | "visible";
export type CafeWindowFocus = "blurred" | "focused";
export type CafeBackgroundAnimations = "paused" | "running";

type CafeVisibilityListener = () => void;
type CafeWindowFocusListener = () => void;

export interface CafeVisibilityDocument {
  readonly documentElement: Pick<HTMLElement, "getAttribute" | "removeAttribute" | "setAttribute">;
  readonly visibilityState: DocumentVisibilityState;
  hasFocus?: () => boolean;
  addEventListener(type: "visibilitychange", listener: CafeVisibilityListener): void;
  removeEventListener(type: "visibilitychange", listener: CafeVisibilityListener): void;
}

export interface CafeVisibilityWindow {
  addEventListener(type: "blur" | "focus", listener: CafeWindowFocusListener): void;
  removeEventListener(type: "blur" | "focus", listener: CafeWindowFocusListener): void;
}

export function readCafeDocumentVisibility(
  documentRef: Pick<Document, "visibilityState">,
): CafeDocumentVisibility {
  return documentRef.visibilityState === "visible" ? "visible" : "hidden";
}

export function readCafeWindowFocus(
  documentRef: Pick<Document, "hasFocus"> | { hasFocus?: () => boolean },
): CafeWindowFocus {
  return typeof documentRef.hasFocus === "function" && !documentRef.hasFocus()
    ? "blurred"
    : "focused";
}

export function applyCafeDocumentVisibility(
  documentRef: Pick<CafeVisibilityDocument, "documentElement" | "visibilityState">,
): CafeDocumentVisibility {
  const visibility = readCafeDocumentVisibility(documentRef);
  documentRef.documentElement.setAttribute(CAFE_DOCUMENT_VISIBILITY_ATTRIBUTE, visibility);
  return visibility;
}

export function applyCafeWindowFocus(
  documentRef: Pick<CafeVisibilityDocument, "documentElement" | "hasFocus">,
): CafeWindowFocus {
  const focus = readCafeWindowFocus(documentRef);
  documentRef.documentElement.setAttribute(CAFE_WINDOW_FOCUS_ATTRIBUTE, focus);
  return focus;
}

export function applyCafeBackgroundAnimations(
  continueBackgroundAnimations: boolean,
  documentRef: Pick<CafeVisibilityDocument, "documentElement"> = document,
): CafeBackgroundAnimations {
  const mode = continueBackgroundAnimations ? "running" : "paused";
  documentRef.documentElement.setAttribute(CAFE_BACKGROUND_ANIMATIONS_ATTRIBUTE, mode);
  return mode;
}

export function clearCafeBackgroundAnimations(
  documentRef: Pick<CafeVisibilityDocument, "documentElement"> = document,
): void {
  documentRef.documentElement.removeAttribute(CAFE_BACKGROUND_ANIMATIONS_ATTRIBUTE);
}

export function startCafeDocumentVisibilitySync(
  documentRef: CafeVisibilityDocument = document,
  windowRef: CafeVisibilityWindow = window,
): () => void {
  const syncVisibility = () => {
    applyCafeDocumentVisibility(documentRef);
  };
  const syncFocus = () => {
    applyCafeWindowFocus(documentRef);
  };

  syncVisibility();
  syncFocus();
  documentRef.addEventListener("visibilitychange", syncVisibility);
  windowRef.addEventListener("focus", syncFocus);
  windowRef.addEventListener("blur", syncFocus);

  return () => {
    documentRef.removeEventListener("visibilitychange", syncVisibility);
    windowRef.removeEventListener("focus", syncFocus);
    windowRef.removeEventListener("blur", syncFocus);
    documentRef.documentElement.removeAttribute(CAFE_DOCUMENT_VISIBILITY_ATTRIBUTE);
    documentRef.documentElement.removeAttribute(CAFE_WINDOW_FOCUS_ATTRIBUTE);
  };
}
