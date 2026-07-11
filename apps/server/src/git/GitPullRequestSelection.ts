import type { ChangeRequest } from "@cafecode/contracts";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Order from "effect/Order";

export interface PullRequestHeadContext {
  readonly headBranch: string;
  readonly headRepositoryNameWithOwner: string | null;
  readonly headRepositoryOwnerLogin: string | null;
  readonly isCrossRepository: boolean;
}

const pullRequestUpdatedAtDescOrder: Order.Order<ChangeRequest> = Order.mapInput(
  Order.flip(Option.makeOrder(DateTime.Order)),
  (pullRequest) => pullRequest.updatedAt,
);

export function parseRepositoryNameFromPullRequestUrl(url: string): string | null {
  const trimmed = url.trim();
  const match = /^https:\/\/github\.com\/[^/]+\/([^/]+)\/pull\/\d+(?:\/.*)?$/i.exec(trimmed);
  const repositoryName = match?.[1]?.trim() ?? "";
  return repositoryName.length > 0 ? repositoryName : null;
}

export function parseRepositoryOwnerLogin(nameWithOwner: string | null): string | null {
  const trimmed = nameWithOwner?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }
  const [ownerLogin] = trimmed.split("/");
  const normalizedOwnerLogin = ownerLogin?.trim() ?? "";
  return normalizedOwnerLogin.length > 0 ? normalizedOwnerLogin : null;
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeOptionalRepositoryNameWithOwner(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalString(value);
  return normalized ? normalized.toLowerCase() : null;
}

function normalizeOptionalOwnerLogin(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalString(value);
  return normalized ? normalized.toLowerCase() : null;
}

function resolvePullRequestHeadRepositoryNameWithOwner(pr: ChangeRequest): string | null {
  const explicitRepository = normalizeOptionalString(pr.headRepositoryNameWithOwner);
  if (explicitRepository) {
    return explicitRepository;
  }

  if (!pr.isCrossRepository) {
    return null;
  }

  const ownerLogin = normalizeOptionalString(pr.headRepositoryOwnerLogin);
  const repositoryName = parseRepositoryNameFromPullRequestUrl(pr.url);
  if (!ownerLogin || !repositoryName) {
    return null;
  }

  return `${ownerLogin}/${repositoryName}`;
}

export function matchesPullRequestHeadContext(
  pr: ChangeRequest,
  headContext: PullRequestHeadContext,
): boolean {
  if (pr.headRefName !== headContext.headBranch) {
    return false;
  }

  const expectedHeadRepository = normalizeOptionalRepositoryNameWithOwner(
    headContext.headRepositoryNameWithOwner,
  );
  const expectedHeadOwner =
    normalizeOptionalOwnerLogin(headContext.headRepositoryOwnerLogin) ??
    parseRepositoryOwnerLogin(expectedHeadRepository);
  const prHeadRepository = normalizeOptionalRepositoryNameWithOwner(
    resolvePullRequestHeadRepositoryNameWithOwner(pr),
  );
  const prHeadOwner =
    normalizeOptionalOwnerLogin(pr.headRepositoryOwnerLogin) ??
    parseRepositoryOwnerLogin(prHeadRepository);

  if (headContext.isCrossRepository) {
    if (pr.isCrossRepository === false) {
      return false;
    }
    if ((expectedHeadRepository || expectedHeadOwner) && !prHeadRepository && !prHeadOwner) {
      return false;
    }
    if (expectedHeadRepository && prHeadRepository && expectedHeadRepository !== prHeadRepository) {
      return false;
    }
    if (expectedHeadOwner && prHeadOwner && expectedHeadOwner !== prHeadOwner) {
      return false;
    }
    return true;
  }

  if (pr.isCrossRepository === true) {
    return false;
  }
  if (expectedHeadRepository && prHeadRepository && expectedHeadRepository !== prHeadRepository) {
    return false;
  }
  if (expectedHeadOwner && prHeadOwner && expectedHeadOwner !== prHeadOwner) {
    return false;
  }
  return true;
}

/**
 * Select the PR that represents the checked-out branch. Open PRs remain actionable even when a
 * newer closed/merged record exists; otherwise the newest terminal record supplies history.
 */
export function selectLatestPullRequest(
  pullRequests: Iterable<ChangeRequest>,
  headContext: PullRequestHeadContext,
): ChangeRequest | null {
  const matchingByNumber = new Map<number, ChangeRequest>();
  for (const pullRequest of pullRequests) {
    if (matchesPullRequestHeadContext(pullRequest, headContext)) {
      matchingByNumber.set(pullRequest.number, pullRequest);
    }
  }

  const sorted = Arr.sort(matchingByNumber.values(), pullRequestUpdatedAtDescOrder);
  return sorted.find((pullRequest) => pullRequest.state === "open") ?? sorted[0] ?? null;
}
