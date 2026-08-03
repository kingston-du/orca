import {
  canFollowLinkNow,
  nextPendingNavigation,
  pushRouteToPath,
  queryKeysToInvalidate,
  toPushEventId,
  toPushRoute,
} from "@/features/notifications/notification-routing";

const MOMENT = "aa000000-0000-4000-8000-000000000001";
const EVENT = "bb000000-0000-4000-8000-000000000001";

describe("reading a push payload", () => {
  it("reads the three routes the worker actually sends", () => {
    expect(toPushRoute({ e: EVENT, r: "requests" })).toEqual({
      kind: "requests",
    });
    expect(toPushRoute({ e: EVENT, r: "people" })).toEqual({ kind: "people" });
    expect(toPushRoute({ e: EVENT, r: "moment", id: MOMENT })).toEqual({
      kind: "moment",
      momentId: MOMENT,
    });
  });

  it.each([
    ["nothing at all", undefined],
    ["null", null],
    ["a string", "moment"],
    ["an array", ["moment"]],
    ["an unknown route", { r: "settings" }],
    ["a Moment route with no id", { r: "moment" }],
    ["a Moment route whose id is not a UUID", { r: "moment", id: "../../etc" }],
    ["a Moment route carrying a number", { r: "moment", id: 7 }],
  ])("refuses %s rather than guessing", (_label, payload) => {
    expect(toPushRoute(payload)).toBeNull();
  });

  it("reads the event id only when it is a UUID", () => {
    expect(toPushEventId({ e: EVENT })).toBe(EVENT);
    expect(toPushEventId({ e: "not-a-uuid" })).toBeNull();
    expect(toPushEventId({})).toBeNull();
    expect(toPushEventId(null)).toBeNull();
  });

  it("routes friend events to a list and never to a profile", () => {
    // A profile UUID on a lock screen is a relationship detail, so friend
    // notifications carry no identifier and land on People.
    expect(pushRouteToPath({ kind: "requests" })).toBe("/people");
    expect(pushRouteToPath({ kind: "people" })).toBe("/people");
    expect(pushRouteToPath({ kind: "moment", momentId: MOMENT })).toBe(
      `/moments/${MOMENT}`,
    );
  });
});

describe("following a link while a draft is in flight", () => {
  it("waits while publishing and follows once it settles", () => {
    expect(canFollowLinkNow(true)).toBe(false);
    expect(canFollowLinkNow(false)).toBe(true);
  });

  it("holds exactly one intent, and the newest wins", () => {
    const first = { eventId: EVENT, route: { kind: "people" as const } };
    const second = {
      eventId: null,
      route: { kind: "moment" as const, momentId: MOMENT },
    };
    // Three unread notifications must not become three navigations after an
    // upload finishes. None of those taps meant that.
    expect(nextPendingNavigation(first, second)).toBe(second);
    expect(nextPendingNavigation(null, first)).toBe(first);
  });
});

describe("what a delivered notification invalidates", () => {
  it("never invalidates the live Recent deck", () => {
    // Section 18: a foreground receipt updates the non-disruptive pill and
    // never inserts into or reorders the deck.
    const keys = queryKeysToInvalidate({ kind: "moment", momentId: MOMENT });
    expect(keys).toContain("recent-arrivals");
    expect(keys).not.toContain("recent-moments");
    expect(keys).not.toContain("highlight-moments");
  });

  it("scopes friend events to the friend surfaces", () => {
    expect(queryKeysToInvalidate({ kind: "requests" })).toEqual([
      "friend-requests",
      "friends",
    ]);
  });
});
