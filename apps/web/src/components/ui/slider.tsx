"use client";

import { Slider as SliderPrimitive } from "@base-ui/react/slider";

import { cn } from "~/lib/utils";

/**
 * Thin horizontal slider matching the settings-control visual language:
 * a 3px track, primary-tinted fill, and a small round thumb.
 */
function Slider({ className, ...props }: SliderPrimitive.Root.Props<number>) {
  return (
    <SliderPrimitive.Root
      className={cn("flex w-full touch-none items-center select-none", className)}
      data-slot="slider"
      {...props}
    >
      <SliderPrimitive.Control className="flex h-5 w-full cursor-pointer items-center">
        <SliderPrimitive.Track className="relative h-[3px] w-full rounded-full bg-muted-foreground/25">
          <SliderPrimitive.Indicator className="absolute h-full rounded-full bg-primary" />
          <SliderPrimitive.Thumb
            aria-label={props["aria-label"]}
            aria-labelledby={props["aria-labelledby"]}
            className="absolute top-1/2 size-3 -translate-y-1/2 rounded-full bg-foreground shadow-sm outline-none transition-[scale] duration-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background active:scale-110 data-disabled:cursor-not-allowed"
            data-slot="slider-thumb"
          />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
