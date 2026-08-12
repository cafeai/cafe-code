import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@cafecode/contracts";

export const CAMERA_CAPTURE_MAX_EDGE_PX = 2_048;
export const CAMERA_CAPTURE_MAX_BYTES = PROVIDER_SEND_TURN_MAX_IMAGE_BYTES;
export const CAMERA_CAPTURE_JPEG_QUALITIES = [0.86, 0.72, 0.58] as const;

export type CameraFacingMode = "environment" | "user";

export interface CameraCaptureDimensions {
  readonly width: number;
  readonly height: number;
}

export function supportsLiveCameraCapture(
  targetWindow: Pick<Window, "isSecureContext"> | undefined = typeof window === "undefined"
    ? undefined
    : window,
  targetNavigator: Pick<Navigator, "mediaDevices"> | undefined = typeof navigator === "undefined"
    ? undefined
    : navigator,
): boolean {
  return Boolean(
    targetWindow?.isSecureContext &&
    targetNavigator?.mediaDevices &&
    typeof targetNavigator.mediaDevices.getUserMedia === "function",
  );
}

export function getBoundedCameraCaptureDimensions(
  sourceWidth: number,
  sourceHeight: number,
  maxEdge = CAMERA_CAPTURE_MAX_EDGE_PX,
): CameraCaptureDimensions {
  if (
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(sourceHeight) ||
    !Number.isFinite(maxEdge) ||
    sourceWidth <= 0 ||
    sourceHeight <= 0 ||
    maxEdge <= 0
  ) {
    throw new Error("Camera preview does not have a usable frame yet.");
  }

  const boundedMaxEdge = Math.max(1, Math.floor(maxEdge));
  const scale = Math.min(1, boundedMaxEdge / Math.max(sourceWidth, sourceHeight));
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

export function cameraVideoConstraints(
  facingMode: CameraFacingMode,
  deviceId?: string,
): MediaTrackConstraints {
  const shared = {
    width: { ideal: 1_920 },
    height: { ideal: 1_080 },
  } satisfies MediaTrackConstraints;

  if (deviceId) {
    return {
      ...shared,
      deviceId: { exact: deviceId },
    };
  }

  return {
    ...shared,
    facingMode: { ideal: facingMode },
  };
}

export function stopCameraStream(stream: MediaStream | null | undefined): void {
  for (const track of stream?.getTracks() ?? []) {
    try {
      track.stop();
    } catch {
      // A broken/removed device must not prevent the remaining tracks from
      // releasing their camera or microphone resources.
    }
  }
}

const FRONT_CAMERA_LABEL = /\b(front|user|selfie|facetime)\b/i;
const REAR_CAMERA_LABEL = /\b(back|rear|environment|world)\b/i;

export function selectCameraDevice(
  devices: readonly MediaDeviceInfo[],
  facingMode: CameraFacingMode,
  activeDeviceId?: string,
): MediaDeviceInfo | undefined {
  const videoInputs = devices.filter(
    (device) => device.kind === "videoinput" && device.deviceId.length > 0,
  );
  if (videoInputs.length === 0) return undefined;

  const labelPattern = facingMode === "environment" ? REAR_CAMERA_LABEL : FRONT_CAMERA_LABEL;
  const labeledMatch = videoInputs.find((device) => labelPattern.test(device.label));
  if (labeledMatch) return labeledMatch;

  if (activeDeviceId && videoInputs.length > 1) {
    const activeIndex = videoInputs.findIndex((device) => device.deviceId === activeDeviceId);
    if (activeIndex >= 0) {
      return videoInputs[(activeIndex + 1) % videoInputs.length];
    }
  }

  return undefined;
}

function canvasToJpegBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", quality);
  });
}

export function cameraCaptureFileName(now = new Date()): string {
  const timestamp = now.toISOString().replaceAll("-", "").replaceAll(":", "").replace(".", "");
  return `cafe-code-camera-${timestamp}.jpg`;
}

export async function captureCameraFrame(
  video: HTMLVideoElement,
  options: {
    readonly maxEdge?: number;
    readonly maxBytes?: number;
    readonly now?: Date;
  } = {},
): Promise<File> {
  const { width, height } = getBoundedCameraCaptureDimensions(
    video.videoWidth,
    video.videoHeight,
    options.maxEdge,
  );
  const canvas = video.ownerDocument.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    throw new Error("This browser cannot prepare a camera image.");
  }
  context.drawImage(video, 0, 0, width, height);

  const maxBytes = options.maxBytes ?? CAMERA_CAPTURE_MAX_BYTES;
  for (const quality of CAMERA_CAPTURE_JPEG_QUALITIES) {
    const blob = await canvasToJpegBlob(canvas, quality);
    if (!blob || blob.size <= 0 || blob.type !== "image/jpeg") continue;
    if (blob.size <= maxBytes) {
      return new File([blob], cameraCaptureFileName(options.now), {
        type: "image/jpeg",
        lastModified: options.now?.getTime() ?? Date.now(),
      });
    }
  }

  throw new Error("The captured photo is too large to attach. Try a lower-resolution camera.");
}
