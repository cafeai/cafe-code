import type { SidebarBrandImageAsset } from "@cafecode/contracts/settings";

import { DEFAULT_SIDEBAR_BRAND_IMAGE_SIZES, useSidebarBrandImageSrc } from "../brandingImages";
import {
  builtInSidebarImageSource,
  resolveSidebarImageColor,
  resolveSidebarImageMode,
  type SidebarImageColorId,
  type SidebarImageMode,
} from "../sidebarImages";
import { useSettings } from "./useSettings";
import { useTheme } from "./useTheme";

export type { SidebarImageMode } from "../sidebarImages";

export interface ResolvedSidebarImage {
  readonly mode: SidebarImageMode;
  readonly colorId: SidebarImageColorId;
  readonly src: string;
  readonly srcSet: string | undefined;
  readonly sizes: string | undefined;
  /** True while the uploaded custom image is what `src` shows. */
  readonly showsCustomImage: boolean;
}

/**
 * The picture the sidebar shows. "Match color" follows the sidebar color and
 * light/dark theme; "Custom" shows the upload and falls back to the matched
 * scene until one exists (or while a saved server's copy is still loading).
 */
export function useSidebarImage(
  overrides: { readonly customImage?: SidebarBrandImageAsset | null } = {},
): ResolvedSidebarImage {
  const { resolvedTheme } = useTheme();
  const showSidebarMascot = useSettings((settings) => settings.showSidebarMascot);
  const sidebarImageSource = useSettings((settings) => settings.sidebarImageSource);
  const savedCustomImage = useSettings((settings) => settings.sidebarBrandImage);
  const sidebarColor = useSettings((settings) => settings.appAccentColor);
  const customImage =
    overrides.customImage === undefined ? savedCustomImage : overrides.customImage;
  const customSrc = useSidebarBrandImageSrc(customImage);

  const mode = resolveSidebarImageMode({
    showSidebarMascot,
    sidebarImageSource,
    hasCustomImage: customImage !== null,
  });
  const colorId = resolveSidebarImageColor(sidebarColor, resolvedTheme);
  if (mode === "custom" && customSrc !== null) {
    return {
      mode,
      colorId,
      src: customSrc,
      srcSet: undefined,
      sizes: undefined,
      showsCustomImage: true,
    };
  }
  const builtIn = builtInSidebarImageSource(colorId, resolvedTheme);
  return {
    mode,
    colorId,
    src: builtIn.src,
    srcSet: builtIn.srcSet,
    sizes: DEFAULT_SIDEBAR_BRAND_IMAGE_SIZES,
    showsCustomImage: false,
  };
}
