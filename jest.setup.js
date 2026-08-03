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
    // The sheet's drag hands its dismiss back to JavaScript. With no UI thread
    // to cross, the identity function is exactly right.
    runOnJS: (fn) => fn,
    // The reaction controls' selection pop. Its *timing* is a UI-thread
    // behaviour a device pass owns; what tests here own is that pressing a
    // control does not throw and that Reduce Motion is honoured, so the
    // animation primitives resolve to their settled value.
    withSequence: (...steps) => steps[steps.length - 1],
    withSpring: (toValue) => toValue,
    withTiming: (toValue) => toValue,
  };
});

/**
 * SF Symbols are the app's icon system as of Checkpoint 9C, so almost every
 * screen now reaches `expo-symbols` — and its real `SymbolView` is a native
 * view. Loading it into a test renderer corrupts React Native's own native
 * component registry: the observable symptom is that an unrelated `Switch`
 * elsewhere in the tree renders `undefined` and the whole screen throws.
 *
 * The stub keeps the one thing worth asserting on. A glyph cannot be checked
 * in a test renderer, but *which* symbol was asked for can, and that is what
 * carries state wherever two symbols distinguish one — flash off versus auto,
 * an empty Heart versus a filled one. Four test files each declared this mock
 * before; it is here so that a screen test does not have to know its subject
 * happens to draw an icon.
 */
jest.mock("expo-symbols", () => {
  const React = require("react");
  const { View } = require("react-native");

  return {
    SymbolView: ({ name, ...props }) =>
      React.createElement(View, { ...props, testID: `symbol-${name}` }),
  };
});

/**
 * The sheet is draggable, which brings `react-native-gesture-handler` into the
 * tree of every screen that opens one. Its own setup file replaces the native
 * module with a stub and makes `GestureDetector` render its child, which is all
 * a test renderer can meaningfully do with a pan: whether the sheet actually
 * follows a finger is a device behaviour. What tests still own is that the
 * sheet mounts, that its content is reachable, and that the two dismissals
 * which are *not* gestures — the close button and the scrim — still work.
 */
require("react-native-gesture-handler/jestSetup");

/**
 * `GestureDetector` wires itself to Reanimated's event plumbing, which the mock
 * above this file deliberately does not provide — there is no UI thread to
 * attach to. It becomes a passthrough, so the sheet's content is still rendered
 * and still reachable; the drag itself is a device behaviour.
 */
jest.mock("react-native-gesture-handler", () => {
  const actual = jest.requireActual("react-native-gesture-handler");
  return { ...actual, GestureDetector: ({ children }) => children };
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
