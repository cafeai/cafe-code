import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  AxiomSettings,
  ProviderAttestationEvidence,
  ProviderAttestationStatus,
  ProviderInstanceEnvironment,
  type ModelSelection,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as AcpClient from "effect-acp/client";
import * as AcpErrors from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";
import { make as makeSessionRuntime, type AcpSessionRuntimeOptions } from "./AcpSessionRuntime.ts";

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const Count = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
export type AxiomFrontend = "cli" | "desktop-chat";
const NativePath = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(8192),
  Schema.isPattern(/^[^\0]+$/),
);
export const AxiomDesktopBootstrap = Schema.Struct({
  frontend: Schema.Literal("desktop-chat"),
  chatCwd: NativePath,
  permissionProfile: Schema.Literal("web"),
});
export const AxiomDesktopAgent = Schema.Struct({
  enabled: Schema.Boolean,
  permission: Schema.Literals(["approve_commands", "full_access"]),
  workingDirectory: NativePath,
  defaultWorkingDirectory: NativePath,
  usesDefaultDirectory: Schema.Boolean,
  revision: Count,
});
const DesktopThread = Schema.Struct({ threadId: Text, cwd: NativePath });
export const AxiomDesktopThread = Schema.Struct({
  thread: DesktopThread,
  desktopAgent: AxiomDesktopAgent,
});
const DesktopConfigured = Schema.Struct({ thread: DesktopThread, agent: AxiomDesktopAgent });
export const AxiomExtension = Schema.Struct({
  protocolVersion: Text,
  runtimeInstanceId: Schema.String.check(Schema.isUUID()),
  features: Schema.Record(Schema.String, Count),
});
export const AxiomAccount = Schema.Struct({
  status: Schema.Struct({
    revision: Count,
    state: Schema.Literals(["starting", "signed_out", "valid", "expired", "unavailable"]),
    account: Schema.optional(Schema.Struct({ id: Text, displayName: Schema.optional(Text) })),
  }),
});
export const AxiomModels = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      id: Text,
      label: Text,
      shortLabel: Text,
      providerId: Text,
      providerLabel: Text,
      upstreamModel: Text,
      thinkingLevels: Schema.Array(Text).check(Schema.isMaxLength(32)),
      contextWindowTokens: Count,
      maxOutputTokens: Count,
      autoCompactThresholdTokens: Count,
      supportsImages: Schema.Boolean,
      fileMimeTypes: Schema.Array(Text).check(Schema.isMaxLength(128)),
    }),
  ).check(Schema.isMaxLength(2048)),
});
export type AxiomModel = (typeof AxiomModels.Type.models)[number];
export const AxiomBilling = Schema.Struct({
  status: Schema.Struct({
    availableMicrousd: Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(-Number.MAX_SAFE_INTEGER),
      Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
    ),
    currency: Schema.Literal("USD"),
  }),
});
/** Preserve the native integer microUSD balance without floating-point rounding. */
export const axiomCreditBalance = (microusd: number) => {
  const amount = BigInt(microusd);
  const positive = amount < 0n ? -amount : amount;
  return (
    (amount < 0n ? "-" : "") +
    String(positive / 1000000n) +
    "." +
    String(positive % 1000000n).padStart(6, "0")
  );
};
export const AxiomVerification = Schema.Struct({
  status: ProviderAttestationStatus,
  evidence: Schema.NullOr(ProviderAttestationEvidence),
});

/** Feature versions are taken from the reviewed AxiomCLI 0.1.13 DTOs, not
 * from the independently versioned ACP runtime package. Unknown features do
 * not authorize calls. Desktop bootstrap/Agent is required for new chats;
 * Desktop MCP uses its own revision fence and explicit per-thread selection. */
export const AXIOM_CLIENT_CAPABILITIES = {
  elicitation: { form: {} },
  _meta: {
    axiom: {
      protocolVersion: "0.2",
      features: {
        desktopChat: 1,
        desktopAgent: 1,
        desktopMcp: 1,
        webConsent: 1,
        account: 2,
        modelCatalog: 1,
        securityEvidence: 4,
        activity: 1,
        timeline: 2,
        threadCatalog: 1,
        attachments: 2,
        steering: 1,
        compaction: 1,
        billing: 4,
      },
    },
  },
} satisfies AcpSchema.InitializeRequest["clientCapabilities"];
export const AXIOM_CLI_CLIENT_CAPABILITIES = {
  ...AXIOM_CLIENT_CAPABILITIES,
  _meta: {
    axiom: {
      ...AXIOM_CLIENT_CAPABILITIES._meta.axiom,
      features: {
        ...AXIOM_CLIENT_CAPABILITIES._meta.axiom.features,
        desktopChat: 0,
        desktopAgent: 0,
        desktopMcp: 0,
        webConsent: 0,
      },
    },
  },
} satisfies AcpSchema.InitializeRequest["clientCapabilities"];

