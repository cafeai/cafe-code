import { expect, it, vi } from "vitest";
import {
  NativeFixtureRetirementRecorder,
  type NativeFixtureRetirementContents,
  type NativeFixtureRetirementSurface,
} from "./nativeVisualizationFixtureRetirement.ts";
import { VISUALIZATION_SCHEME } from "./visualizationHostPolicy.ts";

/** In-memory sequencing only: no native process, real PID, profile or API call.
 * The recorder must observe production's decision, never manufacture a crash. */
function fixture(pid = 120) {
  const generation = `fixture-${pid}`;
  const state = {
    phase: "active",
    exclusiveProcess: true,
    frameCount: 1,
    rendererCount: 1,
    gone: false,
    destroyed: false,
  };
  const controls = {
    invoke: true,
    twice: false,
    beforeCrash: () => {},
    nativeError: undefined as Error | undefined,
  };
  let resolve!: (retired: boolean) => void;
  let reject!: (error: unknown) => void;
  const pending = new Promise<boolean>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  const nativeCall = vi.fn(function (this: NativeFixtureRetirementContents) {
    if (controls.nativeError) throw controls.nativeError;
  });
  const contents: NativeFixtureRetirementContents = {
    isDestroyed: () => state.destroyed,
    getURL: () => `${VISUALIZATION_SCHEME}://${generation}/bootstrap`,
    getOSProcessId: () => pid,
    mainFrame: {
      frameToken: "exact-root",
      osProcessId: pid,
      framesInSubtree: [{ osProcessId: pid }],
    },
    forcefullyCrashRenderer: nativeCall,
  };
  const nativeRetire = vi.fn(function (this: NativeFixtureRetirementSurface, _budget?: number) {
    state.phase = "retiring";
    controls.beforeCrash();
    if (controls.invoke) contents.forcefullyCrashRenderer();
    if (controls.twice) contents.forcefullyCrashRenderer();
    return pending;
  });
  const surface: NativeFixtureRetirementSurface = {
    generation,
    retire: nativeRetire,
    diagnostics: () => ({ ...state }),
  };
  const complete = (retired = true, gone = true, destroyed = true) => {
    Object.assign(state, { phase: retired ? "retired" : "quarantined", gone, destroyed });
    resolve(retired);
  };
  return {
    state,
    controls,
    pending,
    reject,
    nativeCall,
    nativeRetire,
    contents,
    surface,
    complete,
  };
}

it("observes only the real exact-owned call followed by gone/destroyed retirement", async () => {
  const value = fixture(),
    recorder = new NativeFixtureRetirementRecorder("linux", 1);
  recorder.observe(value.surface, () => value.contents);
  recorder.observe(value.surface, () => value.contents);
  expect(recorder.pids()).toEqual([]);
  const result = value.surface.retire(731);
  expect(result).toBe(value.pending);
  expect(value.nativeRetire.mock.contexts).toEqual([value.surface]);
  expect(value.nativeRetire).toHaveBeenCalledWith(731);
  expect(value.nativeCall.mock.contexts).toEqual([value.contents]);
  expect(value.nativeCall).toHaveBeenCalledExactlyOnceWith();
  expect(recorder.pids()).toEqual([]);
  value.complete();
  await expect(result).resolves.toBe(true);
  expect(recorder.pids()).toEqual([120]);
  expect(value.contents.forcefullyCrashRenderer).toBe(value.nativeCall);
  expect(value.surface.retire()).toBe(value.pending);
  expect(value.nativeCall).toHaveBeenCalledTimes(2);
  // Repeated native retire semantics remain the original function's behavior,
  // but no second classification witness is fabricated from its cached result.
  expect(recorder.pids()).toEqual([120]);
});

it("does not instrument or grant witnesses on non-Linux hosts", async () => {
  for (const platform of ["darwin", "win32", "unknown"]) {
    const value = fixture(),
      recorder = new NativeFixtureRetirementRecorder(platform, 1);
    recorder.observe(value.surface, () => value.contents);
    expect(value.surface.retire).toBe(value.nativeRetire);
    const result = value.surface.retire();
    value.complete();
    await result;
    expect(recorder.pids()).toEqual([]);
  }
});

