import {
  MAX_SIDEBAR_BRAND_IMAGE_FILE_BYTES,
  type SidebarBrandImageAsset,
} from "@cafecode/contracts/settings";
import type { EnvironmentId } from "@cafecode/contracts";
import { useEffect, useState } from "react";

import sidebarBrandIcon128 from "./assets/cafe-code-sidebar-icon-128.png";
import sidebarBrandIcon256 from "./assets/cafe-code-sidebar-icon-256.png";
import sidebarBrandIcon384 from "./assets/cafe-code-sidebar-icon-384.png";
import { resolvePrimaryEnvironmentHttpUrl } from "./environments/primary/target";
import { readPrimaryEnvironmentDescriptor, usePrimaryEnvironmentId } from "./environments/primary";
import { readWorkspaceEnvironmentId, useWorkspaceEnvironmentId } from "./environments/workspace";
import { useSavedEnvironmentRuntimeStore } from "./environments/runtime/catalog";

import { fileRequest, readBounded } from "./attachments/fileAttachments";

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

async function requestRemoteBrandImage(
  environmentId: EnvironmentId,
  pathname: string,
  init: RequestInit = {},
): Promise<Response> {
  if (
    useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.connectionState !== "connected"
  )
    throw new Error("Reconnect to the selected server before changing its sidebar image.");
  try {
    return await fileRequest(environmentId, pathname, init);
  } catch {
    throw new Error(
      "Could not load or save the selected server's sidebar image. Check its connection and your access.",
    );
  }
}

/** Image elements cannot send the saved server's bearer. Resolve a private
 * blob URL instead of attaching credentials to a URL or reading primary data. */
export function useSidebarBrandImageSrc(asset: SidebarBrandImageAsset | null): string {
  const environmentId = useWorkspaceEnvironmentId();
  const primaryId = usePrimaryEnvironmentId();
  const remote = environmentId !== null && environmentId !== primaryId;
  const connected = useSavedEnvironmentRuntimeStore((s) =>
    environmentId ? s.byId[environmentId]?.connectionState === "connected" : false,
  );
  const key = JSON.stringify([environmentId, asset?.id]);
  const [image, setImage] = useState<{ key: string; url: string } | null>(null);
  useEffect(() => {
    setImage(null);
    if (!remote || !environmentId || !asset || !connected) return;
    const controller = new AbortController();
    let url: string | null = null;
    void requestRemoteBrandImage(environmentId, asset.url, { signal: controller.signal })
      .then(async (response) => {
        const bytes = await readBounded(response, MAX_SIDEBAR_BRAND_IMAGE_FILE_BYTES);
        return new Blob([bytes.buffer as ArrayBuffer], { type: asset.mimeType });
      })
      .then((blob) => {
        if (controller.signal.aborted || blob.size > MAX_SIDEBAR_BRAND_IMAGE_FILE_BYTES) return;
        url = URL.createObjectURL(blob);
        setImage({ key, url });
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [asset, connected, environmentId, key, remote]);
  return remote
    ? connected && image?.key === key
      ? image.url
      : DEFAULT_SIDEBAR_BRAND_IMAGE_SRC
    : resolveSidebarBrandImageSrc(asset);
}

export async function uploadSidebarBrandImage(
  file: File,
  environmentId = readWorkspaceEnvironmentId(),
): Promise<SidebarBrandImageAsset> {
  const remote =
    environmentId !== null && environmentId !== readPrimaryEnvironmentDescriptor()?.environmentId;
  const init: RequestInit = {
    body: file,
    credentials: "include",
    headers: {
      "content-type": file.type || "application/octet-stream",
    },
    method: "POST",
  };
  const response = remote
    ? await requestRemoteBrandImage(environmentId, "/api/branding/sidebar-image", init)
    : await fetch(resolvePrimaryEnvironmentHttpUrl("/api/branding/sidebar-image"), init);

  if (!response.ok) {
    const message = (await response.text()).trim();
    throw new Error(message || `Sidebar image upload failed (${response.status}).`);
  }

  let payload: { readonly sidebarBrandImage?: unknown };
  if (remote) {
    try {
      payload = JSON.parse(new TextDecoder().decode(await readBounded(response, 8 * 1024)));
    } catch {
      throw new Error("Sidebar image upload returned an invalid response.");
    }
  } else {
    payload = await response.json();
  }
  if (!isSidebarBrandImageAsset(payload.sidebarBrandImage)) {
    throw new Error("Sidebar image upload returned an invalid response.");
  }
  return payload.sidebarBrandImage;
}
