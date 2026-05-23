import { describe, expect, it } from "vitest";

import {
  applyCafeBackgroundAnimations,
  CAFE_BACKGROUND_ANIMATIONS_ATTRIBUTE,
  CAFE_DOCUMENT_VISIBILITY_ATTRIBUTE,
  CAFE_WINDOW_FOCUS_ATTRIBUTE,
  clearCafeBackgroundAnimations,
  readCafeDocumentVisibility,
  readCafeWindowFocus,
  startCafeDocumentVisibilitySync,
  type CafeVisibilityDocument,
  type CafeVisibilityWindow,
} from "./documentVisibility";

type VisibilityListener = () => void;
type FocusListener = () => void;

function makeVisibilityDocument(initialVisibility: DocumentVisibilityState) {
  const attributes = new Map<string, string>();
  let listener: VisibilityListener | null = null;
  let focusListener: FocusListener | null = null;
  let blurListener: FocusListener | null = null;
  let focused = true;

  const fakeDocument = {
    visibilityState: initialVisibility,
    hasFocus: () => focused,
    documentElement: {
      getAttribute: (name: string) => attributes.get(name) ?? null,
      removeAttribute: (name: string) => {
        attributes.delete(name);
      },
      setAttribute: (name: string, value: string) => {
        attributes.set(name, value);
      },
    },
    addEventListener: (type: "visibilitychange", nextListener: VisibilityListener) => {
      if (type === "visibilitychange") {
        listener = nextListener;
      }
    },
    removeEventListener: (type: "visibilitychange", nextListener: VisibilityListener) => {
      if (type === "visibilitychange" && listener === nextListener) {
        listener = null;
      }
    },
  } satisfies CafeVisibilityDocument;
  const fakeWindow = {
    addEventListener: (type: "blur" | "focus", nextListener: FocusListener) => {
      if (type === "focus") {
        focusListener = nextListener;
      }
      if (type === "blur") {
        blurListener = nextListener;
      }
    },
    removeEventListener: (type: "blur" | "focus", nextListener: FocusListener) => {
      if (type === "focus" && focusListener === nextListener) {
        focusListener = null;
      }
      if (type === "blur" && blurListener === nextListener) {
        blurListener = null;
      }
    },
  } satisfies CafeVisibilityWindow;

  return {
    document: fakeDocument,
    window: fakeWindow,
    getVisibilityAttribute: () =>
      fakeDocument.documentElement.getAttribute(CAFE_DOCUMENT_VISIBILITY_ATTRIBUTE),
    getFocusAttribute: () => fakeDocument.documentElement.getAttribute(CAFE_WINDOW_FOCUS_ATTRIBUTE),
    setVisibility: (visibilityState: DocumentVisibilityState) => {
      fakeDocument.visibilityState = visibilityState;
      listener?.();
    },
    setFocused: (nextFocused: boolean) => {
      focused = nextFocused;
      if (nextFocused) {
        focusListener?.();
      } else {
        blurListener?.();
      }
    },
  };
}

describe("documentVisibility", () => {
  it("maps only visible documents to the visible animation state", () => {
    expect(readCafeDocumentVisibility({ visibilityState: "visible" })).toBe("visible");
    expect(readCafeDocumentVisibility({ visibilityState: "hidden" })).toBe("hidden");
  });

  it("maps window focus into the animation pause state", () => {
    expect(readCafeWindowFocus({ hasFocus: () => true })).toBe("focused");
    expect(readCafeWindowFocus({ hasFocus: () => false })).toBe("blurred");
    expect(readCafeWindowFocus({})).toBe("focused");
  });

  it("keeps a document attribute synchronized with visibility changes", () => {
    const fake = makeVisibilityDocument("visible");
    const stop = startCafeDocumentVisibilitySync(fake.document, fake.window);

    expect(fake.getVisibilityAttribute()).toBe("visible");
    expect(fake.getFocusAttribute()).toBe("focused");

    fake.setVisibility("hidden");
    expect(fake.getVisibilityAttribute()).toBe("hidden");

    fake.setVisibility("visible");
    expect(fake.getVisibilityAttribute()).toBe("visible");

    fake.setFocused(false);
    expect(fake.getFocusAttribute()).toBe("blurred");

    fake.setFocused(true);
    expect(fake.getFocusAttribute()).toBe("focused");

    stop();
    expect(fake.getVisibilityAttribute()).toBeNull();
    expect(fake.getFocusAttribute()).toBeNull();

    fake.setVisibility("hidden");
    expect(fake.getVisibilityAttribute()).toBeNull();
    fake.setFocused(false);
    expect(fake.getFocusAttribute()).toBeNull();
  });

  it("maps the background animation setting into a document attribute", () => {
    const fake = makeVisibilityDocument("visible");

    expect(applyCafeBackgroundAnimations(false, fake.document)).toBe("paused");
    expect(fake.document.documentElement.getAttribute(CAFE_BACKGROUND_ANIMATIONS_ATTRIBUTE)).toBe(
      "paused",
    );

    expect(applyCafeBackgroundAnimations(true, fake.document)).toBe("running");
    expect(fake.document.documentElement.getAttribute(CAFE_BACKGROUND_ANIMATIONS_ATTRIBUTE)).toBe(
      "running",
    );

    clearCafeBackgroundAnimations(fake.document);
    expect(fake.document.documentElement.getAttribute(CAFE_BACKGROUND_ANIMATIONS_ATTRIBUTE)).toBe(
      null,
    );
  });
});
