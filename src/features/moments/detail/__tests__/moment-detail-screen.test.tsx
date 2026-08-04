import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  render,
  screen,
  userEvent,
  waitFor,
} from "@testing-library/react-native";
import { Alert } from "react-native";

import {
  getMomentDetail,
  listMomentParticipants,
  removeMomentTag,
  type MomentDetail,
} from "@/features/moments/detail/detail-api";
import { MomentDetailScreen } from "@/features/moments/detail/moment-detail-screen";
import { markMomentsSeen } from "@/features/moments/feed/recent-api";
import {
  deleteMoment,
  editMomentCaption,
} from "@/features/moments/publish/publish-api";
import { getReactionQuota } from "@/features/moments/reactions/reaction-api";

jest.mock("@/features/moments/detail/detail-api", () => ({
  getMomentDetail: jest.fn(),
  listMomentParticipants: jest.fn(),
  removeMomentTag: jest.fn(),
}));

jest.mock("@/features/moments/feed/recent-api", () => ({
  markMomentsSeen: jest.fn().mockResolvedValue(1),
}));

jest.mock("@/features/moments/publish/publish-api", () => ({
  deleteMoment: jest.fn(),
  editMomentCaption: jest.fn(),
}));

jest.mock("@/features/moments/media/signed-media", () => ({
  useMomentMediaPurge: () => ({ purge: jest.fn(), purgeAll: jest.fn() }),
  useMomentMediaUrl: () => ({
    data: "https://example.test/signed",
    isError: false,
  }),
}));

// The reaction transport reaches the Supabase client, which reaches
// AsyncStorage's native module. The reaction rules and the cache patchers are
// pure and have their own suites; here the bar only needs a transport that
// resolves.
jest.mock("@/features/moments/reactions/reaction-api", () => ({
  REACTION_PAGE_SIZE: 30,
  SUPERHEART_LIMIT_MESSAGE: "Superheart limit reached",
  isSuperheartLimitError: (error: unknown) =>
    (error as { message?: string } | null)?.message ===
    "Superheart limit reached",
  getReactionQuota: jest.fn(async () => ({ usesRemaining: 3, resetsAt: null })),
  listMomentReactions: jest.fn(async () => []),
  setMomentReaction: jest.fn(),
}));

jest.mock("expo-symbols", () => {
  const { Text } = jest.requireActual("react-native");
  return {
    SymbolView: ({ name }: { name: string }) => <Text>{`sf:${name}`}</Text>,
  };
});

jest.mock("@/features/profiles/avatar-api", () => ({
  createAvatarSignedUrl: jest.fn(async () => null),
}));

jest.mock("@/features/auth/auth-provider", () => ({
  useAuth: () => ({ user: { id: "viewer" } }),
}));

jest.mock("expo-crypto", () => ({ randomUUID: () => "command-uuid" }));

function detail(overrides: Partial<MomentDetail> = {}): MomentDetail {
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
    caption: "Cold morning",
    caption_updated_at: "2026-01-15T02:00:00.000Z",
    published_at: "2026-01-15T02:00:00.000Z",
    object_path: "a1/m1/media.jpg",
    media_width: 1600,
    media_height: 2000,
    viewer_is_author: false,
    viewer_is_tagged: false,
    participant_count: 0,
    audience: null,
    recipient_count: null,
    can_react: true,
    heart_count: 0,
    superheart_count: 0,
    viewer_reaction: null,
    ...overrides,
  };
}

const onClose = jest.fn();
const onReport = jest.fn();

async function renderDetail() {
  const client = new QueryClient({
    defaultOptions: {
      mutations: { gcTime: Infinity, retry: false },
      queries: { gcTime: Infinity, retry: false },
    },
  });
  client.setQueryData(["reaction-quota", "viewer"], {
    usesRemaining: 3,
    resetsAt: null,
  });
  return render(
    <QueryClientProvider client={client}>
      <MomentDetailScreen
        momentId="m1"
        onClose={onClose}
        onOpenProfile={jest.fn()}
        onOpenReactions={jest.fn()}
        onReport={onReport}
      />
    </QueryClientProvider>,
  );
}

