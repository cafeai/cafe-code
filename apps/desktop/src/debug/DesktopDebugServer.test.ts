// @effect-diagnostics globalDate:off
import { assert, describe, it } from "@effect/vitest";

import { __desktopDebugServerTestApi as debugServer } from "./DesktopDebugServer.ts";

const makeLargeRendererSnapshot = (index: number) => ({
  debugSnapshotVersion: 50,
  source: "test",
  capturedAt: new Date(1_700_000_000_000 + index).toISOString(),
  route: {
    activeThreadId: "thread-1",
  },
  project: {
    id: "project-1",
    name: "project",
    cwd: "/Users/mike/secret/project",
  },
  thread: {
    id: "thread-1",
    title: "Long debug thread",
    projectId: "project-1",
    worktreePath: "/Users/mike/secret/project",
    messageCount: 2_000,
    activityCount: 500,
    session: {
      status: "running",
      activeTurnId: "turn-1",
      provider: "codex",
    },
    latestTurn: {
      turnId: "turn-1",
      state: "running",
      requestedAt: "2026-05-26T00:00:00.000Z",
      startedAt: "2026-05-26T00:00:01.000Z",
      completedAt: null,
    },
    recentMessages: [
      {
        id: "message-1",
        role: "user",
        textPreview: `prompt-secret-${index}`.repeat(1_000),
      },
    ],
    recentActivities: [
      {
        id: "activity-1",
        kind: "runtime.warning",
        summaryPreview: `output-secret-${index}`.repeat(1_000),
        payloadPreview: JSON.stringify({ token: `npm_${"A".repeat(40)}` }),
      },
    ],
  },
  composer: {
    activeThreadId: "thread-1",
    phase: "running",
    selectedProvider: "codex",
    selectedInstanceId: "codex_astrea_zkm",
    selectedModelSelection: {
      instanceId: "codex_astrea_zkm",
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "ultra" }],
    },
    promptPreview: `composer-prompt-secret-${index}`.repeat(1_000),
  },
  connection: {
    phase: "disconnected",
    reconnectPhase: "waiting",
    hasConnected: true,
    connected: false,
    online: true,
    attemptCount: 4,
    reconnectAttemptCount: 2,
    reconnectMaxAttempts: 8,
    closeCode: 1006,
    socketUrl: "wss://secret.example.test/ws?token=secret",
    closeReason: "private provider response",
    lastError: "bearer secret should not be retained",
    recentEvents: [
      {
        at: "2026-05-26T00:00:00.000Z",
        kind: "closed",
        phase: "disconnected",
        reconnectPhase: "waiting",
        attemptCount: 4,
        reconnectAttemptCount: 2,
        closeCode: 1006,
        online: true,
        injectedSecret: "recent event secret",
      },
    ],
  },
  usage: {
    detail: {
      active: true,
      consumerCount: 1,
      cacheAvailable: true,
      inFlight: true,
      attemptCount: 8,
      successCount: 6,
      failureCount: 2,
      reconnectRefreshCount: 2,
      lastDurationMs: 5_123,
      lastOutcome: "success",
      lastErrorCategory: null,
      lastDayCount: 51,
      lastTokenBreakdownCount: 93,
      payload: "usage payload secret",
    },
  },
  dictation: {
    capturedAt: "2026-08-27T10:00:00.000Z",
    operationElapsedMs: 1_250.125,
    stageElapsedMs: 75.5,
    attemptElapsedMs: 75.5,
    stage: "sdp_exchange",
    outcome: "failed",
    attempt: 3,
    maxAttempts: 3,
    requestDurationMs: 75.5,
    httpStatus: 503,
    requestId: "req_safe-123",
    openAiProcessingMs: 63.25,
    retryAfterMs: 1_000,
    responseContentTypeCategory: "json",
    responseContentLengthBytes: 98,
    providerErrorType: "server_error",
    providerErrorCode: "internal_error",
    responseBodyBytes: 98,
    responseBodySha256: "A".repeat(64),
    responseBodyTruncated: true,
    sessionProfile: "transcription_pcm24k_minimal_v1",
    clientSecretModel: "gpt-live-transcribe",
    clientSecretLifetimeMs: 60_000,
    clientSecretRequestId: "req_mint-123",
    clientSecretRequestDurationMs: 42.125,
    clientSecretOpenAiProcessingMs: 21.5,
    clientSecretEffectiveProfile: "matches",
    offerSdpBytes: 1_024,
    offerSdpLineCount: 24,
    offerMediaSectionCount: 2,
    offerAudioSectionCount: 1,
    offerApplicationSectionCount: 1,
    offerCandidateCount: 3,
    offerHasOpus: true,
    offerHasIceCandidate: true,
    answerSdpBytes: 864,
    answerSdpLineCount: 20,
    answerMediaSectionCount: 2,
    answerAudioSectionCount: 1,
    answerApplicationSectionCount: 1,
    answerCandidateCount: 2,
    answerHasOpus: true,
    answerHasIceCandidate: true,
    peerConnectionState: "connecting",
    iceConnectionState: "checking",
    iceGatheringState: "complete",
    signalingState: "stable",
    dataChannelState: "connecting",
    audioTrackCount: 1,
    audioTrackState: "live",
    audioTrackEnabled: true,
    audioTrackMuted: false,
    audioSampleRate: 48_000,
    audioChannelCount: 1,
    audioSampleSize: 16,
    audioEchoCancellation: true,
    audioNoiseSuppression: true,
    audioAutoGainControl: true,
    errorCode: "upstream_unavailable",
    timeline: [
      {
        capturedAt: "2026-08-27T09:59:59.000Z",
        operationElapsedMs: 250,
        stageElapsedMs: 75,
        attemptElapsedMs: 75,
        stage: "sdp_exchange",
        outcome: "retrying",
        attempt: 1,
        maxAttempts: 3,
        requestDurationMs: 75,
        httpStatus: 500,
        requestId: "req_timeline-1",
        responseContentTypeCategory: "json",
        responseBodyBytes: 98,
        responseBodySha256: "B".repeat(64),
        responseBodyTruncated: true,
        providerErrorType: "server_error",
        providerErrorCode: "internal_error",
        errorCode: "upstream_unavailable",
        responseBody: `nested-dictation-response-secret-${index}`,
        rawError: { message: `nested-dictation-error-secret-${index}` },
      },
    ],
    omittedTimelineEntryCount: 0,
    transcript: `dictation-transcript-secret-${index}`,
    audio: `dictation-audio-secret-${index}`,
    sdp: `dictation-sdp-secret-${index}`,
    credential: `dictation-credential-secret-${index}`,
    responseBody: `dictation-response-secret-${index}`,
    rawError: { message: `dictation-error-secret-${index}` },
  },
  performance: {
    rendererSnapshotBuildDurationMs: 12,
    activeThread: {
      pressureFlags: [
        "message-window-at-server-limit",
        "activity-window-at-server-limit",
        "large-context-input-token-count",
      ],
      approximateChars: {
        messageText: 2_000_000,
        activityPayloadJson: 2_000_000,
      },
      latency: {
        activeTurnElapsedMs: 3_600_000,
        lastActivityAgeMs: 120_000,
      },
      latestMessage: {
        textPreview: `assistant-secret-${index}`.repeat(1_000),
      },
    },
    storePressure: {
      threadCount: 1,
      maxThreadMessageCount: 2_000,
      maxThreadActivityCount: 500,
    },
    notableThreads: Array.from({ length: 30 }, (_, threadIndex) => ({
      id: `notable-${threadIndex}`,
      title: `Notable ${threadIndex}`,
      latestActiveTurnMessage: {
        textPreview: `notable-secret-${threadIndex}`.repeat(100),
      },
    })),
  },
  lifecycle: {
    active: {
      phase: "running",
      latestActiveTurnActivity: {
        kind: "tool.started",
        summaryPreview: "tool command should be omitted",
      },
      redFlags: ["provider-signal-after-earliest-completion-signal"],
    },
    counts: {
      sessionsRunning: 1,
    },
    queueCoupling: {
      activeQueueLength: 1,
      waitReasons: ["provider-running-tool", "debug-pruned"],
      redFlags: ["queue-blocked-by-active-turn"],
    },
    interestingThreads: Array.from({ length: 30 }, (_, threadIndex) => ({
      id: `interesting-${threadIndex}`,
      latestActiveTurnMessage: {
        textPreview: `interesting-secret-${threadIndex}`.repeat(100),
      },
    })),
  },
  queue: {
    activeThreadId: "thread-1",
    length: 1,
    steeringLength: 0,
    blockers: ["thread-visible-working"],
    items: [
      {
        id: "queue-1",
        promptPreview: "queued prompt should be omitted".repeat(100),
        promptLength: 3_000,
      },
    ],
    allQueues: {
      "thread-1": {
        items: [
          {
            promptPreview: "queued allQueues prompt should be omitted".repeat(100),
          },
        ],
      },
    },
  },
  gates: {
    waitReasons: ["provider-running-tool", "debug-pruned"],
  },
});

