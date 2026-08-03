import { render } from "@testing-library/react-native";

import { SupportScreen } from "@/features/safety/support-screen";

describe("SupportScreen", () => {
  test("publishes the review targets a reporter is promised", async () => {
    const screen = await render(
      <SupportScreen onBack={jest.fn()} accountState="active" />,
    );

    expect(
      screen.getByText(/within 24\s*hours; everything else within 72\s*hours/),
    ).toBeOnTheScreen();
  });

  test("states the appeal window and the retention Orca actually applies", async () => {
    const screen = await render(
      <SupportScreen onBack={jest.fn()} accountState="active" />,
    );

    expect(screen.getByText(/appeal within 30\s*days/)).toBeOnTheScreen();
    expect(
      screen.getByText(/destroyed 90\s*days\s*after the case is closed/),
    ).toBeOnTheScreen();
  });

  test("a suspended account is shown the appeal path first", async () => {
    const screen = await render(
      <SupportScreen onBack={jest.fn()} accountState="suspended" />,
    );

    expect(screen.getByText("Your account is restricted")).toBeOnTheScreen();
    expect(screen.getByText(/preserved, not deleted/)).toBeOnTheScreen();
  });

  test("an ordinary account is not told it is restricted", async () => {
    const screen = await render(
      <SupportScreen onBack={jest.fn()} accountState="active" />,
    );

    expect(screen.queryByText("Your account is restricted")).toBeNull();
  });

  test("says plainly when no support address is configured yet", async () => {
    // The repository ships no mailbox: an invented address would be worse than
    // an honest gap, and `EXPO_PUBLIC_SUPPORT_EMAIL` is unset in tests.
    const screen = await render(<SupportScreen onBack={jest.fn()} />);

    expect(
      screen.getByText(/no published support address configured/),
    ).toBeOnTheScreen();
  });
});
