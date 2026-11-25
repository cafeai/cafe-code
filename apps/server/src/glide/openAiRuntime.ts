// Exact native runtime boundary; OpenAI owns the kernel and every desktop action.
// @effect-diagnostics nodeBuiltinImport:off
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { parseImageHeader } from "@cafecode/shared/rasterImageHeader";
import { OpenAiMcpChild } from "./mcpChild.ts";
import {
  validateOpenAiComputerInstallation,
  type OpenAiComputerInstallation,
} from "./openAiInstallation.ts";
import {
  GLIDE_IMAGE_BYTES,
  GLIDE_OUTPUT_BYTES,
  GLIDE_TIMEOUT_MS,
  jsInputSchema,
  type CellResult,
  type GlideOutput,
} from "./protocol.ts";

export interface GlideRuntimeAuthorization {
  readonly desktop?: boolean;
  readonly apps: readonly string[];
  readonly current: () => boolean;
}
export interface GlidePermissionActivity {
  readonly operation: number;
  readonly app: string;
  readonly appName: string;
  readonly method: string;
}
export interface GlideRuntimeAuthority {
  authorize(): Promise<GlideRuntimeAuthorization>;
  activity?(event: GlidePermissionActivity | undefined): Promise<void>;
}
export class GlideExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlideExecutionError";
  }
}
export function glideExecutionFailure(error: unknown): CellResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: error instanceof Error ? error.message.slice(0, 2048) : "Computer use failed.",
      },
    ],
  };
}

/** One cell at a time across Cafe chats. OpenAI sequences the actions inside it. */
export function makeGlideExecutionLane() {
  type Job = {
    run(): Promise<void>;
    reject(error: Error): void;
    signal: AbortSignal;
    abort(): void;
    running: boolean;
  };
  const jobs: Job[] = [];
  let held = false;
  const drain = async () => {
    if (held) return;
    held = true;
    try {
      while (jobs.length) {
        const job = jobs.shift()!;
        job.running = true;
        try {
          if (job.signal.aborted)
            throw new GlideExecutionError("Computer use was cancelled while queued.");
          await job.run();
        } catch (error) {
          job.reject(
            error instanceof Error ? error : new GlideExecutionError("Computer use failed."),
          );
        } finally {
          job.signal.removeEventListener("abort", job.abort);
        }
      }
    } finally {
      held = false;
    }
  };
  return <A>(execute: () => Promise<A>, signal: AbortSignal): Promise<A> => {
    if (jobs.length >= 32 || signal.aborted)
      return Promise.reject(new GlideExecutionError("Computer-use queue is unavailable."));
    return new Promise<A>((resolve, reject) => {
      const job: Job = {
        running: false,
        signal,
        reject,
        run: async () => resolve(await execute()),
        abort: () => {
          if (job.running) return;
          const index = jobs.indexOf(job);
          if (index >= 0) jobs.splice(index, 1);
          signal.removeEventListener("abort", job.abort);
          reject(new GlideExecutionError("Computer use was cancelled while queued."));
        },
      };
      signal.addEventListener("abort", job.abort, { once: true });
      jobs.push(job);
      if (signal.aborted) job.abort();
      void drain();
    });
  };
}

const appApproval = z.object({
  connector_id: z.literal("computer-use"),
  codex_approval_kind: z.literal("mcp_tool_call"),
  tool_call_id: z.string().min(1).max(128),
  tool_name: z.enum([
    "get_app_state",
    "click",
    "drag",
    "paste",
    "perform_secondary_action",
    "press_key",
    "scroll",
    "select_text",
    "set_value",
    "type_text",
  ]),
  tool_params: z.object({ app: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{1,254}$/) }).strict(),
  tool_params_display: z
    .array(z.object({ name: z.string(), value: z.string().max(1024) }))
    .max(16)
    .optional(),
});

export function boundedOpenAiResult(raw: { content: unknown[]; isError?: boolean }): CellResult {
  if (raw.content.length > 128) throw new Error("Computer-use output exceeded its limit.");
  let size = 0;
  const content: GlideOutput[] = raw.content.map((entry) => {
    const item = z.object({ type: z.string() }).passthrough().parse(entry);
    if (item.type === "text") {
      const text = z.string().parse(item.text);
      size += Buffer.byteLength(text);
      return { type: "text", text };
    }
    if (item.type !== "image") throw new Error("Unsupported computer-use output.");
    const mimeType = z.enum(["image/png", "image/jpeg", "image/webp"]).parse(item.mimeType);
    const data = z
      .string()
      .max(Math.ceil(GLIDE_IMAGE_BYTES / 3) * 4)
      .parse(item.data);
    const bytes = Buffer.from(data, "base64"),
      dimensions = parseImageHeader(bytes);
    // A bounded round trip validates padding/alphabet without a repeated-group
    // regexp that can exhaust the JS stack on a normal large screenshot.
    if (bytes.toString("base64") !== data) throw new Error("Invalid computer-use image.");
    if (
      bytes.length > GLIDE_IMAGE_BYTES ||
      !dimensions ||
      dimensions.mimeType !== mimeType ||
      dimensions.width > 16384 ||
      dimensions.height > 16384 ||
      dimensions.width * dimensions.height > 40_000_000
    )
      throw new Error("Computer-use image exceeded its limit.");
    size += data.length;
    return { type: "image", mimeType, data };
  });
  if (size > GLIDE_OUTPUT_BYTES) throw new Error("Computer-use output exceeded its limit.");
  return { content, ...(raw.isError === undefined ? {} : { isError: raw.isError }) };
}

