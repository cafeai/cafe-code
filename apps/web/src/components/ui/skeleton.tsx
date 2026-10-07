import { cn } from "~/lib/utils";

/**
 * First-load placeholder shaped like the final layout (docs/style-guide.md §9).
 * The shimmer uses the stepped, pausable `animate-skeleton` token and stops
 * entirely under reduced motion, leaving the static muted block.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "animate-skeleton rounded-sm motion-reduce:animate-none [--skeleton-highlight:--alpha(var(--color-white)/64%)] [background:linear-gradient(120deg,transparent_40%,var(--skeleton-highlight),transparent_60%)_var(--color-muted)_0_0/200%_100%_fixed] dark:[--skeleton-highlight:--alpha(var(--color-white)/4%)]",
        className,
      )}
      data-slot="skeleton"
      {...props}
    />
  );
}

export { Skeleton };
