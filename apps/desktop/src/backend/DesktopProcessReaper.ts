/**
 * Liveness is observational only; it never establishes process ownership.
 * Automatic process enumeration and bare-PID termination deliberately do not
 * live here. Debug and Production may share an executable, and a retained
 * native child handle or the Windows native ownership guard must own control.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
