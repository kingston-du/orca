import { useQuery } from "@tanstack/react-query";
import * as Crypto from "expo-crypto";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import { AppState, type AppStateStatus } from "react-native";

import { useAuth } from "@/features/auth/auth-provider";
import { listFriends } from "@/features/friends/friends-api";
import { classifyCapture } from "@/features/moments/capture/capture-evidence";
import type { NormalizedPhoto } from "@/features/moments/capture/photo-normalizer";
import {
  composerReducer,
  initialComposerState,
  type ComposerAction,
  type ComposerState,
} from "@/features/moments/composer/composer-reducer";
import {
  discardMomentDraft,
  readMomentDraft,
  saveMomentDraft,
} from "@/features/moments/composer/draft-storage";
import type { MomentDraft } from "@/features/moments/composer/moment-draft";
import {
  usePublishController,
  type PublishController,
} from "@/features/moments/publish/use-publish-controller";
import { supabaseUrl } from "@/lib/supabase";
import { userScopeKey, type UserScope } from "@/lib/user-scoped-file-cache";

/**
 * The one owner of the active Moment draft.
 *
 * It spans a subtree rather than living in a screen because capture and
 * composition are separate routes that must agree on a single draft, and
 * because restart recovery has to happen once — not once per screen that
 * happens to mount. It deliberately does not duplicate anything TanStack Query
 * owns: the friend list is read through the ordinary `friends` query and only
 * projected into reducer-shaped values.
 */

/** How long an edit rests before it is written. Manifest writes are small, but
 * one per keystroke is pointless I/O; anything leaving the foreground flushes
 * immediately regardless. */
const PERSIST_DEBOUNCE_MS = 500;

/** How often a resting draft rechecks whether it has aged out of Recent. */
const RECLASSIFY_INTERVAL_MS = 60_000;

type MomentDraftContextValue = {
  state: ComposerState;
  /** True until restart recovery has settled, so no screen renders "no draft"
   * before the cached one has had a chance to load. */
  isRestoring: boolean;
  dispatch: (action: ComposerAction) => void;
  startDraft: (photo: NormalizedPhoto) => void;
  discardDraft: () => void;
  /** The single in-flight publish attempt for the single draft. It lives here
   * because an upload outlives the composer route. */
  publish: PublishController;
};

const MomentDraftContext = createContext<MomentDraftContextValue | null>(null);

