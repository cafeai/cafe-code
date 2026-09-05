import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DictationRealtimeClientSecret,
  DictationTranscriptionModel,
} from "@cafecode/contracts";

import { __dictationDiagnosticsTestApi, getDictationDiagnosticSnapshot } from "./diagnostics";

import {
  createRealtimeTranscriptState,
  decodeRealtimeServerEvent,
  formatComposerDictationInsertion,
  OPENAI_REALTIME_CALLS_URL,
  RealtimeTranscriptionError,
  reduceRealtimeTranscript,
  selectRealtimeTranscript,
  startRealtimeTranscription,
} from "./realtimeTranscription";

class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = "connecting";
  readonly sent: string[] = [];
  readonly closeMock = vi.fn();

  open(): void {
    this.readyState = "open";
    this.dispatchEvent(new Event("open"));
  }

  emitServerEvent(event: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeMock();
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
}

class FakePeerConnection extends EventTarget {
  readonly offerSdp: string;
  readonly finalizedOfferSdp: string;
  connectionState: RTCPeerConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "new";
  localDescription: RTCSessionDescription | null = null;
  autoCompleteIceGathering = true;
  readonly channel = new FakeDataChannel();
  readonly addTrackMock = vi.fn();
  readonly closeMock = vi.fn();
  readonly createDataChannelMock = vi.fn((label: string) => {
    expect(label).toBe("oai-events");
    return this.channel as unknown as RTCDataChannel;
  });
  readonly setLocalDescriptionMock = vi.fn(
    async (_description: RTCSessionDescriptionInit) => undefined,
  );
  readonly setRemoteDescriptionMock = vi.fn(async (_description: RTCSessionDescriptionInit) => {
    this.connectionState = "connected";
    this.channel.open();
  });

  constructor(attempt = 1) {
    super();
    this.offerSdp =
      attempt === 1 ? "v=0\r\nt=test-offer\r\n" : `v=0\r\nt=test-offer-${attempt}\r\n`;
    this.finalizedOfferSdp = `${this.offerSdp}a=candidate:${attempt} 1 udp 1 127.0.0.1 9 typ host\r\n`;
  }

  createDataChannel(label: string): RTCDataChannel {
    return this.createDataChannelMock(label);
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: this.offerSdp };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    await this.setLocalDescriptionMock(description);
    this.localDescription = {
      type: "offer",
      sdp: description.sdp ?? "",
      toJSON: () => ({ type: "offer", sdp: description.sdp ?? "" }),
    } as RTCSessionDescription;
    this.iceGatheringState = "gathering";
    if (this.autoCompleteIceGathering) this.finishIceGathering();
  }

  finishIceGathering(): void {
    this.localDescription = {
      type: "offer",
      sdp: this.finalizedOfferSdp,
      toJSON: () => ({ type: "offer", sdp: this.finalizedOfferSdp }),
    } as RTCSessionDescription;
    this.iceGatheringState = "complete";
    this.dispatchEvent(new Event("icegatheringstatechange"));
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    await this.setRemoteDescriptionMock(description);
  }

  addTrack(track: MediaStreamTrack, ...streams: MediaStream[]): RTCRtpSender {
    this.addTrackMock(track, ...streams);
    return {} as RTCRtpSender;
  }

  close(): void {
    this.closeMock();
    this.connectionState = "closed";
  }
}

function makeMediaFixture() {
  const stop = vi.fn();
  const track = { enabled: true, stop } as unknown as MediaStreamTrack;
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  return { stop, stream, track };
}

function createTestDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function makeDependencies(input?: {
  readonly response?: Response;
  readonly responses?: readonly Response[];
}) {
  const peer = new FakePeerConnection();
  const peers = [peer];
  let peerCreationCount = 0;
  const media = makeMediaFixture();
  const getUserMedia = vi.fn(async () => media.stream);
  const queuedResponses = [...(input?.responses ?? [])];
  const fetchMock = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) => {
    const queued = queuedResponses.shift();
    return queued ?? input?.response ?? new Response("v=0\r\nt=test-answer\r\n");
  });
  const waitForRetry = vi.fn(async (_delayMs: number, _signal: AbortSignal) => undefined);
  const dependencies: NonNullable<Parameters<typeof startRealtimeTranscription>[1]> = {
    createPeerConnection: () => {
      peerCreationCount += 1;
      if (peerCreationCount === 1) return peer as unknown as RTCPeerConnection;
      const nextPeer = new FakePeerConnection(peerCreationCount);
      peers.push(nextPeer);
      return nextPeer as unknown as RTCPeerConnection;
    },
    fetch: fetchMock as typeof fetch,
    getUserMedia,
    now: () => 1_000_000,
    waitForRetry,
    setTimeout: (callback, delayMs) =>
      globalThis.setTimeout(callback, delayMs) as unknown as number,
    clearTimeout: (timerId) => globalThis.clearTimeout(timerId),
  };
  return {
    dependencies,
    fetchMock,
    getUserMedia,
    media,
    peer,
    peers,
    waitForRetry,
  };
}

const validClientSecret = {
  clientSecret: "ephemeral-test-secret",
  expiresAt: 2_000,
  model: "gpt-live-transcribe" as const,
  sessionProfile: "transcription_pcm24k_minimal_v1" as const,
  clientSecretRequestId: "req_mint_test",
  clientSecretRequestDurationMs: 42,
  clientSecretOpenAiProcessingMs: 12,
  clientSecretEffectiveProfile: "matches" as const,
};

afterEach(() => {
  __dictationDiagnosticsTestApi.reset();
});

