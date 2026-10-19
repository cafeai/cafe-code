import { VISUALIZATION_SCHEME } from "./visualizationHostPolicy.ts";

/** Structural native observations keep this helper usable in pure sequencing
 * tests without importing or launching Electron. Production never imports it.
 * No received source selects a PID or grants process retirement authority. */
export interface NativeFixtureRetirementContents {
  isDestroyed(): boolean;
  getURL(): string;
  getOSProcessId(): number;
  mainFrame: {
    frameToken: string;
    osProcessId: number;
    framesInSubtree: readonly { osProcessId: number }[];
  };
  forcefullyCrashRenderer(): void;
}

export interface NativeFixtureRetirementSurface {
  readonly generation: string;
  retire(budgetMs?: number): Promise<boolean>;
  diagnostics(): {
    phase: string;
    exclusiveProcess: boolean;
    frameCount: number;
    rendererCount: number;
    gone: boolean;
    destroyed: boolean;
  };
}

/** Record only the real exact-owned native crash invocation followed by actual
 * successful retirement. Electron42's Linux forcefullyCrashRenderer sends
 * RenderProcessHost::ForceCrash, whose Chromium148 CrashHungProcess emits the
 * fixed FATAL message. A matching log alone is never a witness. This recorder
 * observes, but neither requests a crash nor changes any production admission,
 * kill/close fallback, retirement budget or uncertainty handling.
 * https://github.com/electron/electron/blob/v42.11.15/shell/browser/api/electron_api_web_contents.cc#L3101
 * https://github.com/chromium/chromium/blob/148.0.7778.280/content/child/child_thread_impl.cc#L375 */
export class NativeFixtureRetirementRecorder {
  private readonly proven = new Set<number>();
  private readonly surfaces = new WeakSet<NativeFixtureRetirementSurface>();
  private count = 0;
  private invalid = false;
  private readonly platform: string;
  private readonly maximum: 1 | 3;

  constructor(platform: string, maximum: 1 | 3) {
    // Explicit fields retain Node's erasable-only TypeScript contract without
    // introducing a parameter-property transform or alternate runtime.
    this.platform = platform;
    this.maximum = maximum;
  }

  observe(
    surface: NativeFixtureRetirementSurface,
    findContents: () => NativeFixtureRetirementContents | undefined,
  ): void {
    if (this.platform !== "linux" || this.surfaces.has(surface)) return;
    this.surfaces.add(surface);
    if (++this.count > this.maximum) {
      this.invalid = true;
      return;
    }
    const recorder = this;
    const originalRetire = surface.retire;
    let started = false;
    surface.retire = function (this: NativeFixtureRetirementSurface, ...args: [number?]) {
      // Preserve the original receiver, arguments, Promise identity and throw
      // behavior even for a foreign receiver or repeated cached retirement.
      if (this !== surface || started)
        return Reflect.apply(originalRetire, this, args) as Promise<boolean>;
      started = true;
      let contents: NativeFixtureRetirementContents | undefined;
      try {
        contents = findContents();
      } catch {
        /* Observation uncertainty grants no witness. */
      }
      const initial = contents ? recorder.identity(surface, contents) : undefined;
      if (!contents || !initial)
        return Reflect.apply(originalRetire, this, args) as Promise<boolean>;
      const nativeContents = contents;
      const originalCrash = nativeContents.forcefullyCrashRenderer;
      let called = false;
      let valid = true;
      const observedCrash = function (
        this: NativeFixtureRetirementContents,
        ...nativeArgs: unknown[]
      ) {
        // The production method has just reverified exact stored PID/root token
        // plus native process exclusivity. Independently require the same exact
        // generation/frame/PID and live not-yet-gone state at the real call.
        const current = recorder.identity(surface, nativeContents);
        let diagnostics: ReturnType<NativeFixtureRetirementSurface["diagnostics"]> | undefined;
        try {
          diagnostics = surface.diagnostics();
        } catch {
          valid = false;
        }
        if (
          called ||
          this !== nativeContents ||
          !current ||
          current.pid !== initial.pid ||
          current.frameToken !== initial.frameToken ||
          diagnostics?.phase !== "retiring" ||
          diagnostics.exclusiveProcess !== true ||
          diagnostics.frameCount !== 1 ||
          diagnostics.rendererCount !== 1 ||
          diagnostics.gone !== false ||
          diagnostics.destroyed !== false
        )
          valid = false;
        called = true;
        try {
          return Reflect.apply(originalCrash, this, nativeArgs);
        } catch (error) {
          valid = false;
          throw error;
        }
      };
      try {
        nativeContents.forcefullyCrashRenderer = observedCrash;
      } catch {
        return Reflect.apply(originalRetire, this, args) as Promise<boolean>;
      }
      const finish = (retired: boolean) => {
        try {
          const diagnostics = surface.diagnostics();
          if (
            valid &&
            called &&
            retired === true &&
            nativeContents.forcefullyCrashRenderer === observedCrash &&
            diagnostics.phase === "retired" &&
            diagnostics.gone === true &&
            diagnostics.destroyed === true &&
            !recorder.proven.has(initial.pid) &&
            recorder.proven.size < recorder.maximum
          )
            recorder.proven.add(initial.pid);
          else recorder.invalid = true;
        } catch {
          recorder.invalid = true;
        } finally {
          try {
            if (nativeContents.forcefullyCrashRenderer === observedCrash)
              nativeContents.forcefullyCrashRenderer = originalCrash;
          } catch {
            recorder.invalid = true;
          }
        }
      };
      let result: Promise<boolean>;
      try {
        result = Reflect.apply(originalRetire, this, args) as Promise<boolean>;
      } catch (error) {
        finish(false);
        throw error;
      }
      // Observe completion without replacing the original Promise. Registering
      // now places this bounded synchronous observation before the host's await
      // continuation; neither rejection nor observation failure becomes success.
      void result.then(finish, () => finish(false));
      return result;
    };
  }

  private identity(
    surface: NativeFixtureRetirementSurface,
    contents: NativeFixtureRetirementContents,
  ) {
    try {
      const pid = contents.getOSProcessId(),
        frame = contents.mainFrame;
      if (
        contents.isDestroyed() ||
        contents.getURL() !== `${VISUALIZATION_SCHEME}://${surface.generation}/bootstrap` ||
        !Number.isSafeInteger(pid) ||
        pid <= 0 ||
        pid > 2_147_483_647 ||
        frame.osProcessId !== pid ||
        typeof frame.frameToken !== "string" ||
        frame.frameToken.length < 1 ||
        frame.frameToken.length > 128 ||
        frame.framesInSubtree.length !== 1 ||
        frame.framesInSubtree[0]?.osProcessId !== pid
      )
        return;
      return { pid, frameToken: frame.frameToken };
    } catch {
      return;
    }
  }

  /** Only fixed bounded native PIDs leave the recorder, after all observations.
   * Non-Linux remains empty; any uncertainty invalidates the whole witness set. */
  pids(): readonly number[] {
    return this.invalid ? [] : [...this.proven];
  }
}
