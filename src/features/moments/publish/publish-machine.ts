import type { MomentKind } from "@/features/moments/capture/capture-evidence";
import type {
  MomentPublishOutcome,
  MomentReviewReason,
} from "@/features/moments/publish/publish-api";

/**
 * The publish state machine from `PROJECT.md` Section 9, as a pure reducer.
 *
 * `preparing → ready → reserving → uploading → finalizing → published`, with
 * the `needs_review`, `retryable_unknown`, `cancel_requested`, and
 * `terminal_rejected` branches. It is pure for the same reason the composer
 * reducer is: every interesting case here is a failure that happens between two
 * network calls, and those are cheap and exhaustive to test as data, impossible
 * to test honestly by driving a UI through a flaky connection.
 *
 * The rule the whole machine exists to enforce: no state transition may claim a
 * Moment was or was not published on the strength of a *local* failure. Only a
 * server outcome moves the machine to a terminal state — everything else lands
 * in `retryable_unknown`, whose only exits are asking the server again or
 * cancelling.
 */

export type PublishStatus =
  | "idle"
  | "reserving"
  | "uploading"
  | "finalizing"
  | "published"
  | "needs_review"
  | "rejected"
  | "retryable_unknown"
  | "canceled"
  | "failed";

export type PublishState = {
  status: PublishStatus;
  /** The Moment UUID this attempt owns. It is the draft's own ID, so it
   * survives restart and every retry refers to the same immutable path. */
  momentId: string | null;
  /** Native bytes-sent fraction, 0–1. Only meaningful while uploading. */
  progress: number;
  publishedKind: MomentKind | null;
  reviewReason: MomentReviewReason | null;
  /** True once cancellation has been asked for but the attempt has not yet
   * come to rest, so the UI can stop offering the button twice. */
  cancelRequested: boolean;
  /** A message safe to show. It never contains a path, URL, or identifier. */
  message: string | null;
};

export const initialPublishState: PublishState = {
  status: "idle",
  momentId: null,
  progress: 0,
  publishedKind: null,
  reviewReason: null,
  cancelRequested: false,
  message: null,
};

export type PublishAction =
  | { type: "publish_started"; momentId: string }
  | { type: "reservation_confirmed" }
  | { type: "upload_progressed"; fraction: number }
  | { type: "upload_finished" }
  | { type: "cancel_requested" }
  | { type: "outcome_resolved"; outcome: MomentPublishOutcome }
  /** The attempt threw before any outcome was known. */
  | { type: "attempt_failed"; recoverable: boolean; message: string }
  | { type: "reset" };

export function isPublishInFlight(state: PublishState): boolean {
  return (
    state.status === "reserving" ||
    state.status === "uploading" ||
    state.status === "finalizing"
  );
}

/** Whether the author may still cancel. Once finalization has begun the server
 * may already have committed, so cancelling would be a lie. */
export function canCancelPublish(state: PublishState): boolean {
  return (
    !state.cancelRequested &&
    (state.status === "reserving" || state.status === "uploading")
  );
}

export function publishReducer(
  state: PublishState,
  action: PublishAction,
): PublishState {
  switch (action.type) {
    case "publish_started":
      return {
        ...initialPublishState,
        status: "reserving",
        momentId: action.momentId,
      };

    case "reservation_confirmed":
      return state.status === "reserving"
        ? { ...state, status: "uploading", progress: 0 }
        : state;

    case "upload_progressed": {
      if (state.status !== "uploading") return state;
      const fraction = Math.min(1, Math.max(0, action.fraction));
      // Progress never goes backwards: a retried native chunk reporting a lower
      // byte count must not make the bar jump left.
      return fraction <= state.progress
        ? state
        : { ...state, progress: fraction };
    }

    case "upload_finished":
      return state.status === "uploading"
        ? { ...state, status: "finalizing", progress: 1 }
        : state;

    case "cancel_requested":
      return canCancelPublish(state)
        ? { ...state, cancelRequested: true }
        : state;

    case "outcome_resolved":
      return applyOutcome(state, action.outcome);

    case "attempt_failed":
      // A local failure proves nothing about the server. Recoverable failures
      // land in `retryable_unknown` precisely so the next step is asking, not
      // assuming.
      return {
        ...state,
        status: action.recoverable ? "retryable_unknown" : "failed",
        cancelRequested: false,
        message: action.message,
      };

    case "reset":
      return initialPublishState;
  }
}

function applyOutcome(
  state: PublishState,
  outcome: MomentPublishOutcome,
): PublishState {
  const settled = { ...state, cancelRequested: false, message: null };

  switch (outcome.kind) {
    case "published":
      return {
        ...settled,
        status: "published",
        progress: 1,
        publishedKind: outcome.momentKind,
      };

    case "needs_review":
      return {
        ...settled,
        status: "needs_review",
        reviewReason: outcome.reason,
        message: reviewMessage(outcome.reason),
      };

    case "rejected":
      return {
        ...settled,
        status: "rejected",
        message: "That photo could not be shared. Try a different one.",
      };

    case "canceled":
      return { ...settled, status: "canceled", progress: 0 };

    case "unresolved":
      return {
        ...settled,
        status: "retryable_unknown",
        message:
          "Splotty could not confirm whether this Moment shared. Check again before trying once more.",
      };
  }
}

export function reviewMessage(reason: MomentReviewReason | null): string {
  switch (reason) {
    case "CLASSIFICATION_CHANGED":
      return "This photo is now older than a day, so it can only go to you and anyone you tag. Nothing was shared — review it and share again.";
    case "AUDIENCE_CHANGED":
      return "Someone you chose is no longer available to share with. Nothing was shared — review who can see this and share again.";
    case "NO_RECIPIENTS":
      return "You have no friends to share with right now, so nothing was shared. You can keep this Moment to yourself instead.";
    default:
      return "This Moment changed before it shared, so nothing was shared. Review it and share again.";
  }
}
