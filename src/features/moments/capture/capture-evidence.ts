import {
  MAX_UTC_OFFSET_MINUTES,
  RECENT_FUTURE_SKEW_MS,
  RECENT_WINDOW_MS,
} from "@/constants/moments";
import { formatExactCaptureTime } from "@/features/moments/capture-time";

/**
 * Capture evidence: the only thing Orca keeps from a photo's metadata.
 *
 * A picker asset arrives with a full EXIF/TIFF/GPS dictionary. This module is
 * the single place that touches it, reads exactly two allowlisted keys, and
 * returns a small immutable value. The dictionary itself is never stored,
 * returned, spread, serialized, or logged — the re-encode in `photo-normalizer`
 * then strips every byte of it from the file Orca actually keeps.
 *
 * Orca is deliberately honest about what this proves: nothing. A device clock
 * and a picker's `DateTimeOriginal` are both client claims. The server enforces
 * the admission window at finalization but never presents a claim as
 * cryptographically trustworthy, and Orca adds no attestation infrastructure.
 */

/** Mirrors the Moment table's evidence enum. */
export type CredibleCaptureEvidence =
  "camera_clock" | "picker_original_with_offset";

export type CaptureEvidence =
  | {
      evidence: CredibleCaptureEvidence;
      capturedAt: string;
      capturedUtcOffsetMinutes: number;
    }
  | {
      evidence: "unknown";
      capturedAt: null;
      capturedUtcOffsetMinutes: null;
    };

/** Mirrors the Moment table's kind enum. */
export type MomentKind = "recent" | "archive";

/**
 * The table constraint is `unknown` requires *both* columns null, so the
 * unknown case is one shared frozen value rather than a shape built ad hoc.
 */
export const UNKNOWN_CAPTURE_EVIDENCE: CaptureEvidence = Object.freeze({
  evidence: "unknown",
  capturedAt: null,
  capturedUtcOffsetMinutes: null,
});

export function isCredibleCaptureEvidence(
  evidence: CaptureEvidence,
): evidence is Extract<CaptureEvidence, { capturedAt: string }> {
  return evidence.evidence !== "unknown";
}

/**
 * The shutter records device UTC time and the offset *before* normalization,
 * because re-encoding takes long enough on a large photo to move a Moment
 * across the Recent boundary or, near midnight, onto the wrong calendar day.
 */
export function getCameraCaptureEvidence(date = new Date()): CaptureEvidence {
  const capturedUtcOffsetMinutes = -date.getTimezoneOffset();
  const capturedAt = date.toISOString();

  // A device with a nonsensical clock or an offset outside the storable range
  // is unknown evidence, not a rejected capture: the photo is still shareable
  // as Archive.
  if (
    Number.isNaN(date.getTime()) ||
    !Number.isInteger(capturedUtcOffsetMinutes) ||
    Math.abs(capturedUtcOffsetMinutes) > MAX_UTC_OFFSET_MINUTES
  ) {
    return UNKNOWN_CAPTURE_EVIDENCE;
  }

  return {
    evidence: "camera_clock",
    capturedAt,
    // JavaScript reports minutes *west* of UTC; Orca stores the conventional
    // signed offset, so Los Angeles is −420 during daylight time.
    capturedUtcOffsetMinutes,
  };
}

/**
 * EXIF writes an offset as `±HH:MM`. There is no other accepted spelling here:
 * a bare `Z`, a numeric field, or a vendor variant is treated as absent, which
 * is what makes the timezone half of the claim explicit rather than assumed.
 */
