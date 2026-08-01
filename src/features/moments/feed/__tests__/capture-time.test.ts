import {
  formatExactCaptureTime,
  formatFriendlyCaptureTime,
} from "@/features/moments/capture-time";

describe("the exact form", () => {
  it("reads the wall clock the photo was taken on, not the viewer's", () => {
    // 2026-01-14T21:07Z is 06:07 the next morning in Tokyo (+540).
    expect(formatExactCaptureTime("2026-01-14T21:07:00.000Z", 540)).toBe(
      "Jan 15, 2026 at 6:07 AM",
    );
  });

  it("keeps a negative offset on the earlier calendar day", () => {
    expect(formatExactCaptureTime("2026-01-15T02:30:00.000Z", -300)).toBe(
      "Jan 14, 2026 at 9:30 PM",
    );
  });

  it("renders midnight and noon in twelve-hour form", () => {
    expect(formatExactCaptureTime("2026-03-01T00:00:00.000Z", 0)).toBe(
      "Mar 1, 2026 at 12:00 AM",
    );
    expect(formatExactCaptureTime("2026-03-01T12:00:00.000Z", 0)).toBe(
      "Mar 1, 2026 at 12:00 PM",
    );
  });

  it("returns null rather than a wrong date for an unparseable instant", () => {
    expect(formatExactCaptureTime("not a date", 0)).toBeNull();
  });
});

describe("the friendly form", () => {
  // Built from local components on purpose: "Today" is the *viewer's* day, so
  // the test must not depend on the timezone the runner happens to be in.
  const now = new Date(2026, 7, 1, 15, 0, 0);

  it("says Today against the viewer's day", () => {
    expect(formatFriendlyCaptureTime("2026-08-01T14:00:00.000Z", 0, now)).toBe(
      "Today at 2:00 PM",
    );
  });

  it("says Yesterday against the viewer's day", () => {
    expect(formatFriendlyCaptureTime("2026-07-31T14:00:00.000Z", 0, now)).toBe(
      "Yesterday at 2:00 PM",
    );
  });

  it("falls back to the exact form beyond yesterday", () => {
    expect(formatFriendlyCaptureTime("2026-07-20T14:00:00.000Z", 0, now)).toBe(
      "Jul 20, 2026 at 2:00 PM",
    );
  });

  it("keeps the clock in the capture offset even when the day is Today", () => {
    // Captured at 23:00 in Tokyo on Aug 1, which is still Aug 1 for a viewer
    // whose own date is Aug 1. The clock must read the Tokyo wall time.
    expect(
      formatFriendlyCaptureTime("2026-08-01T14:00:00.000Z", 540, now),
    ).toBe("Today at 11:00 PM");
  });
});
