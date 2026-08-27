import { describe, expect, it, vi } from "vitest";

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
  connectionState: RTCPeerConnectionState = "new";
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

  createDataChannel(label: string): RTCDataChannel {
    return this.createDataChannelMock(label);
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "v=0\r\nt=test-offer\r\n" };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    await this.setLocalDescriptionMock(description);
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

function makeDependencies(input?: { readonly response?: Response }) {
  const peer = new FakePeerConnection();
  const media = makeMediaFixture();
  const getUserMedia = vi.fn(async () => media.stream);
  const fetchMock = vi.fn(
    async (_request: RequestInfo | URL, _init?: RequestInit) =>
      input?.response ?? new Response("v=0\r\nt=test-answer\r\n"),
  );
  const dependencies: NonNullable<Parameters<typeof startRealtimeTranscription>[1]> = {
    createPeerConnection: () => peer as unknown as RTCPeerConnection,
    fetch: fetchMock as typeof fetch,
    getUserMedia,
    now: () => 1_000_000,
    setTimeout: (callback, delayMs) =>
      globalThis.setTimeout(callback, delayMs) as unknown as number,
    clearTimeout: (timerId) => globalThis.clearTimeout(timerId),
  };
  return { dependencies, fetchMock, getUserMedia, media, peer };
}

const validClientSecret = {
  clientSecret: "ephemeral-test-secret",
  expiresAt: 2_000,
  model: "gpt-live-transcribe" as const,
};

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

  it("posts SDP with the ephemeral bearer, streams partials, and waits for final completion", async () => {
    const fixture = makeDependencies();
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
      body: "v=0\r\nt=test-offer\r\n",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    expect((request?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      "Bearer ephemeral-test-secret",
    );
    expect((request?.headers as Record<string, string> | undefined)?.["Content-Type"]).toBe(
      "application/sdp",
    );

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
      code: "session_rejected",
      message:
        "OpenAI rejected the Realtime dictation session. Check this API project's model access.",
    },
    {
      status: 429,
      code: "upstream_rate_limited",
      message:
        "OpenAI has no Realtime transcription capacity or quota available for this API project.",
    },
    {
      status: 500,
      code: "upstream_unavailable",
      message: "OpenAI is temporarily unavailable for dictation.",
    },
  ])(
    "maps an OpenAI $status SDP rejection by status without exposing its body",
    async ({ status, code, message }) => {
      const leakedDetail = "provider-response-secret-that-must-not-surface";
      const fixture = makeDependencies({
        response: new Response(leakedDetail, { status, statusText: leakedDetail }),
      });

      const rejected = expect(
        startRealtimeTranscription(
          { getClientSecret: async () => validClientSecret, onTranscript: () => undefined },
          fixture.dependencies,
        ),
      ).rejects;
      await rejected.toMatchObject({ code, message });
      await rejected.not.toMatchObject({ message: leakedDetail });
      expect(fixture.media.stop).toHaveBeenCalledOnce();
      expect(fixture.peer.channel.closeMock).toHaveBeenCalledOnce();
      expect(fixture.peer.closeMock).toHaveBeenCalledOnce();
    },
  );

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
