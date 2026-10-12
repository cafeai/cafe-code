import { describe, expect, it } from "vitest";

import {
  detectSourceControlProviderFromRemoteUrl,
  getChangeRequestTerminologyForKind,
  resolveChangeRequestPresentation,
  selectSourceControlCloneUrl,
} from "./sourceControl.ts";

describe("selectSourceControlCloneUrl", () => {
  const urls = {
    nameWithOwner: "owner/repo",
    url: "https://github.com/owner/repo",
    sshUrl: "git@github.com:owner/repo.git",
  };

  it.each([undefined, "owner/repo", "https://github.com/owner/repo.git"])(
    "defaults %s to HTTPS without assuming SSH setup",
    (repositoryInput) => {
      const options = repositoryInput === undefined ? {} : { repositoryInput };
      expect(selectSourceControlCloneUrl(urls, options)).toBe(urls.url);
      expect(selectSourceControlCloneUrl(urls, { ...options, protocol: "auto" })).toBe(urls.url);
    },
  );

  it.each(["git@github.com:owner/repo.git", "ssh://git@github.com/owner/repo.git"])(
    "respects explicit SSH reference %s",
    (repositoryInput) => {
      expect(selectSourceControlCloneUrl(urls, { repositoryInput })).toBe(urls.sshUrl);
      expect(selectSourceControlCloneUrl(urls, { repositoryInput, protocol: "https" })).toBe(
        urls.url,
      );
    },
  );

  it("gives an explicit protocol priority over the reference spelling", () => {
    expect(
      selectSourceControlCloneUrl(urls, {
        repositoryInput: urls.url,
        protocol: "ssh",
      }),
    ).toBe(urls.sshUrl);
  });
});

describe("source control presentation", () => {
  it("uses merge request terminology for GitLab", () => {
    expect(getChangeRequestTerminologyForKind("gitlab")).toEqual({
      shortLabel: "MR",
      singular: "merge request",
    });
  });

  it("uses pull request terminology for GitHub-compatible providers", () => {
    expect(getChangeRequestTerminologyForKind("github")).toEqual({
      shortLabel: "PR",
      singular: "pull request",
    });
    expect(getChangeRequestTerminologyForKind("azure-devops")).toEqual({
      shortLabel: "PR",
      singular: "pull request",
    });
    expect(getChangeRequestTerminologyForKind("bitbucket")).toEqual({
      shortLabel: "PR",
      singular: "pull request",
    });
  });

  it("falls back to generic change request copy for unknown providers", () => {
    expect(
      resolveChangeRequestPresentation({ kind: "unknown", name: "forge", baseUrl: "" }),
    ).toEqual(
      expect.objectContaining({
        shortName: "change request",
        longName: "change request",
      }),
    );
  });
});

describe("detectSourceControlProviderFromRemoteUrl", () => {
  it("detects common source control hosts", () => {
    expect(detectSourceControlProviderFromRemoteUrl("git@github.com:owner/repo.git")?.kind).toBe(
      "github",
    );
    expect(
      detectSourceControlProviderFromRemoteUrl("https://gitlab.com/group/repo.git")?.kind,
    ).toBe("gitlab");
    expect(
      detectSourceControlProviderFromRemoteUrl("https://dev.azure.com/org/project/_git/repo")?.kind,
    ).toBe("azure-devops");
    expect(
      detectSourceControlProviderFromRemoteUrl("git@bitbucket.org:workspace/repo.git")?.kind,
    ).toBe("bitbucket");
  });
});
