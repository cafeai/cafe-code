import { describe, expect, it } from "vitest";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProviderUpdateDiagnostics,
  type ServerProviderUpdateState,
} from "@cafecode/contracts";
import {
  captureProviderUpdateFailure,
  providerUpdateOutputForDisplay,
  providerUpdatePhaseLabel,
  providerUpdateCategoryLabel,
  sameProviderUpdateFailure,
  type FailureSnapshot,
} from "./ProviderUpdateFailureDetails.logic";

function snapshot() {
  return {
    environmentId: EnvironmentId.make("server-a"),
    instanceId: ProviderInstanceId.make("codex-personal"),
    driver: ProviderDriverKind.make("codex"),
    state: {
      status: "failed" as ServerProviderUpdateState["status"],
      startedAt: "2026-10-30T01:00:00.000Z",
      finishedAt: "2026-10-30T01:01:00.000Z",
      message: "Update command exited with code 1.",
      output: "private-command-output" as string | null,
      diagnostics: {
        phase: "command" as ServerProviderUpdateDiagnostics["phase"],
        category: "command_failed" as ServerProviderUpdateDiagnostics["category"],
        exitCode: 1 as number | null,
        timedOut: false as ServerProviderUpdateDiagnostics["timedOut"],
        stdoutTruncated: false as ServerProviderUpdateDiagnostics["stdoutTruncated"],
        stderrTruncated: false as ServerProviderUpdateDiagnostics["stderrTruncated"],
        outputTruncated: false as ServerProviderUpdateDiagnostics["outputTruncated"],
      },
    },
  } satisfies FailureSnapshot;
}

describe("provider update failure output display", () => {
  it("retains ordinary Unicode, hearts, HTML-looking text and whitespace as literal data", () => {
    const text = "日本語 💜❤️🩵🤍🩷💛💚\tline one\n<script>not executable</script>";
    expect(providerUpdateOutputForDisplay(text)).toEqual({
      text,
      controlsEscaped: false,
      displayTruncated: false,
    });
  });

  it("makes terminal and directional formatting controls visible without interpreting them", () => {
    expect(
      providerUpdateOutputForDisplay("\u001b[31m\u0000\u0085\u061c\u202e\u2066x\u2069"),
    ).toEqual({
      text: "\\u{1B}[31m\\u{0}\\u{85}\\u{61C}\\u{202E}\\u{2066}x\\u{2069}",
      controlsEscaped: true,
      displayTruncated: false,
    });
  });

  it("bounds both received text and expanded escapes without cutting an escape token", () => {
    expect(providerUpdateOutputForDisplay("x".repeat(10_000))).toMatchObject({
      text: "x".repeat(10_000),
      displayTruncated: false,
    });
    expect(providerUpdateOutputForDisplay("x".repeat(10_001))).toMatchObject({
      text: "x".repeat(10_000),
      displayTruncated: true,
    });
    const escaped = providerUpdateOutputForDisplay("\u001b".repeat(10_000));
    expect(escaped.text.length).toBeLessThanOrEqual(10_000);
    expect(escaped.text).toBe("\\u{1B}".repeat(Math.floor(10_000 / "\\u{1B}".length)));
    expect(escaped.controlsEscaped).toBe(true);
    expect(escaped.displayTruncated).toBe(true);
  });
});

