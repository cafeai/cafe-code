# Axiom public contract fixture

`../axiomAcpContractFixture.ts` is an independent initialization response from
AxiomCLI 0.1.22, reviewed against axiom-desktop `195479c` on 2026-11-16. Runtime
UUIDs are synthetic. It includes no account state, credentials, history, prompts,
inference or service traffic.

The ordinary Axiom adapter peer uses this fixture, rather than inventing versions
or importing Cafe's requested capabilities. Default negotiation tests admit this
response for both supported frontends, exercise the reviewed v1/v2 compatibility
cases and reject missing, obsolete and unknown required contracts. The peer's
MCP, command and terminal-response scenarios separately qualify those behaviors.

When updating Axiom compatibility:

1. Review native `FeatureVersions::all`, `ExtensionState::negotiate` and
   `sessions::initialize` in the owning axiom-desktop source. Read each changed
   feature's DTOs, handlers and generated v0.2 JSON Schema; a product version or
   a higher feature number alone does not establish compatibility.
2. Run the explicit native protocol qualification with the selected binary and
   isolated storage roots, nonproduction service origins and disabled Keychain
   UI. Initialization must create no conversation or inference request. Record
   the exact binary/product/source provenance and compare its public metadata.
3. Update the public fixture and supported-version policy independently. Update
   the relevant MCP/command/failure fixtures and refusal cases for changed wire
   behavior. Missing security evidence or unknown required versions stay denied.
4. Run the ordinary Axiom test files and the opt-in native qualification in the
   coordinator's normal validation phase. Update the provider guide and Axiom
   architecture instructions with the reviewed versions and limitations.

Default tests do not launch an installed provider, depend on a neighboring
checkout, read a Keychain or access real credentials. They establish compatibility
with the reviewed public snapshot, not with every future native build. The
opt-in `AxiomAcpCliProbe.e2e.test.ts` checks the actual selected native binary.
