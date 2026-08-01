import {
  MAX_MOMENT_TAGS,
  MAX_SELECTED_RECIPIENTS,
  MIN_SELECTED_RECIPIENTS,
} from "@/constants/moments";
import type { MomentKind } from "@/features/moments/capture/capture-evidence";
import { normalizeCaption } from "@/features/moments/composer/caption";
import {
  canonicalIds,
  effectiveAudience,
  type ComposerAudience,
  type EffectiveAudience,
  type MomentDraft,
} from "@/features/moments/composer/moment-draft";

/**
 * The audience and tag matrix from `PROJECT.md` Section 9, as one pure reducer.
 *
 * It is pure on purpose. Audience is the highest-consequence decision in the
 * product — it decides who sees a private photo — and every one of its rules is
 * a boundary condition: the 50th recipient, the 20th tag, a tag that locks a
 * recipient, a switch that would silently drop someone. Those cases are cheap
 * and exhaustive to test as data in, data out, and impossible to test honestly
 * through a UI.
 *
 * It is also not authorization. The reducer produces *intent*. Finalization
 * revalidates every identifier against the live graph, blocks, and account
 * state under lock, and an author who never opens this screen still cannot
 * reach anyone they are not currently friends with.
 */

export type ComposerFriend = {
  id: string;
  username: string;
  displayName: string;
};

export type ComposerNotice =
  /** A tag in Selected forced its friend into the recipient set. */
  | { kind: "tag_locked_recipient"; friendId: string }
  /** The recipient cap blocks a tag; the author must free a slot first. */
  | { kind: "recipient_limit_blocks_tag" }
  | { kind: "recipient_limit_reached" }
  | { kind: "tag_limit_reached" }
  /** A locked recipient cannot be deselected while its tag exists. */
  | { kind: "recipient_locked_by_tag"; friendId: string }
  | { kind: "only_me_cleared_audience" }
  | { kind: "selected_started_empty_above_limit" }
  | { kind: "aged_out_to_archive" };

/**
 * Two transitions are destructive enough to require a deliberate confirmation
 * rather than an undo: dropping to Only Me clears recipients and tags, and
 * moving a large friend list to Selected cannot preselect everyone.
 */
export type PendingTransition =
  | { kind: "confirm_only_me" }
  | { kind: "confirm_selected_above_limit"; friendCount: number };

export type ComposerStatus = "preparing" | "ready" | "needs_review";

/** Where the current draft came from. A restored draft must be offered as an
 * explicit Continue or Discard rather than silently reappearing. */
export type DraftOrigin = "captured" | "restored";

export type ComposerState = {
  status: ComposerStatus;
  draft: MomentDraft | null;
  draftOrigin: DraftOrigin | null;
  /** The kind the client currently believes applies. The server decides for
   * real at publication; this only chooses which rules the composer shows. */
  kind: MomentKind;
  friends: ComposerFriend[] | null;
  pendingTransition: PendingTransition | null;
  notice: ComposerNotice | null;
  reviewReason: "aged_out" | null;
};

export const initialComposerState: ComposerState = {
  status: "preparing",
  draft: null,
  draftOrigin: null,
  kind: "archive",
  friends: null,
  pendingTransition: null,
  notice: null,
  reviewReason: null,
};

export type ComposerAction =
  | {
      type: "draft_prepared";
      draft: MomentDraft;
      kind: MomentKind;
      origin: DraftOrigin;
    }
  | { type: "draft_discarded" }
  /** The normalized file finished moving into the recoverable cache location.
   * Only the URI changes, and only for the draft that is still current. */
  | { type: "draft_media_persisted"; draftId: string; uri: string }
  | { type: "friends_loaded"; friends: ComposerFriend[] }
  | { type: "caption_changed"; caption: string }
  | { type: "audience_chosen"; audience: ComposerAudience }
  | { type: "transition_confirmed" }
  | { type: "transition_canceled" }
  | { type: "recipient_toggled"; friendId: string }
  | { type: "tag_toggled"; friendId: string }
  | { type: "reclassified"; kind: MomentKind }
  | { type: "review_acknowledged" }
  | { type: "notice_dismissed" };

function withDraft(
  state: ComposerState,
  changes: Partial<MomentDraft>,
  extra: Partial<ComposerState> = {},
): ComposerState {
  if (state.draft === null) return state;
  return {
    ...state,
    draft: { ...state.draft, ...changes },
    notice: null,
    ...extra,
  };
}

/**
 * A tag implies its friend must be able to see the Moment. In Selected that
 * makes the tagged friend a locked recipient; All Friends already includes
 * everyone, and Archive has no recipient set at all.
 */
export function lockedRecipientIds(state: ComposerState): string[] {
  if (state.draft === null) return [];
  if (state.kind === "archive") return [];
  if (state.draft.audience !== "selected_friends") return [];
  return canonicalIds(state.draft.tagIds);
}

