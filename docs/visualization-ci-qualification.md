# Visualization CI qualification

Status: Qualification procedure for the current Full-access browser path
Created: 2026-10-13 18:22:30 JST (UTC+0900)
Last updated: 2026-10-13 23:38:27 JST (UTC+0900)

The current feature executes ordinary same-origin browser frames, not a separate
native source host. CI selects real browser input/layout/lifecycle/App protocol
and inert current-frame PNG fixtures. Earlier native-host checks remain historical
and are not release evidence for this architecture. The user explicitly replaced
that architecture; its helper setup and active-host qualification steps are removed
from Quality. This does not disable Electron's ordinary application policies or
change provider permissions, unrelated browser contexts or artifact qualification.

## Reproducible local checks

Use the repository-pinned Node and Corepack Yarn; do not resolve another runtime
or install dependencies as a workaround. Runtime/lock/action pins are unchanged.
With that runtime already on PATH:

```sh
corepack yarn fmt
corepack yarn i18n:extract
corepack yarn fmt:check
corepack yarn lint
corepack yarn audit:repository
NODE_OPTIONS=--max-old-space-size=4096 corepack yarn typecheck --force --concurrency=1 --continue=always
corepack yarn test --force
corepack yarn workspace @cafecode/web test:browser
corepack yarn workspace @cafeai/cafe-code build:bundle
CAFE_CODE_MCP_BRIDGE_E2E=1 corepack yarn workspace @cafeai/cafe-code exec vitest run --config vitest.e2e.config.ts integration/CafeMcpBridge.e2e.test.ts
corepack yarn build:desktop --force
```

The forced desktop build is last, after all tests on unchanged source. Preserve
exact working-tree inputs, commands, toolchain identity, byte counts and hashes
of private logs. A changed source/environment reopens affected gates. Default
tests do not launch live providers or read real accounts/profiles.

The build still validates the emitted ordinary application and global dictation
preloads against Electron's supported sandbox-preload module set. Both artifacts
are required; a missing file, shared relative chunk, unsupported module or dynamic
import fails the build. There is no visualization preload in the current inline
design. Removing that retired artifact does not relax these application checks.

The serial uncached typecheck uses the pinned Turbo diagnostic policy to finish
every package after a failure; it still exits unsuccessfully if any package
fails. This is not a retry or permission to proceed to publication with errors.

## Browser assertions

Current visualization files exercise Full-access denial/late responses, actual
clickable source frames, full-width/natural-height flow, multiple visible units,
stable partial-scroll document identity, true offscreen teardown, quiet menu,
private disclosure and owner loss. The App bridge uses actual WindowProxy messages
and registers before parsing so SDK initialization cannot be lost. Consent is
one-use and private JSON remains deliberate; backend independently tests exact
configured-server and current-policy admission.

Current PNG fixtures verify real SVG gradients, HTML/chart text, actual canvas/
image/WebGL pixels, explicit abort/decode/serialization limits, owner/document
replacement and omission/refusal of active or unreadable content. Arbitrary WebGL
that does not preserve its drawing buffer may not retain pixels at export time;
the bundled decorative helper preserves its buffer. No saved preview substitutes.

Font checks retain complete fixed-byte equality, independent digests, headers,
descriptor limits and OFL notice. Fluid checks preserve the actual supplied
solver, allocation/resource identity, static/reduced-motion/context-loss handling,
pointer progress and exact cleanup. Actual glyph ink bounds must remain uniformly
scaled, not merely an SVG advance or family-name assertion.

Linux retains the complete browser suite. Windows/macOS use the existing focused
subset plus current history/owner/App/capture fixtures, with original worker caps,
deadlines and provider-owned input/reduced-motion contexts. No raw CDP mutations,
media mocks, forced hover CSS or retries substitute for input qualification.
Mermaid remains a separate inert renderer and its admission/export tests remain.

## Native artifacts and failure evidence

Copied MCP bridge artifacts run as independent bundles in private synthetic
directories with the existing native executable and temporary test credentials.
They qualify audience/endpoint/transport construction, not a real provider.
Every applicable Quality/native-artifact/Linux AppImage job and nonempty unexpired
exact-run/head release artifact must pass before claiming hosted delivery.
Diagnostic ZIPs never qualify a release; dev push does not authorize tag publication.

Preserve raw failed-job logs privately with byte count/SHA-256 before diagnosis.
Only exact synthetic fixture screenshots are uploaded; no user source, retained
chart, profile or whole attachment/temporary tree is published. Missing pixels
or unobserved phases are not evidence of a cause.

Local fixtures do not prove user-owned rebuilt app adoption, installed IME/
screen-reader/native dialog delivery, physical memory accounting, or native
Windows/Linux outcomes from a Mac. Same-origin Full-access source remains
privileged even when every data/protocol/lifecycle assertion passes.
