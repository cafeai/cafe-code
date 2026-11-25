import { fetchAppResource, readPrimaryRelay } from "./environments/relay/active";
import { useUiPresentation } from "~/i18n";
import { uiText, type UiLocale } from "@cafecode/shared/i18n";
import { parseImageHeader } from "@cafecode/shared/rasterImageHeader";
import {
  MAX_SIDEBAR_BRAND_IMAGE_DIMENSION,
  MAX_SIDEBAR_BRAND_IMAGE_FILE_BYTES,
  MAX_SIDEBAR_BRAND_IMAGE_PIXEL_COUNT,
  type SidebarBrandImageAsset,
} from "@cafecode/contracts/settings";
import type { EnvironmentId } from "@cafecode/contracts";
import { useEffect, useState } from "react";

import { resolvePrimaryEnvironmentHttpUrl } from "./environments/primary/target";
import { readPrimaryEnvironmentDescriptor, usePrimaryEnvironmentId } from "./environments/primary";
import { readWorkspaceEnvironmentId, useWorkspaceEnvironmentId } from "./environments/workspace";
import { useSavedEnvironmentRuntimeStore } from "./environments/runtime/catalog";

import { fileRequest, readBounded } from "./attachments/fileAttachments";

/** The sidebar card renders 102 CSS px wide; pair with built-in srcsets. */
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

/** URL of an uploaded custom sidebar image, or null when none is saved. */
export function resolveSidebarBrandImageSrc(asset: SidebarBrandImageAsset | null): string | null {
  return asset ? resolveBrandingImageUrl(asset.url) : null;
}

async function requestRemoteBrandImage(
  environmentId: EnvironmentId,
  pathname: string,
  init: RequestInit = {},
): Promise<Response> {
  if (
    useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.connectionState !== "connected"
  )
    throw new Error(uiText("Reconnect to the selected server before changing its sidebar image."));
  try {
    return await fileRequest(environmentId, pathname, init);
  } catch {
    throw new Error(
      uiText(
        "Could not load or save the selected server's sidebar image. Check its connection and your access.",
      ),
    );
  }
}

/** Image elements cannot send the saved server's bearer. Resolve a private
 * blob URL instead of attaching credentials to a URL or reading primary data.
 * Returns null until a custom image is available, so callers can show the
 * built-in scene instead of an empty card. */
export function useSidebarBrandImageSrc(asset: SidebarBrandImageAsset | null): string | null {
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const environmentId = useWorkspaceEnvironmentId();
  const primaryId = usePrimaryEnvironmentId();
  const remote = environmentId !== null && environmentId !== primaryId;
  const relayPrimary =
    environmentId !== null && environmentId === readPrimaryRelay()?.environmentId;
  const connected = useSavedEnvironmentRuntimeStore((s) =>
    environmentId ? s.byId[environmentId]?.connectionState === "connected" : false,
  );
  const key = JSON.stringify([environmentId, asset?.id]);
  const [image, setImage] = useState<{ key: string; url: string } | null>(null);
  useEffect(() => {
    setImage(null);
    if ((!remote && !relayPrimary) || !environmentId || !asset || (!connected && !relayPrimary))
      return;
    const controller = new AbortController();
    let url: string | null = null;
    void (
      relayPrimary
        ? fileRequest(environmentId, asset.url, { signal: controller.signal })
        : requestRemoteBrandImage(environmentId, asset.url, { signal: controller.signal })
    )
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
  }, [asset, connected, environmentId, key, remote, relayPrimary]);
  return remote || relayPrimary
    ? (connected || relayPrimary) && image?.key === key
      ? image.url
      : null
    : uiPresentation.resolveSidebarBrandImageSrc(asset);
}

export async function prepareSidebarBrandImage(file: File, locale: UiLocale): Promise<Blob> {
  // Decode in an image element so browsers can also rasterize vectors with a viewBox.
  const source =
    !file.type && /\.svg$/i.test(file.name) ? file.slice(0, file.size, "image/svg+xml") : file;
  const image = new Image();
  const url = URL.createObjectURL(source);
  try {
    image.src = url;
    await image.decode();

    // Keep compliant originals, including their animation. Check the same
    // encoded dimensions and MIME type the upload route will read.
    if (file.size <= MAX_SIDEBAR_BRAND_IMAGE_FILE_BYTES) {
      const header = parseImageHeader(new Uint8Array(await file.arrayBuffer()));
      if (
        header &&
        Math.max(header.width, header.height) <= MAX_SIDEBAR_BRAND_IMAGE_DIMENSION &&
        header.width * header.height <= MAX_SIDEBAR_BRAND_IMAGE_PIXEL_COUNT
      ) {
        return file.type === header.mimeType ? file : file.slice(0, file.size, header.mimeType);
      }
    }

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (context) {
      // The image also feeds web app icons. Start with enough detail for those
      // and reduce the canvas for high-entropy images or PNG encoder fallback.
      const longestSide = Math.max(image.naturalWidth, image.naturalHeight);
      for (const maxSide of [1024, 768, 384]) {
        const scale = Math.min(1, maxSide / longestSide);
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        context.imageSmoothingQuality = "high";
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const encoded = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, "image/webp", 0.9),
        );
        if (encoded && encoded.size > 0 && encoded.size <= MAX_SIDEBAR_BRAND_IMAGE_FILE_BYTES) {
          return encoded;
        }
      }
    }
  } catch {
    throw new Error(uiText("Could not read that image.", undefined, undefined, locale));
  } finally {
    image.removeAttribute("src");
    URL.revokeObjectURL(url);
  }
  throw new Error(uiText("Could not upload that image.", undefined, undefined, locale));
}

export async function uploadSidebarBrandImage(
  file: Blob,
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
    : await fetchAppResource(resolvePrimaryEnvironmentHttpUrl("/api/branding/sidebar-image"), init);

  if (!response.ok) {
    const message = (await response.text()).trim();
    throw new Error(
      message || uiText("Sidebar image upload failed ({status}).", { status: response.status }),
    );
  }

  let payload: { readonly sidebarBrandImage?: unknown };
  if (remote) {
    try {
      payload = JSON.parse(new TextDecoder().decode(await readBounded(response, 8 * 1024)));
    } catch {
      throw new Error(uiText("Sidebar image upload returned an invalid response."));
    }
  } else {
    payload = await response.json();
  }
  if (!isSidebarBrandImageAsset(payload.sidebarBrandImage)) {
    throw new Error(uiText("Sidebar image upload returned an invalid response."));
  }
  return payload.sidebarBrandImage;
}

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = { resolveSidebarBrandImageSrc };