export function composerEffectiveAudience(
  state: ComposerState,
): EffectiveAudience | null {
  return state.draft === null
    ? null
    : effectiveAudience(state.draft, state.kind);
}

export type ComposerValidation =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "preparing"
        | "needs_review"
        | "caption_invalid"
        | "no_recipients"
        | "too_many_recipients"
        | "too_many_tags";
    };

/**
 * What Phase 4's Publish action will gate on. Phase 3 uses it to describe the
 * draft honestly in the development harness; no release surface can publish.
 */
export function validateComposer(state: ComposerState): ComposerValidation {
  if (state.draft === null || state.status === "preparing") {
    return { ok: false, reason: "preparing" };
  }
  if (state.status === "needs_review") {
    return { ok: false, reason: "needs_review" };
  }
  if (!normalizeCaption(state.draft.caption).ok) {
    return { ok: false, reason: "caption_invalid" };
  }
  if (state.draft.tagIds.length > MAX_MOMENT_TAGS) {
    return { ok: false, reason: "too_many_tags" };
  }

  if (state.kind === "recent" && state.draft.audience === "selected_friends") {
    if (state.draft.recipientIds.length < MIN_SELECTED_RECIPIENTS) {
      return { ok: false, reason: "no_recipients" };
    }
    if (state.draft.recipientIds.length > MAX_SELECTED_RECIPIENTS) {
      return { ok: false, reason: "too_many_recipients" };
    }
  }

  return { ok: true };
}

/**
 * Recent defaults to All Friends when the author has at least one accepted
 * friend, and to Only Me otherwise — the zero-friend case must not present a
 * share control that would reach nobody. Archive has no audience choice.
 */
function defaultAudience(
  friends: ComposerFriend[] | null,
  kind: MomentKind,
): ComposerAudience {
  if (kind === "archive") return "all_friends";
  if (friends === null) return "all_friends";
  return friends.length > 0 ? "all_friends" : "only_me";
}

function applyOnlyMe(state: ComposerState): ComposerState {
  // Only Me cannot tag, so confirming it clears both the explicit recipients
  // and the tags rather than leaving invisible intent behind.
  return withDraft(
    state,
    {
      audience: "only_me",
      audienceChosenByAuthor: true,
      recipientIds: [],
      tagIds: [],
    },
    {
      pendingTransition: null,
      notice: { kind: "only_me_cleared_audience" },
    },
  );
}

function enterSelected(
  state: ComposerState,
  friends: ComposerFriend[],
): ComposerState {
  if (state.draft === null) return state;

  if (friends.length <= MAX_SELECTED_RECIPIENTS) {
    // Small graphs preselect everyone, so switching to Selected starts from the
    // audience the author already had and narrows it deliberately.
    return withDraft(
      state,
      {
        audience: "selected_friends",
        audienceChosenByAuthor: true,
        recipientIds: canonicalIds(friends.map((friend) => friend.id)),
      },
      { pendingTransition: null },
    );
  }

  return {
    ...state,
    notice: null,
    pendingTransition: {
      kind: "confirm_selected_above_limit",
      friendCount: friends.length,
    },
  };
}

