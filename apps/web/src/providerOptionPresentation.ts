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
export function getLocalizedProviderOptionDescriptors(input: {
  readonly caps: ModelCapabilities;
  readonly selections?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}): ReadonlyArray<ProviderOptionDescriptor> {
  const hasNativeServiceTier =
    input.caps.optionDescriptors?.some((entry) => entry.id === "serviceTier") === true;
  return getProviderOptionDescriptors(input).map((descriptor) =>
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
