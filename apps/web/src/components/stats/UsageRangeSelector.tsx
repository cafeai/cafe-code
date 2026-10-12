import { useUiLocale, useUiPresentation } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { SegmentedControl } from "../ui/segmented-control";
import { USAGE_RANGES, type UsageRangeKey } from "./usageRange";

const RANGE_OPTIONS = USAGE_RANGES.map((entry) => ({ value: entry.key, label: entry.label }));

/**
 * The single calendar-range control shared by both usage surfaces. It uses the
 * shared segmented control (docs/style-guide.md §6), which renders an
 * accessible `group` of pressed-state buttons named "Usage date range".
 */
export function UsageRangeSelector({
  value,
  onChange,
}: {
  value: UsageRangeKey;
  onChange: (value: UsageRangeKey) => void;
}) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  return (
    <SegmentedControl
      aria-label={uiText("Usage date range", undefined, undefined, uiLocale)}
      value={value}
      onValueChange={onChange}
      options={uiPresentation.RANGE_OPTIONS}
    />
  );
}

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = { RANGE_OPTIONS };
