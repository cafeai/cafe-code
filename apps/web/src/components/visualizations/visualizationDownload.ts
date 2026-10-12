/** One application-wide download handoff retains at most16MiB for60seconds.
 * A download dispatch is not a disk-write receipt. The ordinary browser/native
 * download owner chooses the destination; no arbitrary filesystem bridge or
 * live guest is given write authority. HTML remains inert in this application. */
let handoff: { url: string; timer: ReturnType<typeof setTimeout> } | null = null;
export function downloadPortableVisualization(html: string) {
  if (
    handoff ||
    html.length > 16 * 1024 * 1024 ||
    new TextEncoder().encode(html).byteLength > 16 * 1024 * 1024
  )
    throw new Error("download-unavailable");
  const blob = new Blob([html], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const release = () => {
    if (handoff?.url !== url) return;
    clearTimeout(handoff.timer);
    handoff = null;
    URL.revokeObjectURL(url);
  };
  handoff = { url, timer: setTimeout(release, 60_000) };
  try {
    link.href = url;
    link.download = "visualization.html";
    link.rel = "noopener noreferrer";
    document.body.append(link);
    link.click();
  } catch {
    release();
    throw new Error("download-unavailable");
  } finally {
    link.remove();
  }
  return release;
}
