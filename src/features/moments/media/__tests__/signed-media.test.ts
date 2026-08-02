import {
  SIGNED_URL_REFRESH_MS,
  SIGNED_URL_RENEW_MARGIN_MS,
  SIGNED_URL_TTL_SECONDS,
  signMomentMedia,
} from "@/features/moments/media/signed-media";
import { supabase } from "@/lib/supabase";

const createSignedUrls = jest.fn();

jest.mock("@/lib/supabase", () => ({
  supabase: { storage: { from: jest.fn() } },
  supabaseUrl: "",
}));

beforeEach(() => {
  createSignedUrls.mockReset();
  jest.mocked(supabase.storage.from).mockReturnValue({
    createSignedUrls,
  } as never);
});

describe("batching", () => {
  it("coalesces everything requested in one tick into a single call", async () => {
    createSignedUrls.mockResolvedValue({
      data: [
        { path: "a/1/media.jpg", signedUrl: "https://signed/a", error: null },
        { path: "b/2/media.jpg", signedUrl: "https://signed/b", error: null },
        { path: "c/3/media.jpg", signedUrl: "https://signed/c", error: null },
      ],
      error: null,
    });

    // The deck mounts the current card and one neighbour each side in a single
    // commit. That is one round trip, not three.
    const urls = await Promise.all([
      signMomentMedia("a/1/media.jpg"),
      signMomentMedia("b/2/media.jpg"),
      signMomentMedia("c/3/media.jpg"),
    ]);

    expect(createSignedUrls).toHaveBeenCalledTimes(1);
    expect(createSignedUrls).toHaveBeenCalledWith(
      ["a/1/media.jpg", "b/2/media.jpg", "c/3/media.jpg"],
      SIGNED_URL_TTL_SECONDS,
    );
    expect(urls).toEqual([
      "https://signed/a",
      "https://signed/b",
      "https://signed/c",
    ]);
  });

  it("asks once for a path two cards want at the same time", async () => {
    createSignedUrls.mockResolvedValue({
      data: [
        { path: "a/1/media.jpg", signedUrl: "https://signed/a", error: null },
      ],
      error: null,
    });

    const urls = await Promise.all([
      signMomentMedia("a/1/media.jpg"),
      signMomentMedia("a/1/media.jpg"),
    ]);

    expect(createSignedUrls).toHaveBeenCalledWith(
      ["a/1/media.jpg"],
      SIGNED_URL_TTL_SECONDS,
    );
    expect(urls).toEqual(["https://signed/a", "https://signed/a"]);
  });

  it("starts a new batch after the previous one has flushed", async () => {
    createSignedUrls.mockResolvedValue({
      data: [
        { path: "a/1/media.jpg", signedUrl: "https://signed/a", error: null },
      ],
      error: null,
    });

    await signMomentMedia("a/1/media.jpg");
    await signMomentMedia("a/1/media.jpg");

    expect(createSignedUrls).toHaveBeenCalledTimes(2);
  });
});

describe("denial and failure", () => {
  it("reports a refused path as unavailable rather than throwing", async () => {
    // A path the viewer may no longer read simply fails to sign. The card shows
    // one generic unavailable state, because the difference between "you lost
    // access" and "your connection dropped" is not the viewer's to learn.
    createSignedUrls.mockResolvedValue({
      data: [
        { path: "a/1/media.jpg", signedUrl: "", error: "Object not found" },
        { path: "b/2/media.jpg", signedUrl: "https://signed/b", error: null },
      ],
      error: null,
    });

    const [refused, allowed] = await Promise.all([
      signMomentMedia("a/1/media.jpg"),
      signMomentMedia("b/2/media.jpg"),
    ]);

    expect(refused).toBeNull();
    expect(allowed).toBe("https://signed/b");
  });

  it("rejects the whole batch when the transport fails, so the query layer can retry", async () => {
    createSignedUrls.mockResolvedValue({
      data: null,
      error: new Error("network"),
    });

    await expect(signMomentMedia("a/1/media.jpg")).rejects.toThrow("network");
  });
});

describe("the renewal window", () => {
  it("renews with about a minute of the token still to run", () => {
    // The rendered photo must never depend on a token that is about to expire,
    // and the renewal doubles as the row's reauthorization.
    expect(SIGNED_URL_REFRESH_MS).toBe(
      SIGNED_URL_TTL_SECONDS * 1000 - SIGNED_URL_RENEW_MARGIN_MS,
    );
    expect(SIGNED_URL_RENEW_MARGIN_MS).toBe(60_000);
    // Aligned with the object cache-control the uploader sets, so a signed URL
    // can never outlive the response an intermediary is allowed to keep.
    expect(SIGNED_URL_TTL_SECONDS).toBe(300);
  });
});
