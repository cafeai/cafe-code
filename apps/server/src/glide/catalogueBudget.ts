/** Retained catalogues keep a provider-owned relay available for a later
 * Computer use button click. They are separate from the smaller limits on
 * simultaneous publications and executing Glide kernels. This is an explicit
 * catalogue increase, not a claim that relay processes consume no memory. */
export const GLIDE_CATALOGUE_MAX_ENTRIES = 128;
export const GLIDE_CATALOGUE_MAX_BYTES = 128 * 1024 * 1024;

/** Capacity refusals are finite presentation evidence. Never attach a token,
 * private path, source bytes or an underlying native error to this error. */
export class GlideCatalogueCapacityError extends Error {
  constructor() {
    super("Computer use has reached its session resource capacity.");
    this.name = "GlideCatalogueCapacityError";
  }
}

/** Each successful reservation owns one catalogue and its copied private-file
 * extent. Admission and retirement are synchronous, so concurrent async
 * publishers cannot observe the same remaining capacity before charging it.
 * The caller must retain the reservation when native cleanup is uncertain. */
export function makeGlideCatalogueBudget(): {
  readonly reserve: (bytes: number) => () => void;
} {
  let entries = 0;
  let retainedBytes = 0;
  return {
    reserve(bytes) {
      if (
        !Number.isSafeInteger(bytes) ||
        bytes <= 0 ||
        entries >= GLIDE_CATALOGUE_MAX_ENTRIES ||
        bytes > GLIDE_CATALOGUE_MAX_BYTES - retainedBytes
      ) {
        throw new GlideCatalogueCapacityError();
      }
      entries++;
      retainedBytes += bytes;
      let released = false;
      return () => {
        // Repeated disposal and a racing owner shutdown retire the same charge
        // once. No caller can release another reservation or enlarge a limit.
        if (released) return;
        released = true;
        entries--;
        retainedBytes -= bytes;
      };
    },
  };
}
