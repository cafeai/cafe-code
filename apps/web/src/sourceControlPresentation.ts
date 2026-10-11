import { GitPullRequestIcon } from "lucide-react";
import type { ElementType } from "react";
import type { SourceControlProviderInfo } from "@cafecode/contracts";
import { uiText } from "@cafecode/shared/i18n";
import {
  resolveChangeRequestPresentation as canonicalChangeRequestPresentation,
  type ChangeRequestPresentation,
  type ChangeRequestTerminology,
} from "@cafecode/shared/sourceControl";
export type {
  ChangeRequestPresentation,
  ChangeRequestTerminology,
} from "@cafecode/shared/sourceControl";
import { AzureDevOpsIcon, BitbucketIcon, GitHubIcon, GitLabIcon } from "./components/Icons";

/** Shared terminology also feeds provider-side generation. Localize only this
 * renderer view; command examples, URLs, brands and unknown names stay exact. */
export function resolveChangeRequestPresentation(
  provider: SourceControlProviderInfo | null | undefined,
): ChangeRequestPresentation {
  const canonical = canonicalChangeRequestPresentation(provider);
  switch (canonical.icon) {
    case "github":
      return {
        ...canonical,
        longName: uiText("pull request"),
        pluralLongName: uiText("pull requests"),
        providerLongName: uiText("GitHub pull request"),
      };
    case "gitlab":
      return {
        ...canonical,
        longName: uiText("merge request"),
        pluralLongName: uiText("merge requests"),
        providerLongName: uiText("GitLab merge request"),
      };
    case "azure-devops":
      return {
        ...canonical,
        longName: uiText("pull request"),
        pluralLongName: uiText("pull requests"),
        providerLongName: uiText("Azure DevOps pull request"),
      };
    case "bitbucket":
      return {
        ...canonical,
        longName: uiText("pull request"),
        pluralLongName: uiText("pull requests"),
        providerLongName: uiText("Bitbucket pull request"),
      };
    case "change-request":
      return {
        ...canonical,
        providerName: uiText("source control"),
        shortName: uiText("change request"),
        longName: uiText("change request"),
        pluralLongName: uiText("change requests"),
        providerLongName: uiText("change request"),
      };
  }
}

export const DEFAULT_CHANGE_REQUEST_TERMINOLOGY: ChangeRequestTerminology = {
  shortLabel: "PR",
  get singular() {
    return uiText("pull request");
  },
};

export function getChangeRequestTerminology(
  provider: SourceControlProviderInfo | null | undefined,
): ChangeRequestTerminology {
  const presentation = resolveChangeRequestPresentation(provider);
  return { shortLabel: presentation.shortName, singular: presentation.longName };
}

export function formatChangeRequestAction(
  verb: "View" | "Create",
  presentation: ChangeRequestPresentation,
): string {
  return uiText("{verb, select, View {View} other {Create}} {kind}", {
    verb,
    kind: presentation.shortName,
  });
}

export function formatCreateChangeRequestPhrase(presentation: ChangeRequestPresentation): string {
  return uiText("create {kind}", { kind: presentation.shortName });
}

export interface SourceControlPresentation {
  readonly providerName: string;
  readonly terminology: ChangeRequestTerminology;
  readonly Icon: ElementType<{ className?: string }>;
}

export function getSourceControlPresentation(
  provider: SourceControlProviderInfo | null | undefined,
): SourceControlPresentation {
  const presentation = resolveChangeRequestPresentation(provider);
  switch (presentation.icon) {
    case "github":
      return {
        providerName: provider?.name || presentation.providerName,
        terminology: getChangeRequestTerminology(provider),
        Icon: GitHubIcon,
      };
    case "gitlab":
      return {
        providerName: provider?.name || presentation.providerName,
        terminology: getChangeRequestTerminology(provider),
        Icon: GitLabIcon,
      };
    case "azure-devops":
      return {
        providerName: provider?.name || presentation.providerName,
        terminology: getChangeRequestTerminology(provider),
        Icon: AzureDevOpsIcon,
      };
    case "bitbucket":
      return {
        providerName: provider?.name || presentation.providerName,
        terminology: getChangeRequestTerminology(provider),
        Icon: BitbucketIcon,
      };
    case "change-request":
      return {
        providerName: provider?.name || presentation.providerName,
        terminology: getChangeRequestTerminology(provider),
        Icon: GitPullRequestIcon,
      };
  }
}
