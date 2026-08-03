/**
 * Where a notification tap goes, derived from an untrusted payload.
 *
 * Everything here treats the notification data as hostile input. A push payload
 * arrives from the network, is stored by the OS, and can be replayed; it grants
 * nothing. The route it names is opened, and the screen behind it re-fetches
 * under the caller's own RLS, so a forged or stale payload can at most send
 * someone to a screen that tells them the Moment is no longer available.
 */

export type PushRoute =
  | { kind: "requests" }
  | { kind: "people" }
  | { kind: "moment"; momentId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads the `{ e, r, id }` payload the worker sends.
 *
 * Returns null for anything unrecognized rather than guessing, because the
 * failure mode of guessing is navigating somebody somewhere they did not ask
 * to go.
 */
export function toPushRoute(data: unknown): PushRoute | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as { r?: unknown; id?: unknown };

  if (record.r === "requests") return { kind: "requests" };
  if (record.r === "people") return { kind: "people" };
  if (record.r === "moment") {
    return typeof record.id === "string" && UUID.test(record.id)
      ? { kind: "moment", momentId: record.id }
      : null;
  }
  return null;
}

/** The event UUID, used only to avoid handling one notification twice. */
export function toPushEventId(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const id = (data as { e?: unknown }).e;
  return typeof id === "string" && UUID.test(id) ? id : null;
}

export type PushRoutePath = "/people" | `/moments/${string}`;

export function pushRouteToPath(route: PushRoute): PushRoutePath {
  switch (route.kind) {
    case "requests":
      // Requests live inside People in V1; there is no separate route yet, and
      // inventing one for a notification would be placeholder navigation.
      return "/people";
    case "people":
      return "/people";
    case "moment":
      return `/moments/${route.momentId}`;
  }
}

/**
 * Whether a link may be followed right now.
 *
 * Section 18 is explicit: a draft that is preparing, uploading, or finalizing is
 * never discarded or replaced to satisfy a link. The intent is held, a
 * non-destructive banner is shown, and it executes once publishing settles.
 */
export function canFollowLinkNow(publishInFlight: boolean): boolean {
  return !publishInFlight;
}

export type PendingNavigation = { route: PushRoute; eventId: string | null };

/**
 * Exactly one intent is held, and the newest wins.
 *
 * Queueing them would mean a person who left three notifications unread gets
 * three navigations after their upload finishes, which is not what any of those
 * taps meant.
 */
export function nextPendingNavigation(
  _current: PendingNavigation | null,
  incoming: PendingNavigation,
): PendingNavigation {
  return incoming;
}

/**
 * Which cached queries a delivered notification invalidates.
 *
 * Deliberately narrow, and keyed off the route rather than the event, because
 * the route is all the payload carries. Section 18 governs the important case:
 * a foreground new-Moment receipt performs the same head check Home focus does
 * and updates the non-disruptive pill — it never inserts into or reorders the
 * live deck — so what is invalidated is the arrivals probe, not the feed.
 */
export function queryKeysToInvalidate(route: PushRoute): string[] {
  switch (route.kind) {
    case "requests":
    case "people":
      return ["friend-requests", "friends"];
    case "moment":
      // The arrivals count and the Moment's own detail. `recent-moments` is
      // deliberately absent: refetching the deck under someone's finger is
      // exactly the disruption the pill exists to avoid.
      return ["recent-arrivals", "moment-detail", "moment-reactions"];
  }
}
