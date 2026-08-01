/**
 * The deck's performance harness.
 *
 * It is deliberately **not** gated on `__DEV__`. A development build runs
 * unoptimized JavaScript over a Metro bridge; its timings say nothing useful
 * about what a person holding an iPhone SE actually experiences, so the only
 * measurement worth taking is one taken in a release build. That means the gate
 * has to be something a release build can carry.
 *
 * `EXPO_PUBLIC_ORCA_DECK_METRICS` is inlined at bundle time, so an ordinary
 * build compiles the check down to a constant false and every call below
 * becomes an empty function around dead code. Nothing here is reachable in a
 * build that was not made specifically to measure.
 *
 * What it records is durations and a stage name. No Moment ID, author, caption,
 * object path, or signed URL is ever timed, logged, or retained — a performance
 * trace is not a place to leak who shared what.
 */

export type DeckStage =
  /** Home asked the server for a page. */
  | "page_requested"
  /** The first card's metadata is on screen. */
  | "page_rendered"
  /** A card asked for a signed media URL. */
  | "photo_requested"
  /** That card's photo finished decoding. */
  | "photo_shown"
  /** Older or Newer was invoked. */
  | "move_requested"
  /** The deck settled on the destination card. */
  | "move_settled";

export type DeckSample = { stage: DeckStage; at: number };

const timeline: DeckSample[] = [];

/** Read on every call rather than captured once, so a test can flip it. In a
 * release build the comparison is constant-folded and this whole module is
 * inert. */
export function isDeckInstrumentationEnabled(): boolean {
  return process.env.EXPO_PUBLIC_ORCA_DECK_METRICS === "1";
}

export function markDeckStage(stage: DeckStage, now = Date.now()): void {
  if (!isDeckInstrumentationEnabled()) return;
  timeline.push({ stage, at: now });
}

export function readDeckTimeline(): readonly DeckSample[] {
  return timeline;
}

export function resetDeckTimeline(): void {
  timeline.length = 0;
}

/**
 * Milliseconds between the most recent occurrence of each stage, or null when
 * either has not happened. This is what the harness screen reports and what a
 * release-build measurement run records against the budgets in Section 21.
 */
export function measureDeckStages(
  from: DeckStage,
  to: DeckStage,
  samples: readonly DeckSample[] = timeline,
): number | null {
  const end = findLast(samples, (s) => s.stage === to);
  if (!end) return null;

  const start = findLast(
    samples.filter((s) => s.at <= end.at),
    (s) => s.stage === from,
  );
  return start ? end.at - start.at : null;
}

function findLast<T>(items: readonly T[], match: (item: T) => boolean) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (match(items[index])) return items[index];
  }
  return undefined;
}
