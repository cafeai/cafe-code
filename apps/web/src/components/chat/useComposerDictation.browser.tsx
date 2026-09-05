import type {
  DictationRealtimeClientSecret,
  DictationTranscriptionModel,
} from "@cafecode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

import type {
  RealtimeTranscriptionSession,
  StartRealtimeTranscriptionInput,
} from "~/dictation/realtimeTranscription";

const dictationHarness = vi.hoisted(() => ({
  startRealtimeTranscription: vi.fn(),
  latestInput: null as StartRealtimeTranscriptionInput | null,
}));

vi.mock("~/dictation/realtimeTranscription", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/dictation/realtimeTranscription")>()),
  startRealtimeTranscription: dictationHarness.startRealtimeTranscription,
}));

import { useComposerDictation } from "~/hooks/useComposerDictation";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

interface PromptState {
  value: string;
}

async function renderDictationController(prompt: PromptState, onError = vi.fn()) {
  return renderHook(() =>
    useComposerDictation({
      enabled: true,
      sessionKey: "test-session",
      createClientSecret: async (
        model: DictationTranscriptionModel,
      ): Promise<DictationRealtimeClientSecret> => ({
        clientSecret: "ephemeral-test-token",
        expiresAt: Date.now() + 60_000,
        model,
        sessionProfile: "transcription_pcm24k_minimal_v1",
      }),
      readComposerSnapshot: () => ({
        value: prompt.value,
        expandedCursor: prompt.value.length,
      }),
      replaceComposerRange: (input) => {
        if (prompt.value.slice(input.start, input.end) !== input.expectedText) return false;
        prompt.value = `${prompt.value.slice(0, input.start)}${input.replacement}${prompt.value.slice(input.end)}`;
        return true;
      },
      onError,
    }),
  );
}

function emitTranscript(transcript: string): void {
  const input = dictationHarness.latestInput;
  if (!input) throw new Error("Dictation transport input was not captured");
  input.onTranscript({
    transcript,
    // The hook intentionally treats the provider event as opaque; its only
    // responsibility here is applying the transport's selected transcript.
    event: {} as never,
  });
}

describe("useComposerDictation finalization boundary", () => {
  beforeEach(() => {
    dictationHarness.latestInput = null;
    dictationHarness.startRealtimeTranscription.mockReset();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("waits for the authoritative final transcript before allowing Send", async () => {
    const finalization = deferred<void>();
    const session: RealtimeTranscriptionSession = {
      cancel: vi.fn(),
      stopAndFinalize: vi.fn(() => finalization.promise),
    };
    dictationHarness.startRealtimeTranscription.mockImplementation(
      async (input: StartRealtimeTranscriptionInput) => {
        dictationHarness.latestInput = input;
        return session;
      },
    );
    const prompt = { value: "" };
    const hook = await renderDictationController(prompt);
    const onSend = vi.fn();

    await hook.act(async () => {
      hook.result.current.toggle();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(hook.result.current.phase).toBe("recording"));
    await hook.act(() => emitTranscript("interim words"));

    let finishAndSend!: Promise<void>;
    await hook.act(() => {
      finishAndSend = hook.result.current.finish().then((ready) => {
        if (ready) onSend(prompt.value);
      });
    });
    await vi.waitFor(() => expect(hook.result.current.phase).toBe("finalizing"));
    expect(onSend).not.toHaveBeenCalled();

    await hook.act(async () => {
      emitTranscript("interim words plus final words");
      finalization.resolve(undefined);
      await finishAndSend;
    });

    expect(onSend).toHaveBeenCalledOnce();
    expect(onSend).toHaveBeenCalledWith("interim words plus final words");
    expect(session.stopAndFinalize).toHaveBeenCalledOnce();
  });

  it("waits through microphone startup before finalizing and sending", async () => {
    const startup = deferred<RealtimeTranscriptionSession>();
    const finalization = deferred<void>();
    const session: RealtimeTranscriptionSession = {
      cancel: vi.fn(),
      stopAndFinalize: vi.fn(() => finalization.promise),
    };
    dictationHarness.startRealtimeTranscription.mockImplementation(
      (input: StartRealtimeTranscriptionInput) => {
        dictationHarness.latestInput = input;
        return startup.promise;
      },
    );
    const prompt = { value: "" };
    const hook = await renderDictationController(prompt);
    const onSend = vi.fn();

    await hook.act(() => hook.result.current.toggle());
    expect(hook.result.current.phase).toBe("starting");
    let finishAndSend!: Promise<void>;
    await hook.act(() => {
      finishAndSend = hook.result.current.finish().then((ready) => {
        if (ready) onSend(prompt.value);
      });
    });
    expect(onSend).not.toHaveBeenCalled();
    expect(session.stopAndFinalize).not.toHaveBeenCalled();

    await hook.act(async () => {
      startup.resolve(session);
      await startup.promise;
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(session.stopAndFinalize).toHaveBeenCalledOnce());
    await hook.act(async () => {
      emitTranscript("final startup transcript");
      finalization.resolve(undefined);
      await finishAndSend;
    });

    expect(onSend).toHaveBeenCalledOnce();
    expect(onSend).toHaveBeenCalledWith("final startup transcript");
  });

  it("does not release an interim transcript when finalization fails", async () => {
    const session: RealtimeTranscriptionSession = {
      cancel: vi.fn(),
      stopAndFinalize: vi.fn(async () => {
        throw new Error("provider finalization failed");
      }),
    };
    dictationHarness.startRealtimeTranscription.mockImplementation(
      async (input: StartRealtimeTranscriptionInput) => {
        dictationHarness.latestInput = input;
        return session;
      },
    );
    const prompt = { value: "" };
    const onError = vi.fn();
    const hook = await renderDictationController(prompt, onError);
    const onSend = vi.fn();

    await hook.act(async () => {
      hook.result.current.toggle();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(hook.result.current.phase).toBe("recording"));
    await hook.act(() => emitTranscript("unsafe interim text"));
    await hook.act(async () => {
      const ready = await hook.result.current.finish();
      if (ready) onSend(prompt.value);
    });

    expect(hook.result.current.phase).toBe("error");
    expect(onSend).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });
});
