import { Component, type ReactNode, type RefObject } from "react";

import { Button } from "../ui/button";

interface AtriumSubagentDetailBoundaryProps {
  readonly children: ReactNode;
  readonly backButtonRef: RefObject<HTMLButtonElement | null>;
  readonly onBack: () => void;
}

/**
 * Inspecting one worker must not replace the board or the underlying chat with
 * a whole-app error screen. Normal transport failures are already handled by
 * the shared detail reader; this boundary contains unexpected render failures.
 * Keep only a boolean, never exception text or a provider payload. The caller
 * keys this boundary to the exact selected history, and Back revokes that
 * selection rather than retrying any provider operation or reloading drafts.
 */
export class AtriumSubagentDetailBoundary extends Component<
  AtriumSubagentDetailBoundaryProps,
  { readonly hasError: boolean }
> {
  constructor(props: AtriumSubagentDetailBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override componentDidCatch() {
    // The original detail's focus target may have been unmounted by the error.
    // Restore a usable, popup-local exit after React commits the safe fallback.
    this.props.backButtonRef.current?.focus();
  }

  override render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <section className="flex h-full min-h-0 flex-col gap-4 overflow-auto p-6">
        <h2 className="text-base font-medium text-foreground">Subagent activity unavailable</h2>
        <p className="text-sm text-muted-foreground">Close this view and open it again.</p>
        <Button
          ref={this.props.backButtonRef}
          className="self-start"
          variant="outline"
          onClick={this.props.onBack}
        >
          Back to Atrium
        </Button>
      </section>
    );
  }
}
