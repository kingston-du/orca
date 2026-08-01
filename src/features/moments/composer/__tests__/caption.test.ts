import {
  captionCharactersRemaining,
  captionLength,
  normalizeCaption,
} from "@/features/moments/composer/caption";

describe("normalizeCaption", () => {
  test("trims outer whitespace and returns null for an empty caption", () => {
    expect(normalizeCaption("   ")).toEqual({ ok: true, caption: null });
    expect(normalizeCaption("  hello  ")).toEqual({
      ok: true,
      caption: "hello",
    });
  });

  test("normalizes CRLF to LF while keeping intentional line breaks", () => {
    expect(normalizeCaption("one\r\ntwo\rthree")).toEqual({
      ok: true,
      caption: "one\ntwo\nthree",
    });
  });

  test("applies NFC so a decomposed and composed accent are the same caption", () => {
    // Built from code points rather than literals so the two forms are provably
    // different byte sequences in this file.
    const decomposed = `cafe${String.fromCharCode(0x0301)}`;
    const composed = `caf${String.fromCharCode(0x00e9)}`;
    expect(decomposed).not.toBe(composed);

    expect(normalizeCaption(decomposed)).toEqual({
      ok: true,
      caption: composed,
    });
  });

  test("rejects NUL and other C0/C1 control characters", () => {
    for (const code of [0x00, 0x1b, 0x7f, 0x85]) {
      expect(normalizeCaption(`hi${String.fromCharCode(code)}there`)).toEqual({
        ok: false,
        reason: "unsupported_characters",
      });
    }
  });

  test("keeps a tab-free caption with an ordinary line feed", () => {
    expect(normalizeCaption("one\ntwo")).toEqual({
      ok: true,
      caption: "one\ntwo",
    });
  });

  test("counts code points, not UTF-16 units, so emoji match Postgres", () => {
    // Each of these is one `char_length` character on the server but two
    // JavaScript `.length` units.
    const emoji = "🐋".repeat(160);
    expect(captionLength(emoji)).toBe(160);
    expect(normalizeCaption(emoji).ok).toBe(true);
    expect(normalizeCaption("🐋".repeat(161))).toEqual({
      ok: false,
      reason: "too_long",
    });
  });

  test("accepts exactly the limit and rejects one more", () => {
    expect(normalizeCaption("a".repeat(160)).ok).toBe(true);
    expect(normalizeCaption("a".repeat(161))).toEqual({
      ok: false,
      reason: "too_long",
    });
  });
});

describe("captionCharactersRemaining", () => {
  test("counts against the normalized caption, not the raw input", () => {
    expect(captionCharactersRemaining("   ")).toBe(160);
    expect(captionCharactersRemaining(" hello ")).toBe(155);
    expect(captionCharactersRemaining("a".repeat(165))).toBe(-5);
  });
});
