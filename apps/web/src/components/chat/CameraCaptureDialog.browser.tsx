import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { CameraCaptureDialog } from "./CameraCaptureDialog";

interface CameraTrackHarness {
  readonly track: MediaStreamTrack;
  readonly stop: ReturnType<typeof vi.fn>;
}

interface CameraStreamHarness {
  readonly stream: MediaStream;
  readonly track: CameraTrackHarness;
}

const originalMediaDevicesDescriptor = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
const originalSrcObjectDescriptor = Object.getOwnPropertyDescriptor(
  HTMLMediaElement.prototype,
  "srcObject",
);

function cameraDevice(deviceId: string, label: string): MediaDeviceInfo {
  return {
    deviceId,
    groupId: "camera-group",
    kind: "videoinput",
    label,
    toJSON: () => ({}),
  };
}

function cameraStream(
  deviceId: string,
  facingMode: "environment" | "user",
  options: { readonly settingsError?: boolean } = {},
): CameraStreamHarness {
  const stop = vi.fn();
  const track = {
    kind: "video",
    stop,
    getSettings: () => {
      if (options.settingsError) throw new Error("settings unavailable");
      return { deviceId, facingMode };
    },
  } as unknown as MediaStreamTrack;
  return {
    stream: {
      getTracks: () => [track],
      getVideoTracks: () => [track],
    } as unknown as MediaStream,
    track: { track, stop },
  };
}

function installMediaDevices(input: {
  readonly getUserMedia: (constraints?: MediaStreamConstraints) => Promise<MediaStream>;
  readonly enumerateDevices?: () => Promise<MediaDeviceInfo[]>;
}): void {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: input.getUserMedia,
      enumerateDevices: input.enumerateDevices ?? (async () => []),
    },
  });
}

function dialogProps(
  overrides: Partial<React.ComponentProps<typeof CameraCaptureDialog>> = {},
): React.ComponentProps<typeof CameraCaptureDialog> {
  return {
    open: true,
    onOpenChange: vi.fn(),
    onAcceptFile: vi.fn(),
    onRequestSystemCamera: vi.fn(),
    ...overrides,
  };
}

async function startCamera(): Promise<void> {
  await page.getByRole("button", { name: "Start camera" }).click();
}

beforeEach(() => {
  const assignedSources = new WeakMap<HTMLMediaElement, MediaStream | null>();
  Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
    configurable: true,
    get() {
      return assignedSources.get(this) ?? null;
    },
    set(value: MediaStream | null) {
      assignedSources.set(this, value);
    },
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalMediaDevicesDescriptor) {
    Object.defineProperty(navigator, "mediaDevices", originalMediaDevicesDescriptor);
  } else {
    Reflect.deleteProperty(navigator, "mediaDevices");
  }
  if (originalSrcObjectDescriptor) {
    Object.defineProperty(HTMLMediaElement.prototype, "srcObject", originalSrcObjectDescriptor);
  } else {
    Reflect.deleteProperty(HTMLMediaElement.prototype, "srcObject");
  }
});

it("waits for an explicit camera action and enumerates only after permission", async () => {
  const selected = cameraStream("rear", "environment");
  let resolvePermission!: (stream: MediaStream) => void;
  const permission = new Promise<MediaStream>((resolve) => {
    resolvePermission = resolve;
  });
  const getUserMedia = vi.fn(() => permission);
  const enumerateDevices = vi.fn(async () => [cameraDevice("rear", "Back Camera")]);
  installMediaDevices({ getUserMedia, enumerateDevices });
  const onOpenChange = vi.fn();

  const mounted = await render(
    <CameraCaptureDialog
      {...dialogProps({
        open: false,
        onOpenChange,
      })}
    />,
  );
  expect(getUserMedia).not.toHaveBeenCalled();

  await mounted.rerender(
    <CameraCaptureDialog
      {...dialogProps({
        open: true,
        onOpenChange,
      })}
    />,
  );
  expect(getUserMedia).not.toHaveBeenCalled();

  await startCamera();
  await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
  expect(getUserMedia).toHaveBeenCalledWith({
    audio: false,
    video: {
      facingMode: { ideal: "environment" },
      height: { ideal: 1_080 },
      width: { ideal: 1_920 },
    },
  });
  expect(enumerateDevices).not.toHaveBeenCalled();

  resolvePermission(selected.stream);
  await vi.waitFor(() => expect(enumerateDevices).toHaveBeenCalledOnce());
  const preview = page.getByLabelText("Camera preview").element() as HTMLVideoElement;
  expect(preview.autoplay).toBe(true);
  expect(preview.muted).toBe(true);
  expect(preview.playsInline).toBe(true);

  await page.getByRole("button", { name: "Cancel" }).click();
  expect(selected.track.stop).toHaveBeenCalledOnce();
  expect(onOpenChange).toHaveBeenCalledWith(false);
  await mounted.unmount();
});