it("refuses missing, early, foreign, shared and changed native identity witnesses", async () => {
  for (const change of [
    (value: ReturnType<typeof fixture>) => {
      value.controls.invoke = false;
    },
    (value: ReturnType<typeof fixture>) => {
      value.controls.twice = true;
    },
    (value: ReturnType<typeof fixture>) => {
      value.controls.beforeCrash = () => {
        value.state.gone = true;
      };
    },
    (value: ReturnType<typeof fixture>) => {
      value.controls.beforeCrash = () => {
        value.state.exclusiveProcess = false;
      };
    },
    (value: ReturnType<typeof fixture>) => {
      value.controls.beforeCrash = () => {
        value.state.frameCount = 2;
      };
    },
    (value: ReturnType<typeof fixture>) => {
      value.controls.beforeCrash = () => {
        value.state.rendererCount = 2;
      };
    },
    (value: ReturnType<typeof fixture>) => {
      value.controls.beforeCrash = () => {
        value.contents.mainFrame.frameToken = "changed-root";
      };
    },
    (value: ReturnType<typeof fixture>) => {
      value.controls.beforeCrash = () => {
        value.contents.getOSProcessId = () => 130;
        value.contents.mainFrame.osProcessId = 130;
        value.contents.mainFrame.framesInSubtree = [{ osProcessId: 130 }];
      };
    },
    (value: ReturnType<typeof fixture>) => {
      value.contents.getURL = () => "https://foreign.invalid/private";
    },
    (value: ReturnType<typeof fixture>) => {
      value.contents.getOSProcessId = () => 0;
    },
    (value: ReturnType<typeof fixture>) => {
      value.contents.mainFrame.framesInSubtree = [{ osProcessId: 120 }, { osProcessId: 120 }];
    },
  ]) {
    const value = fixture(),
      recorder = new NativeFixtureRetirementRecorder("linux", 1);
    change(value);
    recorder.observe(value.surface, () => value.contents);
    const result = value.surface.retire();
    value.complete();
    await result;
    expect(recorder.pids()).toEqual([]);
  }
});

it("requires true retirement and both observed native terminal states", async () => {
  for (const outcome of [
    [false, true, true],
    [true, false, true],
    [true, true, false],
  ]) {
    const value = fixture(),
      recorder = new NativeFixtureRetirementRecorder("linux", 1);
    recorder.observe(value.surface, () => value.contents);
    const result = value.surface.retire();
    value.complete(outcome[0], outcome[1], outcome[2]);
    await result;
    expect(recorder.pids()).toEqual([]);
    expect(value.contents.forcefullyCrashRenderer).toBe(value.nativeCall);
  }
});

it("preserves synchronous native errors and asynchronous retirement rejection", async () => {
  const value = fixture(),
    recorder = new NativeFixtureRetirementRecorder("linux", 1);
  const nativeError = new Error("fixed native test refusal");
  value.controls.nativeError = nativeError;
  recorder.observe(value.surface, () => value.contents);
  expect(() => value.surface.retire(12)).toThrow(nativeError);
  expect(value.contents.forcefullyCrashRenderer).toBe(value.nativeCall);
  expect(recorder.pids()).toEqual([]);
  const failed = fixture(121),
    other = new NativeFixtureRetirementRecorder("linux", 1);
  other.observe(failed.surface, () => failed.contents);
  const result = failed.surface.retire();
  const rejection = new Error("fixed retirement test refusal");
  failed.reject(rejection);
  await expect(result).rejects.toBe(rejection);
  expect(other.pids()).toEqual([]);
  expect(failed.contents.forcefullyCrashRenderer).toBe(failed.nativeCall);
});

it("does not manufacture a witness for a foreign receiver or lookup uncertainty", async () => {
  const value = fixture(),
    recorder = new NativeFixtureRetirementRecorder("linux", 1);
  recorder.observe(value.surface, () => value.contents);
  const foreign = { ...value.surface };
  const result = Reflect.apply(value.surface.retire, foreign, [111]) as Promise<boolean>;
  value.complete();
  await result;
  expect(value.nativeRetire.mock.contexts).toEqual([foreign]);
  expect(recorder.pids()).toEqual([]);
  for (const lookup of [
    () => undefined,
    () => {
      throw new Error("fixed observation refusal");
    },
  ]) {
    const absent = fixture(122),
      other = new NativeFixtureRetirementRecorder("linux", 1);
    other.observe(absent.surface, lookup);
    const pending = absent.surface.retire();
    absent.complete();
    await pending;
    expect(other.pids()).toEqual([]);
    expect(absent.nativeCall).toHaveBeenCalledTimes(1);
  }
});

it("refuses duplicate PID generations and bounded-recorder overflow", async () => {
  const recorder = new NativeFixtureRetirementRecorder("linux", 3);
  for (const pid of [120, 120]) {
    const value = fixture(pid);
    recorder.observe(value.surface, () => value.contents);
    const result = value.surface.retire();
    value.complete();
    await result;
  }
  expect(recorder.pids()).toEqual([]);
  const bounded = new NativeFixtureRetirementRecorder("linux", 1);
  for (const pid of [121, 122]) {
    const value = fixture(pid);
    bounded.observe(value.surface, () => value.contents);
    const result = value.surface.retire();
    value.complete();
    await result;
  }
  expect(bounded.pids()).toEqual([]);
});
