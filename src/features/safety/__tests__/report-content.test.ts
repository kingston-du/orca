import {
  MAX_REPORT_DETAIL_CHARACTERS,
  REPORT_CATEGORIES,
  reportDetailsRemaining,
  toCanonicalDetails,
} from "@/features/safety/report-content";

describe("report categories", () => {
  test("are exactly the seven the server accepts", () => {
    expect(REPORT_CATEGORIES.map((option) => option.value)).toEqual([
      "harassment_or_bullying",
      "hate_or_threats",
      "child_safety",
      "sexual_content",
      "self_harm",
      "spam_or_impersonation",
      "other",
    ]);
  });

  test("every category explains itself, so the choice is not a guess", () => {
    for (const option of REPORT_CATEGORIES) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.hint.length).toBeGreaterThan(0);
    }
  });
});

describe("report details", () => {
  test("collapse CRLF and trim the outside, matching the server", () => {
    expect(toCanonicalDetails("  first\r\nsecond  ")).toBe("first\nsecond");
  });

  test("keep interior line feeds an author typed on purpose", () => {
    expect(toCanonicalDetails("one\n\ntwo")).toBe("one\n\ntwo");
  });

  test("count code points, so one emoji costs one character on both sides", () => {
    expect(reportDetailsRemaining("🐋")).toBe(MAX_REPORT_DETAIL_CHARACTERS - 1);
  });

  test("report the overflow rather than silently truncating", () => {
    expect(
      reportDetailsRemaining("x".repeat(MAX_REPORT_DETAIL_CHARACTERS + 3)),
    ).toBe(-3);
  });

  test("whitespace alone is nothing to send", () => {
    expect(toCanonicalDetails("   \n  ")).toBe("");
  });
});