describe("Realtime transcript reconciliation", () => {
  it("streams deltas in first-seen item order and replaces each item with its authoritative final", () => {
    let state = createRealtimeTranscriptState();
    state = reduceRealtimeTranscript(state, {
      type: "conversation.item.input_audio_transcription.delta",
      itemId: "item-a",
      delta: "Helo",
    });
    state = reduceRealtimeTranscript(state, {
      type: "conversation.item.input_audio_transcription.delta",
      itemId: "item-b",
      delta: "world",
    });
    expect(selectRealtimeTranscript(state)).toBe("Helo world");

    // Completion order may differ from speech order. item_id reconciliation
    // keeps item-a first and replaces only its misspelled interim text.
    state = reduceRealtimeTranscript(state, {
      type: "conversation.item.input_audio_transcription.completed",
      itemId: "item-b",
      transcript: "world!",
    });
    state = reduceRealtimeTranscript(state, {
      type: "conversation.item.input_audio_transcription.completed",
      itemId: "item-a",
      transcript: "Hello",
    });
    expect(selectRealtimeTranscript(state)).toBe("Hello world!");
  });

  it("owns only the transcript and required boundary whitespace", () => {
    expect(formatComposerDictationInsertion("beforeafter", 6, "inserted")).toBe(" inserted ");
    expect(formatComposerDictationInsertion("before after", 7, "inserted ")).toBe("inserted ");
    expect(formatComposerDictationInsertion("unchanged", 4, "")).toBe("");
  });

  it("rejects malformed allowlisted events without exposing arbitrary payload fields", () => {
    expect(() =>
      decodeRealtimeServerEvent(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.delta",
          item_id: "bad\u0000item",
          delta: "ignored",
        }),
      ),
    ).toThrow(RealtimeTranscriptionError);
    expect(
      decodeRealtimeServerEvent(JSON.stringify({ type: "session.updated", secret: "x" })),
    ).toBeNull();
  });
});

