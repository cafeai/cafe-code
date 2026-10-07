import { Loader2Icon } from "lucide-react";
import { cn } from "~/lib/utils";

/**
 * The one loading spinner (docs/style-guide.md §6, §9): a Lucide loader on the
 * stepped, pausable `animate-spin` token. Use it inside buttons or small inline
 * spots, gated with `useDelayedFlag` so fast work never flashes it.
 *
 * It announces itself as a "Loading" status by default. Pass `aria-hidden` when
 * nearby text already says what is happening; the status role and label are
 * then dropped so the hidden icon carries no orphaned semantics.
 */
function Spinner({ className, ...props }: React.ComponentProps<typeof Loader2Icon>) {
  const hidden = props["aria-hidden"] === true || props["aria-hidden"] === "true";
  return (
    <Loader2Icon
      aria-label={hidden ? undefined : "Loading"}
      className={cn("size-4 shrink-0 animate-spin", className)}
      data-slot="spinner"
      role={hidden ? undefined : "status"}
      {...props}
    />
  );
}

export { Spinner };
