import { useEffect, useState } from "react";
import { PaletteIcon } from "lucide-react";

import { normalizeAccentColor } from "../../themeAccent";

/**
 * Compact accent-color control: a palette swatch backed by a native color
 * input. Commits the normalized hex on blur (or `emptyValue` when cleared).
 * Shared by the appearance settings and the onboarding customization step.
 */
export function ColorWheelPicker(props: {
  readonly value: string;
  readonly defaultPickerColor: string;
  readonly emptyValue: string;
  readonly ariaLabel: string;
  readonly onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(props.value);
  const [isEditing, setIsEditing] = useState(false);
  const draftColor = normalizeAccentColor(draft);

  useEffect(() => {
    if (isEditing) return;
    setDraft(props.value);
  }, [isEditing, props.value]);

  const commitDraft = () => {
    setIsEditing(false);
    props.onCommit(draftColor ?? props.emptyValue);
  };

  return (
    <div className="flex min-w-0 items-center justify-end">
      <label className="group relative inline-flex h-8 w-10 cursor-pointer items-center justify-center rounded-md border border-input bg-background shadow-xs transition-colors hover:bg-accent focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1 focus-within:ring-offset-background">
        <span
          className="pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 transition-opacity group-hover:opacity-100"
          style={{
            backgroundColor: draftColor ?? "transparent",
          }}
        />
        <span className="pointer-events-none relative flex size-6 items-center justify-center rounded-full bg-[conic-gradient(from_40deg,#ef4444,#f97316,#facc15,#22c55e,#06b6d4,#3b82f6,#8b5cf6,#ef4444)] shadow-inner shadow-black/15">
          <span className="absolute inset-1 rounded-full bg-background/92" />
          <PaletteIcon
            className="relative size-3.5 text-foreground/78"
            strokeWidth={2.2}
            aria-hidden="true"
          />
        </span>
        <input
          type="color"
          value={draftColor ?? props.defaultPickerColor}
          onFocus={() => setIsEditing(true)}
          onInput={(event) => {
            setIsEditing(true);
            setDraft(event.currentTarget.value);
          }}
          onChange={(event) => {
            setIsEditing(true);
            setDraft(event.currentTarget.value);
          }}
          onBlur={commitDraft}
          aria-label={props.ariaLabel}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </label>
    </div>
  );
}
