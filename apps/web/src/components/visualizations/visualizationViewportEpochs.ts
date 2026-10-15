/** Opaque pane identities are local scheduling ownership, not wire authority. */
export type VisualizationPane = Readonly<object>;
export const createVisualizationPane = (): VisualizationPane => Object.freeze({});

/**
 * Terminal admission survives row recycling. Only a genuinely observed visible
 * -> offscreen -> visible sequence, or an explicit gesture, may renew it. Hidden
 * modals and detached DOM are not observations of an offscreen viewport.
 * Retention is finite and fail-closed: a full ledger never evicts a stopped key
 * and accidentally turns its remount into a fresh automatic entitlement.
 */
export function createVisualizationViewportEpochs(limit = 1024) {
  const entries = new Map<
    string,
    {
      visible: boolean;
      offscreen: boolean;
      terminal: boolean;
      epoch: number;
      layout?: ReservedLayout;
    }
  >();
  return {
    observe(key: string, visible: boolean) {
      let entry = entries.get(key);
      if (!entry) {
        if (entries.size >= limit) return false;
        entry = { visible, offscreen: false, terminal: false, epoch: 1 };
        entries.set(key, entry);
      } else if (visible && !entry.visible && entry.offscreen) {
        entry.epoch += 1;
        entry.terminal = false;
        entry.offscreen = false;
      } else if (!visible && entry.visible) entry.offscreen = true;
      entry.visible = visible;
      return !entry.terminal;
    },
    terminal(key: string) {
      let entry = entries.get(key);
      // Authority can be lost while a nearby ticket/capability awaits its
      // first true viewport sample. Remember that loss as terminal too; the
      // first later visible sample alone does not grant a renewed admission.
      if (!entry && entries.size < limit) {
        entry = { visible: false, offscreen: false, terminal: true, epoch: 1 };
        entries.set(key, entry);
      }
      if (entry) entry.terminal = true;
    },
    restart(key: string) {
      const entry = entries.get(key);
      if (!entry) return false;
      entry.epoch += 1;
      entry.terminal = false;
      return true;
    },
    allowed: (key: string) => entries.get(key)?.terminal === false,
    // A remembered scalar reserves the same chat flow after row recycling.
    // It never admits a key, renews an epoch or retains guest/source objects.
    rememberLayout(key: string, layout: ReservedLayout) {
      const entry = entries.get(key);
      if (
        !entry ||
        !Number.isInteger(layout.height) ||
        layout.height < 80 ||
        layout.height > 2000 ||
        typeof layout.constrained !== "boolean"
      )
        return false;
      entry.layout = Object.freeze({ height: layout.height, constrained: layout.constrained });
      return true;
    },
    layout: (key: string) => entries.get(key)?.layout,
    has: (key: string) => entries.has(key),
    size: () => entries.size,
    clear: () => entries.clear(),
  };
}
import type { VisualizationHostLayout } from "@cafecode/contracts/visualizationHost";

type ReservedLayout = Readonly<Pick<VisualizationHostLayout, "height" | "constrained">>;
