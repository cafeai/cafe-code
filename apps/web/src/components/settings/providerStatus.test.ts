import { describe, expect, it } from "vitest";

import { getProviderVersionAdvisoryPresentation } from "./providerStatus";

describe("provider version advisory presentation", () => {
  it("labels an off-pin provider as requiring detached conformity", () => {
    expect(
      getProviderVersionAdvisoryPresentation({
        status: "behind_latest",
        currentVersion: "2.1.220",
        latestVersion: "2.1.226",
        approvedVersion: "2.1.224",
        updateCommand: null,
        canUpdate: false,
        checkedAt: null,
        message: null,
      }),
    ).toMatchObject({
      title: "Conformity required",
      detail: "Conformity required: install v2.1.224.",
      updateCommand: null,
      actionable: false,
    });
  });

  it("labels a quarantined upstream release as awaiting conformity", () => {
    expect(
      getProviderVersionAdvisoryPresentation({
        status: "behind_latest",
        currentVersion: "2.1.224",
        latestVersion: "2.1.226",
        approvedVersion: "2.1.224",
        updateCommand: null,
        canUpdate: false,
        checkedAt: null,
        message: null,
      }),
    ).toMatchObject({
      title: "Awaiting conformity",
      detail: "Awaiting conformity: v2.1.226.",
      updateCommand: null,
      actionable: false,
    });
  });

  it("retains the normal update label for an actionable unpinned provider", () => {
    expect(
      getProviderVersionAdvisoryPresentation({
        status: "behind_latest",
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        approvedVersion: null,
        updateCommand: "tool update",
        canUpdate: true,
        checkedAt: null,
        message: null,
      }),
    ).toMatchObject({
      title: "Update available",
      detail: "Update available: install v1.1.0.",
      updateCommand: "tool update",
      actionable: true,
    });
  });
});
