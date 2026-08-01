import * as Crypto from "expo-crypto";
import { useCallback, useEffect, useReducer, useRef } from "react";

import { classifyCapture } from "@/features/moments/capture/capture-evidence";
import {
  validateComposer,
  type ComposerAction,
  type ComposerState,
} from "@/features/moments/composer/composer-reducer";
import {
  getMomentUploadStatus,
  publishMoment,
  readMomentMediaFacts,
  type MomentPublishOutcome,
} from "@/features/moments/publish/publish-api";
import {
  initialPublishState,
  publishReducer,
  reviewMessage,
  type PublishState,
} from "@/features/moments/publish/publish-machine";

/**
 * Binds the pure publish machine to the network and to the draft it publishes.
 *
 * It lives beside the draft provider rather than in a screen, because an upload
 * outlives the composer route: an author may background the app or navigate
 * away mid-transfer, and the attempt must still come to rest somewhere that
 * knows how to discard or re-key the draft afterwards.
 */

export type PublishController = {
  state: PublishState;
  publish: () => void;
  cancel: () => void;
  /** Asks the server what actually happened after an unknown outcome. This is
   * the only way out of `retryable_unknown` other than cancelling. */
  checkStatus: () => void;
  dismiss: () => void;
};

type ControllerInput = {
  composer: ComposerState;
  dispatchComposer: (action: ComposerAction) => void;
  discardDraft: () => void;
};

export function usePublishController({
  composer,
  dispatchComposer,
  discardDraft,
}: ControllerInput): PublishController {
  const [state, dispatch] = useReducer(publishReducer, initialPublishState);
  const abortRef = useRef<AbortController | null>(null);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  const settle = useCallback(
    (outcome: MomentPublishOutcome) => {
      dispatch({ type: "outcome_resolved", outcome });

      if (outcome.kind === "published") {
        // The bytes are the server's now, so the recoverable local copy has
        // done its job and is removed rather than left to be republished.
        discardDraft();
        return;
      }

      if (outcome.kind === "needs_review") {
        const draft = composer.draft;
        dispatchComposer({
          type: "publication_refused",
          draftId: Crypto.randomUUID(),
          kind:
            draft === null
              ? composer.kind
              : classifyCapture(draft.photo.evidence, Date.now()),
          message: reviewMessage(outcome.reason),
        });
        return;
      }

      // Cancelled and rejected attempts both spend the Moment UUID: the
      // server's tombstone is permanent, so the next attempt needs a new one.
      if (outcome.kind === "canceled" || outcome.kind === "rejected") {
        dispatchComposer({
          type: "draft_rekeyed",
          draftId: Crypto.randomUUID(),
        });
      }
    },
    [composer.draft, composer.kind, discardDraft, dispatchComposer],
  );

  const publish = useCallback(() => {
    const draft = composer.draft;
    if (draft === null || !validateComposer(composer).ok) return;

    const controller = new AbortController();
    abortRef.current = controller;
    dispatch({ type: "publish_started", momentId: draft.draftId });

    void (async () => {
      try {
        const facts = await readMomentMediaFacts(draft.photo.uri);
        const outcome = await publishMoment({
          byteSize: facts.byteSize,
          draft,
          kind: composer.kind,
          onProgress: (fraction) =>
            dispatch({ type: "upload_progressed", fraction }),
          onStage: (stage) =>
            dispatch(
              stage === "uploading"
                ? { type: "reservation_confirmed" }
                : { type: "upload_finished" },
            ),
          sha256: facts.sha256,
          signal: controller.signal,
        });

        if (isMounted.current) settle(outcome);
      } catch {
        // Nothing is logged: the only details worth logging here would be a
        // path, a caption, or an identifier. A thrown reserve or hash step
        // means no upload was attempted, but the machine still refuses to
        // claim that on its own — the author can check or try again.
        if (isMounted.current) {
          dispatch({
            type: "attempt_failed",
            recoverable: true,
            message:
              "Orca could not share this Moment. Check your connection and try again.",
          });
        }
      }
    })();
  }, [composer, settle]);

  const cancel = useCallback(() => {
    dispatch({ type: "cancel_requested" });
    abortRef.current?.abort();
  }, []);

  const checkStatus = useCallback(() => {
    const momentId = state.momentId;
    if (momentId === null) return;

    void (async () => {
      try {
        const status = await getMomentUploadStatus(momentId);
        if (!isMounted.current || status === null) return;

        if (status.status === "published") {
          settle({
            kind: "published",
            momentId,
            momentKind: status.kind === "archive" ? "archive" : "recent",
          });
          return;
        }
        if (status.status === "needs_review") {
          settle({
            kind: "needs_review",
            momentId,
            reason:
              (status.error_code as Parameters<typeof reviewMessage>[0]) ??
              null,
          });
          return;
        }
        if (status.status === "rejected") {
          settle({ kind: "rejected", momentId });
          return;
        }
        if (
          status.status === "cancel_requested" ||
          status.status === "expired"
        ) {
          settle({ kind: "canceled", momentId });
        }
        // A still-live reservation leaves the machine where it is; the author
        // may check again or cancel.
      } catch {
        // Unchanged state is the honest answer to a failed question.
      }
    })();
  }, [settle, state.momentId]);

  const dismiss = useCallback(() => dispatch({ type: "reset" }), []);

  return { state, publish, cancel, checkStatus, dismiss };
}
