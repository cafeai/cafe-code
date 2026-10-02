import "../index.css";

import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import ChatMarkdown from "./ChatMarkdown";

// This representative long pipeline intentionally uses the real Markdown,
// sandboxed Mermaid, sanitization and blob-image paths. Short mocked rectangles
// cannot catch unreadable scale-to-height previews or missing graph labels.
const PIPELINE_SOURCE = `flowchart TD
    accTitle: Proof verification pipeline
    I["Program + public inputs + protected private inputs"] --> A["Compile and admit original sources through CHL"]
    A --> R["Execute the registered VM"]
    R --> T["Admit the claimed transition through CHL"]
    T --> C["Independent replay + faithful CCS constraints"]
    C --> M["Native M31 proof component"]
    C --> B["Characteristic-two proof component"]
    M --> L["Authenticated links between the same canonical objects"]
    B --> L
    L --> P["One aggregate proof artifact"]
    P --> V["Independent verifier"]
    E["Independently expected public statement"] --> V`;

const CLOSED_MARKDOWN = `\`\`\`mermaid\n${PIPELINE_SOURCE}\n\`\`\``;

async function renderedPipeline(host: HTMLElement): Promise<HTMLImageElement> {
  // The first real render lazily loads the bundled engine before starting its
  // sandbox, whose production deadline is 15 seconds. A one-second polling
  // default races that cold startup under parallel browser CI. Bound readiness
  // separately, leaving time for the unchanged layout/security assertions
  // inside the suite's 30-second test budget; production limits stay unchanged.
  await vi.waitFor(
    () => {
      expect(host.querySelector(".mermaid-preview img")).not.toBeNull();
    },
    { timeout: 20_000 },
  );
  const image = host.querySelector<HTMLImageElement>(".mermaid-preview img")!;
  await image.decode();
  expect(image.naturalWidth).toBeGreaterThan(0);
  expect(image.naturalHeight).toBeGreaterThan(0);
  expect(image.alt).toBe("Proof verification pipeline");

  // Reading this local blob verifies that labels survived the real rendering
  // and sanitizer, without inserting untrusted SVG into the test document.
  const svg = await (await fetch(image.src)).text();
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  for (const style of parsed.querySelectorAll("style")) style.remove();
  const walker = document.createTreeWalker(parsed, NodeFilter.SHOW_TEXT);
  const labelParts: string[] = [];
  while (walker.nextNode()) labelParts.push(walker.currentNode.textContent ?? "");
  const labels = labelParts.join(" ").replace(/\s+/g, " ");
  expect(labels).toContain("Native M31 proof component");
  expect(labels).toContain("Independent verifier");
  expect(labels).toContain("One aggregate proof artifact");
  expect(parsed.querySelector("foreignObject, script, image, a")).toBeNull();
  expect(document.querySelector('iframe[title="Isolated diagram renderer"]')).toBeNull();
  return image;
}

async function capture(name: string): Promise<void> {
  // Optional visual evidence stays outside source and is never a committed
  // screenshot baseline. Ordinary CI exercises the same geometry assertions.
  if (import.meta.env.VITE_MERMAID_SCREENSHOTS !== "1") return;
  await page.screenshot({ path: `../../../../.explorations/101-mermaid/${name}.png` });
}

afterEach(() => {
  localStorage.removeItem("cafe-code:theme");
  document.documentElement.classList.remove("dark");
  document.documentElement.style.removeProperty("background-color");
  document.body.style.removeProperty("background-color");
});