it("captures a bounded JPEG, stops the preview, retakes, and accepts the new photo", async () => {
  const first = cameraStream("rear", "environment");
  const second = cameraStream("rear", "environment");
  const getUserMedia = vi
    .fn<(constraints?: MediaStreamConstraints) => Promise<MediaStream>>()
    .mockResolvedValueOnce(first.stream)
    .mockResolvedValueOnce(second.stream);
  installMediaDevices({ getUserMedia });
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
    callback(new Blob(["jpeg"], { type: "image/jpeg" }));
  });
  let objectUrlIndex = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:camera-${++objectUrlIndex}`);
  const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  const onAcceptFile = vi.fn<(file: File) => Promise<void>>(async () => undefined);
  const onOpenChange = vi.fn();

  const mounted = await render(
    <CameraCaptureDialog {...dialogProps({ onAcceptFile, onOpenChange })} />,
  );
  await startCamera();
  await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
  let preview = page.getByLabelText("Camera preview").element() as HTMLVideoElement;
  expect(preview.srcObject).toBe(first.stream);
  Object.defineProperties(preview, {
    videoHeight: { configurable: true, value: 3_024 },
    videoWidth: { configurable: true, value: 4_032 },
  });
  await page.getByRole("button", { name: "Capture" }).click();
  await expect.element(page.getByAltText("Captured photo preview")).toBeVisible();
  expect(drawImage).toHaveBeenCalledWith(preview, 0, 0, 2_048, 1_536);
  expect(first.track.stop).toHaveBeenCalledOnce();

  await page.getByRole("button", { name: "Retake" }).click();
  await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:camera-1");
  preview = page.getByLabelText("Camera preview").element() as HTMLVideoElement;
  expect(preview.srcObject).toBe(second.stream);
  Object.defineProperties(preview, {
    videoHeight: { configurable: true, value: 480 },
    videoWidth: { configurable: true, value: 640 },
  });
  await page.getByRole("button", { name: "Capture" }).click();
  await expect.element(page.getByAltText("Captured photo preview")).toBeVisible();
  expect(second.track.stop).toHaveBeenCalledOnce();

  await page.getByRole("button", { name: "Use photo" }).click();
  await vi.waitFor(() => expect(onAcceptFile).toHaveBeenCalledOnce());
  const acceptedFile = onAcceptFile.mock.calls[0]?.[0];
  expect(acceptedFile).toBeInstanceOf(File);
  expect(acceptedFile?.type).toBe("image/jpeg");
  expect(acceptedFile?.size).toBe(4);
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:camera-2");
  await mounted.unmount();
});

it("serializes photo acceptance and ignores its late completion after close", async () => {
  const selected = cameraStream("rear", "environment");
  installMediaDevices({
    getUserMedia: vi.fn(async () => selected.stream),
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
    callback(new Blob(["jpeg"], { type: "image/jpeg" }));
  });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:camera-pending");
  const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  let resolveAccept!: () => void;
  const onAcceptFile = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveAccept = resolve;
      }),
  );
  const onOpenChange = vi.fn();

  const mounted = await render(
    <CameraCaptureDialog {...dialogProps({ onAcceptFile, onOpenChange })} />,
  );
  await startCamera();
  const preview = page.getByLabelText("Camera preview").element() as HTMLVideoElement;
  Object.defineProperties(preview, {
    videoHeight: { configurable: true, value: 480 },
    videoWidth: { configurable: true, value: 640 },
  });
  await page.getByRole("button", { name: "Capture" }).click();
  await expect.element(page.getByAltText("Captured photo preview")).toBeVisible();

  const usePhoto = page.getByRole("button", { name: "Use photo" }).element() as HTMLButtonElement;
  usePhoto.click();
  usePhoto.click();
  expect(onAcceptFile).toHaveBeenCalledOnce();
  await expect.element(page.getByText("Attaching photo…")).toBeVisible();

  await page.getByRole("button", { name: "Cancel" }).click();
  expect(onOpenChange).toHaveBeenCalledTimes(1);
  expect(onOpenChange).toHaveBeenLastCalledWith(false);
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:camera-pending");

  resolveAccept();
  await Promise.resolve();
  expect(onOpenChange).toHaveBeenCalledTimes(1);
  await mounted.unmount();
});

it("keeps the captured photo available when the attachment target rejects it", async () => {
  const selected = cameraStream("rear", "environment");
  installMediaDevices({
    getUserMedia: vi.fn(async () => selected.stream),
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
    callback(new Blob(["jpeg"], { type: "image/jpeg" }));
  });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:camera-rejected");
  const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  const onAcceptFile = vi.fn(async () => {
    throw new Error("attachment limit reached");
  });
  const onOpenChange = vi.fn();

  const mounted = await render(
    <CameraCaptureDialog {...dialogProps({ onAcceptFile, onOpenChange })} />,
  );
  await startCamera();
  const preview = page.getByLabelText("Camera preview").element() as HTMLVideoElement;
  Object.defineProperties(preview, {
    videoHeight: { configurable: true, value: 480 },
    videoWidth: { configurable: true, value: 640 },
  });
  await page.getByRole("button", { name: "Capture" }).click();
  await expect.element(page.getByAltText("Captured photo preview")).toBeVisible();

  await page.getByRole("button", { name: "Use photo" }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("The captured photo could not be attached.");
  await expect.element(page.getByAltText("Captured photo preview")).toBeVisible();
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(revokeObjectURL).not.toHaveBeenCalledWith("blob:camera-rejected");

  await mounted.unmount();
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:camera-rejected");
});

it("stops a failed switch stream, restores the prior camera, and cleans up on unmount", async () => {
  const initial = cameraStream("rear", "environment");
  const failedSwitch = cameraStream("front", "user", { settingsError: true });
  const restored = cameraStream("rear", "environment");
  const getUserMedia = vi
    .fn<(constraints?: MediaStreamConstraints) => Promise<MediaStream>>()
    .mockResolvedValueOnce(initial.stream)
    .mockResolvedValueOnce(failedSwitch.stream)
    .mockResolvedValueOnce(restored.stream);
  const enumerateDevices = vi.fn(async () => [
    cameraDevice("front", "Front Camera"),
    cameraDevice("rear", "Back Camera"),
  ]);
  installMediaDevices({
    getUserMedia,
    enumerateDevices,
  });

  const mounted = await render(<CameraCaptureDialog {...dialogProps()} />);
  await startCamera();
  await vi.waitFor(() => expect(enumerateDevices).toHaveBeenCalledOnce());
  await page.getByRole("button", { name: "Switch front or rear camera" }).click();
  await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(3));

  expect(initial.track.stop).toHaveBeenCalledOnce();
  expect(failedSwitch.track.stop).toHaveBeenCalledOnce();
  expect(getUserMedia.mock.calls[1]?.[0]).toMatchObject({
    video: { deviceId: { exact: "front" } },
  });
  expect(getUserMedia.mock.calls[2]?.[0]).toMatchObject({
    video: { deviceId: { exact: "rear" } },
  });
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("the previous camera was restored");

  await mounted.unmount();
  expect(restored.track.stop).toHaveBeenCalledOnce();
});

it("stops a late permission result after the dialog scope closes", async () => {
  const late = cameraStream("rear", "environment");
  let resolvePermission!: (stream: MediaStream) => void;
  const getUserMedia = vi.fn(
    () =>
      new Promise<MediaStream>((resolve) => {
        resolvePermission = resolve;
      }),
  );
  const enumerateDevices = vi.fn(async () => [cameraDevice("rear", "Back Camera")]);
  installMediaDevices({ getUserMedia, enumerateDevices });
  const props = dialogProps();

  const mounted = await render(<CameraCaptureDialog {...props} />);
  await startCamera();
  await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
  await mounted.rerender(<CameraCaptureDialog {...props} open={false} />);
  resolvePermission(late.stream);

  await vi.waitFor(() => expect(late.track.stop).toHaveBeenCalledOnce());
  expect(enumerateDevices).not.toHaveBeenCalled();
  await mounted.unmount();
});

it("shows permission failure and invokes the system fallback before closing", async () => {
  const getUserMedia = vi.fn(async () => {
    throw new DOMException("denied", "NotAllowedError");
  });
  installMediaDevices({ getUserMedia });
  const order: string[] = [];
  const onRequestSystemCamera = vi.fn(() => {
    order.push("system");
  });
  const onOpenChange = vi.fn(() => {
    order.push("close");
  });

  const mounted = await render(
    <CameraCaptureDialog
      {...dialogProps({
        onOpenChange,
        onRequestSystemCamera,
      })}
    />,
  );
  await startCamera();
  await expect.element(page.getByRole("alert")).toHaveTextContent("Camera permission was denied");

  await page.getByRole("button", { name: "System camera" }).click();
  expect(order).toEqual(["system", "close"]);
  expect(onRequestSystemCamera).toHaveBeenCalledOnce();
  expect(onOpenChange).toHaveBeenCalledWith(false);
  await mounted.unmount();
});