export function composerReducer(
  state: ComposerState,
  action: ComposerAction,
): ComposerState {
  switch (action.type) {
    case "draft_prepared": {
      const audience = action.draft.audienceChosenByAuthor
        ? action.draft.audience
        : defaultAudience(state.friends, action.kind);

      return {
        ...state,
        status: "ready",
        kind: action.kind,
        draft: { ...action.draft, audience },
        draftOrigin: action.origin,
        pendingTransition: null,
        notice: null,
        reviewReason: null,
      };
    }

    case "draft_discarded":
      return { ...initialComposerState, friends: state.friends };

    case "draft_media_persisted": {
      // A save that completes after the author already discarded or retook the
      // photo must not resurrect the old file.
      if (state.draft === null || state.draft.draftId !== action.draftId) {
        return state;
      }
      if (state.draft.photo.uri === action.uri) return state;
      return {
        ...state,
        draft: {
          ...state.draft,
          photo: { ...state.draft.photo, uri: action.uri },
        },
      };
    }

    case "friends_loaded": {
      const friends = action.friends;
      if (state.draft === null || state.draft.audienceChosenByAuthor) {
        return { ...state, friends };
      }

      // The list usually settles after the draft exists, so the zero-friend
      // Only Me rule is applied here — but never over a deliberate choice.
      return {
        ...state,
        friends,
        draft: {
          ...state.draft,
          audience: defaultAudience(friends, state.kind),
        },
      };
    }

    case "caption_changed":
      return withDraft(state, { caption: action.caption });

    case "audience_chosen": {
      if (state.draft === null || state.kind === "archive") return state;
      if (state.draft.audience === action.audience) {
        return { ...state, notice: null, pendingTransition: null };
      }

      if (action.audience === "only_me") {
        return {
          ...state,
          notice: null,
          pendingTransition: { kind: "confirm_only_me" },
        };
      }

      if (action.audience === "all_friends") {
        // The explicit subset is discarded; tags are intentionally retained
        // because All Friends already includes every valid tag.
        return withDraft(
          state,
          {
            audience: "all_friends",
            audienceChosenByAuthor: true,
            recipientIds: [],
          },
          { pendingTransition: null },
        );
      }

      // Selected needs the real friend list before it can preselect or explain
      // the cap, so the control stays inert until the list has loaded.
      if (state.friends === null) return state;
      return enterSelected(state, state.friends);
    }

    case "transition_confirmed": {
      if (state.pendingTransition === null || state.draft === null)
        return state;

      if (state.pendingTransition.kind === "confirm_only_me") {
        return applyOnlyMe(state);
      }

      // Above the cap Selected starts from the locked tags alone and requires
      // deliberate selection; nobody is silently carried over or dropped.
      return withDraft(
        state,
        {
          audience: "selected_friends",
          audienceChosenByAuthor: true,
          recipientIds: canonicalIds(state.draft.tagIds).slice(
            0,
            MAX_SELECTED_RECIPIENTS,
          ),
        },
        {
          pendingTransition: null,
          notice: { kind: "selected_started_empty_above_limit" },
        },
      );
    }

    case "transition_canceled":
      // Cancelling preserves whatever audience the draft already had.
      return { ...state, pendingTransition: null, notice: null };

    case "recipient_toggled": {
      if (state.draft === null || state.kind === "archive") return state;
      if (state.draft.audience !== "selected_friends") return state;

      const { recipientIds } = state.draft;
      const isSelected = recipientIds.includes(action.friendId);

      if (isSelected) {
        if (state.draft.tagIds.includes(action.friendId)) {
          return {
            ...state,
            notice: {
              kind: "recipient_locked_by_tag",
              friendId: action.friendId,
            },
          };
        }
        return withDraft(state, {
          recipientIds: recipientIds.filter((id) => id !== action.friendId),
        });
      }

      if (recipientIds.length >= MAX_SELECTED_RECIPIENTS) {
        return { ...state, notice: { kind: "recipient_limit_reached" } };
      }

      return withDraft(state, {
        recipientIds: canonicalIds([...recipientIds, action.friendId]),
      });
    }

    case "tag_toggled": {
      if (state.draft === null) return state;
      // Only Me cannot tag; the control is absent, and the action is inert even
      // if something else dispatches it.
      if (state.kind === "recent" && state.draft.audience === "only_me") {
        return state;
      }

      const { tagIds, recipientIds } = state.draft;

      if (tagIds.includes(action.friendId)) {
        // Removing a tag unlocks the friend but leaves them selected until the
        // author explicitly deselects them — an untag must not quietly narrow
        // the audience.
        return withDraft(state, {
          tagIds: tagIds.filter((id) => id !== action.friendId),
        });
      }

      if (tagIds.length >= MAX_MOMENT_TAGS) {
        return { ...state, notice: { kind: "tag_limit_reached" } };
      }

      const needsRecipientSlot =
        state.kind === "recent" &&
        state.draft.audience === "selected_friends" &&
        !recipientIds.includes(action.friendId);

      if (
        needsRecipientSlot &&
        recipientIds.length >= MAX_SELECTED_RECIPIENTS
      ) {
        return { ...state, notice: { kind: "recipient_limit_blocks_tag" } };
      }

      return withDraft(
        state,
        {
          tagIds: canonicalIds([...tagIds, action.friendId]),
          recipientIds: needsRecipientSlot
            ? canonicalIds([...recipientIds, action.friendId])
            : recipientIds,
        },
        needsRecipientSlot
          ? {
              notice: {
                kind: "tag_locked_recipient",
                friendId: action.friendId,
              },
            }
          : {},
      );
    }

    case "reclassified": {
      if (state.draft === null || action.kind === state.kind) return state;

      if (action.kind === "archive") {
        // Ageing out of Recent narrows the audience rules. Tags survive because
        // they are who the Moment is *about*; the direct audience selections do
        // not, and the author must review before publishing anything.
        return {
          ...state,
          kind: "archive",
          status: "needs_review",
          reviewReason: "aged_out",
          pendingTransition: null,
          notice: { kind: "aged_out_to_archive" },
          draft: {
            ...state.draft,
            recipientIds: [],
            audience: "all_friends",
            audienceChosenByAuthor: false,
          },
        };
      }

      return { ...state, kind: action.kind, notice: null };
    }

    case "review_acknowledged":
      return state.status === "needs_review"
        ? { ...state, status: "ready", reviewReason: null, notice: null }
        : state;

    case "notice_dismissed":
      return state.notice === null ? state : { ...state, notice: null };
  }
}