describe("real Mermaid chat preview", () => {
  it.each([
    { name: "wide-dark", theme: "dark", viewport: 1200, pane: "52rem" },
    { name: "narrow-light", theme: "light", viewport: 420, pane: "22rem" },
  ])(
    "keeps the $name pipeline readable and scrollable inside its message",
    async ({ name, theme, viewport, pane }) => {
      await page.viewport(viewport, 900);
      localStorage.setItem("cafe-code:theme", theme);
      const host = document.createElement("div");
      host.style.width = `min(100%, ${pane})`;
      host.style.padding = "1rem";
      document.body.append(host);
      const screen = await render(
        <ChatMarkdown text={CLOSED_MARKDOWN} cwd={undefined} isStreaming />,
        { container: host },
      );
      try {
        const image = await renderedPipeline(host);
        const imageUrl = image.src;
        const preview = host.querySelector<HTMLElement>(".mermaid-preview")!;
        const block = host.querySelector<HTMLElement>(".mermaid-block")!;
        const renderedSize = image.getBoundingClientRect();
        expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
        expect(block.getBoundingClientRect().right).toBeLessThanOrEqual(
          host.getBoundingClientRect().right,
        );
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
        // Keep labels at their intrinsic size on both wide and narrow panes.
        // Both axes scroll locally instead of shrinking the graph into a small
        // thumbnail or allowing its intrinsic size to widen the conversation.
        expect(renderedSize.width).toBeCloseTo(image.naturalWidth, 0);
        expect(renderedSize.height / renderedSize.width).toBeCloseTo(
          image.naturalHeight / image.naturalWidth,
          2,
        );
        expect(preview.scrollHeight).toBeGreaterThan(preview.clientHeight + 30);
        expect(renderedSize.height).toBeGreaterThan(preview.clientHeight);
        await expect
          .element(page.getByRole("region", { name: "Mermaid diagram preview; scroll to inspect" }))
          .toHaveAttribute("tabindex", "0");
        if (name === "narrow-light") {
          expect(preview.scrollWidth).toBeGreaterThan(preview.clientWidth);
          preview.focus();
          await userEvent.keyboard("{ArrowRight}");
          await vi.waitFor(() => expect(preview.scrollLeft).toBeGreaterThan(0));
          // Show the main pipeline column in the visual evidence after proving
          // that keyboard users can reach content outside the initial viewport.
          preview.scrollLeft = (preview.scrollWidth - preview.clientWidth) / 2;
        } else {
          expect(preview.scrollWidth).toBeLessThanOrEqual(preview.clientWidth + 1);
        }
        await capture(`${name}-preview`);
        preview.scrollTo(preview.scrollLeft, preview.scrollHeight);
        expect(preview.scrollTop).toBeGreaterThan(0);
        await capture(`${name}-preview-bottom`);

        await page.getByRole("button", { name: "Source", exact: true }).click();
        expect(host.querySelector(".mermaid-source code")?.textContent).toBe(PIPELINE_SOURCE);
        await page.getByRole("button", { name: "Diagram", exact: true }).click();
        expect(host.querySelector<HTMLImageElement>(".mermaid-preview img")!.src).toBe(imageUrl);
        await page.getByRole("button", { name: "Expand diagram" }).click();
        await expect
          .element(page.getByRole("dialog", { name: "Expanded Mermaid diagram" }))
          .toBeVisible();
        const popup = document.querySelector<HTMLElement>(".mermaid-expanded-dialog")!;
        const expandedViewport = document.querySelector<HTMLElement>(".mermaid-expanded-viewport")!;
        await vi.waitFor(() => {
          expect(Number(getComputedStyle(popup).opacity)).toBe(1);
          expect(expandedViewport.scrollWidth).toBeLessThanOrEqual(
            expandedViewport.clientWidth + 1,
          );
          expect(expandedViewport.scrollHeight).toBeLessThanOrEqual(
            expandedViewport.clientHeight + 1,
          );
        });
        expect(popup.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth + 1);
        expect(popup.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight + 1);
        await capture(`${name}-expanded-fit`);
        await page.getByRole("button", { name: "Reset", exact: true }).click();
        expect(document.querySelector(".mermaid-zoom-value")?.textContent).toBe("100%");
        expect(expandedViewport.scrollHeight).toBeGreaterThan(expandedViewport.clientHeight);
        await capture(`${name}-expanded-reset`);

        // Later prose remains streaming after this complete fence. It must not
        // remount the real image, reset zoom or dismiss the user's open viewer.
        await screen.rerender(
          <ChatMarkdown
            text={`${CLOSED_MARKDOWN}\n\nThe verifier checks the aggregate proof.`}
            cwd={undefined}
            isStreaming
          />,
        );
        await expect
          .element(page.getByRole("dialog", { name: "Expanded Mermaid diagram" }))
          .toBeVisible();
        expect(host.querySelector<HTMLImageElement>(".mermaid-preview img")!.src).toBe(imageUrl);
        expect(document.querySelector(".mermaid-zoom-value")?.textContent).toBe("100%");
        await userEvent.keyboard("{Escape}");
        await expect.element(page.getByRole("button", { name: "Expand diagram" })).toHaveFocus();
      } finally {
        await screen.unmount();
        host.remove();
      }
    },
  );

  it("renders a newly closed fence during a live stream and preserves exact source", async () => {
    await page.viewport(1000, 800);
    localStorage.setItem("cafe-code:theme", "dark");
    const host = document.createElement("div");
    host.style.width = "min(100%, 48rem)";
    document.body.append(host);
    const screen = await render(
      <ChatMarkdown text={`\`\`\`mermaid\n${PIPELINE_SOURCE}`} cwd={undefined} isStreaming />,
      { container: host },
    );
    try {
      expect(host.querySelector(".mermaid-source code")?.textContent).toBe(PIPELINE_SOURCE);
      expect(host.querySelector(".mermaid-preview img")).toBeNull();
      expect(document.querySelector('iframe[title="Isolated diagram renderer"]')).toBeNull();
      await screen.rerender(
        <ChatMarkdown text={`${CLOSED_MARKDOWN}\n\nStill streaming`} cwd={undefined} isStreaming />,
      );
      await renderedPipeline(host);
      await expect.element(page.getByText("Still streaming", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Source", exact: true }).click();
      expect(host.querySelector(".mermaid-source code")?.textContent).toBe(PIPELINE_SOURCE);
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