export const decodeAxiom = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  value: unknown,
) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() =>
      AcpErrors.AcpRequestError.invalidParams(
        "Axiom returned an invalid public protocol response.",
      ),
    ),
  );

export function negotiateAxiom(
  result: AcpSchema.InitializeResponse,
  frontend: AxiomFrontend = "desktop-chat",
) {
  return Effect.gen(function* () {
    const extension = yield* decodeAxiom(AxiomExtension, result.agentCapabilities?._meta?.axiom);
    if (
      result.protocolVersion !== 1 ||
      extension.protocolVersion.split(".")[0] !== "0" ||
      Object.entries({
        ...(frontend === "desktop-chat"
          ? { desktopChat: 1, desktopAgent: 1, desktopMcp: 1, webConsent: 1 }
          : {}),
        account: 2,
        modelCatalog: 1,
        securityEvidence: 4,
        activity: 1,
        timeline: 2,
        attachments: 2,
        steering: 1,
        compaction: 1,
        threadCatalog: 1,
      }).some(([name, version]) => extension.features[name] !== version)
    ) {
      return yield* AcpErrors.AcpRequestError.invalidParams(
        "Update AxiomCLI to a compatible ACP and security-evidence contract.",
      );
    }
    return extension;
  });
}

const decodeAxiomSettings = Schema.decodeUnknownSync(AxiomSettings);
const decodeEnvironment = Schema.decodeUnknownSync(ProviderInstanceEnvironment);
export const axiomConfigurationKey = (config: unknown, environment: unknown = []) => {
  const settings = decodeAxiomSettings(config);
  const pairs = new Map(
    decodeEnvironment(environment).map(({ name, value }) => [name, value] as const),
  );
  return createHash("sha256")
    .update(
      JSON.stringify([
        settings.binaryPath,
        "desktop-chat-v2",
        [...pairs].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ]),
    )
    .digest("hex");
};
export const axiomAccountKey = (id: string) => createHash("sha256").update(id).digest("hex");
export const axiomSpawnInput = (
  settings: AxiomSettings,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  frontend: AxiomFrontend = "desktop-chat",
) => ({
  command: settings.binaryPath || "axiomcli",
  args: ["acp", "--frontend", frontend],
  cwd,
  ...(environment ? { env: environment } : {}),
});

/** Control-only connection never creates history or runs a prompt. Its scope
 * owns the exact child; stderr is drained and discarded, never diagnostics. */
export const makeAxiomControl = (
  settings: AxiomSettings,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const spawn = axiomSpawnInput(settings, cwd, environment);
    const child = yield* spawner
      .spawn(
        ChildProcess.make(spawn.command, spawn.args, {
          cwd,
          shell: false,
          ...(environment ? { env: environment, extendEnv: true } : {}),
        }),
      )
      .pipe(Effect.mapError((cause) => new AcpErrors.AcpSpawnError({ cause })));
    yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped());
    const context = yield* Layer.build(AcpClient.layerChildProcess(child));
    const client = yield* Effect.service(AcpClient.AcpClient).pipe(Effect.provide(context));
    const initialized = yield* client.agent.initialize({
      protocolVersion: 1,
      clientInfo: { name: "cafe-code", version: "0.2.0" },
      clientCapabilities: AXIOM_CLIENT_CAPABILITIES,
    });
    const extension = yield* negotiateAxiom(initialized);
    return { client, initialized, extension };
  });

