import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SubagentAvatar } from "./SubagentAvatar";

describe("SubagentAvatar", () => {
  it("renders the same local vector artwork for the same provider thread id", () => {
    const first = renderToStaticMarkup(<SubagentAvatar seed="thread-audit-123" />);
    const second = renderToStaticMarkup(<SubagentAvatar seed="thread-audit-123" />);

    expect(first).toBe(second);
    expect(first).toContain("<svg");
    expect(first).not.toContain("<image");
    expect(first).not.toContain("href=");
    expect(first).not.toContain("url(");
  });

  it("derives distinct visual identities without exposing opaque thread ids", () => {
    const firstSeed = "provider-thread-private-alpha";
    const secondSeed = "provider-thread-private-beta";
    const first = renderToStaticMarkup(<SubagentAvatar seed={firstSeed} />);
    const second = renderToStaticMarkup(<SubagentAvatar seed={secondSeed} />);

    expect(first).not.toBe(second);
    expect(first).not.toContain(firstSeed);
    expect(second).not.toContain(secondSeed);
  });

  it("is decorative by default and supports an explicit accessible name", () => {
    const decorative = renderToStaticMarkup(<SubagentAvatar seed="thread-decorative" />);
    const labelled = renderToStaticMarkup(
      <SubagentAvatar seed="thread-labelled" label="Audit chat pipeline sub-agent" />,
    );

    expect(decorative).toContain('aria-hidden="true"');
    expect(decorative).toContain('role="presentation"');
    expect(labelled).toContain('role="img"');
    expect(labelled).toContain('aria-label="Audit chat pipeline sub-agent"');
    expect(labelled).not.toContain('aria-hidden="true"');
  });

  it("keeps hashing work bounded for long untrusted identifiers", () => {
    const longSeed = `${"shared-prefix-".repeat(100)}first-ending`;
    const siblingSeed = `${"shared-prefix-".repeat(100)}second-ending`;
    const first = renderToStaticMarkup(<SubagentAvatar seed={longSeed} className="size-10" />);
    const sibling = renderToStaticMarkup(<SubagentAvatar seed={siblingSeed} className="size-10" />);

    expect(first).not.toBe(sibling);
    expect(first).toContain('class="shrink-0 overflow-visible size-10"');
    expect(first).not.toContain(longSeed);
  });
});
