# Decision: full local Mermaid bundle with bounded family admission

Decision status: Accepted
Created: 2026-10-12 04:04:59 JST (UTC+0900)
Last updated: 2026-10-12 04:46:50 JST (UTC+0900)
Decision authority: implementation choices within the human's explicit request for broad Mermaid support, regression tests and this qualified dev push.
Implementation status: Implemented; reproducible real-engine, repository/build and exact-head hosted qualification remain separate publication gates.
Supersedes: Only the Tiny distribution choice in [isolated rendering](mermaid-rendering.md). Its sandbox, source fidelity, inert output and documented containment limitations remain unchanged. Supplements [chart](mermaid-chart-admission.md) and [Gantt](mermaid-gantt-admission.md) admission; their existing contracts remain mandatory.

## Context and alternatives

The previous source/type allowlists exposed eight families even though the
locked Tiny12 distribution included many more. Mindmap and architecture were
omitted from that distribution. All supplied diagram dialects exist in the
same upstream12.0.0 revision; they are not source that Cafe should translate
into a different chart. Merely removing the type switch would bypass resource
limits and admit expanding packet offsets, block spacers, unsafe hierarchy
accessors, cyclic Sankey graphs and unconstrained numeric layout.

Use the exact full `mermaid`12.0.0 single-script IIFE, not its lazy ESM entrypoint,
another renderer or a network service. It requires no dynamic chunk imports.
The full renderer costs additional local asset/frame initialization bytes;
source/theme/policy results remain cached under the existing bounded queue.
Do not execute the bundle in Cafe's realm. The app loads it only as inert source
for the nonce-protected opaque-origin rendering document.

## Identity and reproducibility

The exact distribution is bound by `apps/web/package.json`, `yarn.lock` and
`bundleIdentity.test.ts`. The full IIFE is5,575,485bytes, SHA256
`28fca7ae6ebc7ed7bb63bde63136a74bfef14f296a57e403657eeb8b32836073`.
Its registry archive SHA512 is
`/wQXC9iBxoGV8p3erbvaXs9h77VyLDBH6GdayVjj3hEcSQhFU4N1WUhUppotCEqlIxI2pRMwjwBSwTB1MfZBgQ==`.
Registry integrity is not an independent publisher attestation. The
[immutable upstream detector inventory](https://github.com/mermaid-js/mermaid/blob/98a0945418c76238f15df2afaddbba4272656c3b/packages/mermaid/src/diagram-api/diagram-orchestration.ts)
binds the reviewed native engine contracts. The compiled bundle's embedded
dependency graph, not arbitrary installed transitive ESM files, executes in the
sandbox; upgrades require reviewing both distribution and installed lock graph.

The new Chevrotain dependency requests `lodash-es`4.17.23, which is affected by
[template compilation](https://github.com/advisories/GHSA-r5fr-rjxr-66jc) and
[prototype deletion](https://github.com/advisories/GHSA-f23m-r3pf-42rh) advisories.
The root resolution narrowly maps that exact descriptor to patched4.18.1.
It does **not** rewrite the prebuilt renderer: its reviewed source map still
includes229 older Lodash helper modules, but neither version's emitted module
inventory contains `template`, `templateSettings`, `unset`, `omit`, `_baseUnset`
or `_parent`. The exact map is SHA256
`b92ab7885a856caee67c64031fa02ff60e59d0ec540b77b5de3d85cae4b36401`;
the identity tests bind both artifact and this narrow reachability finding.
Nonce-only CSP also denies dynamic evaluation, but is not claimed to prevent
prototype deletion. Existing repository audit findings outside this changeset
remain separately reported; this is not a blanket dependency upgrade or a claim
that Mermaid and its compiled dependencies are universally vulnerability-free.

## Decision and security consequences

Additional adapters are fixed local scripts within the same sandbox. They bind
admission to known parsed family contracts before native layout, not a generic
recursive object count or guessed empty graph. Raw preflight precedes parsing
where the grammar itself expands numeric input. Unknown database shapes and
unqualified source remain exact copyable source with content-free failures.
Packet's first field may share its header line; that suffix is checked before
the native population pass with the same contiguous row/fragment budget.
The cache policy is versioned `full-12.0.0/cafe-4`.

Keep global classic look, strict security, HTML labels disabled and code-owned
Dagre policy where engines use graph layout. Sankey uses its native source-node
link color rather than gradient paint servers unsupported by the independent
SVG policy. This changes link coloring, not data/topology. No sanitizer elements,
style permissions, CSP, callbacks, image resources, provider authority or desktop
capabilities are widened to accommodate additional engines.

Event modeling has no native SVG-label option. Its fixed `g.em-box`/rect and
foreignObject→div/table→span/cell→bold name plus optional BR/BR/code structure
is parsed only in a detached inert template inside the opaque frame. Exact
namespaces, attributes, code-owned styles and padding-bound geometry are required.
Only text and native line breaks are converted to SVG text/tspans, using
`textContent`; no HTML style is copied. Characters/breaks and original box/edge
geometry survive, with a250-line/32KiB-character budget, bounded16–8px fitting
and no more than2x horizontal compression. Excessive/unknown markup refuses the
image instead of dropping content. The parent independently sanitizes the final
SVG as before. Native-unused notes/given-when-then and multiline data declarations
remain source-only. Raw timeframe/reset/dependency work is bounded before the
native allocating state resolver, not only after it emits relations.
Dependencies must reference an already-declared native frame; the pinned
one-pass resolver silently omits unknown/forward references, so those remain
exact source instead of qualifying incomplete images.
Quoted inline data, HTML payloads and braces without trailing whitespace remain
source: the pinned database assumes braces and unconditionally strips the final
pre-brace character. Cafe does not rewrite that data to make rendering succeed.

Native `info` declares a400×100 viewport but never emits a viewBox. Only its exact
known root/container/version-text structure and attribute values qualify for
the fixed `0 0 400 100` viewport inside the opaque frame. Unknown output or a
different version refuses the image. This is not generic geometry inference;
the parent SVG admission remains unchanged. Upstream bundled license comments
are preserved and component notices/source links are recorded in `NOTICE.md`.

The existing32KiB source,250-item/connection admission,2MiB SVG,64 pending jobs,
128-entry/16MiB cache and15-second asynchronous deadline remain in force.
Per-family aggregate bounds include synthesized containers, children, metadata,
ticks and expanding intermediate work where applicable. Finite values alone
are insufficient when native arithmetic or topology walks can overflow.
Unsupported icons/HTML-only output must not become silently incomplete images.
The iframe still is neither a hard synchronous CPU deadline nor a universal
self-navigation barrier; no arbitrary-code containment proof is claimed.

## Verification and operational boundary

`MermaidFamilies.browser.tsx` uses real parsed native output, retained semantic
geometry/labels, inert image decoding, complete PNGs, light/dark themes and exact
Source/Copy controls. Geometry-stripped controls prevent text-only pictures from
qualifying a chart. Synthetic pre-layout sentinels qualify resource/malformed
contracts without forcing large layouts. Legacy engines, isolation and active
SVG negatives remain required. Run in the existing native-provider browser
projects and macOS/Windows focused CI coverage; workers/deadlines do not change.

See [Mermaid diagrams](../mermaid-diagrams.md) for supported syntax, conservative
fidelity/resource limits and replay commands. Local Chromium/isolated export
checks do not establish live clipboard/picker delivery, packaged-native smoke,
Linux/Windows renderer qualification or hosted release success. All repository
gates and the final forced desktop build precede this approved push; exact-head
hosted checks and release artifact metadata separately qualify delivery.
