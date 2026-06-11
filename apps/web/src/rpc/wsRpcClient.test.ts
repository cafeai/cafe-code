import type {
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusStreamEvent,
} from "@cafecode/contracts";
import { ORCHESTRATION_WS_METHODS } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";

vi.mock("./wsTransport", () => ({
  WsTransport: class WsTransport {
    dispose = vi.fn(async () => undefined);
    reconnect = vi.fn(async () => undefined);
    request = vi.fn();
    requestStream = vi.fn();
    subscribe = vi.fn(() => () => undefined);
  },
}));

import { createWsRpcClient } from "./wsRpcClient";
import type { WsRpcProtocolClient } from "./protocol";
import { type WsTransport } from "./wsTransport";

const baseLocalStatus: VcsStatusLocalResult = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/demo",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
};

const baseRemoteStatus: VcsStatusRemoteResult = {
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

describe("wsRpcClient", () => {
  it("routes provider journal repair requests through the orchestration RPC method", async () => {
    const rpcMethod = vi.fn(() =>
      Effect.succeed({
        status: "source-not-found" as const,
        threadId: "thread-1" as never,
        messageId: "assistant:item-1" as never,
      }),
    );
    const requestMock = vi.fn(
      async <TSuccess>(
        execute: (client: WsRpcProtocolClient) => Effect.Effect<TSuccess, Error, never>,
      ) =>
        Effect.runPromise(
          execute({
            [ORCHESTRATION_WS_METHODS.repairAssistantMessageFromProviderJournal]: rpcMethod,
          } as unknown as WsRpcProtocolClient),
        ),
    );
    const transport = {
      dispose: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      request: requestMock as unknown as WsTransport["request"],
      requestStream: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    } satisfies Pick<
      WsTransport,
      "dispose" | "reconnect" | "request" | "requestStream" | "subscribe"
    >;

    const client = createWsRpcClient(transport as unknown as WsTransport);
    await client.orchestration.repairAssistantMessageFromProviderJournal({
      threadId: "thread-1" as never,
      messageId: "assistant:item-1" as never,
    });

    expect(requestMock).toHaveBeenCalledOnce();
    expect(rpcMethod).toHaveBeenCalledWith({
      threadId: "thread-1",
      messageId: "assistant:item-1",
    });
  });

  it("routes thread assistant repair requests through the orchestration RPC method", async () => {
    const rpcMethod = vi.fn(() =>
      Effect.succeed({
        threadId: "thread-1" as never,
        sourcePolicy: "local-then-upstream" as const,
        counts: {
          totalMessages: 0,
          eligibleMessages: 0,
          localAttempts: 0,
          upstreamAttempts: 0,
          repaired: 0,
          unchanged: 0,
          notEligible: 0,
          sourceNotFound: 0,
          ambiguousSource: 0,
          diverged: 0,
          upstreamUnavailable: 0,
          failed: 0,
        },
        results: [],
      }),
    );
    const requestMock = vi.fn(
      async <TSuccess>(
        execute: (client: WsRpcProtocolClient) => Effect.Effect<TSuccess, Error, never>,
      ) =>
        Effect.runPromise(
          execute({
            [ORCHESTRATION_WS_METHODS.repairThreadAssistantMessages]: rpcMethod,
          } as unknown as WsRpcProtocolClient),
        ),
    );
    const transport = {
      dispose: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      request: requestMock as unknown as WsTransport["request"],
      requestStream: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    } satisfies Pick<
      WsTransport,
      "dispose" | "reconnect" | "request" | "requestStream" | "subscribe"
    >;

    const client = createWsRpcClient(transport as unknown as WsTransport);
    await client.orchestration.repairThreadAssistantMessages({
      threadId: "thread-1" as never,
      sourcePolicy: "local-then-upstream",
    });

    expect(requestMock).toHaveBeenCalledOnce();
    expect(rpcMethod).toHaveBeenCalledWith({
      threadId: "thread-1",
      sourcePolicy: "local-then-upstream",
    });
  });

  it("reduces vcs status stream events into flat status snapshots", () => {
    const subscribe = vi.fn(<TValue>(_connect: unknown, listener: (value: TValue) => void) => {
      for (const event of [
        {
          _tag: "snapshot",
          local: baseLocalStatus,
          remote: null,
        },
        {
          _tag: "remoteUpdated",
          remote: baseRemoteStatus,
        },
        {
          _tag: "localUpdated",
          local: {
            ...baseLocalStatus,
            hasWorkingTreeChanges: true,
          },
        },
      ] satisfies VcsStatusStreamEvent[]) {
        listener(event as TValue);
      }
      return () => undefined;
    });

    const transport = {
      dispose: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      request: vi.fn(),
      requestStream: vi.fn(),
      subscribe,
    } satisfies Pick<
      WsTransport,
      "dispose" | "reconnect" | "request" | "requestStream" | "subscribe"
    >;

    const client = createWsRpcClient(transport as unknown as WsTransport);
    const listener = vi.fn();

    client.vcs.onStatus({ cwd: "/repo" }, listener);

    expect(listener.mock.calls).toEqual([
      [
        {
          ...baseLocalStatus,
          hasUpstream: false,
          aheadCount: 0,
          behindCount: 0,
          aheadOfDefaultCount: 0,
          pr: null,
        },
      ],
      [
        {
          ...baseLocalStatus,
          ...baseRemoteStatus,
        },
      ],
      [
        {
          ...baseLocalStatus,
          ...baseRemoteStatus,
          hasWorkingTreeChanges: true,
        },
      ],
    ]);
  });
});
