import {
  SEEN_DWELL_MS,
  SEEN_FLUSH_MS,
  createSeenReporter,
} from "@/features/moments/feed/seen-reporter";

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe("the dwell rule", () => {
  it("ignores a card that was only swiped past", () => {
    const send = jest.fn(async () => 0);
    const reporter = createSeenReporter(send);

    reporter.enter("a");
    jest.advanceTimersByTime(SEEN_DWELL_MS - 1);
    reporter.leave();
    jest.advanceTimersByTime(SEEN_FLUSH_MS * 2);

    expect(send).not.toHaveBeenCalled();
  });

  it("records a card that was actually looked at", () => {
    const send = jest.fn(async () => 1);
    const reporter = createSeenReporter(send);

    reporter.enter("a");
    jest.advanceTimersByTime(SEEN_DWELL_MS + SEEN_FLUSH_MS);

    expect(send).toHaveBeenCalledWith(["a"]);
  });

  it("moving on cancels the previous card's dwell", () => {
    const send = jest.fn(async () => 1);
    const reporter = createSeenReporter(send);

    reporter.enter("a");
    jest.advanceTimersByTime(SEEN_DWELL_MS - 100);
    reporter.enter("b");
    jest.advanceTimersByTime(SEEN_DWELL_MS + SEEN_FLUSH_MS);

    expect(send).toHaveBeenCalledWith(["b"]);
  });
});

describe("batching", () => {
  it("sends several cards in one call rather than one call each", () => {
    const send = jest.fn(async () => 2);
    const reporter = createSeenReporter(send);

    reporter.enter("a");
    jest.advanceTimersByTime(SEEN_DWELL_MS);
    reporter.enter("b");
    jest.advanceTimersByTime(SEEN_DWELL_MS);
    jest.advanceTimersByTime(SEEN_FLUSH_MS);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(["a", "b"]);
  });

  it("flushes early when the screen is left, rather than stranding a batch", () => {
    const send = jest.fn(async () => 1);
    const reporter = createSeenReporter(send);

    reporter.enter("a");
    jest.advanceTimersByTime(SEEN_DWELL_MS);
    reporter.leave();

    expect(send).toHaveBeenCalledWith(["a"]);
  });

  it("flushes on unmount", () => {
    const send = jest.fn(async () => 1);
    const reporter = createSeenReporter(send);

    reporter.enter("a");
    jest.advanceTimersByTime(SEEN_DWELL_MS);
    reporter.dispose();

    expect(send).toHaveBeenCalledWith(["a"]);
  });

  it("does not re-send a card the viewer swipes back to", () => {
    const send = jest.fn(async () => 1);
    const reporter = createSeenReporter(send);

    reporter.enter("a");
    jest.advanceTimersByTime(SEEN_DWELL_MS + SEEN_FLUSH_MS);
    reporter.enter("b");
    jest.advanceTimersByTime(SEEN_DWELL_MS + SEEN_FLUSH_MS);
    reporter.enter("a");
    jest.advanceTimersByTime(SEEN_DWELL_MS + SEEN_FLUSH_MS);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, ["a"]);
    expect(send).toHaveBeenNthCalledWith(2, ["b"]);
  });
});

describe("failure", () => {
  it("drops a failed batch instead of queueing it for later", async () => {
    // Section 8 forbids an offline seen queue. A record the server never
    // received belongs to a session the viewer has already left, and replaying
    // it later would move the unseen partition of a session that no longer
    // exists. The server record is idempotent, so the next session re-marks it.
    const send = jest.fn(async () => {
      throw new Error("offline");
    });
    const reporter = createSeenReporter(send);

    reporter.enter("a");
    jest.advanceTimersByTime(SEEN_DWELL_MS + SEEN_FLUSH_MS);
    await Promise.resolve();

    expect(send).toHaveBeenCalledTimes(1);

    // Nothing is retried on the next flush window.
    jest.advanceTimersByTime(SEEN_FLUSH_MS * 5);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