describe("provider update reveal ownership", () => {
  it("captures owned primitive copies, leaves caller props mutable and accepts identical fresh polling values", () => {
    const source = snapshot();
    let futureReads = 0;
    Object.defineProperty(source.state.diagnostics, "futurePrivateField", {
      enumerable: true,
      get: () => {
        futureReads += 1;
        return "must-not-be-read";
      },
    });
    const captured = captureProviderUpdateFailure(source);
    // Vitest's object-valued toBe matcher eagerly tries deep equality for its
    // diagnostic, even when .not.toBe passes. Keep these exact reference
    // assertions primitive so the observer itself cannot invoke the sentinel.
    expect(Object.is(captured, source)).toBe(false);
    expect(Object.is(captured.state, source.state)).toBe(false);
    expect(Object.is(captured.state.diagnostics, source.state.diagnostics)).toBe(false);
    expect(Object.isFrozen(source.state)).toBe(false);
    expect(Object.isFrozen(source.state.diagnostics)).toBe(false);
    expect(Object.isFrozen(captured.state)).toBe(true);
    expect(sameProviderUpdateFailure(captured, snapshot())).toBe(true);
    expect(futureReads).toBe(0);
    expect(Object.keys(captured.state.diagnostics!)).toEqual([
      "phase",
      "category",
      "exitCode",
      "timedOut",
      "stdoutTruncated",
      "stderrTruncated",
      "outputTruncated",
    ]);
  });

  const changes: readonly [string, (source: ReturnType<typeof snapshot>) => void][] = [
    [
      "environment",
      (s) => {
        s.environmentId = EnvironmentId.make("server-b");
      },
    ],
    [
      "instance",
      (s) => {
        s.instanceId = ProviderInstanceId.make("codex-work");
      },
    ],
    [
      "driver",
      (s) => {
        s.driver = ProviderDriverKind.make("claudeAgent");
      },
    ],
    [
      "status",
      (s) => {
        s.state.status = "running";
      },
    ],
    [
      "start",
      (s) => {
        s.state.startedAt = "2026-10-30T01:02:00.000Z";
      },
    ],
    [
      "finish",
      (s) => {
        s.state.finishedAt = "2026-10-30T01:03:00.000Z";
      },
    ],
    [
      "message",
      (s) => {
        s.state.message = "A different failure.";
      },
    ],
    [
      "output",
      (s) => {
        s.state.output = "a-different-private-output";
      },
    ],
    [
      "phase",
      (s) => {
        s.state.diagnostics.phase = "verification";
      },
    ],
    [
      "category",
      (s) => {
        s.state.diagnostics.category = "unexpected_failure";
      },
    ],
    [
      "exit code",
      (s) => {
        s.state.diagnostics.exitCode = 2;
      },
    ],
    [
      "timeout",
      (s) => {
        s.state.diagnostics.timedOut = true;
      },
    ],
    [
      "stdout truncation",
      (s) => {
        s.state.diagnostics.stdoutTruncated = true;
      },
    ],
    [
      "stderr truncation",
      (s) => {
        s.state.diagnostics.stderrTruncated = true;
      },
    ],
    [
      "joined output truncation",
      (s) => {
        s.state.diagnostics.outputTruncated = true;
      },
    ],
  ];
  it.each(changes)("rejects in-place %s mutation after capturing the reveal", (_name, mutate) => {
    const source = snapshot();
    const captured = captureProviderUpdateFailure(source);
    mutate(source);
    expect(sameProviderUpdateFailure(captured, source)).toBe(false);
  });

  it("keeps legacy metadata absent and refuses to transfer a legacy reveal to a newly diagnosed state", () => {
    const source = snapshot();
    const legacy: FailureSnapshot = {
      ...source,
      state: {
        status: source.state.status,
        startedAt: source.state.startedAt,
        finishedAt: source.state.finishedAt,
        message: source.state.message,
        output: source.state.output,
      },
    };
    const captured = captureProviderUpdateFailure(legacy);
    expect(Object.hasOwn(captured.state, "diagnostics")).toBe(false);
    expect(sameProviderUpdateFailure(captured, { ...legacy, state: { ...legacy.state } })).toBe(
      true,
    );
    expect(sameProviderUpdateFailure(captured, source)).toBe(false);
  });
});

describe("provider update diagnostic labels", () => {
  it.each([
    ["preflight", "Preparing the update"],
    ["command", "Running the update command"],
    ["verification", "Checking the installed version"],
    ["lifecycle", "Managing the update"],
  ] as const)("names %s with a fixed friendly message", (phase, expected) => {
    expect(providerUpdatePhaseLabel(phase, "en")).toBe(expected);
  });
  it.each([
    ["preflight_failed", "Update preparation failed"],
    ["command_failed", "The update command failed"],
    ["command_timed_out", "The update command timed out"],
    ["runtime_check_failed", "The provider runtime check failed"],
    ["version_unverified", "The updated version could not be verified"],
    ["unexpected_failure", "The update could not finish"],
    ["interrupted", "The update was interrupted"],
  ] as const)("names %s without displaying its internal identifier", (category, expected) => {
    expect(providerUpdateCategoryLabel(category, "en")).toBe(expected);
  });
});
