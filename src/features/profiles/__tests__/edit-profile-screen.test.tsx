import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, userEvent, waitFor } from "@testing-library/react-native";

import {
  cancelAvatarUpload,
  createAvatarSignedUrl,
  publishAvatar,
  removeAvatar,
} from "@/features/profiles/avatar-api";
import { chooseAvatar } from "@/features/profiles/avatar-image";
import { EditProfileScreen } from "@/features/profiles/edit-profile-screen";

// `jest.mock` is hoisted above these imports, so declaring it after them keeps
// the import block contiguous without changing behaviour.
jest.mock("@/features/profiles/avatar-api", () => ({
  cancelAvatarUpload: jest.fn(async () => undefined),
  createAvatarSignedUrl: jest.fn(async () => null),
  publishAvatar: jest.fn(),
  removeAvatar: jest.fn(async () => undefined),
}));

jest.mock("@/features/profiles/avatar-image", () => ({
  chooseAvatar: jest.fn(),
}));

const prepared = {
  kind: "selected" as const,
  avatar: { byteSize: 4096, sha256: "a".repeat(64), uri: "file:///avatar.jpg" },
};

function renderScreen(avatarPath: string | null = null) {
  const client = new QueryClient({
    defaultOptions: {
      mutations: { gcTime: Infinity, retry: false },
      queries: { gcTime: Infinity, retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <EditProfileScreen
        avatarPath={avatarPath}
        displayName="Kingston"
        onDone={jest.fn()}
        username="kingston"
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.resetAllMocks();
  // A denied or absent signature is the normal case here; the avatar itself is
  // covered by its own component behaviour.
  jest.mocked(createAvatarSignedUrl).mockResolvedValue(null);
});

test("offers Add photo and no removal control when no avatar exists", async () => {
  const screen = await renderScreen();
  expect(screen.getByText("Add photo")).toBeOnTheScreen();
  expect(screen.queryByText("Remove photo")).not.toBeOnTheScreen();
});

test("offers Change photo once an avatar exists", async () => {
  const screen = await renderScreen("user/version.jpg");
  expect(screen.getByText("Change photo")).toBeOnTheScreen();
  expect(screen.getByText("Remove photo")).toBeOnTheScreen();
});

test("a published upload clears the progress state", async () => {
  jest.mocked(chooseAvatar).mockResolvedValue(prepared);
  jest.mocked(publishAvatar).mockResolvedValue({
    avatarPath: "user/version.jpg",
    kind: "published",
  });

  const user = userEvent.setup();
  const screen = await renderScreen();
  await user.press(screen.getByText("Add photo"));

  await waitFor(() => expect(publishAvatar).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(screen.queryByText(/Uploading/)).not.toBeOnTheScreen(),
  );
});

// A rejected image must say so plainly without hinting at why the server
// refused it beyond "try another one".
test("a rejected image reports a retryable message", async () => {
  jest.mocked(chooseAvatar).mockResolvedValue(prepared);
  jest.mocked(publishAvatar).mockResolvedValue({ kind: "rejected" });

  const user = userEvent.setup();
  const screen = await renderScreen();
  await user.press(screen.getByText("Add photo"));

  expect(
    await screen.findByText("That photo couldn’t be used. Try another one."),
  ).toBeOnTheScreen();
});

test("an unresolved upload asks the user to retry rather than claiming success", async () => {
  jest.mocked(chooseAvatar).mockResolvedValue(prepared);
  jest
    .mocked(publishAvatar)
    .mockResolvedValue({ kind: "unresolved", requestId: "request-1" });

  const user = userEvent.setup();
  const screen = await renderScreen();
  await user.press(screen.getByText("Add photo"));

  expect(
    await screen.findByText("We couldn’t confirm that upload. Try again."),
  ).toBeOnTheScreen();
});

test("a cancelled picker leaves the screen idle", async () => {
  jest.mocked(chooseAvatar).mockResolvedValue({ kind: "canceled" });

  const user = userEvent.setup();
  const screen = await renderScreen();
  await user.press(screen.getByText("Add photo"));

  await waitFor(() => expect(publishAvatar).not.toHaveBeenCalled());
  expect(cancelAvatarUpload).not.toHaveBeenCalled();
});

test("a preparation failure surfaces its message and uploads nothing", async () => {
  jest
    .mocked(chooseAvatar)
    .mockResolvedValue({ kind: "error", message: "That image is too large." });

  const user = userEvent.setup();
  const screen = await renderScreen();
  await user.press(screen.getByText("Add photo"));

  expect(await screen.findByText("That image is too large.")).toBeOnTheScreen();
  expect(publishAvatar).not.toHaveBeenCalled();
});

test("removing an existing avatar calls the server once", async () => {
  const user = userEvent.setup();
  const screen = await renderScreen("user/version.jpg");
  await user.press(screen.getByText("Remove photo"));

  await waitFor(() => expect(removeAvatar).toHaveBeenCalledTimes(1));
});

// The copy must be honest that bytes already delivered cannot be recalled.
test("states the visibility rule and the copy limitation", async () => {
  const screen = await renderScreen();
  expect(
    screen.getByText(/friends of your friends can see your photo/),
  ).toBeOnTheScreen();
  expect(screen.getByText(/may still have a copy/)).toBeOnTheScreen();
});
