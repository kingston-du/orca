import type { HistoryMoment } from "@/features/moments/history/history-api";
import {
  HISTORY_COLUMNS,
  UNKNOWN_CAPTURE_SECTION,
  toHistoryRows,
} from "@/features/moments/history/history-rows";

function moment(overrides: Partial<HistoryMoment> = {}): HistoryMoment {
  return {
    moment_id: "m1",
    author_id: "a1",
    author_username: "ada",
    author_display_name: "Ada",
    author_avatar_path: null,
    kind: "recent",
    captured_at: "2026-01-14T21:07:00.000Z",
    captured_utc_offset_minutes: 540,
    capture_evidence: "camera_clock",
    caption: null,
    published_at: "2026-01-15T02:00:00.000Z",
    object_path: "a1/m1/media.jpg",
    media_width: 1600,
    media_height: 2000,
    viewer_is_author: false,
    ...overrides,
  };
}

describe("grouping", () => {
  it("groups by the month the photo was taken in, not the viewer's", () => {
    // 21:07Z on 31 January at +540 is 06:07 on 1 February in Tokyo. A viewer in
    // Toronto must still see it filed under February.
    const rows = toHistoryRows([
      moment({
        moment_id: "m1",
        captured_at: "2026-01-31T21:07:00.000Z",
        captured_utc_offset_minutes: 540,
      }),
    ]);

    expect(rows[0]).toEqual({
      kind: "header",
      key: "header:February 2026",
      title: "February 2026",
    });
  });

  it("starts a new section at each month boundary", () => {
    const rows = toHistoryRows([
      moment({ moment_id: "m1", captured_at: "2026-03-02T12:00:00.000Z" }),
      moment({ moment_id: "m2", captured_at: "2026-03-01T12:00:00.000Z" }),
      moment({ moment_id: "m3", captured_at: "2026-02-20T12:00:00.000Z" }),
    ]);

    expect(rows.map((row) => row.kind)).toEqual([
      "header",
      "photos",
      "header",
      "photos",
    ]);
  });

  it("puts every unknown capture date in one final section", () => {
    const rows = toHistoryRows([
      moment({ moment_id: "m1" }),
      moment({
        moment_id: "m2",
        captured_at: null,
        captured_utc_offset_minutes: null,
        capture_evidence: "unknown",
      }),
      moment({
        moment_id: "m3",
        captured_at: null,
        captured_utc_offset_minutes: null,
        capture_evidence: "unknown",
      }),
    ]);

    const last = rows.at(-2);
    expect(last).toMatchObject({
      kind: "header",
      title: UNKNOWN_CAPTURE_SECTION,
    });
    // Publication time is never relabelled as capture time; it just says so.
    expect(rows.at(-1)).toMatchObject({ kind: "photos" });
    expect((rows.at(-1) as { moments: HistoryMoment[] }).moments).toHaveLength(
      2,
    );
  });
});

describe("bounded rows", () => {
  it("never puts more than one row's worth of photos in a row", () => {
    const rows = toHistoryRows(
      Array.from({ length: 7 }, (_, index) =>
        moment({ moment_id: `m${index}` }),
      ),
    );

    const photoRows = rows.filter((row) => row.kind === "photos");
    for (const row of photoRows) {
      expect(
        (row as { moments: HistoryMoment[] }).moments.length,
      ).toBeLessThanOrEqual(HISTORY_COLUMNS);
    }
    // Seven photos, three across: three rows, the last one short.
    expect(photoRows).toHaveLength(3);
  });

  it("does not carry a partial row across a month boundary", () => {
    const rows = toHistoryRows([
      moment({ moment_id: "m1", captured_at: "2026-03-02T12:00:00.000Z" }),
      moment({ moment_id: "m2", captured_at: "2026-02-20T12:00:00.000Z" }),
    ]);

    const photoRows = rows.filter((row) => row.kind === "photos") as {
      moments: HistoryMoment[];
    }[];
    expect(photoRows).toHaveLength(2);
    expect(photoRows[0].moments).toHaveLength(1);
    expect(photoRows[1].moments).toHaveLength(1);
  });

  it("returns nothing at all for an empty page", () => {
    expect(toHistoryRows([])).toEqual([]);
  });
});
