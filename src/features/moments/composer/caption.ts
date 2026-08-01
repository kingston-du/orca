import { MAX_CAPTION_CHARACTERS } from "@/constants/moments";

/**
 * Caption normalization, matching the Moment table's contract exactly.
 *
 * The client normalizes so the author sees an accurate remaining count and a
 * useful error before submitting; the server normalizes again and owns the
 * decision. Doing it in both places is intentional — the client copy is a
 * courtesy, never the check.
 */

const LINE_FEED = 0x0a;
const C0_END = 0x1f;
const C1_START = 0x7f;
const C1_END = 0x9f;

/**
 * Rejects NUL and every other C0/C1 control character, while preserving the
 * line feed an author may have typed on purpose. Written as an explicit scan
 * rather than a regular expression so the boundaries are readable and no
 * literal control character ever appears in this source file.
 */
function hasForbiddenControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === LINE_FEED) continue;
    if (code <= C0_END || (code >= C1_START && code <= C1_END)) return true;
  }
  return false;
}

export type CaptionValidation =
  | { ok: true; caption: string | null }
  | { ok: false; reason: "too_long" | "unsupported_characters" };

/**
 * Postgres `char_length` counts code points; JavaScript's `.length` counts
 * UTF-16 units, so a single emoji would otherwise cost two characters here and
 * one on the server. Spreading the string iterates code points.
 */
export function captionLength(caption: string): number {
  return [...caption].length;
}

function toCanonicalCaption(raw: string): string {
  return (
    raw
      .normalize("NFC")
      // CRLF becomes LF; a lone CR would otherwise survive as a forbidden
      // control character and reject an otherwise ordinary paste.
      .replace(/\r\n?/g, "\n")
      .trim()
  );
}

export function normalizeCaption(raw: string): CaptionValidation {
  const normalized = toCanonicalCaption(raw);

  if (hasForbiddenControlCharacter(normalized)) {
    return { ok: false, reason: "unsupported_characters" };
  }

  if (captionLength(normalized) > MAX_CAPTION_CHARACTERS) {
    return { ok: false, reason: "too_long" };
  }

  // An empty caption is null on the server, not an empty string, so there is
  // exactly one representation of "no caption".
  return { ok: true, caption: normalized.length === 0 ? null : normalized };
}

export function captionCharactersRemaining(raw: string): number {
  return MAX_CAPTION_CHARACTERS - captionLength(toCanonicalCaption(raw));
}
