import {
  canCancelPublish,
  initialPublishState,
  isPublishInFlight,
  publishReducer,
  reviewMessage,
  type PendingPhoto,
  type PublishAction,
  type PublishState,
} from "@/features/moments/publish/publish-machine";

const MOMENT_ID = "11111111-1111-4111-8111-111111111111";

/** The local copy Home draws while the attempt is in flight. Nothing in the
 * reducer reads its fields; what matters is when it is present and when it is
 * cleared. */
const PHOTO: PendingPhoto = {
  uri: "file:///moment.jpg",
  width: 1536,
  height: 2048,
  caption: "",
  capturedAt: "2026-08-03T10:00:00.000Z",
  capturedUtcOffsetMinutes: -240,
  kind: "recent",
};

const start: PublishAction = {
  type: "publish_started",
  momentId: MOMENT_ID,
  photo: PHOTO,
};

function run(
  actions: PublishAction[],
  from = initialPublishState,
): PublishState {
  return actions.reduce(publishReducer, from);
}

const started: PublishAction[] = [start, { type: "reservation_confirmed" }];

describe("publishReducer", () => {
  test("walks reserve, upload, and finalize in order", () => {
    const reserving = run([start]);
    expect(reserving.status).toBe("reserving");
    expect(reserving.momentId).toBe(MOMENT_ID);
    expect(isPublishInFlight(reserving)).toBe(true);

    const uploading = publishReducer(reserving, {
      type: "reservation_confirmed",
    });
    expect(uploading.status).toBe("uploading");

    const finalizing = publishReducer(uploading, { type: "upload_finished" });
    expect(finalizing.status).toBe("finalizing");
    expect(finalizing.progress).toBe(1);
  });

  test("ignores stage transitions that arrive out of order", () => {
    // A late callback from an attempt the author already cancelled must not
    // drag the machine back into a running state.
    const canceled = run([
      ...started,
      {
        type: "outcome_resolved",
        outcome: { kind: "canceled", momentId: MOMENT_ID },
      },
    ]);

    expect(
      publishReducer(canceled, { type: "upload_progressed", fraction: 0.9 }),
    ).toBe(canceled);
    expect(publishReducer(canceled, { type: "upload_finished" })).toBe(
      canceled,
    );
    expect(publishReducer(canceled, { type: "reservation_confirmed" })).toBe(
      canceled,
    );
  });

  test("never moves progress backwards and clamps it to the unit range", () => {
    const uploading = run([
      ...started,
      { type: "upload_progressed", fraction: 0.6 },
    ]);
    expect(uploading.progress).toBe(0.6);

    expect(
      publishReducer(uploading, { type: "upload_progressed", fraction: 0.2 })
        .progress,
    ).toBe(0.6);
    expect(
      publishReducer(uploading, { type: "upload_progressed", fraction: 4 })
        .progress,
    ).toBe(1);
    expect(publishReducer(initialPublishState, start).progress).toBe(0);
  });

  test("allows cancelling only before finalization has begun", () => {
    const uploading = run(started);
    expect(canCancelPublish(uploading)).toBe(true);

    const finalizing = publishReducer(uploading, { type: "upload_finished" });
    // Once the server may have committed, offering cancel would be a lie.
    expect(canCancelPublish(finalizing)).toBe(false);
    expect(publishReducer(finalizing, { type: "cancel_requested" })).toBe(
      finalizing,
    );
  });

  test("does not offer cancel twice for one attempt", () => {
    const requested = run([...started, { type: "cancel_requested" }]);

    expect(requested.cancelRequested).toBe(true);
    expect(canCancelPublish(requested)).toBe(false);
  });

  test("a local failure lands in retryable_unknown, never in a claim", () => {
    const failed = run([
      ...started,
      { type: "attempt_failed", recoverable: true, message: "No connection." },
    ]);

    // The point of the whole machine: a transport failure says nothing about
    // whether the server published, so the state may not say either.
    expect(failed.status).toBe("retryable_unknown");
    expect(failed.message).toBe("No connection.");
    expect(isPublishInFlight(failed)).toBe(false);
  });

  test("records a published outcome with the kind the server decided", () => {
    const published = run([
      ...started,
      {
        type: "outcome_resolved",
        outcome: {
          kind: "published",
          momentId: MOMENT_ID,
          momentKind: "archive",
        },
      },
    ]);

    expect(published.status).toBe("published");
    expect(published.publishedKind).toBe("archive");
    expect(published.progress).toBe(1);
  });

  test("carries the server's review reason into a message that says nothing shared", () => {
    const review = run([
      ...started,
      {
        type: "outcome_resolved",
        outcome: {
          kind: "needs_review",
          momentId: MOMENT_ID,
          reason: "AUDIENCE_CHANGED",
        },
      },
    ]);

    expect(review.status).toBe("needs_review");
    expect(review.reviewReason).toBe("AUDIENCE_CHANGED");
    expect(review.message).toMatch(/Nothing was shared/);
  });

  test("an unresolved outcome asks the author to check rather than retry blindly", () => {
    const unresolved = run([
      ...started,
      {
        type: "outcome_resolved",
        outcome: { kind: "unresolved", momentId: MOMENT_ID },
      },
    ]);

    expect(unresolved.status).toBe("retryable_unknown");
    expect(unresolved.message).toMatch(/could not confirm/);
    // The Moment ID survives, because checking status is the only way out.
    expect(unresolved.momentId).toBe(MOMENT_ID);
  });

  test("reset returns to a state that claims nothing", () => {
    const reset = run([
      ...started,
      {
        type: "outcome_resolved",
        outcome: {
          kind: "published",
          momentId: MOMENT_ID,
          momentKind: "recent",
        },
      },
      { type: "reset" },
    ]);

    expect(reset).toEqual(initialPublishState);
  });

  test("every review reason has copy, including one the client does not know", () => {
    for (const reason of [
      "CLASSIFICATION_CHANGED",
      "AUDIENCE_CHANGED",
      "NO_RECIPIENTS",
      null,
    ] as const) {
      expect(reviewMessage(reason)).toMatch(/shared/);
    }
  });
});