interface Peer {
  readonly client: Client;
  readonly transport: OpenAiMcpChild;
  readonly root: string;
  turn?: string;
  closing?: Promise<void>;
}
interface Execution {
  readonly epoch: number;
  readonly deadline: number;
  readonly controller: AbortController;
  readonly turn: string;
  readonly call: string;
  permissions: number;
}

// Run the installed package's own environment builder in the installed Node,
// then replace that process with node_repl. execve preserves the single exact
// child/stdio owner; a launcher subprocess must not outlive a killed wrapper.
const openAiBootstrap = `
const { pathToFileURL } = await import("node:url");
const root = process.argv[1], executable = process.argv[2];
const packageRoot = root + "/lib/node_modules/@oai/cua-repl/";
const { create_launch_environment } = await import(pathToFileURL(packageRoot + "dist/lib/js/oai_js_cua_repl/src/environment.js").href);
const environment = create_launch_environment({ env: process.env, platform: process.platform, instructions_directory: pathToFileURL(packageRoot + "instructions/") });
if (typeof process.execve !== "function") throw new Error("The installed Node cannot own this runtime.");
process.execve(executable, [executable], environment);
`;
// OpenAI supplies [workingDirectory, codex, "sandbox", ...] to this hook.
// Preserve its exact command/policy/stdio and replace only this launch process.
const openAiWorkerBootstrap = `
const [expected, root, directory, command, ...args] = process.argv.slice(1);
if (command !== expected || args[0] !== "sandbox" || !directory.startsWith(root + "/")) throw new Error("Unsupported OpenAI worker launch.");
process.chdir(directory);
process.execve(command, [command, ...args], { ...process.env, NODE_OPTIONS: "--max-old-space-size=256 --max-semi-space-size=8" });
`;
interface GlideRuntimeOptions {
  installation: OpenAiComputerInstallation;
  authority: GlideRuntimeAuthority;
  sessionId?: string;
  turnId?: () => string | undefined;
  withLane?: <A>(execute: () => Promise<A>, signal: AbortSignal) => Promise<A>;
  /** Exact synthetic MCP peer for native protocol/close qualification only. */
  childFactory?: (environment: NodeJS.ProcessEnv, directory: string) => OpenAiMcpChild;
}
export class GlideRuntime {
  private readonly session: string;
  private epoch = 0;
  private sequence = 0;
  private queued = 0;
  private closed = false;
  private connection: Promise<Peer> | undefined;
  private current: Execution | undefined;
  private readonly controllers = new Set<AbortController>();
  private tail: Promise<unknown> = Promise.resolve();
  private retirement: Promise<void> = Promise.resolve();
  private turnRetirement: Promise<void> = Promise.resolve();
  private readonly options: GlideRuntimeOptions;
  constructor(options: GlideRuntimeOptions) {
    this.options = options;
    this.session = options.sessionId ?? randomUUID();
  }

