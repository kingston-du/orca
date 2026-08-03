import {
  formatCaptureDate,
  formatCompactCaptureTime,
  formatDetailedCaptureTime,
  formatExactCaptureTime,
  formatSharedDate,
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

describe("the quiet Moment forms", () => {
  const now = new Date("2026-08-02T00:00:00.000Z");

  it("uses compact elapsed time on a card and full words in detail", () => {
    expect(formatCompactCaptureTime("2026-08-01T23:21:00.000Z", 0, now)).toBe(
      "39m",
    );
    expect(formatDetailedCaptureTime("2026-08-01T23:21:00.000Z", 0, now)).toBe(
      "39 minutes ago",
    );

    expect(formatCompactCaptureTime("2026-08-01T16:00:00.000Z", 0, now)).toBe(
      "8h",
    );
    expect(formatDetailedCaptureTime("2026-08-01T16:00:00.000Z", 0, now)).toBe(
      "8 hours ago",
    );
  });

  it("keeps elapsed time through 23 hours even across a calendar boundary", () => {
    expect(formatCompactCaptureTime("2026-08-01T01:00:00.000Z", 0, now)).toBe(
      "23h",
    );
  });

  it("shows only the capture date at 24 hours and beyond", () => {
    expect(formatCompactCaptureTime("2026-08-01T00:00:00.000Z", 0, now)).toBe(
      "Aug 1, 2026",
    );
    expect(formatDetailedCaptureTime("2026-08-01T00:00:00.000Z", 0, now)).toBe(
      "Aug 1, 2026",
    );
  });

  it("uses the photo's capture calendar for an older date", () => {
    // The UTC instant is already Aug 1, but the photo was taken on July 31 in
    // its -07:00 capture offset.
    expect(formatCaptureDate("2026-08-01T02:00:00.000Z", -420)).toBe(
      "Jul 31, 2026",
    );
  });

  it("handles singular units and credible future clock skew", () => {
    expect(formatDetailedCaptureTime("2026-08-01T23:59:00.000Z", 0, now)).toBe(
      "1 minute ago",
    );
    expect(formatDetailedCaptureTime("2026-08-01T23:00:00.000Z", 0, now)).toBe(
      "1 hour ago",
    );
    expect(formatCompactCaptureTime("2026-08-02T00:03:00.000Z", 0, now)).toBe(
      "now",
    );
    expect(formatDetailedCaptureTime("2026-08-02T00:03:00.000Z", 0, now)).toBe(
      "just now",
    );
  });

  it("keeps unknown sharing fallback free of a clock too", () => {
    expect(formatSharedDate("2026-08-01T23:59:00.000Z")).toBe("Aug 1, 2026");
    expect(formatSharedDate("not a date")).toBeNull();
  });
});