describe("startRealtimeTranscription", () => {
  it("preserves a sanitized client-secret rejection before requesting microphone access", async () => {
    const fixture = makeDependencies();
    const order: string[] = [];
    const leakedDetail = "sk-secret-provider-detail-that-must-not-surface";
    const getClientSecret = vi.fn(async () => {
      order.push("credential");
      throw {
        code: "upstream_auth_failed",
        message: leakedDetail,
        cause: { credential: leakedDetail },
      };
    });
    fixture.getUserMedia.mockImplementation(async () => {
      order.push("microphone");
      return fixture.media.stream;
    });

    const rejected = expect(
      startRealtimeTranscription(
        { getClientSecret, onTranscript: () => undefined },
        fixture.dependencies,
      ),
    ).rejects;
    await rejected.toMatchObject({
      code: "upstream_auth_failed",
      message:
        "OpenAI rejected the saved dictation credential or its Realtime transcription access.",
    });
    await rejected.not.toMatchObject({ message: leakedDetail });
    expect(order).toEqual(["credential"]);
    expect(fixture.getUserMedia).not.toHaveBeenCalled();
    expect(fixture.fetchMock).not.toHaveBeenCalled();
  });

  it("sanitizes an unknown client-secret transport failure", async () => {
    const fixture = makeDependencies();
    const leakedDetail = "unsafe-rpc-detail";

    await expect(
      startRealtimeTranscription(
        {
          getClientSecret: async () => {
            throw { code: "future_unknown_code", message: leakedDetail };
          },
          onTranscript: () => undefined,
        },
        fixture.dependencies,
      ),
    ).rejects.toMatchObject({
      code: "session_setup_failed",
      message: "Cafe could not start dictation.",
    });
    expect(fixture.getUserMedia).not.toHaveBeenCalled();
    expect(fixture.fetchMock).not.toHaveBeenCalled();
  });

  it("does not mint a credential or touch media for an already-aborted owner", async () => {
    const fixture = makeDependencies();
    const controller = new AbortController();
    const getClientSecret = vi.fn(async () => validClientSecret);
    controller.abort();

    await expect(
      startRealtimeTranscription(
        {
          getClientSecret,
          onTranscript: () => undefined,
          signal: controller.signal,
        },
        fixture.dependencies,
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(getClientSecret).not.toHaveBeenCalled();
    expect(fixture.getUserMedia).not.toHaveBeenCalled();
    expect(fixture.fetchMock).not.toHaveBeenCalled();
  });

  it("does not request the microphone when cancellation lands between mint continuations", async () => {
    const fixture = makeDependencies();
    const controller = new AbortController();
    const pendingSecret = createTestDeferred<typeof validClientSecret>();
    const secretRequested = createTestDeferred<void>();
    const started = startRealtimeTranscription(
      {
        getClientSecret: () => {
          secretRequested.resolve();
          return pendingSecret.promise;
        },
        onTranscript: () => undefined,
        signal: controller.signal,
      },
      fixture.dependencies,
    );
    await secretRequested.promise;

    pendingSecret.resolve(validClientSecret);
    queueMicrotask(() => queueMicrotask(() => controller.abort()));

    await expect(started).rejects.toMatchObject({ code: "cancelled" });
    expect(fixture.getUserMedia).not.toHaveBeenCalled();
    expect(fixture.fetchMock).not.toHaveBeenCalled();
  });

  it("posts SDP with the ephemeral bearer, streams partials, and waits for final completion", async () => {
    const fixture = makeDependencies({
      response: new Response("v=0\r\nt=test-answer\r\n", { status: 201 }),
    });
    const onTranscript = vi.fn();
    const session = await startRealtimeTranscription(
      {
        getClientSecret: async () => validClientSecret,
        onTranscript,
      },
      fixture.dependencies,
    );

    expect(fixture.getUserMedia).toHaveBeenCalledOnce();
    expect(fixture.fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fixture.fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(OPENAI_REALTIME_CALLS_URL);
    expect(request).toMatchObject({
      method: "POST",
      body: fixture.peer.offerSdp,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    expect(request?.body).not.toBe(fixture.peer.finalizedOfferSdp);
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect((request?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      "Bearer ephemeral-test-secret",
    );
    expect((request?.headers as Record<string, string> | undefined)?.["Content-Type"]).toBe(
      "application/sdp",
    );
    expect((request?.headers as Record<string, string> | undefined)?.["X-Client-Request-Id"]).toBe(
      undefined,
    );
    expect(getDictationDiagnosticSnapshot()).toMatchObject({
      stage: "active",
      outcome: "connected",
      sessionProfile: "transcription_pcm24k_minimal_v1",
      clientSecretModel: "gpt-live-transcribe",
      clientSecretRequestId: "req_mint_test",
      clientSecretRequestDurationMs: 42,
      clientSecretOpenAiProcessingMs: 12,
      clientSecretEffectiveProfile: "matches",
      httpStatus: 201,
      offerCandidateCount: 0,
      offerHasIceCandidate: false,
      answerSdpBytes: 20,
      answerSdpLineCount: 2,
      audioTrackCount: 1,
    });

    fixture.peer.channel.emitServerEvent({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "item-1",
      content_index: 0,
      delta: "Helo world",
    });
    expect(onTranscript).toHaveBeenLastCalledWith(
      expect.objectContaining({ transcript: "Helo world" }),
    );

    const finalized = session.stopAndFinalize();
    expect(fixture.media.stop).toHaveBeenCalledOnce();
    expect(fixture.peer.channel.sent).toEqual([
      JSON.stringify({ type: "input_audio_buffer.commit" }),
    ]);

    fixture.peer.channel.emitServerEvent({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-1",
      content_index: 0,
      transcript: "Hello world",
    });
    await finalized;

    expect(onTranscript).toHaveBeenLastCalledWith(
      expect.objectContaining({ transcript: "Hello world" }),
    );
    expect(fixture.peer.channel.closeMock).toHaveBeenCalledOnce();
    expect(fixture.peer.closeMock).toHaveBeenCalledOnce();
  });

  it("stops once when streamed text conflicts with the composer-owned range", async () => {
    const fixture = makeDependencies();
    const onFatalError = vi.fn();
    await startRealtimeTranscription(
      {
        getClientSecret: async () => validClientSecret,
        onTranscript: () => false,
        onFatalError,
      },
      fixture.dependencies,
    );

    fixture.peer.channel.emitServerEvent({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "item-conflict",
      content_index: 0,
      delta: "conflicting text",
    });
    fixture.peer.channel.dispatchEvent(new Event("error"));

    expect(onFatalError).toHaveBeenCalledOnce();
    expect(onFatalError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "transcript_conflict" }),
    );
    expect(fixture.media.stop).toHaveBeenCalledOnce();
    expect(fixture.peer.channel.closeMock).toHaveBeenCalledOnce();
    expect(fixture.peer.closeMock).toHaveBeenCalledOnce();
  });

  it("reports an active transport failure exactly once", async () => {
    const fixture = makeDependencies();
    const onFatalError = vi.fn();
    await startRealtimeTranscription(
      {
        getClientSecret: async () => validClientSecret,
        onTranscript: () => undefined,
        onFatalError,
      },
      fixture.dependencies,
    );

    fixture.peer.channel.dispatchEvent(new Event("error"));
    fixture.peer.channel.dispatchEvent(new Event("close"));

    expect(onFatalError).toHaveBeenCalledOnce();
    expect(onFatalError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "connection_failed" }),
    );
    expect(fixture.media.stop).toHaveBeenCalledOnce();
    expect(fixture.peer.closeMock).toHaveBeenCalledOnce();
  });

  it("rejects a declared oversized SDP answer and releases every captured resource", async () => {
    const response = new Response("too large", {
      headers: { "content-length": "1048577" },
    });
    const fixture = makeDependencies({ response });

    await expect(
      startRealtimeTranscription(
        { getClientSecret: async () => validClientSecret, onTranscript: () => undefined },
        fixture.dependencies,
      ),
    ).rejects.toMatchObject({ code: "protocol_error" });
    expect(fixture.media.stop).toHaveBeenCalledOnce();
    expect(fixture.peer.channel.closeMock).toHaveBeenCalledOnce();
    expect(fixture.peer.closeMock).toHaveBeenCalledOnce();
  });

  it.each([
    {
      status: 403,
      attempts: 1,
      code: "session_rejected",
      message:
        "OpenAI rejected the Realtime dictation session. Check this API project's model access.",
    },
    {
      status: 402,
      attempts: 1,
      code: "upstream_quota_exhausted",
      message:
        "This OpenAI API project has insufficient credits or quota for dictation. Add API credits or check its billing and usage limits, then try again.",
    },
    {
      status: 429,
      attempts: 3,
      code: "upstream_rate_limited",
      message:
        "OpenAI is rate limiting Realtime transcription. Please wait a moment and try again.",
    },
    {
      status: 409,
      attempts: 3,
      code: "upstream_unavailable",
      message:
        "OpenAI returned a temporary HTTP 409 error while starting dictation. Please try again shortly.",
    },
    {
      status: 500,
      attempts: 3,
      code: "upstream_unavailable",
      message:
        "OpenAI could not start either supported Realtime dictation model (HTTP 500). Check this API project's credits, billing, and Realtime transcription access, then retry.",
    },
  ])(
    "maps an OpenAI $status SDP rejection by status without exposing its body",
    async ({ status, attempts, code, message }) => {
      const leakedDetail = "provider-response-secret-that-must-not-surface";
      const fixture = makeDependencies({
        response: new Response(leakedDetail, { status, statusText: leakedDetail }),
      });

      const rejected = expect(
        startRealtimeTranscription(
          {
            getClientSecret: async (model) => ({ ...validClientSecret, model }),
            onTranscript: () => undefined,
          },
          fixture.dependencies,
        ),
      ).rejects;
      await rejected.toMatchObject({ code, message });
      await rejected.not.toMatchObject({ message: leakedDetail });
      expect(fixture.fetchMock).toHaveBeenCalledTimes(attempts);
      expect(fixture.waitForRetry).toHaveBeenCalledTimes(attempts - 1);
      expect(fixture.media.stop).toHaveBeenCalledOnce();
      expect(fixture.peer.channel.closeMock).toHaveBeenCalledOnce();
      expect(fixture.peer.closeMock).toHaveBeenCalledOnce();
    },
  );

  it("does not retry an exact insufficient_quota response reported as HTTP 429", async () => {
    const leakedDetail = "provider-billing-message-that-must-not-surface";
    const fixture = makeDependencies({
      response: Response.json(
        {
          error: {
            type: "insufficient_quota",
            code: "insufficient_quota",
            message: leakedDetail,
          },
        },
        { status: 429, headers: { "x-request-id": "req_quota-test" } },
      ),
    });
    const getClientSecret = vi.fn(async () => validClientSecret);

    const rejected = expect(
      startRealtimeTranscription(
        { getClientSecret, onTranscript: () => undefined },
        fixture.dependencies,
      ),
    ).rejects;
    await rejected.toMatchObject({
      code: "upstream_quota_exhausted",
      message:
        "This OpenAI API project has insufficient credits or quota for dictation. Add API credits or check its billing and usage limits, then try again.",
    });
    await rejected.not.toMatchObject({ message: leakedDetail });
    expect(getClientSecret).toHaveBeenCalledOnce();
    expect(fixture.fetchMock).toHaveBeenCalledOnce();
    expect(fixture.waitForRetry).not.toHaveBeenCalled();
    expect(getDictationDiagnosticSnapshot()).toMatchObject({
      httpStatus: 429,
      requestId: "req_quota-test",
      providerErrorType: "insufficient_quota",
      providerErrorCode: "insufficient_quota",
      errorCode: "upstream_quota_exhausted",
    });
    const diagnosticJson = JSON.stringify(getDictationDiagnosticSnapshot());
    expect(diagnosticJson).not.toContain(leakedDetail);
  });

  it("classifies HTTP 402 immediately even when its response body never arrives", async () => {
    const cancelBody = vi.fn();
    const fixture = makeDependencies({
      response: new Response(
        new ReadableStream<Uint8Array>({
          cancel: cancelBody,
        }),
        { status: 402 },
      ),
    });

    await expect(
      startRealtimeTranscription(
        { getClientSecret: async () => validClientSecret, onTranscript: () => undefined },
        fixture.dependencies,
      ),
    ).rejects.toMatchObject({
      code: "upstream_quota_exhausted",
      message:
        "This OpenAI API project has insufficient credits or quota for dictation. Add API credits or check its billing and usage limits, then try again.",
    });
    expect(fixture.fetchMock).toHaveBeenCalledOnce();
    expect(fixture.waitForRetry).not.toHaveBeenCalled();
    expect(cancelBody).toHaveBeenCalledOnce();
  });

  it("keeps stalled HTTP 429 bodies bounded and preserves rate-limit classification", async () => {
    const cancelBodies = [vi.fn(), vi.fn(), vi.fn()];
    const fixture = makeDependencies({
      responses: cancelBodies.map(
        (cancel) =>
          new Response(
            new ReadableStream<Uint8Array>({
              cancel,
            }),
            { status: 429 },
          ),
      ),
    });
    const dependencies = {
      ...fixture.dependencies,
      setTimeout: (callback: () => void, delayMs: number) => {
        if (delayMs === 500) {
          queueMicrotask(callback);
          return 500;
        }
        return fixture.dependencies.setTimeout(callback, delayMs);
      },
      clearTimeout: (timerId: number) => {
        if (timerId !== 500) fixture.dependencies.clearTimeout(timerId);
      },
    };

    await expect(
      startRealtimeTranscription(
        {
          getClientSecret: async (model) => ({ ...validClientSecret, model }),
          onTranscript: () => undefined,
        },
        dependencies,
      ),
    ).rejects.toMatchObject({
      code: "upstream_rate_limited",
      message:
        "OpenAI is rate limiting Realtime transcription. Please wait a moment and try again.",
    });
    expect(fixture.fetchMock).toHaveBeenCalledTimes(3);
    expect(fixture.waitForRetry).toHaveBeenCalledTimes(2);
    expect(cancelBodies.every((cancel) => cancel.mock.calls.length === 1)).toBe(true);
  });

  it("keeps HTTP 429 authoritative when headers arrive at the global setup deadline", async () => {
    const cancelBody = vi.fn();
    const fixture = makeDependencies({
      response: new Response(
        new ReadableStream<Uint8Array>({
          cancel: cancelBody,
        }),
        { status: 429 },
      ),
    });
    const setupTimeoutScheduled = createTestDeferred<() => void>();
    const bodyTimeoutScheduled = createTestDeferred<() => void>();
    const dependencies = {
      ...fixture.dependencies,
      setTimeout: (callback: () => void, delayMs: number) => {
        if (delayMs === 20_000) {
          setupTimeoutScheduled.resolve(callback);
          return 20_000;
        }
        if (delayMs === 500) {
          bodyTimeoutScheduled.resolve(callback);
          return 500;
        }
        throw new Error(`unexpected timeout: ${delayMs}`);
      },
      clearTimeout: vi.fn(),
    };

    const started = startRealtimeTranscription(
      {
        getClientSecret: async () => validClientSecret,
        onTranscript: () => undefined,
      },
      dependencies,
    );
    const triggerSetupTimeout = await setupTimeoutScheduled.promise;
    const triggerBodyTimeout = await bodyTimeoutScheduled.promise;
    triggerSetupTimeout();
    triggerBodyTimeout();

    await expect(started).rejects.toMatchObject({ code: "upstream_rate_limited" });
    expect(fixture.fetchMock).toHaveBeenCalledOnce();
    expect(fixture.waitForRetry).not.toHaveBeenCalled();
    expect(cancelBody).toHaveBeenCalledOnce();
  });

  it("keeps external cancellation authoritative during stalled 429 metadata", async () => {
    const controller = new AbortController();
    const cancelBody = vi.fn();
    const bodyReadStarted = createTestDeferred<void>();
    const fixture = makeDependencies({
      response: new Response(
        new ReadableStream<Uint8Array>({
          cancel: cancelBody,
        }),
        { status: 429 },
      ),
    });
    const dependencies = {
      ...fixture.dependencies,
      setTimeout: (callback: () => void, delayMs: number) => {
        if (delayMs === 500) bodyReadStarted.resolve();
        return fixture.dependencies.setTimeout(callback, delayMs);
      },
      clearTimeout: fixture.dependencies.clearTimeout,
    };

    const started = startRealtimeTranscription(
      {
        getClientSecret: async () => validClientSecret,
        onTranscript: () => undefined,
        signal: controller.signal,
      },
      dependencies,
    );
    await bodyReadStarted.promise;
    controller.abort();

    await expect(started).rejects.toMatchObject({ code: "cancelled" });
    expect(fixture.fetchMock).toHaveBeenCalledOnce();
    expect(fixture.waitForRetry).not.toHaveBeenCalled();
    expect(cancelBody).toHaveBeenCalledOnce();
  });

  it("preserves HTTP 429 when reading each provider body fails", async () => {
    const leakedDetail = "provider-stream-failure-secret";
    const fixture = makeDependencies({
      responses: [1, 2, 3].map(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start: (controller) => controller.error(new Error(leakedDetail)),
            }),
            { status: 429 },
          ),
      ),
    });

    await expect(
      startRealtimeTranscription(
        {
          getClientSecret: async (model) => ({ ...validClientSecret, model }),
          onTranscript: () => undefined,
        },
        fixture.dependencies,
      ),
    ).rejects.toMatchObject({ code: "upstream_rate_limited" });
    expect(fixture.fetchMock).toHaveBeenCalledTimes(3);
    expect(fixture.waitForRetry).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(getDictationDiagnosticSnapshot())).not.toContain(leakedDetail);
  });

  it("retries a transient SDP allocation failure and then connects", async () => {
    const fixture = makeDependencies({
      responses: [
        new Response("provider detail", {
          status: 503,
          headers: { "x-request-id": "req_retry-1" },
        }),
        new Response("v=0\r\nt=test-answer\r\n"),
      ],
    });
    const getClientSecret = vi
      .fn<(model: DictationTranscriptionModel) => Promise<DictationRealtimeClientSecret>>()
      .mockResolvedValueOnce({ ...validClientSecret, clientSecret: "ephemeral-attempt-1" })
      .mockResolvedValueOnce({
        ...validClientSecret,
        clientSecret: "ephemeral-attempt-2",
        model: "gpt-realtime-whisper",
      });

    const session = await startRealtimeTranscription(
      { getClientSecret, onTranscript: () => undefined },
      fixture.dependencies,
    );

    expect(getClientSecret).toHaveBeenCalledTimes(2);
    expect(getClientSecret.mock.calls).toEqual([["gpt-live-transcribe"], ["gpt-realtime-whisper"]]);
    expect(fixture.getUserMedia).toHaveBeenCalledOnce();
    expect(fixture.fetchMock).toHaveBeenCalledTimes(2);
    expect(fixture.peers).toHaveLength(2);
    expect(fixture.peers[0]?.closeMock).toHaveBeenCalledOnce();
    expect(fixture.peers[1]?.closeMock).not.toHaveBeenCalled();
    const firstRequest = fixture.fetchMock.mock.calls[0]?.[1];
    const secondRequest = fixture.fetchMock.mock.calls[1]?.[1];
    expect(firstRequest?.body).toBe(fixture.peers[0]?.offerSdp);
    expect(secondRequest?.body).toBe(fixture.peers[1]?.offerSdp);
    expect((firstRequest?.headers as Record<string, string>)?.Authorization).toBe(
      "Bearer ephemeral-attempt-1",
    );
    expect((secondRequest?.headers as Record<string, string>)?.Authorization).toBe(
      "Bearer ephemeral-attempt-2",
    );
    expect(
      (firstRequest?.headers as Record<string, string>)?.["X-Client-Request-Id"],
    ).toBeUndefined();
    expect(
      (secondRequest?.headers as Record<string, string>)?.["X-Client-Request-Id"],
    ).toBeUndefined();
    expect(fixture.waitForRetry).toHaveBeenCalledOnce();
    expect(fixture.waitForRetry).toHaveBeenCalledWith(250, expect.any(AbortSignal));
    expect(getDictationDiagnosticSnapshot()).toMatchObject({
      stage: "active",
      outcome: "connected",
      attempt: 2,
      maxAttempts: 3,
      httpStatus: 200,
      requestId: null,
      errorCode: null,
    });
    expect(getDictationDiagnosticSnapshot()?.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "sdp_exchange",
          outcome: "retrying",
          httpStatus: 503,
          requestId: "req_retry-1",
        }),
      ]),
    );
    session.cancel();
    expect(fixture.peers[1]?.closeMock).toHaveBeenCalledOnce();
  });

  it("retries a renderer network failure without retaining the thrown transport detail", async () => {
    const fixture = makeDependencies();
    const leakedDetail = "ephemeral-secret-in-network-error";
    fixture.fetchMock.mockRejectedValueOnce(new Error(leakedDetail));

    const session = await startRealtimeTranscription(
      { getClientSecret: async () => validClientSecret, onTranscript: () => undefined },
      fixture.dependencies,
    );

    expect(fixture.fetchMock).toHaveBeenCalledTimes(2);
    expect(fixture.waitForRetry).toHaveBeenCalledOnce();
    expect(JSON.stringify(getDictationDiagnosticSnapshot())).not.toContain(leakedDetail);
    session.cancel();
  });

  it("honors OpenAI Retry-After when it exceeds the local retry floor", async () => {
    const fixture = makeDependencies({
      responses: [
        new Response("capacity", { status: 429, headers: { "retry-after": "2" } }),
        new Response("v=0\r\nt=test-answer\r\n"),
      ],
    });

    const session = await startRealtimeTranscription(
      { getClientSecret: async () => validClientSecret, onTranscript: () => undefined },
      fixture.dependencies,
    );

    expect(fixture.waitForRetry).toHaveBeenCalledOnce();
    expect(fixture.waitForRetry).toHaveBeenCalledWith(2_000, expect.any(AbortSignal));
    session.cancel();
  });

  it("sanitizes a fresh-credential failure during retry and releases the first transport", async () => {
    const fixture = makeDependencies({ response: new Response("retry", { status: 503 }) });
    const leakedDetail = "provider-retry-secret-detail";
    const getClientSecret = vi
      .fn<() => Promise<typeof validClientSecret>>()
      .mockResolvedValueOnce(validClientSecret)
      .mockRejectedValueOnce({
        code: "upstream_auth_failed",
        message: leakedDetail,
        cause: { credential: leakedDetail },
      });

    const rejected = expect(
      startRealtimeTranscription(
        { getClientSecret, onTranscript: () => undefined },
        fixture.dependencies,
      ),
    ).rejects;
    await rejected.toMatchObject({
      code: "upstream_auth_failed",
      message:
        "OpenAI rejected the saved dictation credential or its Realtime transcription access.",
    });
    await rejected.not.toMatchObject({ message: leakedDetail });
    expect(getClientSecret).toHaveBeenCalledTimes(2);
    expect(fixture.getUserMedia).toHaveBeenCalledOnce();
    expect(fixture.fetchMock).toHaveBeenCalledOnce();
    expect(fixture.peers).toHaveLength(1);
    expect(fixture.peer.closeMock).toHaveBeenCalledOnce();
    expect(fixture.media.stop).toHaveBeenCalledOnce();
    expect(JSON.stringify(getDictationDiagnosticSnapshot())).not.toContain(leakedDetail);
  });

  it("does not allocate a new retry peer when cancellation lands between mint continuations", async () => {
    const fixture = makeDependencies({ response: new Response("retry", { status: 503 }) });
    const controller = new AbortController();
    const retrySecret = createTestDeferred<typeof validClientSecret>();
    const retryMintStarted = createTestDeferred<void>();
    const getClientSecret = vi
      .fn<() => Promise<typeof validClientSecret>>()
      .mockResolvedValueOnce(validClientSecret)
      .mockImplementationOnce(() => {
        retryMintStarted.resolve();
        return retrySecret.promise;
      });

    const started = startRealtimeTranscription(
      { getClientSecret, onTranscript: () => undefined, signal: controller.signal },
      fixture.dependencies,
    );
    await retryMintStarted.promise;
    retrySecret.resolve({ ...validClientSecret, clientSecret: "late-retry-secret" });
    queueMicrotask(() => queueMicrotask(() => controller.abort()));

    await expect(started).rejects.toMatchObject({ code: "cancelled" });
    expect(getClientSecret).toHaveBeenCalledTimes(2);
    expect(fixture.peers).toHaveLength(1);
    expect(fixture.peer.closeMock).toHaveBeenCalledOnce();
    expect(fixture.media.stop).toHaveBeenCalledOnce();
  });

  it("cancels immediately during retry backoff and releases the microphone", async () => {
    const fixture = makeDependencies({ response: new Response("retry", { status: 503 }) });
    const controller = new AbortController();
    let notifyBackoffStarted!: () => void;
    const backoffStarted = new Promise<void>((resolve) => {
      notifyBackoffStarted = resolve;
    });
    const waitForRetry = vi.fn(async (_delayMs: number, signal: AbortSignal) => {
      notifyBackoffStarted();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });

    const started = startRealtimeTranscription(
      {
        getClientSecret: async () => validClientSecret,
        onTranscript: () => undefined,
        signal: controller.signal,
      },
      { ...fixture.dependencies, waitForRetry },
    );
    await backoffStarted;
    controller.abort();

    await expect(started).rejects.toMatchObject({ code: "cancelled" });
    expect(waitForRetry).toHaveBeenCalledOnce();
    expect(fixture.media.stop).toHaveBeenCalledOnce();
    expect(getDictationDiagnosticSnapshot()).toMatchObject({
      stage: "sdp_exchange",
      outcome: "cancelled",
      errorCode: "cancelled",
    });
  });

  it("stops a microphone resolved in the microtask immediately before cancellation", async () => {
    const fixture = makeDependencies();
    const controller = new AbortController();
    const mediaRequested = createTestDeferred<void>();
    const pendingMedia = createTestDeferred<MediaStream>();
    fixture.getUserMedia.mockImplementation(() => {
      mediaRequested.resolve();
      return pendingMedia.promise;
    });

    const started = startRealtimeTranscription(
      {
        getClientSecret: async () => validClientSecret,
        onTranscript: () => undefined,
        signal: controller.signal,
      },
      fixture.dependencies,
    );
    await mediaRequested.promise;

    // Preserve this ordering: both media reactions are queued first, then the
    // abort, then the async continuation produced by Promise.race. The stream
    // must still be disposed even though cleanup ran before ownership moved to
    // the session's mediaStream field.
    pendingMedia.resolve(fixture.media.stream);
    queueMicrotask(() => controller.abort());

    await expect(started).rejects.toMatchObject({ code: "cancelled" });
    expect(fixture.media.stop).toHaveBeenCalledOnce();
    expect(fixture.fetchMock).not.toHaveBeenCalled();
  });

  it("times out an unresolved retry credential without relabeling or late diagnostic writes", async () => {
    const fixture = makeDependencies({ response: new Response("retry", { status: 503 }) });
    const retryMint = createTestDeferred<typeof validClientSecret>();
    const retryMintStarted = createTestDeferred<void>();
    const getClientSecret = vi
      .fn<() => Promise<typeof validClientSecret>>()
      .mockResolvedValueOnce(validClientSecret)
      .mockImplementationOnce(() => {
        retryMintStarted.resolve();
        return retryMint.promise;
      });
    const setupTimeoutScheduled = createTestDeferred<() => void>();
    const dependencies = {
      ...fixture.dependencies,
      setTimeout: (callback: () => void, delayMs: number) => {
        if (delayMs === 500) return fixture.dependencies.setTimeout(callback, delayMs);
        expect(delayMs).toBe(20_000);
        setupTimeoutScheduled.resolve(callback);
        return 91;
      },
      clearTimeout: vi.fn((timerId: number) => {
        if (timerId !== 91) fixture.dependencies.clearTimeout(timerId);
      }),
    };

    const started = startRealtimeTranscription(
      { getClientSecret, onTranscript: () => undefined },
      dependencies,
    );
    await retryMintStarted.promise;
    const triggerSetupTimeout = await setupTimeoutScheduled.promise;
    triggerSetupTimeout();

    await expect(started).rejects.toMatchObject({ code: "connection_failed" });
    expect(fixture.media.stop).toHaveBeenCalledOnce();
    expect(fixture.peer.closeMock).toHaveBeenCalledOnce();
    expect(getDictationDiagnosticSnapshot()).toMatchObject({
      stage: "client_secret",
      outcome: "failed",
      errorCode: "connection_failed",
    });

    const terminalSnapshot = JSON.stringify(getDictationDiagnosticSnapshot());
    retryMint.resolve({ ...validClientSecret, clientSecret: "late-secret" });
    await Promise.resolve();
    await Promise.resolve();
    expect(JSON.stringify(getDictationDiagnosticSnapshot())).toBe(terminalSnapshot);
  });

  it("settles a setup timeout while the data channel is unopened", async () => {
    const fixture = makeDependencies();
    const remoteDescriptionSet = createTestDeferred<void>();
    fixture.peer.setRemoteDescriptionMock.mockImplementation(async () => {
      remoteDescriptionSet.resolve();
      // Deliberately leave the channel connecting to exercise the open waiter.
    });
    const setupTimeoutScheduled = createTestDeferred<() => void>();
    const dependencies = {
      ...fixture.dependencies,
      setTimeout: (callback: () => void, delayMs: number) => {
        expect(delayMs).toBe(20_000);
        setupTimeoutScheduled.resolve(callback);
        return 92;
      },
      clearTimeout: vi.fn(),
    };

    const started = startRealtimeTranscription(
      { getClientSecret: async () => validClientSecret, onTranscript: () => undefined },
      dependencies,
    );
    await remoteDescriptionSet.promise;
    const triggerSetupTimeout = await setupTimeoutScheduled.promise;
    triggerSetupTimeout();

    await expect(started).rejects.toMatchObject({ code: "connection_failed" });
    expect(fixture.media.stop).toHaveBeenCalledOnce();
    expect(fixture.peer.channel.closeMock).toHaveBeenCalledOnce();
    expect(fixture.peer.closeMock).toHaveBeenCalledOnce();
    const terminalSnapshot = JSON.stringify(getDictationDiagnosticSnapshot());
    fixture.peer.channel.open();
    fixture.peer.dispatchEvent(new Event("connectionstatechange"));
    expect(JSON.stringify(getDictationDiagnosticSnapshot())).toBe(terminalSnapshot);
  });

  it("closes a newly allocated peer when data-channel creation throws", async () => {
    const fixture = makeDependencies();
    fixture.peer.createDataChannelMock.mockImplementationOnce(() => {
      throw new Error("unsafe-browser-detail");
    });

    await expect(
      startRealtimeTranscription(
        { getClientSecret: async () => validClientSecret, onTranscript: () => undefined },
        fixture.dependencies,
      ),
    ).rejects.toMatchObject({ code: "connection_failed" });
    expect(fixture.fetchMock).not.toHaveBeenCalled();
    expect(fixture.media.stop).toHaveBeenCalledOnce();
    expect(fixture.peer.closeMock).toHaveBeenCalledOnce();
    expect(JSON.stringify(getDictationDiagnosticSnapshot())).not.toContain("unsafe-browser-detail");
  });

  it("settles immediately when the connecting transport fails during an uncancellable peer await", async () => {
    const fixture = makeDependencies();
    const offerStarted = createTestDeferred<void>();
    const neverOffer = createTestDeferred<RTCSessionDescriptionInit>();
    vi.spyOn(fixture.peer, "createOffer").mockImplementation(() => {
      offerStarted.resolve();
      return neverOffer.promise;
    });

    const started = startRealtimeTranscription(
      { getClientSecret: async () => validClientSecret, onTranscript: () => undefined },
      fixture.dependencies,
    );
    await offerStarted.promise;
    fixture.peer.channel.dispatchEvent(new Event("error"));

    await expect(started).rejects.toMatchObject({ code: "connection_failed" });
    expect(fixture.media.stop).toHaveBeenCalledOnce();
    expect(fixture.peer.channel.closeMock).toHaveBeenCalledOnce();
    expect(fixture.peer.closeMock).toHaveBeenCalledOnce();
    expect(getDictationDiagnosticSnapshot()).toMatchObject({
      outcome: "failed",
      errorCode: "connection_failed",
    });
  });

  it("posts the original offer without waiting for candidate-rich ICE gathering", async () => {
    const fixture = makeDependencies();
    fixture.peer.autoCompleteIceGathering = false;

    const session = await startRealtimeTranscription(
      { getClientSecret: async () => validClientSecret, onTranscript: () => undefined },
      fixture.dependencies,
    );

    expect(fixture.peer.iceGatheringState).toBe("gathering");
    expect(fixture.fetchMock).toHaveBeenCalledOnce();
    expect(fixture.fetchMock.mock.calls[0]?.[1]?.body).toBe(fixture.peer.offerSdp);
    expect(fixture.fetchMock.mock.calls[0]?.[1]?.body).not.toBe(fixture.peer.finalizedOfferSdp);
    session.cancel();
  });

  it("aborts an in-flight OpenAI call when the owning route is cancelled", async () => {
    const fixture = makeDependencies();
    const controller = new AbortController();
    const fetchStarted = createTestDeferred<AbortSignal>();
    fixture.fetchMock.mockImplementationOnce(async (_request, init) => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) throw new Error("missing setup abort signal");
      fetchStarted.resolve(signal);
      return new Promise<Response>(() => undefined);
    });

    const started = startRealtimeTranscription(
      {
        getClientSecret: async () => validClientSecret,
        onTranscript: () => undefined,
        signal: controller.signal,
      },
      fixture.dependencies,
    );
    const fetchSignal = await fetchStarted.promise;
    expect(fetchSignal.aborted).toBe(false);
    controller.abort();

    await expect(started).rejects.toMatchObject({ code: "cancelled" });
    expect(fetchSignal.aborted).toBe(true);
    expect(fixture.media.stop).toHaveBeenCalledOnce();
    expect(fixture.peer.channel.closeMock).toHaveBeenCalledOnce();
    expect(fixture.peer.closeMock).toHaveBeenCalledOnce();
  });

  it("settles an in-flight finalization immediately when the session is cancelled", async () => {
    const fixture = makeDependencies();
    const session = await startRealtimeTranscription(
      { getClientSecret: async () => validClientSecret, onTranscript: () => undefined },
      fixture.dependencies,
    );

    const finalized = session.stopAndFinalize();
    session.cancel();

    await expect(finalized).rejects.toMatchObject({ code: "cancelled" });
    expect(getDictationDiagnosticSnapshot()).toMatchObject({
      stage: "closed",
      outcome: "cancelled",
      errorCode: "cancelled",
    });
  });

  it("single-flights finalization and times out with deterministic cleanup", async () => {
    const fixture = makeDependencies();
    const finalizationTimeoutScheduled = createTestDeferred<() => void>();
    const dependencies = {
      ...fixture.dependencies,
      setTimeout: (callback: () => void, delayMs: number) => {
        if (delayMs === 10_000) finalizationTimeoutScheduled.resolve(callback);
        return delayMs;
      },
      clearTimeout: vi.fn(),
    };
    const session = await startRealtimeTranscription(
      { getClientSecret: async () => validClientSecret, onTranscript: () => undefined },
      dependencies,
    );

    const first = session.stopAndFinalize();
    const second = session.stopAndFinalize();
    expect(second).toBe(first);
    const triggerFinalizationTimeout = await finalizationTimeoutScheduled.promise;
    triggerFinalizationTimeout();

    await expect(first).rejects.toMatchObject({ code: "finalization_timeout" });
    expect(fixture.peer.channel.sent).toEqual([
      JSON.stringify({ type: "input_audio_buffer.commit" }),
    ]);
    expect(fixture.media.stop).toHaveBeenCalledOnce();
    expect(fixture.peer.channel.closeMock).toHaveBeenCalledOnce();
    expect(fixture.peer.closeMock).toHaveBeenCalledOnce();
  });

  it("retains only the final safe status and request id after exhausting transient retries", async () => {
    const leakedDetail = "secret-provider-body";
    const fixture = makeDependencies({
      responses: [1, 2, 3].map((attempt) =>
        Response.json(
          {
            error: {
              type: "server_error",
              code: "allocation_failed",
              message: `${leakedDetail}-${attempt}`,
            },
          },
          {
            status: 503,
            headers: { "x-request-id": `req_attempt-${attempt}` },
          },
        ),
      ),
    });
    let mintedSecretCount = 0;
    const getClientSecret = vi.fn(async (model: DictationTranscriptionModel) => {
      mintedSecretCount += 1;
      return {
        ...validClientSecret,
        clientSecret: `ephemeral-exhausted-${mintedSecretCount}`,
        model,
      };
    });

    const rejected = expect(
      startRealtimeTranscription(
        { getClientSecret, onTranscript: () => undefined },
        fixture.dependencies,
      ),
    ).rejects;
    await rejected.toMatchObject({
      code: "upstream_unavailable",
      message:
        "OpenAI could not start either supported Realtime dictation model (HTTP 503). Check this API project's credits, billing, and Realtime transcription access, then retry.",
    });
    await rejected.not.toMatchObject({ message: leakedDetail });
    expect(getClientSecret).toHaveBeenCalledTimes(3);
    expect(getClientSecret.mock.calls).toEqual([
      ["gpt-live-transcribe"],
      ["gpt-realtime-whisper"],
      ["gpt-realtime-whisper"],
    ]);
    expect(fixture.getUserMedia).toHaveBeenCalledOnce();
    expect(fixture.fetchMock).toHaveBeenCalledTimes(3);
    expect(fixture.peers).toHaveLength(3);
    expect(fixture.peers.every((peer) => peer.closeMock.mock.calls.length === 1)).toBe(true);
    expect(fixture.fetchMock.mock.calls.map(([, request]) => request?.body)).toEqual(
      fixture.peers.map((peer) => peer.offerSdp),
    );
    expect(fixture.waitForRetry).toHaveBeenCalledTimes(2);
    const diagnostic = getDictationDiagnosticSnapshot();
    expect(diagnostic).toMatchObject({
      stage: "sdp_exchange",
      outcome: "failed",
      attempt: 3,
      maxAttempts: 3,
      httpStatus: 503,
      requestId: "req_attempt-3",
      responseContentTypeCategory: "json",
      providerErrorType: "server_error",
      providerErrorCode: "allocation_failed",
      responseBodyTruncated: false,
      errorCode: "upstream_unavailable",
    });
    expect(JSON.stringify(diagnostic)).not.toContain(leakedDetail);
  });

  it("truncates an oversized provider error without retaining or hashing it", async () => {
    const leakedDetail = "provider-body-secret";
    const fixture = makeDependencies({
      response: new Response(leakedDetail.repeat(10_000), {
        status: 400,
        headers: { "content-type": "text/plain" },
      }),
    });

    await expect(
      startRealtimeTranscription(
        { getClientSecret: async () => validClientSecret, onTranscript: () => undefined },
        fixture.dependencies,
      ),
    ).rejects.toMatchObject({ code: "session_rejected" });

    const diagnostic = getDictationDiagnosticSnapshot();
    expect(diagnostic).toMatchObject({
      httpStatus: 400,
      responseContentTypeCategory: "text",
      responseBodyBytes: 65_536,
      responseBodyTruncated: true,
      providerErrorType: null,
      providerErrorCode: null,
    });
    expect(JSON.stringify(diagnostic)).not.toContain(leakedDetail);
  });

  it("collapses token-shaped provider error identifiers before recording diagnostics", async () => {
    const fixture = makeDependencies({
      response: Response.json(
        {
          error: {
            type: "sk-proj-secret-shaped-type",
            code: "ek_secret_shaped_code",
            message: "provider-message-secret",
          },
        },
        { status: 400 },
      ),
    });

    await expect(
      startRealtimeTranscription(
        { getClientSecret: async () => validClientSecret, onTranscript: () => undefined },
        fixture.dependencies,
      ),
    ).rejects.toMatchObject({ code: "session_rejected" });

    const diagnosticJson = JSON.stringify(getDictationDiagnosticSnapshot());
    expect(getDictationDiagnosticSnapshot()).toMatchObject({
      providerErrorType: "other",
      providerErrorCode: "other",
    });
    expect(diagnosticJson).not.toContain("sk-proj-secret-shaped-type");
    expect(diagnosticJson).not.toContain("ek_secret_shaped_code");
    expect(diagnosticJson).not.toContain("provider-message-secret");
  });

  it("hard-caps an oversized streamed SDP answer without relying on Content-Length", async () => {
    const response = new Response(new Uint8Array(1_048_577));
    const fixture = makeDependencies({ response });

    await expect(
      startRealtimeTranscription(
        { getClientSecret: async () => validClientSecret, onTranscript: () => undefined },
        fixture.dependencies,
      ),
    ).rejects.toMatchObject({ code: "protocol_error" });
    expect(fixture.media.stop).toHaveBeenCalledOnce();
    expect(fixture.peer.closeMock).toHaveBeenCalledOnce();
  });
});
