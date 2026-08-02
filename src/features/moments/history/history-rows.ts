import { formatCaptureMonth } from "@/features/moments/capture-time";
import type { HistoryMoment } from "@/features/moments/history/history-api";

/** Three across is what keeps a thumbnail large enough to recognise a face. */
export const HISTORY_COLUMNS = 3;

export const UNKNOWN_CAPTURE_SECTION = "Unknown capture date";

export type HistoryRow =
  | { kind: "header"; key: string; title: string }
  | { kind: "photos"; key: string; moments: HistoryMoment[] };

/**
 * Flattens a history page into one list of headers and fixed-width photo rows.
 *
 * It is deliberately *flat*. Section 8 requires bounded photo rows rather than
 * nested lists, and a `SectionList` of horizontal `FlatList`s — the usual way
 * people build a photo grid — gives up virtualization at exactly the point it
 * starts to matter, because each inner list renders its whole section.
 *
 * Grouping is by the month the photo was taken in, reconstructed from the
 * stored capture offset, never from the viewer's timezone. Moments with no
 * credible capture evidence do not get guessed at: they fall into one final
 * section that says so, ordered among themselves by when they were shared.
 * Publication time is never relabelled as capture time.
 */
export function toHistoryRows(moments: HistoryMoment[]): HistoryRow[] {
  const rows: HistoryRow[] = [];
  let section: string | null = null;
  let pending: HistoryMoment[] = [];

  const flushPending = () => {
    if (pending.length === 0) return;
    rows.push({
      kind: "photos",
      key: `photos:${pending[0].moment_id}`,
      moments: pending,
    });
    pending = [];
  };

  for (const moment of moments) {
    const title =
      moment.captured_at !== null && moment.captured_utc_offset_minutes !== null
        ? (formatCaptureMonth(
            moment.captured_at,
            moment.captured_utc_offset_minutes,
          ) ?? UNKNOWN_CAPTURE_SECTION)
        : UNKNOWN_CAPTURE_SECTION;

    if (title !== section) {
      flushPending();
      section = title;
      rows.push({ kind: "header", key: `header:${title}`, title });
    }

    pending.push(moment);
    if (pending.length === HISTORY_COLUMNS) flushPending();
  }

  flushPending();
  return rows;
}