export function parseExifUtcOffsetMinutes(value: unknown): number | null {
  if (typeof value !== "string") return null;

  const match = /^([+-])(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const [, sign, rawHours, rawMinutes] = match;
  const hours = Number(rawHours);
  const minutes = Number(rawMinutes);
  if (minutes > 59) return null;

  const total = hours * 60 + minutes;
  if (total > MAX_UTC_OFFSET_MINUTES) return null;

  // `-00:00` and `+00:00` are the same instant; normalize away negative zero so
  // the value round-trips through JSON and Postgres identically.
  return total === 0 ? 0 : sign === "-" ? -total : total;
}

type CalendarParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

/**
 * EXIF writes the original capture instant as `YYYY:MM:DD HH:MM:SS` in the
 * camera's *local* calendar, with no zone of its own. Cameras that never had
 * their clock set write all-zero fields, so those are rejected outright, and
 * the parsed day is round-tripped through `Date.UTC` to reject `2026:02:30`.
 */
export function parseExifOriginalDateTime(
  value: unknown,
): CalendarParts | null {
  if (typeof value !== "string") return null;

  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(
    value.trim(),
  );
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match.map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];

  if (year === 0 || month === 0 || day === 0) return null;
  if (month > 12 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }

  const utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day, hour, minute, second };
}

/**
 * The complete allowlist. `DateTimeOriginal` alone is not enough: without
 * `OffsetTimeOriginal` the instant is ambiguous by up to a day, so a photo
 * carrying only a local wall-clock time is unknown evidence. Everything else
 * the picker hands over — `DateTime` (a generic modified time), filename,
 * asset identifier, make/model, and every `GPS*` key — is deliberately never
 * read.
 */
const ALLOWED_EXIF_KEYS = ["DateTimeOriginal", "OffsetTimeOriginal"] as const;

export function readCaptureEvidenceFromExif(exif: unknown): CaptureEvidence {
  if (typeof exif !== "object" || exif === null) {
    return UNKNOWN_CAPTURE_EVIDENCE;
  }

  const source = exif as Record<string, unknown>;
  const [dateTimeOriginalKey, offsetTimeOriginalKey] = ALLOWED_EXIF_KEYS;

  const parts = parseExifOriginalDateTime(source[dateTimeOriginalKey]);
  const capturedUtcOffsetMinutes = parseExifUtcOffsetMinutes(
    source[offsetTimeOriginalKey],
  );

  if (parts === null || capturedUtcOffsetMinutes === null) {
    return UNKNOWN_CAPTURE_EVIDENCE;
  }

  const utcMilliseconds =
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    ) -
    capturedUtcOffsetMinutes * 60_000;

  if (!Number.isFinite(utcMilliseconds)) return UNKNOWN_CAPTURE_EVIDENCE;

  return {
    evidence: "picker_original_with_offset",
    capturedAt: new Date(utcMilliseconds).toISOString(),
    capturedUtcOffsetMinutes,
  };
}

/**
 * `server_now − 24h ≤ captured_at ≤ server_now + 5min`.
 *
 * The client evaluates this only to choose which audience rules the composer
 * presents. Recent versus Archive is fixed by the *server* at successful
 * publication, so a draft that ages while it sits on the device must be
 * reclassified and reviewed rather than published under stale rules.
 */
export function classifyCapture(
  evidence: CaptureEvidence,
  nowMilliseconds: number,
): MomentKind {
  if (!isCredibleCaptureEvidence(evidence)) return "archive";

  const capturedMilliseconds = Date.parse(evidence.capturedAt);
  if (!Number.isFinite(capturedMilliseconds)) return "archive";

  return capturedMilliseconds >= nowMilliseconds - RECENT_WINDOW_MS &&
    capturedMilliseconds <= nowMilliseconds + RECENT_FUTURE_SKEW_MS
    ? "recent"
    : "archive";
}

/**
 * The composer's label for a credible capture time. The arithmetic lives in
 * `capture-time.ts` because the feed asks the same question and the two must
 * never drift apart.
 */
export function formatCaptureLocalTime(
  evidence: CaptureEvidence,
): string | null {
  if (!isCredibleCaptureEvidence(evidence)) return null;

  return formatExactCaptureTime(
    evidence.capturedAt,
    evidence.capturedUtcOffsetMinutes,
  );
}
