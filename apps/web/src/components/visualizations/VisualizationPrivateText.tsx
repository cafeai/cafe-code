import { useEffect, useState } from "react";
import { uiText } from "@cafecode/shared/i18n";
import { useUiLocale } from "~/i18n";
import { Button } from "../ui/button";

const PAGE_CODE_UNITS = 32 * 1024;

/**
 * An explicit private reader must still not lay out several MiB of wrapped
 * attacker-controlled text at once. All received bytes remain available through
 * finite pages and the owner's exact-copy action; no source is executed and no
 * page state survives the disclosure's unmount. This is a presentation budget,
 * not a claim that arbitrary received JSON or HTML is safe to interpret.
 */
export function VisualizationPrivateText({ value }: { value: string }) {
  const uiLocale = useUiLocale();
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [value]);
  const count = Math.max(1, Math.ceil(value.length / PAGE_CODE_UNITS));
  const current = Math.min(page, count - 1);
  const start = current * PAGE_CODE_UNITS;
  // Include a complete surrogate pair at a page boundary. The overlap is at
  // most one code unit; exact full-copy bytes come from the original value.
  const begin = start > 0 && /[\uDC00-\uDFFF]/u.test(value[start] ?? "") ? start - 1 : start;
  const end = Math.min(value.length, (current + 1) * PAGE_CODE_UNITS);
  const finish =
    end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1] ?? "") ? end + 1 : end;
  return (
    <div className="min-w-0 space-y-2">
      <pre className="max-h-80 overflow-auto whitespace-pre rounded-md border border-border-subtle p-2 font-mono text-xs">
        {value.slice(begin, finish)}
      </pre>
      {count > 1 ? (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <Button
            size="sm"
            variant="ghost"
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
          >
            {uiText("Previous details page", undefined, undefined, uiLocale)}
          </Button>
          <span>
            {uiText(
              "Page {page} of {total}",
              { page: current + 1, total: count },
              undefined,
              uiLocale,
            )}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={current + 1 >= count}
            onClick={() => setPage(current + 1)}
          >
            {uiText("Next details page", undefined, undefined, uiLocale)}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
