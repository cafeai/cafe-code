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
  return (
    <SegmentedControl
      aria-label="Usage date range"
      value={value}
      onValueChange={onChange}
      options={RANGE_OPTIONS}
    />
  );
}
