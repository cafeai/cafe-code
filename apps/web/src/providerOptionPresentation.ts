import type {
  ModelCapabilities,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
} from "@cafecode/contracts";
import { getProviderOptionDescriptors } from "@cafecode/shared/model";
import { uiText } from "@cafecode/shared/i18n";

/** Keep received model/account option labels opaque. Only the service-tier
 * escape descriptor minted by Cafe's shared helper is presentation-owned: it
 * appears when saved intent survives a missing modern descriptor, optionally
 * retaining the same model's equivalent legacy Fast capability. This
 * wrapper never changes ids, selections, defaults or admission semantics. */
/**
 * Options Cafe no longer offers. Claude's output style always stays at the
 * provider default, so it is neither shown in the composer nor sent with a
 * message (a previously saved choice is dropped on the next send).
 */
const RETIRED_PROVIDER_OPTION_IDS = new Set(["outputStyle"]);

export function withoutRetiredProviderOptions(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ReadonlyArray<ProviderOptionDescriptor> {
  return descriptors.filter((descriptor) => !RETIRED_PROVIDER_OPTION_IDS.has(descriptor.id));
}

export function getLocalizedProviderOptionDescriptors(input: {
  readonly caps: ModelCapabilities;
  readonly selections?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}): ReadonlyArray<ProviderOptionDescriptor> {
  const hasNativeServiceTier =
    input.caps.optionDescriptors?.some((entry) => entry.id === "serviceTier") === true;
  return withoutRetiredProviderOptions(getProviderOptionDescriptors(input)).map((descriptor) =>
    !hasNativeServiceTier && descriptor.id === "serviceTier" && descriptor.type === "select"
      ? {
          ...descriptor,
          label: uiText("Service tier"),
          options: descriptor.options.map((option) =>
            option.id === "default"
              ? { ...option, label: uiText("Standard") }
              : option.id === "priority"
                ? { ...option, label: uiText("Fast") }
                : option,
          ),
        }
      : descriptor,
  );
}
