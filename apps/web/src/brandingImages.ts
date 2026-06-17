import type { SidebarBrandImageAsset } from "@cafecode/contracts/settings";

import sidebarBrandIcon128 from "./assets/cafe-code-sidebar-icon-128.png";
import sidebarBrandIcon256 from "./assets/cafe-code-sidebar-icon-256.png";
import sidebarBrandIcon384 from "./assets/cafe-code-sidebar-icon-384.png";
import { resolvePrimaryEnvironmentHttpUrl } from "./environments/primary/target";

export const DEFAULT_SIDEBAR_BRAND_IMAGE_SRC = sidebarBrandIcon256;
export const DEFAULT_SIDEBAR_BRAND_IMAGE_SRC_SET = `${sidebarBrandIcon128} 128w, ${sidebarBrandIcon256} 256w, ${sidebarBrandIcon384} 384w`;
export const DEFAULT_SIDEBAR_BRAND_IMAGE_SIZES = "102px";

function isSidebarBrandImageAsset(value: unknown): value is SidebarBrandImageAsset {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<SidebarBrandImageAsset>;
  return (
    typeof record.id === "string" &&
    /^sha256-[a-f0-9]{64}\.(?:gif|jpe?g|png|webp)$/.test(record.id) &&
    typeof record.url === "string" &&
    record.url === `/api/branding/sidebar-image/${record.id}` &&
    (record.mimeType === "image/gif" ||
      record.mimeType === "image/jpeg" ||
      record.mimeType === "image/png" ||
      record.mimeType === "image/webp") &&
    typeof record.width === "number" &&
    Number.isInteger(record.width) &&
    record.width > 0 &&
    typeof record.height === "number" &&
    Number.isInteger(record.height) &&
    record.height > 0 &&
    typeof record.sizeBytes === "number" &&
    Number.isInteger(record.sizeBytes) &&
    record.sizeBytes > 0
  );
}

function resolveBrandingImageUrl(pathname: string): string {
  try {
    return resolvePrimaryEnvironmentHttpUrl(pathname);
  } catch {
    return pathname;
  }
}

export function resolveSidebarBrandImageSrc(asset: SidebarBrandImageAsset | null): string {
  return asset ? resolveBrandingImageUrl(asset.url) : DEFAULT_SIDEBAR_BRAND_IMAGE_SRC;
}

export async function uploadSidebarBrandImage(file: File): Promise<SidebarBrandImageAsset> {
  const response = await fetch(resolvePrimaryEnvironmentHttpUrl("/api/branding/sidebar-image"), {
    body: file,
    credentials: "include",
    headers: {
      "content-type": file.type || "application/octet-stream",
    },
    method: "POST",
  });

  if (!response.ok) {
    const message = (await response.text()).trim();
    throw new Error(message || `Sidebar image upload failed (${response.status}).`);
  }

  const payload = (await response.json()) as { readonly sidebarBrandImage?: unknown };
  if (!isSidebarBrandImageAsset(payload.sidebarBrandImage)) {
    throw new Error("Sidebar image upload returned an invalid response.");
  }
  return payload.sidebarBrandImage;
}