const makeLargeProviderDaemonSnapshot = () => ({
  status: "running",
  pid: 123,
  endpoint: {
    httpBaseUrl: "http://127.0.0.1:3773",
    transport: "ipc",
    socketPath: "/Users/mike/.cafe-code/provider-daemon.sock",
    leaseId: "lease-secret",
  },
  markerPath: "/Users/mike/.cafe-code/provider-daemon-marker.json",
  credentialPath: "/Users/mike/.cafe-code/provider-daemon-token.bin",
  lastHealth: {
    ok: true,
    mode: "provider-daemon",
    pid: 123,
    activeStreamCount: 1,
    retainedEventCount: 760_000,
    eventCursor: 970_000,
    commandCount: 465,
    completedCommandCount: 449,
    failedCommandCount: 16,
    runningCommandCount: 0,
    recentCompletedCommands: Array.from({ length: 50 }, (_, index) => ({
      id: `command-${index}`,
      payload: `command-secret-${index}`.repeat(500),
    })),
    rpc: {
      totalRpcCount: 100,
      mutatingRpcCount: 40,
      failedRpcCount: 2,
      recentFailures: Array.from({ length: 20 }, (_, index) => ({
        message: `failure-secret-${index}`.repeat(100),
      })),
    },
    runtimeEvents: {
      recentMethodCounts: Array.from({ length: 50 }, (_, index) => ({
        method: `method-${index}`,
        count: index,
      })),
      recentTurnTimings: Array.from({ length: 50 }, (_, index) => ({
        turnId: `turn-${index}`,
      })),
      lastEventAt: "2026-05-26T00:00:00.000Z",
      lastThreadId: "thread-1",
      lastTurnId: "turn-1",
    },
    pipelineDiagnostics: {
      eventLoop: {
        retainedSampleCount: 600,
        currentLagMs: 1,
        p95LagMs: 2,
        p99LagMs: 3,
        maxLagMs: 4,
      },
      daemonStream: {
        activeStreamCount: 1,
        replayPageCount: 489,
        replayRecordCount: 3_879,
        replayBytes: 10_674_735,
        drainWaitCount: 173,
        queuedLiveRecords: 74,
        queuedLiveBytes: 375_649,
        laggingDisconnectCount: 7,
        secret: "daemon stream secret",
      },
      backendBridge: {},
      subscriptions: {},
      webSocket: {},
    },
    supervisor: {
      sessionCount: 5,
      runningSessionCount: 1,
      errorSessionCount: 0,
    },
  },
});

