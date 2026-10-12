import { cdp } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDesktopStartupDocument,
  DESKTOP_STARTUP_STYLE,
  type DesktopStartupPhase,
} from "@cafecode/shared/desktopStartupDocument";

let frame: HTMLIFrameElement | undefined;

afterEach(async () => {
  frame?.remove();
  frame = undefined;
  // Restore real media behavior for the next independent fixture file.
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
});

async function mountDocument(input: {
  readonly theme: "light" | "dark";
  readonly scalePercent: number;
  readonly phase: DesktopStartupPhase;
  readonly reducedMotion?: boolean;
}) {
  await cdp().send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-color-scheme", value: input.theme },
      { name: "prefers-reduced-motion", value: input.reducedMotion ? "reduce" : "no-preference" },
    ],
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(DESKTOP_STARTUP_STYLE),
  );
  const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
  frame = document.createElement("iframe");
  frame.setAttribute("title", "Cafe Code startup fixture");
  frame.style.width = "430px";
  frame.style.height = "230px";
  frame.style.border = "0";
  const loaded = new Promise<void>((resolve) =>
    frame!.addEventListener("load", () => resolve(), { once: true }),
  );
  frame.srcdoc = createDesktopStartupDocument(input.phase, hash);
  document.body.append(frame);
  await loaded;
  const contents = frame.contentDocument!;
  // Electron's native zoom is qualified separately with the isolated window
  // fixture. This renderer test checks the same rem-scale boundary without
  // giving the inert document a script or IPC surface.
  contents.documentElement.style.fontSize = `${(16 * input.scalePercent) / 100}px`;
  return { contents, view: frame.contentWindow! };
}

describe.each(["light", "dark"] as const)("inert desktop startup in %s", (theme) => {
  it.each([80, 130])(
    "keeps migration feedback readable and contained at %i%%",
    async (scalePercent) => {
      const { contents, view } = await mountDocument({ theme, scalePercent, phase: "migrating" });
      const main = contents.querySelector("main")!;
      const heading = contents.querySelector("h1")!;
      const status = contents.querySelector("[role='status']")!;
      const detail = contents.querySelector(".detail")!;
      expect(status.textContent).toBe("Updating your workspace…");
      expect(detail.textContent).toBe("Large workspaces can take a while. Your chats stay saved.");
      expect(view.getComputedStyle(contents.body).backgroundColor).toBe(
        theme === "dark" ? "rgb(22, 22, 22)" : "rgb(249, 249, 249)",
      );
      expect(view.getComputedStyle(heading).fontSize).toBe(`${(16 * scalePercent) / 100}px`);
      expect(view.getComputedStyle(status.querySelector(".spinner")!).animationName).toBe("spin");
      expect(main.getBoundingClientRect().right).toBeLessThanOrEqual(430);
      expect(detail.getBoundingClientRect().right).toBeLessThanOrEqual(430);
      expect(detail.getBoundingClientRect().bottom).toBeLessThanOrEqual(230);
      expect(contents.documentElement.scrollWidth).toBeLessThanOrEqual(430);
      expect(contents.querySelector("script, img, iframe, a, button, input")).toBeNull();
      expect(
        contents
          .querySelector("meta[http-equiv='Content-Security-Policy']")
          ?.getAttribute("content"),
      ).toContain("connect-src 'none'");
    },
  );

  it("uses actual browser reduced motion without a simulated matchMedia result", async () => {
    const { contents, view } = await mountDocument({
      theme,
      scalePercent: 130,
      phase: "ready",
      reducedMotion: true,
    });
    expect(view.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
    expect(view.getComputedStyle(contents.querySelector(".spinner")!).animationName).toBe("none");
    expect(view.getComputedStyle(contents.querySelector("main")!).animationName).toBe("none");
    expect(contents.querySelector("[role='status']")?.textContent).toBe("Opening your workspace…");
    expect(contents.querySelector(".detail")).toBeNull();
  });
});
