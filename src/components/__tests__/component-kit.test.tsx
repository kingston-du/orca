import { render, userEvent } from "@testing-library/react-native";
import { Text } from "react-native";

import { AppButton } from "@/components/app-button";
import { InlineAlert } from "@/components/inline-alert";
import { ScreenHeader } from "@/components/screen-header";
import { SegmentedControl } from "@/components/segmented-control";

/**
 * The accessibility contracts the shared kit is responsible for.
 *
 * Before Checkpoint 9C each screen declared its own buttons, chips, and alert
 * cards, so these guarantees had to hold twenty times over and in practice did
 * not. Asserting them once, here, is what makes "use the component" a real
 * answer rather than a convention.
 */

describe("AppButton", () => {
  test("a busy button is disabled to a screen reader as well as to a finger", async () => {
    const onPress = jest.fn();
    const user = userEvent.setup();
    const screen = await render(
      <AppButton busy label="Publishing…" onPress={onPress} />,
    );

    expect(screen.getByRole("button")).toHaveProp(
      "accessibilityState",
      expect.objectContaining({ busy: true, disabled: true }),
    );

    // Dimming alone would leave the control pressable, which is how a
    // double-publish happens.
    await user.press(screen.getByRole("button"));
    expect(onPress).not.toHaveBeenCalled();
  });

  test("a disabled button refuses presses", async () => {
    const onPress = jest.fn();
    const user = userEvent.setup();
    const screen = await render(
      <AppButton disabled label="Publish" onPress={onPress} />,
    );

    await user.press(screen.getByRole("button"));
    expect(onPress).not.toHaveBeenCalled();
  });
});

describe("SegmentedControl", () => {
  const options = [
    { label: "Recent", value: "recent" },
    { label: "Highlights", value: "highlights" },
  ] as const;

  test("selection is announced as state, not carried by tint alone", async () => {
    const screen = await render(
      <SegmentedControl
        accessibilityLabel="Home view"
        onChange={jest.fn()}
        options={options}
        role="tablist"
        value="recent"
      />,
    );

    expect(screen.getByRole("tab", { name: "Recent" })).toHaveProp(
      "accessibilityState",
      expect.objectContaining({ selected: true }),
    );
    expect(screen.getByRole("tab", { name: "Highlights" })).toHaveProp(
      "accessibilityState",
      expect.objectContaining({ selected: false }),
    );
  });

  test("the role follows the job: choosing a value is a radiogroup, not tabs", async () => {
    const screen = await render(
      <SegmentedControl
        accessibilityLabel="Who can see this"
        onChange={jest.fn()}
        options={options}
        role="radiogroup"
        value="recent"
      />,
    );

    expect(screen.getByRole("radio", { name: "Recent" })).toBeOnTheScreen();
    expect(screen.queryByRole("tab", { name: "Recent" })).toBeNull();
  });
});

describe("InlineAlert", () => {
  test("the alert role sits on the text so an action inside stays reachable", async () => {
    const onPress = jest.fn();
    const user = userEvent.setup();
    const screen = await render(
      <InlineAlert
        action={<AppButton label="Try again" onPress={onPress} />}
        message="Couldn’t publish."
        tone="critical"
      />,
    );

    // A container marked accessible swallows its children, leaving a screen
    // reader able to hear the problem but not to act on it.
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn’t publish.");
    await user.press(screen.getByRole("button", { name: "Try again" }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe("ScreenHeader", () => {
  test("the back chevron appears only when the route supplies a target", async () => {
    const onBack = jest.fn();
    const user = userEvent.setup();

    const withBack = await render(
      <ScreenHeader onBack={onBack} title="Settings" />,
    );
    await user.press(withBack.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalledTimes(1);

    // A tab root has nothing to pop, so it must not offer a dead control.
    const tabRoot = await render(<ScreenHeader title="People" />);
    expect(tabRoot.queryByRole("button", { name: "Back" })).toBeNull();
  });

  test("the title is a header and trailing controls keep their own identity", async () => {
    const screen = await render(
      <ScreenHeader title="People" trailing={<Text>Badge</Text>} />,
    );

    expect(screen.getByRole("header")).toHaveTextContent("People");
    expect(screen.getByText("Badge")).toBeOnTheScreen();
  });
});
