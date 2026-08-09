/** Home's live window is measured from credible capture time on the server. */
export const LIVE_RECENT_WINDOW_MS = 24 * 60 * 60 * 1_000;

type ExpiringRecentRow = {
  captured_at: string | null;
  session_started_at: string;
};

/**
 * Milliseconds until the first retained Home row reaches captured_at + 24h.
 *
 * The subtraction uses each row's server `session_started_at`, not the device
 * clock. A phone with a wrong clock may wake this best-effort timer late by the
 * request's transit time, but it cannot widen the server-owned window. Focus
 * and foreground revalidation remain the authoritative recovery path.
 */
export function nextRecentExpiryDelayMs(
  moments: readonly ExpiringRecentRow[],
): number | null {
  let earliest = Number.POSITIVE_INFINITY;

  for (const moment of moments) {
    if (moment.captured_at === null) continue;
    const capturedAt = Date.parse(moment.captured_at);
    const serverNow = Date.parse(moment.session_started_at);
    if (!Number.isFinite(capturedAt) || !Number.isFinite(serverNow)) continue;
    earliest = Math.min(
      earliest,
      capturedAt + LIVE_RECENT_WINDOW_MS - serverNow,
    );
  }

  return Number.isFinite(earliest) ? Math.max(earliest, 0) : null;
}
