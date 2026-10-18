// Stderr may contain native paths or OS errors. Only complete fixed-vocabulary
// lines are observable; retain at most 128 characters across transport chunks.
export function makeGlideNativePhaseReader(onPhase: (phase: string) => void) {
  let line = "";
  let discarded = false;
  return (chunk: Uint8Array) => {
    for (const byte of chunk) {
      if (byte === 10) {
        const match =
          !discarded &&
          line.match(
            /^glide\.phase=(paste\.(?:read-clipboard|prepare-rich|publish|send-key|await-read|restore)|incoming\.(?:observed|admitted|refused|expired)|hosted\.(?:keyboard|pointer))$/u,
          );
        line = "";
        discarded = false;
        if (match) {
          try {
            onPhase(match[1]!);
          } catch {
            // Observational diagnostics cannot change operation ownership.
          }
        }
      } else if (!discarded) {
        if (line.length === 128 || byte < 32 || byte > 126) {
          discarded = true;
          line = "";
        } else line += String.fromCharCode(byte);
      }
    }
  };
}
