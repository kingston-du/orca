import {
  redactText,
  scrubBreadcrumb,
  scrubEvent,
} from "@/lib/observability-scrub";

describe("redactText", () => {
  test("removes an email address", () => {
    expect(redactText("failed for ada@example.test")).toBe(
      "failed for [email]",
    );
  });

  test("removes a JWT, which is how a session or an invite would leak", () => {
    const token =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZGEiLCJhYWwiOiJhYWwyIn0.c2lnbmF0dXJl";
    expect(redactText(`Authorization: Bearer ${token}`)).toBe(
      "Authorization: Bearer [token]",
    );
  });

  test("removes any URL, signed or not", () => {
    expect(
      redactText(
        "GET https://example.supabase.co/storage/v1/object/sign/moment-media/a/b?token=x",
      ),
    ).toBe("GET [url]");
  });

  test("removes a Storage object path, which names a person and a Moment", () => {
    expect(
      redactText(
        "upload failed for 11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/media.jpg",
      ),
    ).toBe("upload failed for [object]");
  });

  test("removes a long opaque blob, which is how image bytes would arrive", () => {
    expect(redactText(`data ${"A".repeat(200)} end`)).toBe("data [data] end");
  });

  test("truncates, so a caption cannot ride along inside a long message", () => {
    // Spaced words, so this exercises the length cap rather than the
    // long-opaque-blob rule.
    const scrubbed = redactText("word ".repeat(200));
    expect(scrubbed.length).toBeLessThan(320);
    expect(scrubbed.endsWith("…[truncated]")).toBe(true);
  });

  test("leaves an ordinary diagnostic message intact", () => {
    expect(redactText("PGRST301: JWT expired")).toBe("PGRST301: JWT expired");
  });
});

describe("scrubEvent", () => {
  test("scrubs the message and every exception value", () => {
    const event = scrubEvent({
      exception: {
        values: [{ type: "Error", value: "denied for ada@example.test" }],
      },
      message: "failed at https://example.test/x",
    });

    expect(event.message).toBe("failed at [url]");
    expect(event.exception?.values?.[0].value).toBe("denied for [email]");
  });

  test("drops the user entirely, so no crash is attributed to a person", () => {
    const event = scrubEvent({
      message: "boom",
      user: { email: "ada@example.test", id: "abc" },
    });
    expect(event.user).toBeUndefined();
  });

  test("drops request bodies, headers, and cookies rather than redacting them", () => {
    const event = scrubEvent({
      request: {
        cookies: "session=1",
        data: { caption: "a private caption" },
        headers: { authorization: "Bearer x" },
        url: "https://example.test/rpc",
      },
    });

    expect(event.request).toEqual({ url: "[url]" });
  });

  test("scrubs extras and breadcrumbs it carries", () => {
    const event = scrubEvent({
      breadcrumbs: [
        { category: "console", message: "anything at all" },
        { category: "navigation", message: "to https://example.test/a" },
      ],
      extra: { path: "file:///var/mobile/photo.jpg" },
    });

    expect(event.extra).toEqual({ path: "[file]" });
    expect(event.breadcrumbs).toEqual([
      { category: "navigation", message: "to [url]" },
    ]);
  });
});

describe("scrubBreadcrumb", () => {
  test("drops console breadcrumbs, which replay whatever anything logged", () => {
    expect(
      scrubBreadcrumb({ category: "console", message: "a caption" }),
    ).toBeNull();
  });

  test("redacts breadcrumb data", () => {
    expect(
      scrubBreadcrumb({
        category: "xhr",
        data: { count: 3, url: "https://example.test/object/a" },
      }),
    ).toEqual({ category: "xhr", data: { count: 3, url: "[url]" } });
  });
});
