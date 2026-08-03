/**
 * Rendering a capture time in the calendar the photo was taken in.
 *
 * The composer and the feed both face the same question and must answer it the
 * same way: a Moment captured at 11pm in Tokyo was captured on *that* day, and
 * a viewer in Toronto must not see it moved to the previous afternoon. So none
 * of this uses the device timezone or `Intl`. It shifts the stored UTC instant
 * by the offset that was recorded at capture and reads the UTC fields back —
 * the only arithmetic that reproduces the original wall clock.
 *
 * English/12-hour only, matching the V1 iOS beta. Localization is a later
 * decision, not an accidental one.
 */

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const FULL_MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/**
 * The capture instant expressed as a UTC date whose fields read as the original
 * local wall clock. Returns null for anything unparseable, because an
 * unknown capture time is a real state the surfaces above must render, not an
 * error to throw at a viewer.
 */
function shiftToCaptureOffset(
  capturedAt: string,
  capturedUtcOffsetMinutes: number,
): Date | null {
  const shifted = new Date(
    Date.parse(capturedAt) + capturedUtcOffsetMinutes * 60_000,
  );
  return Number.isNaN(shifted.getTime()) ? null : shifted;
}

function formatClock(shifted: Date) {
  const hours24 = shifted.getUTCHours();
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  const minutes = String(shifted.getUTCMinutes()).padStart(2, "0");
  return `${hours12}:${minutes} ${hours24 < 12 ? "AM" : "PM"}`;
}

/**
 * The unambiguous form: "Jan 14, 2026 at 9:07 PM". This is what VoiceOver
 * reads, so it never uses a relative word that depends on when the screen
 * happens to be open.
 */
export function formatExactCaptureTime(
  capturedAt: string,
  capturedUtcOffsetMinutes: number,
): string | null {
  const shifted = shiftToCaptureOffset(capturedAt, capturedUtcOffsetMinutes);
  if (!shifted) return null;

  return (
    `${MONTH_NAMES[shifted.getUTCMonth()]} ${shifted.getUTCDate()}, ` +
    `${shifted.getUTCFullYear()} at ${formatClock(shifted)}`
  );
}

/**
 * The capture date without a clock. Once a Moment is no longer recent enough
 * for elapsed time to be useful, the calendar day is the whole answer — adding
 * a time makes quiet metadata read like a receipt.
 */
export function formatCaptureDate(
  capturedAt: string,
  capturedUtcOffsetMinutes: number,
): string | null {
  const shifted = shiftToCaptureOffset(capturedAt, capturedUtcOffsetMinutes);
  if (!shifted) return null;

  return `${MONTH_NAMES[shifted.getUTCMonth()]} ${shifted.getUTCDate()}, ${shifted.getUTCFullYear()}`;
}

/**
 * When a Moment was *shared*, in the viewer's own local time.
 *
 * This is the one timestamp that genuinely belongs to the reader's clock: it
 * answers "when did this arrive", not "when was this photo taken". Detail may
 * label it as sharing time. Nothing may ever label it as capture time — that is
 * the whole reason the two formatters are separate functions with separate
 * names rather than one with a flag.
 */
export function formatSharedDate(publishedAt: string): string | null {
  const at = new Date(Date.parse(publishedAt));
  if (Number.isNaN(at.getTime())) return null;

  return `${MONTH_NAMES[at.getMonth()]} ${at.getDate()}, ${at.getFullYear()}`;
}

/**
 * The month a Moment belongs to in its *own* calendar, which is what Diary
 * groups by.
 *
 * A photo taken at 11pm on 31 January in Tokyo belongs to January, and a viewer
 * in Toronto must not see it filed under February simply because that is what
 * their own clock said at that instant. The full month name is spelled out
 * because a section header has room for it and "Jan" reads as an abbreviation
 * of data rather than as a heading.
 */
export function formatCaptureMonth(
  capturedAt: string,
  capturedUtcOffsetMinutes: number,
): string | null {
  const shifted = shiftToCaptureOffset(capturedAt, capturedUtcOffsetMinutes);
  if (!shifted) return null;
  return `${FULL_MONTH_NAMES[shifted.getUTCMonth()]} ${shifted.getUTCFullYear()}`;
}

/**
 * Elapsed time is about the instant, not either person's calendar. The capture
 * offset matters only after 24 hours, when the UI changes to the date on which
 * the photo was actually taken.
 */
function elapsedCaptureTime(
  capturedAt: string,
  capturedUtcOffsetMinutes: number,
  now: Date,
):
  | { kind: "date"; value: string }
  | { kind: "hours"; value: number }
  | { kind: "minutes"; value: number }
  | { kind: "now" }
  | null {
  const capturedMilliseconds = Date.parse(capturedAt);
  const nowMilliseconds = now.getTime();
  if (
    !Number.isFinite(capturedMilliseconds) ||
    !Number.isFinite(nowMilliseconds) ||
    shiftToCaptureOffset(capturedAt, capturedUtcOffsetMinutes) === null
  ) {
    return null;
  }

  // Credible camera clocks may be up to five minutes ahead of the server. A
  // small future skew is not a useful thing to expose, so it reads as now.
  const elapsed = Math.max(0, nowMilliseconds - capturedMilliseconds);
  if (elapsed >= DAY_MS) {
    const date = formatCaptureDate(capturedAt, capturedUtcOffsetMinutes);
    return date ? { kind: "date", value: date } : null;
  }
  if (elapsed < MINUTE_MS) return { kind: "now" };
  if (elapsed < HOUR_MS) {
    return { kind: "minutes", value: Math.floor(elapsed / MINUTE_MS) };
  }
  return { kind: "hours", value: Math.floor(elapsed / HOUR_MS) };
}

/** The compact card form: `39m`, `8h`, or `Aug 1, 2026`. */
export function formatCompactCaptureTime(
  capturedAt: string,
  capturedUtcOffsetMinutes: number,
  now: Date,
): string | null {
  const elapsed = elapsedCaptureTime(capturedAt, capturedUtcOffsetMinutes, now);
  if (!elapsed) return null;
  if (elapsed.kind === "now") return "now";
  if (elapsed.kind === "date") return elapsed.value;
  return `${elapsed.value}${elapsed.kind === "minutes" ? "m" : "h"}`;
}

/** The detail/VoiceOver form: `39 minutes ago`, `8 hours ago`, or a date. */
export function formatDetailedCaptureTime(
  capturedAt: string,
  capturedUtcOffsetMinutes: number,
  now: Date,
): string | null {
  const elapsed = elapsedCaptureTime(capturedAt, capturedUtcOffsetMinutes, now);
  if (!elapsed) return null;
  if (elapsed.kind === "now") return "just now";
  if (elapsed.kind === "date") return elapsed.value;

  const unit = elapsed.kind === "minutes" ? "minute" : "hour";
  return `${elapsed.value} ${unit}${elapsed.value === 1 ? "" : "s"} ago`;
}
