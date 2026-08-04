import { StyleSheet } from "react-native";

import { render, screen, userEvent } from "@testing-library/react-native";

import { PublishBanner } from "@/features/moments/publish/publish-banner";
import {
  initialPublishState,
  type PublishState,
} from "@/features/moments/publish/publish-machine";

jest.mock("expo-symbols", () => {
  const { Text } = jest.requireActual("react-native");
  return {
    SymbolView: ({ name }: { name: string }) => <Text>{`sf:${name}`}</Text>,
  };
});

function state(overrides: Partial<PublishState> = {}): PublishState {
  return { ...initialPublishState, ...overrides };
}

async function renderBanner(publish: PublishState) {
  const onCancel = jest.fn();
  const view = await render(
    <PublishBanner
      onCancel={onCancel}
      onCheckStatus={jest.fn()}
      onDismiss={jest.fn()}
      onReview={jest.fn()}
      state={publish}
    />,
  );
  return { onCancel, view };
}

/** The fill's width is the whole visual claim, so it is read rather than
 * snapshotted: a style array would let an unrelated token change rewrite the
 * expectation without anybody noticing the bar had moved. */
function fillWidth() {
  return (
    screen.getByTestId("publish-progress-fill").props.style as {
      width?: string;
    }[]
  ).find((rule) => rule?.width !== undefined)?.width;
}

/** What the row reserves on each side of the bar. Whether the two agree is the
 * whole of "the bar is centred". */
function rowInsets() {
  const style = StyleSheet.flatten(
    screen.getByTestId("publish-progress-row").props.style,
  ) as {
    paddingHorizontal?: number;
    paddingLeft?: number;
    paddingRight?: number;
  };
  return {
    left: style.paddingLeft ?? style.paddingHorizontal ?? 0,
    right: style.paddingRight ?? style.paddingHorizontal ?? 0,
  };
}

describe("sharing in flight", () => {
  it("is a bar and a cross, with no words on the screen", async () => {
    await renderBanner(state({ progress: 0.4, status: "uploading" }));

    // The author pressed send a second ago and their photograph is the card
    // underneath. A sentence narrating that is the thing being removed.
    expect(screen.queryByText(/Sharing/)).toBeNull();
    expect(screen.queryByText(/40/)).toBeNull();
    expect(screen.queryByText(/Preparing/)).toBeNull();
    expect(screen.getByTestId("publish-progress-fill")).toBeTruthy();
    expect(screen.getByTestId("publish-cancel")).toBeTruthy();
  });

  it("speaks the percentage it draws", async () => {
    await renderBanner(state({ progress: 0.4, status: "uploading" }));

    // Unpainted, not lost: the fill is the sighted reading of exactly the value
    // VoiceOver announces here.
    const bar = screen.getByRole("progressbar", { name: "Sharing" });
    expect(bar.props.accessibilityValue).toEqual({ max: 100, min: 0, now: 40 });
    expect(fillWidth()).toBe("40%");
  });

  it("draws a stub before the first byte and a full bar while finalizing", async () => {
    const { view } = await renderBanner(state({ status: "reserving" }));
    // Zero width would read as a broken row rather than as "about to start".
    expect(fillWidth()).toBe("2%");

    await view.rerender(
      <PublishBanner
        onCancel={jest.fn()}
        onCheckStatus={jest.fn()}
        onDismiss={jest.fn()}
        onReview={jest.fn()}
        state={state({ progress: 1, status: "finalizing" })}
      />,
    );
    expect(fillWidth()).toBe("100%");
  });

  it("cancels from the cross", async () => {
    const { onCancel } = await renderBanner(
      state({ progress: 0.4, status: "uploading" }),
    );

    await userEvent.press(
      screen.getByRole("button", { name: "Cancel sharing" }),
    );
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("centres the bar once cancelling is refused", async () => {
    // Finalizing cannot be cancelled. With the cross gone the row is a bar and
    // nothing else, so it is inset equally on both sides rather than keeping a
    // 44-point hole where the control used to be.
    await renderBanner(state({ progress: 1, status: "finalizing" }));

    expect(screen.queryByTestId("publish-cancel")).toBeNull();
    expect(screen.getByTestId("publish-progress-fill")).toBeTruthy();

    const alone = rowInsets();
    expect(alone.left).toBe(alone.right);
  });

  it("leaves room for the cross while it is there", async () => {
    await renderBanner(state({ progress: 0.4, status: "uploading" }));

    // The control supplies its own trailing inset, so the row must not add a
    // second one — which is exactly what makes these two sides differ.
    const withCross = rowInsets();
    expect(withCross.left).toBeGreaterThan(withCross.right);
  });
});

describe("outcomes still speak", () => {
  it("says what happened when nothing was shared", async () => {
    await renderBanner(state({ message: "Nope.", status: "needs_review" }));

    // A failure has nothing on screen to speak for it, so these keep their
    // words and their named action.
    expect(screen.getByText("Nope.")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Review this Moment" }),
    ).toBeTruthy();
  });

  it("says nothing at all once the Moment is published", async () => {
    await renderBanner(state({ status: "published" }));

    expect(screen.queryByTestId("publish-status-card")).toBeNull();
  });
});
