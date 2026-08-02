/**
 * Jest setup.
 *
 * `react-native-safe-area-context` reads its insets from the native side, so
 * under Jest `useSafeAreaInsets` has nothing to read and throws. This mock
 * supplies them from an ordinary React context instead.
 *
 * The default is a **notched** device, not a flat rectangle. Zero insets are
 * the one case where a layout that ignores the safe area still looks correct,
 * so defaulting to zero would let exactly the bug this mock exists to catch —
 * a control sitting under the status bar — pass every test. A test that wants
 * different hardware wraps its subject in `SafeAreaProvider initialMetrics`.
 *
 * Everything the factory needs is declared inside it: `jest.mock` is hoisted
 * above the file's own imports, so it may not close over module scope.
 */
/**
 * Reanimated drives the deck's depth on the UI thread, which does not exist
 * under Jest. Importing the library for real — or even its own shipped mock,
 * which re-exports the real entry point — reaches for the native worklets
 * module and throws before any test runs.
 *
 * So the animated pieces become ordinary ones: `Animated.View` is a `View` and
 * a created animated component is the component itself. **What this cannot
 * check is the interpolation.** Whether the neighbouring cards actually recede
 * is a UI-thread behaviour that only a device can answer, and it is part of the
 * Checkpoint 5A device pass. What tests here still own is everything
 * structural: which cards mount, what the list snaps by, and the reading order.
 */
jest.mock("react-native-reanimated", () => {
  const React = require("react");
  const { View } = require("react-native");

  const AnimatedView = React.forwardRef((props, ref) =>
    React.createElement(View, { ...props, ref }),
  );
  AnimatedView.displayName = "MockAnimatedView";

  const identity = (component) => component;

  return {
    __esModule: true,
    default: { View: AnimatedView, createAnimatedComponent: identity },
    Extrapolation: { CLAMP: "clamp", EXTEND: "extend", IDENTITY: "identity" },
    createAnimatedComponent: identity,
    interpolate: (value, input, output) => output[0],
    useAnimatedScrollHandler: () => () => {},
    useAnimatedStyle: (factory) => factory(),
    useSharedValue: (initial) => ({ value: initial }),
  };
});

jest.mock("react-native-safe-area-context", () => {
  const React = require("react");
  const actual = jest.requireActual("react-native-safe-area-context");

  const insets = { top: 59, right: 0, bottom: 34, left: 0 };
  const frame = { x: 0, y: 0, width: 393, height: 852 };

  const InsetsContext = React.createContext(insets);
  const FrameContext = React.createContext(frame);

  return {
    ...actual,
    SafeAreaInsetsContext: InsetsContext,
    SafeAreaFrameContext: FrameContext,
    initialWindowMetrics: { frame, insets },
    useSafeAreaInsets: () => React.useContext(InsetsContext),
    useSafeAreaFrame: () => React.useContext(FrameContext),
    SafeAreaProvider: ({ children, initialMetrics }) =>
      React.createElement(
        FrameContext.Provider,
        { value: initialMetrics?.frame ?? frame },
        React.createElement(
          InsetsContext.Provider,
          { value: initialMetrics?.insets ?? insets },
          children,
        ),
      ),
  };
});