/** Confirms the destructive dialog the way a decided user would. */
function confirmAlerts() {
  jest.spyOn(Alert, "alert").mockImplementation((_title, _body, buttons) => {
    const confirm = buttons?.find((button) => button.style === "destructive");
    confirm?.onPress?.();
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  jest
    .mocked(getReactionQuota)
    .mockResolvedValue({ usesRemaining: 3, resetsAt: null });
  jest.mocked(listMomentParticipants).mockResolvedValue([]);
});

describe("what detail shows", () => {
  it("shows the capture time in the offset the photo was taken in", async () => {
    jest.mocked(getMomentDetail).mockResolvedValue(detail());

    await renderDetail();

    // 21:07Z at +540 is the next morning in Tokyo, wherever the viewer is.
    expect(await screen.findByText("Jan 15, 2026")).toBeOnTheScreen();
    expect(screen.getByText("Cold morning")).toBeOnTheScreen();
  });

  it("shows the full photo in a frame matching its verified aspect", async () => {
    jest
      .mocked(getMomentDetail)
      .mockResolvedValue(detail({ media_width: 1000, media_height: 2000 }));

    await renderDetail();

    const frame = await screen.findByTestId("detail-photo-frame");
    expect(frame.props.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          height: expect.any(Number),
          width: expect.any(Number),
        }),
      ]),
    );
    const size = frame.props.style.find(
      (style: unknown) =>
        typeof style === "object" && style !== null && "width" in style,
    ) as { height: number; width: number };
    expect(size.width / size.height).toBeCloseTo(0.5);
    expect(screen.getByTestId("detail-photo")).toHaveProp(
      "resizeMode",
      "contain",
    );
  });

  it("says so rather than passing off the sharing time as a capture time", async () => {
    jest.mocked(getMomentDetail).mockResolvedValue(
      detail({
        captured_at: null,
        captured_utc_offset_minutes: null,
        capture_evidence: "unknown",
        kind: "archive",
      }),
    );

    await renderDetail();

    expect(
      await screen.findByText("Capture date unavailable"),
    ).toBeOnTheScreen();
    expect(screen.getByText(/^Shared /)).toBeOnTheScreen();
  });

  it("gives an unauthorized or deleted Moment one indistinguishable answer", async () => {
    jest.mocked(getMomentDetail).mockResolvedValue(null);

    await renderDetail();

    expect(
      await screen.findByText("Moment no longer available"),
    ).toBeOnTheScreen();
    // The copy offers possibilities and commits to none of them. It must never
    // name blocking, suspension, or a lost friendship, because which of those
    // happened is a fact about someone else's account.
    expect(screen.queryByText(/block|suspend|friend|unfriend/i)).toBeNull();
    expect(screen.getByText(/may have been deleted/)).toBeOnTheScreen();
  });

  it("shows an author their counts without offering them a control", async () => {
    jest.mocked(getMomentDetail).mockResolvedValue(
      detail({
        viewer_is_author: true,
        can_react: false,
        audience: "all_friends",
        recipient_count: 3,
        heart_count: 2,
        superheart_count: 1,
      }),
    );

    await renderDetail();
    await screen.findByTestId("edit-caption");

    // The server said no, so there is no control to press — but what other
    // people did is still theirs to see.
    expect(screen.getByText("2 Hearts · 1 Superheart")).toBeOnTheScreen();
    expect(screen.queryByLabelText("Heart")).toBeNull();
    expect(screen.queryByLabelText("Superheart")).toBeNull();
  });

  it("gives the audience summary to the author and to nobody else", async () => {
    jest.mocked(getMomentDetail).mockResolvedValue(
      detail({
        viewer_is_author: true,
        audience: "all_friends",
        recipient_count: 3,
      }),
    );
    const author = await renderDetail();
    expect(
      await screen.findByText(
        "Shared with all friends — 3 friends at the time",
      ),
    ).toBeOnTheScreen();
    await author.unmount();

    jest.mocked(getMomentDetail).mockResolvedValue(detail());
    await renderDetail();
    await screen.findByText("Jan 15, 2026");
    expect(screen.queryByText(/Shared with/)).toBeNull();
  });
});