export interface AxiomSessionIdentity {
  runtimeId: string;
  accountKey: string;
  frontend: AxiomFrontend;
}
export const makeAxiomRuntime = (
  settings: AxiomSettings,
  options: Omit<
    AcpSessionRuntimeOptions,
    | "spawn"
    | "clientInfo"
    | "clientCapabilities"
    | "authMethodId"
    | "beforeSession"
    | "resolveSessionCwd"
  > & { readonly frontend?: AxiomFrontend; readonly nativeResumeCwd?: string },
  identity: (value: AxiomSessionIdentity) => void,
  environment?: NodeJS.ProcessEnv,
  expectedAccountKey?: string,
) => {
  const frontend = options.frontend ?? "desktop-chat";
  let sessionCwd = options.nativeResumeCwd ?? options.cwd;
  return makeSessionRuntime({
    ...options,
    cancelPromptLocally: false,
    spawn: axiomSpawnInput(settings, options.cwd, environment, frontend),
    clientInfo: { name: "cafe-code", version: "0.2.0" },
    clientCapabilities:
      frontend === "desktop-chat" ? AXIOM_CLIENT_CAPABILITIES : AXIOM_CLI_CLIENT_CAPABILITIES,
    resolveSessionCwd: () => Effect.succeed(sessionCwd),
    // Axiom's initialize response intentionally offers no standard auth method.
    // Admission instead requires its negotiated native account status before
    // loading any history. Existing ACP drivers retain their explicit auth call.
    authMethodId: () => Effect.succeed(undefined),
    beforeSession: (initialized, request) =>
      Effect.gen(function* () {
        const extension = yield* negotiateAxiom(initialized, frontend);
        const { status } = yield* request("_axiom/account/status", {}).pipe(
          Effect.flatMap((value) => decodeAxiom(AxiomAccount, value)),
        );
        if (status.state !== "valid" || !status.account)
          return yield* AcpErrors.AcpRequestError.authRequired(
            "Sign in to Axiom before starting a conversation.",
          );
        const accountKey = axiomAccountKey(status.account.id);
        if (expectedAccountKey !== undefined && expectedAccountKey !== accountKey)
          return yield* AcpErrors.AcpRequestError.authRequired(
            "This conversation belongs to another Axiom account.",
          );
        if (frontend === "desktop-chat") {
          const bootstrap = yield* request("_axiom/desktop/bootstrap", {}).pipe(
            Effect.flatMap((value) => decodeAxiom(AxiomDesktopBootstrap, value)),
          );
          if (!isAbsolute(bootstrap.chatCwd))
            return yield* AcpErrors.AcpRequestError.invalidParams(
              "Axiom returned an invalid desktop workspace.",
            );
          if (!options.resumeSessionId) sessionCwd = bootstrap.chatCwd;
          else if (!options.nativeResumeCwd || !isAbsolute(options.nativeResumeCwd))
            return yield* AcpErrors.AcpRequestError.invalidParams(
              "The saved Axiom desktop workspace is invalid.",
            );
        }
        identity({ runtimeId: extension.runtimeInstanceId, accountKey, frontend });
      }),
  });
};

/** Bind only this native thread to Cafe's admitted tool workspace. Native
 * configuration revisions protect both prompts and later policy changes. */
export const configureAxiomDesktopSession = (
  runtime: {
    request: (method: string, payload: unknown) => Effect.Effect<unknown, AcpErrors.AcpError>;
  },
  sessionId: string,
  input: {
    readonly cwd: string;
    readonly enabled: boolean;
    readonly permission: "approve_commands" | "full_access";
    readonly expectedRevision?: number;
  },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const canonical = yield* fs
      .realPath(input.cwd)
      .pipe(
        Effect.mapError(() =>
          AcpErrors.AcpRequestError.invalidParams("Cafe's Axiom workspace is unavailable."),
        ),
      );
    const current = yield* runtime
      .request("_axiom/thread/timeline", { threadId: sessionId, afterSequence: 0, limit: 1 })
      .pipe(Effect.flatMap((value) => decodeAxiom(AxiomDesktopThread, value)));
    if (
      current.thread.threadId !== sessionId ||
      current.thread.cwd !== current.desktopAgent.workingDirectory ||
      (input.expectedRevision !== undefined &&
        current.desktopAgent.revision !== input.expectedRevision)
    )
      return yield* AcpErrors.AcpRequestError.invalidParams(
        "The owned Axiom Agent configuration changed. Re-establish the conversation before sending.",
      );
    const currentCanonical = yield* fs
      .realPath(current.desktopAgent.workingDirectory)
      .pipe(
        Effect.mapError(() =>
          AcpErrors.AcpRequestError.invalidParams("The native Axiom workspace is unavailable."),
        ),
      );
    if (input.expectedRevision !== undefined && currentCanonical !== canonical)
      return yield* AcpErrors.AcpRequestError.invalidParams(
        "The native Axiom workspace no longer matches Cafe's conversation.",
      );
    if (
      currentCanonical === canonical &&
      current.desktopAgent.enabled === input.enabled &&
      current.desktopAgent.permission === input.permission
    )
      return current.desktopAgent;
    const result = yield* runtime
      .request("_axiom/desktop/agent/configure", {
        threadId: sessionId,
        expectedRevision: current.desktopAgent.revision,
        enabled: input.enabled,
        permission: input.permission,
        workingDirectory: canonical,
      })
      .pipe(Effect.flatMap((value) => decodeAxiom(DesktopConfigured, value)));
    const resolved = yield* fs
      .realPath(result.agent.workingDirectory)
      .pipe(
        Effect.mapError(() =>
          AcpErrors.AcpRequestError.invalidParams("The configured Axiom workspace is unavailable."),
        ),
      );
    if (
      result.thread.threadId !== sessionId ||
      result.thread.cwd !== result.agent.workingDirectory ||
      resolved !== canonical ||
      result.agent.enabled !== input.enabled ||
      result.agent.permission !== input.permission ||
      result.agent.revision !== current.desktopAgent.revision + 1
    )
      return yield* AcpErrors.AcpRequestError.invalidParams(
        "Axiom did not confirm the exact requested workspace and Agent policy.",
      );
    return result.agent;
  });

