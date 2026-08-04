import {
  classifyCapture,
  formatCaptureLocalTime,
  getCameraCaptureEvidence,
  parseExifOriginalDateTime,
  parseExifUtcOffsetMinutes,
  readCaptureEvidenceFromExif,
  UNKNOWN_CAPTURE_EVIDENCE,
} from "@/features/moments/capture/capture-evidence";

describe("parseExifUtcOffsetMinutes", () => {
  test("reads the conventional signed offset from UTC", () => {
    expect(parseExifUtcOffsetMinutes("+09:00")).toBe(540);
    expect(parseExifUtcOffsetMinutes("-07:00")).toBe(-420);
    expect(parseExifUtcOffsetMinutes("+05:45")).toBe(345);
  });

  test("normalizes both spellings of zero so the value round-trips", () => {
    expect(Object.is(parseExifUtcOffsetMinutes("-00:00"), 0)).toBe(true);
    expect(Object.is(parseExifUtcOffsetMinutes("+00:00"), 0)).toBe(true);
  });

  test("rejects anything that is not an explicit ±HH:MM offset", () => {
    for (const value of [
      "Z",
      "+9:00",
      "09:00",
      "+09:60",
      "+15:00", // outside the storable −840…+840 range
      "",
      540,
      null,
      undefined,
    ]) {
      expect(parseExifUtcOffsetMinutes(value)).toBeNull();
    }
  });
});

describe("parseExifOriginalDateTime", () => {
  test("reads the EXIF colon-separated calendar form", () => {
    expect(parseExifOriginalDateTime("2026:07:31 14:05:09")).toEqual({
      year: 2026,
      month: 7,
      day: 31,
      hour: 14,
      minute: 5,
      second: 9,
    });
  });

  test("rejects the all-zero value a never-set camera clock writes", () => {
    expect(parseExifOriginalDateTime("0000:00:00 00:00:00")).toBeNull();
  });

  test("rejects a calendar date that does not exist", () => {
    expect(parseExifOriginalDateTime("2026:02:30 10:00:00")).toBeNull();
    expect(parseExifOriginalDateTime("2026:13:01 10:00:00")).toBeNull();
    expect(parseExifOriginalDateTime("2026:07:31 25:00:00")).toBeNull();
  });
});

describe("readCaptureEvidenceFromExif", () => {
  test("combines the allowlisted date and offset into one UTC instant", () => {
    const evidence = readCaptureEvidenceFromExif({
      DateTimeOriginal: "2026:07:31 09:30:00",
      OffsetTimeOriginal: "-07:00",
    });

    expect(evidence).toEqual({
      evidence: "picker_original_with_offset",
      capturedAt: "2026-07-31T16:30:00.000Z",
      capturedUtcOffsetMinutes: -420,
    });
  });

  test("is unknown without an explicit offset, because the instant is ambiguous", () => {
    expect(
      readCaptureEvidenceFromExif({ DateTimeOriginal: "2026:07:31 09:30:00" }),
    ).toEqual(UNKNOWN_CAPTURE_EVIDENCE);
  });

  test("never falls back to a generic modified time, filename, or asset id", () => {
    expect(
      readCaptureEvidenceFromExif({
        DateTime: "2026:07:31 09:30:00",
        OffsetTime: "-07:00",
        DateTimeDigitized: "2026:07:31 09:30:00",
        FileName: "IMG_0042.HEIC",
        assetId: "ABC-123",
      }),
    ).toEqual(UNKNOWN_CAPTURE_EVIDENCE);
  });

  test("reads only the two allowlisted keys and copies nothing else out", () => {
    const evidence = readCaptureEvidenceFromExif({
      DateTimeOriginal: "2026:07:31 09:30:00",
      OffsetTimeOriginal: "+00:00",
      GPSLatitude: 51.5007,
      GPSLongitude: -0.1246,
      Make: "Apple",
      Model: "iPhone SE",
    });

    // The value must contain the evidence fields and nothing that could carry
    // location or device identity forward.
    expect(Object.keys(evidence).sort()).toEqual([
      "capturedAt",
      "capturedUtcOffsetMinutes",
      "evidence",
    ]);
    expect(JSON.stringify(evidence)).not.toMatch(/GPS|Apple|iPhone/);
  });

  test("treats a missing or non-object dictionary as unknown", () => {
    expect(readCaptureEvidenceFromExif(null)).toEqual(UNKNOWN_CAPTURE_EVIDENCE);
    expect(readCaptureEvidenceFromExif(undefined)).toEqual(
      UNKNOWN_CAPTURE_EVIDENCE,
    );
    expect(readCaptureEvidenceFromExif("2026:07:31 09:30:00")).toEqual(
      UNKNOWN_CAPTURE_EVIDENCE,
    );
  });
});

describe("getCameraCaptureEvidence", () => {
  test("records the shutter instant as a camera-clock claim", () => {
    const date = new Date("2026-07-31T12:00:00.000Z");
    jest.spyOn(date, "getTimezoneOffset").mockReturnValue(420);

    expect(getCameraCaptureEvidence(date)).toEqual({
      evidence: "camera_clock",
      capturedAt: "2026-07-31T12:00:00.000Z",
      // JavaScript reports minutes west of UTC; Splotty stores the signed offset.
      capturedUtcOffsetMinutes: -420,
    });
  });
});

describe("classifyCapture", () => {
  const now = Date.parse("2026-07-31T12:00:00.000Z");
  const at = (iso: string) =>
    ({
      evidence: "camera_clock",
      capturedAt: iso,
      capturedUtcOffsetMinutes: 0,
    }) as const;

  test("admits a credible capture inside the 24-hour window", () => {
    expect(classifyCapture(at("2026-07-31T11:59:00.000Z"), now)).toBe("recent");
    expect(classifyCapture(at("2026-07-30T12:00:00.000Z"), now)).toBe("recent");
  });

  test("allows five minutes of forward clock skew and no more", () => {
    expect(classifyCapture(at("2026-07-31T12:05:00.000Z"), now)).toBe("recent");
    expect(classifyCapture(at("2026-07-31T12:05:00.001Z"), now)).toBe(
      "archive",
    );
  });

  test("archives anything older than the window by even a millisecond", () => {
    expect(classifyCapture(at("2026-07-30T11:59:59.999Z"), now)).toBe(
      "archive",
    );
  });

  test("archives unknown evidence, because no claim can be admitted", () => {
    expect(classifyCapture(UNKNOWN_CAPTURE_EVIDENCE, now)).toBe("archive");
  });
});

describe("formatCaptureLocalTime", () => {
  test("reconstructs the calendar the photo was taken in, not the viewer's", () => {
    // 03:30 UTC in Tokyo (+09:00) is the afternoon of the *next* day locally.
    expect(
      formatCaptureLocalTime({
        evidence: "picker_original_with_offset",
        capturedAt: "2026-07-30T22:30:00.000Z",
        capturedUtcOffsetMinutes: 540,
      }),
    ).toBe("Jul 31, 2026 at 7:30 AM");
  });

  test("has no label for unknown evidence", () => {
    expect(formatCaptureLocalTime(UNKNOWN_CAPTURE_EVIDENCE)).toBeNull();
  });
});
