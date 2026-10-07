import { Undo2Icon } from "lucide-react";
import { type ComponentPropsWithoutRef, type ReactNode, useEffect, useState } from "react";

import { useDelayedFlag } from "../../hooks/useDelayedFlag";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Re-render every `intervalMs`; return a stable timestamp snapshot for render-time relative labels. */
export function useRelativeTimeTick(intervalMs = 1_000) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return nowMs;
}

export function SettingsSection({
  title,
  icon,
  headerAction,
  children,
  className,
  ...sectionProps
}: ComponentPropsWithoutRef<"section"> & {
  /**
   * Optional overline. Omit it when the page title already names the only
   * section on the page (docs/style-guide.md §1, "one fact, one place").
   */
  title?: string;
  icon?: ReactNode;
  headerAction?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section {...sectionProps} className={cn("space-y-2.5", className)}>
      {title || headerAction ? (
        <div className="flex items-center justify-between px-1">
          {title ? (
            <h2 className="label-overline flex items-center gap-2 [&_svg]:size-3.5">
              {icon}
              {title}
            </h2>
          ) : (
            <span />
          )}
          <div className="flex h-5 min-w-5 items-center justify-end">{headerAction}</div>
        </div>
      ) : null}
      <div className="relative overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-sm/4 not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:shadow-none dark:before:shadow-[0_-1px_--theme(--color-white/6%)]">
        {children}
      </div>
    </section>
  );
}

export function SettingsRow({
  title,
  description,
  status,
  resetAction,
  control,
  children,
  className,
  ...rowProps
}: Omit<ComponentPropsWithoutRef<"div">, "title"> & {
  title: ReactNode;
  /**
   * Optional one-line explanation (docs/style-guide.md §10). Omit it when the
   * title and control already make the setting clear; put caveats in an
   * `InfoTip` next to the title instead of a second sentence.
   */
  description?: ReactNode;
  status?: ReactNode;
  resetAction?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      {...rowProps}
      className={cn(
        "border-t border-border-subtle px-4 first:border-t-0 sm:px-5",
        children ? "pt-3.5 pb-0" : "py-3.5",
        className,
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="text-ui font-semibold text-foreground">{title}</h3>
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
              {resetAction}
            </span>
          </div>
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
          {status ? <div className="pt-0.5 text-2xs text-muted-foreground">{status}</div> : null}
        </div>
        {control ? (
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            {control}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

/**
 * Keeps a button's label and width while it is busy: after a noticeable wait
 * (docs/style-guide.md §9) a centred spinner covers the label instead of the
 * label changing to a different, differently sized word. Pair it with
 * `aria-busy` on the button; the label stays in the accessible name.
 */
export function BusyButtonLabel({
  busy,
  children,
  spinnerClassName = "size-4",
}: {
  busy: boolean;
  children: ReactNode;
  spinnerClassName?: string;
}) {
  const showSpinner = useDelayedFlag(busy);
  return (
    <>
      <span className={cn(showSpinner && "opacity-0")}>{children}</span>
      {showSpinner ? <Spinner aria-hidden className={cn("absolute", spinnerClassName)} /> : null}
    </>
  );
}

export function SettingResetButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Reset ${label} to default`}
            className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
          >
            <Undo2Icon className="size-3" />
          </Button>
        }
      />
      <TooltipPopup side="top">Reset to default</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Every settings page uses one content width so switching sections never
 * changes the column; `wide` is reserved for tables and dashboards
 * (docs/style-guide.md §5). Pages may pass a `title` heading.
 */
export function SettingsPageContainer({
  children,
  className,
  width = "standard",
  title,
  description,
}: {
  children: ReactNode;
  className?: string;
  width?: "standard" | "wide";
  title?: ReactNode;
  description?: ReactNode;
}) {
  return (
    <div className="flex-1 overflow-y-auto p-6 sm:p-8">
      <div
        className={cn(
          "mx-auto flex w-full animate-enter-rise flex-col gap-8",
          width === "wide" ? "max-w-5xl" : "max-w-3xl",
          className,
        )}
      >
        {title ? (
          <header className="space-y-1 px-1">
            <h1 className="text-lg font-semibold text-foreground">{title}</h1>
            {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
          </header>
        ) : null}
        {children}
      </div>
    </div>
  );
}
