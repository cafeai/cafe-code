// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
const root = resolve(import.meta.dirname, "..");
const workflow = (name: string) =>
  parse(readFileSync(resolve(root, ".github/workflows", name), "utf8"));

describe("release publication gates", () => {
  it("keeps manual branch publication behind the normal CI and validated artifacts before minting its tag", () => {
    const release = workflow("release.yml");
    expect(release.on.workflow_dispatch.inputs.version.required).toBe(true);
    expect(release.on.workflow_dispatch.inputs.publish_release).toEqual({
      description: "Create the tag and publish only after all release gates pass",
      type: "boolean",
      default: false,
    });
    expect(release.jobs.publish.if).toBe(
      "${{ !cancelled() && needs.prepare.result == 'success' && needs.artifacts.result == 'success' && (github.event_name != 'workflow_dispatch' || inputs.publish_release) && (inputs.build_only || needs.quality.result == 'success') }}",
    );
    expect(release.jobs.publish.needs).toEqual(["prepare", "quality", "artifacts"]);
    expect(release.jobs.publish.env.RELEASE_TAG).toBe("${{ needs.prepare.outputs.tag }}");
    const steps = release.jobs.publish.steps;
    const publication = steps.findIndex(
      (step: { name?: string }) => step.name === "Create GitHub release",
    );
    expect(steps[publication].run).toContain(
      'git push origin "${RELEASE_SOURCE_SHA}:refs/tags/${RELEASE_TAG}"',
    );
    expect(steps[publication].run).not.toContain("--force");
    for (const name of [
      "Verify qualified artifact identities",
      "Validate release manifests and checksums",
    ]) {
      expect(steps.findIndex((step: { name?: string }) => step.name === name)).toBeLessThan(
        publication,
      );
    }
    const prepare = release.jobs.prepare.steps.find(
      (step: { id?: string }) => step.id === "release",
    );
    expect(prepare.env.RELEASE_TAG_INPUT).toBe(
      "${{ github.event_name == 'workflow_dispatch' && inputs.version || github.ref_name }}",
    );
    expect(prepare.run).toContain('tag="${RELEASE_TAG_INPUT}"');
    expect(prepare.run).toContain('echo "tag=${tag}"');
  });

  it("scopes native sandbox and private keychain setup to their exact artifact smoke steps", () => {
    const flags = [
      "CAFE_CODE_LINUX_ARTIFACT_PREPARE_SANDBOX",
      "CAFE_CODE_MACOS_ARTIFACT_PREPARE_KEYCHAIN",
    ] as const;
    for (const [name, jobName, linuxName, macName] of [
      [
        "reliability.yml",
        "packaged-runtime",
        "Launch Linux artifact in isolated virtual display",
        "Launch macOS artifact with isolated keychain",
      ],
    ] as const) {
      const source = workflow(name);
      for (const flag of flags) expect(source.env ?? {}).not.toHaveProperty(flag);
      for (const job of Object.values(source.jobs) as { env?: unknown }[]) {
        for (const flag of flags) expect(job.env ?? {}).not.toHaveProperty(flag);
      }
      const steps = source.jobs[jobName].steps as {
        name?: string;
        if?: string;
        env?: Record<string, string>;
      }[];
      expect(steps.filter((step) => step.env?.[flags[0]])).toEqual([
        expect.objectContaining({
          name: linuxName,
          if: "runner.os == 'Linux'",
          env: { [flags[0]]: "1" },
        }),
      ]);
      expect(steps.filter((step) => step.env?.[flags[1]])).toEqual([
        expect.objectContaining({
          name: macName,
          if: "runner.os == 'macOS'",
          env: expect.objectContaining({ [flags[1]]: "1" }),
        }),
      ]);
    }
  });

  it("requires macOS signing secrets only on its release build and verifies signatures before sealing", () => {
    const release = workflow("release.yml");
    const steps = release.jobs.artifacts.steps;
    const signed = steps.find(
      (step: { name?: string }) => step.name === "Build signed and notarized macOS artifact",
    );
    expect(signed.if).toBe("runner.os == 'macOS'");
    expect(signed.env).toEqual({
      CAFE_CODE_DESKTOP_SIGNED: "true",
      CSC_IDENTITY_AUTO_DISCOVERY: "true",
      CSC_LINK: "${{ secrets.MACOS_CERTIFICATE_BASE64 }}",
      CSC_KEY_PASSWORD: "${{ secrets.MACOS_CERTIFICATE_PASSWORD }}",
      APPLE_ID: "${{ secrets.APPLE_ID }}",
      APPLE_APP_SPECIFIC_PASSWORD: "${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}",
      APPLE_TEAM_ID: "${{ secrets.APPLE_TEAM_ID }}",
    });
    expect(signed.run).toContain('if [[ -z "${!required}" ]]');
    expect(
      steps.filter((step: { env?: Record<string, string> }) =>
        Object.values(step.env ?? {}).some((value) => value.includes("secrets.")),
      ),
    ).toEqual([signed]);
    const verification = steps.find(
      (step: { name?: string }) => step.name === "Verify macOS signature and notarization",
    );
    expect(verification.if).toBe("runner.os == 'macOS'");
    for (const command of [
      "codesign --verify --deep --strict",
      "spctl --assess --type execute",
      "xcrun stapler validate",
    ]) {
      expect(verification.run).toContain(command);
    }
    const unsigned = steps.find(
      (step: { name?: string }) => step.name === "Build unsigned Windows or Linux artifact",
    );
    expect(unsigned.if).toBe("runner.os != 'macOS'");
    expect(release.jobs.artifacts.env.CAFE_CODE_DESKTOP_SIGNED).toBe("false");
  });

  it("qualifies one selected source across every reliability job", () => {
    const ci = workflow("ci.yml");
    expect(ci.on.workflow_dispatch.inputs.reliability_only).toEqual({
      description: "Run the complete isolated reliability and packaged-runtime workflow",
      type: "boolean",
      default: false,
    });
    // Route through CI's registered manual entrypoint before the new reusable
    // workflow reaches the default branch. The caller pins its event commit.
    expect(ci.jobs["reliability-qualification"]).toEqual({
      if: "${{ github.event_name == 'workflow_dispatch' && inputs.reliability_only && !inputs.windows_ownership_only }}",
      permissions: { contents: "read" },
      uses: "./.github/workflows/reliability.yml",
      with: { source_ref: "${{ github.sha }}" },
    });
    expect(ci.jobs.quality.if).toBe(
      "${{ always() && !cancelled() && !inputs.windows_ownership_only && !inputs.reliability_only }}",
    );
    const reliability = workflow("reliability.yml");
    expect(reliability.on.workflow_call.inputs.source_ref).toEqual({
      type: "string",
      default: "",
    });
    expect(Object.keys(reliability.jobs).sort()).toEqual([
      "dependency-advisories",
      "packaged-runtime",
      "process-lifecycle",
    ]);
    for (const job of Object.values(reliability.jobs) as {
      steps: { uses?: string; with?: { ref?: string } }[];
    }[]) {
      const checkouts = job.steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
      expect(checkouts).toHaveLength(1);
      // Release callers supply an immutable source SHA, manual runs pin their
      // selected ref's event commit, and scheduled canaries retain dev. A later
      // branch push must not change a matrix job's source midway through a run.
      expect(checkouts[0]!.with?.ref).toBe(
        "${{ inputs.source_ref || (github.event_name == 'workflow_dispatch' && github.sha || 'dev') }}",
      );
    }
  });

  it("uses normal reusable CI for the exact release commit without additional qualification", () => {
    const release = workflow("release.yml");
    expect(release.jobs.quality.with.source_ref).toBe("${{ needs.prepare.outputs.source-sha }}");
    expect(release.jobs.quality.uses).toBe("./.github/workflows/ci.yml");
    expect(release.jobs.quality.with.release_candidate ?? false).toBe(false);
    expect(release.jobs).not.toHaveProperty("reliability");
    expect(release.jobs.publish.needs).toEqual(["prepare", "quality", "artifacts"]);
    const ci = workflow("ci.yml");
    expect(
      ci.jobs["browser-checks"].steps.some(
        (step: { run?: string }) => step.run === "corepack yarn test:browser:ci",
      ),
    ).toBe(true);
    expect(ci.jobs.quality.needs).toEqual(
      expect.arrayContaining(["node-checks", "browser-checks"]),
    );
    // This stable required check must fail explicitly instead of being
    // silently skipped when one of its newly parallel prerequisites fails.
    const failureGate = ci.jobs.quality.steps.find(
      (step: { run?: string }) => step.run === "exit 1",
    );
    expect(failureGate).toMatchObject({
      if: "${{ needs['node-checks'].result != 'success' || needs['browser-checks'].result != 'success' }}",
    });
    expect(failureGate["continue-on-error"]).not.toBe(true);
    expect(ci.jobs.quality.steps.indexOf(failureGate)).toBeLessThan(
      ci.jobs.quality.steps.findIndex((step: { uses?: string }) =>
        step.uses?.startsWith("actions/checkout@"),
      ),
    );
    expect(ci.jobs["node-checks"].needs ?? []).not.toContain("browser-checks");
    expect(ci.jobs["browser-checks"].needs ?? []).not.toContain("node-checks");
  });
  it("seals signed build identities and verifies bytes and manifests before publishing", () => {
    const release = workflow("release.yml");
    const artifactSteps = release.jobs.artifacts.steps;
    const seal = artifactSteps.findIndex(
      (step: { name?: string }) => step.name === "Seal qualified artifact identities",
    );
    for (const name of [
      "Build unsigned Windows or Linux artifact",
      "Build signed and notarized macOS artifact",
      "Verify macOS signature and notarization",
    ]) {
      const index = artifactSteps.findIndex((step: { name?: string }) => step.name === name);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(seal);
    }
    expect(artifactSteps[seal].run).toContain('--sha "${{ needs.prepare.outputs.source-sha }}"');
    const steps = release.jobs.publish.steps;
    const publish = steps.findIndex(
      (step: { name?: string }) => step.name === "Create GitHub release",
    );
    for (const name of [
      "Verify qualified artifact identities",
      "Validate release manifests and checksums",
    ]) {
      const index = steps.findIndex((step: { name?: string }) => step.name === name);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(publish);
    }
    expect(release.jobs.artifacts.env.CAFE_CODE_DESKTOP_SIGNED).toBe("false");
    for (const job of Object.values(release.jobs) as {
      steps?: { [key: string]: unknown }[];
      [key: string]: unknown;
    }[]) {
      expect(job).not.toHaveProperty("continue-on-error");
      for (const step of job.steps ?? []) expect(step).not.toHaveProperty("continue-on-error");
    }
  });
});
