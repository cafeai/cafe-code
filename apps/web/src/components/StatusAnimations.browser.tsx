import { afterEach, expect, it } from "vitest";
import {
  applyCafeBackgroundAnimations,
  CAFE_BACKGROUND_ANIMATIONS_ATTRIBUTE,
  CAFE_DOCUMENT_VISIBILITY_ATTRIBUTE,
  CAFE_WINDOW_FOCUS_ATTRIBUTE,
} from "../documentVisibility";
import "../index.css";

const attributes = [
  CAFE_BACKGROUND_ANIMATIONS_ATTRIBUTE,
  CAFE_DOCUMENT_VISIBILITY_ATTRIBUTE,
  CAFE_WINDOW_FOCUS_ATTRIBUTE,
];
const original = attributes.map((name) => document.documentElement.getAttribute(name));
let host: HTMLElement | undefined;
afterEach(() => {
  host?.remove();
  attributes.forEach((name, index) => {
    const value = original[index];
    if (value == null) document.documentElement.removeAttribute(name);
    else document.documentElement.setAttribute(name, value);
  });
});
it("honors the background animation preference when the document is hidden", () => {
  host = document.createElement("div");
  host.className = "animate-spin";
  document.body.append(host);
  document.documentElement.setAttribute(CAFE_DOCUMENT_VISIBILITY_ATTRIBUTE, "hidden");
  document.documentElement.setAttribute(CAFE_WINDOW_FOCUS_ATTRIBUTE, "blurred");
  applyCafeBackgroundAnimations(false);
  expect(getComputedStyle(host).animationPlayState).toBe("paused");
  applyCafeBackgroundAnimations(true);
  expect(getComputedStyle(host).animationPlayState).toBe("running");
});
