/** Await only the fixed bundled generated faces while the caller's inert
 * bootstrap pulse continues. This helper owns no timer, cache, received input,
 * frame or native authority: the caller retains the original startup deadline
 * and must recheck its own document lifecycle before replacement. */
export async function installFontReadyGeneratedDocument(
  load: () => Promise<readonly FontFace[]>,
  isCurrent: () => boolean,
  commit: () => Promise<boolean>,
  replace: (faces: readonly FontFace[]) => void,
  refuse: () => void,
): Promise<void> {
  try {
    const faces = await load();
    // A retired bootstrap must never parse source or send a successful ACK
    // merely because its previously pending fixed font decode later resolves.
    if (!isCurrent()) return;
    // Font readiness is not native authority. Ask the exact owner to reobserve
    // its original pending frame/installation before any source is parsed; an
    // undelivered cancellation cannot turn an already revoked owner into one.
    const admitted = await commit();
    if (!isCurrent()) return;
    if (!admitted) {
      refuse();
      return;
    }
    replace(faces);
  } catch {
    // Received/font errors stay opaque. Cancellation needs no second result;
    // main already owns exact-child retirement and its absolute startup fence.
    if (isCurrent()) refuse();
  }
}

export const GENERATED_VISUALIZATION_FONTS_READY_CHANNEL = "cafe-visualization:fonts-ready";
export function isGeneratedFontInstallNonce(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
  );
}

/** One private source-install attempt has one readiness request and one native
 * authorization. No page-facing bridge, received source, retry, cache or timer
 * is exposed. The exact child owner remains responsible for the original total
 * startup budget and terminal cancellation if its proof is refused. */
export class GeneratedVisualizationFontCommit {
  private readonly nonce: string;
  private pending: Promise<boolean> | undefined;
  private resolve: ((admitted: boolean) => void) | undefined;
  private cancelled = false;
  constructor(nonce: string) {
    if (!isGeneratedFontInstallNonce(nonce))
      throw new Error("Generated visualization installation was refused.");
    this.nonce = nonce;
  }
  request(send: (nonce: string) => void): Promise<boolean> {
    if (this.cancelled) return Promise.resolve(false);
    if (this.pending) return this.pending;
    this.pending = new Promise<boolean>((resolve) => {
      this.resolve = resolve;
    });
    try {
      send(this.nonce);
    } catch {
      this.cancel();
    }
    return this.pending;
  }
  receive(raw: unknown): boolean {
    if (
      this.cancelled ||
      !this.resolve ||
      typeof raw !== "object" ||
      raw === null ||
      Array.isArray(raw) ||
      Object.keys(raw).length !== 2 ||
      Reflect.get(raw, "kind") !== "commit-install" ||
      Reflect.get(raw, "nonce") !== this.nonce
    )
      return false;
    const resolve = this.resolve;
    this.resolve = undefined;
    resolve(true);
    return true;
  }
  cancel(): void {
    this.cancelled = true;
    this.resolve?.(false);
    this.resolve = undefined;
  }
}

/** A terminal native cancellation is not an ordinary visibility hint. Admit
 * only its fixed private scalar form, and only while generated readiness is
 * pending. External Apps, parsed documents and malformed/replayed data cannot
 * acquire a new installation or cancellation lifecycle through this helper. */
export function cancelsPendingGeneratedFontInstall(raw: unknown, pending: boolean): boolean {
  return (
    pending &&
    typeof raw === "object" &&
    raw !== null &&
    !Array.isArray(raw) &&
    Object.keys(raw).length === 1 &&
    Reflect.get(raw, "kind") === "cancel-install"
  );
}
