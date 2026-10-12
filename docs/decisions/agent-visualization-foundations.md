# Decision: dedicated visualization data and finite lifecycle foundations

Decision status: Accepted for foundational boundaries only
Created: 2026-10-12 23:10:48 JST (UTC+0900)
Last updated: 2026-10-13 02:22:03 JST (UTC+0900)
Decision authority: implementation choices within the user's visualization/MCP Apps request, subject to the explicit no-install constraint and existing security requirements.
Historical foundation increment: complete isolated schema, JSON-decoding and coordination components were implemented before any artifact service, tool registration, active host, timeline feature or MCP Apps adapter was enabled. Later integration is documented in the successor host and Apps decisions.
Historical foundation verification: 65 focused data/lifecycle tests passed locally and independent source/docs review closed. Those checks did not qualify native execution or full-feature integration; this remains a foundation decision, not a release decision.
Supersedes: None. Existing inert attachment, Mermaid, native export, provider and approval policies remain in force.
Supplemented by: [sandboxed native execution host](agent-visualization-execution-host.md), including the user's explicit macOS hard-memory-cap exception. Historical implementation status below describes the foundation increment, not later host qualification.

## Context and alternatives

Generated browser content needs a purpose-specific artifact boundary. Treating a
filename, MIME value or provider JSON flag as authority to run HTML would weaken
existing inert file previews. Copying source into ordinary work-log references
would multiply private bytes across event journals, history and renderer state.
Public schema-validation errors can also echo rejected code or diagnostics.

An iframe, CSP, heap setting or watchdog alone does not qualify native CPU/memory
containment. A timeout is not proof that the exact child and descendants retired.
The current no-install constraint excludes provisioning a guest/runtime/helper or
changing OS policy to overcome platform gaps. Independent safe foundations can
be implemented without pretending that those gaps have been solved.

## Decision

- Keep contracts schema-only and expose the dedicated visualization subpath.
  Separate compact display references from private source and diagnostics.
  Refuse unknown routing/authority/path fields rather than silently ignore them.
  Count exact UTF-8, reject malformed surrogate pairs, and preserve admitted text.
- Provide bounded JSON decoders with fixed content-free failure results. Check
  byte, nesting and lexical work ceilings before payload decoding. Do not format
  raw schema issues or parser exceptions into operational output.
- Coordinate finite work with an opaque process-local lane, explicit admission,
  one slot, two waiting entries and nonrenewable deadlines. Keep response
  revocation separate from retirement. Only a private trusted-owner observation
  may release the exact active slot; uncertainty quarantines it.
- Do not wire these modules into provider tools, HTTP/RPC routes, generic file
  previews or active rendering before the dependent storage, provenance and
  native execution boundaries are qualified. Do not introduce a success-shaped
  platform stub or advertise unsupported Apps methods.

The complete contracts and lane API are documented in
[agent visualization foundations](../agent-visualizations.md). Canonical constants
and accepted schema fields remain in source rather than duplicated here.

## Security, privacy and failure consequences

Data validation and opaque local object identity are not durable authorization.
Future publication must independently bind the exact owner/runtime/native call
and immutable content, serialize claims with tombstones/session replacement, and
use per-invocation completion proofs distinct from operation deduplication.
Historical authenticated reads cannot inherit producer or Apps action authority.
No such authority is minted by these foundational components.

The retirement controller is private trusted plumbing, not an attestation API
for untrusted JSON or booleans. Its future caller must hold and freshly observe
the actual native owner. Unit tests prove stale-token rejection and finite
bookkeeping; they do not prove process death, browser sandboxing, kernel memory
accounting, native accessibility or long-lived viewer behavior.

Source/diagnostic schema acceptance does not remove embedded credentials. Explicit
private inspection still needs owner authentication/redaction before returning
bytes. The bounded parser never returns failed input/cause information, while a
successful producer value remains private and must not enter ordinary logs.

## Compatibility and operational consequences

No existing transcript/SQL schema, provider startup, daemon ownership, permissions,
native dialogs, generic attachments, dependency/runtime pin or CI policy changes.
No package installation, new executable/image, persistent service or OS change.
Existing viewers and provider work retain their current behavior.

Full desktop/browser capability and rollout remain pending. In particular, the
no-install macOS execution/resource boundary is unresolved. The full feature
goal is retained; these components are not a staged feature release or permission
to ship an incomplete active feature. No speculative performance improvement is
claimed. Native host/platform and input/accessibility evidence remain distinct
from local data/lifecycle tests.

## Evidence and supersession

The replay guide identifies focused and required repository checks. Verification
status must follow observed results at an exact source/toolchain state; acceptance
of this decision alone supplies no test evidence. A later accepted execution-host
or Apps decision will supplement these foundations without silently superseding
the existing inert-file/Mermaid or native provider approval policies.