export const applyAxiomSelection = (
  runtime: {
    setModel: (model: string) => Effect.Effect<void, AcpErrors.AcpError>;
    setConfigOption: (
      id: string,
      value: string | boolean,
    ) => Effect.Effect<unknown, AcpErrors.AcpError>;
  },
  selection?: ModelSelection,
) =>
  Effect.gen(function* () {
    if (selection?.model) yield* runtime.setModel(selection.model);
    const thinking = selection?.options?.find((option) => option.id === "thinkingLevel")?.value;
    if (typeof thinking === "string") yield* runtime.setConfigOption("thinking", thinking);
  });

/** Contract validation is separate from the native cryptographic verifier.
 * Preserve provider-specific scope and the one explicitly consented TDX
 * OutOfDate failure. Every other failed check makes a report inadmissible. */
export function validateAxiomEvidence(
  value: typeof AxiomVerification.Type,
  modelId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  const evidence = value.evidence;
  if (value.status.state !== "verified" && value.status.state !== "degraded") return null;
  const tinfoil =
    evidence?.providerId === "tinfoil" &&
    evidence.attestationProtocol === "tinfoil-snp-sigstore-v1" &&
    evidence.e2eeProtocol === "tinfoil-ehbp-v1" &&
    evidence.e2eeEncryptionVersion === 1;
  const near =
    evidence?.providerId === "near" &&
    evidence.attestationProtocol === "near-tdx-nvidia-v2" &&
    evidence.e2eeProtocol === "near-v3" &&
    evidence.e2eeEncryptionVersion === 2;
  const degraded = value.status.state === "degraded";
  if (
    !evidence ||
    (!tinfoil && !near) ||
    evidence.modelId !== modelId ||
    evidence.status.state !== value.status.state ||
    evidence.verifiedAtUnixSeconds > nowSeconds + 60 ||
    evidence.hardExpiresAtUnixSeconds <= nowSeconds ||
    evidence.hardExpiresAtUnixSeconds <= evidence.verifiedAtUnixSeconds ||
    (near && !evidence.attestationGeneration) ||
    (degraded &&
      (!near ||
        !evidence.checks.some(
          (check) => check.name === "Intel TDX" && check.detail === "OutOfDate" && !check.passed,
        ))) ||
    (evidence.workloadManifest != null &&
      new TextEncoder().encode(evidence.workloadManifest).byteLength > 1024 * 1024) ||
    evidence.checks.some((check) => new TextEncoder().encode(check.detail).byteLength > 8192) ||
    evidence.providerClaims.some(
      (claim) => new TextEncoder().encode(claim.value).byteLength > 8192,
    ) ||
    evidence.checks.some(
      (check) =>
        !check.passed && !(degraded && check.name === "Intel TDX" && check.detail === "OutOfDate"),
    )
  ) {
    throw new Error(
      "Axiom verification evidence does not match the admitted model and provider contract.",
    );
  }
  return evidence;
}