describe("the author's actions", () => {
  beforeEach(() => {
    jest
      .mocked(getMomentDetail)
      .mockResolvedValue(
        detail({ viewer_is_author: true, audience: "only_me" }),
      );
  });

  it("sends the caption with the version it was read at", async () => {
    const user = userEvent.setup();
    jest
      .mocked(editMomentCaption)
      .mockResolvedValue({ caption: "Warm morning", caption_updated_at: "x" });

    await renderDetail();
    // The editor is behind a pencil beside the caption now, rather than a
    // permanently open form every reader of the Moment scrolls past.
    await user.press(await screen.findByTestId("edit-caption"));
    const input = await screen.findByLabelText("Caption");

    await user.clear(input);
    await user.type(input, "Warm morning");
    await user.press(screen.getByTestId("save-caption"));

    await waitFor(() => {
      expect(editMomentCaption).toHaveBeenCalledWith({
        caption: "Warm morning",
        // The optimistic-concurrency version. A stale device is refused rather
        // than allowed to overwrite an edit it never saw.
        expectedCaptionUpdatedAt: "2026-01-15T02:00:00.000Z",
        momentId: "m1",
      });
    });
  });

  it("will not save a caption that has not changed", async () => {
    const user = userEvent.setup();
    await renderDetail();
    await user.press(await screen.findByTestId("edit-caption"));
    await screen.findByLabelText("Caption");

    expect(screen.getByTestId("save-caption")).toBeDisabled();
  });

  it("shows the caption as a caption until its author asks to edit it", async () => {
    const user = userEvent.setup();
    await renderDetail();

    await screen.findByTestId("edit-caption");
    expect(screen.queryByLabelText("Caption")).toBeNull();

    await user.press(screen.getByTestId("edit-caption"));
    expect(screen.getByLabelText("Caption")).toBeOnTheScreen();
  });

  it("keeps the caption editor above the keyboard", async () => {
    const user = userEvent.setup();
    await renderDetail();
    await user.press(await screen.findByTestId("edit-caption"));

    expect(screen.getByLabelText("Caption")).toHaveProp("autoFocus", true);
    expect(screen.getByTestId("moment-detail-scroll")).toHaveProp(
      "automaticallyAdjustKeyboardInsets",
      true,
    );
    expect(screen.getByTestId("moment-detail-scroll")).toHaveProp(
      "keyboardDismissMode",
      "interactive",
    );
  });

  it("confirms before deleting, then leaves the screen", async () => {
    confirmAlerts();
    const user = userEvent.setup();
    jest
      .mocked(deleteMoment)
      .mockResolvedValue({ status: "cleaning", moment_id: "m1" });

    await renderDetail();
    // A trash can in the header, not a bordered sentence at the foot of the
    // scroll. Its accessibility label still says the whole thing.
    await user.press(
      await screen.findByRole("button", { name: "Delete this Moment" }),
    );

    await waitFor(() => expect(deleteMoment).toHaveBeenCalled());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

describe("tag self-removal", () => {
  it("keeps the screen open when a recipient grant survives", async () => {
    confirmAlerts();
    const user = userEvent.setup();
    jest
      .mocked(getMomentDetail)
      .mockResolvedValue(detail({ viewer_is_tagged: true }));
    jest.mocked(removeMomentTag).mockResolvedValue({ stillVisible: true });

    await renderDetail();
    await user.press(
      await screen.findByRole("button", { name: "Remove me from this Moment" }),
    );

    await waitFor(() => expect(removeMomentTag).toHaveBeenCalledWith("m1"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("leaves the screen when the tag was the only grant an Archive Moment had", async () => {
    confirmAlerts();
    const user = userEvent.setup();
    jest
      .mocked(getMomentDetail)
      .mockResolvedValue(detail({ kind: "archive", viewer_is_tagged: true }));
    jest.mocked(removeMomentTag).mockResolvedValue({ stillVisible: false });

    await renderDetail();
    await user.press(
      await screen.findByRole("button", { name: "Remove me from this Moment" }),
    );

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("offers self-removal only to someone who is actually tagged", async () => {
    jest.mocked(getMomentDetail).mockResolvedValue(detail());

    await renderDetail();
    await screen.findByText("Jan 15, 2026");

    expect(
      screen.queryByRole("button", { name: "Remove me from this Moment" }),
    ).toBeNull();
  });
});

describe("seen", () => {
  it("records the Moment as seen once it is on the screen", async () => {
    jest.mocked(getMomentDetail).mockResolvedValue(detail());

    await renderDetail();
    await screen.findByText("Jan 15, 2026");

    // Home earns the marker back from a swipe, on the reasoning that arriving
    // on a card is not reading it. Detail needs no such test — the viewer asked
    // for this Moment by name and it is filling their screen. This is also the
    // only path a Moment opened from a notification ever takes.
    await waitFor(() => expect(markMomentsSeen).toHaveBeenCalledWith(["m1"]));
  });

  it("records it once, not once per render", async () => {
    jest.mocked(getMomentDetail).mockResolvedValue(detail());

    await renderDetail();
    await waitFor(() => expect(markMomentsSeen).toHaveBeenCalled());
    // The participants query and the signed URL both land after the detail and
    // re-render the screen. A view is one event, not one per commit.
    await screen.findByText("Jan 15, 2026");

    expect(jest.mocked(markMomentsSeen).mock.calls).toHaveLength(1);
  });

  it("says nothing about a Moment that could not be read", async () => {
    jest.mocked(getMomentDetail).mockResolvedValue(null);

    await renderDetail();
    await screen.findByText("Moment no longer available");

    // Deleted, blocked, or never theirs — all one answer, and none of them is
    // something to record a view of.
    expect(markMomentsSeen).not.toHaveBeenCalled();
  });
});

describe("reporting", () => {
  test("a viewer can report the Moment they are looking at", async () => {
    jest.mocked(getMomentDetail).mockResolvedValue(detail());

    const screen = await renderDetail();
    const report = await screen.findByRole("button", {
      name: "Report this Moment",
    });
    await userEvent.press(report);

    // The route is handed opaque identity plus the name already on screen.
    expect(onReport).toHaveBeenCalledWith("m1", "Ada");
  });

  test("an author is not offered a report of their own Moment", async () => {
    jest
      .mocked(getMomentDetail)
      .mockResolvedValue(detail({ viewer_is_author: true }));

    const screen = await renderDetail();
    await screen.findByTestId("edit-caption");

    // The header corner holds exactly one destructive action, and for an
    // author it is the trash can rather than the flag.
    expect(screen.queryByTestId("moment-flag")).toBeNull();
    expect(screen.getByTestId("moment-trash")).toBeOnTheScreen();
  });
});
