import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";

import { RECENT_PAGE_SIZE } from "@/features/moments/feed/recent-api";
import { useRecentFeed } from "@/features/moments/feed/use-recent-feed";

const mockRpc = jest.fn();

jest.mock("@/lib/supabase", () => ({
  supabase: { rpc: (...args: unknown[]) => mockRpc(...args) },
  supabaseUrl: "",
}));

function row(index: number, overrides: Record<string, unknown> = {}) {
  return {
    session_started_at: "2026-08-01T12:00:00.000Z",
    anchor_at: "2026-08-01T11:00:00.000Z",
    moment_id: `m${index}`,
    author_id: "a1",
    author_username: "ada",
    author_display_name: "Ada",
    author_avatar_path: null,
    captured_at: "2026-08-01T09:00:00.000Z",
    captured_utc_offset_minutes: -300,
    capture_evidence: "camera_clock",
    caption: null,
    caption_updated_at: "2026-08-01T11:00:00.000Z",
    // Descending, so the cursor of the last row of a page is the oldest one.
    published_at: new Date(
      Date.parse("2026-08-01T11:00:00.000Z") - index * 60_000,
    ).toISOString(),
    object_path: `a1/m${index}/media.jpg`,
    media_width: 1600,
    media_height: 2000,
    viewer_is_author: false,
    seen_at_session_start: false,
    ...overrides,
  };
}

function fullPage(offset: number) {
  return Array.from({ length: RECENT_PAGE_SIZE }, (_, index) =>
    row(offset + index),
  );
}

function wrapper({ children }: PropsWithChildren) {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function listCalls() {
  return mockRpc.mock.calls.filter((call) => call[0] === "list_recent_moments");
}

beforeEach(() => {
  mockRpc.mockReset();
  mockRpc.mockImplementation(async (name: string) => {
    if (name === "count_new_recent_moments") return { data: 0, error: null };
    return { data: [], error: null };
  });
});

describe("the session envelope", () => {
  it("opens a session from the first page and replays it on every later one", async () => {
    mockRpc.mockImplementation(async (name: string) => {
      if (name === "count_new_recent_moments") return { data: 0, error: null };
      return { data: fullPage(0), error: null };
    });

    const { result } = await renderHook(() => useRecentFeed("viewer"), {
      wrapper,
    });
    await waitFor(() => expect(result.current.moments).toHaveLength(20));

    // The first call cannot know the envelope; the server computes and returns
    // it. Everything after must hand the same two instants back, or the window
    // would move and a Moment published since could appear mid-deck.
    expect(listCalls()[0][1]).toMatchObject({
      p_session_started_at: undefined,
      p_anchor_at: undefined,
      p_direction: "older",
    });

    await act(async () => result.current.fetchOlder());
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(1));

    expect(listCalls().at(-1)?.[1]).toMatchObject({
      p_session_started_at: "2026-08-01T12:00:00.000Z",
      p_anchor_at: "2026-08-01T11:00:00.000Z",
    });
  });

  it("pages by the tuple the server orders by, not by an offset", async () => {
    mockRpc.mockImplementation(async (name: string) => {
      if (name === "count_new_recent_moments") return { data: 0, error: null };
      return { data: fullPage(0), error: null };
    });

    const { result } = await renderHook(() => useRecentFeed("viewer"), {
      wrapper,
    });
    await waitFor(() => expect(result.current.moments).toHaveLength(20));

    await act(async () => result.current.fetchOlder());
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(1));

    const last = fullPage(0).at(-1);
    expect(listCalls().at(-1)?.[1]).toMatchObject({
      p_cursor_seen: false,
      p_cursor_published_at: last?.published_at,
      p_cursor_id: last?.moment_id,
      p_direction: "older",
    });
  });

  it("stops asking for more once a short page proves there is no more", async () => {
    mockRpc.mockImplementation(async (name: string) => {
      if (name === "count_new_recent_moments") return { data: 0, error: null };
      return { data: [row(0), row(1)], error: null };
    });

    const { result } = await renderHook(() => useRecentFeed("viewer"), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isCaughtUp).toBe(true));

    const before = listCalls().length;
    await act(async () => result.current.fetchOlder());
    expect(listCalls()).toHaveLength(before);
  });

  it("starts a new session with no envelope at all", async () => {
    mockRpc.mockImplementation(async (name: string) => {
      if (name === "count_new_recent_moments") return { data: 0, error: null };
      return { data: [row(0)], error: null };
    });

    const { result } = await renderHook(() => useRecentFeed("viewer"), {
      wrapper,
    });
    await waitFor(() => expect(result.current.moments).toHaveLength(1));

    await act(async () => result.current.startNewSession());
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(1));

    // A new snapshot recomputes the anchor. Reusing the old one would leave the
    // viewer looking at the same window they just asked to leave.
    expect(listCalls().at(-1)?.[1]).toMatchObject({
      p_session_started_at: undefined,
      p_anchor_at: undefined,
    });
  });
});

describe("arrivals", () => {
  it("counts against the frozen anchor rather than against now", async () => {
    mockRpc.mockImplementation(async (name: string) => {
      if (name === "count_new_recent_moments") return { data: 4, error: null };
      return { data: [row(0)], error: null };
    });

    const { result } = await renderHook(() => useRecentFeed("viewer"), {
      wrapper,
    });
    await waitFor(() => expect(result.current.newMomentCount).toBe(4));

    const counts = mockRpc.mock.calls.filter(
      (call) => call[0] === "count_new_recent_moments",
    );
    expect(counts.at(-1)?.[1]).toEqual({
      p_anchor_at: "2026-08-01T11:00:00.000Z",
    });
  });
});

describe("failures", () => {
  it("surfaces an error rather than pretending the feed is empty", async () => {
    mockRpc.mockImplementation(async (name: string) => {
      if (name === "count_new_recent_moments") return { data: 0, error: null };
      return { data: null, error: new Error("network") };
    });

    const { result } = await renderHook(() => useRecentFeed("viewer"), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.moments).toEqual([]);
  });
});
