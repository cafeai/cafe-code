import { CameraIcon, LoaderCircleIcon, RefreshCwIcon, SwitchCameraIcon } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import {
  type CameraFacingMode,
  cameraVideoConstraints,
  captureCameraFrame,
  selectCameraDevice,
  stopCameraStream,
  supportsLiveCameraCapture,
} from "./cameraCapture";

export interface CameraCaptureDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onAcceptFile: (file: File) => void | Promise<void>;
  readonly onRequestSystemCamera: () => void | Promise<void>;
}

type CameraStatus =
  | "attaching"
  | "captured"
  | "capturing"
  | "error"
  | "idle"
  | "loading"
  | "ready"
  | "switching";

interface CapturedPhoto {
  readonly file: File;
  readonly previewUrl: string;
}

function cameraUnavailableReason(): string | null {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return "Camera preview is unavailable in this environment.";
  }
  if (!window.isSecureContext) {
    return "Camera preview requires a secure HTTPS or loopback connection.";
  }
  if (!supportsLiveCameraCapture()) {
    return "This browser does not offer an in-app camera preview.";
  }
  return null;
}

function cameraRequestErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    switch (error.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "Camera permission was denied. Allow camera access or use the system camera.";
      case "NotFoundError":
      case "OverconstrainedError":
        return "No compatible camera is available.";
      case "AbortError":
      case "NotReadableError":
        return "The camera is busy or could not be started.";
      default:
        break;
    }
  }
  return "The camera could not be started. You can still use the system camera.";
}