export function MomentDraftProvider({ children }: PropsWithChildren) {
  const { user } = useAuth();
  const [state, dispatch] = useReducer(composerReducer, initialComposerState);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scope = useMemo<UserScope | null>(
    () => (user ? { userId: user.id, environmentUrl: supabaseUrl } : null),
    [user],
  );
  const scopeKey = scope === null ? null : userScopeKey(scope);

  /**
   * Recovery is tracked as "which scope have we already read from disk",
   * derived rather than toggled. A boolean flag would have to be set
   * synchronously as the identity changes, which is exactly the cascading
   * render effects are not supposed to cause.
   */
  const [restoredScopeKey, setRestoredScopeKey] = useState<string | null>(null);
  const isRestoring = restoredScopeKey !== scopeKey;

  // Restart recovery. A pre-reservation draft whose file the OS reclaimed is a
  // safe discard, which `readMomentDraft` performs before returning null.
  useEffect(() => {
    let isCurrent = true;

    const restore = async () => {
      if (scope === null) {
        // Signing out has nothing to recover, and the file cache was already
        // purged by the identity change.
        dispatch({ type: "draft_discarded" });
        return;
      }

      const draft = await readMomentDraft(scope);
      if (!isCurrent || draft === null) return;

      dispatch({
        type: "draft_prepared",
        draft,
        kind: classifyCapture(draft.photo.evidence, Date.now()),
        origin: "restored",
      });
    };

    void restore()
      .catch(() => {
        // A cache read failure is never fatal: the author simply starts a new
        // draft. Nothing is logged, because the only detail worth logging here
        // would be a private path.
      })
      .finally(() => {
        if (isCurrent) setRestoredScopeKey(scopeKey);
      });

    return () => {
      isCurrent = false;
    };
  }, [scope, scopeKey]);

  const draft = state.draft;

  const persist = useCallback(
    (pending: MomentDraft) => {
      if (scope === null) return;
      void saveMomentDraft(scope, pending)
        .then((saved) => {
          dispatch({
            type: "draft_media_persisted",
            draftId: saved.draftId,
            uri: saved.photo.uri,
          });
        })
        .catch(() => {
          // Losing the cached copy costs recovery after a restart, not the
          // draft the author is looking at right now.
        });
    },
    [scope],
  );

  useEffect(() => {
    if (draft === null) return;

    persistTimer.current = setTimeout(
      () => persist(draft),
      PERSIST_DEBOUNCE_MS,
    );
    return () => {
      if (persistTimer.current !== null) clearTimeout(persistTimer.current);
    };
  }, [draft, persist]);

  // Leaving the foreground is the last reliable moment before the process may
  // be killed, so the pending write is flushed rather than debounced away.
  useEffect(() => {
    const subscription = AppState.addEventListener(
      "change",
      (status: AppStateStatus) => {
        if (status === "active" || draft === null) return;
        if (persistTimer.current !== null) clearTimeout(persistTimer.current);
        persist(draft);
      },
    );
    return () => subscription.remove();
  }, [draft, persist]);

  // A draft can sit on the device long enough to cross the Recent boundary. The
  // reducer refuses to publish under the old rules once it does; this only
  // notices in time to tell the author.
  useEffect(() => {
    if (draft === null) return;

    const evaluate = () =>
      dispatch({
        type: "reclassified",
        kind: classifyCapture(draft.photo.evidence, Date.now()),
      });

    evaluate();
    const interval = setInterval(evaluate, RECLASSIFY_INTERVAL_MS);
    const subscription = AppState.addEventListener("change", (status) => {
      if (status === "active") evaluate();
    });

    return () => {
      clearInterval(interval);
      subscription.remove();
    };
  }, [draft]);

  const friendsQuery = useQuery({
    queryKey: ["friends", user?.id],
    queryFn: listFriends,
    enabled: user !== null && draft !== null,
  });
  const friendRows = friendsQuery.data;

  useEffect(() => {
    if (!friendRows) return;
    dispatch({
      type: "friends_loaded",
      friends: friendRows.map((friend) => ({
        id: friend.id,
        username: friend.username,
        displayName: friend.display_name,
        avatarPath: friend.avatar_path,
      })),
    });
  }, [friendRows]);

  const startDraft = useCallback(
    (photo: NormalizedPhoto) => {
      const now = new Date();
      const nextDraft: MomentDraft = {
        // Minted once, before anything is written, so every later retry,
        // reservation, and Storage path in Phase 4 refers to the same Moment.
        draftId: Crypto.randomUUID(),
        photo,
        caption: "",
        audience: "all_friends",
        audienceChosenByAuthor: false,
        recipientIds: [],
        tagIds: [],
        createdAt: now.toISOString(),
      };

      dispatch({
        type: "draft_prepared",
        draft: nextDraft,
        kind: classifyCapture(photo.evidence, now.getTime()),
        origin: "captured",
      });

      // Written immediately rather than on the debounce: this is the one write
      // that moves the normalized bytes into the recoverable location.
      persist(nextDraft);
    },
    [persist],
  );

  const discardDraft = useCallback(() => {
    if (persistTimer.current !== null) clearTimeout(persistTimer.current);
    dispatch({ type: "draft_discarded" });
    if (scope === null) return;
    try {
      discardMomentDraft(scope);
    } catch {
      // Already gone, or the platform refused. Either way the draft is no
      // longer reachable from the app.
    }
  }, [scope]);

  const publish = usePublishController({
    composer: state,
    dispatchComposer: dispatch,
    discardDraft,
  });

  const value = useMemo<MomentDraftContextValue>(
    () => ({ state, isRestoring, dispatch, startDraft, discardDraft, publish }),
    [state, isRestoring, startDraft, discardDraft, publish],
  );

  return (
    <MomentDraftContext.Provider value={value}>
      {children}
    </MomentDraftContext.Provider>
  );
}

export function useMomentDraft() {
  const context = useContext(MomentDraftContext);

  if (!context) {
    throw new Error("useMomentDraft must be used inside MomentDraftProvider");
  }

  return context;
}
