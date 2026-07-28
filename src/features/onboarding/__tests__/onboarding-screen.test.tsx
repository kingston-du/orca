import {
  fireEvent,
  render,
  userEvent,
  waitFor,
} from "@testing-library/react-native";

import { OnboardingScreen } from "@/features/onboarding/onboarding-screen";

const ACCEPTANCE_LABELS = [
  "Accept Adult eligibility",
  "Accept Terms",
  "Accept Privacy notice",
  "Accept Community guidelines",
];

describe("OnboardingScreen", () => {
  test("requires a display name and every acceptance", async () => {
    const onComplete = jest.fn();
    const user = userEvent.setup();
    const screen = await render(
      <OnboardingScreen onComplete={onComplete} onSignOut={jest.fn()} />,
    );

    await user.press(screen.getByText("Finish setup"));

    expect(
      screen.getByText("Enter the name your friends will see."),
    ).toBeOnTheScreen();
    expect(
      screen.getByText("Review and accept all four requirements to continue."),
    ).toBeOnTheScreen();
    expect(onComplete).not.toHaveBeenCalled();
  });

  test("submits only after all four documents are accepted", async () => {
    const profile = {
      avatar_path: null,
      created_at: "2026-07-28T00:00:00Z",
      display_name: "Kingston",
      id: "11111111-1111-4111-8111-111111111111",
      onboarding_completed_at: "2026-07-28T00:00:00Z",
      updated_at: "2026-07-28T00:00:00Z",
    };
    const onComplete = jest.fn().mockResolvedValue({
      kind: "success",
      profile,
    });
    const user = userEvent.setup();
    const screen = await render(
      <OnboardingScreen onComplete={onComplete} onSignOut={jest.fn()} />,
    );

    await user.type(screen.getByLabelText("Display name"), "Kingston");

    for (const label of ACCEPTANCE_LABELS) {
      await fireEvent(screen.getByLabelText(label), "valueChange", true);
    }

    await user.press(screen.getByText("Finish setup"));

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledWith("Kingston");
    });
  });

  test("allows an incomplete user to sign out", async () => {
    const onSignOut = jest.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    const screen = await render(
      <OnboardingScreen onComplete={jest.fn()} onSignOut={onSignOut} />,
    );

    await user.press(screen.getByText("Sign out"));

    await waitFor(() => expect(onSignOut).toHaveBeenCalledTimes(1));
  });
});