export const CameraCaptureDialog = memo(function CameraCaptureDialog({
  open,
  onOpenChange,
  onAcceptFile,
  onRequestSystemCamera,
}: CameraCaptureDialogProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const activeStreamRef = useRef<MediaStream | null>(null);
  const activeDeviceIdRef = useRef<string | undefined>(undefined);
  const activeFacingModeRef = useRef<CameraFacingMode>("environment");
  const requestGenerationRef = useRef(0);
  const captureInFlightGenerationRef = useRef<number | null>(null);
  const acceptingPhotoRef = useRef<CapturedPhoto | null>(null);
  const capturedPhotoRef = useRef<CapturedPhoto | null>(null);

  const [status, setStatus] = useState<CameraStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [cameraDevices, setCameraDevices] = useState<readonly MediaDeviceInfo[]>([]);
  const [facingMode, setFacingMode] = useState<CameraFacingMode>("environment");
  const [capturedPhoto, setCapturedPhoto] = useState<CapturedPhoto | null>(null);

  const setCameraPreviewElement = useCallback((video: HTMLVideoElement | null) => {
    videoRef.current = video;
    const stream = activeStreamRef.current;
    if (!video || !stream) return;
    video.srcObject = stream;
    void video.play().catch(() => {
      // autoPlay and loaded-metadata retry cover browsers that defer play.
    });
  }, []);

  const releaseActiveStream = useCallback(() => {
    const stream = activeStreamRef.current;
    activeStreamRef.current = null;
    activeDeviceIdRef.current = undefined;
    if (videoRef.current?.srcObject === stream) {
      videoRef.current.srcObject = null;
    }
    stopCameraStream(stream);
  }, []);

  const clearCapturedPhoto = useCallback(() => {
    const photo = capturedPhotoRef.current;
    capturedPhotoRef.current = null;
    if (photo) URL.revokeObjectURL(photo.previewUrl);
    setCapturedPhoto(null);
  }, []);

  const acquireCamera = useCallback(
    async (
      generation: number,
      requestedFacingMode: CameraFacingMode,
      deviceId?: string,
    ): Promise<boolean> => {
      const unavailableReason = cameraUnavailableReason();
      if (unavailableReason) throw new Error(unavailableReason);

      const mediaDevices = navigator.mediaDevices;
      const stream = await mediaDevices.getUserMedia({
        audio: false,
        video: cameraVideoConstraints(requestedFacingMode, deviceId),
      });
      if (generation !== requestGenerationRef.current) {
        stopCameraStream(stream);
        return false;
      }

      try {
        const videoTrack = stream.getVideoTracks()[0];
        if (!videoTrack) {
          throw new Error("The selected device did not provide a video track.");
        }

        const settings = videoTrack.getSettings();
        const actualFacingMode =
          settings.facingMode === "user" || settings.facingMode === "environment"
            ? settings.facingMode
            : requestedFacingMode;
        activeFacingModeRef.current = actualFacingMode;
        activeDeviceIdRef.current = settings.deviceId;
        activeStreamRef.current = stream;
        setFacingMode(actualFacingMode);
        setStatus("ready");
        setErrorMessage(null);

        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          void video.play().catch(() => {
            // autoPlay and loaded-metadata retry cover browsers that defer play.
          });
        }

        // Device labels and stable device ids are exposed only after permission.
        if (typeof mediaDevices.enumerateDevices === "function") {
          try {
            const devices = await mediaDevices.enumerateDevices();
            if (generation === requestGenerationRef.current) {
              setCameraDevices(devices.filter((device) => device.kind === "videoinput"));
            }
          } catch {
            // Facing-mode constraints still provide a useful switch fallback.
          }
        }
        return true;
      } catch (error) {
        if (activeStreamRef.current === stream) {
          activeStreamRef.current = null;
          activeDeviceIdRef.current = undefined;
        }
        if (videoRef.current?.srcObject === stream) {
          videoRef.current.srcObject = null;
        }
        stopCameraStream(stream);
        throw error;
      }
    },
    [],
  );

  const startCamera = useCallback(
    async (requestedFacingMode: CameraFacingMode, unavailableStatus: CameraStatus = "error") => {
      const generation = ++requestGenerationRef.current;
      releaseActiveStream();
      setStatus("loading");
      setErrorMessage(null);
      try {
        await acquireCamera(generation, requestedFacingMode);
      } catch (error) {
        if (generation !== requestGenerationRef.current) return;
        releaseActiveStream();
        setStatus(unavailableStatus);
        const unavailableReason = cameraUnavailableReason();
        setErrorMessage(unavailableReason ?? cameraRequestErrorMessage(error));
      }
    },
    [acquireCamera, releaseActiveStream],
  );

  useEffect(() => {
    if (!open) return;

    setCameraDevices([]);
    setFacingMode("environment");
    activeFacingModeRef.current = "environment";
    clearCapturedPhoto();
    setStatus("idle");
    setErrorMessage(null);

    return () => {
      requestGenerationRef.current += 1;
      releaseActiveStream();
      clearCapturedPhoto();
    };
  }, [clearCapturedPhoto, open, releaseActiveStream]);

  const closeDialog = useCallback(() => {
    requestGenerationRef.current += 1;
    releaseActiveStream();
    clearCapturedPhoto();
    onOpenChange(false);
  }, [clearCapturedPhoto, onOpenChange, releaseActiveStream]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        onOpenChange(true);
        return;
      }
      closeDialog();
    },
    [closeDialog, onOpenChange],
  );

  const handleSwitchCamera = useCallback(async () => {
    const previousFacingMode = activeFacingModeRef.current;
    const nextFacingMode: CameraFacingMode =
      previousFacingMode === "environment" ? "user" : "environment";
    const nextDevice = selectCameraDevice(cameraDevices, nextFacingMode, activeDeviceIdRef.current);
    const previousDeviceId = activeDeviceIdRef.current;
    const generation = ++requestGenerationRef.current;
    releaseActiveStream();
    setStatus("switching");
    setErrorMessage(null);

    try {
      if (await acquireCamera(generation, nextFacingMode, nextDevice?.deviceId)) return;
    } catch {
      // Restart the previous camera below so a failed switch does not strand the preview.
    }
    if (generation !== requestGenerationRef.current) return;

    try {
      const restored = await acquireCamera(generation, previousFacingMode, previousDeviceId);
      if (restored && generation === requestGenerationRef.current) {
        setErrorMessage("That camera was unavailable, so the previous camera was restored.");
      }
    } catch (error) {
      if (generation !== requestGenerationRef.current) return;
      releaseActiveStream();
      setStatus("error");
      setErrorMessage(cameraRequestErrorMessage(error));
    }
  }, [acquireCamera, cameraDevices, releaseActiveStream]);

  const handleCapture = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !activeStreamRef.current) return;
    const generation = requestGenerationRef.current;
    if (captureInFlightGenerationRef.current === generation) return;
    captureInFlightGenerationRef.current = generation;
    setStatus("capturing");
    setErrorMessage(null);
    try {
      const file = await captureCameraFrame(video);
      if (generation !== requestGenerationRef.current) return;
      const photo = {
        file,
        previewUrl: URL.createObjectURL(file),
      } satisfies CapturedPhoto;
      capturedPhotoRef.current = photo;
      setCapturedPhoto(photo);
      releaseActiveStream();
      setStatus("captured");
    } catch (error) {
      if (generation !== requestGenerationRef.current) return;
      setStatus("ready");
      setErrorMessage(
        error instanceof Error ? error.message : "The camera frame could not be captured.",
      );
    } finally {
      if (captureInFlightGenerationRef.current === generation) {
        captureInFlightGenerationRef.current = null;
      }
    }
  }, [releaseActiveStream]);

  const handleRetake = useCallback(() => {
    clearCapturedPhoto();
    void startCamera(activeFacingModeRef.current);
  }, [clearCapturedPhoto, startCamera]);

  const handleUsePhoto = useCallback(async () => {
    const photo = capturedPhotoRef.current;
    if (!photo || acceptingPhotoRef.current === photo) return;
    acceptingPhotoRef.current = photo;
    const generation = ++requestGenerationRef.current;
    releaseActiveStream();
    setStatus("attaching");
    setErrorMessage(null);
    try {
      await onAcceptFile(photo.file);
      if (generation !== requestGenerationRef.current) return;
      clearCapturedPhoto();
      onOpenChange(false);
    } catch {
      if (generation !== requestGenerationRef.current) return;
      setStatus("captured");
      setErrorMessage("The captured photo could not be attached.");
    } finally {
      if (acceptingPhotoRef.current === photo) {
        acceptingPhotoRef.current = null;
      }
    }
  }, [clearCapturedPhoto, onAcceptFile, onOpenChange, releaseActiveStream]);

  const handleRequestSystemCamera = useCallback(() => {
    requestGenerationRef.current += 1;
    releaseActiveStream();
    clearCapturedPhoto();
    // Keep this callback synchronous with the button gesture so a parent file
    // input can open the native camera/picker without losing user activation.
    void onRequestSystemCamera();
    onOpenChange(false);
  }, [clearCapturedPhoto, onOpenChange, onRequestSystemCamera, releaseActiveStream]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-sm:max-h-[calc(100dvh-3rem)] sm:max-w-2xl"
        data-testid="camera-capture-dialog"
      >
        <DialogHeader>
          <DialogTitle>Take a photo</DialogTitle>
          <DialogDescription>
            Start the camera, capture a photo, then choose whether to attach it.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 overflow-y-auto px-4 pb-4 sm:px-6">
          <div className="relative flex aspect-[4/3] max-h-[60dvh] min-h-48 w-full items-center justify-center overflow-hidden rounded-xl border border-border/70 bg-black">
            {capturedPhoto ? (
              <img
                src={capturedPhoto.previewUrl}
                alt="Captured photo preview"
                className="size-full object-contain"
                data-testid="camera-captured-photo"
              />
            ) : (
              <video
                ref={setCameraPreviewElement}
                aria-label="Camera preview"
                className={
                  facingMode === "user"
                    ? "size-full -scale-x-100 object-cover"
                    : "size-full object-cover"
                }
                data-testid="camera-preview"
                autoPlay
                muted
                playsInline
                onLoadedMetadata={(event) => {
                  void event.currentTarget.play().catch(() => {
                    // The capture controls remain available if autoplay is deferred.
                  });
                }}
              />
            )}

            {(status === "loading" ||
              status === "switching" ||
              status === "capturing" ||
              status === "attaching") && (
              <div
                className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/55 text-sm text-white"
                role="status"
              >
                <LoaderCircleIcon aria-hidden="true" className="size-5 animate-spin" />
                {status === "switching"
                  ? "Switching camera…"
                  : status === "capturing"
                    ? "Capturing photo…"
                    : status === "attaching"
                      ? "Attaching photo…"
                      : "Starting camera…"}
              </div>
            )}
            {status === "idle" ? (
              <div className="absolute inset-0 flex items-center justify-center bg-black/55">
                <Button type="button" onClick={() => void startCamera("environment")}>
                  <CameraIcon aria-hidden="true" />
                  Start camera
                </Button>
              </div>
            ) : null}
          </div>

          {errorMessage ? (
            <p className="mt-3 text-sm text-destructive" role="alert">
              {errorMessage}
            </p>
          ) : null}
        </div>

        <DialogFooter className="max-sm:grid max-sm:grid-cols-2">
          <Button type="button" variant="ghost" onClick={closeDialog}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={status === "attaching"}
            onClick={handleRequestSystemCamera}
          >
            <CameraIcon aria-hidden="true" />
            System camera
          </Button>
          {capturedPhoto ? (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={status === "attaching"}
                onClick={handleRetake}
              >
                <RefreshCwIcon aria-hidden="true" />
                Retake
              </Button>
              <Button
                type="button"
                disabled={status === "attaching"}
                onClick={() => void handleUsePhoto()}
              >
                Use photo
              </Button>
            </>
          ) : status === "error" ? (
            <Button type="button" onClick={() => void startCamera(activeFacingModeRef.current)}>
              <RefreshCwIcon aria-hidden="true" />
              Try again
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={status !== "ready"}
                aria-label="Switch front or rear camera"
                onClick={() => void handleSwitchCamera()}
              >
                <SwitchCameraIcon aria-hidden="true" />
                Switch
              </Button>
              <Button
                type="button"
                disabled={status !== "ready"}
                onClick={() => void handleCapture()}
              >
                <CameraIcon aria-hidden="true" />
                Capture
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});
