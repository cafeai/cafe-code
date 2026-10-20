import { createMermaidSandboxDocument } from "../lib/mermaid/sandboxDocument";
import { instrumentMermaidProbeBootstrap } from "./mermaidProbe.test.fixture";

type DocumentSegment =
  | { readonly kind: "static"; readonly text: string }
  | { readonly kind: "nonce" | "id" | "fixture" };

/** This bounded cache contains only immutable local engine/receiver text and
 * instrumentation. The UUID-shaped placeholders are inert template markers,
 * never invocation nonces or IDs and never submitted to a native document.
 * Preparing the expensive full-asset validation/replacements once avoids
 * repeatedly scanning the multi-megabyte locked engine for every native case.
 * Actual source, override code, realms, ports, parser state and outcomes are
 * deliberately absent: each call below receives its own newly minted binding. */
const documentSegments: readonly DocumentSegment[] = (() => {
  const nonce = "149ec896-9346-4785-9522-7b65f62a144f";
  const id = "c8d073fc-ea46-4169-ae43-9f97afad960a";
  const fixture = "__CAFE_MERMAID_FAMILY_FIXTURE_SLOT_V1__";
  const document = createMermaidSandboxDocument(nonce).replace(
    "</script></body>",
    `</script><script nonce="${nonce}">${fixture}</script></body>`,
  );
  // Reuse the existing exact escaped-asset validator and ordered readiness
  // instrumentation. No independent receiver/engine or weaker admission path
  // is introduced by this preparation step.
  const instrumented = instrumentMermaidProbeBootstrap(document, nonce, id);
  if (
    instrumented.indexOf(fixture) < 0 ||
    instrumented.indexOf(fixture) !== instrumented.lastIndexOf(fixture) ||
    instrumented.indexOf(id) < 0 ||
    instrumented.indexOf(id) !== instrumented.lastIndexOf(id)
  )
    throw new Error("Invalid family probe template binding");
  return Object.freeze(
    instrumented
      .split(new RegExp(`(${nonce}|${id}|${fixture})`, "g"))
      .map((text) =>
        Object.freeze(
          text === nonce
            ? { kind: "nonce" as const }
            : text === id
              ? { kind: "id" as const }
              : text === fixture
                ? { kind: "fixture" as const }
                : { kind: "static" as const, text },
        ),
      ),
  );
})();

/** Assemble only the final string for one fresh opaque native probe. All
 * JavaScript escaping is still performed by the original caller; immutable
 * segments neither parse nor rewrite its synthetic override script. Exact
 * byte-equivalence against the uncached builder is qualified separately. */
export function createMermaidFamilyProbeDocument(
  nonce: string,
  id: string,
  fixtureScript: string,
): string {
  if (!/^[a-f0-9-]{36}$/.test(nonce) || !/^[a-f0-9-]{36}$/.test(id))
    throw new Error("Invalid probe bootstrap binding");
  return documentSegments
    .map((segment) => {
      switch (segment.kind) {
        case "nonce":
          return nonce;
        case "id":
          return id;
        case "fixture":
          return fixtureScript;
        case "static":
          return segment.text;
      }
    })
    .join("");
}
