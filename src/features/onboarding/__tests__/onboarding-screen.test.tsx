import {
  fireEvent,
  render,
  userEvent,
  waitFor,
} from "@testing-library/react-native";

import { LEGAL_DOCUMENT } from "@/features/legal/legal-documents";
import { OnboardingScreen } from "@/features/onboarding/onboarding-screen";

const ACCEPTANCE_LABEL = `I am 18 or older and I accept the ${LEGAL_DOCUMENT.title}`;

function renderScreen(props: Partial<Record<string, unknown>> = {}) {
  return render(
    <OnboardingScreen
      onComplete={jest.fn()}
      onOpenLegal={jest.fn()}
      onSignOut={jest.fn()}
      {...props}
    />,
  );
}

describe("OnboardingScreen", () => {
  test("requires a display name and the single acceptance", async () => {
    const onComplete = jest.fn();
    const user = userEvent.setup();
    const screen = await renderScreen({ onComplete });

    await user.press(screen.getByText("Finish setup"));

    expect(
      screen.getByText("Enter the name your friends will see."),
    ).toBeOnTheScreen();
    expect(
      screen.getByText(
        "Confirm you are 18 or older and accept the Terms to continue.",
      ),
    ).toBeOnTheScreen();
    expect(onComplete).not.toHaveBeenCalled();
  });

  test("asks exactly once — there is one acceptance control", async () => {
    const screen = await renderScreen();

    // The four development switches became one. A regression that reintroduces
    // a second control is the thing this checkpoint exists to prevent.
    expect(screen.getAllByRole("switch")).toHaveLength(1);
    expect(screen.getByLabelText(ACCEPTANCE_LABEL)).toBeOnTheScreen();
  });

  test("submits after the one acceptance is given", async () => {
    const profile = {
      avatar_path: null,
      created_at: "2026-07-28T00:00:00Z",
      display_name: "Kingston",
      id: "11111111-1111-4111-8111-111111111111",
      onboarding_completed_at: "2026-07-28T00:00:00Z",
      updated_at: "2026-07-28T00:00:00Z",
      username: "kingston",
    };
    const onComplete = jest
      .fn()
      .mockResolvedValue({ kind: "success", profile });
    const user = userEvent.setup();
    const screen = await renderScreen({ onComplete });

    await user.type(screen.getByLabelText("Display name"), "Kingston");
    await user.type(screen.getByLabelText("Username"), "Kingston");
    await fireEvent(
      screen.getByLabelText(ACCEPTANCE_LABEL),
      "valueChange",
      true,
    );

    await user.press(screen.getByText("Finish setup"));

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledWith("kingston", "Kingston");
    });
  });

  test("can open the full agreement before accepting it", async () => {
    const onOpenLegal = jest.fn();
    const user = userEvent.setup();
    const screen = await renderScreen({ onOpenLegal });

    await user.press(screen.getByText(`Read the full ${LEGAL_DOCUMENT.title}`));

    expect(onOpenLegal).toHaveBeenCalledTimes(1);
  });

  test("allows an incomplete user to sign out", async () => {
    const onSignOut = jest.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    const screen = await renderScreen({ onSignOut });

    await user.press(screen.getByText("Sign out"));

    await waitFor(() => expect(onSignOut).toHaveBeenCalledTimes(1));
  });
});
