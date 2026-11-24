import type * as AcpSchema from "effect-acp/schema";

/**
 * Independent public protocol fixture, reviewed 2026-11-16 against AxiomCLI
 * 0.1.22 / axiom-desktop dev 195479c. This is the installed native initialize
 * response captured with isolated XDG roots, --no-keychain-ui and a nonproduction
 * loopback service origin. No account, prompt, credential or provider inference
 * is involved. The runtime UUID is replaced with a synthetic identity.
 *
 * Keep this fixture independent of AXIOM_CLIENT_CAPABILITIES: deriving the peer's
 * advertisement from Cafe's requested versions would hide integration drift.
 * Source: crates/axiom-acp-extension/src/lib.rs::FeatureVersions::all and
 * apps/axiomcli/src/acp/sessions.rs::initialize. See axiom-contract/README.md.
 */
export const AXIOM_CURRENT_INITIALIZE_RESPONSE = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true, audio: false, embeddedContext: false },
    mcpCapabilities: { http: false, sse: false },
    sessionCapabilities: {},
    auth: {},
    _meta: {
      axiom: {
        protocolVersion: "0.2",
        features: {
          desktopChat: 1,
          desktopAgent: 1,
          desktopMcp: 2,
          localPayload: 2,
          threadCatalog: 1,
          timeline: 2,
          modelCatalog: 1,
          profilePreferences: 1,
          collections: 1,
          account: 2,
          billing: 7,
          usage: 1,
          securityEvidence: 4,
          webConsent: 1,
          // No image service exists at the isolated loopback fixture origin.
          imageGeneration: 0,
          imageResources: 2,
          steering: 1,
          messageRevision: 1,
          attachments: 2,
          compaction: 1,
          activity: 2,
          commandInvocation: 1,
        },
        runtimeInstanceId: "10000000-0000-4000-8000-000000000001",
      },
    },
  },
  authMethods: [],
  agentInfo: { name: "axiomcli", title: "AxiomCLI", version: "0.1.22" },
} satisfies AcpSchema.InitializeResponse;

/** The native CLI frontend withholds desktop MCP but keeps its other metadata.
 * A fresh copy prevents a scenario mutation from rewriting the shared baseline. */
export const axiomContractInitializeResponse = (
  runtimeInstanceId: string,
  frontend: "cli" | "desktop-chat" = "desktop-chat",
) => ({
  ...AXIOM_CURRENT_INITIALIZE_RESPONSE,
  agentCapabilities: {
    ...AXIOM_CURRENT_INITIALIZE_RESPONSE.agentCapabilities,
    _meta: {
      axiom: {
        ...AXIOM_CURRENT_INITIALIZE_RESPONSE.agentCapabilities._meta.axiom,
        runtimeInstanceId,
        features: {
          ...AXIOM_CURRENT_INITIALIZE_RESPONSE.agentCapabilities._meta.axiom.features,
          desktopMcp: frontend === "desktop-chat" ? 2 : 0,
        },
      },
    },
  },
});
