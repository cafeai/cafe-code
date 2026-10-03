import "../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

// No links are activated and no backend/provider exists in this fixture.
vi.mock("../localApi", () => ({ readLocalApi: () => undefined }));

import ChatMarkdown from "./ChatMarkdown";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("numeric Markdown whitespace", () => {
  it("preserves numeric boundaries throughout streamed rerenders, including inline code and links", async () => {
    const deltas = [
      "record",
      " ",
      "**0",
      "87**",
      " and",
      " ",
      "`2",
      "7`",
      " from",
      " ",
      "[0",
      "78](https://example.test/078)",
      ".",
    ];
    const screen = await render(<ChatMarkdown text="" cwd={undefined} isStreaming />);
    let text = "";
    try {
      for (const delta of deltas) {
        text += delta;
        await screen.rerender(<ChatMarkdown text={text} cwd={undefined} isStreaming />);
      }
      expect(document.querySelector("p")?.textContent).toBe("record 087 and 27 from 078.");
      await screen.rerender(<ChatMarkdown text={text} cwd={undefined} />);
      expect(document.querySelector("p")?.textContent).toBe("record 087 and 27 from 078.");
      expect(document.querySelector("code")?.textContent).toBe("27");
      expect(document.querySelector("a")?.getAttribute("href")).toBe("https://example.test/078");
    } finally {
      await screen.unmount();
    }
  });

  it("does not fabricate spaces inside provider-authored words, identifiers, or URLs", async () => {
    const screen = await render(
      <ChatMarkdown
        text="record087 and27 from078. Identifier: `record087`; [from078](https://example.test/from078)."
        cwd={undefined}
      />,
    );
    try {
      expect(document.querySelector("p")?.textContent).toBe(
        "record087 and27 from078. Identifier: record087; from078.",
      );
      expect(document.querySelector("code")?.textContent).toBe("record087");
      expect(document.querySelector("a")?.getAttribute("href")).toBe(
        "https://example.test/from078",
      );
    } finally {
      await screen.unmount();
    }
  });
});
