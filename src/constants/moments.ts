/**
 * Bounds the Moment contract fixes in `PROJECT.md` Sections 9, 14, and 17.
 *
 * The client uses them to keep a draft inside the shape the server will accept
 * and to explain limits before an author hits them. None of these values are
 * an authorization decision: the finalizer revalidates every one of them from
 * the bytes and the graph, because a client claim is never proof.
 */

/** Postgres `char_length`, so the client counts code points, not UTF-16 units. */
export const MAX_CAPTION_CHARACTERS = 160;

/** An explicit Selected audience is 1–50 recipients. All Friends has no cap. */
export const MIN_SELECTED_RECIPIENTS = 1;
export const MAX_SELECTED_RECIPIENTS = 50;

export const MAX_MOMENT_TAGS = 20;

/**
 * The admission window for Recent, not a deletion TTL. The server owns the real
 * decision at finalization; the client applies the same arithmetic only so the
 * composer can explain which audience rules apply.
 */
export const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Tolerance for a device clock that runs slightly ahead of the server. */
export const RECENT_FUTURE_SKEW_MS = 5 * 60 * 1000;

/** Matches the `−840…+840` capture-offset constraint on the Moment table. */
export const MAX_UTC_OFFSET_MINUTES = 840;

/** Normalized output bounds shared by the client normalizer and the verifier. */
export const MAX_PHOTO_LONG_EDGE = 2048;
export const MAX_PHOTO_BYTES = 6 * 1024 * 1024;
