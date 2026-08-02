/**
 * Recording that someone actually looked at a Moment.
 *
 * Section 8 sets the bar deliberately high: a card counts as seen only after it
 * has been at least 85% visible for a full second while Home is focused and the
 * app is in the foreground. On the deck, "the settled current card" *is* that
 * condition — it is the only card drawn at full size and full opacity, and a
 * card that is still moving has not settled — so the dwell timer starts when the
 * position settles and is cancelled the moment anything changes.
 *
 * Writes are batched for roughly two seconds and flushed early on leave or
 * background, because a viewer swiping quickly would otherwise produce one
 * round trip per card. There is deliberately **no offline queue**: a seen record
 * the server never received is a fact about a session that has ended, and
 * replaying it hours later would move the unseen partition of a session the
 * viewer has long since left. Dropping it is the honest behaviour.
 */

/** How long a card must stay settled and visible before it counts. */
export const SEEN_DWELL_MS = 1000;

/** How long recorded IDs accumulate before a flush goes out. */
export const SEEN_FLUSH_MS = 2000;

export type SeenReporter = {
  /** A card settled into view. Starts its dwell timer. */
  enter: (momentId: string) => void;
  /** Focus, foreground, or position was lost before the dwell completed. */
  leave: () => void;
  /** Send whatever has been recorded so far. */
  flush: () => void;
  /** Unmount. Flushes first, so a screen exit does not lose the last card. */
  dispose: () => void;
};

export function createSeenReporter(
  send: (momentIds: string[]) => Promise<unknown>,
): SeenReporter {
  const queued = new Set<string>();
  // Anything already accepted by the server stays here for the life of the
  // screen, so a viewer swiping back and forth across three cards does not
  // re-send them every time.
  const settled = new Set<string>();

  let dwell: ReturnType<typeof setTimeout> | null = null;
  let batch: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function clearDwell() {
    if (dwell) clearTimeout(dwell);
    dwell = null;
  }

  function flush() {
    if (batch) clearTimeout(batch);
    batch = null;

    const ids = [...queued];
    if (ids.length === 0) return;
    queued.clear();
    for (const id of ids) settled.add(id);

    // A failed flush is dropped rather than retried or persisted. The server
    // record is idempotent, so the next session simply marks it again.
    void Promise.resolve(send(ids)).catch(() => {
      for (const id of ids) settled.delete(id);
    });
  }

  return {
    enter(momentId: string) {
      clearDwell();
      if (disposed || settled.has(momentId) || queued.has(momentId)) return;
      dwell = setTimeout(() => {
        dwell = null;
        queued.add(momentId);
        if (!batch) batch = setTimeout(flush, SEEN_FLUSH_MS);
      }, SEEN_DWELL_MS);
    },

    leave() {
      clearDwell();
      flush();
    },

    flush,

    dispose() {
      disposed = true;
      clearDwell();
      flush();
    },
  };
}
