import { describe, expect, it, vi } from "vitest";
import {
  cameraCaptureFileName,
  cameraVideoConstraints,
  getBoundedCameraCaptureDimensions,
  selectCameraDevice,
  stopCameraStream,
  supportsLiveCameraCapture,
} from "./cameraCapture";

function cameraDevice(
  deviceId: string,
  label: string,
  kind: MediaDeviceKind = "videoinput",
): MediaDeviceInfo {
  return {
    deviceId,
    groupId: "",
    kind,
    label,
    toJSON: () => ({}),
  };
}

describe("camera capture helpers", () => {
  it("requires both a secure context and the live camera API", () => {
    const getUserMedia = vi.fn();
    const mediaNavigator = {
      mediaDevices: { getUserMedia },
    } as unknown as Pick<Navigator, "mediaDevices">;

    expect(supportsLiveCameraCapture({ isSecureContext: true }, mediaNavigator)).toBe(true);
    expect(supportsLiveCameraCapture({ isSecureContext: false }, mediaNavigator)).toBe(false);
    expect(supportsLiveCameraCapture({ isSecureContext: true }, undefined)).toBe(false);
  });

  it("preserves aspect ratio while bounding the longest edge", () => {
    expect(getBoundedCameraCaptureDimensions(4_032, 3_024)).toEqual({
      width: 2_048,
      height: 1_536,
    });
    expect(getBoundedCameraCaptureDimensions(640, 480)).toEqual({
      width: 640,
      height: 480,
    });
    expect(() => getBoundedCameraCaptureDimensions(0, 480)).toThrow(/usable frame/i);
  });

  it("prefers an explicit device only after discovery and otherwise requests facing mode", () => {
    expect(cameraVideoConstraints("environment")).toMatchObject({
      facingMode: { ideal: "environment" },
      width: { ideal: 1_920 },
      height: { ideal: 1_080 },
    });
    expect(cameraVideoConstraints("user", "front-camera")).toEqual({
      deviceId: { exact: "front-camera" },
      width: { ideal: 1_920 },
      height: { ideal: 1_080 },
    });
  });

  it("uses camera labels first and a different discovered input as a fallback", () => {
    const devices = [
      cameraDevice("microphone", "Mic", "audioinput"),
      cameraDevice("front", "Front Selfie Camera"),
      cameraDevice("rear", "Back Camera"),
    ];

    expect(selectCameraDevice(devices, "environment", "front")?.deviceId).toBe("rear");
    expect(selectCameraDevice(devices, "user", "rear")?.deviceId).toBe("front");

    const unlabeled = [cameraDevice("one", ""), cameraDevice("two", "")];
    expect(selectCameraDevice(unlabeled, "user", "one")?.deviceId).toBe("two");
    expect(selectCameraDevice(unlabeled, "environment")?.deviceId).toBeUndefined();
  });

  it("attempts to stop every track and creates a millisecond-distinct filesystem-safe name", () => {
    const firstTrack = {
      stop: vi.fn(() => {
        throw new Error("device already removed");
      }),
    };
    const secondTrack = { stop: vi.fn() };
    stopCameraStream({
      getTracks: () => [firstTrack, secondTrack],
    } as unknown as MediaStream);

    expect(firstTrack.stop).toHaveBeenCalledOnce();
    expect(secondTrack.stop).toHaveBeenCalledOnce();
    expect(cameraCaptureFileName(new Date("2026-07-29T21:22:23.456Z"))).toBe(
      "cafe-code-camera-20260729T212223456Z.jpg",
    );
    expect(cameraCaptureFileName(new Date("2026-07-29T21:22:23.457Z"))).toBe(
      "cafe-code-camera-20260729T212223457Z.jpg",
    );
  });
});
