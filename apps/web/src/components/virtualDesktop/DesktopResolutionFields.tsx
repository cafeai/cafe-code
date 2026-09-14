import { useId, useState } from "react";
import {
  DESKTOP_MIN_DIMENSION,
  DESKTOP_MAX_DIMENSION,
  type DesktopResolution,
} from "@cafecode/contracts";
import { Input } from "../ui/input";

export type ResolutionDraft = { width: string; height: string };
export const draftResolution = (value: DesktopResolution): ResolutionDraft => ({
  width: String(value.width),
  height: String(value.height),
});
export function readResolutionDraft(value: ResolutionDraft): DesktopResolution | null {
  const width = Number(value.width),
    height = Number(value.height);
  return /^\d+$/.test(value.width) &&
    /^\d+$/.test(value.height) &&
    [width, height].every(
      (n) => Number.isInteger(n) && n >= DESKTOP_MIN_DIMENSION && n <= DESKTOP_MAX_DIMENSION,
    )
    ? { width, height }
    : null;
}
const presets = [
  { width: 1280, height: 800, label: "1280 × 800 · 16:10 (default)" },
  { width: 1280, height: 720, label: "1280 × 720 · 16:9" },
  { width: 1600, height: 1200, label: "1600 × 1200 · 4:3" },
  { width: 1920, height: 1080, label: "1920 × 1080 · 16:9" },
  { width: 1080, height: 1920, label: "1080 × 1920 · Portrait" },
];

export function DesktopResolutionFields({
  value,
  onChange,
  disabled = false,
}: {
  value: ResolutionDraft;
  onChange: (value: ResolutionDraft) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const [custom, setCustom] = useState(false);
  const [ratio, setRatio] = useState<number | null>(null);
  const parsed = readResolutionDraft(value);
  const preset = presets.find(
    (p) => String(p.width) === value.width && String(p.height) === value.height,
  );
  function dimension(key: "width" | "height", text: string) {
    setCustom(true);
    const next = { ...value, [key]: text };
    if (ratio && /^\d+$/.test(text) && Number(text) > 0) {
      const other = key === "width" ? "height" : "width";
      next[other] = String(
        Math.round(key === "width" ? Number(text) / ratio : Number(text) * ratio),
      );
    }
    onChange(next);
  }
  return (
    <fieldset className="space-y-3" disabled={disabled}>
      <div className="space-y-1.5">
        <label htmlFor={`${id}-preset`} className="text-sm font-medium">
          Resolution
        </label>
        <select
          id={`${id}-preset`}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          value={!custom && preset ? `${preset.width}x${preset.height}` : "custom"}
          onChange={(event) => {
            const next = presets.find((p) => `${p.width}x${p.height}` === event.target.value);
            setCustom(!next);
            if (next) {
              onChange(draftResolution(next));
              if (ratio) setRatio(next.width / next.height);
            }
          }}
        >
          {presets.map((p) => (
            <option key={p.label} value={`${p.width}x${p.height}`}>
              {p.label}
            </option>
          ))}
          <option value="custom">Custom</option>
        </select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {(["width", "height"] as const).map((key) => (
          <div key={key} className="space-y-1.5">
            <label htmlFor={`${id}-${key}`} className="text-xs text-muted-foreground">
              {key === "width" ? "Width" : "Height"} (pixels)
            </label>
            <Input
              id={`${id}-${key}`}
              type="number"
              min={DESKTOP_MIN_DIMENSION}
              max={DESKTOP_MAX_DIMENSION}
              step={1}
              required
              value={value[key]}
              aria-invalid={!parsed}
              onChange={(e) => dimension(key, e.target.value)}
            />
          </div>
        ))}
      </div>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={ratio !== null}
          disabled={disabled || (!ratio && !parsed)}
          onChange={(e) =>
            setRatio(e.target.checked && parsed ? parsed.width / parsed.height : null)
          }
        />
        Lock aspect ratio
      </label>
      <p className="text-xs text-muted-foreground">
        320–2048 pixels per dimension. Larger desktops use more resources.
      </p>
    </fieldset>
  );
}
