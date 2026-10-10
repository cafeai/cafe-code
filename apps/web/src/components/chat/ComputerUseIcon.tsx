import type { SVGProps } from "react";

/** Rounded pointer silhouette from Cua's bundled default cursor artwork. */
export function ComputerUseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="36 22 84 88" fill="none" aria-hidden="true" {...props}>
      <path
        d="M55 30 C48 28 42 33 43 41 L64 98 C67 106 73 106 77 99 L86 79 C88 75 91 72 95 70 L108 63 C115 59 114 53 107 50 Z"
        fill="currentColor"
        stroke="var(--color-primary-foreground)"
        strokeWidth="6"
        strokeLinejoin="round"
      />
    </svg>
  );
}