describe("DesktopDebugServer compact snapshots", () => {
  it("keeps default debug bounded and strips long-running prompt/output previews", () => {
    debugServer.reset();
    for (let index = 0; index < 25; index += 1) {
      debugServer.publishRendererSnapshot(makeLargeRendererSnapshot(index));
    }
    debugServer.publishProviderDaemonSnapshot(makeLargeProviderDaemonSnapshot());

    const compact = debugServer.buildCompactDebugSnapshot();
    const compactJson = JSON.stringify(compact);

    assert.equal((compact.debug as Record<string, unknown>).detail, "compact");
    assert.equal(debugServer.rendererHistoryLength(), 20);
    assert.equal(compactJson.includes("prompt-secret"), false);
    assert.equal(compactJson.includes("assistant-secret"), false);
    assert.equal(compactJson.includes("queued prompt should be omitted"), false);
    assert.equal(compactJson.includes("composer-prompt-secret"), false);
    assert.equal(compactJson.includes("command-secret"), false);
    assert.equal(compactJson.includes("secret.example.test"), false);
    assert.equal(compactJson.includes("private provider response"), false);
    assert.equal(compactJson.includes("bearer secret"), false);
    assert.equal(compactJson.includes("recent event secret"), false);
    assert.equal(compactJson.includes("usage payload secret"), false);
    assert.equal(compactJson.includes("dictation-transcript-secret"), false);
    assert.equal(compactJson.includes("dictation-audio-secret"), false);
    assert.equal(compactJson.includes("dictation-sdp-secret"), false);
    assert.equal(compactJson.includes("dictation-credential-secret"), false);
    assert.equal(compactJson.includes("dictation-response-secret"), false);
    assert.equal(compactJson.includes("dictation-error-secret"), false);
    assert.equal(compactJson.includes("nested-dictation-response-secret"), false);
    assert.equal(compactJson.includes("nested-dictation-error-secret"), false);
    assert.equal(compactJson.includes("daemon stream secret"), false);
    assert.equal(compactJson.includes('"laggingDisconnectCount":7'), true);
    assert.equal(compactJson.includes('"lastDurationMs":5123'), true);
    assert.equal(compactJson.includes("gpt-5.6-sol"), true);
    assert.equal(compactJson.includes("ultra"), true);
    assert.equal(compactJson.includes("provider-running-tool"), true);
    assert.equal(compactJson.includes("debug-pruned"), true);
    const compactDictation = (compact.renderer as Record<string, unknown>).dictation as Record<
      string,
      unknown
    >;
    assert.deepInclude(compactDictation, {
      capturedAt: "2026-08-27T10:00:00.000Z",
      operationElapsedMs: 1_250.13,
      stageElapsedMs: 75.5,
      attemptElapsedMs: 75.5,
      stage: "sdp_exchange",
      outcome: "failed",
      attempt: 3,
      maxAttempts: 3,
      requestDurationMs: 75.5,
      httpStatus: 503,
      requestId: "req_safe-123",
      openAiProcessingMs: 63.25,
      retryAfterMs: 1_000,
      responseContentTypeCategory: "json",
      responseContentLengthBytes: 98,
      providerErrorType: "server_error",
      providerErrorCode: "internal_error",
      responseBodyBytes: 98,
      responseBodySha256: "a".repeat(64),
      responseBodyTruncated: true,
      sessionProfile: "transcription_pcm24k_minimal_v1",
      clientSecretModel: "gpt-live-transcribe",
      clientSecretLifetimeMs: 60_000,
      clientSecretRequestId: "req_mint-123",
      clientSecretRequestDurationMs: 42.13,
      clientSecretOpenAiProcessingMs: 21.5,
      clientSecretEffectiveProfile: "matches",
      offerSdpBytes: 1_024,
      offerSdpLineCount: 24,
      offerMediaSectionCount: 2,
      offerAudioSectionCount: 1,
      offerApplicationSectionCount: 1,
      offerCandidateCount: 3,
      offerHasOpus: true,
      offerHasIceCandidate: true,
      answerSdpBytes: 864,
      answerSdpLineCount: 20,
      answerMediaSectionCount: 2,
      answerAudioSectionCount: 1,
      answerApplicationSectionCount: 1,
      answerCandidateCount: 2,
      answerHasOpus: true,
      answerHasIceCandidate: true,
      peerConnectionState: "connecting",
      iceConnectionState: "checking",
      iceGatheringState: "complete",
      signalingState: "stable",
      dataChannelState: "connecting",
      audioTrackCount: 1,
      audioTrackState: "live",
      audioTrackEnabled: true,
      audioTrackMuted: false,
      audioSampleRate: 48_000,
      audioChannelCount: 1,
      audioSampleSize: 16,
      audioEchoCancellation: true,
      audioNoiseSuppression: true,
      audioAutoGainControl: true,
      errorCode: "upstream_unavailable",
      omittedTimelineEntryCount: 0,
    });
    const dictationTimeline = compactDictation.timeline as ReadonlyArray<Record<string, unknown>>;
    assert.equal(dictationTimeline.length, 1);
    assert.deepInclude(dictationTimeline[0] ?? {}, {
      capturedAt: "2026-08-27T09:59:59.000Z",
      operationElapsedMs: 250,
      stageElapsedMs: 75,
      attemptElapsedMs: 75,
      stage: "sdp_exchange",
      outcome: "retrying",
      attempt: 1,
      httpStatus: 500,
      requestId: "req_timeline-1",
      responseBodyBytes: 98,
      responseBodySha256: "b".repeat(64),
      responseBodyTruncated: true,
      providerErrorType: "server_error",
      providerErrorCode: "internal_error",
      errorCode: "upstream_unavailable",
    });
    assert.ok(Buffer.byteLength(compactJson, "utf8") < 80_000);
  });

  it("rejects malformed dictation diagnostic fields at the desktop boundary", () => {
    debugServer.reset();
    debugServer.publishRendererSnapshot({
      ...makeLargeRendererSnapshot(1),
      dictation: {
        capturedAt: "not-a-timestamp",
        stage: "transcript-secret",
        outcome: "provider-body-secret",
        attempt: 999,
        maxAttempts: -1,
        operationElapsedMs: Number.POSITIVE_INFINITY,
        stageElapsedMs: -1,
        attemptElapsedMs: 100_000_000,
        requestDurationMs: "provider-duration-secret",
        httpStatus: 999,
        requestId: "sk_provider_request_secret",
        openAiProcessingMs: -1,
        retryAfterMs: 100_000_000,
        responseContentTypeCategory: "application/provider-body-secret",
        responseContentLengthBytes: 999_999_999,
        providerErrorType: "sk_provider_type_secret",
        providerErrorCode: "Bearer_provider_code_secret",
        responseBodyBytes: -1,
        responseBodySha256: "provider-body-secret",
        responseBodyTruncated: "provider-truncation-secret",
        sessionProfile: "transcription_pcm24k_minimal_v1_debug",
        clientSecretModel: "gpt-live-transcribe-preview",
        clientSecretLifetimeMs: 100_000_000,
        clientSecretRequestId: "ek_provider_mint_secret",
        clientSecretRequestDurationMs: Number.NaN,
        clientSecretOpenAiProcessingMs: -1,
        clientSecretEffectiveProfile: "provider-profile-secret",
        offerSdpBytes: -1,
        offerSdpLineCount: 20_000,
        offerMediaSectionCount: 200,
        offerAudioSectionCount: 200,
        offerApplicationSectionCount: -1,
        offerCandidateCount: 5_000,
        offerHasOpus: "provider-opus-secret",
        offerHasIceCandidate: "provider-candidate-secret",
        answerSdpBytes: 200_000_000,
        answerSdpLineCount: -1,
        answerMediaSectionCount: 200,
        answerAudioSectionCount: 200,
        answerApplicationSectionCount: -1,
        answerCandidateCount: 5_000,
        answerHasOpus: "provider-answer-opus-secret",
        answerHasIceCandidate: "provider-answer-candidate-secret",
        peerConnectionState: "provider-peer-secret",
        iceConnectionState: "provider-ice-secret",
        iceGatheringState: "provider-gather-secret",
        signalingState: "provider-signal-secret",
        dataChannelState: "provider-channel-secret",
        audioTrackCount: 100,
        audioTrackState: "provider-audio-secret",
        audioTrackEnabled: "provider-enabled-secret",
        audioTrackMuted: "provider-muted-secret",
        audioSampleRate: 1_000_000,
        audioChannelCount: 0,
        audioSampleSize: 128,
        audioEchoCancellation: "provider-echo-secret",
        audioNoiseSuppression: "provider-noise-secret",
        audioAutoGainControl: "provider-gain-secret",
        errorCode: "raw-provider-error-secret",
        timeline: [
          "nested-provider-secret",
          {
            capturedAt: "nested timestamp secret",
            stage: "nested-stage-secret",
            requestId: "sk_nested_request_secret",
            providerErrorCode: "Bearer_nested_error_secret",
            responseBody: "nested response body secret",
          },
        ],
        omittedTimelineEntryCount: -1,
      },
    });

    const compact = debugServer.buildCompactDebugSnapshot();

    const compactDictation = (compact.renderer as Record<string, unknown>).dictation as Record<
      string,
      unknown
    >;
    assert.deepInclude(compactDictation, {
      capturedAt: null,
      operationElapsedMs: null,
      stageElapsedMs: null,
      attemptElapsedMs: null,
      stage: null,
      outcome: null,
      attempt: null,
      maxAttempts: null,
      requestDurationMs: null,
      httpStatus: null,
      requestId: null,
      openAiProcessingMs: null,
      retryAfterMs: null,
      responseContentTypeCategory: null,
      responseContentLengthBytes: null,
      providerErrorType: "other",
      providerErrorCode: "other",
      responseBodyBytes: null,
      responseBodySha256: null,
      responseBodyTruncated: null,
      sessionProfile: null,
      clientSecretModel: null,
      clientSecretLifetimeMs: null,
      clientSecretRequestId: null,
      clientSecretRequestDurationMs: null,
      clientSecretOpenAiProcessingMs: null,
      clientSecretEffectiveProfile: null,
      offerSdpBytes: null,
      offerSdpLineCount: null,
      offerMediaSectionCount: null,
      offerAudioSectionCount: null,
      offerApplicationSectionCount: null,
      offerCandidateCount: null,
      offerHasOpus: null,
      offerHasIceCandidate: null,
      answerSdpBytes: null,
      answerSdpLineCount: null,
      answerMediaSectionCount: null,
      answerAudioSectionCount: null,
      answerApplicationSectionCount: null,
      answerCandidateCount: null,
      answerHasOpus: null,
      answerHasIceCandidate: null,
      peerConnectionState: null,
      iceConnectionState: null,
      iceGatheringState: null,
      signalingState: null,
      dataChannelState: null,
      audioTrackCount: null,
      audioTrackState: null,
      audioTrackEnabled: null,
      audioTrackMuted: null,
      audioSampleRate: null,
      audioChannelCount: null,
      audioSampleSize: null,
      audioEchoCancellation: null,
      audioNoiseSuppression: null,
      audioAutoGainControl: null,
      errorCode: null,
      omittedTimelineEntryCount: 0,
    });
    const compactTimeline = compactDictation.timeline as ReadonlyArray<Record<string, unknown>>;
    assert.equal(compactTimeline.length, 1);
    assert.equal(compactTimeline[0]?.requestId, null);
    assert.equal(compactTimeline[0]?.providerErrorCode, "other");
    const compactJson = JSON.stringify(compact);
    assert.equal(compactJson.includes("bearer-secret"), false);
    assert.equal(compactJson.includes("raw-provider-error-secret"), false);
    assert.equal(compactJson.includes("provider-body-secret"), false);
    assert.equal(compactJson.includes("provider-profile-secret"), false);
    assert.equal(compactJson.includes("provider-truncation-secret"), false);
    assert.equal(compactJson.includes("provider-opus-secret"), false);
    assert.equal(compactJson.includes("provider-echo-secret"), false);
    assert.equal(compactJson.includes("sk_provider_type_secret"), false);
    assert.equal(compactJson.includes("Bearer_provider_code_secret"), false);
    assert.equal(compactJson.includes("sk_provider_request_secret"), false);
    assert.equal(compactJson.includes("ek_provider_mint_secret"), false);
    assert.equal(compactJson.includes("nested-provider-secret"), false);
    assert.equal(compactJson.includes("Bearer_nested_error_secret"), false);
    assert.equal(compactJson.includes("nested response body secret"), false);
  });

  it("revalidates and caps an oversized renderer dictation timeline", () => {
    debugServer.reset();
    debugServer.publishRendererSnapshot({
      ...makeLargeRendererSnapshot(1),
      dictation: {
        capturedAt: "2026-08-27T10:00:00.000Z",
        stage: "sdp_exchange",
        outcome: "failed",
        attempt: 3,
        maxAttempts: 3,
        errorCode: "upstream_unavailable",
        omittedTimelineEntryCount: 5,
        timeline: Array.from({ length: 40 }, (_, index) => ({
          capturedAt: new Date(Date.parse("2026-08-27T09:00:00.000Z") + index).toISOString(),
          operationElapsedMs: index,
          stageElapsedMs: index,
          attemptElapsedMs: index,
          stage: "sdp_exchange",
          outcome: "retrying",
          attempt: 1,
          maxAttempts: 3,
          httpStatus: 500,
          requestId: `req_timeline-${index}`,
          responseBodySha256: index.toString(16).padStart(64, "0"),
          errorCode: "upstream_unavailable",
          responseBody: `oversized-timeline-provider-secret-${index}`,
        })),
      },
    });

    const compact = debugServer.buildCompactDebugSnapshot();
    const compactDictation = (compact.renderer as Record<string, unknown>).dictation as Record<
      string,
      unknown
    >;
    const timeline = compactDictation.timeline as ReadonlyArray<Record<string, unknown>>;

    assert.equal(timeline.length, 32);
    assert.equal(compactDictation.omittedTimelineEntryCount, 13);
    assert.equal(timeline[0]?.requestId, "req_timeline-8");
    assert.equal(timeline[31]?.requestId, "req_timeline-39");
    assert.equal(JSON.stringify(compact).includes("oversized-timeline-provider-secret"), false);
  });

  it("keeps full debug explicit for local forensic reads", () => {
    debugServer.reset();
    debugServer.publishRendererSnapshot(makeLargeRendererSnapshot(1));
    debugServer.publishProviderDaemonSnapshot(makeLargeProviderDaemonSnapshot());

    const full = debugServer.buildFullDebugSnapshot();
    const fullJson = JSON.stringify(full);

    assert.equal((full.debug as Record<string, unknown>).detail, "full");
    assert.equal(fullJson.includes("prompt-secret-1"), true);
    assert.equal(fullJson.includes("command-secret-1"), true);
  });

  it("reports provider-to-renderer freshness lag without reading content previews", () => {
    debugServer.reset();
    debugServer.publishRendererSnapshot({
      ...makeLargeRendererSnapshot(1),
      performance: {
        rendererSnapshotBuildDurationMs: 12,
        activeThread: {
          latestMessage: {
            createdAt: "2026-05-26T00:00:00.000Z",
            textPreview: "hidden assistant text",
          },
        },
      },
    });
    debugServer.publishProviderDaemonSnapshot({
      ...makeLargeProviderDaemonSnapshot(),
      lastHealth: {
        ...makeLargeProviderDaemonSnapshot().lastHealth,
        runtimeEvents: {
          lastEventAt: "2026-05-26T00:03:00.000Z",
          lastThreadId: "thread-1",
          lastTurnId: "turn-1",
        },
      },
    });

    const compact = debugServer.buildCompactDebugSnapshot();
    const freshness = compact.freshness as Record<string, unknown>;

    assert.equal(freshness.status, "offline");
    assert.equal(freshness.activeThreadId, "thread-1");
    assert.equal(freshness.providerLastThreadId, "thread-1");
    assert.equal(freshness.lagMs, 179_000);
    assert.equal(JSON.stringify(freshness).includes("hidden assistant text"), false);
  });

  it("uses cached provider daemon snapshots for ordinary debug reads", async () => {
    debugServer.reset();
    debugServer.publishProviderDaemonSnapshot(makeLargeProviderDaemonSnapshot());
    debugServer.setProviderDaemonSnapshotUpdatedAt("9999-01-01T00:00:00.000Z");
    let refreshCount = 0;
    debugServer.setProviderDaemonSnapshotRefresher(async () => {
      refreshCount += 1;
      debugServer.publishProviderDaemonSnapshot(makeLargeProviderDaemonSnapshot());
    });

    await debugServer.prepareProviderDaemonSnapshotForDebugRequest(false);
    assert.equal(refreshCount, 0);
    assert.equal(debugServer.getProviderDaemonRefreshAttemptCount(), 0);

    await debugServer.prepareProviderDaemonSnapshotForDebugRequest(true);
    assert.equal(refreshCount, 1);
    assert.equal(debugServer.getProviderDaemonRefreshAttemptCount(), 1);

    let resolveBackgroundRefresh!: () => void;
    const backgroundRefreshCompleted = new Promise<void>((resolve) => {
      resolveBackgroundRefresh = resolve;
    });
    debugServer.setProviderDaemonSnapshotRefresher(async () => {
      refreshCount += 1;
      debugServer.publishProviderDaemonSnapshot(makeLargeProviderDaemonSnapshot());
      resolveBackgroundRefresh();
    });
    debugServer.setProviderDaemonSnapshotUpdatedAt("1970-01-01T00:00:00.000Z");
    await debugServer.prepareProviderDaemonSnapshotForDebugRequest(false);
    await backgroundRefreshCompleted;

    assert.equal(refreshCount, 2);
    assert.equal(debugServer.getProviderDaemonRefreshAttemptCount(), 2);
  });
});
