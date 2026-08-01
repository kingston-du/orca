import {
  isDeckInstrumentationEnabled,
  markDeckStage,
  measureDeckStages,
  readDeckTimeline,
  resetDeckTimeline,
} from "@/features/moments/feed/deck-instrumentation";

const flag = process.env.EXPO_PUBLIC_ORCA_DECK_METRICS;

afterEach(() => {
  resetDeckTimeline();
  if (flag === undefined) {
    delete process.env.EXPO_PUBLIC_ORCA_DECK_METRICS;
  } else {
    process.env.EXPO_PUBLIC_ORCA_DECK_METRICS = flag;
  }
});

it("is off unless a build explicitly turned it on", () => {
  delete process.env.EXPO_PUBLIC_ORCA_DECK_METRICS;
  expect(isDeckInstrumentationEnabled()).toBe(false);

  markDeckStage("page_requested");
  markDeckStage("page_rendered");
  expect(readDeckTimeline()).toHaveLength(0);
});

it("stays off for any value other than the exact flag", () => {
  process.env.EXPO_PUBLIC_ORCA_DECK_METRICS = "true";
  expect(isDeckInstrumentationEnabled()).toBe(false);
});

describe("when a measurement build turns it on", () => {
  beforeEach(() => {
    process.env.EXPO_PUBLIC_ORCA_DECK_METRICS = "1";
  });

  it("measures the span between two stages", () => {
    markDeckStage("page_requested", 1_000);
    markDeckStage("page_rendered", 1_420);
    expect(measureDeckStages("page_requested", "page_rendered")).toBe(420);
  });

  it("measures the most recent completed span, not the first", () => {
    markDeckStage("move_requested", 1_000);
    markDeckStage("move_settled", 1_100);
    markDeckStage("move_requested", 2_000);
    markDeckStage("move_settled", 2_060);
    expect(measureDeckStages("move_requested", "move_settled")).toBe(60);
  });

  it("reports nothing when a stage never happened", () => {
    markDeckStage("photo_requested", 1_000);
    expect(measureDeckStages("photo_requested", "photo_shown")).toBeNull();
  });
});