  private live(execution: Execution) {
    return (
      !this.closed &&
      execution.epoch === this.epoch &&
      this.current === execution &&
      !execution.controller.signal.aborted &&
      performance.now() < execution.deadline
    );
  }
  private async connect(epoch: number): Promise<Peer> {
    await validateOpenAiComputerInstallation(this.options.installation);
    const root = await realpath(await mkdtemp(join(tmpdir(), "cafe-openai-computer-")));
    let transport: OpenAiMcpChild | undefined;
    try {
      if (this.closed || this.epoch !== epoch) throw new Error("Computer use was retired.");
      // This private, credential-free support home needs no plugin discovery
      // or background marketplace clones. The real provider profile is untouched.
      await writeFile(join(root, "config.toml"), "[features]\nplugins = false\n", {
        flag: "wx",
        mode: 0o600,
      });
      const installation = this.options.installation;
      const environment: NodeJS.ProcessEnv = {
        PATH: `${installation.runtimeRoot}/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
        HOME: process.env.HOME,
        CODEX_HOME: root,
        TMPDIR: root,
        CODEX_CLI_PATH: installation.codexPath,
        NODE_REPL_NODE_PATH: installation.nodePath,
        NODE_REPL_NODE_MODULE_DIRS: installation.moduleDirectory,
        NODE_REPL_TRUSTED_CODE_PATHS: installation.runtimeRoot,
        NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ sky: "@oai/sky/service" }),
        NODE_REPL_UNTRUSTED_ENV_ALLOWLIST: "CUA_REPL_ENABLED_SURFACES",
        NODE_REPL_JS_BANNER: 'await import("@oai/cua/tinyskyAlt");',
        CUA_REPL_ENABLED_SURFACES: "computer",
        SKY_CUA_SERVICE_PATH: installation.servicePath,
        NODE_OPTIONS: "--max-old-space-size=256 --max-semi-space-size=8",
        // The native host strips inherited NODE_OPTIONS from kernel children.
        // Its worker hook reapplies only this fixed ceiling before executing
        // the exact native sandbox command, with its original policy intact.
        NODE_REPL_WORKER_WRAPPER: JSON.stringify([
          installation.nodePath,
          "--max-old-space-size=256",
          "--max-semi-space-size=8",
          "--input-type=module",
          "--eval",
          openAiWorkerBootstrap,
          installation.codexPath,
          root,
        ]),
        NODE_REPL_DISABLE_ANALYTICS: "1",
        OTEL_SDK_DISABLED: "true",
      };
      transport =
        this.options.childFactory?.(environment, root) ??
        new OpenAiMcpChild({
          command: installation.nodePath,
          args: [
            "--input-type=module",
            "--eval",
            openAiBootstrap,
            installation.runtimeRoot,
            installation.replPath,
          ],
          cwd: root,
          env: environment,
        });
      const client = new Client(
        { name: "cafe-code-computer", version: "1.0.0" },
        { capabilities: { elicitation: { form: {} } } },
      );
      client.setRequestHandler(ElicitRequestSchema, async (request) => {
        const execution = this.current,
          metadata = appApproval.safeParse(request.params._meta);
        if (
          !execution ||
          !this.live(execution) ||
          !metadata.success ||
          metadata.data.tool_call_id !== execution.call ||
          (request.params.mode !== undefined && request.params.mode !== "form") ||
          ("requestedSchema" in request.params &&
            Object.keys(request.params.requestedSchema.properties).length > 0) ||
          ++execution.permissions > 256
        )
          return { action: "decline" };
        await validateOpenAiComputerInstallation(this.options.installation);
        const grant = await this.options.authority.authorize();
        const app = metadata.data.tool_params.app;
        if (
          !this.live(execution) ||
          !grant.current() ||
          (!grant.desktop && !grant.apps.includes(app))
        )
          return { action: "decline" };
        await this.options.authority.activity?.({
          operation: ++this.sequence,
          app,
          appName:
            metadata.data.tool_params_display
              ?.find((item) => item.name === "app")
              ?.value.slice(0, 128) ?? app,
          method: metadata.data.tool_name,
        });
        if (!this.live(execution) || !grant.current()) return { action: "decline" };
        // Only this individual app request is covered. Never save native rules,
        // select persistence or accept any user-input/audio/URL request.
        return { action: "accept" };
      });
      await client.connect(transport, { timeout: 10_000 });
      if (this.closed || epoch !== this.epoch) throw new Error("Computer use was retired.");
      const catalog = await client.listTools({}, { timeout: 5000 });
      if (
        !["js", "js_reset", "turn_ended"].every((name) =>
          catalog.tools.some((tool) => tool.name === name),
        )
      )
        throw new Error("Unsupported OpenAI computer-use catalogue.");
      return { client, transport, root };
    } catch {
      await transport?.close();
      await rm(root, { recursive: true, force: true });
      throw new GlideExecutionError("The installed OpenAI computer-use runtime could not start.");
    }
  }
  private async finishTurn(peer: Peer, turn: string) {
    if (peer.turn !== turn) return;
    // Reserve this exact hook before IO. Retirement must not send it again
    // after a partial failure or erase a newer turn on a delayed reply.
    delete peer.turn;
    const result = await peer.client.callTool(
      {
        name: "turn_ended",
        arguments: { hook_event_name: "Stop", session_id: this.session, turn_id: turn },
      },
      undefined,
      { timeout: 1000, maxTotalTimeout: 1000 },
    );
    if (result.isError) throw new Error("OpenAI turn cleanup was not confirmed.");
  }
  private closePeer(peer: Peer) {
    peer.closing ??= (async () => {
      if (peer.turn) await this.finishTurn(peer, peer.turn).catch(() => undefined);
      await peer.transport.close();
      await peer.client.close().catch(() => undefined);
      await rm(peer.root, { recursive: true, force: true });
    })();
    return peer.closing;
  }
  endTurn(turn: string): Promise<void> {
    const connection = this.connection,
      epoch = this.epoch;
    this.turnRetirement = this.turnRetirement.then(async () => {
      const peer = await connection;
      if (peer && this.epoch === epoch && peer.turn === turn) await this.finishTurn(peer, turn);
    });
    void this.turnRetirement.catch(() => undefined);
    return this.turnRetirement;
  }
  reset(): Promise<void> {
    this.epoch++;
    for (const controller of this.controllers) controller.abort();
    this.current = undefined;
    const connection = this.connection;
    this.connection = undefined;
    const turnRetirement = this.turnRetirement;
    this.turnRetirement = Promise.resolve();
    this.retirement = Promise.all([
      this.retirement,
      turnRetirement.catch(() => undefined),
      connection?.then(
        (peer) => this.closePeer(peer),
        () => undefined,
      ),
    ]).then(() => undefined);
    void this.retirement.catch(() => undefined);
    return this.retirement;
  }
  async execute(input: z.input<typeof jsInputSchema>, signal?: AbortSignal): Promise<CellResult> {
    const parsed = jsInputSchema.parse(input);
    if (this.closed || this.queued >= 8)
      throw new GlideExecutionError("Computer-use queue is full or closed.");
    const epoch = this.epoch,
      deadline = performance.now() + (parsed.timeout_ms ?? GLIDE_TIMEOUT_MS);
    const controller = new AbortController(),
      expiry = Promise.withResolvers<never>();
    let expired = false;
    this.controllers.add(controller);
    void expiry.promise.catch(() => undefined);
    const expire = () => {
      if (expired) return;
      expired = true;
      controller.abort();
      if (this.current?.controller === controller) void this.reset();
      expiry.reject(
        new GlideExecutionError(
          "Computer use stopped or timed out. Already-dispatched input may have taken effect; inspect fresh state before continuing.",
        ),
      );
    };
    // Queue time consumes the same nonrenewable native execution deadline.
    // @effect-diagnostics-next-line globalTimers:off
    const timer = setTimeout(expire, Math.max(1, deadline - performance.now()));
    signal?.addEventListener("abort", expire, { once: true });
    this.queued++;
    const run = async () => {
      await this.retirement;
      await this.turnRetirement;
      if (
        expired ||
        signal?.aborted ||
        this.closed ||
        this.epoch !== epoch ||
        performance.now() >= deadline
      )
        throw new GlideExecutionError("Computer use was cancelled before execution.");
      const grant = await this.options.authority.authorize();
      if (!grant.current() || expired || this.epoch !== epoch)
        throw new GlideExecutionError("This chat's computer-use permission expired.");
      const execution: Execution = {
        epoch,
        deadline,
        controller,
        permissions: 0,
        turn: this.options.turnId?.() ?? randomUUID(),
        call: randomUUID(),
      };
      this.current = execution;
      try {
        const peer = await (this.connection ??= this.connect(epoch));
        await validateOpenAiComputerInstallation(this.options.installation);
        if (!this.live(execution) || !grant.current()) throw new Error("Computer use was retired.");
        peer.turn = execution.turn;
        const remaining = Math.max(1, deadline - performance.now());
        const result = await peer.client.callTool(
          {
            name: "js",
            arguments: parsed,
            _meta: {
              "x-codex-turn-metadata": {
                thread_id: this.session,
                turn_id: execution.turn,
                call_id: execution.call,
              },
            },
          },
          undefined,
          { signal: controller.signal, timeout: remaining, maxTotalTimeout: remaining },
        );
        if (!this.live(execution) || !grant.current()) throw new Error("Computer use was retired.");
        return boundedOpenAiResult(result as { content: unknown[]; isError?: boolean });
      } catch {
        if (this.epoch === epoch) await this.reset();
        throw new GlideExecutionError(
          "OpenAI computer use was interrupted. Earlier actions may have taken effect; inspect fresh state before continuing.",
        );
      } finally {
        if (this.current === execution) this.current = undefined;
        await this.options.authority.activity?.(undefined);
      }
    };
    const operation = this.tail.then(() =>
      this.options.withLane ? this.options.withLane(run, controller.signal) : run(),
    );
    this.tail = operation
      .catch(() => undefined)
      .finally(() => {
        this.queued--;
        this.controllers.delete(controller);
      });
    try {
      if (signal?.aborted) expire();
      return await Promise.race([operation, expiry.promise]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", expire);
    }
  }
  async close() {
    this.closed = true;
    await this.reset();
    await this.tail;
  }
}
